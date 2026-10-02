import type { AppState, ChainCommand, QueueOp, RunDetail, RunSummary, Schedule, SessionMode, Settings } from './types'

/**
 * The API exposed to the renderer as `window.api`. Invoke calls resolve to an
 * error message or null. `ws` is the id of the tab (workspace) to act on.
 */
export interface ChainPromptApi {
  getState(): Promise<AppState>
  getScrollback(ws: string): Promise<string>
  queueOp(ws: string, op: QueueOp): Promise<string | null>
  chain(ws: string, cmd: ChainCommand): Promise<string | null>
  saveChain(ws: string): Promise<string | null>
  loadChain(ws: string): Promise<string | null>
  applyTemplate(ws: string, index: number): Promise<string | null>
  setVariables(ws: string, values: Record<string, string>): Promise<string | null>
  setSchedule(ws: string, schedule: Schedule | null): Promise<string | null>
  rollback(ws: string, stepId: string): Promise<string | null>
  pickFolder(ws: string): Promise<string | null>
  setFolder(ws: string, folder: string): Promise<string | null>
  startSession(ws: string, mode: SessionMode): Promise<string | null>
  updateSettings(patch: Partial<Settings>): Promise<string | null>
  testNotification(): Promise<string | null>
  openLogs(ws: string): Promise<string | null>
  listRuns(ws: string): Promise<RunSummary[]>
  getRun(ws: string, file: string): Promise<RunDetail | null>
  /** Resolves to the new tab's id. */
  addWorkspace(): Promise<string>
  closeWorkspace(ws: string): Promise<string | null>
  ptyWrite(ws: string, data: string): void
  ptyResize(cols: number, rows: number): void
  onState(cb: (s: AppState) => void): () => void
  onPtyData(cb: (ws: string, d: string) => void): () => void
  onPtyReset(cb: (ws: string) => void): () => void
}
