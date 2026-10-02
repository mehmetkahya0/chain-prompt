/**
 * Runs two chains in two tabs at the same time through the GUI, with
 * scripts/fake-claude.cjs as claude (no model, no login, no cost); then
 * checks roll back, the run history and the run comparison.
 *
 *   npm run test:e2e:parallel      (macOS / Linux)
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const shots = process.argv[2] || mkdtempSync(join(tmpdir(), 'chain-shots-'))
const userData = mkdtempSync(join(tmpdir(), 'ui-par-'))
const mkRepo = () => {
  const d = mkdtempSync(join(tmpdir(), 'par-repo-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' })
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  writeFileSync(join(d, 'keep.txt'), 'original\n'); g('add', '.'); g('commit', '-qm', 'i')
  return d
}
const a = mkRepo(), b = mkRepo()
const steps = (tag: string) => [
  { id: `${tag}1`, prompt: `WRITE keep.txt changed-by-${tag}`, newSession: false, status: 'pending' },
  { id: `${tag}2`, prompt: `WRITE new-${tag}.txt hello`, newSession: false, status: 'pending', verify: `test -f new-${tag}.txt` }
]
writeFileSync(join(userData, 'state.json'), JSON.stringify({
  recentFolders: [a, b],
  workspaces: [
    { id: 'wa', name: 'Tab A', cwd: a, mode: 'new', steps: steps('a'), variables: [], schedule: null },
    { id: 'wb', name: 'Tab B', cwd: b, mode: 'new', steps: steps('b'), variables: [], schedule: null }
  ],
  settings: { desktopNotifications: false, stepDelayMs: 300, claudeCommand: resolve('scripts/fake-claude.cjs') }
}))
const results: [string, boolean][] = []
const check = (n: string, ok: boolean) => { results.push([n, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`) }
const errors: string[] = []

void (async () => {
  const app = await electron.launch({ executablePath: electronPath as unknown as string, args: ['--no-sandbox', resolve('out/main/index.js')], env: { ...process.env, CHAIN_PROMPT_USER_DATA: userData } as Record<string, string> })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.tab')
  // Start tab A, switch, start tab B: both run at the same time.
  await page.click('#btn-start')
  await page.click('.tab:nth-child(2)')
  await page.click('#btn-start')
  await page.waitForFunction(() => document.querySelectorAll('.tab[data-state="completed"]').length === 2, null, { timeout: 60000 })
  check('two tabs ran in parallel and both completed', true)
  check('terminal shows tab B output', ((await page.textContent('#terminal')) ?? '').includes('new-b.txt'))
  check('files written in each folder', readFileSync(join(a, 'keep.txt'), 'utf8') === 'changed-by-a\n' && existsSync(join(b, 'new-b.txt')) && !existsSync(join(a, 'new-b.txt')))
  check('cost shown in queue bar', /\$\d/.test((await page.textContent('#queue-count')) ?? ''))
  check('diff stat on cards', (await page.$$('#queue .card .diffstat')).length === 2)
  await page.screenshot({ path: join(shots, 'p1-completed.png') })

  // Roll back tab A to before step 1
  await page.click('.tab:nth-child(1)')
  await page.waitForTimeout(300)
  check('terminal switched to tab A output', ((await page.textContent('#terminal')) ?? '').includes('new-a.txt'))
  const rb = '#queue .card:nth-child(1) .icon-btn[title^="Roll back"]'
  await page.click(rb); await page.click(rb)
  await page.waitForFunction(() => document.querySelector('#queue .card .status')?.textContent?.trim() === 'Pending')
  check('rollback restores files', readFileSync(join(a, 'keep.txt'), 'utf8') === 'original\n' && !existsSync(join(a, 'new-a.txt')))
  check('rolled back steps are pending', (await page.$$eval('#queue .card .status', (e) => e.map((x) => x.textContent?.trim()))).every((s) => s === 'Pending'))
  await page.screenshot({ path: join(shots, 'p2-rolledback.png') })

  // History dialog lists the run with a cost
  await page.click('#btn-history')
  await page.waitForSelector('#history-list li')
  await page.click('#history-list li')
  await page.waitForSelector('#history-detail table')
  check('history shows run detail', ((await page.textContent('#history-detail')) ?? '').includes('WRITE keep.txt'))
  await page.locator('#history-dialog').screenshot({ path: join(shots, 'p3-history.png') })
  await page.click('#history-dialog button[value="cancel"]')

  // Run A again so history has two runs, then compare
  await page.click('#btn-start')
  await page.waitForFunction(() => document.querySelector('.tab:nth-child(1)')?.getAttribute('data-state') === 'completed', null, { timeout: 30000 })
  await page.click('#btn-history')
  await page.waitForFunction(() => document.querySelectorAll('#history-list li').length === 2)
  await page.check('#history-list li:nth-child(1) input')
  await page.check('#history-list li:nth-child(2) input')
  await page.waitForSelector('#history-detail tfoot')
  check('two runs compared', ((await page.textContent('#history-detail h3')) ?? '') === 'Comparison')
  await page.locator('#history-dialog').screenshot({ path: join(shots, 'p4-compare.png') })
  await app.close()
  check(`no renderer errors ${errors.join('|')}`, errors.length === 0)
  const failed = results.filter(([, ok]) => !ok).length
  console.log(failed ? `${failed} FAILED` : 'all passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
