import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_SETTINGS,
  type AppState,
  type ChainCommand,
  type ChainFile,
  type QueueOp,
  type SessionMode,
  type Settings
} from '../shared/types'
import { SessionManager } from './core/sessionManager'
import { ChainRunner } from './core/chainRunner'
import { logsDir } from './core/runLog'
import { Store } from './store'
import { sendNotice } from './notifier'

// Lets the e2e test run against a throwaway profile.
if (process.env.CHAIN_PROMPT_USER_DATA) app.setPath('userData', process.env.CHAIN_PROMPT_USER_DATA)

if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
const store = new Store(join(app.getPath('userData'), 'state.json'))
const sm = new SessionManager(() => store.data.settings)
const chain = new ChainRunner(sm, () => store.data.settings, (kind, title, body) => {
  void sendNotice(store.data.settings, kind, title, body)
})
let blockerId: number | null = null

function appState(): AppState {
  return {
    chain: chain.snapshot(),
    session: sm.info(),
    settings: store.data.settings,
    recentFolders: store.data.recentFolders
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const broadcast = () => send(IPC.stateChanged, appState())

/** Keep the machine awake while a chain is in flight. */
function updatePowerBlocker(): void {
  const want = chain.isBusy || chain.state === 'paused'
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

// Coalesce pty output into ~60 fps IPC messages.
let outBuf = ''
let outTimer: NodeJS.Timeout | null = null
function queueOutput(d: string): void {
  outBuf += d
  if (outTimer) return
  outTimer = setTimeout(() => {
    outTimer = null
    const chunk = outBuf
    outBuf = ''
    send(IPC.ptyData, chunk)
  }, 16)
}

function wireCore(): void {
  chain.restore(store.data.steps)
  sm.cwd = store.data.cwd && existsSync(store.data.cwd) ? store.data.cwd : null
  sm.mode = store.data.mode

  chain.on('change', () => {
    store.data.steps = chain.steps
    store.save()
    updatePowerBlocker()
    broadcast()
  })
  sm.on('change', broadcast)
  sm.on('data', queueOutput)
  sm.on('reset', () => {
    outBuf = ''
    send(IPC.ptyReset)
  })
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function setFolder(folder: string): string | null {
  if (!isDir(folder)) return 'Folder not found'
  if (chain.isBusy) return 'Cannot change the folder while the chain is running'
  store.addRecentFolder(folder)
  store.data.cwd = folder
  store.save()
  sm.start(folder, 'new')
  return null
}

function registerIpc(): void {
  ipcMain.handle(IPC.getState, () => ({ ...appState(), scrollback: sm.current?.getScrollback() ?? '' }))

  ipcMain.handle(IPC.queueOp, (_e, op: QueueOp) => chain.applyQueueOp(op))

  ipcMain.handle(IPC.chainCommand, (_e, cmd: ChainCommand) => {
    if (cmd === 'start') chain.start()
    else if (cmd === 'pause') chain.pause()
    else if (cmd === 'resume') chain.resume()
    else if (cmd === 'stop') chain.stop()
    else if (cmd === 'skipNext') chain.skipNext()
    return null
  })

  ipcMain.handle(IPC.pickFolder, async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose working folder',
      properties: ['openDirectory'],
      defaultPath: store.data.cwd ?? undefined
    })
    if (r.canceled || !r.filePaths[0]) return null
    return setFolder(r.filePaths[0])
  })

  ipcMain.handle(IPC.setFolder, (_e, folder: string) => (typeof folder === 'string' ? setFolder(folder) : 'Invalid folder'))

  ipcMain.handle(IPC.startSession, (_e, mode: SessionMode) => {
    if (!sm.cwd) return 'Pick a folder first'
    if (chain.isBusy) return 'Cannot restart the session while the chain is running'
    const m: SessionMode = mode === 'continue' ? 'continue' : 'new'
    store.data.mode = m
    store.save()
    sm.start(sm.cwd, m)
    return null
  })

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<Settings>) => {
    const next = { ...store.data.settings }
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (patch[key] !== undefined && typeof patch[key] === typeof DEFAULT_SETTINGS[key]) {
        ;(next as Record<string, unknown>)[key] = patch[key]
      }
    }
    store.data.settings = next
    store.save()
    broadcast()
    return null
  })

  ipcMain.handle(IPC.saveChain, async () => {
    if (!chain.steps.length) return 'The queue is empty'
    const r = await dialog.showSaveDialog(win!, {
      title: 'Save chain',
      defaultPath: 'my-chain.chain.json',
      filters: [{ name: 'Chain Prompt chain', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    const file: ChainFile = {
      format: 'chain-prompt',
      version: 1,
      name: basename(r.filePath).replace(/(\.chain)?\.json$/i, ''),
      steps: chain.steps.map((s) => ({ prompt: s.prompt, newSession: s.newSession }))
    }
    writeFileSync(r.filePath, JSON.stringify(file, null, 2))
    return null
  })

  ipcMain.handle(IPC.loadChain, async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Load chain',
      properties: ['openFile'],
      filters: [{ name: 'Chain Prompt chain', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const raw = JSON.parse(readFileSync(r.filePaths[0], 'utf8'))
      // Accept our format, or a bare array of strings / {prompt} objects.
      const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.steps) ? raw.steps : []
      const steps = list
        .map((s) => (typeof s === 'string' ? { prompt: s } : (s as { prompt?: unknown; newSession?: unknown })))
        .filter((s): s is { prompt: string; newSession?: boolean } => !!s && typeof s.prompt === 'string')
      if (!steps.length) return 'No steps found in the file'
      return chain.replaceSteps(steps)
    } catch (e) {
      return `Could not read the file: ${(e as Error).message}`
    }
  })

  ipcMain.handle(IPC.openLogs, async () => {
    if (!sm.cwd) return 'Pick a folder first'
    const dir = logsDir(sm.cwd)
    mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return err || null
  })

  ipcMain.on(IPC.ptyWrite, (_e, data: unknown) => {
    if (typeof data === 'string') sm.write(data)
  })
  ipcMain.on(IPC.ptyResize, (_e, cols: unknown, rows: unknown) => {
    if (typeof cols === 'number' && typeof rows === 'number') sm.setSize(Math.floor(cols), Math.floor(rows))
  })
}

const appIcon = join(app.getAppPath(), 'build', 'icon.png')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Chain Prompt',
    // Taskbar/window icon in dev and on Linux; packaged builds also embed it.
    icon: existsSync(appIcon) ? appIcon : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // No navigation or popups: external links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  app.setAppUserModelId('com.chainprompt.app')
  // Packaged macOS builds use the .icns from the bundle; in dev the Dock would show Electron's icon.
  if (process.platform === 'darwin' && !app.isPackaged && existsSync(appIcon)) app.dock?.setIcon(appIcon)
  await sm.init()
  wireCore()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  e.preventDefault()
  store.data.steps = chain.steps
  store.flush()
  chain.dispose()
  void sm.shutdown().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
