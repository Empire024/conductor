import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, relative, resolve } from 'node:path'
import type { SandboxConfig } from './config.ts'
import { runDir, tempDir } from './config.ts'
import { isSecretPath, resolveInWorkspace } from './workspace.ts'

/** The sandbox could not be used. Every tool that needs execution turns this into a refusal;
 *  nothing in this module or its callers ever falls back to a host shell for a model's command.
 *  That is the whole point of the boundary: a stopped or broken Docker sandbox means execution
 *  is unavailable, not that the command runs on Windows instead. The one host run is the task
 *  contract's own acceptance command, in an isolated copy: see `runHostAcceptance`. */
export class SandboxUnavailableError extends Error {}

/** A command the sandbox refuses on policy rather than on capability, with an explanation the
 *  model can act on. */
export class SandboxPolicyError extends Error {}

/** Refused outright: these rebuild a dependency tree, and rebuilding begins by dismantling the
 *  one that is already there. The container has no network, so none of them can finish — `npx`
 *  included, which reifies a tree before it runs anything. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'corepack'])
const ALWAYS_REFUSED = new Set(['npx', 'pnpx', 'bunx'])
const INSTALLING_SUBCOMMANDS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'prune', 'update', 'up',
  'upgrade', 'dedupe', 'ddp', 'rebuild', 'link', 'unlink', 'exec', 'dlx', 'create', 'init', 'import'
])

const GUIDANCE = 'The sandbox has no network, so an install can only destroy the dependency tree it finds. Run the installed binary directly instead, for example `node ./node_modules/typescript/bin/tsc --noEmit` or `./node_modules/.bin/vitest run <file>`.'

/** Split a shell command into the segments that each start a new program, so a package manager
 *  cannot be hidden behind `&&`, a pipe, a subshell or a command substitution. */
export function commandSegments(command: string): string[] {
  return command
    .split(/\$\(|`|\)|\||&&|\|\||;|\n/)
    .map(segment => segment.trim())
    .filter(Boolean)
}

/** The program a segment runs, ignoring leading environment assignments and `sudo`-style
 *  prefixes, reduced to its base name so `/usr/bin/npm` is the same decision as `npm`. */
export function segmentProgram(segment: string): { program: string; args: string[] } {
  const words = segment.split(/\s+/).filter(Boolean)
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ['sudo', 'env', 'command', 'nohup', 'time', 'exec'].includes(words[0]!))) words.shift()
  const raw = words.shift() ?? ''
  const program = raw.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, '')
  return { program, args: words }
}

/** Refuse a sandboxed command that would rewrite the owner's installed dependencies. The
 *  read-only mounts in `containerRunArgs` make this structurally impossible as well; this layer
 *  exists so the model is told what to run instead of watching a command fail obscurely. */
export function assertNoPackageInstall(command: string): void {
  for (const segment of commandSegments(command)) {
    const { program, args } = segmentProgram(segment)
    if (ALWAYS_REFUSED.has(program)) throw new SandboxPolicyError(`Refusing \`${program}\`: it installs a package tree before running anything. ${GUIDANCE}`)
    if (!PACKAGE_MANAGERS.has(program)) continue
    const subcommand = args.find(argument => !argument.startsWith('-'))?.toLowerCase()
    if (subcommand && INSTALLING_SUBCOMMANDS.has(subcommand)) {
      throw new SandboxPolicyError(`Refusing \`${program} ${subcommand}\`: it rewrites the workspace's installed dependencies. ${GUIDANCE}`)
    }
  }
}

export interface SandboxResult {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  cancelled?: boolean
  durationMs: number
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,110}$/
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/
const LINUX_DEPS_VOLUME = /^conductor-linux-deps-[0-9a-f]{16}$/

