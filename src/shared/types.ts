// Types shared by the main process, preload and renderer.

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting' // blocked on the user (permission prompt, question etc.)
  | 'done'
  | 'error'
  | 'skipped'
  | 'interrupted' // stopped mid-flight (user stop or app closed)

export type OnError = 'pause' | 'skip' | 'retry'

/** Everything about a step the user configures (as opposed to run-time state). */
export interface StepConfig {
  prompt: string
  /** Reset the context before this step (via /clear or a claude restart). */
  newSession: boolean
  /** Run this step with a different model (claude is restarted with --continue when it changes). */
  model?: string
  /** Run this step with a different permission mode (restart with --continue when it changes). */
  permissionMode?: PermissionMode
  /** Per-step stall warning in minutes; overrides the global setting. 0 = off. */
  idleTimeoutMin?: number
  /** What to do when the step fails. Default: pause the chain. */
  onError?: OnError
  /** Shell command run before the step; a non-zero exit skips the step. */
  when?: string
  /** Shell command run after the step; a non-zero exit means the step did not succeed. */
  verify?: string
  /** Prompt sent when `verify` fails (defaults to the step prompt). {{verify.output}} holds the command output. */
  fixPrompt?: string
  /** How many times to send the fix prompt and re-verify before giving up. */
  maxLoops?: number
}

export interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  /** Estimated USD cost from public API prices; null when the model is unknown. */
  costUsd: number | null
  models: string[]
}

export interface Step extends StepConfig {
  id: string
  status: StepStatus
  startedAt?: number
  endedAt?: number
  /** Human readable reason for error / interrupted / skipped states. */
  note?: string
  /** claude's last message for this step (from the Stop hook). */
  output?: string
  /** Retries used after failures in the current run. */
  attempts?: number
  /** Fix loops used after failed verifications in the current run. */
  loops?: number
  /** Short output of the last verification command. */
  verifyOutput?: string
  usage?: StepUsage
  /** Git snapshot commit taken just before the step ran. */
  checkpoint?: string
  /** `git diff --stat` summary line of the step's changes. */
  diffStat?: string
}

export const STEP_CONFIG_KEYS = [
  'prompt',
  'newSession',
  'model',
  'permissionMode',
  'idleTimeoutMin',
  'onError',
  'when',
  'verify',
  'fixPrompt',
  'maxLoops'
] as const satisfies readonly (keyof StepConfig)[]

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions']
const ON_ERROR: OnError[] = ['pause', 'skip', 'retry']

/**
 * Validate a step config coming from a file, the renderer or a template.
 * Unknown / malformed fields are dropped. Returns null if there is no prompt.
 */
export function sanitizeStepConfig(raw: unknown): StepConfig | null {
  if (typeof raw === 'string') raw = { prompt: raw }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) return null
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const num = (v: unknown, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : undefined
  const out: StepConfig = { prompt: r.prompt.trim(), newSession: r.newSession === true }
  const model = str(r.model)
  if (model) out.model = model
  if (PERMISSION_MODES.includes(r.permissionMode as PermissionMode)) out.permissionMode = r.permissionMode as PermissionMode
  const idle = num(r.idleTimeoutMin, 1440)
  if (idle !== undefined) out.idleTimeoutMin = idle
  if (ON_ERROR.includes(r.onError as OnError)) out.onError = r.onError as OnError
  const when = str(r.when)
  if (when) out.when = when
  const verify = str(r.verify)
  if (verify) out.verify = verify
  const fix = str(r.fixPrompt)
  if (fix) out.fixPrompt = fix
  const loops = num(r.maxLoops, 50)
  if (loops !== undefined) out.maxLoops = Math.floor(loops)
  return out
}

/** Only the configured fields of a step, e.g. for saving a chain file. */
export function stepConfigOf(step: StepConfig): StepConfig {
  const out: Record<string, unknown> = {}
  for (const k of STEP_CONFIG_KEYS) if (step[k] !== undefined) out[k] = step[k]
  return out as unknown as StepConfig
}

export type ChainState =
  | 'idle' // never started / stopped
  | 'starting' // waiting for claude to be ready
  | 'running'
  | 'waiting_user' // permission prompt / notification / question
  | 'pausing' // will pause when the current step ends
  | 'paused'
  | 'completed'

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions'

