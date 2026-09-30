/**
 * Headless end-to-end check of the chain engine with a real `claude`:
 * runs a 3-step chain and verifies each Stop hook triggered the next prompt.
 *
 *   npm run test:chain -- [folder]
 *
 * Without a folder a temp dir is used; its "trust this folder" dialog is
 * accepted automatically (test only — the app itself never does this).
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import { SessionManager } from '../src/main/core/sessionManager'
import { ChainRunner } from '../src/main/core/chainRunner'
import { logsDir } from '../src/main/core/runLog'
import type { HookEvent } from '../src/main/core/hookServer'

async function main() {
  const folder = process.argv[2] || mkdtempSync(join(tmpdir(), 'chain-smoke-'))
  const settings: Settings = { ...DEFAULT_SETTINGS, stepDelayMs: 1000, desktopNotifications: false }
  const t0 = Date.now()
  const log = (s: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}`)

  const sm = new SessionManager(() => settings)
  await sm.init()
  log(`hook server ${sm.hooks.baseUrl()} — folder ${folder}`)

  let screen = ''
  let trusted = false
  sm.on('data', (d: string) => {
    screen = (screen + d.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, '').replace(/\s+/g, '')).slice(-4000)
    if (!trusted && screen.includes('Itrustthisfolder')) {
      trusted = true
      log('trust dialog -> accepting (test only)')
      setTimeout(() => {
        sm.write('\x1b[B')
        setTimeout(() => sm.write('\r'), 300)
      }, 800)
    }
  })
  sm.on('hook', (ev: HookEvent) => {
    const extra =
      ev.event === 'Stop'
        ? ` last_assistant_message=${JSON.stringify(String(ev.payload.last_assistant_message ?? '').slice(0, 60))}`
        : ev.event === 'SessionStart'
          ? ` source=${ev.payload.source}`
          : ev.event === 'UserPromptSubmit'
            ? ` prompt=${JSON.stringify(String(ev.payload.prompt ?? '').slice(0, 70))}`
            : ''
    log(`HOOK ${ev.event}${extra}`)
  })

  const notices: string[] = []
  const chain = new ChainRunner(sm, () => settings, (kind, title, body) => {
    notices.push(kind)
    log(`NOTIFY[${kind}] ${title} — ${body}`)
  })
  let lastMsg = ''
  chain.on('change', () => {
    const snap = chain.snapshot()
    const line = `${snap.state} | ${snap.steps.map((s) => s.status).join(',')} | ${snap.message}`
    if (line !== lastMsg) log(`STATE ${line}`)
    lastMsg = line
  })

  chain.applyQueueOp({ type: 'add', prompt: 'Reply with exactly the word ALPHA and nothing else. Do not use any tools.' })
  chain.applyQueueOp({
    type: 'add',
    prompt: 'This prompt has several lines.\nLine two.\nLine three: reply with exactly the word BETA and nothing else. Do not use any tools.'
  })
  chain.applyQueueOp({
    type: 'add',
    newSession: true,
    prompt:
      'Which single word did I ask you to reply with in my very first message of this conversation? ' +
      'If this is the first message of the conversation, reply with exactly UNKNOWN. Do not use any tools.'
  })

  sm.start(folder, 'new')
  chain.start()

  const deadline = Date.now() + 6 * 60_000
  while (chain.state !== 'completed' && chain.state !== 'paused' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
  }

  const snap = chain.snapshot()
  const logs = readdirSync(logsDir(folder)).filter((f) => f.endsWith('.log'))
  const logText = logs.length ? readFileSync(join(logsDir(folder), logs[logs.length - 1]), 'utf8') : ''
  const lastReply = /Claude last message:\n\s+(.*)\n(?![\s\S]*Claude last message)/.exec(logText)?.[1]?.trim()

  const checks: [string, boolean][] = [
    ['chain completed', snap.state === 'completed'],
    ['all 3 steps done', snap.steps.every((s) => s.status === 'done')],
    ['each step has start/end timestamps', snap.steps.every((s) => s.startedAt && s.endedAt)],
    ['steps ran strictly in order', snap.steps.every((s, i) => i === 0 || (s.startedAt ?? 0) >= (snap.steps[i - 1].endedAt ?? Infinity))],
    ['log file written in .chain-prompt/logs', logs.length > 0],
    ['completion notification sent', notices.includes('done')],
    ['step 3 ran after /clear (context reset -> UNKNOWN)', lastReply === 'UNKNOWN']
  ]
  console.log('\n--- results ---')
  for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`last reply: ${lastReply}`)
  console.log(`log: ${logs.length ? join(logsDir(folder), logs[logs.length - 1]) : '-'}`)

  chain.dispose()
  await sm.shutdown()
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
