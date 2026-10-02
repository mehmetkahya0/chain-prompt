#!/usr/bin/env node
/**
 * A stand-in for the interactive `claude` CLI, used by `npm run test:headless`.
 * It speaks the same protocol Chain Prompt relies on: it reads the hook
 * settings passed with --settings and runs those hook commands (curl) with
 * the same JSON payloads Claude Code sends. No model is involved.
 *
 * Prompt language (anything else is just echoed back):
 *   WRITE <file> <text>   write <text> to <file> in the working folder
 *   ASK                   end the turn with a question
 *   FAIL                  end the turn with an API error (StopFailure)
 */
const { execSync } = require('node:child_process')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.lastIndexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const settings = JSON.parse(readFileSync(arg('--settings'), 'utf8'))
const model = arg('--model') || 'claude-sonnet-4-6'
const sessionId = randomUUID()
const transcript = join(require('node:os').tmpdir(), `fake-claude-${sessionId}.jsonl`)
writeFileSync(transcript, '')

function hook(event, payload) {
  const h = settings.hooks?.[event]?.[0]?.hooks?.[0]
  if (!h || h.type !== 'command') return
  const body = JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: process.cwd(), hook_event_name: event, ...payload })
  try {
    execSync(h.command, { input: body, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 })
  } catch {
    /* like claude: a failing hook does not stop the session */
  }
}

let turn = 0
function reply(prompt) {
  hook('UserPromptSubmit', { prompt })
  process.stdout.write(`\r\n> ${prompt.split('\n')[0]}\r\n`)
  setTimeout(() => {
    if (prompt.trim() === 'FAIL') {
      hook('StopFailure', { error_type: 'overloaded_error', error_message: 'Overloaded' })
      return
    }
    let text = `ECHO ${prompt.split('\n')[0]}`
    const w = /^WRITE (\S+) (.*)$/s.exec(prompt.trim())
    if (w) {
      writeFileSync(join(process.cwd(), w[1]), `${w[2]}\n`)
      text = `Wrote ${w[1]}`
    }
    if (prompt.includes('ASK')) text = 'I can do this two ways.\n\nShould I use the fast one?'
    turn++
    appendFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id: `msg_${sessionId}_${turn}`, model, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000 } }
      }) + '\n'
    )
    process.stdout.write(`${text}\r\n`)
    hook('Stop', { last_assistant_message: text, stop_hook_active: false })
  }, 150)
}

process.stdout.write(`fake claude (${model}${args.includes('--continue') ? ', --continue' : ''})\r\n`)
setTimeout(() => hook('SessionStart', { source: args.includes('--continue') ? 'resume' : 'startup', model }), 100)

if (process.stdin.isTTY) process.stdin.setRawMode(true)
let buf = ''
let pasting = false
process.stdin.on('data', (chunk) => {
  let s = chunk.toString('utf8')
  while (s.length) {
    if (s.startsWith('\x1b[200~')) {
      pasting = true
      s = s.slice(6)
    } else if (s.startsWith('\x1b[201~')) {
      pasting = false
      s = s.slice(6)
    } else if (s[0] === '\r' && !pasting) {
      const prompt = buf
      buf = ''
      s = s.slice(1)
      if (!prompt.trim()) continue
      if (prompt.trim() === '/clear') {
        setTimeout(() => hook('SessionStart', { source: 'clear' }), 50)
        continue
      }
      reply(prompt)
    } else if (s[0] === '\x1b' && !pasting) {
      s = s.slice(1) // Esc: interrupt — nothing to interrupt here
    } else if (s[0] === '\x03') {
      hook('SessionEnd', { reason: 'other' })
      process.exit(0)
    } else {
      buf += s[0]
      s = s.slice(1)
    }
  }
})
