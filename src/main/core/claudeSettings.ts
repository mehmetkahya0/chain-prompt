import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookTransport } from '../../shared/types'
import { TOKEN_HEADER } from './hookServer'

/**
 * Hook events we subscribe to. Only Stop / StopFailure / Notification drive
 * the chain; the rest let us know when claude is ready for input, that our
 * prompt was accepted, and that it is making progress after a permission prompt.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'Notification',
  'SessionEnd'
] as const

export interface HookSettingsOptions {
  baseUrl: string
  token: string
  launchId: string
  transport: HookTransport
  platform?: NodeJS.Platform
}

// Claude Code refuses HTTP hooks for these events ("HTTP hooks are not
// supported for SessionStart" in --debug output), so they always use curl.
const COMMAND_ONLY_EVENTS = new Set(['SessionStart', 'SessionEnd'])

function hookHandler(opts: HookSettingsOptions, event: string): Record<string, unknown> {
  const url = `${opts.baseUrl}/hook/${opts.launchId}/${event}`
  if (opts.transport === 'http' && !COMMAND_ONLY_EVENTS.has(event)) {
    // Native HTTP hook: Claude Code POSTs the hook input JSON to the URL.
    return { type: 'http', url, timeout: 10, headers: { [TOKEN_HEADER]: opts.token } }
  }
  // curl fallback: the hook input arrives on stdin and is forwarded as the body.
  // Only double quotes are used so the line works in sh, cmd and PowerShell;
  // on Windows `curl.exe` avoids PowerShell's `curl` alias.
  const curl = (opts.platform ?? process.platform) === 'win32' ? 'curl.exe' : 'curl'
  const command =
    `${curl} -s -m 5 -X POST -H "content-type: application/json" ` +
    `-H "${TOKEN_HEADER}: ${opts.token}" --data-binary "@-" "${url}"`
  return { type: 'command', command, timeout: 10 }
}

/** Build the settings object passed to `claude --settings`. */
export function buildHookSettings(opts: HookSettingsOptions): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const event of HOOK_EVENTS) {
    // No matcher = match everything (all notification types, all tools, ...).
    hooks[event] = [{ hooks: [hookHandler(opts, event)] }]
  }
  return { hooks }
}

const settingsDir = () => join(tmpdir(), 'chain-prompt')

/**
 * Write the per-launch settings file. It lives in the OS temp dir, never in
 * the project or ~/.claude, so the user's own settings stay untouched;
 * Claude Code merges hooks from --settings with the user's hooks.
 */
export function writeHookSettingsFile(opts: HookSettingsOptions): string {
  mkdirSync(settingsDir(), { recursive: true })
  const file = join(settingsDir(), `hooks-${opts.launchId}.json`)
  writeFileSync(file, JSON.stringify(buildHookSettings(opts), null, 2), { mode: 0o600 })
  return file
}

export function removeHookSettingsFile(file: string | null): void {
  if (!file) return
  try {
    rmSync(file, { force: true })
  } catch {
    /* best effort */
  }
}
