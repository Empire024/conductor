import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
 *
 * A worktree holds committed files only, so a Node project's git-ignored node_modules is absent
 * and its tests cannot run there. The worktree is never linked to the owner's node_modules (an
 * install or build would write through the link into the owner's tree, and electron-builder drops
 * packages reached through a junction); `create` reports the gap in `dependencies.note`, and a
 * project may opt in to a private copy (docs/durable-jobs.md, "Dependencies in a job worktree").
 */

export interface WorktreeDependencies {
  /** `copy` when the project opted in through WORKTREE_SETTINGS_FILE. */
  mode: 'none' | 'copy'
  /** `ready`: every package folder already had node_modules; `copied`: copies were made. */
  status: 'ready' | 'copied' | 'missing'
  /** Folders (relative to the repository root, `.` for the root) that hold a package.json. */
  packageDirs: string[]
  /** What the model and the owner need to know; absent when status is `ready`. */
  note?: string
}

export interface JobWorktree { path: string; branch: string; baseCommit: string; dependencies?: WorktreeDependencies }

/** Every commit a checkpoint makes carries this trailer, so reconciliation can find it. */
export const OPERATION_TRAILER = 'Conductor-Job-Operation'

/** Per-project durable-job settings, read from the owner's project folder when a job is created. */
export const WORKTREE_SETTINGS_FILE = '.conductor/durable-jobs.json'

/** Folders a non-git checkpoint neither captures nor prunes: VCS data, dependencies, caches. */
export const SNAPSHOT_SKIPPED_DIRECTORIES = ['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.cache']

const SNAPSHOT_MAX_FILES = 20_000
const SNAPSHOT_MAX_FILE_BYTES = 50 * 1024 * 1024
const SNAPSHOT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