export const sandboxContainerName = (sessionId: string): string => {
  const name = `conductor-local-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (!NAME.test(name)) throw new SandboxUnavailableError('Invalid sandbox container name')
  return name
}

/** Docker is invoked as a program, never through a shell: the executable is resolved from
 *  CONDUCTOR_DOCKER_PATH or PATH and every argument is passed as its own argv entry, so no
 *  model-produced text is ever parsed by PowerShell or cmd.exe. */
export const dockerExecutable = (): string => process.env.CONDUCTOR_DOCKER_PATH?.trim() || 'docker'

export interface RunOutcome { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; cancelled?: boolean; spawnError?: Error }

/** Extras for a long docker run: cancellation, live output, and keeping the tail of an output
 *  larger than `maxBytes` instead of killing the client over it. */
export interface DockerRunControls { signal?: AbortSignal; onData?: (text: string, stream: 'out' | 'err') => void; keepTail?: boolean }

/** The docker CLI as a function, so the Linux dependency paths can be exercised with a fake. */
export type DockerRun = (args: string[], timeoutMs: number, maxBytes: number, controls?: DockerRunControls) => Promise<RunOutcome>

function runDocker(args: string[], timeoutMs: number, maxBytes: number, controls: DockerRunControls = {}): Promise<RunOutcome> {
  return new Promise(resolvePromise => {
    let stdout = '', stderr = '', bytes = 0, timedOut = false, truncated = false, cancelled = false, settled = false
    const outChunks: Buffer[] = [], errChunks: Buffer[] = []
    const kept = { out: 0, err: 0 }
    const child = spawn(dockerExecutable(), args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const abort = (): void => { cancelled = true; child.kill('SIGKILL') }
    const finish = (outcome: RunOutcome): void => {
      if (settled) return
      settled = true; clearTimeout(timer); controls.signal?.removeEventListener('abort', abort)
      resolvePromise({ ...outcome, cancelled, stdout: Buffer.concat(outChunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8') })
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    if (controls.signal?.aborted) abort()
    else controls.signal?.addEventListener('abort', abort, { once: true })
    const capture = (chunk: Buffer, target: 'out' | 'err'): void => {
      controls.onData?.(chunk.toString('utf8'), target)
      if (controls.keepTail) {
        const chunks = target === 'out' ? outChunks : errChunks
        chunks.push(chunk); kept[target] += chunk.length
        while (kept[target] > maxBytes && chunks.length > 1) { kept[target] -= chunks.shift()!.length; truncated = true }
        return
      }
      const remaining = Math.max(0, maxBytes - bytes)
      bytes += chunk.length
      const captured = chunk.subarray(0, remaining)
      if (captured.length) (target === 'out' ? outChunks : errChunks).push(captured)
      if (bytes > maxBytes) { truncated = true; child.kill('SIGKILL') }
    }
    child.stdout.on('data', chunk => capture(chunk as Buffer, 'out'))
    child.stderr.on('data', chunk => capture(chunk as Buffer, 'err'))
    child.on('error', error => finish({ code: null, stdout, stderr, timedOut, truncated, spawnError: error as Error }))
    child.on('close', code => finish({ code, stdout, stderr, timedOut, truncated }))
  })
}

export interface DockerAvailability { available: boolean; version?: string; reason?: string; kind?: 'cli-missing' | 'engine-stopped' }

export async function dockerAvailable(): Promise<DockerAvailability> {
  const outcome = await runDocker(['version', '--format', '{{.Server.Version}}'], 20_000, 64 * 1024)
  if (outcome.spawnError) return { available: false, kind: 'cli-missing', reason: 'Docker unavailable: the docker CLI was not found. Install Docker Desktop (Linux containers).' }
  if (outcome.code !== 0) return { available: false, kind: 'engine-stopped', reason: 'Docker unavailable: the Docker engine is not responding. Start Docker Desktop.' }
  return { available: true, version: outcome.stdout.trim() }
}

/** Known per-machine installs. Merely finding one does not start it; this list is consulted only
 * when an edit-capable local turn actually attempts its first sandbox command. */
export function dockerDesktopCandidates(environment: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [
    environment.CONDUCTOR_DOCKER_DESKTOP_PATH,
    environment.ProgramFiles ? join(environment.ProgramFiles, 'Docker', 'Docker', 'Docker Desktop.exe') : undefined,
    environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, 'Docker', 'Docker Desktop.exe') : undefined
  ]
  return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate?.trim())).map(candidate => candidate.trim()))]
}

export interface DockerStartupDependencies {
  platform: NodeJS.Platform
  check(): Promise<DockerAvailability>
  exists(path: string): boolean
  launch(path: string): Promise<boolean>
  wait(ms: number): Promise<void>
  candidates(): string[]
}

const defaultDockerStartup: DockerStartupDependencies = {
  platform: process.platform,
  check: dockerAvailable,
  exists: existsSync,
  launch: path => new Promise(resolvePromise => {
    const child = spawn(path, ['--minimized'], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' })
    let settled = false
    const finish = (value: boolean): void => { if (settled) return; settled = true; resolvePromise(value) }
    child.once('error', () => finish(false))
    child.once('spawn', () => { child.unref(); finish(true) })
  }),
  wait: ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
  candidates: dockerDesktopCandidates
}

let dockerDesktopStartup: Promise<DockerAvailability> | undefined

/** Start an installed Docker Desktop once and wait for its engine. Concurrent sandboxes share
 * this promise. Missing software remains an actionable setup refusal; nothing is installed. */
export async function ensureDockerAvailable(options: { timeoutMs?: number; pollMs?: number } = {}, dependencies: DockerStartupDependencies = defaultDockerStartup): Promise<DockerAvailability> {
  const initial = await dependencies.check()
  if (initial.available || initial.kind === 'cli-missing' || dependencies.platform !== 'win32') return initial
  if (!dockerDesktopStartup) {
    dockerDesktopStartup = (async (): Promise<DockerAvailability> => {
      const executable = dependencies.candidates().find(candidate => dependencies.exists(candidate))
      if (!executable) return initial
      if (!await dependencies.launch(executable)) return { available: false, kind: 'engine-stopped', reason: 'Docker unavailable: Docker Desktop is installed but could not be started.' }
      const deadline = Date.now() + (options.timeoutMs ?? 120_000)
      while (Date.now() < deadline) {
        await dependencies.wait(options.pollMs ?? 2_000)
        const state = await dependencies.check()
        if (state.available) return state
      }
      return { available: false, kind: 'engine-stopped', reason: 'Docker Desktop started but its engine did not become ready within 2 minutes.' }
    })().finally(() => { dockerDesktopStartup = undefined })
  }
  return dockerDesktopStartup!
}

export function resetDockerDesktopStartupForTests(): void { dockerDesktopStartup = undefined }

export async function sandboxImageExists(image: string): Promise<boolean> {
  if (!IMAGE.test(image)) throw new SandboxUnavailableError('Invalid sandbox image reference')
  const outcome = await runDocker(['image', 'inspect', image, '--format', '{{.Id}}'], 30_000, 64 * 1024)
  return !outcome.spawnError && outcome.code === 0
}

/** One path the container must not see as it really is, and the mount that replaces it. A mask
 *  with a `source` is bound read-only from that host path; otherwise a directory becomes an
 *  empty tmpfs and a file an empty read-only file. */
export interface SecretMask {
  relative: string
  directory: boolean
  /** Host path whose contents stand in for the masked path. Set only by `trackedMaskPlan`, so a
   *  path git already has in its index keeps the content git expects. */
  source?: string
}

/** Directories the secret scan does not descend. Dependency trees and build output are not where
 *  the owner keeps credentials, they are re-derivable, and they are what made the scan a
 *  multi-hundred-millisecond stall on every command. `.git` is mounted as a unit and masking
 *  inside it would break git itself. Anything named as a secret is still masked at its own level
 *  even when it sits directly inside one of these, because the mask decision happens before the
 *  descent decision. */
export const SCAN_SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'release', 'artifacts',
  'coverage', 'target', 'vendor', '.next', '.nuxt', '.turbo', '.venv', 'venv', '__pycache__'
])

interface SecretScan {
  masks: SecretMask[]
  /** Every directory the walk actually read, with the mtime it had. Revalidating those stats is
   *  how the cache notices a credential file that appeared since the last command. */
  directories: Array<{ path: string; mtimeMs: number }>
}

/** Files inside the workspace that policy hides from local models. Masked in the container and
 *  refused by the host-side file tools, so a secret is not merely absent from one of the two.
 *  The recursive scan is bounded and fails closed if incomplete; silently truncating a scan
 *  would expose the rest of the workspace through the command tool. Asynchronous throughout:
 *  this runs before every sandboxed command and must never block the Electron main process. */
async function scanWorkspace(workspace: string, maxDepth: number, limit: number): Promise<SecretScan> {
  const masks: SecretMask[] = []
  const directories: Array<{ path: string; mtimeMs: number }> = []
  let visited = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) throw new SandboxUnavailableError('Secret scan exceeded its depth budget; command execution refused')
    let entries: import('node:fs').Dirent[]
    let info: import('node:fs').Stats
    try { [entries, info] = await Promise.all([readdir(dir, { withFileTypes: true }), stat(dir)]) }
    catch { throw new SandboxUnavailableError('Secret scan could not inspect a workspace directory; command execution refused') }
    directories.push({ path: dir, mtimeMs: info.mtimeMs })
    const descend: string[] = []
    for (const entry of entries) {
      if (++visited > 200_000) throw new SandboxUnavailableError('Secret scan exceeded its entry budget; command execution refused')
      const full = join(dir, entry.name)
      const rel = relative(workspace, full).replace(/\\/g, '/')
      if (isSecretPath(rel)) {
        if (masks.length >= limit) throw new SandboxUnavailableError('Secret scan exceeded its mask budget; command execution refused')
        masks.push({ relative: rel, directory: entry.isDirectory() }); continue
      }
      if (entry.isDirectory() && !SCAN_SKIP_DIRECTORIES.has(entry.name.toLowerCase())) descend.push(full)
    }
    for (const child of descend) await walk(child, depth + 1)
  }
  await walk(workspace, 0)
  masks.sort((left, right) => left.relative.localeCompare(right.relative))
  return { masks, directories }
}

/** The uncached scan, kept exported so callers and tests can exercise the budgets directly. */
export async function detectSecretPaths(workspace: string, maxDepth = 64, limit = 4096): Promise<SecretMask[]> {
  return (await scanWorkspace(workspace, maxDepth, limit)).masks
}

const scanCache = new Map<string, SecretScan>()
const scanInFlight = new Map<string, Promise<SecretScan>>()

/** True when every directory the last scan read still has the mtime it had. Creating, renaming
 *  or deleting a file changes its directory's mtime, so a credential file that another process
 *  dropped into the workspace invalidates the cache and is masked before the next command. */
async function scanStillValid(scan: SecretScan): Promise<boolean> {
  const checks = await Promise.all(scan.directories.map(async entry => {
    try { return (await stat(entry.path)).mtimeMs === entry.mtimeMs } catch { return false }
  }))
  return checks.every(Boolean)
}

/** The masks for a workspace, reusing the previous scan while the tree it walked is unchanged.
 *  Revalidation is a few hundred parallel `stat` calls rather than a full-tree walk, and none of
 *  it is synchronous, so `run_command` no longer freezes the main process before every command. */
export async function secretPathsFor(workspace: string): Promise<SecretMask[]> {
  const key = resolve(workspace)
  const cached = scanCache.get(key)
  if (cached && await scanStillValid(cached)) return cached.masks
  let pending = scanInFlight.get(key)
  if (!pending) {
    pending = scanWorkspace(key, 64, 4096)
      .then(scan => { scanCache.set(key, scan); return scan })
      .finally(() => { scanInFlight.delete(key) })
    scanInFlight.set(key, pending)
  }
  return (await pending).masks
}

/** Drop the cache. Tests use it; nothing in the running app needs it, because the mtime check
 *  already notices every change the cache could be stale about. */
export function clearSecretScanCache(): void { scanCache.clear(); scanInFlight.clear(); indexCache.clear() }

interface GitProcess { code: number | null; stdout: Buffer; stderr: string; spawnError?: Error }

/** Host `git`, run as a program with an explicit argv, only ever to read the index of the very
 *  workspace that is about to be mounted. */
function runGit(workspace: string, args: string[], maxBytes: number): Promise<GitProcess> {
  return new Promise(resolvePromise => {
    const chunks: Buffer[] = []
    let stderr = '', bytes = 0, settled = false, overflowed = false
    const child = spawn('git', args, { cwd: workspace, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (outcome: GitProcess): void => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(outcome) }
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.on('data', chunk => {
      bytes += (chunk as Buffer).length
      if (bytes > maxBytes) { overflowed = true; child.kill('SIGKILL'); return }
      chunks.push(chunk as Buffer)
    })
    child.stderr.on('data', chunk => { stderr += (chunk as Buffer).toString('utf8').slice(0, 4096) })
    child.on('error', error => finish({ code: null, stdout: Buffer.concat(chunks), stderr, spawnError: error as Error }))
    child.on('close', code => finish({ code: overflowed ? null : code, stdout: Buffer.concat(chunks), stderr }))
  })
}

/** One tracked path: the blob git has in its index, and where the replica of it lives. */
export interface TrackedMaskWrite { source: string; oid: string }

/** A tracked blob larger than this refuses the command rather than being staged. */
const MAX_TRACKED_MASK_BYTES = 8 * 1024 * 1024

const stagedRoot = (stageRoot: string, key: string): string =>
  join(stageRoot, createHash('sha256').update(key).digest('hex').slice(0, 32))

interface TrackedIndex { entries: Map<string, { mode: string; oid: string }>; mtimeMs: number }
const indexCache = new Map<string, TrackedIndex>()

/** Every path in the workspace's git index, with the blob each one is staged at. Re-read only
 *  when `.git/index` changes, because this runs before every command of a granted conversation
 *  and a large repository's `ls-files` is not free. */
async function trackedIndex(workspace: string): Promise<Map<string, { mode: string; oid: string }>> {
  const key = resolve(workspace)
  const mtimeMs = await stat(join(workspace, '.git', 'index')).then(info => info.mtimeMs, () => Number.NaN)
  const cached = indexCache.get(key)
  if (cached && Number.isFinite(mtimeMs) && cached.mtimeMs === mtimeMs) return cached.entries
  const listed = await runGit(workspace, ['ls-files', '--stage', '-z'], 64 * 1024 * 1024)
  if (listed.spawnError || listed.code !== 0) {
    throw new SandboxUnavailableError('Repository writes were granted but the workspace index could not be read, so a masked path could be committed as a deletion; command execution refused')
  }
  const entries = new Map<string, { mode: string; oid: string }>()
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) \d+\t([\s\S]+)$/.exec(record)
    if (match) entries.set(match[3]!.replace(/\\/g, '/'), { mode: match[1]!, oid: match[2]! })
  }
  if (Number.isFinite(mtimeMs)) indexCache.set(key, { entries, mtimeMs })
  return entries
}

/** Masking is what keeps a credential out of the container; it is also, with repository writes
 *  granted, what would let the model commit the deletion of every masked path that git tracks.
 *  An empty file over a tracked file is a truncation and an empty tmpfs over a tracked directory
 *  is a deletion of everything in it, and one `git commit -a` records both into the owner's real
 *  history on the owner's real working tree.
 *
 *  So when the grant is on, a mask that overlaps the index is replaced by a read-only replica of
 *  exactly what git already has staged for it. Git then sees no change at all: no deletion, no
 *  truncation, nothing to commit, and the replica is read-only so the model cannot create one
 *  either. Nothing is disclosed that the container could not already read, because `.git` is
 *  mounted in both modes and `git cat-file` serves the same blob; the worktree copy, which may
 *  hold uncommitted secret edits, stays hidden. Untracked masked paths keep the empty mask, and
 *  an untracked file inside a tracked masked directory is simply absent from the replica, so the
 *  directory stays opaque. */
export async function trackedMaskPlan(workspace: string, masks: SecretMask[], stageRoot: string): Promise<{ masks: SecretMask[]; writes: TrackedMaskWrite[] }> {
  if (!masks.length || !existsSync(join(workspace, '.git'))) return { masks, writes: [] }
  const tracked = await trackedIndex(workspace)
  if (!tracked.size) return { masks, writes: [] }
  const writes: TrackedMaskWrite[] = []
  const planned = masks.map(mask => {
    const prefix = mask.relative.replace(/\/+$/, '') + '/'
    const overlap = [...tracked.entries()].filter(([path]) => mask.directory ? path.startsWith(prefix) : path === mask.relative)
    if (!overlap.length) return mask
    for (const [path, entry] of overlap) {
      // A symlink or a submodule cannot be reproduced as a plain file, and writing one as a
      // regular file would itself be a change git would record. Refuse the grant instead.
      if (entry.mode !== '100644' && entry.mode !== '100755') {
        throw new SandboxUnavailableError(`Repository writes cannot be granted safely: the withheld path ${path} is tracked as a symlink or submodule. Withdraw the repository-writes grant for this conversation.`)
      }
    }
    const root = stagedRoot(stageRoot, JSON.stringify([mask.relative, overlap.map(([path, entry]) => [path, entry.oid])]))
    for (const [path, entry] of overlap) {
      writes.push({ source: mask.directory ? join(root, path.slice(prefix.length)) : join(root, 'blob'), oid: entry.oid })
    }
    return { ...mask, source: mask.directory ? root : join(root, 'blob') }
  })
  return { masks: planned, writes }
}

/** Write the staged replicas. Content-addressed by the index blobs, so an unchanged index reuses
 *  the files it wrote last time and a changed one produces different paths — which changes the
 *  mount signature and therefore recreates the container. */
export async function materializeMaskSources(workspace: string, writes: TrackedMaskWrite[]): Promise<void> {
  for (const write of writes) {
    if (existsSync(write.source)) continue
    const blob = await runGit(workspace, ['cat-file', 'blob', write.oid], MAX_TRACKED_MASK_BYTES)
    if (blob.spawnError || blob.code !== 0) {
      throw new SandboxUnavailableError('Repository writes were granted but a tracked withheld file could not be read from the index; command execution refused')
    }
    await mkdir(dirname(write.source), { recursive: true })
    await writeFile(write.source, blob.stdout)
  }
}

const dockerPath = (value: string): string => resolve(value).replace(/\\/g, '/')

/** Paths a sandboxed command may read but must never rewrite: the owner's installed dependency
 *  tree and the lockfile that describes it. */
export const DEPENDENCY_PATHS = ['node_modules', 'package-lock.json'] as const
/** Writable scratch inside the read-only tree, so a build that caches next to its dependencies
 *  still runs. */
export const DEPENDENCY_CACHES = ['node_modules/.cache', 'node_modules/.vite'] as const

/** The argv for the runtime container. Locked down deliberately and verifiably: no network, a
 *  non-root user, all capabilities dropped, no new privileges, default seccomp, a read-only
 *  root filesystem with tmpfs for the few writable areas, and hard memory/CPU/PID limits. The
 *  only host path bound in is the workspace itself; .git is re-bound read-only over it and every
 *  detected secret is masked. No Docker socket, no named pipe, no host profile, no devices. */
export function containerRunArgs(options: {
  name: string
  image: string
  workspace: string
  sandbox: SandboxConfig
  masks: SecretMask[]
  emptyFile: string
  /** Off unless the owner grants it in the conversation: see the .git mount below. */
  analysis?: boolean
  analysisScratch?: string
  gitWritable?: boolean
  /** The host repository's own `core.autocrlf`, mirrored into a granted container: see below. */
  gitAutocrlf?: string
  /** A prepared Linux dependency volume (`prepareLinuxDependencies`) that stands in for the
   *  host's Windows node_modules. */
  linuxDeps?: string
}): string[] {
  if (!NAME.test(options.name)) throw new SandboxUnavailableError('Invalid sandbox container name')
  if (!IMAGE.test(options.image)) throw new SandboxUnavailableError('Invalid sandbox image reference')
  if (options.linuxDeps !== undefined && !LINUX_DEPS_VOLUME.test(options.linuxDeps)) throw new SandboxUnavailableError('Invalid Linux dependency volume name')
  // Only over a node_modules the host already has: the mountpoint then exists in the bind, and
  // Docker never creates an empty node_modules in the owner's checkout on the container's behalf.
  const linuxDeps = options.linuxDeps && existsSync(join(options.workspace, 'node_modules')) ? options.linuxDeps : undefined
  const workspace = dockerPath(options.workspace)
  if (/[,=]/.test(workspace)) throw new SandboxUnavailableError('Workspace path contains a character Docker mount syntax cannot carry')
  // Only a specific workspace directory ever crosses the boundary. A drive root or the Windows
  // user profile would hand the container a whole volume or the owner's credential stores.
  const absolute = resolve(options.workspace)
  if (absolute === parse(absolute).root) throw new SandboxUnavailableError('Refusing to mount a drive root into the sandbox')
  const profile = process.env.USERPROFILE
  if (profile && absolute.toLowerCase() === resolve(profile).toLowerCase()) throw new SandboxUnavailableError('Refusing to mount the Windows user profile into the sandbox')
  const args = [
    'run', '--detach', '--name', options.name,
    '--network', 'none',
    '--user', '10001:10001',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--init',
    '--pids-limit', String(options.sandbox.pids),
    '--memory', options.sandbox.memory,
    '--memory-swap', options.sandbox.memory,
    '--cpus', options.sandbox.cpus,
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${options.sandbox.tmpfsSizeMb}m`,
    '--tmpfs', `/home/agent:rw,nosuid,nodev,size=${Math.min(options.sandbox.tmpfsSizeMb, 128)}m`,
    '--label', 'conductor.local-sandbox=1',
    '--workdir', '/workspace',
    '--mount', `type=bind,source=${workspace},target=/workspace${options.analysis ? ",readonly" : ""}`,
    ...(options.analysis && options.analysisScratch ? ['--mount', `type=bind,source=${workspace}/${options.analysisScratch},target=/workspace/${options.analysisScratch}`] : []),
    // Repository metadata stays readable for status and diffs but can never be rewritten, so a
    // sandboxed turn cannot install a git hook or change remotes in the owner's repository.
    // The owner can grant write access per conversation; the container still has no network, so
    // the grant reaches local history only. A push under that grant is brokered on the host
    // instead, under the checks in git-push.ts — nothing in here ever reaches a remote.
    ...((options.analysis || !options.gitWritable) && existsSync(join(options.workspace, '.git')) ? ['--mount', `type=bind,source=${workspace}/.git,target=/workspace/.git,readonly`] : []),
    // An installed dependency tree is an input to a sandboxed command and never its output. The
    // container has no network, so it can never repair an install — but npm and npx tear a tree
    // down *before* they discover that, and a plain `npx tsc` in this repo removed the owner's
    // node_modules and package-lock.json mid-run. Read-only is the only state in which those two
    // paths are safe to expose at all.
    // With a prepared Linux tree, that volume replaces the host's Windows binaries, read-only too.
    ...DEPENDENCY_PATHS.flatMap(relative => !existsSync(join(options.workspace, relative)) ? []
      : relative === 'node_modules' && linuxDeps ? ['--mount', `type=volume,source=${linuxDeps},target=/workspace/node_modules,readonly,volume-nocopy`]
        : ['--mount', `type=bind,source=${workspace}/${relative},target=/workspace/${relative},readonly`]),
    // Build tools cache inside the tree they read. These stay writable so a sandboxed build still
    // works, without the rest of node_modules being writable with it. Only a cache directory that
    // already exists is mounted: the mountpoint would have to be created inside the read-only
    // node_modules bind, which Docker cannot do, and the whole container then fails to start.
    // The Linux volume is built with both directories, so there they are always mounted.
    ...DEPENDENCY_CACHES.flatMap(relative => linuxDeps || existsSync(join(options.workspace, relative))
      ? ['--tmpfs', `/workspace/${relative}:rw,nosuid,nodev,size=256m`]
      : [])
  ]
  for (const mask of options.masks) {
    if (/[,=\r\n]/.test(mask.relative)) throw new SandboxUnavailableError('A secret path cannot be represented safely as a Docker mask')
    // A mask with a replica stands in for a path git already tracks: read-only, and holding
    // exactly the bytes in the index, so no sandboxed git command can record its deletion or
    // truncation. See `trackedMaskPlan`.
    if (mask.source) {
      const source = dockerPath(mask.source)
      if (/[,=\r\n]/.test(source)) throw new SandboxUnavailableError('A mask replica path cannot be represented safely as a Docker mount')
      args.push('--mount', `type=bind,source=${source},target=/workspace/${mask.relative},readonly`)
    } else if (mask.directory) args.push('--tmpfs', `/workspace/${mask.relative}:rw,nosuid,nodev,size=1m`)
    else args.push('--mount', `type=bind,source=${dockerPath(options.emptyFile)},target=/workspace/${mask.relative},readonly`)
  }
  // A deliberately minimal environment. Nothing from the host is inherited, so no API key,
  // cloud credential or token can be read out of the sandbox even if the model asks for it.
  for (const variable of ['HOME=/home/agent', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', 'TERM=dumb', 'TMPDIR=/tmp', 'XDG_CACHE_HOME=/tmp/cache', 'NPM_CONFIG_CACHE=/tmp/npm', 'NPM_CONFIG_OFFLINE=1', 'NPM_CONFIG_AUDIT=false', 'NPM_CONFIG_FUND=false', 'PIP_CACHE_DIR=/tmp/pip', 'CONDUCTOR_SANDBOX=1']) args.push('--env', variable)
  // A commit needs an identity, and the read-only root filesystem has nowhere to configure one.
  // Naming the local model in the commit itself keeps its history distinguishable from the owner's.
  if (options.gitWritable) for (const variable of ['GIT_AUTHOR_NAME=Conductor local model', 'GIT_AUTHOR_EMAIL=local-model@conductor.invalid', 'GIT_COMMITTER_NAME=Conductor local model', 'GIT_COMMITTER_EMAIL=local-model@conductor.invalid']) args.push('--env', variable)
  // The container is Linux and the workspace is a Windows checkout, so git in here sees a
  // CRLF working tree with none of the host's translation configured: a `git add -A` would
  // rewrite every untouched file in the repository as a line-ending change. Mirroring the
  // host's own setting keeps a sandboxed commit recording the same bytes the host would.
  if (options.gitWritable && options.gitAutocrlf) for (const variable of ['GIT_CONFIG_COUNT=1', 'GIT_CONFIG_KEY_0=core.autocrlf', `GIT_CONFIG_VALUE_0=${options.gitAutocrlf}`]) args.push('--env', variable)
  args.push(options.image, 'sleep', 'infinity')
  return args
}

/** Argv for one command. The model's text is a single argument handed to bash *inside* the
 *  container; it is never concatenated into a host command line. `timeout` enforces the limit
 *  in-container so a runaway process dies with it rather than outliving the docker exec. */
export function execArgs(container: string, command: string, timeoutSec: number): string[] {
  if (!NAME.test(container)) throw new SandboxUnavailableError('Invalid sandbox container name')
  if (typeof command !== 'string' || !command.trim()) throw new SandboxUnavailableError('A command is required')
  if (command.includes('\0')) throw new SandboxUnavailableError('Command contains a NUL byte')
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new SandboxUnavailableError('Invalid command timeout')
  return ['exec', '--user', '10001:10001', '--workdir', '/workspace', container, 'timeout', '--kill-after=5', String(timeoutSec), 'bash', '-lc', command]
}

/** One spelling for a host path that Docker may report as `C:\dir`, `C:/dir`, `/host_mnt/c/dir`
 *  or `/run/desktop/mnt/host/c/dir` depending on the engine. */
const hostPathKey = (value: string): string => value
  .toLowerCase().replace(/\\/g, '/')
  .replace(/^\/(host_mnt|run\/desktop\/mnt\/host)/, '')
  .replace(/^([a-z]):/, '/$1')
  .replace(/\/+$/, '')

/** The label a container carries so a later session can tell what mounts it was built from. */
export const MOUNT_LABEL = 'conductor.mount-signature'

export const mountDigest = (signature: string): string => createHash('sha256').update(signature).digest('hex')

/** Whether an already-running container may be adopted for this workspace. `docker inspect`
 *  reports the mount signature it was labelled with and the binds it really has; both must agree
 *  with what this session would create now, or the container is destroyed and rebuilt. Mounts
 *  cannot be changed on a running container, so adopting a mismatched one would run a command
 *  against a withdrawn grant or an unmasked secret. */
export function adoptableContainer(inspected: string, digest: string, workspace: string): boolean {
  const [, label, mounts] = inspected.trim().split('\t')
  if (label !== digest) return false
  let bound: Array<{ Type?: string; Source?: string; Destination?: string }>
  try { bound = JSON.parse(mounts ?? 'null') as Array<{ Type?: string; Source?: string; Destination?: string }> } catch { return false }
  if (!Array.isArray(bound)) return false
  const root = bound.filter(mount => mount.Destination === '/workspace')
  return root.length === 1 && hostPathKey(root[0]!.Source ?? '') === hostPathKey(dockerPath(workspace))
}

/** What the host would do with line endings in this repository, as the container should do it:
 *  a host that translates on checkout (`true`) stores LF, which is `input` for a Linux container
 *  that already has LF files on disk; anything else records the bytes as they are. */
export async function hostAutocrlf(workspace: string): Promise<string> {
  const configured = await runGit(workspace, ['config', '--get', 'core.autocrlf'], 4096)
  const value = configured.code === 0 ? configured.stdout.toString('utf8').trim().toLowerCase() : ''
  return value === 'true' || value === 'input' ? 'input' : 'false'
}

/** The Linux dependency tree is keyed on the lockfile alone: the same lock always names the same
 *  volume, and a changed lock is simply a volume nobody has prepared yet. */
const lockKeyCache = new Map<string, { mtimeMs: number; size: number; key: string }>()

export async function linuxDepsKey(workspace: string): Promise<string | null> {
  const path = join(resolve(workspace), 'package-lock.json')
  let info: import('node:fs').Stats
  try { info = await stat(path) } catch { return null }
  if (!info.isFile()) return null
  const cached = lockKeyCache.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.key
  let bytes: Buffer
  try { bytes = await readFile(path) } catch { return null }
  const key = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  lockKeyCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, key })
  return key
}

