import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_SETTINGS,
  stepConfigOf,
  type AppState,
  type ChainCommand,
  type ChainFile,
  type QueueOp,
  type Schedule,
  type SessionMode,
  type Settings
} from '../shared/types'
import { BUILTIN_TEMPLATES } from '../shared/templates'
import { HookServer } from './core/hookServer'
import { getRun, listRuns, logsDir } from './core/runLog'
import type { Notify } from './core/chainRunner'
import { emptyWorkspace, Store } from './store'
import { sendNotice } from './desktopNotifier'
import { Workspace } from './workspace'
import { HEADLESS_USAGE, parseHeadlessArgs, runHeadless } from './headless'

// Lets the e2e test run against a throwaway profile.
if (process.env.CHAIN_PROMPT_USER_DATA) app.setPath('userData', process.env.CHAIN_PROMPT_USER_DATA)

// `Chain Prompt run <chain.json> ...` runs headless (see headless.ts). The
// "run" word is the first argument that is neither a Chromium switch placed
// before it nor (in dev) the app entry script.
function findCliArgs(): string[] | null {
  const rest = process.argv.slice(1)
  const i = rest.findIndex((a) => !a.startsWith('-') && !(!app.isPackaged && (a.endsWith('.js') || a === '.')))
  return i >= 0 && rest[i] === 'run' ? rest.slice(i + 1) : null
}
const cliArgs = findCliArgs()
const headless = cliArgs !== null