const git = (cwd: string, args: string[], timeoutMs = 120_000): Promise<string> => new Promise((resolvePromise, reject) => {
  execFile('git', args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
    if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim().slice(0, 600)}`))
    else resolvePromise(String(stdout))
  })
})

export async function gitRoot(path: string): Promise<string | null> {
  try { return resolve((await git(path, ['rev-parse', '--show-toplevel'], 20_000)).trim()) } catch { return null }
}

export interface RestoreResult { written: string[]; removed: string[] }

export interface WorktreeOps {
  gitRoot(path: string): Promise<string | null>
  create(projectPath: string, jobId: string, target: string): Promise<JobWorktree>
  /** Commits every change in the job's worktree; undefined when there was nothing to commit. */
  commit(worktreePath: string, message: string, operationId: string): Promise<string | undefined>
  /** The commit carrying this operation id, if one was made (reconciliation). */
  findCommit(worktreePath: string, operationId: string): Promise<string | undefined>
  /**
   * Captures the whole folder at cwd (except SNAPSHOT_SKIPPED_DIRECTORIES) into `directory` and
   * writes manifest.json last. `files` are the files the job reported changing; they get artifact
   * refs, but every file is captured, so one a shell command created is restorable too.
   */
  snapshot(cwd: string, files: string[], directory: string): Promise<DurableJobArtifactRef[]>
  /** A snapshot is complete only once its manifest exists. */
  snapshotComplete(directory: string): boolean
  /**
   * Puts the folder back to a snapshot: rewrites every captured file whose content differs, and
   * with `prune` deletes files the snapshot did not have (skipped folders are left alone).
   */
  restore?(directory: string, cwd?: string, options?: { prune?: boolean }): Promise<RestoreResult>
}

interface ManifestFile { path: string; sha256: string; bytes: number; mtimeMs?: number }
interface Manifest {
  version?: number
  cwd: string
  createdAt?: string
  files: ManifestFile[]
  /** The files the job reported changing when the snapshot was taken. */
  changed?: string[]
  skipped?: { directories: string[]; links: number; large: string[]; truncated: boolean }
}

const toPosix = (path: string) => path.split(sep).join('/')
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
/** Content-addressed store shared by every snapshot of the job, so unchanged files are kept once. */
const objectsRoot = (directory: string) => join(dirname(directory), 'objects')
const objectPath = (directory: string, hash: string) => join(objectsRoot(directory), hash.slice(0, 2), hash)

async function readManifest(directory: string): Promise<Manifest | null> {
  try { return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest } catch { return null }
}

/** The newest complete sibling snapshot, so an unchanged file (same size and mtime) is not re-hashed. */
async function previousManifest(directory: string): Promise<Manifest | null> {
  const parent = dirname(directory)
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  let best: Manifest | null = null
  for (const entry of entries) {
    if (!entry.isDirectory() || resolve(parent, entry.name) === resolve(directory)) continue
    const manifest = await readManifest(join(parent, entry.name))
    if (manifest?.version === 2 && (!best || (manifest.createdAt ?? '') > (best.createdAt ?? ''))) best = manifest
  }
  return best
}

interface WalkResult { files: Array<{ rel: string; bytes: number; mtimeMs: number }>; directories: Set<string>; links: number; large: string[]; truncated: boolean }

/** Every regular file under base, never following a link and never entering `exclude`. */
async function walk(base: string, exclude: string[]): Promise<WalkResult> {
  const result: WalkResult = { files: [], directories: new Set(), links: 0, large: [], truncated: false }
  const skipped = new Set(SNAPSHOT_SKIPPED_DIRECTORIES.map(name => name.toLowerCase()))
  let total = 0
  const pending = ['']
  while (pending.length) {
    const rel = pending.pop()!
    const entries = await readdir(join(base, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name
      const absolute = join(base, childRel)
      if (entry.isSymbolicLink()) { result.links++; continue }
      if (entry.isDirectory()) {
        if (skipped.has(entry.name.toLowerCase())) { result.directories.add(toPosix(childRel)); continue }
        if (exclude.some(path => absolute === path || absolute.startsWith(path + sep))) continue
        pending.push(childRel)
      } else if (entry.isFile()) {
        const info = await stat(absolute).catch(() => null)
        if (!info) continue
        if (info.size > SNAPSHOT_MAX_FILE_BYTES) { result.large.push(toPosix(childRel)); continue }
        if (result.files.length >= SNAPSHOT_MAX_FILES || total + info.size > SNAPSHOT_MAX_TOTAL_BYTES) { result.truncated = true; continue }
        total += info.size
        result.files.push({ rel: childRel, bytes: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  return result
}

async function storeObject(directory: string, hash: string, data: Buffer): Promise<string> {
  const target = objectPath(directory, hash)
  if (existsSync(target)) return target
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, target).catch(async error => {
    await unlink(temporary).catch(() => undefined)
    if (!existsSync(target)) throw error
  })
  return target
}

/** Package folders (repository-relative) at the root and the job's project folder. */
function packageDirsOf(root: string, projectPath: string, worktreePath: string): string[] {
  const project = relative(root, resolve(projectPath))
  const candidates = ['', project && !project.startsWith('..') && !isAbsolute(project) ? project : '']
  return [...new Set(candidates)].filter(dir => existsSync(join(worktreePath, dir, 'package.json')))
}

async function readSettings(root: string): Promise<{ worktreeDependencies?: string }> {
  try { return JSON.parse(await readFile(join(root, WORKTREE_SETTINGS_FILE), 'utf8')) as { worktreeDependencies?: string } } catch { return {} }
}

/** Copies node_modules as real files, skipping every link so nothing in the copy points back out. */
async function copyModules(source: string, target: string): Promise<number> {
  let links = 0
  await cp(source, target, {
    recursive: true, errorOnExist: false, force: true,
    filter: async path => {
      const info = await lstat(path).catch(() => null)
      if (info?.isSymbolicLink()) { links++; return false }
      return true
    }
  })
  return links
}

/**
 * The dependency state of a fresh worktree for a Node project. Never a link: `copy` (opt-in)
 * makes a private copy of the owner's node_modules only when git ignores it there, so no
 * checkpoint commit can pick it up and nothing the job runs can write into the owner's tree.
 */
export async function prepareDependencies(root: string, projectPath: string, worktreePath: string): Promise<WorktreeDependencies | undefined> {
  const packageDirs = packageDirsOf(root, projectPath, worktreePath)
  if (!packageDirs.length) return undefined
  const mode = (await readSettings(root)).worktreeDependencies === 'copy' ? 'copy' : 'none'
  const shown = (dir: string) => dir ? toPosix(dir) : '.'
  const missing = packageDirs.filter(dir => !existsSync(join(worktreePath, dir, 'node_modules')))
  if (!missing.length) return { mode, status: 'ready', packageDirs: packageDirs.map(shown) }
  const notes: string[] = []
  const copied: string[] = []
  let links = 0
  if (mode === 'copy') {
    for (const dir of missing) {
      const source = join(root, dir, 'node_modules')
      if (!existsSync(source)) { notes.push(`The project folder has no node_modules in ${shown(dir)} to copy.`); continue }
      // The trailing slash lets a directory-only pattern (node_modules/) match a folder that does not exist yet.
      const ignored = await git(worktreePath, ['check-ignore', '-q', `${toPosix(join(dir, 'node_modules'))}/`]).then(() => true, () => false)
      if (!ignored) { notes.push(`node_modules in ${shown(dir)} is not ignored by git, so a checkpoint commit would add the copy; it was not copied.`); continue }
      try {
        links += await copyModules(source, join(worktreePath, dir, 'node_modules'))
        copied.push(dir)
      } catch (error) {
        await rm(join(worktreePath, dir, 'node_modules'), { recursive: true, force: true }).catch(() => undefined)
        notes.push(`Copying node_modules into ${shown(dir)} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400))
      }
    }
  }
  const still = missing.filter(dir => !copied.includes(dir))
  if (!still.length) {
    return { mode, status: 'copied', packageDirs: packageDirs.map(shown), note: `node_modules in ${copied.map(shown).join(', ')} is a private copy of the project folder's, made when the job started (${links} link(s) inside it were skipped, not followed). It is the job's own: an install or build here does not touch the project folder.` }
  }
  return {
    mode, status: 'missing', packageDirs: packageDirs.map(shown),
    note: [
      `The job's worktree has no node_modules in ${still.map(shown).join(', ')}: a worktree holds committed files only and dependencies are git-ignored, so npm test and build commands there fail with "module not found" until dependencies are installed.`,
      ...notes,
      `The job does not link the project's node_modules in: an install or build would write through the link into the owner's tree, and electron-builder drops packages reached through a junction.`,
      `To run tests, install in the worktree (npm ci; it needs network and the owner's permission) or opt in to a private copy with ${WORKTREE_SETTINGS_FILE} {"worktreeDependencies":"copy"} in the project and start a new job.`
    ].join(' ')
  }
}