export const linuxDepsVolume = (key: string): string => {
  const volume = `conductor-linux-deps-${key}`
  if (!LINUX_DEPS_VOLUME.test(volume)) throw new SandboxUnavailableError('Invalid Linux dependency key')
  return volume
}

/** Written on the host only after a prepare finished, so a half-built volume never counts. */
export interface LinuxDepsMarker { key: string; volume: string; preparedAt: string; scripts: 'ran' | 'skipped'; image: string }
export interface LinuxDepsStatus { state: 'ready' | 'missing' | 'no-lockfile'; key?: string; volume?: string; preparedAt?: string }

export interface LinuxDepsDependencies {
  docker: DockerRun
  /** Directory of the host-side readiness markers. */
  markerRoot(): string
  ensureDocker(): Promise<DockerAvailability>
}

const defaultLinuxDeps: LinuxDepsDependencies = {
  docker: runDocker,
  markerRoot: () => join(runDir(), 'linux-deps'),
  ensureDocker: () => ensureDockerAvailable()
}

/** Volumes `docker volume inspect` confirmed recently, so a command does not pay a docker round
 *  trip before every run. A volume removed by hand is noticed within the minute. */
const confirmedVolumes = new Map<string, number>()
const VOLUME_CONFIRM_TTL_MS = 60_000

