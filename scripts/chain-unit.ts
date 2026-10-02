/**
 * Fast state-machine tests for ChainRunner with a fake claude session
 * (no Electron, no claude). Hook events are injected by hand.
 *
 *   npm run test:unit
 */
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_SETTINGS, sanitizeStepConfig, type Settings, type Step } from '../src/shared/types'
import { renderPrompt, variableNames } from '../src/shared/variables'
import { ChainRunner, type NoticeKind } from '../src/main/core/chainRunner'
import type { LaunchOverrides, SessionManager } from '../src/main/core/sessionManager'
import { looksLikeQuestion } from '../src/main/core/questions'
import { usageFromTranscript, priceFor } from '../src/main/core/usage'
import { createCheckpoint, diffStatSince, rollbackTo } from '../src/main/core/git'
import { buildClaudeArgs } from '../src/main/core/ptySession'
import { parseHeadlessArgs } from '../src/main/headless'
import { Store } from '../src/main/store'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeSession extends EventEmitter {
  launchId = 'L1'
  alive = true
  ready = true
  cwd = mkdtempSync(join(tmpdir(), 'chain-unit-'))
  mode = 'new'
  pasted: string[] = []
  submits = 0
  writes: string[] = []
  /** When true, pressing Enter produces a UserPromptSubmit hook. */
  acceptPrompts = true
  starts: { mode: string; overrides: LaunchOverrides }[] = []
  current = this.makeSession('L1', 'new', {})
  makeSession(launchId: string, mode: string, o: LaunchOverrides) {
    return {
      launchId,
      mode,
      model: o.model ?? '',
      permissionMode: o.permissionMode ?? 'default',
      alive: true,
      lastOutputAt: Date.now(),
      pastePrompt: (t: string) => this.pasted.push(t),
      pressEnter: () => {
        if (this.acceptPrompts) setTimeout(() => (this.submits++, this.hook('UserPromptSubmit')), 5)
      }
    }
  }
  hook(event: string, payload: Record<string, unknown> = {}) {
    this.emit('hook', { launchId: this.launchId, event, payload, receivedAt: Date.now() })
  }
  start(_cwd: string, mode: string, overrides: LaunchOverrides = {}) {
    this.starts.push({ mode, overrides })
    this.launchId = `L${this.starts.length + 1}`
    this.current = this.makeSession(this.launchId, mode, overrides)
  }
  async waitReady() {
    return true
  }
  write(d: string) {
    this.writes.push(d)
  }
}