export const gitWorktrees: WorktreeOps & Required<Pick<WorktreeOps, 'restore'>> = {
  gitRoot,

  async create(projectPath, jobId, target) {
    const root = await gitRoot(projectPath)
    if (!root) throw new Error('Not a git repository')
    const baseCommit = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const branch = `conductor-job/${jobId}`
    await mkdir(dirname(target), { recursive: true })
    await git(root, ['worktree', 'add', '-b', branch, target, baseCommit])
    const path = resolve(target)
    const dependencies = await prepareDependencies(root, projectPath, path)
    return { path, branch, baseCommit, ...(dependencies ? { dependencies } : {}) }
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
    // The checkpoints folder may sit inside the job's folder; never snapshot it into itself.
    const walked = await walk(base, [resolve(dirname(directory))])
    const previous = new Map((await previousManifest(directory))?.files.map(file => [file.path, file]) ?? [])
    const manifest: ManifestFile[] = []
    const stored = new Map<string, string>()
    for (const file of walked.files) {
      const path = toPosix(file.rel)
      const before = previous.get(path)
      let hash = before && before.bytes === file.bytes && before.mtimeMs === file.mtimeMs && existsSync(objectPath(directory, before.sha256)) ? before.sha256 : undefined
      if (!hash) {
        const data = await readFile(join(base, file.rel)).catch(() => null)
        if (!data) continue
        hash = sha256(data)
        await storeObject(directory, hash, data)
      }
      manifest.push({ path, sha256: hash, bytes: file.bytes, mtimeMs: file.mtimeMs })
      stored.set(path, hash)
    }
    const changed: string[] = []
    for (const file of [...new Set(files)].slice(0, 2_000)) {
      const rel = relative(base, resolve(base, file))
      // Only files inside the job's folder; a path that escapes it is not the job's.
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      changed.push(toPosix(rel))
    }
    const body: Manifest = {
      version: 2, cwd: base, createdAt: new Date().toISOString(), files: manifest, changed,
      skipped: { directories: [...walked.directories].sort(), links: walked.links, large: walked.large.slice(0, 200), truncated: walked.truncated }
    }
    const temporary = join(directory, 'manifest.json.tmp')
    await writeFile(temporary, JSON.stringify(body, null, 2))
    await rename(temporary, join(directory, 'manifest.json'))
    const refs: DurableJobArtifactRef[] = changed.filter(path => stored.has(path)).map(path => ({ path: objectPath(directory, stored.get(path)!), kind: 'checkpoint', note: path }))
    const extra = [walked.truncated ? 'truncated at the size limit' : '', walked.large.length ? `${walked.large.length} file(s) over 50 MB skipped` : ''].filter(Boolean).join('; ')
    refs.unshift({ path: join(directory, 'manifest.json'), kind: 'checkpoint', note: `${manifest.length} file(s) in the folder, ${changed.length} reported changed${extra ? `; ${extra}` : ''}` })
    return refs
  },

  snapshotComplete: directory => existsSync(join(directory, 'manifest.json')),

  async restore(directory, cwd, options = {}) {
    const manifest = await readManifest(directory)
    if (!manifest) throw new Error(`No complete snapshot at ${directory}`)
    const base = resolve(cwd ?? manifest.cwd)
    const inside = (path: string) => {
      const rel = relative(base, resolve(base, path))
      return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
    }
    // Verify every stored copy before touching the folder, so a damaged snapshot changes nothing.
    const plan: Array<{ rel: string; data: Buffer }> = []
    for (const file of manifest.files) {
      const rel = inside(file.path)
      if (!rel) continue
      const source = manifest.version === 2 ? objectPath(directory, file.sha256) : join(directory, 'files', rel)
      const data = await readFile(source).catch(() => null)
      if (!data || sha256(data) !== file.sha256) throw new Error(`The stored copy of ${file.path} does not match the snapshot manifest; nothing was restored`)
      plan.push({ rel, data })
    }
    const written: string[] = []
    for (const { rel, data } of plan) {
      const target = join(base, rel)
      const current = await readFile(target).catch(() => null)
      if (current && current.equals(data)) continue
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.conductor-restore.tmp`
      await writeFile(temporary, data)
      await rename(temporary, target)
      written.push(toPosix(rel))
    }
    const removed: string[] = []
    if (options.prune && manifest.version === 2) {
      // A truncated snapshot did not capture every file, so pruning could delete one it never had.
      if (manifest.skipped?.truncated) throw new Error('This snapshot was truncated at its size limit; it cannot prune. The captured files were restored.')
      const large = new Set((manifest.skipped?.large ?? []).map(path => path.toLowerCase()))
      const keep = new Set(plan.map(entry => toPosix(entry.rel).toLowerCase()))
      const walked = await walk(base, [resolve(dirname(directory))])
      for (const file of walked.files) {
        const path = toPosix(file.rel)
        if (keep.has(path.toLowerCase()) || large.has(path.toLowerCase())) continue
        await unlink(join(base, file.rel))
        removed.push(path)
      }
    }
    return { written, removed }
  }
}