export function resetLinuxDepsCacheForTests(): void { confirmedVolumes.clear(); lockKeyCache.clear() }

async function readLinuxDepsMarker(root: string, key: string): Promise<LinuxDepsMarker | null> {
  try {
    const marker = JSON.parse(await readFile(join(root, `${key}.json`), 'utf8')) as Partial<LinuxDepsMarker> | null
    return marker && marker.key === key && typeof marker.preparedAt === 'string' ? marker as LinuxDepsMarker : null
  } catch { return null }
}

/** Ready only when the host marker exists for this lockfile and this image *and* Docker still has
 *  the volume. Either one alone is an interrupted prepare or a volume removed by hand. */
export async function linuxDepsStatus(workspace: string, sandbox: SandboxConfig, deps: Partial<LinuxDepsDependencies> = {}): Promise<LinuxDepsStatus> {
  const { docker, markerRoot } = { ...defaultLinuxDeps, ...deps }
  const key = await linuxDepsKey(workspace)
  if (!key) return { state: 'no-lockfile' }
  const volume = linuxDepsVolume(key)
  const marker = await readLinuxDepsMarker(markerRoot(), key)
  if (!marker || marker.volume !== volume || marker.image !== sandbox.image) return { state: 'missing', key, volume }
  const confirmed = confirmedVolumes.get(volume)
  if (confirmed === undefined || Date.now() - confirmed > VOLUME_CONFIRM_TTL_MS) {
    const inspected = await docker(['volume', 'inspect', '--format', '{{.Name}}', volume], 20_000, 16 * 1024)
    if (inspected.spawnError || inspected.code !== 0) { confirmedVolumes.delete(volume); return { state: 'missing', key, volume } }
    confirmedVolumes.set(volume, Date.now())
  }
  return { state: 'ready', key, volume, preparedAt: marker.preparedAt }
}

