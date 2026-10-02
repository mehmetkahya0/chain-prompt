/**
 * Plain-Node entry for headless runs (no Electron needed):
 *
 *   npm run cli -- run my.chain.json --cwd ../project --var feature="dark mode"
 *
 * Remote notifications (ntfy, Slack, Discord, Telegram) use the app's saved
 * settings when --settings <state.json> is given.
 */
import { readFileSync } from 'node:fs'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { HEADLESS_USAGE, parseHeadlessArgs, runHeadless } from '../main/headless'
import { sendRemoteNotice } from '../main/notifier'

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args[0] !== 'run') {
    console.log(HEADLESS_USAGE)
    return args.length ? 2 : 0
  }
  let base: Settings = DEFAULT_SETTINGS
  const si = args.indexOf('--settings')
  if (si >= 0) {
    try {
      const raw = JSON.parse(readFileSync(args[si + 1], 'utf8'))
      base = { ...DEFAULT_SETTINGS, ...(raw.settings ?? raw) }
    } catch (e) {
      console.error(`error: cannot read settings: ${(e as Error).message}`)
      return 2
    }
    args.splice(si, 2)
  }
  const o = parseHeadlessArgs(args.slice(1), base)
  if (o === 'help') {
    console.log(HEADLESS_USAGE)
    return 0
  }
  if (typeof o === 'string') {
    console.error(`error: ${o}\n\n${HEADLESS_USAGE}`)
    return 2
  }
  return runHeadless(o, (kind, title, body) => void sendRemoteNotice(o.settings, kind, title, body))
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
