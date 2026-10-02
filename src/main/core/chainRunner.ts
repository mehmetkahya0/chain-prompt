import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  sanitizeStepConfig,
  stepConfigOf,
  STEP_CONFIG_KEYS,
  type ChainSnapshot,
  type ChainState,
  type QueueOp,
  type Settings,
  type Step,
  type StepConfig
} from '../../shared/types'
import { isBuiltinVariable, renderPrompt, variableNames } from '../../shared/variables'
import type { HookEvent } from './hookServer'
import type { SessionManager } from './sessionManager'
import { RunLog, formatDuration } from './runLog'
import { looksLikeQuestion } from './questions'
import { runCommand, type RunningCommand } from './shell'
import { addUsage, usageFromTranscript } from './usage'
import { createCheckpoint, deleteCheckpointRef, diffStatSince, finishChain, isGitRepo, rollbackTo } from './git'

export type NoticeKind = 'done' | 'attention' | 'error'
export type Notify = (kind: NoticeKind, title: string, body: string) => void

/** Notification types that mean "claude is blocked on the user". */
const ATTENTION_TYPES = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input'
])

const RUNNABLE = new Set<Step['status']>(['pending', 'interrupted', 'error'])
const ACTIVE = new Set<Step['status']>(['running', 'waiting'])
const MAX_OUTPUT = 20_000

/** Internal phase; the exported ChainState is derived from it (see `state`). */
type Phase = 'idle' | 'starting' | 'active' | 'verifying' | 'between' | 'paused' | 'completed'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ChainRunnerOptions {
  /** User variables ({{name}}) of this chain. */
  getVariables?: () => Record<string, string>
  /** Display name for logs and notifications. */
  getName?: () => string
}

/**
 * The chain state machine. Progress is driven only by Claude Code hooks:
 *   UserPromptSubmit -> our prompt was accepted
 *   Stop             -> turn done: question check, verify command, next step
 *   StopFailure      -> API error, retry or fail the step
 *   Notification     -> claude waits for the user (permission etc.)
 *   PostToolUse      -> claude is working again after a permission prompt
 *   SessionEnd / pty exit -> step failed
 * A watchdog pauses the chain if a running step prints nothing for too long.
 * Emits 'change' on every state change and 'log' (line) for every log line.
 */
export class ChainRunner extends EventEmitter {
  steps: Step[] = []
  currentStepId: string | null = null
  message = ''

  private phase: Phase = 'idle'
  private pauseRequested = false
  /** Bumped to cancel in-flight async sequences (stop, pause while starting). */
  private gen = 0
  private timer: NodeJS.Timeout | null = null
  private submitted = false
  private stallWarned = false
  /** The current step's last turn ended with a question to the user. */
  private questionPending = false
  /** Start of the current turn, for token usage. */
  private turnStartedAt = 0
  /** Transcript message ids already attributed to a step. */
  private countedMessages = new Set<string>()
  /** Running `when` / `verify` command, killed on stop. */
  private command: RunningCommand | null = null
  /** Prompts submitted per claude launch; a fresh launch needs no /clear. */
  private promptCount = new Map<string, number>()
  private log: RunLog | null = null
  private gitRepo = false
  private readonly watchdog: NodeJS.Timeout

  constructor(
    private readonly sm: SessionManager,
    private readonly getSettings: () => Settings,
    private readonly notify: Notify,
    private readonly opts: ChainRunnerOptions = {}
  ) {
    super()
    sm.on('hook', (ev: HookEvent) => this.onHook(ev))
    sm.on('exit', () => {
      const step = this.activeStep()
      if (step && this.phase !== 'verifying') this.failStep(step, 'The terminal / claude process exited')
    })
    this.watchdog = setInterval(() => this.checkIdle(), 5000)
    this.watchdog.unref?.()
  }

  // ---------------------------------------------------------------- state

  get state(): ChainState {
    switch (this.phase) {
      case 'starting':
        return 'starting'
      case 'active':
      case 'verifying':
      case 'between': {
        if (this.activeStep()?.status === 'waiting') return 'waiting_user'
        return this.pauseRequested ? 'pausing' : 'running'
      }
      default:
        return this.phase
    }
  }

  get isBusy(): boolean {
    return this.phase === 'starting' || this.phase === 'active' || this.phase === 'verifying' || this.phase === 'between'
  }

  snapshot(): ChainSnapshot {
    return {
      state: this.state,
      steps: this.steps.map((s) => ({ ...s })),
      currentStepId: this.currentStepId,
      message: this.message
    }
  }

