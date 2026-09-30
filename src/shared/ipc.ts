// IPC channel names. Kept in one place so main and preload cannot drift apart.

export const IPC = {
  // renderer -> main (invoke)
  getState: 'app:get-state',
  queueOp: 'queue:op',
  chainCommand: 'chain:command',
  saveChain: 'chain:save-file',
  loadChain: 'chain:load-file',
  pickFolder: 'session:pick-folder',
  setFolder: 'session:set-folder',
  startSession: 'session:start',
  updateSettings: 'settings:update',
  openLogs: 'logs:open',

  // renderer -> main (send, fire and forget)
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',

  // main -> renderer
  stateChanged: 'app:state-changed',
  ptyData: 'pty:data',
  ptyReset: 'pty:reset',
  toast: 'app:toast'
} as const
