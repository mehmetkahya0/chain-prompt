/**
 * Drives the real built Electron app with Playwright:
 *  1. adds a 3-step chain through the UI (step 3 = "new session"), runs it,
 *     waits for completion and checks every card is "Done";
 *  2. closes the app while a step is running, reopens it and checks the
 *     step is shown as "Interrupted".
 *
 *   npm run test:e2e -- <trusted-folder>
 *
 * The folder must already be trusted by claude (run `claude` there once),
 * because the app never answers the trust dialog on your behalf.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const folder = process.argv[2]
if (!folder) {
  console.error('usage: npm run test:e2e -- <trusted-folder>')
  process.exit(2)
}
const userData = mkdtempSync(join(tmpdir(), 'chain-e2e-profile-'))
const shotDir = resolve('docs')
mkdirSync(shotDir, { recursive: true })

// Seed the profile with the working folder (the native folder picker can't be scripted).
writeFileSync(
  join(userData, 'state.json'),
  JSON.stringify({ cwd: folder, recentFolders: [folder], mode: 'new', steps: [], settings: { stepDelayMs: 1000, desktopNotifications: false } })
)

const t0 = Date.now()
const log = (s: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}`)
const results: [string, boolean][] = []
const check = (name: string, ok: boolean) => {
  results.push([name, ok])
  log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: [resolve('out/main/index.js')],
    env: { ...process.env, CHAIN_PROMPT_USER_DATA: userData } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForSelector('#btn-start')
  return { app, page }
}

async function statuses(page: Page): Promise<string[]> {
  return page.$$eval('#queue .card .status', (els) => els.map((e) => e.textContent?.trim() ?? ''))
}

async function main() {
  // ---------------------------------------------------------------- run 1
  let { app, page } = await launch()
  await page.setViewportSize({ width: 1440, height: 860 }).catch(() => {})
  log('app launched')

  const prompts = [
    'Reply with exactly the word ALPHA and nothing else. Do not use any tools.',
    'Second step, spread over\nmultiple lines.\nReply with exactly the word BETA and nothing else. Do not use any tools.',
    'Which single word did I ask you to reply with in my very first message of this conversation? If this is the first message, reply with exactly UNKNOWN. Do not use any tools.'
  ]
  for (const [i, p] of prompts.entries()) {
    await page.fill('#new-prompt', p)
    if (i === 2) await page.check('#new-session')
    await page.press('#new-prompt', 'Control+Enter')
  }
  await page.waitForFunction(() => document.querySelectorAll('#queue .card').length === 3)
  check('3 cards added via composer', (await statuses(page)).every((s) => s === 'Pending'))
  check('step 3 tagged "new session"', (await page.textContent('#queue .card:nth-child(3) .tag')) === 'new session')

  await page.click('#btn-start')
  log('Start clicked')
  const seen = new Set<string>()
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const pill = (await page.textContent('#chain-state'))?.trim() ?? ''
    const st = (await statuses(page)).join(', ')
    const line = `${pill} | ${st}`
    if (!seen.has(line)) {
      seen.add(line)
      log(line)
    }
    if (pill === 'Completed' || pill === 'Paused') break
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(shotDir, 'screenshot.png') })
  check('chain completed in the UI', (await page.textContent('#chain-state'))?.trim() === 'Completed')
  check('all cards "Done"', (await statuses(page)).every((s) => s === 'Done'))
  check('each card shows a duration', (await page.$$eval('#queue .card .timing strong', (e) => e.length)) === 3)
  check('terminal shows claude reply UNKNOWN', await page.evaluate(() => document.querySelector('#terminal')?.textContent?.includes('UNKNOWN') ?? false))
  check('session status "claude ready"', (await page.textContent('#session-status'))?.trim() === 'claude ready')

  // Settings dialog with the bypassPermissions warning visible (README image).
  await page.click('#btn-settings')
  await page.check('input[name="permissionMode"][value="bypassPermissions"]')
  // Lift the dialog's height cap so the image shows every section.
  await page.evaluate(() => {
    const d = document.querySelector<HTMLDialogElement>('#settings-dialog')!
    Object.assign(d.style, { maxHeight: 'none', position: 'absolute', top: '0', margin: '0 auto' })
  })
  await page.waitForTimeout(400)
  await page.locator('#settings-dialog').screenshot({ path: join(shotDir, 'settings.png') })
  check('bypassPermissions shows the risk warning', await page.isVisible('#bypass-warning'))
  await page.keyboard.press('Escape')

  // ------------------------------------------- run 2: interrupted by quit
  await page.click('#btn-clear')
  await page.click('#btn-clear') // two-click confirm
  const run2 = [
    'Write a detailed 600 word essay about the history of the terminal emulator. Do not use any tools.',
    'Summarise the essay above in three bullet points.',
    'Suggest a title for the essay.'
  ]
  for (const p of run2) {
    await page.fill('#new-prompt', p)
    await page.press('#new-prompt', 'Control+Enter')
  }
  await page.click('#btn-start')
  await page.waitForFunction(() => document.querySelector('#queue .card .status')?.textContent?.trim() === 'Running', null, {
    timeout: 120_000
  })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: join(shotDir, 'screenshot-running.png') })
  log('step running -> closing app')
  await app.close()

  ;({ app, page } = await launch())
  await page.waitForTimeout(500)
  const after = await statuses(page)
  log(`after reopen: ${after.join(', ')} | ${await page.textContent('#chain-message')}`)
  check('running step restored as "Interrupted"', after[0] === 'Interrupted')
  check('start enabled to continue from it', !(await page.isDisabled('#btn-start')))
  await app.close()

  console.log('\n--- results ---')
  for (const [n, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`)
  console.log(`screenshot: ${join(shotDir, 'screenshot.png')}`)
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
