import type { AppState, ChainCommand, QueueOp, SessionMode, Settings } from './types'

/** The API exposed to the renderer as `window.api`. Invoke calls resolve to an error message or null. */
export interface ChainPromptApi {
  getState(): Promise<AppState & { scrollback: string }>
  queueOp(op: QueueOp): Promise<string | null>
  chain(cmd: ChainCommand): Promise<string | null>
  saveChain(): Promise<string | null>
  loadChain(): Promise<string | null>
  pickFolder(): Promise<string | null>
  setFolder(folder: string): Promise<string | null>
  startSession(mode: SessionMode): Promise<string | null>
  updateSettings(patch: Partial<Settings>): Promise<string | null>
  openLogs(): Promise<string | null>
  ptyWrite(data: string): void
  ptyResize(cols: number, rows: number): void
  onState(cb: (s: AppState) => void): () => void
  onPtyData(cb: (d: string) => void): () => void
  onPtyReset(cb: () => void): () => void
}