  /** Restore persisted queue. A step that was mid-flight when the app died is marked interrupted. */
  restore(steps: Step[]): void {
    this.steps = steps.map((s) =>
      ACTIVE.has(s.status) ? { ...s, status: 'interrupted', note: 'The app was closed while this step was running' } : { ...s }
    )
    const cut = this.steps.find((s) => s.status === 'interrupted')
    if (cut) {
      this.currentStepId = cut.id
      this.message = `Step ${this.indexOf(cut) + 1} was interrupted — press "Start" to resume from it`
    }
    this.changed()
  }

  private changed(): void {
    this.emit('change')
  }

  private line(text: string): void {
    this.log?.line(text)
    this.emit('log', text)
  }

  private block(title: string, body: string): void {
    this.log?.block(title, body)
    this.emit('log', title)
  }

  private indexOf(step: Step): number {
    return this.steps.findIndex((s) => s.id === step.id)
  }

  private activeStep(): Step | undefined {
    const s = this.steps.find((x) => x.id === this.currentStepId)
    return s && ACTIVE.has(s.status) ? s : undefined
  }

  private nextRunnable(fromIndex: number): Step | undefined {
    return this.steps.slice(Math.max(0, fromIndex)).find((s) => RUNNABLE.has(s.status))
  }

  private label(step: Step): string {
    return `Step ${this.indexOf(step) + 1}/${this.steps.length}`
  }

  private get cwd(): string | null {
    return this.sm.cwd
  }

  // ------------------------------------------------------------ variables

  /** Values for {{...}} in the prompts of `step`. */
  variablesFor(step: Step, extra: Record<string, string> = {}): Record<string, string> {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const i = this.indexOf(step)
    const prev = this.steps
      .slice(0, Math.max(0, i))
      .reverse()
      .find((s) => s.status === 'done' && s.output)
    return {
      ...(this.opts.getVariables?.() ?? {}),
      folder: this.cwd ?? '',
      folderName: this.cwd ? basename(this.cwd) : '',
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      step: String(i + 1),
      'prev.output': prev?.output ?? '',
      'verify.output': step.verifyOutput ?? '',
      ...extra
    }
  }

  /** User variables used by runnable steps that have no value yet. */
  missingVariables(): string[] {
    const vars = this.opts.getVariables?.() ?? {}
    const used = variableNames(...this.steps.filter((s) => RUNNABLE.has(s.status)).flatMap((s) => [s.prompt, s.fixPrompt]))
    return used.filter((n) => !isBuiltinVariable(n) && !(vars[n] ?? '').trim())
  }

  // ------------------------------------------------------------- commands

  start(): void {
    if (this.isBusy) {
      if (this.pauseRequested) this.resume()
      return
    }
    if (this.phase === 'paused') return this.resume()
    const next = this.nextRunnable(0)
    if (!next) {
      this.message = 'Nothing left to run in the queue'
      return this.changed()
    }
    if (!this.cwd) {
      this.message = 'Pick a working folder first (top right)'
      return this.changed()
    }
    const missing = this.missingVariables()
    if (missing.length) {
      this.message = `Fill in the chain variable${missing.length > 1 ? 's' : ''} first: ${missing.join(', ')}`
      return this.changed()
    }
    this.log = new RunLog(this.cwd, this.opts.getName?.())
    this.emit('log', `Chain started — folder: ${this.cwd}`)
    this.pauseRequested = false
    this.gen++
    void this.beginRun(next, this.gen)
  }

  private async beginRun(first: Step, g: number): Promise<void> {
    // Busy from this moment on (a second Start is a no-op, Pause cancels).
    this.phase = 'starting'
    this.currentStepId = first.id
    this.message = 'Starting…'
    this.changed()
    const cwd = this.cwd
    this.gitRepo = !!cwd && this.getSettings().gitCheckpoints && (await isGitRepo(cwd).catch(() => false))
    if (g !== this.gen) return
    void this.runStep(first, g, true)
  }

  pause(): void {
    if (!this.isBusy) return
    if (this.phase === 'between' && !this.activeStep()) {
      this.clearTimer()
      this.enterPaused('Paused — press "Resume" to continue')
    } else if (this.phase === 'starting' && !this.activeStep()) {
      // Nothing was sent yet: cancel the start sequence, the step stays as it was.
      this.gen++
      this.killCommand()
      this.enterPaused('Paused — press "Resume" to continue')
    } else {
      this.pauseRequested = true
      this.message = 'Will pause after the current step finishes'
      this.line('Pause requested')
      this.changed()
    }
  }

