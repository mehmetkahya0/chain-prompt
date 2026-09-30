/**
 * Fast state-machine tests for ChainRunner with a fake claude session
 * (no Electron, no claude). Hook events are injected by hand.
 *
 *   npm run test:unit
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings, type Step } from '../src/shared/types'
import { ChainRunner, type NoticeKind } from '../src/main/core/chainRunner'
import type { SessionManager } from '../src/main/core/sessionManager'

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
  current = {
    launchId: this.launchId,
    alive: true,
    lastOutputAt: Date.now(),
    pastePrompt: (t: string) => this.pasted.push(t),
    pressEnter: () => {
      if (this.acceptPrompts) setTimeout(() => (this.submits++, this.hook('UserPromptSubmit')), 5)
    }
  }
  hook(event: string, payload: Record<string, unknown> = {}) {
    this.emit('hook', { launchId: this.launchId, event, payload, receivedAt: Date.now() })
  }
  start() {}
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

function setup(n: number, extra: Partial<Settings> = {}) {
  const sm = new FakeSession()
  const settings: Settings = { ...DEFAULT_SETTINGS, stepDelayMs: 20, ...extra }
  const notices: NoticeKind[] = []
  const chain = new ChainRunner(sm as unknown as SessionManager, () => settings, (k) => notices.push(k))
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

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

void main()
