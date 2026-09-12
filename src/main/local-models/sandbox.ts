import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, parse, relative, resolve } from 'node:path'
import type { SandboxConfig } from './config.ts'
import { runDir } from './config.ts'
import { isSecretPath } from './workspace.ts'

/** The sandbox could not be used. Every tool that needs execution turns this into a refusal;
 *  nothing in this module or its callers ever falls back to a host shell. That is the whole
 *  point of the boundary: a stopped or broken Docker sandbox means execution is unavailable,
 *  not that the command runs on Windows instead. */
export class SandboxUnavailableError extends Error {}

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

/** Files inside the workspace that policy hides from local models. Masked in the container and
 *  refused by the host-side file tools, so a secret is not merely absent from one of the two.
 *  The recursive scan is bounded and fails closed if incomplete; silently truncating a scan
 *  would expose the rest of the workspace through the command tool. */
export function detectSecretPaths(workspace: string, maxDepth = 64, limit = 4096): Array<{ relative: string; directory: boolean }> {
  const found: Array<{ relative: string; directory: boolean }> = []
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) throw new SandboxUnavailableError('Secret scan exceeded its depth budget; command execution refused')
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { throw new SandboxUnavailableError('Secret scan could not inspect a workspace directory; command execution refused') }
    for (const entry of entries) {
      if (++visited > 200_000) throw new SandboxUnavailableError('Secret scan exceeded its entry budget; command execution refused')
      const full = join(dir, entry.name)
      const rel = relative(workspace, full).replace(/\\/g, '/')
      if (isSecretPath(rel)) {
        if (found.length >= limit) throw new SandboxUnavailableError('Secret scan exceeded its mask budget; command execution refused')
        found.push({ relative: rel, directory: entry.isDirectory() }); continue
      }
      if (entry.isDirectory()) walk(full, depth + 1)
    }
  }
  walk(workspace, 0)
  return found
}

const dockerPath = (value: string): string => resolve(value).replace(/\\/g, '/')

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
  masks: Array<{ relative: string; directory: boolean }>
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
    ...(!options.gitWritable && existsSync(join(options.workspace, '.git')) ? ['--mount', `type=bind,source=${workspace}/.git,target=/workspace/.git,readonly`] : [])
  ]
  for (const mask of options.masks) {
    if (/[,=\r\n]/.test(mask.relative)) throw new SandboxUnavailableError('A secret path cannot be represented safely as a Docker mask')
    if (mask.directory) args.push('--tmpfs', `/workspace/${mask.relative}:rw,nosuid,nodev,size=1m`)
    else args.push('--mount', `type=bind,source=${dockerPath(options.emptyFile)},target=/workspace/${mask.relative},readonly`)
  }
  // A deliberately minimal environment. Nothing from the host is inherited, so no API key,
  // cloud credential or token can be read out of the sandbox even if the model asks for it.
  for (const variable of ['HOME=/home/agent', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', 'TERM=dumb', 'TMPDIR=/tmp', 'XDG_CACHE_HOME=/tmp/cache', 'NPM_CONFIG_CACHE=/tmp/npm', 'PIP_CACHE_DIR=/tmp/pip', 'CONDUCTOR_SANDBOX=1']) args.push('--env', variable)
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

  private signature(masks: Array<{ relative: string; directory: boolean }>): string {
    return JSON.stringify({ masks, git: this.gitWritable })
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
    const running = await runDocker(['inspect', '--format', '{{.State.Running}}', this.name], 20_000, 16 * 1024)
    if (running.code === 0 && running.stdout.trim() === 'true') return
    if (running.code === 0) await runDocker(['rm', '--force', this.name], 30_000, 16 * 1024)
    const emptyFile = join(runDir(), 'masked-empty')
    if (!existsSync(emptyFile)) writeFileSync(emptyFile, '', 'utf8')
    const masks = detectSecretPaths(this.workspace)
    this.mountSignature = this.signature(masks)
    const created = await runDocker(containerRunArgs({ name: this.name, image: this.sandbox.image, workspace: this.workspace, sandbox: this.sandbox, masks, emptyFile, gitWritable: this.gitWritable }), 120_000, 256 * 1024)
    if (created.spawnError || created.code !== 0) throw new SandboxUnavailableError(`Sandbox failed to start: ${(created.stderr || created.stdout).trim().slice(0, 400) || 'docker run failed'}`)
  }

  /** Run one command inside the container. Refuses closed on any sandbox problem. */
  async exec(command: string, timeoutSec = this.sandbox.timeoutSec, signal?: AbortSignal): Promise<SandboxResult> {
    signal?.throwIfAborted()
    // Other coworkers may create credential files between commands, and the owner may have
    // granted or withdrawn repository writes. A running container's bind mounts cannot change;
    // recreate it before executing against a different set of them.
    if (this.started && this.signature(detectSecretPaths(this.workspace)) !== this.mountSignature) await this.stop()
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
    await runDocker(['rm', '--force', this.name], 60_000, 64 * 1024)
  }
}
