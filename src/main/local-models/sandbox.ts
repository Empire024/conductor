import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve } from 'node:path'
import type { SandboxConfig } from './config.ts'
import { runDir } from './config.ts'
import { isSecretPath } from './workspace.ts'

/** The sandbox could not be used. Every tool that needs execution turns this into a refusal;
 *  nothing in this module or its callers ever falls back to a host shell. That is the whole
 *  point of the boundary: a stopped or broken Docker sandbox means execution is unavailable,
 *  not that the command runs on Windows instead. */
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
  durationMs: number
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,110}$/
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/

export const sandboxContainerName = (sessionId: string): string => {
  const name = `conductor-local-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
  if (!NAME.test(name)) throw new SandboxUnavailableError('Invalid sandbox container name')
  return name
}

/** Docker is invoked as a program, never through a shell: the executable is resolved from
 *  CONDUCTOR_DOCKER_PATH or PATH and every argument is passed as its own argv entry, so no
 *  model-produced text is ever parsed by PowerShell or cmd.exe. */
export const dockerExecutable = (): string => process.env.CONDUCTOR_DOCKER_PATH?.trim() || 'docker'

interface RunOutcome { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; spawnError?: Error }

function runDocker(args: string[], timeoutMs: number, maxBytes: number): Promise<RunOutcome> {
  return new Promise(resolvePromise => {
    let stdout = '', stderr = '', bytes = 0, timedOut = false, truncated = false, settled = false
    const child = spawn(dockerExecutable(), args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = (outcome: RunOutcome): void => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(outcome) }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    const capture = (chunk: Buffer, target: 'out' | 'err'): void => {
      const remaining = Math.max(0, maxBytes - bytes)
      bytes += chunk.length
      const captured = chunk.subarray(0, remaining).toString('utf8')
      if (target === 'out') stdout += captured
      else stderr += captured
      if (bytes > maxBytes) { truncated = true; child.kill('SIGKILL') }
    }
    child.stdout.on('data', chunk => capture(chunk as Buffer, 'out'))
    child.stderr.on('data', chunk => capture(chunk as Buffer, 'err'))
    child.on('error', error => finish({ code: null, stdout, stderr, timedOut, truncated, spawnError: error as Error }))
    child.on('close', code => finish({ code, stdout, stderr, timedOut, truncated }))
  })
}

export async function dockerAvailable(): Promise<{ available: boolean; version?: string; reason?: string }> {
  const outcome = await runDocker(['version', '--format', '{{.Server.Version}}'], 20_000, 64 * 1024)
  if (outcome.spawnError) return { available: false, reason: 'Docker unavailable: the docker CLI was not found. Install Docker Desktop (Linux containers).' }
  if (outcome.code !== 0) return { available: false, reason: 'Docker unavailable: the Docker engine is not responding. Start Docker Desktop.' }
  return { available: true, version: outcome.stdout.trim() }
}

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
  gitWritable?: boolean
}): string[] {
  if (!NAME.test(options.name)) throw new SandboxUnavailableError('Invalid sandbox container name')
  if (!IMAGE.test(options.image)) throw new SandboxUnavailableError('Invalid sandbox image reference')
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
    '--mount', `type=bind,source=${workspace},target=/workspace`,
    // Repository metadata stays readable for status and diffs but can never be rewritten, so a
    // sandboxed turn cannot install a git hook or change remotes in the owner's repository.
    // The owner can grant write access per conversation; the container still has no network, so
    // the grant reaches local history only and never pushes anywhere.
    ...(!options.gitWritable && existsSync(join(options.workspace, '.git')) ? ['--mount', `type=bind,source=${workspace}/.git,target=/workspace/.git,readonly`] : []),
    // An installed dependency tree is an input to a sandboxed command and never its output. The
    // container has no network, so it can never repair an install — but npm and npx tear a tree
    // down *before* they discover that, and a plain `npx tsc` in this repo removed the owner's
    // node_modules and package-lock.json mid-run. Read-only is the only state in which those two
    // paths are safe to expose at all.
    ...DEPENDENCY_PATHS.flatMap(relative => existsSync(join(options.workspace, relative))
      ? ['--mount', `type=bind,source=${workspace}/${relative},target=/workspace/${relative},readonly`]
      : []),
    // Build tools cache inside the tree they read. These stay writable so a sandboxed build still
    // works, without the rest of node_modules being writable with it.
    ...DEPENDENCY_CACHES.flatMap(relative => existsSync(join(options.workspace, 'node_modules'))
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

export class DockerSandbox {
  readonly name: string
  private readonly workspace: string
  private readonly sandbox: SandboxConfig
  private started = false
  private starting?: Promise<void>
  private mountSignature?: string
  private gitWritable = false

  constructor(sessionId: string, workspace: string, sandbox: SandboxConfig) {
    this.name = sandboxContainerName(sessionId)
    this.workspace = workspace
    this.sandbox = sandbox
  }

  /** The owner can grant or withdraw repository write access between turns. A running container's
   *  bind mounts cannot change, so the grant only becomes real on the next container. */
  setGitAccess(writable: boolean): void { this.gitWritable = writable }

  private signature(masks: SecretMask[]): string {
    return JSON.stringify({ masks, git: this.gitWritable, workspace: resolve(this.workspace) })
  }

  /** The mounts this session should be running with right now: the cached secret scan, plus the
   *  index-backed replicas that keep a granted `git` from committing a mask as a deletion. Plans
   *  only — nothing is written to disk until the container is actually created. */
  private async plannedMasks(): Promise<{ masks: SecretMask[]; writes: TrackedMaskWrite[] }> {
    const masks = await secretPathsFor(this.workspace)
    if (!this.gitWritable) return { masks, writes: [] }
    return trackedMaskPlan(this.workspace, masks, join(runDir(), 'masked-tracked'))
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
    const docker = await dockerAvailable()
    if (!docker.available) throw new SandboxUnavailableError(docker.reason ?? 'Docker unavailable')
    if (!await sandboxImageExists(this.sandbox.image)) throw new SandboxUnavailableError(`Sandbox image missing: build ${this.sandbox.image} with scripts/local-models/setup.ps1`)
    const planned = await this.plannedMasks()
    const signature = this.signature(planned.masks)
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
    const args = containerRunArgs({ name: this.name, image: this.sandbox.image, workspace: this.workspace, sandbox: this.sandbox, masks: planned.masks, emptyFile, gitWritable: this.gitWritable })
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
    if (this.started && this.signature((await this.plannedMasks()).masks) !== this.mountSignature) await this.stop()
    await this.start()
    signal?.throwIfAborted()
    const started = Date.now()
    // Killing only the docker client leaves the Linux command running. Remove this session's
    // container on cancellation and await removal before allowing another turn to start.
    let stopping: Promise<void> | undefined
    const cancel = (): void => { stopping ??= this.stop() }
    signal?.addEventListener('abort', cancel, { once: true })
    let outcome: RunOutcome
    try { outcome = await runDocker(execArgs(this.name, command, timeoutSec), (timeoutSec + 15) * 1000, this.sandbox.maxOutputBytes) }
    finally { signal?.removeEventListener('abort', cancel); await stopping }
    signal?.throwIfAborted()
    if (outcome.spawnError) throw new SandboxUnavailableError('Docker unavailable: the docker CLI could not be launched')
    const truncated = outcome.truncated
    // 124 is `timeout` reporting that it killed the command; 137 is the kill that followed.
    const timedOut = outcome.timedOut || outcome.code === 124 || outcome.code === 137
    // Overflow terminates the Docker client, not the container's process tree. Waiting for
    // container removal also prevents escaped/delayed children surviving a command timeout.
    if (truncated || timedOut) await this.stop()
    return { exitCode: truncated ? -1 : outcome.code ?? -1, stdout: outcome.stdout, stderr: outcome.stderr, truncated, timedOut, durationMs: Date.now() - started }
  }

  async stop(): Promise<void> {
    this.started = false
    this.mountSignature = undefined
    await runDocker(['rm', '--force', this.name], 60_000, 64 * 1024)
  }
}
