import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ChainSnapshot, ChainState, QueueOp, Settings, Step } from '../../shared/types'
import type { HookEvent } from './hookServer'
import type { SessionManager } from './sessionManager'
import { RunLog, formatDuration } from './runLog'

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

/** Internal phase; the exported ChainState is derived from it (see `state`). */
type Phase = 'idle' | 'starting' | 'active' | 'between' | 'paused' | 'completed'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The chain state machine. Progress is driven only by Claude Code hooks:
 *   UserPromptSubmit -> our prompt was accepted
 *   Stop             -> step done, schedule the next one
 *   StopFailure      -> API error, step failed, chain pauses
 *   Notification     -> claude waits for the user (permission etc.)
 *   PostToolUse      -> claude is working again after a permission prompt
 *   SessionEnd / pty exit -> step failed, chain pauses
 * A watchdog pauses the chain if a running step prints nothing for too long.
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
  /** Prompts submitted per claude launch; a fresh launch needs no /clear. */
  private promptCount = new Map<string, number>()
  private log: RunLog | null = null
  private readonly watchdog: NodeJS.Timeout

  constructor(
    private readonly sm: SessionManager,
    private readonly getSettings: () => Settings,
    private readonly notify: Notify
  ) {
    super()
    sm.on('hook', (ev: HookEvent) => this.onHook(ev))
    sm.on('exit', () => {
      const step = this.activeStep()
      if (step) this.failStep(step, 'The terminal / claude process exited')
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
      case 'between': {
        if (this.activeStep()?.status === 'waiting') return 'waiting_user'
        return this.pauseRequested ? 'pausing' : 'running'
      }
      default:
        return this.phase
    }
  }

  get isBusy(): boolean {
    return this.phase === 'starting' || this.phase === 'active' || this.phase === 'between'
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
    if (!this.sm.cwd) {
      this.message = 'Pick a working folder first (top right)'
      return this.changed()
    }
    this.log = new RunLog(this.sm.cwd)
    this.pauseRequested = false
    this.gen++
    void this.runStep(next, this.gen)
  }

  pause(): void {
    if (!this.isBusy) return
    if (this.phase === 'between' && !this.activeStep()) {
      this.clearTimer()
      this.enterPaused('Paused — press "Resume" to continue')
    } else if (this.phase === 'starting') {
      // Nothing was sent yet: cancel the start sequence, the step stays pending.
      this.gen++
      this.enterPaused('Paused — press "Resume" to continue')
    } else {
      this.pauseRequested = true
      this.message = 'Will pause after the current step finishes'
      this.log?.line('Pause requested')
      this.changed()
    }
  }

  resume(): void {
    if (this.pauseRequested) {
      this.pauseRequested = false
      this.message = 'Resumed'
      this.log?.line('Pause cancelled')
      return this.changed()
    }
    if (this.phase !== 'paused') return
    // A stall-pause leaves the step running; just go back to watching it.
    if (this.activeStep()) {
      this.phase = 'active'
      this.stallWarned = false
      this.message = 'Resumed'
      return this.changed()
    }
    const cur = this.steps.find((s) => s.id === this.currentStepId)
    const next = this.nextRunnable(cur ? this.indexOf(cur) : 0) ?? this.nextRunnable(0)
    if (!next) return this.finish()
    if (!this.log && this.sm.cwd) this.log = new RunLog(this.sm.cwd)
    this.log?.line('Resumed')
    this.gen++
    void this.runStep(next, this.gen)
  }

  stop(): void {
    if (!this.isBusy && this.phase !== 'paused') return
    this.gen++
    this.clearTimer()
    this.pauseRequested = false
    const step = this.activeStep()
    if (step) {
      this.sm.write('\x1b') // Esc interrupts claude's current turn
      step.status = 'interrupted'
      step.endedAt = Date.now()
      step.note = 'Stopped by user'
      this.log?.line(`${this.label(step)} stopped (Esc sent to claude)`)
    }
    this.phase = 'idle'
    this.message = 'Chain stopped'
    this.log?.writeSummary(this.steps)
    this.changed()
  }

  skipNext(): void {
    const active = this.activeStep()
    const from = active ? this.indexOf(active) + 1 : (() => {
      const cur = this.steps.find((s) => s.id === this.currentStepId)
      return cur ? this.indexOf(cur) : 0
    })()
    const target = this.steps.slice(from).find((s) => s.status === 'pending' || s.status === 'interrupted' || s.status === 'error')
    if (!target) {
      this.message = 'No step to skip'
      return this.changed()
    }
    target.status = 'skipped'
    target.note = 'Skipped by user'
    this.message = `${this.label(target)} skipped`
    this.log?.line(`${this.label(target)} skipped`)
    this.changed()
  }

  applyQueueOp(op: QueueOp): string | null {
    const find = (id: string) => this.steps.find((s) => s.id === id)
    switch (op.type) {
      case 'add': {
        const prompt = op.prompt.trim()
        if (!prompt) return 'Cannot add an empty prompt'
        this.steps.push({ id: randomUUID(), prompt, newSession: !!op.newSession, status: 'pending' })
        break
      }
      case 'update': {
        const s = find(op.id)
        if (!s) return 'Step not found'
        if (op.prompt !== undefined) {
          if (ACTIVE.has(s.status)) return 'A running step cannot be edited'
          if (!op.prompt.trim()) return 'Prompt cannot be empty'
          s.prompt = op.prompt.trim()
        }
        if (op.newSession !== undefined) s.newSession = op.newSession
        break
      }
      case 'remove': {
        const s = find(op.id)
        if (!s) return null
        if (ACTIVE.has(s.status)) return 'A running step cannot be deleted; stop the chain first'
        this.steps = this.steps.filter((x) => x.id !== op.id)
        if (this.currentStepId === op.id) this.currentStepId = null
        break
      }
      case 'duplicate': {
        const i = this.steps.findIndex((s) => s.id === op.id)
        if (i < 0) return null
        const s = this.steps[i]
        this.steps.splice(i + 1, 0, { id: randomUUID(), prompt: s.prompt, newSession: s.newSession, status: 'pending' })
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
        Object.assign(s, { status: 'pending', startedAt: undefined, endedAt: undefined, note: undefined })
        break
      }
      case 'resetAll':
        if (this.isBusy) return 'Cannot reset while the chain is running'
        for (const s of this.steps) Object.assign(s, { status: 'pending', startedAt: undefined, endedAt: undefined, note: undefined })
        this.currentStepId = null
        this.phase = 'idle'
        this.message = ''
        break
      case 'clearAll':
        if (this.isBusy) return 'Cannot clear the queue while the chain is running'
        this.steps = []
        this.currentStepId = null
        this.phase = 'idle'
        this.message = ''
        break
    }
    this.changed()
    return null
  }

  /** Replace the whole queue (loading a chain file). */
  replaceSteps(steps: { prompt: string; newSession?: boolean }[]): string | null {
    if (this.isBusy) return 'Cannot load a chain while the chain is running'
    this.steps = steps
      .filter((s) => typeof s.prompt === 'string' && s.prompt.trim())
      .map((s) => ({ id: randomUUID(), prompt: s.prompt.trim(), newSession: !!s.newSession, status: 'pending' as const }))
    this.currentStepId = null
    this.phase = 'idle'
    this.message = `Loaded a chain with ${this.steps.length} steps`
    this.changed()
    return null
  }

  // ------------------------------------------------------------ execution

  private async runStep(step: Step, g: number): Promise<void> {
    const cancelled = () => g !== this.gen
    const settings = this.getSettings()
    this.clearTimer()
    this.phase = 'starting'
    this.currentStepId = step.id
    this.stallWarned = false

    // 1) Make sure claude is running and has reported SessionStart.
    if (!this.sm.current?.alive) {
      this.message = 'Starting claude…'
      this.changed()
      this.sm.start(this.sm.cwd!, this.sm.mode)
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
    if (step.newSession && (this.promptCount.get(launchId) ?? 0) > 0) {
      this.message = 'Resetting context…'
      this.changed()
      const t = Date.now()
      if (settings.newSessionMethod === 'restart') {
        this.log?.line(`${this.label(step)}: restarting claude (new session)`)
        this.sm.start(this.sm.cwd!, 'new')
        if (!(await this.sm.waitReady({ since: t, timeoutMs: 0, cancelled }))) {
          if (!cancelled()) this.failStep(step, 'claude could not be restarted')
          return
        }
      } else {
        this.log?.line(`${this.label(step)}: sending /clear`)
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

    // 3) Send the prompt and confirm claude accepted it.
    const session = this.sm.current!
    Object.assign(step, { status: 'running', startedAt: Date.now(), endedAt: undefined, note: undefined })
    this.phase = 'active'
    this.submitted = false
    this.message = `${this.label(step)} running`
    this.log?.block(`${this.label(step)} started${step.newSession ? ' (new session)' : ''} — prompt:`, step.prompt)
    this.log?.writeSummary(this.steps)
    this.changed()

    session.pastePrompt(step.prompt)
    // Give the TUI time to ingest a large paste before Enter.
    await sleep(Math.min(3000, 400 + Math.floor(step.prompt.length / 20)))
    if (cancelled()) return
    session.pressEnter()

    for (let attempt = 0; attempt < 2; attempt++) {
      const end = Date.now() + 8000
      while (!this.submitted && Date.now() < end && !cancelled() && ACTIVE.has(step.status)) await sleep(100)
      if (this.submitted || cancelled() || !ACTIVE.has(step.status)) return
      if (attempt === 0) {
        this.log?.line(`${this.label(step)}: no UserPromptSubmit yet, sending Enter again`)
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
    if (!step) return

    switch (ev.event) {
      case 'UserPromptSubmit':
        this.submitted = true
        this.log?.line(`${this.label(step)}: prompt accepted by claude`)
        break
      case 'PostToolUse':
        this.stallWarned = false
        if (step.status === 'waiting') {
          step.status = 'running'
          this.message = `${this.label(step)} running`
          this.log?.line(`${this.label(step)}: user responded, claude is working again`)
          this.changed()
        }
        break
      case 'Notification': {
        const type = String(p.notification_type ?? '')
        const msg = String(p.message ?? 'claude is waiting for you')
        this.log?.line(`${this.label(step)}: notification [${type}] ${msg}`)
        if (!ATTENTION_TYPES.has(type) || !this.submitted) break
        step.status = 'waiting'
        this.message = `${this.label(step)}: waiting for you — ${msg}`
        this.notify('attention', `Chain Prompt: ${this.label(step)} needs you`, msg)
        this.changed()
        break
      }
      case 'Stop':
        // A Stop before our prompt was accepted belongs to an earlier turn.
        if (this.submitted) this.completeStep(step, String(p.last_assistant_message ?? ''))
        break
      case 'StopFailure':
        this.failStep(step, `API error (${String(p.error_type ?? 'unknown')}): ${String(p.error_message ?? '')}`.trim())
        break
      case 'SessionEnd':
        this.failStep(step, 'The claude session ended')
        break
    }
  }

  private completeStep(step: Step, lastMessage: string): void {
    step.status = 'done'
    step.endedAt = Date.now()
    const dur = formatDuration(step.endedAt - (step.startedAt ?? step.endedAt))
    this.log?.line(`${this.label(step)} done (${dur})`)
    if (lastMessage) this.log?.block('  Claude last message:', lastMessage)
    this.log?.writeSummary(this.steps)

    const next = this.nextRunnable(this.indexOf(step) + 1)
    // Also covers a stall-pause: the step finished late, but stay paused.
    if (this.pauseRequested || this.phase === 'paused') {
      this.pauseRequested = false
      return this.enterPaused(`${this.label(step)} done — chain paused`)
    }
    if (!next) return this.finish()

    const delay = Math.max(0, this.getSettings().stepDelayMs)
    this.phase = 'between'
    this.message = `${this.label(step)} done (${dur}) — next step in ${Math.round(delay / 100) / 10}s`
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
      void this.runStep(n, g)
    }, delay)
  }

  private failStep(step: Step, reason: string): void {
    this.gen++ // cancel anything in flight for this step
    this.clearTimer()
    step.status = 'error'
    step.endedAt = Date.now()
    step.note = reason
    this.currentStepId = step.id
    this.pauseRequested = false
    this.log?.line(`${this.label(step)} ERROR: ${reason}`)
    this.log?.writeSummary(this.steps)
    this.notify('error', `Chain Prompt: ${this.label(step)} failed`, reason)
    this.enterPaused(`${this.label(step)} failed, chain paused: ${reason}`)
  }

  private enterPaused(message: string): void {
    this.phase = 'paused'
    this.message = message
    this.log?.line(message)
    this.changed()
  }

  private finish(): void {
    this.clearTimer()
    this.phase = 'completed'
    this.pauseRequested = false
    this.currentStepId = null
    const done = this.steps.filter((s) => s.status === 'done')
    const total = done.reduce((acc, s) => acc + ((s.endedAt ?? 0) - (s.startedAt ?? 0)), 0)
    this.message = `Chain completed — ${done.length}/${this.steps.length} steps in ${formatDuration(total)}`
    this.log?.line(this.message)
    this.log?.writeSummary(this.steps)
    this.log = null
    this.notify('done', 'Chain Prompt: chain completed', this.message)
    this.changed()
  }

  private checkIdle(): void {
    const step = this.activeStep()
    const mins = this.getSettings().idleTimeoutMin
    if (!step || step.status !== 'running' || mins <= 0 || this.stallWarned || this.phase !== 'active') return
    const session = this.sm.current
    if (!session) return
    const idleMs = Date.now() - Math.max(session.lastOutputAt, step.startedAt ?? 0)
    if (idleMs < mins * 60_000) return
    this.stallWarned = true
    this.phase = 'paused' // step keeps running; a later Stop still marks it done
    this.message = `${this.label(step)}: no output for ${mins} min, it may be stuck — chain paused. Check the terminal.`
    this.log?.line(this.message)
    this.notify('attention', `Chain Prompt: ${this.label(step)} may be stuck`, `No terminal output for ${mins} minutes.`)
    this.changed()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  dispose(): void {
    clearInterval(this.watchdog)
    this.clearTimer()
  }
}
