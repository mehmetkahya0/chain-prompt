import { readFileSync, statSync } from 'node:fs'
import type { StepUsage } from '../../shared/types'

/** USD per million tokens. Cache writes are billed at 1.25x input (5 min TTL). */
interface Price {
  input: number
  output: number
  cacheRead: number
}

// Public Claude API list prices. Matched by prefix, most specific first; date
// suffixes (claude-x-20250101) and context suffixes ([1m]) are ignored.
const PRICES: [string, Price][] = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4', { input: 15, output: 75, cacheRead: 1.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-3-7-sonnet', { input: 3, output: 15, cacheRead: 0.3 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, cacheRead: 0.08 }]
]

export function priceFor(model: string): Price | null {
  const id = model.toLowerCase().replace(/^(anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '').replace(/\[.*\]$/, '')
  for (const [prefix, price] of PRICES) if (id.startsWith(prefix)) return price
  return null
}

export function emptyUsage(): StepUsage {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, models: [] }
}

interface TranscriptMessage {
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/**
 * Sum token usage of the assistant messages in a Claude Code transcript
 * (JSONL) whose timestamp lies in [since, until]. A message split into
 * several lines (one per content block) repeats the same usage, so lines are
 * de-duplicated by message id. Subagent transcripts are separate files and
 * are not included. Ids in `counted` are skipped and the ids used are added
 * to it, so back-to-back turns never count a message twice.
 */
export function usageFromTranscript(path: string, since: number, until = Date.now(), counted?: Set<string>): StepUsage | null {
  let text: string
  try {
    // Transcripts can get big; only the tail can contain this step.
    const size = statSync(path).size
    text = readFileSync(path, 'utf8')
    if (size > 64 * 1024 * 1024) text = text.slice(-32 * 1024 * 1024)
  } catch {
    return null
  }
  const byId = new Map<string, TranscriptMessage>()
  let anon = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    const ts = Date.parse(String(entry.timestamp ?? ''))
    if (!Number.isFinite(ts) || ts < since - 1000 || ts > until + 5000) continue
    const msg = entry.message as Record<string, unknown> | undefined
    const u = msg?.usage as Record<string, unknown> | undefined
    if (!msg || !u) continue
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const id = typeof msg.id === 'string' ? msg.id : `anon-${anon++}`
    if (counted?.has(id)) continue
    byId.set(id, {
      model: String(msg.model ?? ''),
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
      cacheRead: n(u.cache_read_input_tokens)
    })
  }
  const usage = emptyUsage()
  const models = new Set<string>()
  for (const id of byId.keys()) if (!id.startsWith('anon-')) counted?.add(id)
  for (const m of byId.values()) {
    usage.inputTokens += m.input
    usage.outputTokens += m.output
    usage.cacheWriteTokens += m.cacheWrite
    usage.cacheReadTokens += m.cacheRead
    if (m.model && m.model !== '<synthetic>') models.add(m.model)
    const p = priceFor(m.model)
    if (m.model === '<synthetic>') continue
    if (!p) {
      usage.costUsd = null
      continue
    }
    if (usage.costUsd !== null) {
      usage.costUsd += (m.input * p.input + m.output * p.output + m.cacheWrite * p.input * 1.25 + m.cacheRead * p.cacheRead) / 1e6
    }
  }
  usage.models = [...models]
  return usage
}

/** Add `b` into `a` (for repeated fix loops of one step). */
export function addUsage(a: StepUsage | undefined, b: StepUsage): StepUsage {
  if (!a) return b
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
    models: [...new Set([...a.models, ...b.models])]
  }
}
