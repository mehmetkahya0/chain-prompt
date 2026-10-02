import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * Git helpers for checkpoints. A checkpoint is a commit of the *whole*
 * working tree (tracked + untracked, minus ignored files) built with a
 * throwaway index, so the user's branch, index and stash are never touched.
 * It is kept alive by a ref under refs/chain-prompt/.
 */

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((res) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
        res({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

async function gitOk(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await git(cwd, args, env)
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed`)
  return r.stdout.trim()
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Chain Prompt',
  GIT_AUTHOR_EMAIL: 'chain-prompt@localhost',
  GIT_COMMITTER_NAME: 'Chain Prompt',
  GIT_COMMITTER_EMAIL: 'chain-prompt@localhost'
}

/** Write the current working tree as a tree object without touching the real index. */
async function snapshotTree(cwd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'chain-prompt-idx-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    // Seed from HEAD when there is one so unchanged files hash fast.
    await git(cwd, ['read-tree', 'HEAD'], env)
    await gitOk(cwd, ['add', '-A', '--', '.'], env)
    return await gitOk(cwd, ['write-tree'], env)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Create a checkpoint commit; returns its hash. */
export async function createCheckpoint(cwd: string, refName: string, message: string): Promise<string> {
  const tree = await snapshotTree(cwd)
  const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
  const parents = head.code === 0 ? ['-p', head.stdout.trim()] : []
  const commit = await gitOk(cwd, ['commit-tree', tree, ...parents, '-m', message], IDENTITY)
  await gitOk(cwd, ['update-ref', `refs/chain-prompt/${refName}`, commit])
  return commit
}

export async function deleteCheckpointRef(cwd: string, refName: string): Promise<void> {
  await git(cwd, ['update-ref', '-d', `refs/chain-prompt/${refName}`])
}

/** `git diff --stat` of the working tree against a checkpoint. Returns [summary line, full stat]. */
export async function diffStatSince(cwd: string, checkpoint: string): Promise<[string, string]> {
  const tree = await snapshotTree(cwd)
  const stat = await gitOk(cwd, ['diff', '--stat=120', `${checkpoint}^{tree}`, tree])
  const lines = stat.split('\n').filter(Boolean)
  const summary = lines.length ? lines[lines.length - 1].trim() : 'no changes'
  return [summary, stat]
}

/**
 * Put the working tree back to a checkpoint: files the step added are
 * deleted, changed/deleted files are restored. If HEAD moved (claude made
 * commits), the branch is moved back too (the commits stay in the reflog).
 */
export async function rollbackTo(cwd: string, checkpoint: string): Promise<void> {
  const parent = await git(cwd, ['rev-parse', '--verify', '-q', `${checkpoint}^`])
  const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
  if (parent.code === 0 && head.code === 0 && parent.stdout.trim() !== head.stdout.trim()) {
    await gitOk(cwd, ['reset', '-q', '--mixed', parent.stdout.trim()])
  }
  const top = await gitOk(cwd, ['rev-parse', '--show-toplevel'])
  const prefix = await gitOk(cwd, ['rev-parse', '--show-prefix'])
  const list = (s: string) => s.split('\0').filter(Boolean)
  const snapFiles = new Set(list(await gitOk(cwd, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', checkpoint])))
  const now = [
    ...list(await gitOk(top, ['ls-files', '-z'])),
    ...list(await gitOk(top, ['ls-files', '-z', '--others', '--exclude-standard']))
  ]
  const root = resolve(top)
  for (const f of now) {
    if (snapFiles.has(f)) continue
    // Only inside the chosen folder, never outside the repo root.
    if (prefix && !f.startsWith(prefix)) continue
    const abs = resolve(root, f)
    if (!abs.startsWith(root + sep)) continue
    rmSync(abs, { force: true })
  }
  if ([...snapFiles].some((f) => !prefix || f.startsWith(prefix))) {
    await gitOk(top, ['checkout', checkpoint, '--', prefix ? prefix : '.'])
  }
  // `checkout <commit> -- path` stages the files; put the index back to HEAD.
  await git(top, ['reset', '-q'])
}

export interface FinishResult {
  ok: boolean
  message: string
}

/** Commit everything (optionally on a new branch, optionally pushed) at the end of a chain. */
export async function finishChain(
  cwd: string,
  action: 'commit' | 'branch' | 'branchPush',
  branchPrefix: string,
  message: string
): Promise<FinishResult> {
  try {
    const status = await gitOk(cwd, ['status', '--porcelain'])
    let branch = ''
    if (action !== 'commit') {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      branch = `${branchPrefix}${stamp}`
      await gitOk(cwd, ['checkout', '-b', branch])
    }
    if (status) {
      await gitOk(cwd, ['add', '-A'])
      await gitOk(cwd, ['commit', '-m', message])
    }
    if (action === 'branchPush') {
      const r = await git(cwd, ['push', '-u', 'origin', branch])
      if (r.code !== 0) return { ok: false, message: `Committed on ${branch}, but push failed: ${(r.stderr || r.stdout).trim()}` }
      return { ok: true, message: `Committed and pushed to ${branch}` }
    }
    if (!status) return { ok: true, message: branch ? `Created branch ${branch} (nothing to commit)` : 'Nothing to commit' }
    return { ok: true, message: branch ? `Committed on new branch ${branch}` : 'Committed the changes' }
  } catch (e) {
    return { ok: false, message: `Git finish failed: ${(e as Error).message}` }
  }
}
