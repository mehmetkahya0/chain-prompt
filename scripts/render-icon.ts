/**
 * Renders docs/logo.svg to build/icon.png (512x512, transparent), which
 * electron-builder turns into the Windows/macOS/Linux app icons.
 *
 *   npm run icon
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const svg = readFileSync(resolve('docs/logo.svg'), 'utf8')
const out = resolve('build/icon.png')
mkdirSync(resolve('build'), { recursive: true })

const dir = mkdtempSync(join(tmpdir(), 'chain-icon-'))
writeFileSync(
  join(dir, 'index.html'),
  `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
)
// A throwaway Electron main: offscreen rendering hands us each painted
// frame; the first full frame after load is the icon.
writeFileSync(
  join(dir, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 512, height: 512, useContentSize: true, show: false, frame: false,
    transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true } })
  let loaded = false
  w.webContents.on('did-finish-load', () => setTimeout(() => (loaded = true), 300))
  w.webContents.on('paint', (_e, _dirty, img) => {
    if (!loaded) return
    const size = img.getSize()
    if (size.width < 512) return
    writeFileSync(${JSON.stringify(out)}, img.resize({ width: 512, height: 512 }).toPNG())
    app.exit(0)
  })
  w.webContents.setFrameRate(30)
  w.loadFile(${JSON.stringify(join(dir, 'index.html'))})
  setTimeout(() => { w.webContents.invalidate() }, 600)
  setTimeout(() => { console.error('timed out'); app.exit(1) }, 20000)
})`
)

execFileSync(electronPath as unknown as string, [join(dir, 'main.cjs')], { stdio: 'inherit', timeout: 60_000 })
console.log(`wrote ${out}`)