let failures = 0
function ok(cond: boolean, name: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

function setup(n: number, extra: Partial<Settings> = {}, vars: Record<string, string> = {}) {
  const sm = new FakeSession()
  const settings: Settings = { ...DEFAULT_SETTINGS, stepDelayMs: 20, retryMax: 0, ...extra }
  const notices: NoticeKind[] = []
  const chain = new ChainRunner(sm as unknown as SessionManager, () => settings, (k) => notices.push(k), { getVariables: () => vars })
  for (let i = 1; i <= n; i++) chain.applyQueueOp({ type: 'add', prompt: `prompt ${i}` })
  const st = () => chain.steps.map((s) => s.status).join(',')
  // Wait until the i-th prompt of this test was sent and accepted by "claude".
  const running = async (i: number) => {
    for (let t = 0; t < 300 && sm.submits < i; t++) await sleep(10)
    await sleep(20)
  }
  return { sm, chain, notices, st, running }
}

async function main() {
  {
    const { sm, chain, notices, st, running } = setup(3)
    chain.start()
    await running(1)
    ok(sm.pasted[0] === 'prompt 1' && st() === 'running,pending,pending', 'start sends step 1')
    sm.hook('Stop')
    await running(2)
    ok(st() === 'done,running,pending' && sm.pasted[1] === 'prompt 2', 'Stop hook triggers step 2')
    sm.hook('Stop')
    await running(3)
    sm.hook('Stop')
    await sleep(30)
    ok(chain.state === 'completed' && st() === 'done,done,done', 'chain completes after 3 Stop hooks')
    ok(notices.includes('done'), 'completion notification')
    ok(chain.steps.every((s) => s.startedAt && s.endedAt), 'timestamps recorded')
    chain.dispose()
  }
  {
    const { sm, chain } = setup(2)
    sm.acceptPrompts = false
    chain.start()
    await sleep(700)
    sm.hook('Stop') // stale Stop from an earlier turn, before our prompt was accepted
    await sleep(50)
    ok(chain.steps[0].status === 'running' && sm.pasted.length === 1, 'Stop before UserPromptSubmit is ignored')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, notices, st, running } = setup(2)
    chain.start()
    await running(1)
    sm.hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
    ok(chain.state === 'waiting_user' && chain.steps[0].status === 'waiting', 'permission Notification -> waiting_user')
    ok(notices.includes('attention'), 'attention notification sent')
    sm.hook('PostToolUse')
    ok(chain.state === 'running' && chain.steps[0].status === 'running', 'PostToolUse -> back to running')
    sm.hook('Notification', { notification_type: 'auth_success', message: 'x' })
    ok(chain.state === 'running', 'non-blocking Notification types are ignored')
    sm.hook('Stop')
    await running(2)
    ok(st() === 'done,running', 'Stop after waiting completes the step')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, st, running } = setup(3)
    chain.start()
    await running(1)
    chain.pause()
    ok(chain.state === 'pausing', 'pause while running -> pausing')
    sm.hook('Stop')
    await sleep(60)
    ok(chain.state === 'paused' && st() === 'done,pending,pending' && sm.pasted.length === 1, 'step finishes, next not sent')
    chain.resume()
    await running(2)
    ok(st() === 'done,running,pending', 'resume sends step 2')
    chain.pause()
    chain.resume()
    ok(chain.state === 'running', 'resume cancels a pending pause')
    chain.stop()
    ok(chain.state === 'idle' && chain.steps[1].status === 'interrupted', 'stop -> idle, step interrupted')
    ok(sm.writes.includes('\x1b'), 'stop sends Esc to claude')
    chain.dispose()
  }
  {
    const { sm, chain, st, running } = setup(3)
    chain.start()
    await running(1)
    chain.skipNext()
    ok(st() === 'running,skipped,pending', 'skipNext skips the following step')
    sm.hook('Stop')
    await running(3)
    ok(st() === 'done,skipped,running' && sm.pasted[1] === 'prompt 3', 'chain jumps over the skipped step')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, notices, st, running } = setup(2)
    chain.start()
    await running(1)
    sm.hook('StopFailure', { error_type: 'rate_limit', error_message: 'Rate limited' })
    ok(chain.state === 'paused' && st() === 'error,pending', 'StopFailure -> step error, chain paused')
    ok(/rate_limit/.test(chain.steps[0].note ?? '') && chain.currentStepId === chain.steps[0].id, 'error reason shown on failed step')
    ok(notices.includes('error'), 'error notification')
    chain.resume()
    await running(2)
    ok(sm.pasted.length === 2 && sm.pasted[1] === 'prompt 1', 'resume retries the failed step')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, st, running } = setup(2)
    chain.start()
    await running(1)
    sm.hook('SessionEnd')
    ok(chain.state === 'paused' && st() === 'error,pending', 'SessionEnd mid-step -> error + pause')
    chain.dispose()
  }
  {
    // idleTimeoutMin 0.001 = 60 ms; the watchdog ticks every 5 s.
    const { sm, chain, notices, st, running } = setup(2, { idleTimeoutMin: 0.001 })
    chain.start()
    await running(1)
    sm.current.lastOutputAt = Date.now() - 10_000
    await sleep(5300)
    ok(chain.state === 'paused' && chain.steps[0].status === 'running', 'idle timeout pauses chain, step keeps running')
    ok(notices.includes('attention'), 'stall notification')
    sm.hook('Stop')
    await sleep(60)
    ok(chain.state === 'paused' && st() === 'done,pending', 'late Stop marks done but chain stays paused')
    chain.dispose()
  }
  {
    const { chain } = setup(0)
    const saved: Step[] = [
      { id: 'a', prompt: 'x', newSession: false, status: 'done' },
      { id: 'b', prompt: 'y', newSession: false, status: 'running', startedAt: 1 },
      { id: 'c', prompt: 'z', newSession: false, status: 'pending' }
    ]
    chain.restore(saved)
    ok(chain.steps[1].status === 'interrupted' && chain.currentStepId === 'b', 'restore marks running step as interrupted')
    ok(chain.applyQueueOp({ type: 'move', id: 'c', toIndex: 0 }) === null && chain.steps[0].id === 'c', 'move reorders')
    chain.applyQueueOp({ type: 'duplicate', id: 'c' })
    ok(chain.steps.length === 4 && chain.steps[1].prompt === 'z', 'duplicate inserts copy below')
    chain.dispose()
  }

  await newFeatureTests()
  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

void main()

const waitFor = async (cond: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await sleep(10)
}

