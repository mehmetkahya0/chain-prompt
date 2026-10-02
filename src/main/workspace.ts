import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { ChainFile, ChainVariable, Schedule, SessionMode, Settings, WorkspaceState } from '../shared/types'
import { isBuiltinVariable, variableNames } from '../shared/variables'
import { ChainRunner, type Notify } from './core/chainRunner'
import { SessionManager } from './core/sessionManager'
import type { HookServer } from './core/hookServer'
import { isGitRepo } from './core/git'
import type { PersistedWorkspace } from './store'

/**
 * One tab: a working folder with its own claude pty and its own chain.
 * Emits 'change' (state for the UI changed), 'persist' (something worth
 * saving changed), 'data' (pty chunk) and 'reset' (terminal replaced).
 */
export class Workspace extends EventEmitter {
  readonly id: string
  name: string
  variables: ChainVariable[]
  schedule: Schedule | null
  isGitRepo = false
  readonly sm: SessionManager
  readonly chain: ChainRunner

  constructor(data: PersistedWorkspace, hooks: HookServer, getSettings: () => Settings, notify: Notify) {
    super()
    this.id = data.id
    this.name = data.name
    this.variables = data.variables
    this.schedule = data.schedule
    this.sm = new SessionManager(getSettings, hooks)
    this.sm.cwd = data.cwd && existsSync(data.cwd) ? data.cwd : null
    this.sm.mode = data.mode
    this.chain = new ChainRunner(this.sm, getSettings, notify, {
      getVariables: () => Object.fromEntries(this.variables.map((v) => [v.name, v.value])),
      getName: () => this.name
    })
    this.chain.restore(data.steps)
    this.chain.on('change', () => {
      this.syncVariables()
      this.emit('persist')
      this.emit('change')
    })
    this.sm.on('change', () => this.emit('change'))
    this.sm.on('data', (d: string) => this.emit('data', d))
    this.sm.on('reset', () => this.emit('reset'))
    this.syncVariables()
    void this.refreshGit()
  }

  async refreshGit(): Promise<void> {
    const repo = this.sm.cwd ? await isGitRepo(this.sm.cwd).catch(() => false) : false
    if (repo !== this.isGitRepo) {
      this.isGitRepo = repo
      this.emit('change')
    }
  }

  /** Keep exactly one variable row for every {{name}} the prompts use. */
  private syncVariables(): void {
    const used = variableNames(...this.chain.steps.flatMap((s) => [s.prompt, s.fixPrompt])).filter((n) => !isBuiltinVariable(n))
    const next = used.map((name) => this.variables.find((v) => v.name === name) ?? { name, value: '' })
    const same = next.length === this.variables.length && next.every((v, i) => v === this.variables[i])
    if (!same) this.variables = next
  }

  state(): WorkspaceState {
    return {
      id: this.id,
      name: this.name,
      chain: this.chain.snapshot(),
      session: this.sm.info(),
      variables: this.variables.map((v) => ({ ...v })),
      schedule: this.schedule,
      isGitRepo: this.isGitRepo
    }
  }

  toPersisted(): PersistedWorkspace {
    return {
      id: this.id,
      name: this.name,
      cwd: this.sm.cwd,
      mode: this.sm.mode,
      steps: this.chain.steps,
      variables: this.variables,
      schedule: this.schedule
    }
  }

  setFolder(folder: string): string | null {
    if (this.chain.isBusy) return 'Cannot change the folder while the chain is running'
    this.sm.start(folder, 'new')
    void this.refreshGit()
    this.emit('persist')
    return null
  }

  startSession(mode: SessionMode): string | null {
    if (!this.sm.cwd) return 'Pick a folder first'
    if (this.chain.isBusy) return 'Cannot restart the session while the chain is running'
    this.sm.start(this.sm.cwd, mode)
    this.emit('persist')
    return null
  }

  setVariables(values: Record<string, string>): void {
    for (const v of this.variables) if (typeof values[v.name] === 'string') v.value = values[v.name]
    this.emit('persist')
    this.emit('change')
  }

  /** Load a chain file / template into this tab. */
  loadChain(file: Partial<ChainFile> & { steps: unknown[] }, fallbackName: string): string | null {
    const err = this.chain.replaceSteps(file.steps)
    if (err) return err
    this.name = (typeof file.name === 'string' && file.name.trim()) || fallbackName
    const defs = Array.isArray(file.variables) ? file.variables.filter((v) => v && typeof v.name === 'string') : []
    for (const d of defs) {
      const existing = this.variables.find((v) => v.name === d.name)
      const value = existing?.value || (typeof d.default === 'string' ? d.default : '')
      const row = { name: d.name, value, description: typeof d.description === 'string' ? d.description : undefined }
      if (existing) Object.assign(existing, row)
      else this.variables.push(row)
    }
    this.syncVariables()
    this.emit('persist')
    this.emit('change')
    return null
  }

  setSchedule(s: Schedule | null): string | null {
    if (s && (!Number.isFinite(s.at) || s.at < Date.now() - 60_000)) return 'Pick a time in the future'
    this.schedule = s ? { at: s.at, daily: !!s.daily } : null
    this.emit('persist')
    this.emit('change')
    return null
  }

  /** Called every few seconds; starts the chain when its scheduled time has come. */
  tickSchedule(now: number, notify: Notify): void {
    const s = this.schedule
    if (!s || now < s.at) return
    const late = now - s.at
    if (s.daily) {
      let at = s.at
      while (at <= now) at += 24 * 3600_000
      this.schedule = { at, daily: true }
    } else this.schedule = null
    this.emit('persist')
    this.emit('change')
    // Missed by a lot (app was closed / machine asleep): don't surprise the user.
    if (late > 30 * 60_000) {
      notify('attention', 'Chain Prompt: scheduled run missed', `The run planned for ${new Date(s.at).toLocaleString()} was skipped.`)
      return
    }
    if (this.chain.isBusy) return
    this.chain.start()
  }

  async shutdown(): Promise<void> {
    this.chain.dispose()
    await this.sm.shutdown()
  }
}
