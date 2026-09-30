import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Step } from '../../shared/types'

export const logsDir = (cwd: string) => join(cwd, '.chain-prompt', 'logs')

const stamp = (t: number) => new Date(t).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`
}

/**
 * One chain run = one `<ts>.log` (human readable event log) and one
 * `<ts>.json` (step timings) in `<cwd>/.chain-prompt/logs/`.
 * Logging must never break the chain, so every write is best effort.
 */
export class RunLog {
  readonly logFile: string
  readonly jsonFile: string
  private readonly startedAt = Date.now()

  constructor(readonly cwd: string) {
    const dir = logsDir(cwd)
    const base = stamp(this.startedAt)
    this.logFile = join(dir, `${base}.log`)
    this.jsonFile = join(dir, `${base}.json`)
    try {
      mkdirSync(dir, { recursive: true })
      // Keep run logs out of the user's git history.
      const ignore = join(cwd, '.chain-prompt', '.gitignore')
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    } catch {
      /* read-only folder etc. */
    }
    this.line(`Chain started — folder: ${cwd}`)
  }

  line(text: string): void {
    const ts = new Date().toISOString()
    try {
      appendFileSync(this.logFile, `[${ts}] ${text}\n`)
    } catch {
      /* ignore */
    }
  }

  block(title: string, body: string): void {
    const indented = body.replace(/\r\n/g, '\n').split('\n').map((l) => `    ${l}`).join('\n')
    this.line(`${title}\n${indented}`)
  }

  writeSummary(steps: Step[]): void {
    const data = {
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: this.cwd,
      steps: steps.map((s, i) => ({
        index: i + 1,
        status: s.status,
        prompt: s.prompt,
        newSession: s.newSession,
        startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
        endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
        durationMs: s.startedAt && s.endedAt ? s.endedAt - s.startedAt : null,
        note: s.note ?? null
      }))
    }
    try {
      writeFileSync(this.jsonFile, JSON.stringify(data, null, 2))
    } catch {
      /* ignore */
    }
  }
}