async function newFeatureTests() {
  {
    const { sm, chain, notices, st, running } = setup(2, { retryMax: 1, retryDelaySec: 0 })
    chain.start()
    await running(1)
    sm.hook('StopFailure', { error_type: 'overloaded', error_message: 'busy' })
    await running(2)
    ok(sm.pasted[1] === 'prompt 1' && chain.steps[0].status === 'running' && chain.steps[0].attempts === 1, 'API error is retried automatically')
    ok(!notices.includes('error'), 'no error notification while retrying')
    sm.hook('Stop')
    await running(3)
    ok(st() === 'done,running', 'retried step completes and the chain goes on')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, st, running } = setup(3)
    chain.applyQueueOp({ type: 'update', id: chain.steps[0].id, onError: 'skip' })
    chain.start()
    await running(1)
    sm.hook('SessionEnd')
    await running(2)
    ok(st() === 'error,running,pending', 'onError=skip: failed step is left behind, chain continues')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, notices, st, running } = setup(2)
    chain.start()
    await running(1)
    sm.hook('Stop', { last_assistant_message: 'I found two options.\n\nShould I use Redis or Postgres?' })
    await sleep(30)
    ok(chain.state === 'waiting_user' && chain.steps[0].status === 'waiting', 'question at the end of a turn -> needs you')
    ok(notices.includes('attention') && sm.pasted.length === 1, 'question: attention notice, next prompt not sent')
    sm.hook('UserPromptSubmit') // user answers in the terminal
    ok(chain.steps[0].status === 'running', 'answer in the terminal -> running again')
    sm.hook('Stop', { last_assistant_message: 'Done, used Postgres.' })
    await running(2)
    ok(st() === 'done,running', 'turn after the answer completes the step')
    sm.hook('Stop', { last_assistant_message: 'Want me to also add tests?' })
    await sleep(30)
    ok(chain.state === 'waiting_user', 'second question detected')
    chain.resume()
    await sleep(60)
    ok(chain.state === 'completed' && st() === 'done,done', 'Resume carries on without answering')
    chain.dispose()
  }
  {
    const { sm, chain, running } = setup(0, { detectQuestions: false })
    chain.applyQueueOp({ type: 'add', prompt: 'a' })
    chain.applyQueueOp({ type: 'add', prompt: 'b' })
    chain.start()
    await running(1)
    sm.hook('Stop', { last_assistant_message: 'Should I continue?' })
    await running(2)
    ok(sm.pasted.length === 2, 'question detection can be switched off')
    chain.stop()
    chain.dispose()
  }
  {
    const vars = { feature: 'dark mode' }
    const { sm, chain, running } = setup(0, {}, vars)
    chain.applyQueueOp({ type: 'add', prompt: 'Build {{feature}} in {{folderName}} (step {{step}})' })
    chain.applyQueueOp({ type: 'add', prompt: 'Previous said: {{prev.output}}' })
    chain.start()
    await running(1)
    ok(sm.pasted[0] === `Build dark mode in ${sm.cwd.split(/[\\/]/).pop()} (step 1)`, 'variables are substituted in prompts')
    sm.hook('Stop', { last_assistant_message: 'PLAN READY' })
    await running(2)
    ok(sm.pasted[1] === 'Previous said: PLAN READY', '{{prev.output}} holds the previous step output')
    ok(chain.steps[0].output === 'PLAN READY', 'step output is stored')
    chain.stop()
    chain.dispose()
  }
  {
    const vars: Record<string, string> = { ticket: '' }
    const { sm, chain } = setup(0, {}, vars)
    chain.applyQueueOp({ type: 'add', prompt: 'Fix {{ticket}}' })
    chain.start()
    ok(chain.state === 'idle' && /ticket/.test(chain.message) && sm.pasted.length === 0, 'missing variable blocks start')
    chain.dispose()
  }
  {
    const { sm, chain, st, running } = setup(0)
    chain.applyQueueOp({ type: 'add', prompt: 'never', when: 'exit 3' })
    chain.applyQueueOp({ type: 'add', prompt: 'yes', when: 'exit 0' })
    chain.start()
    await running(1)
    ok(st() === 'skipped,running' && sm.pasted[0] === 'yes', 'when: non-zero exit skips, zero runs')
    ok(/Condition not met/.test(chain.steps[0].note ?? ''), 'skipped-by-condition note')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, st, running } = setup(0)
    chain.applyQueueOp({ type: 'add', prompt: 'work', verify: 'echo boom-$((40+2)); exit 1', fixPrompt: 'Fix: {{verify.output}}', maxLoops: 1 })
    chain.applyQueueOp({ type: 'add', prompt: 'next' })
    chain.start()
    await running(1)
    sm.hook('Stop', { last_assistant_message: 'done' })
    await running(2)
    ok(sm.pasted[1] === 'Fix: boom-42' && chain.steps[0].loops === 1, 'failed verify sends the fix prompt with {{verify.output}}')
    sm.hook('Stop', { last_assistant_message: 'fixed' })
    await waitFor(() => chain.state === 'paused')
    ok(st() === 'error,pending' && /Verification/.test(chain.steps[0].note ?? ''), 'verify still failing after maxLoops -> error, paused')
    chain.dispose()
  }
  {
    const { sm, chain, st, running } = setup(0)
    chain.applyQueueOp({ type: 'add', prompt: 'work', verify: 'exit 0' })
    chain.applyQueueOp({ type: 'add', prompt: 'next' })
    chain.start()
    await running(1)
    sm.hook('Stop', { last_assistant_message: 'ok' })
    await running(2)
    ok(st() === 'done,running', 'passing verify completes the step')
    chain.stop()
    chain.dispose()
  }
  {
    const { sm, chain, running } = setup(0)
    chain.applyQueueOp({ type: 'add', prompt: 'a' })
    chain.applyQueueOp({ type: 'add', prompt: 'b', model: 'opus', permissionMode: 'acceptEdits' })
    chain.applyQueueOp({ type: 'add', prompt: 'c' })
    chain.start()
    await running(1)
    ok(sm.starts.length === 0, 'no restart when the step uses the default model')
    sm.hook('Stop')
    await running(2)
    ok(
      sm.starts[0]?.mode === 'continue' && sm.starts[0]?.overrides.model === 'opus' && sm.starts[0]?.overrides.permissionMode === 'acceptEdits',
      'per-step model / permission mode restarts claude with --continue'
    )
    sm.hook('Stop')
    await running(3)
    ok(sm.starts.length === 2 && sm.starts[1].overrides.model === '', 'next step switches back to the default model')
    chain.stop()
    chain.dispose()
  }
  {
    const { chain, st } = setup(4)
    const [a, b, c] = chain.steps.map((s) => s.id)
    chain.applyQueueOp({ type: 'bulk', ids: [a, b], action: 'skip' })
    ok(st() === 'skipped,skipped,pending,pending', 'bulk skip')
    chain.applyQueueOp({ type: 'bulk', ids: [a, c], action: 'newSessionOn' })
    ok(chain.steps[0].newSession && chain.steps[2].newSession && !chain.steps[1].newSession, 'bulk new session')
    chain.applyQueueOp({ type: 'bulk', ids: [a, b], action: 'reset' })
    chain.applyQueueOp({ type: 'bulk', ids: [b, c], action: 'remove' })
    ok(chain.steps.length === 2 && st() === 'pending,pending', 'bulk reset + remove')
    chain.applyQueueOp({ type: 'update', id: a, verify: 'npm test', maxLoops: 2 })
    chain.applyQueueOp({ type: 'update', id: a, verify: '' })
    ok(chain.steps[0].verify === undefined && chain.steps[0].maxLoops === 2, 'update clears a field set to empty')
    chain.dispose()
  }

  // ---- pure helpers
  ok(looksLikeQuestion('Done.\n\nShould I also update the docs?'), 'question: trailing ?')
  ok(looksLikeQuestion('I made the change. Let me know if you want me to add tests.'), 'question: "let me know if"')
  ok(looksLikeQuestion('Which approach?\n\n1. Fast\n2. Safe'), 'question: option list after a question')
  ok(looksLikeQuestion('**Want me to continue?**'), 'question: markdown around ?')
  ok(!looksLikeQuestion('Why did it fail? The cache was stale.\n\nFixed it and all tests pass.'), 'not a question: ? only mid-text')
  ok(!looksLikeQuestion(''), 'not a question: empty')

  ok(renderPrompt('{{a}} {{ b }} {{unknown}}', { a: '1', b: '2' }) === '1 2 {{unknown}}', 'renderPrompt keeps unknown names')
  ok(variableNames('x {{a}} {{prev.output}}', '{{a}} {{c}}').join() === 'a,prev.output,c', 'variableNames')

  const cfg = sanitizeStepConfig({ prompt: ' hi ', model: 'opus', onError: 'bogus', maxLoops: 3.7, permissionMode: 'x', extra: 1 })
  ok(!!cfg && cfg.prompt === 'hi' && cfg.model === 'opus' && cfg.onError === undefined && cfg.maxLoops === 3 && cfg.permissionMode === undefined && !('extra' in cfg), 'sanitizeStepConfig')
  ok(sanitizeStepConfig({ prompt: '  ' }) === null && sanitizeStepConfig('plain')?.prompt === 'plain', 'sanitizeStepConfig empty / string')

  const args = buildClaudeArgs({ mode: 'continue', settingsFile: 's.json', permissionMode: 'acceptEdits', extraArgs: '--model sonnet', model: 'opus' })
  ok(args.join(' ') === '--settings s.json --continue --permission-mode acceptEdits --model sonnet --model opus', 'per-step --model comes last')

  {
    const dir = mkdtempSync(join(tmpdir(), 'chain-usage-'))
    const t = Date.now()
    const line = (id: string, model: string, ts: number, u: object) =>
      JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), message: { id, model, usage: u } })
    const file = join(dir, 't.jsonl')
    writeFileSync(
      file,
      [
        line('old', 'claude-sonnet-4-6', t - 60_000, { input_tokens: 999, output_tokens: 999 }),
        line('m1', 'claude-sonnet-4-6', t + 10, { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000 }),
        line('m1', 'claude-sonnet-4-6', t + 20, { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000 }),
        line('m2', 'claude-opus-5-5', t + 30, { input_tokens: 0, output_tokens: 1000, cache_creation_input_tokens: 2000 }),
        JSON.stringify({ type: 'user', timestamp: new Date(t).toISOString() })
      ].join('\n')
    )
    const u = usageFromTranscript(file, t)!
    ok(u.inputTokens === 1000 && u.outputTokens === 1100 && u.cacheReadTokens === 10000 && u.cacheWriteTokens === 2000, 'transcript usage: window + de-dup by message id')
    const expected = (1000 * 3 + 100 * 15 + 10000 * 0.3) / 1e6 + (1000 * 20 + 2000 * 4 * 1.25) / 1e6
    ok(u.costUsd !== null && Math.abs(u.costUsd - expected) < 1e-9, 'transcript cost estimate')
    ok(priceFor('claude-opus-5-5[1m]')?.input === 4 && priceFor('us.anthropic.claude-haiku-4-5-20251001')?.input === 1 && priceFor('gpt') === null, 'price lookup')
  }

  {
    const repo = mkdtempSync(join(tmpdir(), 'chain-git-'))
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString().trim()
    // Windows runners check files out with CRLF (core.autocrlf).
    const text = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
    g('init', '-q')
    g('config', 'user.email', 't@t')
    g('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    writeFileSync(join(repo, 'untracked.txt'), 'keep me\n')
    g('add', 'a.txt')
    g('commit', '-qm', 'init')
    const head = g('rev-parse', 'HEAD')
    const ck = await createCheckpoint(repo, 'step-x', 'test')
    ok(g('rev-parse', 'refs/chain-prompt/step-x') === ck && g('rev-parse', 'HEAD') === head && g('status', '--porcelain') === '?? untracked.txt', 'checkpoint does not touch HEAD / index')
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    writeFileSync(join(repo, 'untracked.txt'), 'changed\n')
    g('add', 'new.txt')
    g('commit', '-qm', 'claude commit')
    const [summary] = await diffStatSince(repo, ck)
    ok(/3 files changed/.test(summary), `diff stat since checkpoint (${summary})`)
    await rollbackTo(repo, ck)
    ok(
      text(join(repo, 'a.txt')) === 'one\n' &&
        !existsSync(join(repo, 'new.txt')) &&
        text(join(repo, 'untracked.txt')) === 'keep me\n' &&
        g('rev-parse', 'HEAD') === head,
      'rollback restores files, removes new ones and moves HEAD back'
    )
  }

  {
    const o = parseHeadlessArgs(['x.chain.json', '--cwd', '/tmp', '--var', 'a=b=c', '--permission-mode', 'acceptEdits', '--tui'])
    ok(typeof o === 'object' && o.vars.a === 'b=c' && o.settings.permissionMode === 'acceptEdits' && o.tui && o.cwd === resolve('/tmp'), 'headless args')
    ok(parseHeadlessArgs(['--bogus']) === 'Unknown option --bogus' && parseHeadlessArgs([]) === 'Missing the chain file', 'headless arg errors')
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'chain-store-'))
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ cwd: '/x', mode: 'continue', steps: [{ id: 'a', prompt: 'p', newSession: false, status: 'done' }], settings: { stepDelayMs: 5 } }))
    const st = new Store(file).data
    ok(st.workspaces.length === 1 && st.workspaces[0].cwd === '/x' && st.workspaces[0].mode === 'continue' && st.workspaces[0].steps.length === 1, 'old single-folder state migrates to one tab')
    ok(st.settings.stepDelayMs === 5 && st.settings.retryMax === DEFAULT_SETTINGS.retryMax, 'settings merge with new defaults')
  }
}
