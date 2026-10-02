/**
 * Drives the built app through the UI features without a real claude:
 * old-state migration, variables, step options, output / cost display,
 * filter, bulk actions, templates, schedule, tabs, settings, shortcuts and
 * persistence across a restart.
 *
 *   npm run test:e2e:ui            (Linux CI: xvfb-run -a npm run test:e2e:ui)
 */
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const shots = process.argv[2] || mkdtempSync(join(tmpdir(), 'chain-shots-'))
const userData = mkdtempSync(join(tmpdir(), 'ui-profile-'))
const repo = mkdtempSync(join(tmpdir(), 'ui-repo-'))
execFileSync('git', ['init', '-q'], { cwd: repo })
// Old (pre-tabs) state format, to exercise the migration.
writeFileSync(join(userData, 'state.json'), JSON.stringify({
  cwd: repo, recentFolders: [repo], mode: 'new',
  steps: [{ id: 'a', prompt: 'Old step from v1 state', newSession: false, status: 'done', startedAt: Date.now() - 65000, endedAt: Date.now() - 1000,
    output: 'All done. I changed 3 files.', usage: { inputTokens: 1200, outputTokens: 3400, cacheWriteTokens: 0, cacheReadTokens: 50000, costUsd: 0.12, models: ['claude-opus-5-5'] }, diffStat: '3 files changed, 42 insertions(+), 7 deletions(-)', checkpoint: 'deadbeef' }],
  settings: { desktopNotifications: false }
}))
const errors: string[] = []
const results: [string, boolean][] = []
const check = (n: string, ok: boolean) => { results.push([n, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`) }

async function main() {
  const app = await electron.launch({
    executablePath: electronPath as unknown as string,
    args: ['--no-sandbox', resolve('out/main/index.js')],
    env: { ...process.env, CHAIN_PROMPT_USER_DATA: userData } as Record<string, string>
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('#queue .card')
  check('old state migrated: step shown', (await page.$$('#queue .card')).length === 1)
  check('tab label = folder name', ((await page.textContent('.tab.active .tab-label')) ?? '').startsWith('ui-repo-'))

  for (const p of ['Plan {{feature}} for {{folderName}}', 'Implement it', 'Run tests']) {
    await page.fill('#new-prompt', p)
    await page.press('#new-prompt', 'Control+Enter')
  }
  await page.waitForFunction(() => document.querySelectorAll('#queue .card').length === 4)
  check('variables bar shows missing {{feature}}', await page.isVisible('#variables-bar .var-chip.missing'))

  // Start should be refused because of the missing variable.
  await page.click('#btn-start')
  await page.waitForTimeout(300)
  check('start refused for missing variable', /feature/.test((await page.textContent('#chain-message')) ?? ''))

  // Edit step 4 with advanced options
  await page.hover('#queue .card:nth-child(4)')
  await page.click('#queue .card:nth-child(4) .icon-btn[title="Edit"]')
  await page.click('#queue .card:nth-child(4) details.advanced summary')
  const card4 = '#queue .card:nth-child(4)'
  await page.fill(`${card4} input[list]`, 'sonnet')
  await page.fill(`${card4} input[placeholder="e.g. npm test"]`, 'npm test')
  await page.fill(`${card4} input[placeholder="0"]`, '3')
  await page.selectOption(`${card4} .opt-field select >> nth=1`, 'skip')
  await page.screenshot({ path: join(shots, '1-edit-options.png') })
  await page.click(`${card4} .btn.primary`)
  await page.waitForTimeout(200)
  const tags4 = await page.$$eval(`${card4} .tag`, (e) => e.map((x) => x.textContent))
  check(`tags shown (${tags4.join('|')})`, tags4.includes('sonnet') && tags4.includes('verify ×3') && tags4.includes('on error: skip'))

  // Variables dialog
  await page.click('#btn-variables')
  await page.fill('#variables-fields textarea[data-name="feature"]', 'dark mode')
  await page.screenshot({ path: join(shots, '2-variables.png') })
  await page.click('#variables-dialog button[value="save"]')
  await page.waitForTimeout(200)
  check('variable filled', !(await page.isVisible('#variables-bar .var-chip.missing')))

  // Output preview of migrated step
  await page.click('#queue .card:nth-child(1) .output-toggle')
  check('claude reply preview', await page.isVisible('#queue .card:nth-child(1) pre.output'))
  check('usage shown', ((await page.textContent('#queue .card:nth-child(1) .timing')) ?? '').includes('$0.12'))
  check('rollback button present', !!(await page.$('#queue .card:nth-child(1) .icon-btn[title^="Roll back"]')))
  await page.screenshot({ path: join(shots, '3-queue.png') })

  // Search
  await page.fill('#queue-search', 'implement')
  await page.waitForTimeout(100)
  check('filter narrows the queue', (await page.$$('#queue .card')).length === 1)
  await page.fill('#queue-search', '')
  await page.dispatchEvent('#queue-search', 'input')

  // Bulk select via shortcut
  await page.keyboard.press('Control+Shift+A')
  await page.waitForSelector('#bulk-bar:not([hidden])')
  await page.check('#queue .card:nth-child(2) .select-box')
  await page.check('#queue .card:nth-child(3) .select-box')
  await page.screenshot({ path: join(shots, '4-bulk.png') })
  await page.click('#bulk-bar [data-bulk="skip"]')
  await page.waitForTimeout(200)
  const st = await page.$$eval('#queue .card .status', (e) => e.map((x) => x.textContent?.trim()))
  check(`bulk skip (${st.join(',')})`, st[1] === 'Skipped' && st[2] === 'Skipped')
  await page.keyboard.press('Control+Shift+A')

  // Templates
  await page.click('#btn-templates')
  await page.screenshot({ path: join(shots, '5-templates.png') })
  await page.click('#template-list li:nth-child(2) .btn.primary')
  await page.waitForSelector('#variables-dialog[open]')
  check('template loaded and variables asked', (await page.$$('#queue .card')).length === 3)
  await page.fill('#variables-fields textarea[data-name="bug"]', 'Crash on empty input')
  await page.click('#variables-dialog button[value="save"]')

  // Schedule
  await page.click('#btn-schedule')
  await page.check('#schedule-form input[name="daily"]')
  await page.click('#schedule-dialog button[value="save"]')
  await page.waitForTimeout(300)
  check('schedule badge shown', await page.isVisible('#schedule-badge'))

  // Tabs
  await page.keyboard.press('Control+Shift+T')
  await page.waitForTimeout(400)
  check('second tab created + active', (await page.$$('.tab')).length === 2 && ((await page.textContent('.tab.active .tab-label')) ?? '') === 'New tab')
  check('new tab has empty queue', (await page.$$('#queue .card')).length === 0)
  await page.keyboard.press('Control+Tab')
  await page.waitForTimeout(200)
  check('ctrl+tab switches back', (await page.$$('#queue .card')).length === 3)

  // Settings
  await page.click('#btn-settings')
  await page.click('#btn-random-topic')
  check('random ntfy topic', /^chain-prompt-[0-9a-f]{24}$/.test(await page.inputValue('input[name="ntfyTopic"]')))
  await page.locator('#settings-dialog').screenshot({ path: join(shots, '6-settings.png') })
  await page.click('#settings-dialog button[value="cancel"]')

  // Shortcuts + history
  await page.keyboard.press('Control+/')
  await page.waitForSelector('#shortcuts-dialog[open]')
  await page.locator('#shortcuts-dialog').screenshot({ path: join(shots, '7-shortcuts.png') })
  await page.click('#shortcuts-dialog button[value="cancel"]')
  await page.click('#btn-history')
  await page.waitForSelector('#history-dialog[open]')
  await page.click('#history-dialog button[value="cancel"]')

  await page.screenshot({ path: join(shots, '8-main.png') })
  await app.close()

  // Relaunch: tabs + schedule + variables persisted
  const app2 = await electron.launch({ executablePath: electronPath as unknown as string, args: ['--no-sandbox', resolve('out/main/index.js')], env: { ...process.env, CHAIN_PROMPT_USER_DATA: userData } as Record<string, string> })
  const p2 = await app2.firstWindow()
  await p2.waitForSelector('.tab')
  await p2.waitForTimeout(500)
  check('tabs persisted', (await p2.$$('.tab')).length === 2)
  await p2.click('.tab:nth-child(1)')
  await p2.waitForTimeout(200)
  check('schedule + variables persisted', (await p2.isVisible('#schedule-badge')) && !(await p2.isVisible('#variables-bar .var-chip.missing')))
  await app2.close()

  check(`no renderer errors ${errors.join(' | ')}`, errors.length === 0)
  const failed = results.filter(([, ok]) => !ok).length
  console.log(failed ? `${failed} FAILED` : 'all passed')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