const PREPARE_TIMEOUT_MS = 20 * 60_000

/** Runs as root in the throwaway install container. The build happens in the container's own
 *  filesystem (not a size-limited tmpfs); only the finished tree is copied into the volume. Install
 *  scripts are tried first and skipped only if they fail, and which one happened is reported back.
 *  The tree is world-readable, and only the two build caches belong to the sandbox user. */
const PREPARE_SCRIPT = [
  'set -eu',
  'export ELECTRON_SKIP_BINARY_DOWNLOAD=1',
  'rm -rf /tmp/linux-deps && mkdir -p /tmp/linux-deps && cd /tmp/linux-deps',
  'cp /src/package.json /src/package-lock.json .',
  'if npm ci --no-audit --no-fund; then echo ran > /tmp/linux-deps.scripts',
  "else echo 'npm ci with install scripts failed; retrying with --ignore-scripts' >&2; npm ci --ignore-scripts --no-audit --no-fund; echo skipped > /tmp/linux-deps.scripts; fi",
  'find /out -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
  'cp -a node_modules/. /out/',
  'mkdir -p /out/.cache /out/.vite',
  'chmod -R a+rX /out',
  'chown -R 10001:10001 /out/.cache /out/.vite',
  'echo "CONDUCTOR_LINUX_DEPS_SCRIPTS=$(cat /tmp/linux-deps.scripts)"'
].join('\n')

/** Argv for the install container. Unlike the runtime container it has the default network and
 *  runs as root, so it sees nothing of the workspace but the two package files, read-only. */
export function linuxDepsPrepareArgs(options: { name: string; workspace: string; sandbox: SandboxConfig; key: string }): string[] {
  if (!NAME.test(options.name)) throw new SandboxUnavailableError('Invalid install container name')
  if (!IMAGE.test(options.sandbox.image)) throw new SandboxUnavailableError('Invalid sandbox image reference')
  const volume = linuxDepsVolume(options.key)
  const workspace = dockerPath(options.workspace)
  if (/[,=\r\n]/.test(workspace)) throw new SandboxUnavailableError('Workspace path contains a character Docker mount syntax cannot carry')
  return [
    'run', '--rm', '--name', options.name,
    '--label', `conductor.linux-deps=${options.key}`,
    '--user', '0:0',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(Math.max(options.sandbox.pids, 1024)),
    '--memory', options.sandbox.memory,
    '--memory-swap', options.sandbox.memory,
    '--cpus', options.sandbox.cpus,
    '--workdir', '/tmp',
    '--mount', `type=bind,source=${workspace}/package.json,target=/src/package.json,readonly`,
    '--mount', `type=bind,source=${workspace}/package-lock.json,target=/src/package-lock.json,readonly`,
    '--mount', `type=volume,source=${volume},target=/out`,
    ...['HOME=/root', 'NPM_CONFIG_CACHE=/tmp/npm-cache', 'NPM_CONFIG_OFFLINE=false', 'NPM_CONFIG_UPDATE_NOTIFIER=false', 'CI=1'].flatMap(variable => ['--env', variable]),
    options.sandbox.image, 'bash', '-c', PREPARE_SCRIPT
  ]
}

