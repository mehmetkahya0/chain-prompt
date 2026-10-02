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
  getScrollback: (ws) => ipcRenderer.invoke(IPC.getScrollback, ws),
  queueOp: (ws, op) => ipcRenderer.invoke(IPC.queueOp, ws, op),
  chain: (ws, cmd) => ipcRenderer.invoke(IPC.chainCommand, ws, cmd),
  saveChain: (ws) => ipcRenderer.invoke(IPC.saveChain, ws),
  loadChain: (ws) => ipcRenderer.invoke(IPC.loadChain, ws),
  applyTemplate: (ws, index) => ipcRenderer.invoke(IPC.applyTemplate, ws, index),
  setVariables: (ws, values) => ipcRenderer.invoke(IPC.setVariables, ws, values),
  setSchedule: (ws, schedule) => ipcRenderer.invoke(IPC.setSchedule, ws, schedule),
  rollback: (ws, stepId) => ipcRenderer.invoke(IPC.rollback, ws, stepId),
  pickFolder: (ws) => ipcRenderer.invoke(IPC.pickFolder, ws),
  setFolder: (ws, folder) => ipcRenderer.invoke(IPC.setFolder, ws, folder),
  startSession: (ws, mode) => ipcRenderer.invoke(IPC.startSession, ws, mode),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  testNotification: () => ipcRenderer.invoke(IPC.testNotification),
  openLogs: (ws) => ipcRenderer.invoke(IPC.openLogs, ws),
  listRuns: (ws) => ipcRenderer.invoke(IPC.listRuns, ws),
  getRun: (ws, file) => ipcRenderer.invoke(IPC.getRun, ws, file),
  addWorkspace: () => ipcRenderer.invoke(IPC.addWorkspace),
  closeWorkspace: (ws) => ipcRenderer.invoke(IPC.closeWorkspace, ws),
  ptyWrite: (ws, data) => ipcRenderer.send(IPC.ptyWrite, ws, data),
  ptyResize: (cols, rows) => ipcRenderer.send(IPC.ptyResize, cols, rows),
  onState: (cb) => listen(IPC.stateChanged, cb),
  onPtyData: (cb) => listen(IPC.ptyData, cb),
  onPtyReset: (cb) => listen(IPC.ptyReset, cb)
}

contextBridge.exposeInMainWorld('api', api)