  resume(): void {
    if (this.pauseRequested) {
      this.pauseRequested = false
      this.message = 'Resumed'
      this.line('Pause cancelled')
      return this.changed()
    }
    // claude asked a question: Resume means "carry on without answering".
    const active = this.activeStep()
    if (active && this.questionPending) {
      this.questionPending = false
      active.status = 'running'
      this.line(`${this.label(active)}: question ignored by user, continuing`)
      return this.afterTurn(active)
    }
    if (this.phase !== 'paused') return
    // A stall-pause leaves the step running; just go back to watching it.
    if (active) {
      this.phase = 'active'
      this.stallWarned = false
      this.message = 'Resumed'
      return this.changed()
    }
    const cur = this.steps.find((s) => s.id === this.currentStepId)
    const next = this.nextRunnable(cur ? this.indexOf(cur) : 0) ?? this.nextRunnable(0)
    if (!next) return this.finish()
    if (!this.log && this.cwd) this.log = new RunLog(this.cwd, this.opts.getName?.())
    this.line('Resumed')
    this.gen++
    void this.beginRun(next, this.gen)
  }

  stop(): void {
    if (!this.isBusy && this.phase !== 'paused') return
    this.gen++
    this.clearTimer()
    this.killCommand()
    this.pauseRequested = false
    this.questionPending = false
    const step = this.activeStep()
    if (step) {
      this.sm.write('\x1b') // Esc interrupts claude's current turn
      step.status = 'interrupted'
      step.endedAt = Date.now()
      step.note = 'Stopped by user'
      this.line(`${this.label(step)} stopped (Esc sent to claude)`)
    }
    this.phase = 'idle'
    this.message = 'Chain stopped'
    this.log?.writeSummary(this.steps)
    this.changed()
  }

  skipNext(): void {
    const active = this.activeStep()
    const from = active
      ? this.indexOf(active) + 1
      : (() => {
          const cur = this.steps.find((s) => s.id === this.currentStepId)
          return cur ? this.indexOf(cur) : 0
        })()
    const target = this.steps.slice(from).find((s) => RUNNABLE.has(s.status))
    if (!target) {
      this.message = 'No step to skip'
      return this.changed()
    }
    target.status = 'skipped'
    target.note = 'Skipped by user'
    this.message = `${this.label(target)} skipped`
    this.line(`${this.label(target)} skipped`)
    this.changed()
  }

