import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DurableJobArtifactRef } from '../../shared/durable-jobs'

/**
 * Where a durable job works and how its checkpoints are kept.
 *
 * A job on a git repository never works in the owner's tree: it gets its own worktree on a new
 * branch `conductor-job/<id>`, cut from the owner's HEAD commit. Uncommitted changes in the
 * owner's tree are therefore not part of the job (the creation event says so), and nothing the
 * job does touches them. Checkpoint commits are made in that worktree only, so they can only
 * contain the job's own changes. A job on a folder without git (or with isolation switched off)
 * works in place and its checkpoints are file snapshots under the job's logDir; nothing is ever
 * committed into the owner's tree.
 */

export interface JobWorktree { path: string; branch: string; baseCommit: string }

/** Every commit a checkpoint makes carries this trailer, so reconciliation can find it. */
export const OPERATION_TRAILER = 'Conductor-Job-Operation'

const git = (cwd: string, args: string[], timeoutMs = 120_000): Promise<string> => new Promise((resolvePromise, reject) => {
  execFile('git', args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
    if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim().slice(0, 600)}`))
    else resolvePromise(String(stdout))
  })
})

export async function gitRoot(path: string): Promise<string | null> {
  try { return resolve((await git(path, ['rev-parse', '--show-toplevel'], 20_000)).trim()) } catch { return null }
}

export interface WorktreeOps {
  gitRoot(path: string): Promise<string | null>
  create(projectPath: string, jobId: string, target: string): Promise<JobWorktree>
  /** Commits every change in the job's worktree; undefined when there was nothing to commit. */
  commit(worktreePath: string, message: string, operationId: string): Promise<string | undefined>
  /** The commit carrying this operation id, if one was made (reconciliation). */
  findCommit(worktreePath: string, operationId: string): Promise<string | undefined>
  /** Copies `files` (relative to cwd) into `directory` and writes manifest.json last. */
  snapshot(cwd: string, files: string[], directory: string): Promise<DurableJobArtifactRef[]>
  /** A snapshot is complete only once its manifest exists. */
  snapshotComplete(directory: string): boolean
}

export const gitWorktrees: WorktreeOps = {
  gitRoot,

  async create(projectPath, jobId, target) {
    const root = await gitRoot(projectPath)
    if (!root) throw new Error('Not a git repository')
    const baseCommit = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const branch = `conductor-job/${jobId}`
    await mkdir(dirname(target), { recursive: true })
    await git(root, ['worktree', 'add', '-b', branch, target, baseCommit])
    return { path: resolve(target), branch, baseCommit }
  },

  async commit(worktreePath, message, operationId) {
    await git(worktreePath, ['add', '-A'])
    const staged = (await git(worktreePath, ['diff', '--cached', '--name-only'])).trim()
    if (!staged) return undefined
    // The owner's identity when configured; a fixed job identity otherwise, so an unconfigured
    // machine still checkpoints. Nothing is ever pushed from here.
    const identity = (await git(worktreePath, ['config', 'user.email']).catch(() => '')).trim() ? [] : ['-c', 'user.name=Conductor durable job', '-c', 'user.email=durable-job@conductor.invalid']
    await git(worktreePath, [...identity, 'commit', '--no-verify', '-q', '-m', message, '-m', `${OPERATION_TRAILER}: ${operationId}`])
    return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
  },

  async findCommit(worktreePath, operationId) {
    if (!existsSync(worktreePath)) return undefined
    const found = (await git(worktreePath, ['log', '--format=%H', '-1', '--fixed-strings', `--grep=${OPERATION_TRAILER}: ${operationId}`]).catch(() => '')).trim()
    return found || undefined
  },

  async snapshot(cwd, files, directory) {
    await mkdir(directory, { recursive: true })
    const base = resolve(cwd)
    const manifest: Array<{ path: string; sha256: string; bytes: number }> = []
    const refs: DurableJobArtifactRef[] = []
    for (const file of [...new Set(files)].slice(0, 2_000)) {
      const source = resolve(base, file)
      const rel = relative(base, source)
      // Only files inside the job's folder; a path that escapes it is not the job's to copy.
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      const info = await stat(source).catch(() => null)
      if (!info?.isFile() || info.size > 50 * 1024 * 1024) continue
      const target = join(directory, 'files', rel)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      manifest.push({ path: rel.replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(target)).digest('hex'), bytes: info.size })
      refs.push({ path: target, kind: 'checkpoint', note: rel.replaceAll('\\', '/') })
    }
    const temporary = join(directory, 'manifest.json.tmp')
    await writeFile(temporary, JSON.stringify({ cwd: base, files: manifest }, null, 2))
    await rename(temporary, join(directory, 'manifest.json'))
    refs.unshift({ path: join(directory, 'manifest.json'), kind: 'checkpoint', note: `${manifest.length} file(s)` })
    return refs
  },

  snapshotComplete: directory => existsSync(join(directory, 'manifest.json'))
}