/** Whole lines from a stream of chunks, per stream, so interleaved stdout/stderr stay readable. */
function progressLines(onProgress?: (line: string) => void): { push(text: string, stream?: 'out' | 'err'): void; flush(): void } {
  const pending = { out: '', err: '' }
  const emit = (line: string): void => { if (line.trim()) onProgress?.(line) }
  return {
    push(text, stream = 'out') {
      if (!onProgress) return
      const parts = (pending[stream] + text).split(/\r?\n|\r/)
      pending[stream] = parts.pop() ?? ''
      parts.forEach(emit)
    },
    flush() { emit(pending.out); emit(pending.err); pending.out = pending.err = '' }
  }
}

const preparing = new Map<string, Promise<{ volume: string; key: string; scripts: 'ran' | 'skipped' }>>()

/** Build a Linux node_modules for this workspace's lockfile into a named Docker volume, so the
 *  sandbox can run vitest, tsc and builds whose host tree carries Windows-only native binaries.
 *
 *  THIS IS THE ONLY SANDBOX PATH THAT USES THE NETWORK. Call it only from an explicit owner
 *  action — a button the owner pressed for this workspace. Never from a model turn, a tool, a
 *  schedule, an acceptance run or an automatic retry: the install container reaches the npm
 *  registry and runs the lockfile's install scripts as root. It never sees the workspace, only
 *  package.json and package-lock.json read-only, and never touches the owner's own node_modules.
 *
 *  On failure it throws `SandboxUnavailableError` with the tail of the install output and leaves
 *  the volume as it is; without a marker it does not count as ready. */
export async function prepareLinuxDependencies(workspace: string, sandbox: SandboxConfig, options: { signal?: AbortSignal; onProgress?(line: string): void } = {}, deps: Partial<LinuxDepsDependencies> = {}): Promise<{ volume: string; key: string; scripts: 'ran' | 'skipped' }> {
  const key = await linuxDepsKey(workspace)
  if (!key) throw new SandboxUnavailableError('This workspace has no package-lock.json, so there is no Linux dependency tree to prepare')
  if (!existsSync(join(workspace, 'package.json'))) throw new SandboxUnavailableError('This workspace has no package.json beside its package-lock.json')
  const volume = linuxDepsVolume(key)
  const running = preparing.get(volume)
  if (running) return running
  const job = prepareVolume(workspace, sandbox, key, volume, options, { ...defaultLinuxDeps, ...deps }).finally(() => { preparing.delete(volume) })
  preparing.set(volume, job)
  return job
}

async function prepareVolume(workspace: string, sandbox: SandboxConfig, key: string, volume: string, options: { signal?: AbortSignal; onProgress?(line: string): void }, deps: LinuxDepsDependencies): Promise<{ volume: string; key: string; scripts: 'ran' | 'skipped' }> {
  options.signal?.throwIfAborted()
  const docker = await deps.ensureDocker()
  if (!docker.available) throw new SandboxUnavailableError(docker.reason ?? 'Docker unavailable')
  const root = deps.markerRoot()
  const markerPath = join(root, `${key}.json`)
  // A rebuild clears the volume first, so its old marker stops vouching for it right away.
  await rm(markerPath, { force: true })
  confirmedVolumes.delete(volume)
  const created = await deps.docker(['volume', 'create', '--label', `conductor.linux-deps=${key}`, volume], 60_000, 16 * 1024)
  if (created.spawnError || created.code !== 0) throw new SandboxUnavailableError(`Could not create the Linux dependency volume: ${(created.stderr || created.stdout).trim().slice(0, 400) || 'docker volume create failed'}`)
  const name = `conductor-linux-deps-prep-${key}`
  await deps.docker(['rm', '--force', name], 30_000, 16 * 1024)
  const lines = progressLines(options.onProgress)
  const run = await deps.docker(linuxDepsPrepareArgs({ name, workspace, sandbox, key }), PREPARE_TIMEOUT_MS, 256 * 1024, { signal: options.signal, keepTail: true, onData: (text, stream) => lines.push(text, stream) })
  lines.flush()
  // Killing the docker client leaves the install container running; `--rm` only fires on exit.
  if (run.cancelled || run.timedOut) await deps.docker(['rm', '--force', name], 60_000, 16 * 1024)
  if (run.cancelled || options.signal?.aborted) throw new SandboxUnavailableError('Linux dependency install cancelled')
  const output = `${run.stderr}\n${run.stdout}`.trim()
  if (run.spawnError || run.timedOut || run.code !== 0) throw new SandboxUnavailableError(`Linux dependency install ${run.timedOut ? 'timed out after 20 minutes' : 'failed'}: ${output.slice(-2000) || 'docker run failed'}`)
  const scripts = /CONDUCTOR_LINUX_DEPS_SCRIPTS=(ran|skipped)/.exec(run.stdout)?.[1] as 'ran' | 'skipped' | undefined
  if (!scripts) throw new SandboxUnavailableError(`Linux dependency install finished without its completion line: ${output.slice(-2000)}`)
  // The lockfile was bound live; a tree built from a lock that changed meanwhile is not this key's.
  if (await linuxDepsKey(workspace) !== key) throw new SandboxUnavailableError('package-lock.json changed while the Linux dependencies were being prepared; prepare them again')
  await mkdir(root, { recursive: true })
  const marker: LinuxDepsMarker = { key, volume, preparedAt: new Date().toISOString(), scripts, image: sandbox.image }
  await writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf8')
  confirmedVolumes.set(volume, Date.now())
  return { volume, key, scripts }
}

/** Ceilings for the host acceptance copy and its output. */
const MAX_ACCEPTANCE_COPY_BYTES = 500 * 1024 * 1024
const ACCEPTANCE_OUTPUT_BYTES = 8 * 1024 * 1024
/** Stripped from the host run's environment: the code under test is the local model's. */
const CREDENTIAL_VARIABLE = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE|AUTH/i

type AcceptanceFs = Pick<typeof import('node:fs/promises'), 'mkdir' | 'mkdtemp' | 'copyFile' | 'lstat' | 'symlink' | 'unlink' | 'rm'>

export interface HostAcceptanceDependencies {
  platform: NodeJS.Platform
  spawn: typeof spawn
  /** Workspace-relative paths to copy; by default `git ls-files -z -co --exclude-standard`. */
  listFiles(workspace: string): Promise<string[]>
  tempRoot(): string
  fs: AcceptanceFs
  maxCopyBytes: number
  killGraceMs: number
}

async function gitListFiles(workspace: string): Promise<string[]> {
  const listed = await runGit(workspace, ['ls-files', '-z', '-co', '--exclude-standard'], 64 * 1024 * 1024)
  if (listed.spawnError || listed.code !== 0) throw new SandboxUnavailableError('The acceptance copy lists the workspace with git, and git could not list it')
  return listed.stdout.toString('utf8').split('\0').filter(Boolean)
}

const defaultHostAcceptance: HostAcceptanceDependencies = {
  platform: process.platform,
  spawn,
  listFiles: gitListFiles,
  tempRoot: () => { try { return join(tempDir(), 'acceptance') } catch { return join(tmpdir(), 'conductor-acceptance') } },
  fs: { mkdir, mkdtemp, copyFile, lstat, symlink, unlink, rm },
  maxCopyBytes: MAX_ACCEPTANCE_COPY_BYTES,
  killGraceMs: 10_000
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await work(items[next++]!) }))
}

export interface HostAcceptanceCopy { root: string; junction?: string; files: number; bytes: number; cleanup(): Promise<void> }

/** A throwaway copy of the workspace's own files, with a junction to the host node_modules. No
 *  .git, no dependency trees, nothing the secret policy withholds, and a hard size budget. */