if (!headless && !app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
const store = new Store(join(app.getPath('userData'), 'state.json'))
const hooks = new HookServer()
const workspaces: Workspace[] = []
let blockerId: number | null = null

const notify: Notify = (kind, title, body) => void sendNotice(store.data.settings, kind, title, body)

function appState(): AppState {
  return {
    workspaces: workspaces.map((w) => w.state()),
    settings: store.data.settings,
    recentFolders: store.data.recentFolders
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Coalesce state broadcasts (several workspaces can change in the same tick).
let stateTimer: NodeJS.Timeout | null = null
function broadcast(): void {
  if (stateTimer) return
  stateTimer = setTimeout(() => {
    stateTimer = null
    send(IPC.stateChanged, appState())
  }, 10)
}

function persist(): void {
  store.data.workspaces = workspaces.map((w) => w.toPersisted())
  store.save()
}

/** Keep the machine awake while a chain is in flight or scheduled. */
function updatePowerBlocker(): void {
  const want = workspaces.some((w) => w.chain.isBusy || w.chain.state === 'paused' || w.schedule)
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

// Coalesce pty output into ~60 fps IPC messages, per workspace.
const outBuf = new Map<string, string>()
let outTimer: NodeJS.Timeout | null = null
function queueOutput(ws: string, d: string): void {
  outBuf.set(ws, (outBuf.get(ws) ?? '') + d)
  if (outTimer) return
  outTimer = setTimeout(() => {
    outTimer = null
    for (const [id, chunk] of outBuf) send(IPC.ptyData, id, chunk)
    outBuf.clear()
  }, 16)
}

function addWorkspace(data = emptyWorkspace()): Workspace {
  const w = new Workspace(data, hooks, () => store.data.settings, notify)
  w.on('change', () => {
    updatePowerBlocker()
    broadcast()
  })
  w.on('persist', persist)
  w.on('data', (d: string) => queueOutput(w.id, d))
  w.on('reset', () => {
    outBuf.delete(w.id)
    send(IPC.ptyReset, w.id)
  })
  workspaces.push(w)
  return w
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function ws(id: unknown): Workspace {
  const w = workspaces.find((x) => x.id === id)
  if (!w) throw new Error('This tab no longer exists')
  return w
}

/** ipcMain.handle with workspace lookup and errors turned into messages. */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
    try {
      return await fn(...args)
    } catch (e) {
      return (e as Error).message || String(e)
    }
  })
}

function setFolder(w: Workspace, folder: string): string | null {
  if (!isDir(folder)) return 'Folder not found'
  const err = w.setFolder(folder)
  if (err) return err
  store.addRecentFolder(folder)
  persist()
  broadcast()
  return null
}

function sanitizeSettings(patch: Partial<Settings>): Settings {
  const next = { ...store.data.settings }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (patch[key] !== undefined && typeof patch[key] === typeof DEFAULT_SETTINGS[key]) {
      ;(next as Record<string, unknown>)[key] = patch[key]
    }
  }
  const oneOf = <K extends keyof Settings>(k: K, allowed: Settings[K][]) => {
    if (!allowed.includes(next[k])) next[k] = DEFAULT_SETTINGS[k]
  }
  oneOf('permissionMode', ['default', 'acceptEdits', 'bypassPermissions'])
  oneOf('newSessionMethod', ['clear', 'restart'])
  oneOf('hookTransport', ['curl', 'http'])
  oneOf('gitFinishAction', ['none', 'commit', 'branch', 'branchPush'])
  for (const k of ['stepDelayMs', 'idleTimeoutMin', 'retryMax', 'retryDelaySec', 'commandTimeoutMin'] as const) {
    if (!Number.isFinite(next[k]) || next[k] < 0) next[k] = DEFAULT_SETTINGS[k]
  }
  return next
}

function registerIpc(): void {
  handle(IPC.getState, () => appState())
  handle(IPC.getScrollback, (id) => ws(id).sm.current?.getScrollback() ?? '')
  handle(IPC.queueOp, (id, op: QueueOp) => ws(id).chain.applyQueueOp(op))

  handle(IPC.chainCommand, (id, cmd: ChainCommand) => {
    const c = ws(id).chain
    if (cmd === 'start') c.start()
    else if (cmd === 'pause') c.pause()
    else if (cmd === 'resume') c.resume()
    else if (cmd === 'stop') c.stop()
    else if (cmd === 'skipNext') c.skipNext()
    return null
  })

  handle(IPC.pickFolder, async (id) => {
    const w = ws(id)
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose working folder',
      properties: ['openDirectory'],
      defaultPath: w.sm.cwd ?? store.data.recentFolders[0] ?? undefined
    })
    if (r.canceled || !r.filePaths[0]) return null
    return setFolder(w, r.filePaths[0])
  })

  handle(IPC.setFolder, (id, folder) => (typeof folder === 'string' ? setFolder(ws(id), folder) : 'Invalid folder'))

  handle(IPC.startSession, (id, mode: SessionMode) => ws(id).startSession(mode === 'continue' ? 'continue' : 'new'))

  handle(IPC.updateSettings, (patch: Partial<Settings>) => {
    store.data.settings = sanitizeSettings(patch ?? {})
    store.save()
    for (const w of workspaces) void w.refreshGit()
    broadcast()
    return null
  })

  handle(IPC.testNotification, async () => {
    const errors = await sendNotice(store.data.settings, 'done', 'Chain Prompt: test notification', 'If you can read this, notifications work.')
    return errors.length ? errors.join(' · ') : null
  })

  handle(IPC.saveChain, async (id) => {
    const w = ws(id)
    if (!w.chain.steps.length) return 'The queue is empty'
    const r = await dialog.showSaveDialog(win!, {
      title: 'Save chain',
      defaultPath: `${(w.name || 'my-chain').replace(/[^\w.-]+/g, '-')}.chain.json`,
      filters: [{ name: 'Chain Prompt chain', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    const file: ChainFile = {
      format: 'chain-prompt',
      version: 2,
      name: basename(r.filePath).replace(/(\.chain)?\.json$/i, ''),
      steps: w.chain.steps.map(stepConfigOf)
    }
    if (w.variables.length) {
      file.variables = w.variables.map((v) => ({ name: v.name, description: v.description, default: v.value || undefined }))
    }
    writeFileSync(r.filePath, JSON.stringify(file, null, 2))
    w.name = file.name ?? w.name
    persist()
    broadcast()
    return null
  })

  handle(IPC.loadChain, async (id) => {
    const w = ws(id)
    const r = await dialog.showOpenDialog(win!, {
      title: 'Load chain',
      properties: ['openFile'],
      filters: [{ name: 'Chain Prompt chain', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    try {
      const raw = JSON.parse(readFileSync(r.filePaths[0], 'utf8'))
      // Accept our format, or a bare array of strings / {prompt} objects.
      const file = Array.isArray(raw) ? { steps: raw } : { ...raw, steps: Array.isArray(raw?.steps) ? raw.steps : [] }
      return w.loadChain(file, basename(r.filePaths[0]).replace(/(\.chain)?\.json$/i, ''))
    } catch (e) {
      return `Could not read the file: ${(e as Error).message}`
    }
  })

  handle(IPC.applyTemplate, (id, index: number) => {
    const t = BUILTIN_TEMPLATES[index]
    if (!t) return 'Unknown template'
    return ws(id).loadChain(t, t.name)
  })

  handle(IPC.setVariables, (id, values: Record<string, string>) => {
    if (!values || typeof values !== 'object') return 'Invalid variables'
    ws(id).setVariables(values)
    return null
  })

  handle(IPC.setSchedule, (id, s: Schedule | null) => {
    const err = ws(id).setSchedule(s)
    updatePowerBlocker()
    return err
  })

  handle(IPC.rollback, (id, stepId: string) => ws(id).chain.rollback(stepId))

  handle(IPC.openLogs, async (id) => {
    const w = ws(id)
    if (!w.sm.cwd) return 'Pick a folder first'
    const dir = logsDir(w.sm.cwd)
    mkdirSync(dir, { recursive: true })
    const err = await shell.openPath(dir)
    return err || null
  })

  ipcMain.handle(IPC.listRuns, (_e, id) => {
    const w = workspaces.find((x) => x.id === id)
    return w?.sm.cwd ? listRuns(w.sm.cwd) : []
  })
  ipcMain.handle(IPC.getRun, (_e, id, file) => {
    const w = workspaces.find((x) => x.id === id)
    return w?.sm.cwd && typeof file === 'string' ? getRun(w.sm.cwd, file) : null
  })

  ipcMain.handle(IPC.addWorkspace, () => {
    const w = addWorkspace()
    persist()
    broadcast()
    return w.id
  })

  handle(IPC.closeWorkspace, async (id) => {
    const w = ws(id)
    if (w.chain.isBusy) return 'Stop the chain in this tab before closing it'
    workspaces.splice(workspaces.indexOf(w), 1)
    await w.shutdown()
    if (!workspaces.length) addWorkspace()
    persist()
    updatePowerBlocker()
    broadcast()
    return null
  })

  ipcMain.on(IPC.ptyWrite, (_e, id: unknown, data: unknown) => {
    if (typeof data === 'string') workspaces.find((x) => x.id === id)?.sm.write(data)
  })
  ipcMain.on(IPC.ptyResize, (_e, cols: unknown, rows: unknown) => {
    if (typeof cols !== 'number' || typeof rows !== 'number') return
    for (const w of workspaces) w.sm.setSize(Math.floor(cols), Math.floor(rows))
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

async function startHeadless(): Promise<void> {
  app.dock?.hide()
  const o = parseHeadlessArgs(cliArgs ?? [], store.data.settings)
  if (o === 'help' || typeof o === 'string') {
    if (o !== 'help') console.error(`error: ${o}\n`)
    console.log(HEADLESS_USAGE)
    return app.exit(o === 'help' ? 0 : 2)
  }
  // Desktop notifications stay off; remote channels from the saved settings work.
  const code = await runHeadless(o, (kind, title, body) => void sendNotice(o.settings, kind, title, body))
  app.exit(code)
}

if (headless) {
  app.whenReady().then(startHeadless)
} else {
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
    await hooks.start()
    for (const data of store.data.workspaces) addWorkspace(data)
    registerIpc()
    createWindow()
    updatePowerBlocker()
    const scheduler = setInterval(() => {
      const now = Date.now()
      for (const w of workspaces) w.tickSchedule(now, notify)
    }, 15_000)
    scheduler.unref?.()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    store.data.workspaces = workspaces.map((w) => w.toPersisted())
    store.flush()
    void Promise.all(workspaces.map((w) => w.shutdown()))
      .then(() => hooks.stop())
      .finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
