// IPC channel names. Kept in one place so main and preload cannot drift apart.

export const IPC = {
  // renderer -> main (invoke)
  getState: 'app:get-state',
  getScrollback: 'pty:get-scrollback',
  queueOp: 'queue:op',
  chainCommand: 'chain:command',
  saveChain: 'chain:save-file',
  loadChain: 'chain:load-file',
  applyTemplate: 'chain:apply-template',
  setVariables: 'chain:set-variables',
  setSchedule: 'chain:set-schedule',
  rollback: 'chain:rollback',
  pickFolder: 'session:pick-folder',
  setFolder: 'session:set-folder',
  startSession: 'session:start',
  updateSettings: 'settings:update',
  testNotification: 'settings:test-notification',
  openLogs: 'logs:open',
  listRuns: 'history:list',
  getRun: 'history:get',
  addWorkspace: 'workspace:add',
  closeWorkspace: 'workspace:close',

  // renderer -> main (send, fire and forget)
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',

  // main -> renderer
  stateChanged: 'app:state-changed',
  ptyData: 'pty:data',
  ptyReset: 'pty:reset',
  toast: 'app:toast'
} as const