  applyQueueOp(op: QueueOp): string | null {
    const find = (id: string) => this.steps.find((s) => s.id === id)
    switch (op.type) {
      case 'add': {
        const { type: _t, ...raw } = op
        const cfg = sanitizeStepConfig(raw)
        if (!cfg) return 'Cannot add an empty prompt'
        this.steps.push({ ...cfg, id: randomUUID(), status: 'pending' })
        break
      }
      case 'update': {
        const s = find(op.id)
        if (!s) return 'Step not found'
        const { type: _t, id: _id, ...patch } = op
        const keys = Object.keys(patch)
        if (ACTIVE.has(s.status) && keys.some((k) => k !== 'newSession')) return 'A running step cannot be edited'
        const merged: Record<string, unknown> = { ...stepConfigOf(s) }
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined || v === null || v === '') delete merged[k]
          else merged[k] = v
        }
        if (typeof merged.prompt !== 'string' || !merged.prompt.trim()) return 'Prompt cannot be empty'
        const cfg = sanitizeStepConfig(merged)
        if (!cfg) return 'Prompt cannot be empty'
        for (const k of STEP_CONFIG_KEYS) delete (s as unknown as Record<string, unknown>)[k]
        Object.assign(s, cfg)
        break
      }
      case 'remove': {
        const s = find(op.id)
        if (!s) return null
        if (ACTIVE.has(s.status)) return 'A running step cannot be deleted; stop the chain first'
        this.dropCheckpoint(s)
        this.steps = this.steps.filter((x) => x.id !== op.id)
        if (this.currentStepId === op.id) this.currentStepId = null
        break
      }
      case 'duplicate': {
        const i = this.steps.findIndex((s) => s.id === op.id)
        if (i < 0) return null
        this.steps.splice(i + 1, 0, { ...stepConfigOf(this.steps[i]), id: randomUUID(), status: 'pending' })
        break
      }
      case 'move': {
        const i = this.steps.findIndex((s) => s.id === op.id)
        if (i < 0) return null
        const [s] = this.steps.splice(i, 1)
        this.steps.splice(Math.max(0, Math.min(op.toIndex, this.steps.length)), 0, s)
        break
      }
      case 'reset': {
        const s = find(op.id)
        if (!s || ACTIVE.has(s.status)) return null
        resetRuntime(s)
        break
      }
      case 'resetAll':
        if (this.isBusy) return 'Cannot reset while the chain is running'
        for (const s of this.steps) resetRuntime(s)
        this.currentStepId = null
        this.phase = 'idle'
        this.message = ''
        break
      case 'clearAll':
        if (this.isBusy) return 'Cannot clear the queue while the chain is running'
        for (const s of this.steps) this.dropCheckpoint(s)
        this.steps = []
        this.currentStepId = null
        this.phase = 'idle'
        this.message = ''
        break
      case 'bulk': {
        const ids = new Set(op.ids)
        const targets = this.steps.filter((s) => ids.has(s.id))
        let skippedActive = 0
        for (const s of targets) {
          const active = ACTIVE.has(s.status)
          if (active && op.action !== 'duplicate' && op.action !== 'newSessionOn' && op.action !== 'newSessionOff') {
            skippedActive++
            continue
          }
          if (op.action === 'remove') {
            this.dropCheckpoint(s)
            this.steps = this.steps.filter((x) => x.id !== s.id)
            if (this.currentStepId === s.id) this.currentStepId = null
          } else if (op.action === 'reset') resetRuntime(s)
          else if (op.action === 'skip') {
            if (RUNNABLE.has(s.status)) Object.assign(s, { status: 'skipped', note: 'Skipped by user' })
          } else if (op.action === 'duplicate') {
            const i = this.steps.findIndex((x) => x.id === s.id)
            this.steps.splice(i + 1, 0, { ...stepConfigOf(s), id: randomUUID(), status: 'pending' })
          } else s.newSession = op.action === 'newSessionOn'
        }
        if (skippedActive) this.message = `${skippedActive} running step(s) were left unchanged`
        break
      }
    }
    this.changed()
    return null
  }

  /** Replace the whole queue (loading a chain file or a template). */
  replaceSteps(steps: unknown[]): string | null {
    if (this.isBusy) return 'Cannot load a chain while the chain is running'
    const configs = steps.map(sanitizeStepConfig).filter((s): s is StepConfig => !!s)
    if (!configs.length) return 'No steps found'
    for (const s of this.steps) this.dropCheckpoint(s)
    this.steps = configs.map((c) => ({ ...c, id: randomUUID(), status: 'pending' as const }))
    this.currentStepId = null
    this.phase = 'idle'
    this.message = `Loaded a chain with ${this.steps.length} steps`
    this.changed()
    return null
  }

  /** Restore the working tree to the checkpoint taken before `stepId`; that step and later ones become pending. */
  async rollback(stepId: string): Promise<string | null> {
    if (this.isBusy) return 'Stop or pause the chain before rolling back'
    const step = this.steps.find((s) => s.id === stepId)
    if (!step?.checkpoint) return 'This step has no checkpoint'
    if (!this.cwd) return 'No working folder'
    try {
      await rollbackTo(this.cwd, step.checkpoint)
    } catch (e) {
      return `Roll back failed: ${(e as Error).message}`
    }
    const i = this.indexOf(step)
    for (const s of this.steps.slice(i)) if (!ACTIVE.has(s.status)) resetRuntime(s)
    this.currentStepId = step.id
    if (this.phase === 'completed') this.phase = 'idle'
    this.message = `Rolled back to before step ${i + 1}. Steps ${i + 1}–${this.steps.length} are pending again.`
    this.line(this.message)
    this.changed()
    return null
  }

  private dropCheckpoint(step: Step): void {
    if (step.checkpoint && this.cwd) void deleteCheckpointRef(this.cwd, `step-${step.id}`).catch(() => {})
  }

  // ------------------------------------------------------------ execution

  private async runStep(step: Step, g: number, fresh: boolean): Promise<void> {
    const cancelled = () => g !== this.gen
    const settings = this.getSettings()
    this.clearTimer()
    this.phase = 'starting'
    this.currentStepId = step.id
    this.stallWarned = false
    this.questionPending = false
    if (fresh) {
      for (const k of ['attempts', 'loops', 'usage', 'diffStat', 'verifyOutput', 'output'] as const) delete step[k]
    }

    // 0) Condition.
    if (step.when) {
      this.message = `${this.label(step)}: checking condition…`
      this.line(`${this.label(step)}: condition \`${step.when}\``)
      this.changed()
      this.command = runCommand(step.when, this.cwd!, { timeoutMs: settings.commandTimeoutMin * 60_000 })
      const r = await this.command.done
      this.command = null
      if (cancelled()) return
      if (r.code !== 0) {
        Object.assign(step, { status: 'skipped', note: `Condition not met (exit ${r.timedOut ? 'timeout' : r.code})`, startedAt: undefined, endedAt: undefined })
        this.line(`${this.label(step)} skipped: condition exited with ${r.timedOut ? 'a timeout' : r.code}`)
        return this.scheduleNext(step, `${this.label(step)} skipped (condition not met)`)
      }
    }

    // 1) Make sure claude runs with the model / permission mode this step wants.
    const want = { model: step.model ?? '', permissionMode: step.permissionMode ?? settings.permissionMode }
    let freshLaunch = false
    const cur = this.sm.current
    if (!cur?.alive) {
      this.message = 'Starting claude…'
      this.changed()
      this.sm.start(this.cwd!, step.newSession ? 'new' : this.sm.mode, want)
      freshLaunch = true
    } else if ((cur.model ?? '') !== want.model || (cur.permissionMode ?? settings.permissionMode) !== want.permissionMode) {
      const used = (this.promptCount.get(cur.launchId) ?? 0) > 0 || cur.mode === 'continue'
      const mode = used && !step.newSession ? 'continue' : 'new'
      this.line(
        `${this.label(step)}: restarting claude (${mode === 'continue' ? '--continue' : 'new session'}) for ` +
          `model "${want.model || 'default'}", permission mode "${want.permissionMode}"`
      )
      this.message = 'Restarting claude for this step’s model / permission mode…'
      this.changed()
      this.sm.start(this.cwd!, mode, want)
      freshLaunch = mode === 'new'
    }
    if (!this.sm.ready) {
      this.message = 'Waiting for claude to become ready…'
      this.changed()
      const hint = setTimeout(() => {
        if (cancelled() || this.phase !== 'starting') return
        this.message =
          'No ready signal (SessionStart) from claude yet — it may be waiting for a folder-trust or login confirmation in the terminal. ' +
          'The chain starts by itself once you confirm.'
        this.notify('attention', 'Chain Prompt: confirmation needed', 'claude may be waiting for your confirmation in the terminal.')
        this.changed()
      }, 20000)
      const ok = await this.sm.waitReady({ timeoutMs: 0, cancelled })
      clearTimeout(hint)
      if (cancelled()) return
      if (!ok) return this.failStep(step, 'claude failed to start or exited')
    }

    // 2) Optional context reset.
    const launchId = this.sm.current!.launchId
    if (step.newSession && !freshLaunch && (this.promptCount.get(launchId) ?? 0) > 0) {
      this.message = 'Resetting context…'
      this.changed()
      const t = Date.now()
      if (settings.newSessionMethod === 'restart') {
        this.line(`${this.label(step)}: restarting claude (new session)`)
        this.sm.start(this.cwd!, 'new', want)
        if (!(await this.sm.waitReady({ since: t, timeoutMs: 0, cancelled }))) {
          if (!cancelled()) this.failStep(step, 'claude could not be restarted')
          return
        }
      } else {
        this.line(`${this.label(step)}: sending /clear`)
        this.sm.write('/clear')
        await sleep(400)
        if (cancelled()) return
        this.sm.write('\r')
        if (!(await this.sm.waitReady({ since: t, timeoutMs: 30000, cancelled }))) {
          if (!cancelled()) this.failStep(step, 'No ready signal from claude after /clear')
          return
        }
      }
    }
    if (cancelled()) return

    // 3) Git checkpoint, so the step can be rolled back and its diff measured.
    if (this.gitRepo && fresh) {
      try {
        step.checkpoint = await createCheckpoint(this.cwd!, `step-${step.id}`, `Chain Prompt checkpoint before ${this.label(step)}`)
        this.line(`${this.label(step)}: checkpoint ${step.checkpoint.slice(0, 10)}`)
      } catch (e) {
        this.line(`${this.label(step)}: checkpoint failed: ${(e as Error).message}`)
      }
      if (cancelled()) return
    }

    // 4) Send the prompt.
    Object.assign(step, { startedAt: Date.now(), endedAt: undefined, note: undefined })
    await this.sendTurn(step, renderPrompt(step.prompt, this.variablesFor(step)), g)
  }

  /** Paste `text` into claude, press Enter and confirm claude accepted it. */
  private async sendTurn(step: Step, text: string, g: number): Promise<void> {
    const cancelled = () => g !== this.gen
    const session = this.sm.current
    if (!session?.alive) return this.failStep(step, 'claude is not running')
    step.status = 'running'
    this.phase = 'active'
    this.submitted = false
    this.questionPending = false
    this.turnStartedAt = Date.now()
    this.message = `${this.label(step)} running${step.loops ? ` (fix attempt ${step.loops}/${step.maxLoops})` : ''}`
    this.block(
      `${this.label(step)} ${step.loops ? `fix attempt ${step.loops}` : 'started'}${step.newSession && !step.loops ? ' (new session)' : ''} — prompt:`,
      text
    )
    this.log?.writeSummary(this.steps)
    this.changed()

    session.pastePrompt(text)
    // Give the TUI time to ingest a large paste before Enter.
    await sleep(Math.min(3000, 400 + Math.floor(text.length / 20)))
    if (cancelled()) return
    session.pressEnter()

    for (let attempt = 0; attempt < 2; attempt++) {
      const end = Date.now() + 8000
      while (!this.submitted && Date.now() < end && !cancelled() && ACTIVE.has(step.status)) await sleep(100)
      if (this.submitted || cancelled() || !ACTIVE.has(step.status)) return
      if (attempt === 0) {
        this.line(`${this.label(step)}: no UserPromptSubmit yet, sending Enter again`)
        session.pressEnter()
      }
    }
    this.failStep(
      step,
      'The prompt was not accepted by claude (no UserPromptSubmit hook). Check the terminal; if hooks are not arriving, try Settings > Hook transport.'
    )
  }

  private onHook(ev: HookEvent): void {
    const p = ev.payload
    if (ev.event === 'UserPromptSubmit') {
      this.promptCount.set(ev.launchId, (this.promptCount.get(ev.launchId) ?? 0) + 1)
    }
    const step = this.activeStep()
    if (!step || this.phase === 'verifying') return

    switch (ev.event) {
      case 'UserPromptSubmit':
        if (this.submitted && step.status === 'waiting') {
          // The user answered claude's question in the terminal.
          step.status = 'running'
          this.questionPending = false
          this.message = `${this.label(step)} running`
          this.line(`${this.label(step)}: user replied in the terminal`)
          this.changed()
        } else {
          this.submitted = true
          this.line(`${this.label(step)}: prompt accepted by claude`)
        }
        break
      case 'PostToolUse':
        this.stallWarned = false
        if (step.status === 'waiting' && !this.questionPending) {
          step.status = 'running'
          this.message = `${this.label(step)} running`
          this.line(`${this.label(step)}: user responded, claude is working again`)
          this.changed()
        }
        break
      case 'Notification': {
        const type = String(p.notification_type ?? '')
        const msg = String(p.message ?? 'claude is waiting for you')
        this.line(`${this.label(step)}: notification [${type}] ${msg}`)
        if (!ATTENTION_TYPES.has(type) || !this.submitted || this.questionPending) break
        step.status = 'waiting'
        this.message = `${this.label(step)}: waiting for you — ${msg}`
        this.notify('attention', `Chain Prompt: ${this.label(step)} needs you`, msg)
        this.changed()
        break
      }
      case 'Stop':
        // A Stop before our prompt was accepted belongs to an earlier turn.
        if (this.submitted) this.onTurnEnd(step, String(p.last_assistant_message ?? ''), String(p.transcript_path ?? ''))
        break
      case 'StopFailure':
        this.failStep(step, `API error (${String(p.error_type ?? 'unknown')}): ${String(p.error_message ?? '')}`.trim(), true)
        break
      case 'SessionEnd':
        this.failStep(step, 'The claude session ended')
        break
    }
  }

  private onTurnEnd(step: Step, lastMessage: string, transcript: string): void {
    // Finished after a stall-pause: complete the step, but stay paused afterwards.
    if (this.phase === 'paused') this.pauseRequested = true
    step.output = lastMessage.length > MAX_OUTPUT ? `${lastMessage.slice(0, MAX_OUTPUT)}\n…` : lastMessage
    if (transcript) {
      const u = usageFromTranscript(transcript, this.turnStartedAt, Date.now(), this.countedMessages)
      if (u) step.usage = addUsage(step.usage, u)
    }
    if (lastMessage) this.block('  Claude last message:', lastMessage)
    if (this.getSettings().detectQuestions && looksLikeQuestion(lastMessage)) {
      step.status = 'waiting'
      this.questionPending = true
      this.message = `${this.label(step)}: claude asked a question — answer it in the terminal, or press Resume to carry on`
      this.line(`${this.label(step)}: turn ended with a question, waiting for the user`)
      this.notify('attention', `Chain Prompt: ${this.label(step)} has a question`, lastMessage.slice(-300))
      return this.changed()
    }
    this.afterTurn(step)
  }

  /** The turn is over and accepted: verify if configured, else the step is done. */
  private afterTurn(step: Step): void {
    if (step.verify) void this.verifyStep(step, this.gen)
    else this.completeStep(step)
  }

  private async verifyStep(step: Step, g: number): Promise<void> {
    const settings = this.getSettings()
    this.phase = 'verifying'
    this.submitted = false
    this.message = `${this.label(step)}: verifying with \`${step.verify}\`…`
    this.line(`${this.label(step)}: verify \`${step.verify}\``)
    this.changed()
    this.command = runCommand(step.verify!, this.cwd!, { timeoutMs: settings.commandTimeoutMin * 60_000 })
    const r = await this.command.done
    this.command = null
    if (g !== this.gen || !ACTIVE.has(step.status)) return
    step.verifyOutput = r.output.slice(-4000)
    if (r.code === 0) {
      this.line(`${this.label(step)}: verification passed`)
      return this.completeStep(step)
    }
    const why = r.timedOut ? `timed out after ${settings.commandTimeoutMin} min` : `exit code ${r.code}`
    this.block(`${this.label(step)}: verification failed (${why}):`, r.output.slice(-2000) || '(no output)')
    const loops = step.loops ?? 0
    const max = step.maxLoops ?? 0
    if (loops < max) {
      step.loops = loops + 1
      step.note = `Verification failed (${why}) — fix attempt ${step.loops}/${max}`
      const text = renderPrompt(step.fixPrompt || step.prompt, this.variablesFor(step))
      return void this.sendTurn(step, text, g)
    }
    const lastLine = r.output.split('\n').filter((l) => l.trim()).pop() ?? ''
    this.failStep(step, `Verification \`${step.verify}\` failed (${why})${max ? ` after ${max} fix attempt(s)` : ''}${lastLine ? `: ${lastLine.slice(0, 200)}` : ''}`)
  }

  private completeStep(step: Step): void {
    step.status = 'done'
    step.endedAt = Date.now()
    step.note = step.loops ? `Passed after ${step.loops} fix attempt(s)` : undefined
    this.questionPending = false
    const dur = formatDuration(step.endedAt - (step.startedAt ?? step.endedAt))
    const cost = step.usage?.costUsd != null ? ` · ~$${step.usage.costUsd.toFixed(2)}` : ''
    this.line(`${this.label(step)} done (${dur}${cost})`)
    this.log?.writeSummary(this.steps)
    if (step.checkpoint && this.cwd) void this.recordDiff(step, step.checkpoint)
    this.scheduleNext(step, `${this.label(step)} done (${dur})`)
  }

  private async recordDiff(step: Step, checkpoint: string): Promise<void> {
    try {
      const [summary, full] = await diffStatSince(this.cwd!, checkpoint)
      step.diffStat = summary
      this.block(`${this.label(step)} changes:`, full || 'no changes')
      this.log?.writeSummary(this.steps)
      this.changed()
    } catch {
      /* not fatal */
    }
  }

  /** Move on after `step` finished (done, skipped by condition, or failed with onError: skip). */
  private scheduleNext(step: Step, doneMessage: string): void {
    const next = this.nextRunnable(this.indexOf(step) + 1)
    // Also covers a stall-pause: the step finished late, but stay paused.
    if (this.pauseRequested || this.phase === 'paused') {
      this.pauseRequested = false
      return this.enterPaused(`${doneMessage} — chain paused`)
    }
    if (!next) return this.finish()

    const delay = Math.max(0, this.getSettings().stepDelayMs)
    this.phase = 'between'
    this.message = `${doneMessage} — next step in ${Math.round(delay / 100) / 10}s`
    this.changed()
    const g = this.gen
    this.timer = setTimeout(() => {
      this.timer = null
      if (g !== this.gen) return
      // Look up again: the queue may have changed during the delay.
      const n = this.nextRunnable(this.indexOf(step) + 1) ?? this.nextRunnable(0)
      if (!n) return this.finish()
      if (this.pauseRequested) {
        this.pauseRequested = false
        return this.enterPaused('Chain paused')
      }
      void this.runStep(n, g, true)
    }, delay)
  }

  private failStep(step: Step, reason: string, retryable = false): void {
    this.gen++ // cancel anything in flight for this step
    this.clearTimer()
    this.killCommand()
    this.questionPending = false
    const settings = this.getSettings()
    step.status = 'error'
    step.endedAt = Date.now()
    step.note = reason
    this.currentStepId = step.id
    this.line(`${this.label(step)} ERROR: ${reason}`)
    this.log?.writeSummary(this.steps)

    const attempts = step.attempts ?? 0
    const maxRetries = step.onError === 'retry' ? Math.max(1, settings.retryMax) : retryable ? settings.retryMax : 0
    if (attempts < maxRetries && !this.pauseRequested) {
      step.attempts = attempts + 1
      const delay = Math.max(0, settings.retryDelaySec) * 1000
      step.note = `${reason} — retry ${step.attempts}/${maxRetries} in ${Math.round(delay / 1000)}s`
      this.phase = 'between'
      this.message = `${this.label(step)} failed, retrying in ${Math.round(delay / 1000)}s (${step.attempts}/${maxRetries})`
      this.line(this.message)
      this.changed()
      const g = this.gen
      this.timer = setTimeout(() => {
        this.timer = null
        if (g === this.gen) void this.runStep(step, g, false)
      }, delay)
      return
    }

    this.notify('error', `Chain Prompt: ${this.label(step)} failed`, reason)
    if (step.onError === 'skip' && !this.pauseRequested) {
      this.line(`${this.label(step)}: on error = skip, continuing with the next step`)
      return this.scheduleNext(step, `${this.label(step)} failed (skipped)`)
    }
    this.pauseRequested = false
    this.enterPaused(`${this.label(step)} failed, chain paused: ${reason}`)
  }

  private enterPaused(message: string): void {
    this.phase = 'paused'
    this.message = message
    this.line(message)
    this.changed()
  }

  private finish(): void {
    this.clearTimer()
    this.phase = 'completed'
    this.pauseRequested = false
    this.currentStepId = null
    const done = this.steps.filter((s) => s.status === 'done')
    const total = done.reduce((acc, s) => acc + ((s.endedAt ?? 0) - (s.startedAt ?? 0)), 0)
    const cost = totalCost(this.steps)
    this.message = `Chain completed — ${done.length}/${this.steps.length} steps in ${formatDuration(total)}${cost !== null ? ` · ~$${cost.toFixed(2)}` : ''}`
    this.line(this.message)
    this.log?.writeSummary(this.steps)
    const log = this.log
    this.log = null
    const action = this.getSettings().gitFinishAction
    if (action !== 'none' && this.gitRepo && this.cwd) void this.gitFinish(action, log)
    else this.notify('done', 'Chain Prompt: chain completed', this.message)
    this.changed()
  }

  private async gitFinish(action: 'commit' | 'branch' | 'branchPush', log: RunLog | null): Promise<void> {
    const s = this.getSettings()
    const name = this.opts.getName?.() || 'chain'
    const r = await finishChain(this.cwd!, action, s.gitBranchPrefix, `Chain Prompt: ${name} (${this.steps.filter((x) => x.status === 'done').length} steps)`)
    log?.line(r.message)
    this.emit('log', r.message)
    if (this.phase === 'completed') this.message = `${this.message} · ${r.message}`
    this.notify(r.ok ? 'done' : 'error', 'Chain Prompt: chain completed', `${this.message}`)
    this.changed()
  }

  private checkIdle(): void {
    const step = this.activeStep()
    const mins = step?.idleTimeoutMin ?? this.getSettings().idleTimeoutMin
    if (!step || step.status !== 'running' || mins <= 0 || this.stallWarned || this.phase !== 'active') return
    const session = this.sm.current
    if (!session) return
    const idleMs = Date.now() - Math.max(session.lastOutputAt, this.turnStartedAt, step.startedAt ?? 0)
    if (idleMs < mins * 60_000) return
    this.stallWarned = true
    this.phase = 'paused' // step keeps running; a later Stop still marks it done
    this.message = `${this.label(step)}: no output for ${mins} min, it may be stuck — chain paused. Check the terminal.`
    this.line(this.message)
    this.notify('attention', `Chain Prompt: ${this.label(step)} may be stuck`, `No terminal output for ${mins} minutes.`)
    this.changed()
  }

  private killCommand(): void {
    this.command?.kill()
    this.command = null
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  dispose(): void {
    clearInterval(this.watchdog)
    this.clearTimer()
    this.killCommand()
  }
}

function resetRuntime(s: Step): void {
  for (const k of ['startedAt', 'endedAt', 'note', 'output', 'attempts', 'loops', 'verifyOutput', 'usage', 'diffStat', 'checkpoint'] as const) {
    delete s[k]
  }
  s.status = 'pending'
}

export function totalCost(steps: Step[]): number | null {
  const withUsage = steps.filter((s) => s.usage)
  if (!withUsage.length) return null
  let sum = 0
  for (const s of withUsage) {
    if (s.usage!.costUsd === null) return null
    sum += s.usage!.costUsd
  }
  return sum
}
