import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { DEFAULT_SETTINGS, type ChainFile, type GitFinishAction, type PermissionMode, type SessionMode, type Settings } from '../shared/types'
import { HookServer } from './core/hookServer'
import { SessionManager } from './core/sessionManager'
import { ChainRunner, totalCost, type Notify } from './core/chainRunner'
import { formatDuration } from './core/runLog'

// Headless runner: `chain-prompt run <chain.json> --cwd <dir>`. No Electron
// imports, so it runs from the packaged app (`--run`) and from plain Node.

export const HEADLESS_USAGE = `Usage: chain-prompt run <chain.json> [options]

Runs a chain without the GUI and exits when it finishes.

Options:
  --cwd <dir>               Working folder (default: current directory)
  --var name=value          Set a chain variable (repeatable)
  --continue                Start claude with --continue
  --permission-mode <m>     default | acceptEdits | bypassPermissions
  --model <name>            Default model for steps without their own
  --claude <cmd>            claude command (default: claude)
  --delay <seconds>         Pause between steps (default: 2)
  --wait-user <minutes>     How long to wait when claude needs a human (default: 0 = fail at once)
  --detect-questions        Treat a turn ending in a question as "needs a human"
  --git-finish <action>     none | commit | branch | branchPush
  --no-checkpoints          Do not take git checkpoints
  --tui                     Mirror claude's terminal output to stdout
  -h, --help                Show this help

Exit codes: 0 all steps done, 1 a step failed, 2 bad usage, 3 claude needed a human, 130 interrupted.`

export interface HeadlessOptions {
  file: string
  cwd: string
  vars: Record<string, string>
  mode: SessionMode
  model: string
  waitUserMin: number
  tui: boolean
  settings: Settings
}

