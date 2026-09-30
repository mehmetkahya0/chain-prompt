// Types shared by the main process, preload and renderer.

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting' // blocked on the user (permission prompt etc.)
  | 'done'
  | 'error'
  | 'skipped'
  | 'interrupted' // stopped mid-flight (user stop or app closed)

export interface Step {
  id: string
  prompt: string
  /** Reset the context before this step (via /clear or a claude restart). */
  newSession: boolean
  status: StepStatus
  startedAt?: number
  endedAt?: number
  /** Human readable reason for error / interrupted states. */
  note?: string
}

export type ChainState =
  | 'idle' // never started / stopped
  | 'starting' // waiting for claude to be ready
  | 'running'
  | 'waiting_user' // permission prompt / notification
  | 'pausing' // will pause when the current step ends
  | 'paused'
  | 'completed'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export type NewSessionMethod = 'clear' | 'restart'

export type HookTransport = 'http' | 'curl'

export interface Settings {
  permissionMode: PermissionMode
  /** Command used to start Claude Code. */
  claudeCommand: string
  /** Extra CLI arguments appended when starting claude (space separated). */
  extraArgs: string
  /** Pause between a Stop hook and sending the next prompt. */
  stepDelayMs: number
  /** Warn + pause if a running step produces no terminal output for this long. 0 = off. */
  idleTimeoutMin: number
  newSessionMethod: NewSessionMethod
  hookTransport: HookTransport
  desktopNotifications: boolean
  ntfyEnabled: boolean
  ntfyServer: string
  ntfyTopic: string
}

export const DEFAULT_SETTINGS: Settings = {
  permissionMode: 'default',
  claudeCommand: 'claude',
  extraArgs: '',
  stepDelayMs: 2000,
  idleTimeoutMin: 10,
  newSessionMethod: 'clear',
  hookTransport: 'curl',
  desktopNotifications: true,
  ntfyEnabled: false,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: ''
}

export type SessionMode = 'new' | 'continue'

export interface SessionInfo {
  cwd: string | null
  /** true while the pty process is alive */
  alive: boolean
  /** true once claude reported SessionStart for the current launch */
  claudeReady: boolean
  mode: SessionMode
}

export interface ChainSnapshot {
  state: ChainState
  steps: Step[]
  currentStepId: string | null
  /** Short status line shown above the queue. */
  message: string
}

export interface AppState {
  chain: ChainSnapshot
  session: SessionInfo
  settings: Settings
  recentFolders: string[]
}

/** File format for saved chains (templates). */
export interface ChainFile {
  format: 'chain-prompt'
  version: 1
  name?: string
  steps: { prompt: string; newSession?: boolean }[]
}

export type QueueOp =
  | { type: 'add'; prompt: string; newSession?: boolean }
  | { type: 'update'; id: string; prompt?: string; newSession?: boolean }
  | { type: 'remove'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'move'; id: string; toIndex: number }
  | { type: 'reset'; id: string }
  | { type: 'resetAll' }
  | { type: 'clearAll' }

export type ChainCommand = 'start' | 'pause' | 'resume' | 'stop' | 'skipNext'