export async function hostAcceptanceCopy(workspace: string, deps: Partial<HostAcceptanceDependencies> = {}): Promise<HostAcceptanceCopy> {
  const d = { ...defaultHostAcceptance, ...deps }
  const listed = [...new Set(await d.listFiles(workspace))]
  const base = d.tempRoot()
  await d.fs.mkdir(base, { recursive: true })
  const root = await d.fs.mkdtemp(join(base, 'acceptance-'))
  let junction: string | undefined
  const cleanup = async (): Promise<void> => {
    if (junction) {
      // The link alone, never a recursive delete through it: its target is the owner's real tree.
      await d.fs.unlink(junction).catch(() => undefined)
      if (await d.fs.lstat(junction).then(() => true, () => false)) throw new SandboxUnavailableError(`The acceptance copy's node_modules junction could not be removed, so ${root} was left in place rather than deleted through it`)
      junction = undefined
    }
    await d.fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
  try {
    const wanted: Array<{ parts: string[]; size: number }> = []
    await eachLimited(listed, 16, async raw => {
      const rel = raw.replace(/\\/g, '/')
      const parts = rel.split('/')
      if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || parts.some(part => !part || part === '.' || part === '..')) return
      if (parts[0] === '.git' || parts.some(part => part.toLowerCase() === 'node_modules') || isSecretPath(rel)) return
      const info = await d.fs.lstat(join(workspace, ...parts)).catch(() => undefined)
      if (info?.isFile()) wanted.push({ parts, size: info.size })
    })
    const bytes = wanted.reduce((sum, file) => sum + file.size, 0)
    if (bytes > d.maxCopyBytes) throw new SandboxUnavailableError(`The acceptance copy would be ${Math.ceil(bytes / 1048576)} MB, over its ${Math.floor(d.maxCopyBytes / 1048576)} MB limit; prepare the Linux dependencies so acceptance runs in the sandbox instead`)
    await eachLimited(wanted, 16, async file => {
      const target = join(root, ...file.parts)
      await d.fs.mkdir(dirname(target), { recursive: true })
      await d.fs.copyFile(join(workspace, ...file.parts), target)
    })
    const modules = resolve(workspace, 'node_modules')
    if (await d.fs.lstat(modules).then(() => true, () => false)) {
      junction = join(root, 'node_modules')
      await d.fs.symlink(modules, junction, 'junction')
    }
    return { root, junction, files: wanted.length, bytes, cleanup }
  } catch (error) {
    await cleanup().catch(() => undefined)
    throw error
  }
}

function acceptanceEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !CREDENTIAL_VARIABLE.test(name)) environment[name] = value
  return { ...environment, CI: '1', CONDUCTOR_ACCEPTANCE_COPY: '1' }
}

function runHostCommand(cwd: string, command: string, timeoutMs: number, maxBytes: number, signal: AbortSignal | undefined, d: HostAcceptanceDependencies): Promise<RunOutcome> {
  return new Promise(resolvePromise => {
    let bytes = 0, timedOut = false, truncated = false, cancelled = false, settled = false, killing = false
    let timer: NodeJS.Timeout | undefined, grace: NodeJS.Timeout | undefined
    const outChunks: Buffer[] = [], errChunks: Buffer[] = []
    const finish = (code: number | null, spawnError?: Error): void => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', onAbort)
      resolvePromise({ code, stdout: Buffer.concat(outChunks).toString('utf8'), stderr: Buffer.concat(errChunks).toString('utf8'), timedOut, truncated, cancelled, spawnError })
    }
    let child: ChildProcess
    const options: SpawnOptions = { cwd, shell: true, windowsHide: true, env: acceptanceEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: d.platform !== 'win32' }
    try { child = d.spawn(command, [], options) } catch (error) { finish(null, error as Error); return }
    // A shell's children outlive a kill of the shell alone; take the whole tree down.
    const killTree = (): void => {
      if (killing) return
      killing = true
      if (d.platform === 'win32' && child.pid) {
        const killer = d.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill('SIGKILL'))
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else child.kill('SIGKILL')
      grace = setTimeout(() => finish(null), d.killGraceMs)
    }
    const onAbort = (): void => { cancelled = true; killTree() }
    timer = setTimeout(() => { timedOut = true; killTree() }, timeoutMs)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    const capture = (chunk: Buffer, target: Buffer[]): void => {
      const remaining = Math.max(0, maxBytes - bytes)
      bytes += chunk.length
      const captured = chunk.subarray(0, remaining)
      if (captured.length) target.push(captured)
      if (bytes > maxBytes) { truncated = true; killTree() }
    }
    child.stdout?.on('data', chunk => capture(chunk as Buffer, outChunks))
    child.stderr?.on('data', chunk => capture(chunk as Buffer, errChunks))
    child.on('error', error => finish(null, error as Error))
    child.on('close', code => finish(code))
  })
}

/** Run the task contract's acceptance command on the Windows host, in a throwaway copy of the
 *  workspace whose node_modules is a junction to the host's own tree. Used only while the sandbox
 *  has no Linux dependency tree, where the bound Windows binaries (Rollup, esbuild) would fail
 *  the run before a single test did. The command is set by the task contract the frontier
 *  controller wrote, never by the local model, which is why running it on the host is acceptable
 *  at all; the code it exercises is the model's, so credentials are stripped from its environment,
 *  package installs are refused, and the copy never holds .git or a withheld file. */
export async function runHostAcceptance(workspace: string, command: string, timeoutSec: number, options: { signal?: AbortSignal; maxBytes?: number } = {}, deps: Partial<HostAcceptanceDependencies> = {}): Promise<SandboxResult> {
  if (typeof command !== 'string' || !command.trim()) throw new SandboxUnavailableError('An acceptance command is required')
  if (command.includes('\0')) throw new SandboxUnavailableError('Command contains a NUL byte')
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 3600) throw new SandboxUnavailableError('Invalid command timeout')
  // The junction is the owner's real tree; an install through it would rewrite that tree.
  assertNoPackageInstall(command)
  options.signal?.throwIfAborted()
  const d = { ...defaultHostAcceptance, ...deps }
  const copy = await hostAcceptanceCopy(workspace, d)
  const started = Date.now()
  const outcome = await runHostCommand(copy.root, command, timeoutSec * 1000, options.maxBytes ?? ACCEPTANCE_OUTPUT_BYTES, options.signal, d)
  const cleanupNote = await copy.cleanup().then(() => '', (error: unknown) => `\n[acceptance copy cleanup: ${error instanceof Error ? error.message : 'failed'}]`)
  if (outcome.spawnError) throw new SandboxUnavailableError(`The acceptance command could not be started on the host: ${outcome.spawnError.message}`)
  const failed = outcome.cancelled || outcome.truncated || outcome.timedOut
  return { cancelled: outcome.cancelled ?? false, exitCode: failed ? -1 : outcome.code ?? -1, stdout: outcome.stdout, stderr: outcome.stderr + cleanupNote, truncated: outcome.truncated, timedOut: outcome.timedOut, durationMs: Date.now() - started }
}

export interface DockerSandboxDependencies {
  linuxDeps?: Partial<LinuxDepsDependencies>
  hostAcceptance?: typeof runHostAcceptance
}

export class DockerSandbox {
  readonly name: string
  private readonly workspace: string
  private readonly sandbox: SandboxConfig
  private started = false
  private starting?: Promise<void>
  private mountSignature?: string
  private gitWritable = false
  private analysis = false
  private analysisScratch?: string

  setAnalysisMode(enabled: boolean): void { this.analysis = enabled; this.analysisScratch = undefined }

  setAnalysisAccess(scratchRelative: string): void {
    if (!scratchRelative || scratchRelative === '.' || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|[:,=\r\n]/.test(scratchRelative) || isSecretPath(scratchRelative)) throw new SandboxUnavailableError('Invalid analysis scratch subdirectory')
    this.analysis = true; this.analysisScratch = scratchRelative.replace(/\\/g, '/')
  }
  private gitAutocrlf?: string

  private readonly deps: DockerSandboxDependencies

  constructor(sessionId: string, workspace: string, sandbox: SandboxConfig, deps: DockerSandboxDependencies = {}) {
    this.name = sandboxContainerName(sessionId)
    this.workspace = workspace
    this.sandbox = sandbox
    this.deps = deps
  }

