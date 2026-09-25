import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { nodeCapabilities, nodeReadiness, normalizeCapability, parseProbe, PROBE_SCRIPT, selectNode } from './capabilities.ts'
import { buildJobCommand, buildScriptCommand, buildStopCommand, MarkerScanner, shQuote } from './shell.ts'
import type { LogStream, RemoteJobStore } from './store.ts'
import type { ExecHandle, ExecResult, TransportFactory } from './transport.ts'
import type { ExecutionNode, NodeSummary, RegisterNode, RemoteJob, RemoteJobStatus, SubmitRemoteJob } from './types.ts'
import { TERMINAL_REMOTE_JOB_STATUSES } from './types.ts'

export interface RemoteJobServiceOptions {
  store: RemoteJobStore
  transport: TransportFactory
  /** Full commit id for a ref of a local repository; `git rev-parse` by default. */
  resolveCommit?: (repoPath: string, ref: string) => Promise<string>
  clock?: () => Date
  newId?: () => string
  nonce?: () => string
  probeTimeoutMs?: number
  /** Per preparation step (create the node's repository, push, check out). */
  prepareTimeoutMs?: number
  /** How long past its own deadline a job may take before this side drops the connection. */
  localGraceMs?: number
  /** How long a cancelled job has to stop on its own before the connection is dropped. */
  cancelGraceMs?: number
  tailChars?: number
  onChange?: (job: RemoteJob) => void
  /** Whether a runner process is still alive; a job whose runner lives is not an orphan. */
  isAlive?: (pid: number) => boolean
}

export const DEFAULT_JOB_TIMEOUT_SEC = 30 * 60
export const MAX_JOB_TIMEOUT_SEC = 24 * 60 * 60
const ACTIVE: readonly RemoteJobStatus[] = ['queued', 'preparing', 'running']

const gitRevParse = (repoPath: string, ref: string): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-C', repoPath, 'rev-parse', '--verify', `${ref}^{commit}`], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
    if (error) reject(new Error(`${ref} is not a commit of ${repoPath}`))
    else resolve(stdout.trim())
  })
})

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

const tail = (value: string, chars: number): string => value.length > chars ? value.slice(value.length - chars) : value
const lastLines = (value: string): string => tail(value.trim(), 400)

interface Active {
  cancelRequested: boolean
  cancelReason: string | null
  handle: ExecHandle | null
}

/**
 * Bounded commands on execution nodes. A job is durable (its record and logs are files here, and
 * survive a restart as a record); the ssh process that carries it is disposable.
 */
export class RemoteJobService {
  private readonly store: RemoteJobStore
  private readonly transport: TransportFactory
  private readonly resolveCommit: (repoPath: string, ref: string) => Promise<string>
  private readonly clock: () => Date
  private readonly newId: () => string
  private readonly nonce: () => string
  private readonly probeTimeoutMs: number
  private readonly prepareTimeoutMs: number
  private readonly localGraceMs: number
  private readonly cancelGraceMs: number
  private readonly tailChars: number
  private readonly onChange?: (job: RemoteJob) => void
  private readonly isAlive: (pid: number) => boolean
  private readonly active = new Map<string, Active>()
  private readonly waiters = new Map<string, Array<(job: RemoteJob) => void>>()
  private readonly running = new Set<Promise<void>>()

  constructor(options: RemoteJobServiceOptions) {
    this.store = options.store
    this.transport = options.transport
    this.resolveCommit = options.resolveCommit ?? gitRevParse
    this.clock = options.clock ?? (() => new Date())
    this.newId = options.newId ?? (() => `rj_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`)
    this.nonce = options.nonce ?? (() => randomBytes(8).toString('hex'))
    this.probeTimeoutMs = options.probeTimeoutMs ?? 30_000
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? 10 * 60_000
    this.localGraceMs = options.localGraceMs ?? 60_000
    this.cancelGraceMs = options.cancelGraceMs ?? 20_000
    this.tailChars = options.tailChars ?? 16_384
    this.onChange = options.onChange
    this.isAlive = options.isAlive ?? processAlive
  }

  private now(): string { return this.clock().toISOString() }

  // ---- nodes -------------------------------------------------------------------------------

