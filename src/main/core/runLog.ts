import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RunDetail, RunStepRecord, RunSummary, Step } from '../../shared/types'

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
 * `<ts>.json` (step timings, outputs, cost) in `<cwd>/.chain-prompt/logs/`.
 * Logging must never break the chain, so every write is best effort.
 */
export class RunLog {
  readonly logFile: string
  readonly jsonFile: string
  private readonly startedAt = Date.now()

  constructor(
    readonly cwd: string,
    readonly name = ''
  ) {
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
    this.line(`Chain started — folder: ${cwd}${name ? ` — chain: ${name}` : ''}`)
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
      name: this.name,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: this.cwd,
      steps: steps.map((s, i) => ({
        index: i + 1,
        status: s.status,
        prompt: s.prompt,
        newSession: s.newSession,
        model: s.model ?? null,
        startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
        endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
        durationMs: s.startedAt && s.endedAt ? s.endedAt - s.startedAt : null,
        note: s.note ?? null,
        output: s.output ?? null,
        loops: s.loops ?? 0,
        attempts: s.attempts ?? 0,
        usage: s.usage ?? null,
        diffStat: s.diffStat ?? null
      }))
    }
    try {
      writeFileSync(this.jsonFile, JSON.stringify(data, null, 2))
    } catch {
      /* ignore */
    }
  }
}

interface RawRun {
  name?: string
  startedAt?: string
  updatedAt?: string
  steps?: {
    index?: number
    status?: string
    prompt?: string
    durationMs?: number | null
    note?: string | null
    output?: string | null
    usage?: { costUsd?: number | null; outputTokens?: number } | null
    diffStat?: string | null
  }[]
}

function readRun(file: string): RunDetail | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RawRun
    const steps: RunStepRecord[] = (raw.steps ?? []).map((s, i) => ({
      index: s.index ?? i + 1,
      status: (s.status ?? 'pending') as RunStepRecord['status'],
      prompt: s.prompt ?? '',
      durationMs: s.durationMs ?? null,
      note: s.note ?? null,
      output: s.output ?? null,
      costUsd: s.usage ? (s.usage.costUsd ?? null) : null,
      outputTokens: s.usage?.outputTokens ?? null,
      diffStat: s.diffStat ?? null
    }))
    const withCost = (raw.steps ?? []).filter((s) => s.usage)
    const costUsd = withCost.length && withCost.every((s) => typeof s.usage?.costUsd === 'number')
      ? withCost.reduce((a, s) => a + (s.usage!.costUsd as number), 0)
      : null
    return {
      file: basename(file),
      name: raw.name ?? '',
      startedAt: raw.startedAt ?? '',
      updatedAt: raw.updatedAt ?? '',
      stepCount: steps.length,
      done: steps.filter((s) => s.status === 'done').length,
      failed: steps.filter((s) => s.status === 'error').length,
      durationMs: steps.reduce((a, s) => a + (s.durationMs ?? 0), 0),
      costUsd,
      steps
    }
  } catch {
    return null
  }
}

/** Past runs in a folder, newest first. */
export function listRuns(cwd: string, limit = 200): RunSummary[] {
  let files: string[]
  try {
    files = readdirSync(logsDir(cwd)).filter((f) => /^[\w-]+\.json$/.test(f))
  } catch {
    return []
  }
  return files
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => readRun(join(logsDir(cwd), f)))
    .filter((r): r is RunDetail => !!r)
    .map(({ steps: _s, ...summary }) => summary)
}

export function getRun(cwd: string, file: string): RunDetail | null {
  if (!/^[\w-]+\.json$/.test(file)) return null
  return readRun(join(logsDir(cwd), file))
}
