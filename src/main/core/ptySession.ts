import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as pty from 'node-pty'
import type { PermissionMode, SessionMode } from '../../shared/types'

export interface LaunchOptions {
  /** Ties hook calls to this launch; generated when omitted. */
  launchId?: string
  cwd: string
  mode: SessionMode
  claudeCommand: string
  settingsFile: string
  permissionMode: PermissionMode
  extraArgs: string
  cols: number
  rows: number
}

const SCROLLBACK_LIMIT = 512 * 1024

// Session markers set when this app itself was started from inside a Claude
// Code session. If they leak into the child, claude treats itself as a nested
// child session (e.g. transcript saving off), which is not what we want.
const STRIP_ENV = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT'
])

export function buildClaudeArgs(o: Pick<LaunchOptions, 'mode' | 'settingsFile' | 'permissionMode' | 'extraArgs'>): string[] {
  const args = ['--settings', o.settingsFile]
  if (o.mode === 'continue') args.push('--continue')
  if (o.permissionMode !== 'default') args.push('--permission-mode', o.permissionMode)
  const extra = o.extraArgs.trim()
  if (extra) args.push(...extra.split(/\s+/))
  return args
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Pick the user's shell per OS and build argv that runs claude inside it.
 * When claude exits, the shell stays open so the terminal remains usable.
 */
export function shellInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { file: string; argv: string[] } {
  if (platform === 'win32') {
    const line = ['&', psQuote(command), ...args.map(psQuote)].join(' ')
    return {
      file: 'powershell.exe',
      argv: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', line]
    }
  }
  const shell =
    process.env.SHELL && existsSync(process.env.SHELL)
      ? process.env.SHELL
      : platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash'
  const line = [shQuote(command), ...args.map(shQuote)].join(' ')
  // -i -l so PATH additions from .zshrc/.bashrc/.profile (where claude usually
  // lives) are visible; afterwards drop into a plain interactive shell.
  return { file: shell, argv: ['-i', '-l', '-c', `${line}; exec ${shQuote(shell)} -i -l`] }
}

/**
 * A pty running claude inside the user's shell. Emits:
 *  - 'data' (chunk: string)
 *  - 'exit' (code: number)
 */
export class ClaudeSession extends EventEmitter {
  readonly launchId: string
  readonly cwd: string
  readonly mode: SessionMode
  private proc: pty.IPty | null = null
  private scrollback = ''
  lastOutputAt = Date.now()

  constructor(private readonly opts: LaunchOptions) {
    super()
    this.launchId = opts.launchId ?? randomUUID()
    this.cwd = opts.cwd
    this.mode = opts.mode
  }

  get alive(): boolean {
    return this.proc !== null
  }

  start(): void {
    const { file, argv } = shellInvocation(this.opts.claudeCommand, buildClaudeArgs(this.opts))
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.has(k)) env[k] = v
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    // Apps opened from Finder/Dock get no locale from launchd, which makes
    // claude's UI fall back to ASCII. Terminal.app sets this, so do we.
    if (process.platform !== 'win32' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8'

    this.proc = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols: Math.max(20, this.opts.cols),
      rows: Math.max(5, this.opts.rows),
      cwd: this.opts.cwd,
      env
    })
    this.proc.onData((d) => {
      this.lastOutputAt = Date.now()
      this.scrollback += d
      if (this.scrollback.length > SCROLLBACK_LIMIT) this.scrollback = this.scrollback.slice(-SCROLLBACK_LIMIT / 2)
      this.emit('data', d)
    })
    this.proc.onExit(({ exitCode }) => {
      this.proc = null
      this.emit('exit', exitCode)
    })
  }

  /** Everything printed so far (bounded), for re-attaching a reloaded renderer. */
  getScrollback(): string {
    return this.scrollback
  }

  write(data: string): void {
    this.proc?.write(data)
  }

  /**
   * Type a (possibly multi-line) prompt into claude's input box using
   * bracketed paste, so embedded newlines don't submit early.
   * Enter is sent separately by the caller after a short delay.
   */
  pastePrompt(text: string): void {
    const body = text.replace(/\r\n/g, '\n').replace(/\x1b\[20[01]~/g, '')
    this.write(`\x1b[200~${body}\x1b[201~`)
  }

  pressEnter(): void {
    this.write('\r')
  }

  resize(cols: number, rows: number): void {
    if (!this.proc || cols < 2 || rows < 2) return
    try {
      this.proc.resize(cols, rows)
    } catch {
      /* pty may have just exited */
    }
  }

  kill(): void {
    const p = this.proc
    this.proc = null
    if (!p) return
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  }
}
