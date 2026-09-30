import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { SessionInfo, SessionMode, Settings } from '../../shared/types'
import { HookServer, type HookEvent } from './hookServer'
import { removeHookSettingsFile, writeHookSettingsFile } from './claudeSettings'
import { ClaudeSession } from './ptySession'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Owns the hook server and the one live claude pty. Emits:
 *  - 'data' (chunk)        terminal output of the current session
 *  - 'reset'               a new pty replaced the old one (clear the terminal)
 *  - 'hook' (HookEvent)    hook calls from the *current* launch only
 *  - 'exit' (code)         the pty process ended
 *  - 'change'              SessionInfo changed
 */
export class SessionManager extends EventEmitter {
  readonly hooks = new HookServer()
  private session: ClaudeSession | null = null
  private settingsFile: string | null = null
  private cols = 100
  private rows = 30
  /** SessionStart seen for the current launch and no SessionEnd since. */
  ready = false
  /** Source of the latest SessionStart (startup, resume, clear, compact...). */
  lastStartSource = ''
  lastStartAt = 0
  cwd: string | null = null
  mode: SessionMode = 'new'

  constructor(private readonly getSettings: () => Settings) {
    super()
    this.hooks.on('hook', (ev: HookEvent) => this.onHook(ev))
  }

  async init(): Promise<void> {
    await this.hooks.start()
  }

  get current(): ClaudeSession | null {
    return this.session
  }

  info(): SessionInfo {
    return { cwd: this.cwd, alive: !!this.session?.alive, claudeReady: this.ready, mode: this.mode }
  }

  setSize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.session?.resize(cols, rows)
  }

  /** Kill any running session and start claude fresh in `cwd`. */
  start(cwd: string, mode: SessionMode): ClaudeSession {
    this.dispose()
    const s = this.getSettings()
    this.cwd = cwd
    this.mode = mode
    this.ready = false
    this.lastStartSource = ''

    const launchId = randomUUID()
    this.settingsFile = writeHookSettingsFile({
      baseUrl: this.hooks.baseUrl(),
      token: this.hooks.token,
      launchId,
      transport: s.hookTransport
    })
    const session = new ClaudeSession({
      launchId,
      cwd,
      mode,
      claudeCommand: s.claudeCommand || 'claude',
      settingsFile: this.settingsFile,
      permissionMode: s.permissionMode,
      extraArgs: s.extraArgs,
      cols: this.cols,
      rows: this.rows
    })
    this.session = session
    this.emit('reset')
    session.on('data', (d: string) => {
      if (this.session === session) this.emit('data', d)
    })
    session.on('exit', (code: number) => {
      if (this.session !== session) return
      this.ready = false
      this.emit('exit', code)
      this.emit('change')
    })
    session.start()
    this.emit('change')
    return session
  }

  private onHook(ev: HookEvent): void {
    // Ignore stragglers from a previous launch (e.g. SessionEnd of a killed pty).
    if (!this.session || ev.launchId !== this.session.launchId) return
    if (ev.event === 'SessionStart') {
      this.ready = true
      this.lastStartSource = String(ev.payload.source ?? '')
      this.lastStartAt = ev.receivedAt
      this.emit('change')
    } else if (ev.event === 'SessionEnd') {
      this.ready = false
      this.emit('change')
    }
    this.emit('hook', ev)
  }

  /**
   * Resolve once claude is ready for input: a SessionStart newer than `since`
   * has arrived and the terminal has been quiet for a moment (the TUI
   * finishes drawing the input box after the hook fires).
   * Resolves false on timeout, pty exit, or when `cancelled()` turns true.
   */
  async waitReady(opts: { since?: number; timeoutMs: number; cancelled: () => boolean }): Promise<boolean> {
    const since = opts.since ?? 0
    const deadline = opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Infinity
    while (!(this.ready && this.lastStartAt > since)) {
      if (opts.cancelled() || !this.session?.alive || Date.now() > deadline) return false
      await sleep(150)
    }
    await this.waitQuiet(700, 6000)
    return !opts.cancelled() && !!this.session?.alive
  }

  /** Wait until no output arrived for `quietMs` (or `maxMs` passed). */
  async waitQuiet(quietMs: number, maxMs: number): Promise<void> {
    const end = Date.now() + maxMs
    await sleep(Math.min(quietMs, maxMs))
    while (Date.now() < end && this.session && Date.now() - this.session.lastOutputAt < quietMs) await sleep(100)
  }

  write(data: string): void {
    this.session?.write(data)
  }

  dispose(): void {
    const old = this.session
    this.session = null
    this.ready = false
    old?.removeAllListeners()
    old?.kill()
    removeHookSettingsFile(this.settingsFile)
    this.settingsFile = null
  }

  async shutdown(): Promise<void> {
    this.dispose()
    await this.hooks.stop()
  }
}