  registerNode(input: RegisterNode): NodeSummary {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.id ?? '')) throw new Error('id must be 1-40 lower-case letters, digits or dashes, e.g. "mac-mini"')
    const ssh = input.ssh
    if (!ssh || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(ssh.host ?? '')) throw new Error('ssh.host must be a host name, e.g. the node\'s Tailscale name')
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(ssh.user ?? '')) throw new Error('ssh.user must be the node account\'s user name')
    if (typeof ssh.identityFile !== 'string' || !ssh.identityFile) throw new Error('ssh.identityFile must name the private key that node accepts')
    if (ssh.port !== undefined && (!Number.isInteger(ssh.port) || ssh.port < 1 || ssh.port > 65535)) throw new Error('ssh.port must be a port number')
    const root = input.root ?? 'conductor-node'
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(root) || root.split('/').includes('..')) throw new Error('root must be a plain path under the node account\'s home')
    const max = input.maxConcurrentJobs ?? 2
    if (!Number.isInteger(max) || max < 1 || max > 16) throw new Error('maxConcurrentJobs must be 1 to 16')
    const previous = this.store.getNode(input.id)
    const sameHost = previous?.ssh.host === ssh.host && previous.ssh.user === ssh.user
    const node: ExecutionNode = {
      id: input.id,
      name: input.name?.trim() || previous?.name || input.id,
      ssh: { host: ssh.host, user: ssh.user, identityFile: ssh.identityFile, ...(ssh.port ? { port: ssh.port } : {}) },
      peerMachineId: input.peerMachineId ?? previous?.peerMachineId ?? null,
      root,
      labels: (input.labels ?? previous?.labels ?? []).map(normalizeCapability).filter(Boolean),
      maxConcurrentJobs: max,
      facts: sameHost ? previous?.facts ?? null : null,
      status: sameHost ? previous?.status ?? 'unknown' : 'unknown',
      lastSeenAt: sameHost ? previous?.lastSeenAt ?? null : null,
      lastProbeAt: sameHost ? previous?.lastProbeAt ?? null : null,
      lastError: sameHost ? previous?.lastError ?? null : null,
      registeredAt: previous?.registeredAt ?? this.now()
    }
    this.store.saveNode(node)
    return this.summary(node)
  }

  removeNode(id: string): void {
    this.node(id)
    if (this.jobsOn(id).length) throw new Error(`${id} still has jobs queued or running; cancel them first`)
    this.store.removeNode(id)
  }

  listNodes(): NodeSummary[] { return this.store.listNodes().map(node => this.summary(node)) }

  getNode(id: string): NodeSummary { return this.summary(this.node(id)) }

  private node(id: string): ExecutionNode {
    const node = this.store.getNode(id)
    if (!node) throw new Error(`No node "${id}"; nodes.list names the registered ones`)
    return node
  }

  private summary(node: ExecutionNode): NodeSummary {
    return { ...node, capabilities: nodeCapabilities(node), currentJobs: this.jobsOn(node.id).map(job => job.id), readiness: nodeReadiness(node.facts) }
  }

  private jobsOn(nodeId: string): RemoteJob[] {
    return this.store.listJobs().filter(job => job.nodeId === nodeId && ACTIVE.includes(job.status))
  }

  /** Asks the node what it is and marks it online or offline by whether it answered. */
  async probeNode(id: string): Promise<NodeSummary> {
    const node = this.node(id)
    let stdout = ''
    let stderr = ''
    const result = await this.transport(node).exec({
      command: buildScriptCommand(PROBE_SCRIPT), timeoutMs: this.probeTimeoutMs,
      onStdout: chunk => { stdout += chunk }, onStderr: chunk => { stderr += chunk }
    }).done
    const at = this.now()
    const current = this.store.getNode(id) ?? node
    if (result.code === 0) {
      this.store.saveNode({ ...current, facts: parseProbe(stdout), status: 'online', lastSeenAt: at, lastProbeAt: at, lastError: null })
    } else {
      const why = result.timedOut ? `no answer within ${Math.round(this.probeTimeoutMs / 1000)} s` : lastLines(stderr) || result.error || `probe exited ${result.code}`
      this.store.saveNode({ ...current, status: 'offline', lastProbeAt: at, lastError: why })
    }
    return this.getNode(id)
  }

  private markNode(id: string, reachable: boolean, error: string | null): void {
    const node = this.store.getNode(id)
    if (!node) return
    const at = this.now()
    this.store.saveNode(reachable ? { ...node, status: 'online', lastSeenAt: at, lastError: null } : { ...node, status: 'offline', lastError: error })
  }

  // ---- jobs --------------------------------------------------------------------------------

  listJobs(filter: { nodeId?: string; status?: RemoteJobStatus[]; projectId?: string; limit?: number } = {}): RemoteJob[] {
    return this.store.listJobs()
      .filter(job => (!filter.nodeId || job.nodeId === filter.nodeId) && (!filter.status || filter.status.includes(job.status)) && (!filter.projectId || job.projectId === filter.projectId))
      .slice(0, filter.limit ?? 50)
  }

  getJob(id: string): RemoteJob {
    const job = this.store.getJob(id)
    if (!job) throw new Error(`No remote job "${id}"`)
    return job
  }

  readLog(id: string, stream: LogStream, bytes = 64 * 1024): { text: string; size: number; path: string } {
    this.getJob(id)
    return { ...this.store.readLog(id, stream, Math.min(Math.max(1, bytes), 1024 * 1024)), path: this.store.logPath(id, stream) }
  }

  async submit(input: SubmitRemoteJob): Promise<RemoteJob> {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) throw new Error('command is required')
    if (command.length > 20_000) throw new Error('command is longer than 20000 characters; put it in a script in the repository')
    const timeoutSec = input.timeoutSec ?? DEFAULT_JOB_TIMEOUT_SEC
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_JOB_TIMEOUT_SEC) throw new Error(`timeoutSec must be 1 to ${MAX_JOB_TIMEOUT_SEC}`)
    const requires = [...new Set((input.requires ?? []).map(normalizeCapability).filter(Boolean))]
    const cwd = input.cwd ?? ''
    if (input.checkout && (cwd.startsWith('/') || cwd.startsWith('~') || cwd.split('/').includes('..'))) throw new Error('With a checkout, cwd is a folder inside it')
    const node = await this.placement(input.nodeId, requires)
    let checkout: RemoteJob['checkout'] = null
    if (input.checkout) {
      const repo = (input.checkout.repo ?? basename(input.checkout.localRepoPath)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
      if (!repo) throw new Error('checkout.repo must name the repository')
      checkout = { repo, commit: await this.resolveCommit(input.checkout.localRepoPath, input.checkout.commit ?? 'HEAD'), localRepoPath: input.checkout.localRepoPath }
    }
    const job: RemoteJob = {
      id: this.newId(),
      title: input.title?.trim().slice(0, 120) || command.replace(/\s+/g, ' ').trim().slice(0, 80),
      nodeId: node.id, requires, command,
      cwd: checkout ? [workPath(node, checkout.repo), cwd].filter(Boolean).join('/') : cwd,
      checkout, timeoutSec, status: 'queued', detail: null, exitCode: null, remotePid: null,
      createdAt: this.now(), startedAt: null, endedAt: null,
      stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '',
      projectId: input.projectId ?? null, createdBy: input.createdBy ?? null, cancelReason: null, runnerPid: process.pid
    }
    this.save(job)
    this.store.prune()
    this.pump()
    return job
  }

  /** The named node, or the best online node with every required capability; stale candidates are probed first. */
  private async placement(nodeId: string | undefined, requires: string[]): Promise<ExecutionNode> {
    const nodes = nodeId ? [this.node(nodeId)] : this.store.listNodes()
    const stale = nodes.filter(node => node.status !== 'online' && requires.every(capability => nodeCapabilities(node).includes(capability) || !node.facts))
    await Promise.all(stale.map(node => this.probeNode(node.id).catch(() => undefined)))
    const candidates = nodes.map(node => {
      const fresh = this.store.getNode(node.id) ?? node
      return { node: fresh, capabilities: nodeCapabilities(fresh), runningJobs: this.jobsOn(fresh.id).length }
    })
    return selectNode(candidates, requires).node
  }

  async cancel(id: string, reason?: string): Promise<RemoteJob> {
    const job = this.getJob(id)
    if (TERMINAL_REMOTE_JOB_STATUSES.includes(job.status)) return job
    const active = this.active.get(id)
    if (!active && job.runnerPid !== null && job.runnerPid !== process.pid && this.isAlive(job.runnerPid)) {
      throw new Error(`${id} is run by another process (pid ${job.runnerPid}); cancel it there`)
    }
    if (!active) {
      this.finish({ ...job, cancelReason: reason ?? null }, 'cancelled', 'Cancelled before it started.')
      return this.getJob(id)
    }
    active.cancelRequested = true
    active.cancelReason = reason ?? null
    if (job.status === 'preparing') active.handle?.kill()
    else if (active.handle) {
      const handle = active.handle
      handle.closeStdin()
      const timer = setTimeout(() => handle.kill(), this.cancelGraceMs)
      timer.unref?.()
    }
    return this.getJob(id)
  }

  /** Resolves with the job once it has ended, or with its current state after timeoutMs. */
  wait(id: string, timeoutMs: number): Promise<RemoteJob> {
    const job = this.getJob(id)
    if (TERMINAL_REMOTE_JOB_STATUSES.includes(job.status)) return Promise.resolve(job)
    return new Promise(resolve => {
      const done = (value: RemoteJob): void => { clearTimeout(timer); resolve(value) }
      const timer = setTimeout(() => {
        this.waiters.set(id, (this.waiters.get(id) ?? []).filter(entry => entry !== done))
        resolve(this.getJob(id))
      }, timeoutMs)
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done])
    })
  }

  /**
   * After a restart: a job this process did not start cannot be followed any more. It is recorded
   * as lost, and its node is asked to stop whatever is left of it (normally nothing: the ssh
   * session ended with the old process, and the wrapper stops a job when that happens).
   */
  async recover(): Promise<RemoteJob[]> {
    const orphans = this.store.listJobs().filter(job => ACTIVE.includes(job.status) && !this.active.has(job.id)
      && (job.runnerPid === null || job.runnerPid === process.pid || !this.isAlive(job.runnerPid)))
    for (const job of orphans) {
      this.finish(job, job.status === 'queued' ? 'cancelled' : 'lost', job.status === 'queued' ? 'Conductor restarted before it started.' : 'Conductor restarted while it ran; the node was asked to stop what was left of it.')
    }
    await Promise.all(orphans.filter(job => job.status !== 'queued').map(async job => {
      const node = this.store.getNode(job.nodeId)
      if (node) await this.transport(node).exec({ command: buildStopCommand(job.id), timeoutMs: this.probeTimeoutMs }).done.catch(() => undefined)
    }))
    return orphans.map(job => this.getJob(job.id))
  }

  /** Stops every running job (app quit). Waits for them to end, at most graceMs. */
  async shutdown(graceMs = 5_000): Promise<void> {
    for (const id of this.active.keys()) await this.cancel(id, 'Conductor is quitting')
    await Promise.race([Promise.all([...this.running]), new Promise(resolve => setTimeout(resolve, graceMs).unref?.())])
  }

  /** Settles when every job this process started has ended (tests, scripts). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running])
  }

  private save(job: RemoteJob): void {
    this.store.saveJob(job)
    this.onChange?.(job)
  }

  private finish(job: RemoteJob, status: RemoteJobStatus, detail: string | null, exitCode: number | null = job.exitCode): void {
    const ended: RemoteJob = { ...job, status, detail, exitCode, endedAt: this.now() }
    this.save(ended)
    const waiting = this.waiters.get(job.id) ?? []
    this.waiters.delete(job.id)
    for (const resolve of waiting) resolve(ended)
  }

  /** Starts every queued job whose node has room and whose checkout is free. */
  private pump(): void {
    const queued = this.store.listJobs().filter(job => job.status === 'queued' && !this.active.has(job.id) && (job.runnerPid === null || job.runnerPid === process.pid)).reverse()
    for (const job of queued) {
      const node = this.store.getNode(job.nodeId)
      if (!node) { this.finish(job, 'failed', 'Its node was removed.'); continue }
      const busy = this.store.listJobs().filter(other => other.nodeId === node.id && (other.status === 'preparing' || other.status === 'running' || this.active.has(other.id)))
      if (busy.length >= node.maxConcurrentJobs) continue
      if (job.checkout && busy.some(other => other.checkout?.repo === job.checkout!.repo)) continue
      const active: Active = { cancelRequested: false, cancelReason: null, handle: null }
      this.active.set(job.id, active)
      const run = this.run(job, node, active)
        .catch(error => { this.finish(this.getJob(job.id), 'failed', `Conductor failed to run it: ${error instanceof Error ? error.message : String(error)}`) })
        .finally(() => { this.active.delete(job.id); this.running.delete(run); this.pump() })
      this.running.add(run)
    }
  }

  private cancelled(job: RemoteJob, active: Active, detail: string): void {
    this.finish({ ...job, cancelReason: active.cancelReason }, 'cancelled', detail)
  }

  private async run(queued: RemoteJob, node: ExecutionNode, active: Active): Promise<void> {
    const transport = this.transport(node)
    let job: RemoteJob = { ...queued, startedAt: this.now() }
    if (job.checkout) {
      const checkout = job.checkout
      job = { ...job, status: 'preparing', detail: `Bringing ${node.id}:${workPath(node, checkout.repo)} to ${checkout.commit.slice(0, 12)}` }
      this.save(job)
      const ref = `refs/conductor/jobs/${job.id}`
      const bare = barePath(node, checkout.repo)
      const step = async (what: string, command: string): Promise<boolean> => {
        let stderr = ''
        let stdout = ''
        const handle = transport.exec({ command, timeoutMs: this.prepareTimeoutMs, onStdout: chunk => { stdout += chunk }, onStderr: chunk => { stderr += chunk } })
        active.handle = handle
        const result = await handle.done
        active.handle = null
        if (active.cancelRequested) { this.cancelled(job, active, `Cancelled while ${what}.`); return false }
        if (result.code === 0) return true
        this.stepFailed(job, node, what, result, stderr || stdout)
        return false
      }
      if (!await step('creating the node\'s repository', buildScriptCommand(`mkdir -p ${shQuote(`${node.root}/repos`)} && { [ -d ${shQuote(bare)} ] || git init --bare -q ${shQuote(bare)}; }`))) return
      try {
        await transport.pushCommit({ localRepoPath: checkout.localRepoPath, commit: checkout.commit, remotePath: bare, ref, timeoutMs: this.prepareTimeoutMs })
      } catch (error) {
        if (active.cancelRequested) { this.cancelled(job, active, 'Cancelled while pushing the commit.'); return }
        this.finish(job, 'failed', error instanceof Error ? error.message : String(error))
        return
      }
      if (active.cancelRequested) { this.cancelled(job, active, 'Cancelled while pushing the commit.'); return }
      if (!await step('checking out the commit', buildScriptCommand(syncScript(node, checkout.repo, ref, checkout.commit)))) return
    }
    if (active.cancelRequested) { this.cancelled(job, active, 'Cancelled before it started.'); return }

    job = { ...job, status: 'running', detail: `Running on ${node.id}` }
    this.save(job)
    const nonce = this.nonce()
    const scanner = new MarkerScanner(nonce)
    let started = false
    let exitCode: number | null = null
    let reason: 'timeout' | 'cancelled' | null = null
    let wrapperError: string | null = null
    let dirty = false
    const take = (stream: LogStream, text: string): void => {
      if (!text) return
      this.store.appendLog(job.id, stream, text)
      if (stream === 'stdout') job = { ...job, stdoutBytes: job.stdoutBytes + Buffer.byteLength(text), stdoutTail: tail(job.stdoutTail + text, this.tailChars) }
      else job = { ...job, stderrBytes: job.stderrBytes + Buffer.byteLength(text), stderrTail: tail(job.stderrTail + text, this.tailChars) }
      dirty = true
    }
    const handle = transport.exec({
      command: buildJobCommand({ jobId: job.id, cwd: job.cwd, timeoutSec: job.timeoutSec, command: job.command, nonce }),
      holdStdin: true,
      timeoutMs: job.timeoutSec * 1000 + this.localGraceMs,
      onStdout: chunk => take('stdout', chunk),
      onStderr: chunk => {
        const { text, events } = scanner.push(chunk)
        take('stderr', text)
        for (const event of events) {
          if (event.kind === 'started') { started = true; job = { ...job, remotePid: event.pid }; this.save(job); dirty = false }
          else if (event.kind === 'reason') reason = event.reason
          else if (event.kind === 'error') wrapperError = event.error
          else exitCode = event.code
        }
      }
    })
    active.handle = handle
    const flush = setInterval(() => { if (dirty) { dirty = false; this.save(job) } }, 2_000)
    flush.unref?.()
    let result: ExecResult
    try { result = await handle.done } finally { clearInterval(flush) }
    active.handle = null
    take('stderr', scanner.flush())
    job = { ...job, exitCode }

    if (exitCode !== null || started) this.markNode(node.id, true, null)
    if (exitCode !== null) {
      if (wrapperError === 'cwd') return this.finish(job, 'failed', `The working directory ${job.cwd || '~'} does not exist on ${node.id}.`)
      if (wrapperError) return this.finish(job, 'failed', `The node could not start the job (${wrapperError}).`)
      if (reason === 'timeout') return this.finish(job, 'timed-out', `Stopped by the node after ${job.timeoutSec} s.`)
      if (reason === 'cancelled') return active.cancelRequested
        ? this.cancelled(job, active, 'Cancelled; the node stopped its processes.')
        : this.finish(job, 'lost', 'The connection closed while it ran; the node stopped its processes.')
      return this.finish(job, exitCode === 0 ? 'succeeded' : 'failed', exitCode === 0 ? null : `Exited with code ${exitCode}.`)
    }
    // No exit report: the connection ended first. The node stops the job when it sees that, and
    // is asked again here in case the connection only broke on this side.
    await transport.exec({ command: buildStopCommand(job.id), timeoutMs: this.probeTimeoutMs }).done.catch(() => undefined)
    if (active.cancelRequested) return this.cancelled(job, active, 'Cancelled; the connection was dropped and the node told to stop it.')
    if (result.timedOut) return this.finish(job, 'timed-out', `No result within ${job.timeoutSec} s plus ${Math.round(this.localGraceMs / 1000)} s grace; the connection was dropped.`)
    if (!started) {
      const why = lastLines(job.stderrTail) || result.error || `ssh exited ${result.code ?? result.signal}`
      this.markNode(node.id, false, why)
      return this.finish(job, 'failed', `Could not start it on ${node.id}: ${why}`)
    }
    this.markNode(node.id, false, result.error ?? 'connection lost')
    return this.finish(job, 'lost', `The connection to ${node.id} ended before the job reported an exit code${result.error ? ` (${result.error})` : ''}.`)
  }

  private stepFailed(job: RemoteJob, node: ExecutionNode, what: string, result: ExecResult, output: string): void {
    const why = lastLines(output) || result.error || (result.timedOut ? 'timed out' : `exit ${result.code}`)
    if (result.code === 255 || result.error) this.markNode(node.id, false, why)
    this.finish(job, 'failed', `Failed while ${what}: ${why}`)
  }
}

