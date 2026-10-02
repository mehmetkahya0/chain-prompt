/**
 * Integration test of the whole engine through the headless CLI — real pty,
 * real hook server, real curl hooks, real git — with scripts/fake-claude.cjs
 * standing in for claude (no model, no login, no cost).
 *
 *   npm run test:headless        (macOS / Linux: needs bash, curl and git)
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { parseHeadlessArgs, runHeadless } from '../src/main/headless'
import { logsDir } from '../src/main/core/runLog'

let failures = 0
const ok = (cond: boolean, name: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

const fake = resolve('scripts/fake-claude.cjs')
chmodSync(fake, 0o755)

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chain-headless-'))
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
  g('init', '-q')
  g('config', 'user.email', 't@t')
  g('config', 'user.name', 't')
  writeFileSync(join(dir, 'README.md'), 'test\n')
  g('add', '.')
  g('commit', '-qm', 'init')
  return dir
}

async function run(chain: object, extra: string[] = [], cwd = repo()) {
  const file = join(mkdtempSync(join(tmpdir(), 'chain-file-')), 'test.chain.json')
  writeFileSync(file, JSON.stringify(chain))
  const o = parseHeadlessArgs([file, '--cwd', cwd, '--claude', fake, '--delay', '0.2', ...extra], { ...DEFAULT_SETTINGS, retryDelaySec: 0 })
  if (typeof o === 'string') throw new Error(o)
  const lines: string[] = []
  const notices: string[] = []
  const code = await runHeadless(o, (kind) => notices.push(kind), (l) => lines.push(l))
  return { code, lines, notices, cwd }
}

async function main() {
  {
    const { code, lines, cwd } = await run({
      format: 'chain-prompt',
      version: 2,
      name: 'integration',
      variables: [{ name: 'word', default: 'apple' }],
      steps: [
        { prompt: 'WRITE fruit.txt {{word}}', verify: 'grep -q banana fruit.txt' },
        { prompt: 'WRITE out.txt wrong', verify: 'grep -q right out.txt', fixPrompt: 'WRITE out.txt right', maxLoops: 2, model: 'claude-opus-5-5' },
        { prompt: 'never sent', when: 'test -f does-not-exist' },
        { prompt: 'Summarize: {{prev.output}}', newSession: true }
      ]
    }, ['--var', 'word=banana'])
    const out = lines.join('\n')
    if (code !== 0) console.log(out)
    ok(code === 0, 'chain completes with exit code 0')
    ok(readFileSync(join(cwd, 'fruit.txt'), 'utf8') === 'banana\n', '--var overrides the default, verify passes')
    ok(readFileSync(join(cwd, 'out.txt'), 'utf8') === 'right\n' && /fix attempt 1/.test(out), 'failed verify -> fix prompt -> verify passes')
    ok(/restarting claude \(--continue\) for model "claude-opus-5-5"/.test(out), 'per-step model restarts claude with --continue')
    ok(/Step 3\/4 skipped: condition/.test(out), 'when: condition skips step 3')
    // Step 4 goes back to the default model, so claude restarts anyway — as a fresh session (no /clear needed).
    ok(/restarting claude \(new session\)/.test(out), 'new-session step after a model change restarts fresh')
    const refs = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/chain-prompt/'], { cwd }).toString().trim().split('\n')
    ok(refs.length === 3, `git checkpoints for the 3 steps that ran (${refs.length})`)
    ok(execFileSync('git', ['status', '--porcelain'], { cwd }).toString().includes('fruit.txt'), 'checkpoints leave the working tree alone')
    const json = readdirSync(logsDir(cwd)).find((f) => f.endsWith('.json'))!
    const summary = JSON.parse(readFileSync(join(logsDir(cwd), json), 'utf8'))
    ok(summary.name === 'integration' && summary.steps[3].status === 'done', 'run summary written')
    ok(summary.steps[0].usage?.outputTokens === 200 && summary.steps[0].usage.costUsd > 0, 'token usage + cost from the transcript')
    ok(summary.steps[1].usage?.outputTokens === 400, `usage of fix loops is summed (${JSON.stringify(summary.steps[1].usage)})`)
    ok(/1 file changed/.test(summary.steps[0].diffStat ?? ''), `diff stat recorded (${summary.steps[0].diffStat})`)
    ok(/Summarize: Wrote out\.txt/.test(out) || summary.steps[3].output === 'ECHO Summarize: Wrote out.txt', '{{prev.output}} reaches the next prompt')
  }
  {
    const { code, lines } = await run({ steps: [{ prompt: 'FAIL' }, { prompt: 'after' }] })
    ok(code === 1 && /retrying in 0s \(2\/2\)/.test(lines.join('\n')), 'API error is retried, then exit 1')
  }
  {
    const { code, lines } = await run({ steps: [{ prompt: 'FAIL', onError: 'skip' }, { prompt: 'after' }] }, ['--no-checkpoints'])
    ok(code === 1 && /on error = skip/.test(lines.join('\n')) && /Step 2\/2 done/.test(lines.join('\n')), 'onError skip continues; exit 1 reports the failure')
  }
  {
    const { code } = await run({ steps: [{ prompt: 'ASK' }] }, ['--detect-questions'])
    ok(code === 3, 'question in headless mode -> exit 3 (needs a human)')
  }
  {
    const { code, lines } = await run({ steps: [{ prompt: 'Hi {{who}}' }] })
    ok(code === 2 && /who/.test(lines.join('\n')), 'missing variable -> exit 2')
  }
  {
    const cwd = repo()
    const { code } = await run({ steps: [{ prompt: 'WRITE a.txt x' }] }, ['--git-finish', 'branch'], cwd)
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd }).toString().trim()
    const last = execFileSync('git', ['log', '-1', '--format=%s'], { cwd }).toString().trim()
    ok(code === 0 && branch.startsWith('chain-prompt/') && /^Chain Prompt: test/.test(last), `git finish: commit on a new branch (${branch})`)
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed')
  process.exit(failures ? 1 : 0)
}

void main()