export type NewSessionMethod = 'clear' | 'restart'

export type HookTransport = 'http' | 'curl'

export type GitFinishAction = 'none' | 'commit' | 'branch' | 'branchPush'

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
  /** Treat a turn that ends with a question as "needs you" instead of moving on. */
  detectQuestions: boolean
  /** Automatic retries after an API error (StopFailure). */
  retryMax: number
  retryDelaySec: number
  /** Timeout for `when` / `verify` shell commands. */
  commandTimeoutMin: number
  /** Snapshot the working tree before each step (git repos only), for roll back and diff stats. */
  gitCheckpoints: boolean
  /** What to do with the changes when a chain completes. */
  gitFinishAction: GitFinishAction
  gitBranchPrefix: string
  desktopNotifications: boolean
  ntfyEnabled: boolean
  ntfyServer: string
  ntfyTopic: string
  /** Optional access token for protected ntfy topics. */
  ntfyToken: string
  slackWebhookUrl: string
  discordWebhookUrl: string
  telegramBotToken: string
  telegramChatId: string
}

export const DEFAULT_SETTINGS: Settings = {
  permissionMode: 'default',
  claudeCommand: 'claude',
  extraArgs: '',
  stepDelayMs: 2000,
  idleTimeoutMin: 10,
  newSessionMethod: 'clear',
  hookTransport: 'curl',
  detectQuestions: true,
  retryMax: 2,
  retryDelaySec: 30,
  commandTimeoutMin: 15,
  gitCheckpoints: true,
  gitFinishAction: 'none',
  gitBranchPrefix: 'chain-prompt/',
  desktopNotifications: true,
  ntfyEnabled: false,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  ntfyToken: '',
  slackWebhookUrl: '',
  discordWebhookUrl: '',
  telegramBotToken: '',
  telegramChatId: ''
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

/** A chain variable, used in prompts as {{name}}. */
export interface ChainVariable {
  name: string
  value: string
  description?: string
}

export interface Schedule {
  /** Epoch ms of the next start. */
  at: number
  /** Repeat every 24 hours. */
  daily: boolean
}

/** One tab: a folder, its claude session and its chain. */
export interface WorkspaceState {
  id: string
  name: string
  chain: ChainSnapshot
  session: SessionInfo
  variables: ChainVariable[]
  schedule: Schedule | null
  isGitRepo: boolean
}

export interface AppState {
  workspaces: WorkspaceState[]
  settings: Settings
  recentFolders: string[]
}

/** File format for saved chains (templates). Version 1 files (prompt + newSession) still load. */
export interface ChainFile {
  format: 'chain-prompt'
  version: 1 | 2
  name?: string
  description?: string
  variables?: { name: string; description?: string; default?: string }[]
  steps: (Partial<StepConfig> & { prompt: string })[]
}

export type BulkAction = 'remove' | 'reset' | 'skip' | 'duplicate' | 'newSessionOn' | 'newSessionOff'

export type QueueOp =
  | ({ type: 'add' } & Partial<StepConfig> & { prompt: string })
  | ({ type: 'update'; id: string } & Partial<StepConfig>)
  | { type: 'remove'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'move'; id: string; toIndex: number }
  | { type: 'reset'; id: string }
  | { type: 'resetAll' }
  | { type: 'clearAll' }
  | { type: 'bulk'; ids: string[]; action: BulkAction }

export type ChainCommand = 'start' | 'pause' | 'resume' | 'stop' | 'skipNext'

/** One entry of the run history (from `<folder>/.chain-prompt/logs/*.json`). */
export interface RunSummary {
  file: string
  name: string
  startedAt: string
  updatedAt: string
  stepCount: number
  done: number
  failed: number
  durationMs: number
  costUsd: number | null
}

export interface RunStepRecord {
  index: number
  status: StepStatus
  prompt: string
  durationMs: number | null
  note: string | null
  output: string | null
  costUsd: number | null
  outputTokens: number | null
  diffStat: string | null
}

export interface RunDetail extends RunSummary {
  steps: RunStepRecord[]
}