export const barePath = (node: Pick<ExecutionNode, 'root'>, repo: string): string => `${node.root}/repos/${repo}.git`
export const workPath = (node: Pick<ExecutionNode, 'root'>, repo: string): string => `${node.root}/work/${repo}`

/**
 * Brings the node's own checkout to one commit. The commit arrives by push into the node's bare
 * repository, so the node needs no GitHub access and nothing depends on the commit being published;
 * the job's ref is removed again once the checkout has the objects.
 */
export function syncScript(node: Pick<ExecutionNode, 'root'>, repo: string, ref: string, commit: string): string {
  return [
    'set -e',
    `bare="$HOME/"${shQuote(barePath(node, repo))}`,
    `work="$HOME/"${shQuote(workPath(node, repo))}`,
    `ref=${shQuote(ref)}`,
    `commit=${shQuote(commit)}`,
    'if [ ! -d "$work/.git" ]; then mkdir -p "$(dirname "$work")"; git clone -q "$bare" "$work" 2>/dev/null || git init -q "$work"; fi',
    'cd "$work"',
    'git fetch -q "$bare" "+$ref:$ref"',
    'git checkout -q --detach --force "$commit"',
    'git clean -fdq',
    'git update-ref -d "$ref"',
    'git --git-dir="$bare" update-ref -d "$ref"',
    'test "$(git rev-parse HEAD)" = "$commit"'
  ].join('\n')
}
