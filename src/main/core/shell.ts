import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface CommandResult {
  code: number | null
  /** Combined stdout + stderr, trimmed to the last `maxOutput` characters. */
  output: string
  timedOut: boolean
  /** Killed through the returned handle (chain stopped). */
  killed: boolean
}

export interface RunningCommand {
  done: Promise<CommandResult>
  kill(): void
}

/**
 * Run a user shell command (`when` / `verify`) in the working folder.
 * Uses a login shell on macOS/Linux so PATH from the user's profile (npm,
 * pnpm, Homebrew...) is available even when the app was started from the Dock.
 */
export function runCommand(command: string, cwd: string, opts: { timeoutMs: number; maxOutput?: number }): RunningCommand {
  const maxOutput = opts.maxOutput ?? 8000
  let child: ChildProcess
  if (process.platform === 'win32') {
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd,
      windowsHide: true
    })
  } else {
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
    // detached: own process group, so a kill also stops what the command started (test runners...).
    child = spawn(shell, ['-l', '-c', command], { cwd, detached: true, env: { ...process.env, CI: process.env.CI ?? '1' } })
  }
  let output = ''
  let timedOut = false
  let killed = false
  const append = (d: Buffer) => {
    output += d.toString('utf8')
    if (output.length > maxOutput * 2) output = output.slice(-maxOutput)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)

  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      // Kill the whole tree: test runners and dev servers spawn their own children.
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
      else if (child.pid) process.kill(-child.pid, 'SIGTERM')
      else child.kill()
    } catch {
      child.kill()
    }
  }
  const timer = opts.timeoutMs > 0 ? setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs) : null

  const done = new Promise<CommandResult>((resolve) => {
    const finish = (code: number | null) => {
      if (timer) clearTimeout(timer)
      const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
      resolve({ code, output: clean.length > maxOutput ? `…${clean.slice(-maxOutput)}` : clean, timedOut, killed })
    }
    child.on('error', (e) => {
      output += `\n${e.message}`
      finish(127)
    })
    child.on('close', (code) => finish(code))
  })
  return {
    done,
    kill: () => {
      killed = true
      kill()
    }
  }
}