/** Parse CLI arguments (after the `run` word). Returns an error string for bad usage. */
export function parseHeadlessArgs(args: string[], base: Settings = DEFAULT_SETTINGS): HeadlessOptions | string {
  const o: HeadlessOptions = {
    file: '',
    cwd: process.cwd(),
    vars: {},
    mode: 'new',
    model: '',
    waitUserMin: 0,
    tui: false,
    // No human watches a headless run, so questions are not detected by default.
    settings: { ...base, desktopNotifications: false, detectQuestions: false }
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const val = () => {
      const v = args[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    try {
      switch (a) {
        case '-h':
        case '--help':
          return 'help'
        case '--cwd':
          o.cwd = resolve(val())
          break
        case '--var': {
          const v = val()
          const eq = v.indexOf('=')
          if (eq < 1) return `--var expects name=value, got "${v}"`
          o.vars[v.slice(0, eq)] = v.slice(eq + 1)
          break
        }
        case '--continue':
          o.mode = 'continue'
          break
        case '--permission-mode': {
          const m = val() as PermissionMode
          if (!['default', 'acceptEdits', 'bypassPermissions'].includes(m)) return `Unknown permission mode "${m}"`
          o.settings.permissionMode = m
          break
        }
        case '--model':
          o.model = val()
          break
        case '--claude':
          o.settings.claudeCommand = val()
          break
        case '--delay':
          o.settings.stepDelayMs = Math.max(0, Number(val()) * 1000 || 0)
          break
        case '--wait-user':
          o.waitUserMin = Math.max(0, Number(val()) || 0)
          break
        case '--detect-questions':
          o.settings.detectQuestions = true
          break
        case '--git-finish': {
          const g = val() as GitFinishAction
          if (!['none', 'commit', 'branch', 'branchPush'].includes(g)) return `Unknown --git-finish action "${g}"`
          o.settings.gitFinishAction = g
          break
        }
        case '--no-checkpoints':
          o.settings.gitCheckpoints = false
          break
        case '--tui':
          o.tui = true
          break
        default:
          if (a.startsWith('-')) return `Unknown option ${a}`
          if (o.file) return `Unexpected argument ${a}`
          o.file = resolve(a)
      }
    } catch (e) {
      return (e as Error).message
    }
  }
  if (!o.file) return 'Missing the chain file'
  return o
}

const READY_TIMEOUT_S = 120

const ts = () => new Date().toTimeString().slice(0, 8)

/** Run a chain to the end. Resolves to the process exit code. */
export async function runHeadless(o: HeadlessOptions, notify: Notify, out: (line: string) => void = (l) => console.log(l)): Promise<number> {
  let file: Partial<ChainFile> & { steps?: unknown[] }
  try {
    if (!statSync(o.cwd).isDirectory()) throw new Error('not a directory')
  } catch {
    out(`error: working folder not found: ${o.cwd}`)
    return 2
  }
  try {
    const raw = JSON.parse(readFileSync(o.file, 'utf8'))
    file = Array.isArray(raw) ? { steps: raw } : raw
  } catch (e) {
    out(`error: cannot read ${o.file}: ${(e as Error).message}`)
    return 2
  }
  const vars: Record<string, string> = {}
  for (const v of file.variables ?? []) if (v && typeof v.name === 'string') vars[v.name] = v.default ?? ''
  Object.assign(vars, o.vars)

  const settings = o.settings
  const hooks = new HookServer()
  await hooks.start()
  const sm = new SessionManager(() => settings, hooks)
  sm.cwd = o.cwd
  sm.mode = o.mode
  sm.setSize(120, 40)
  const name = (typeof file.name === 'string' && file.name) || basename(o.file).replace(/(\.chain)?\.json$/i, '')
  const chain = new ChainRunner(sm, () => settings, notify, { getVariables: () => vars, getName: () => name })
  const err = chain.replaceSteps((file.steps ?? []).map((s) => (o.model && s && typeof s === 'object' && !('model' in s) ? { ...s, model: o.model } : s)))
  const cleanup = async () => {
    chain.dispose()
    await sm.shutdown()
    await hooks.stop()
  }
  if (err) {
    out(`error: ${err}`)
    await cleanup()
    return 2
  }
  const missing = chain.missingVariables()
  if (missing.length) {
    out(`error: missing value for ${missing.map((m) => `{{${m}}}`).join(', ')} — pass --var ${missing[0]}=...`)
    await cleanup()
    return 2
  }

  if (o.tui) sm.on('data', (d: string) => process.stdout.write(d))
  else chain.on('log', (l: string) => out(`[${ts()}] ${l.split('\n')[0]}`))
  out(`[${ts()}] ${name}: ${chain.steps.length} steps in ${o.cwd}`)

  const code = await new Promise<number>((done) => {
    let waitTimer: NodeJS.Timeout | null = null
    // Nobody can answer a folder-trust or login prompt in the terminal.
    let readyTimer: NodeJS.Timeout | null = null
    const watchReady = () => {
      if (chain.state === 'starting' && !sm.ready && !readyTimer) {
        readyTimer = setTimeout(() => {
          if (chain.state !== 'starting' || sm.ready) return
          out(`[${ts()}] claude did not become ready within ${READY_TIMEOUT_S}s — is the folder trusted and claude logged in? Run \`claude\` there once.`)
          chain.stop()
          done(3)
        }, READY_TIMEOUT_S * 1000)
        readyTimer.unref?.()
      }
      if (sm.ready && readyTimer) {
        clearTimeout(readyTimer)
        readyTimer = null
      }
    }
    sm.on('change', watchReady)
    const onSigint = () => {
      chain.stop()
      done(130)
    }
    process.once('SIGINT', onSigint)
    chain.on('change', () => {
      watchReady()
      const st = chain.state
      if (st === 'waiting_user') {
        if (!waitTimer) {
          out(`[${ts()}] claude needs a human: ${chain.message}`)
          waitTimer = setTimeout(() => {
            chain.stop()
            done(3)
          }, o.waitUserMin * 60_000)
        }
        return
      }
      if (waitTimer) {
        clearTimeout(waitTimer)
        waitTimer = null
      }
      if (st === 'completed') {
        process.off('SIGINT', onSigint)
        // Give a git finish action a moment to report.
        setTimeout(() => done(chain.steps.some((s) => s.status === 'error') ? 1 : 0), settings.gitFinishAction === 'none' ? 0 : 15_000)
      } else if (st === 'paused') {
        process.off('SIGINT', onSigint)
        out(`[${ts()}] chain paused: ${chain.message}`)
        chain.stop()
        done(chain.steps.some((s) => s.status === 'error') ? 1 : 3)
      }
    })
    chain.start()
    if (chain.state === 'idle') {
      out(`error: ${chain.message}`)
      done(2)
    }
  })

  const doneSteps = chain.steps.filter((s) => s.status === 'done')
  const dur = doneSteps.reduce((a, s) => a + ((s.endedAt ?? 0) - (s.startedAt ?? 0)), 0)
  const cost = totalCost(chain.steps)
  out(`[${ts()}] ${doneSteps.length}/${chain.steps.length} steps done in ${formatDuration(dur)}${cost !== null ? ` · ~$${cost.toFixed(2)}` : ''} — exit ${code}`)
  await cleanup()
  return code
}
