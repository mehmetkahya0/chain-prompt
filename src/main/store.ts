import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, type SessionMode, type Settings, type Step } from '../shared/types'

export interface PersistedState {
  settings: Settings
  recentFolders: string[]
  cwd: string | null
  mode: SessionMode
  steps: Step[]
}

const MAX_RECENT = 10

/** Tiny JSON file store in Electron's userData dir; writes are debounced and atomic. */
export class Store {
  data: PersistedState
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly file: string) {
    this.data = this.load()
  }

  private load(): PersistedState {
    const empty: PersistedState = { settings: { ...DEFAULT_SETTINGS }, recentFolders: [], cwd: null, mode: 'new', steps: [] }
    try {
      if (!existsSync(this.file)) return empty
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>
      return {
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        recentFolders: Array.isArray(raw.recentFolders) ? raw.recentFolders.filter((f) => typeof f === 'string') : [],
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        mode: raw.mode === 'continue' ? 'continue' : 'new',
        steps: Array.isArray(raw.steps) ? raw.steps.filter((s) => s && typeof s.prompt === 'string' && typeof s.id === 'string') : []
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
