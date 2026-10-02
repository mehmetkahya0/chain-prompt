import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, type ChainVariable, type Schedule, type SessionMode, type Settings, type Step } from '../shared/types'

export interface PersistedWorkspace {
  id: string
  /** Chain name (from a loaded file / template); used in logs and the tab label. */
  name: string
  cwd: string | null
  mode: SessionMode
  steps: Step[]
  variables: ChainVariable[]
  schedule: Schedule | null
}

export interface PersistedState {
  settings: Settings
  recentFolders: string[]
  workspaces: PersistedWorkspace[]
}

const MAX_RECENT = 10

export function emptyWorkspace(cwd: string | null = null): PersistedWorkspace {
  return { id: randomUUID(), name: '', cwd, mode: 'new', steps: [], variables: [], schedule: null }
}

function readSteps(raw: unknown): Step[] {
  return Array.isArray(raw) ? raw.filter((s) => s && typeof s.prompt === 'string' && typeof s.id === 'string') : []
}

function readWorkspace(raw: Record<string, unknown>): PersistedWorkspace {
  const sched = raw.schedule as Schedule | null | undefined
  return {
    id: typeof raw.id === 'string' ? raw.id : randomUUID(),
    name: typeof raw.name === 'string' ? raw.name : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    mode: raw.mode === 'continue' ? 'continue' : 'new',
    steps: readSteps(raw.steps),
    variables: Array.isArray(raw.variables)
      ? (raw.variables as ChainVariable[])
          .filter((v) => v && typeof v.name === 'string')
          .map((v) => ({ name: v.name, value: typeof v.value === 'string' ? v.value : '', description: v.description }))
      : [],
    schedule: sched && typeof sched.at === 'number' ? { at: sched.at, daily: !!sched.daily } : null
  }
}

/** Tiny JSON file store in Electron's userData dir; writes are debounced and atomic. */
export class Store {
  data: PersistedState
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly file: string) {
    this.data = this.load()
  }

  private load(): PersistedState {
    const empty: PersistedState = { settings: { ...DEFAULT_SETTINGS }, recentFolders: [], workspaces: [emptyWorkspace()] }
    try {
      if (!existsSync(this.file)) return empty
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      // Before tabs existed the state held a single cwd/mode/steps.
      const list = Array.isArray(raw.workspaces)
        ? (raw.workspaces as Record<string, unknown>[]).filter((w) => w && typeof w === 'object').map(readWorkspace)
        : [readWorkspace(raw)]
      return {
        settings: { ...DEFAULT_SETTINGS, ...((raw.settings as Partial<Settings>) ?? {}) },
        recentFolders: Array.isArray(raw.recentFolders) ? raw.recentFolders.filter((f): f is string => typeof f === 'string') : [],
        workspaces: list.length ? list : [emptyWorkspace()]
      }
    } catch {
      return empty
    }
  }

  addRecentFolder(folder: string): void {
    this.data.recentFolders = [folder, ...this.data.recentFolders.filter((f) => f !== folder)].slice(0, MAX_RECENT)
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (e) {
      console.error('state save failed', e)
    }
  }
}
