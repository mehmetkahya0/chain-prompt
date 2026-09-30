import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type { ChainPromptApi } from '../shared/api'

// Subscribe helper that hides the IpcRendererEvent from the renderer.
function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: ChainPromptApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  queueOp: (op) => ipcRenderer.invoke(IPC.queueOp, op),
  chain: (cmd) => ipcRenderer.invoke(IPC.chainCommand, cmd),
  saveChain: () => ipcRenderer.invoke(IPC.saveChain),
  loadChain: () => ipcRenderer.invoke(IPC.loadChain),
  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  setFolder: (folder) => ipcRenderer.invoke(IPC.setFolder, folder),
  startSession: (mode) => ipcRenderer.invoke(IPC.startSession, mode),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  openLogs: () => ipcRenderer.invoke(IPC.openLogs),
  ptyWrite: (data) => ipcRenderer.send(IPC.ptyWrite, data),
  ptyResize: (cols, rows) => ipcRenderer.send(IPC.ptyResize, cols, rows),
  onState: (cb) => listen(IPC.stateChanged, cb),
  onPtyData: (cb) => listen(IPC.ptyData, cb),
  onPtyReset: (cb) => listen(IPC.ptyReset, cb)
}

contextBridge.exposeInMainWorld('api', api)