  /** The owner can grant or withdraw repository write access between turns. A running container's
   *  bind mounts cannot change, so the grant only becomes real on the next container. */
  setGitAccess(writable: boolean): void { this.gitWritable = writable }

  private signature(masks: SecretMask[], linuxDeps?: string): string {
    return JSON.stringify({ masks, analysis: this.analysis, analysisScratch: this.analysisScratch, git: this.gitWritable, autocrlf: this.gitAutocrlf ?? null, workspace: resolve(this.workspace), ...(linuxDeps ? { linuxDeps } : {}) })
  }

  /** Whether an owner-prepared Linux dependency volume matches this workspace's lockfile. */
  async linuxDepsReady(): Promise<boolean> {
    return (await this.plannedLinuxDeps()) !== undefined
  }

  /** Only ever resolves a volume the owner already prepared; nothing here prepares one. */
  private async plannedLinuxDeps(): Promise<string | undefined> {
    try {
      const status = await linuxDepsStatus(this.workspace, this.sandbox, this.deps.linuxDeps)
      return status.state === 'ready' ? status.volume : undefined
    } catch { return undefined }
  }

  /** The mounts this session should be running with right now: the cached secret scan, plus the
   *  index-backed replicas that keep a granted `git` from committing a mask as a deletion, plus a
   *  prepared Linux dependency volume once one is ready — which changes the signature, so the
   *  container is recreated onto it. Plans only — nothing is written to disk until the container
   *  is actually created. */
  private async plannedMasks(): Promise<{ masks: SecretMask[]; writes: TrackedMaskWrite[]; linuxDeps?: string }> {
    if (this.analysisScratch) {
      const scratch = await resolveInWorkspace(this.workspace, this.analysisScratch)
      if (scratch.relative !== this.analysisScratch || !(await stat(scratch.path)).isDirectory()) throw new SandboxUnavailableError('Analysis scratch must be a canonical task directory')
    }
    const [masks, linuxDeps] = await Promise.all([secretPathsFor(this.workspace), this.plannedLinuxDeps()])
    if (!this.gitWritable || this.analysis) return { masks, writes: [], linuxDeps }
    this.gitAutocrlf = await hostAutocrlf(this.workspace)
    return { ...(await trackedMaskPlan(this.workspace, masks, join(runDir(), 'masked-tracked'))), linuxDeps }
  }

  /** Bring the container up, or refuse with the specific reason. Never returns without a
   *  running, verified container. */
  async start(): Promise<void> {
    if (this.started) return
    if (this.starting) return this.starting
    this.starting = this.launch().then(() => { this.started = true }).finally(() => { this.starting = undefined })
    return this.starting
  }

  private async launch(): Promise<void> {
    const docker = await ensureDockerAvailable()
    if (!docker.available) throw new SandboxUnavailableError(docker.reason ?? 'Docker unavailable')
    if (!await sandboxImageExists(this.sandbox.image)) throw new SandboxUnavailableError(`Sandbox image missing: build ${this.sandbox.image} with scripts/local-models/setup.ps1`)
    const planned = await this.plannedMasks()
    const signature = this.signature(planned.masks, planned.linuxDeps)
    const digest = mountDigest(signature)
    const existing = await runDocker(['inspect', '--format', `{{.State.Running}}\t{{index .Config.Labels "${MOUNT_LABEL}"}}\t{{json .Mounts}}`, this.name], 20_000, 256 * 1024)
    if (existing.code === 0) {
      // Adopting whatever is already running would run the first command of a session against
      // mounts that may predate a withdrawn .git grant or a credential file that appeared since.
      // The container carries the signature of the mounts it was built from, and its real bind
      // list is checked against this workspace, so a stale container is rebuilt, not adopted.
      if (existing.stdout.trim().startsWith('true') && adoptableContainer(existing.stdout, digest, this.workspace)) {
        this.mountSignature = signature
        return
      }
      await runDocker(['rm', '--force', this.name], 30_000, 16 * 1024)
    }
    const emptyFile = join(runDir(), 'masked-empty')
    if (!existsSync(emptyFile)) writeFileSync(emptyFile, '', 'utf8')
    await materializeMaskSources(this.workspace, planned.writes)
    const args = containerRunArgs({ name: this.name, image: this.sandbox.image, workspace: this.workspace, sandbox: this.sandbox, masks: planned.masks, emptyFile, analysis: this.analysis, analysisScratch: this.analysisScratch, gitWritable: this.gitWritable, gitAutocrlf: this.gitAutocrlf, linuxDeps: planned.linuxDeps })
    args.splice(args.indexOf('--label'), 0, '--label', `${MOUNT_LABEL}=${digest}`)
    const created = await runDocker(args, 120_000, 256 * 1024)
    if (created.spawnError || created.code !== 0) throw new SandboxUnavailableError(`Sandbox failed to start: ${(created.stderr || created.stdout).trim().slice(0, 400) || 'docker run failed'}`)
    this.mountSignature = signature
  }

  /** Run one command inside the container. Refuses closed on any sandbox problem. */
  async exec(command: string, timeoutSec = this.sandbox.timeoutSec, signal?: AbortSignal): Promise<SandboxResult> {
    signal?.throwIfAborted()
    // Other coworkers may create credential files between commands, and the owner may have
    // granted or withdrawn repository writes. A running container's bind mounts cannot change;
    // recreate it before executing against a different set of them.
    if (this.started) {
      const planned = await this.plannedMasks()
      if (this.signature(planned.masks, planned.linuxDeps) !== this.mountSignature) await this.stop()
    }
    await this.start()
    signal?.throwIfAborted()
    const started = Date.now()
    // Killing only the docker client leaves the Linux command running. Remove this session's
    // container on cancellation and await removal before allowing another turn to start.
    let stopping: Promise<void> | undefined
    const cancel = (): void => { stopping ??= this.stop() }
    signal?.addEventListener('abort', cancel, { once: true })
    let outcome: RunOutcome
    try { outcome = await runDocker(execArgs(this.name, command, timeoutSec), (timeoutSec + 15) * 1000, 8 * 1024 * 1024) }
    finally { signal?.removeEventListener('abort', cancel); await stopping }
    if (outcome.spawnError) throw new SandboxUnavailableError('Docker unavailable: the docker CLI could not be launched')
    const truncated = outcome.truncated
    // 124 is `timeout` reporting that it killed the command; 137 is the kill that followed.
    const timedOut = outcome.timedOut || outcome.code === 124 || outcome.code === 137
    // Overflow terminates the Docker client, not the container's process tree. Waiting for
    // container removal also prevents escaped/delayed children surviving a command timeout.
    if (truncated || timedOut) await this.stop()
    return { cancelled: signal?.aborted ?? false, exitCode: signal?.aborted ? -1 : truncated ? -1 : outcome.code ?? -1, stdout: outcome.stdout, stderr: outcome.stderr, truncated, timedOut, durationMs: Date.now() - started }
  }

  /** The task contract's acceptance command. In the sandbox whenever it can really run there: no
   *  lockfile or no host node_modules (nothing native to break), or a prepared Linux tree.
   *  Otherwise the bound Windows node_modules fails on its native binaries before a single test
   *  runs, so it runs in an isolated host copy instead. The command is set by the task contract
   *  (the frontier controller), never by the local model; see `runHostAcceptance`. */
  async runAcceptance(command: string, timeoutSec: number, signal?: AbortSignal): Promise<SandboxResult & { where: 'sandbox' | 'host-copy' }> {
    const windowsTree = existsSync(join(this.workspace, 'package-lock.json')) && existsSync(join(this.workspace, 'node_modules'))
    if (!windowsTree || await this.linuxDepsReady()) return { ...(await this.exec(command, timeoutSec, signal)), where: 'sandbox' }
    const host = this.deps.hostAcceptance ?? runHostAcceptance
    return { ...(await host(this.workspace, command, timeoutSec, { signal })), where: 'host-copy' }
  }

  async stop(): Promise<void> {
    this.started = false
    this.mountSignature = undefined
    await runDocker(['rm', '--force', this.name], 60_000, 64 * 1024)
  }
}
