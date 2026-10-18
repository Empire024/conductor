import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createGunzip } from 'node:zlib'
import { ARTIFACT_CAP_BYTES, buildFetchCommand, checkArtifactPatterns, parseFetchMarks, TarExtractor, type ArtifactFetch } from './artifacts.ts'
import { nodeCapabilities, nodeReadiness, normalizeCapability, parseProbe, PROBE_SCRIPT, selectNode } from './capabilities.ts'
import { buildCancelCommand, buildCleanCommand, buildFollowCommand, buildJobCommand, buildLaunchCommand, buildScriptCommand, buildStopCommand, FrameReader, MarkerScanner, shQuote } from './shell.ts'
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
  /** How long one follow session of a detached job streams before it reconnects. */
  followSeconds?: number
  /** Reconnect backoff while a detached job's node cannot be reached. */
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** How long past its deadline a detached job may go unheard before it is recorded as lost. */
  detachedGraceMs?: number
  artifactCapBytes?: number
  artifactTimeoutMs?: number
  /** How often a waiting nodes.log looks for new output. */
  logPollMs?: number
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

/** The length of the longest prefix of `buffer` that ends on a UTF-8 character boundary. */
export function utf8Boundary(buffer: Buffer): number {
  for (let back = 1; back <= Math.min(4, buffer.length); back++) {
    const byte = buffer[buffer.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return need > back ? buffer.length - back : buffer.length
  }
  return buffer.length
}

export interface LogRange {
  text: string
  /** Byte offset the text starts at, and the one to pass next time. */
  offset: number
  nextOffset: number
  size: number
  /** The job has ended and nothing is left past nextOffset. */
  done: boolean
  path: string
}

interface Active {
  cancelRequested: boolean
  cancelReason: string | null
  cancelRequestedAt: string | null
  handle: ExecHandle | null
  /** What the handle is: a detached launch is never cut short, a follow session may be. */
  phase: 'prepare' | 'launch' | 'run' | 'follow' | 'wait'
  /** Stop following a detached job and leave it running (quit); a later process reattaches. */
  detaching: boolean
  wake: (() => void) | null
  /** Writes the follower's copy of the record now (a cancel request must survive a restart). */
  persist: (() => void) | null
}

const newActive = (cancelReason: string | null = null, cancelRequestedAt: string | null = null): Active =>
  ({ cancelRequested: Boolean(cancelRequestedAt), cancelReason, cancelRequestedAt, handle: null, phase: 'prepare', detaching: false, wake: null, persist: null })

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
  private readonly followSeconds: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly detachedGraceMs: number
  private readonly artifactCapBytes: number
  private readonly artifactTimeoutMs: number
  private readonly logPollMs: number
  private stopping = false

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
    this.followSeconds = options.followSeconds ?? 300
    this.reconnectMinMs = options.reconnectMinMs ?? 2_000
    this.reconnectMaxMs = options.reconnectMaxMs ?? 60_000
    this.detachedGraceMs = options.detachedGraceMs ?? 30 * 60_000
    this.artifactCapBytes = options.artifactCapBytes ?? ARTIFACT_CAP_BYTES
    this.artifactTimeoutMs = options.artifactTimeoutMs ?? 30 * 60_000
    this.logPollMs = options.logPollMs ?? 250
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

  /**
   * A log from a byte offset, ending on a character boundary. When there is nothing past the
   * offset yet and the job still runs, waits up to waitMs for more: a tab follows a run with
   * offset = the previous nextOffset until done.
   */
  async readLogFrom(id: string, stream: LogStream, offset: number, bytes = 64 * 1024, waitMs = 0): Promise<LogRange> {
    this.getJob(id)
    const limit = Math.min(Math.max(1, bytes), 1024 * 1024)
    const deadline = Date.now() + Math.max(0, waitMs)
    for (;;) {
      const terminal = TERMINAL_REMOTE_JOB_STATUSES.includes(this.getJob(id).status)
      const { buffer, size } = this.store.readLogRange(id, stream, offset, limit)
      if (offset > size) throw new Error(`offset ${offset} is past the end of the ${stream} log (${size} bytes); start from 0 or a nextOffset it returned`)
      // Whole characters only, unless nothing more can come or the bytes are not UTF-8 at all.
      const cut = utf8Boundary(buffer)
      const whole = (terminal && offset + buffer.length >= size) || (cut === 0 && buffer.length >= 4) ? buffer.length : cut
      if (whole || terminal || Date.now() >= deadline) {
        const nextOffset = offset + whole
        return { text: buffer.subarray(0, whole).toString('utf8'), offset, nextOffset, size, done: terminal && nextOffset >= size, path: this.store.logPath(id, stream) }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(this.logPollMs, Math.max(1, deadline - Date.now()))))
    }
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
    const artifacts = input.artifacts === undefined ? [] : checkArtifactPatterns(input.artifacts)
    if (artifacts.length && !input.artifactsRoot) throw new Error('artifacts need a folder on this machine to land in')
    const node = await this.placement(input.nodeId, requires)
    let checkout: RemoteJob['checkout'] = null
    if (input.checkout) {
      const repo = (input.checkout.repo ?? basename(input.checkout.localRepoPath)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
      if (!repo) throw new Error('checkout.repo must name the repository')
      checkout = { repo, commit: await this.resolveCommit(input.checkout.localRepoPath, input.checkout.commit ?? 'HEAD'), localRepoPath: input.checkout.localRepoPath }
    }
    const id = this.newId()
    const job: RemoteJob = {
      id,
      title: input.title?.trim().slice(0, 120) || command.replace(/\s+/g, ' ').trim().slice(0, 80),
      nodeId: node.id, requires, command,
      cwd: checkout ? [workPath(node, checkout.repo), cwd].filter(Boolean).join('/') : cwd,
      checkout, timeoutSec, status: 'queued', detail: null, exitCode: null, remotePid: null,
      createdAt: this.now(), startedAt: null, endedAt: null,
      stdoutBytes: 0, stderrBytes: 0, stdoutTail: '', stderrTail: '',
      projectId: input.projectId ?? null, createdBy: input.createdBy ?? null, cancelReason: null, runnerPid: process.pid,
      detached: Boolean(input.detached), cancelRequestedAt: null,
      artifacts, artifactsDir: artifacts.length ? join(input.artifactsRoot!, id) : null, artifactFetch: null
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
    if (!active && job.detached && job.status === 'running') {
      // The node owns a detached job: any process may ask it to stop, and whoever follows the job
      // (another process, or this one after recover) records how it ended.
      const node = this.node(job.nodeId)
      const result = await this.transport(node).exec({ command: buildCancelCommand(job.id), timeoutMs: this.probeTimeoutMs }).done
      if (result.code !== 0) throw new Error(`Could not reach ${node.id} to cancel ${id}: ${result.error ?? `exit ${result.code}`}; try again when it is online`)
      return this.getJob(id)
    }
    if (!active && job.runnerPid !== null && job.runnerPid !== process.pid && this.isAlive(job.runnerPid)) {
      throw new Error(`${id} is run by another process (pid ${job.runnerPid}); cancel it there`)
    }
    if (!active) {
      this.finish({ ...job, cancelReason: reason ?? null }, 'cancelled', 'Cancelled before it started.')
      return this.getJob(id)
    }
    active.cancelRequested = true
    active.cancelReason = reason ?? null
    active.cancelRequestedAt = this.now()
    if (job.status === 'preparing') active.handle?.kill()
    else if (job.detached) {
      // Reconnect at once with cancel=1; a launch in flight finishes first, then the follow cancels.
      active.persist?.()
      if (active.phase === 'follow') active.handle?.kill()
      active.wake?.()
    } else if (active.handle) {
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
   * After a restart. A detached job that was running is reattached: this process follows it from
   * the bytes it already has, and the node never noticed the gap. Any other job this process did
   * not start cannot be followed any more: it is recorded as lost, and its node is asked to stop
   * whatever is left of it (normally nothing: the ssh session ended with the old process, and the
   * wrapper stops an attached job when that happens).
   */
  async recover(): Promise<RemoteJob[]> {
    const orphans = this.store.listJobs().filter(job => ACTIVE.includes(job.status) && !this.active.has(job.id)
      && (job.runnerPid === null || job.runnerPid === process.pid || !this.isAlive(job.runnerPid)))
    const reattach = orphans.filter(job => job.detached && job.status === 'running')
    const ended = orphans.filter(job => !reattach.includes(job))
    for (const job of ended) {
      this.finish(job, job.status === 'queued' ? 'cancelled' : 'lost', job.status === 'queued' ? 'Conductor restarted before it started.' : 'Conductor restarted while it ran; the node was asked to stop what was left of it.')
    }
    for (const job of reattach) this.reattach(job)
    await Promise.all(ended.filter(job => job.status !== 'queued').map(async job => {
      const node = this.store.getNode(job.nodeId)
      if (node) await this.transport(node).exec({ command: buildStopCommand(job.id), timeoutMs: this.probeTimeoutMs }).done.catch(() => undefined)
    }))
    return orphans.map(job => this.getJob(job.id))
  }

  private reattach(stale: RemoteJob): void {
    const node = this.store.getNode(stale.nodeId)
    if (!node) { this.finish(stale, 'lost', 'Its node was removed while it ran detached.'); return }
    const job: RemoteJob = { ...stale, runnerPid: process.pid, detail: `Reattached to ${node.id} after Conductor restarted` }
    this.save(job)
    const active = newActive(job.cancelReason, job.cancelRequestedAt ?? null)
    this.track(job.id, active, () => this.follow(job, node, active))
  }

  /**
   * App quit. An attached job is stopped (its ssh session is about to end anyway); a detached one
   * keeps running on its node and the next start reattaches. Waits at most graceMs.
   */
  async shutdown(graceMs = 5_000): Promise<void> {
    this.stopping = true
    for (const [id, active] of [...this.active]) {
      const job = this.store.getJob(id)
      if (job?.detached && job.status === 'running') {
        active.detaching = true
        if (active.phase === 'follow') active.handle?.kill()
        active.wake?.()
      } else await this.cancel(id, 'Conductor is quitting')
    }
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
    if (this.stopping) return
    const queued = this.store.listJobs().filter(job => job.status === 'queued' && !this.active.has(job.id) && (job.runnerPid === null || job.runnerPid === process.pid)).reverse()
    for (const job of queued) {
      const node = this.store.getNode(job.nodeId)
      if (!node) { this.finish(job, 'failed', 'Its node was removed.'); continue }
      const busy = this.store.listJobs().filter(other => other.nodeId === node.id && (other.status === 'preparing' || other.status === 'running' || this.active.has(other.id)))
      if (busy.length >= node.maxConcurrentJobs) continue
      if (job.checkout && busy.some(other => other.checkout?.repo === job.checkout!.repo)) continue
      const active = newActive()
      this.track(job.id, active, () => this.run(job, node, active))
    }
  }

  private track(id: string, active: Active, body: () => Promise<void>): void {
    this.active.set(id, active)
    const run = body()
      .catch(error => { this.finish(this.getJob(id), 'failed', `Conductor failed to run it: ${error instanceof Error ? error.message : String(error)}`) })
      .finally(() => { this.active.delete(id); this.running.delete(run); this.pump() })
    this.running.add(run)
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
    if (job.detached) return this.launch(job, node, active)

    job = { ...job, status: 'running', detail: `Running on ${node.id}` }
    this.save(job)
    active.phase = 'run'
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
      if (reason === 'cancelled' && !active.cancelRequested) return this.finish(job, 'lost', 'The connection closed while it ran; the node stopped its processes.')
      job = await this.withArtifacts(job, node)
      if (reason === 'timeout') return this.finish(job, 'timed-out', `Stopped by the node after ${job.timeoutSec} s.`)
      if (reason === 'cancelled') return this.cancelled(job, active, 'Cancelled; the node stopped its processes.')
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

  /** Starts a detached job on its node, then follows it. */
  private async launch(queued: RemoteJob, node: ExecutionNode, active: Active): Promise<void> {
    let job: RemoteJob = { ...queued, status: 'running', detail: `Starting on ${node.id}` }
    this.save(job)
    active.phase = 'launch'
    const transport = this.transport(node)
    const nonce = this.nonce()
    const scanner = new MarkerScanner(nonce)
    let output = ''
    const seen: { pid: number | null; error: string | null } = { pid: null, error: null }
    const handle = transport.exec({
      command: buildLaunchCommand({ jobId: job.id, cwd: job.cwd, timeoutSec: job.timeoutSec, command: job.command, nonce }),
      timeoutMs: this.probeTimeoutMs + 30_000,
      onStdout: chunk => { output = tail(output + chunk, 4000) },
      onStderr: chunk => {
        const { text, events } = scanner.push(chunk)
        output = tail(output + text, 4000)
        for (const event of events) {
          if (event.kind === 'started') seen.pid = event.pid
          else if (event.kind === 'error') seen.error = event.error
        }
      }
    })
    active.handle = handle
    const result = await handle.done
    active.handle = null
    if (seen.pid === null) {
      if (seen.error === 'cwd') return this.finish(job, 'failed', `The working directory ${job.cwd || '~'} does not exist on ${node.id}.`)
      if (seen.error) return this.finish(job, 'failed', `The node could not start the job (${seen.error}).`)
      // The launch may have got as far as starting it: make sure nothing half-started runs on.
      await transport.exec({ command: buildCancelCommand(job.id), timeoutMs: this.probeTimeoutMs }).done.catch(() => undefined)
      if (active.cancelRequested) return this.cancelled(job, active, 'Cancelled before it started.')
      const why = lastLines(output) || result.error || (result.timedOut ? 'no answer' : `ssh exited ${result.code ?? result.signal}`)
      this.markNode(node.id, false, why)
      return this.finish(job, 'failed', `Could not start it on ${node.id}: ${why}`)
    }
    this.markNode(node.id, true, null)
    job = { ...job, remotePid: seen.pid, detail: `Running detached on ${node.id}` }
    this.save(job)
    return this.follow(job, node, active)
  }

  /**
   * Follows a detached job: one ssh session streams its output from the byte offsets already
   * here, and is renewed when it expires or breaks, with backoff while the node is unreachable
   * (asleep, offline, this machine asleep). The local log files mirror the node's byte for byte,
   * so their sizes are the offsets, before and after a restart.
   */
  private async follow(start: RemoteJob, node: ExecutionNode, active: Active): Promise<void> {
    let job = start
    const transport = this.transport(node)
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const giveUpAt = Date.parse(job.startedAt ?? job.createdAt) + job.timeoutSec * 1000 + this.detachedGraceMs
    let lastContact = Date.now()
    let backoff = this.reconnectMinMs
    let dirty = false
    active.persist = () => {
      if (active.cancelRequested) job = { ...job, cancelReason: active.cancelReason, cancelRequestedAt: active.cancelRequestedAt }
      dirty = false
      this.save(job)
    }
    const flush = setInterval(() => { if (dirty) active.persist?.() }, 2_000)
    flush.unref?.()
    try {
      for (;;) {
        if (active.detaching) { active.persist(); return }
        const nonce = this.nonce()
        const reader = new FrameReader(nonce)
        const seen: { end: { exit: number; reason: 'timeout' | 'cancelled' | null } | 'gone' | 'dead' | null; contact: boolean } = { end: null, contact: false }
        let stderr = ''
        const cancel = active.cancelRequested
        active.phase = 'follow'
        const handle = transport.exec({
          command: buildFollowCommand({ jobId: job.id, stdoutOffset: this.store.logSize(job.id, 'stdout'), stderrOffset: this.store.logSize(job.id, 'stderr'), maxSeconds: this.followSeconds, nonce, cancel }),
          timeoutMs: (this.followSeconds + 60) * 1000,
          onStdoutBytes: chunk => {
            for (const event of reader.push(chunk)) {
              seen.contact = true
              if (event.kind === 'gone') { seen.end = 'gone'; continue }
              for (const stream of ['stdout', 'stderr'] as const) {
                const bytes = event[stream]
                if (!bytes.length) continue
                this.store.appendLog(job.id, stream, bytes)
                const text = decoders[stream].write(bytes)
                job = stream === 'stdout'
                  ? { ...job, stdoutBytes: job.stdoutBytes + bytes.length, stdoutTail: tail(job.stdoutTail + text, this.tailChars) }
                  : { ...job, stderrBytes: job.stderrBytes + bytes.length, stderrTail: tail(job.stderrTail + text, this.tailChars) }
                dirty = true
              }
              if (event.pid && event.pid !== job.remotePid) { job = { ...job, remotePid: event.pid }; dirty = true }
              if (event.exit !== null) seen.end = { exit: event.exit, reason: event.reason }
              else if (!event.alive) seen.end = 'dead'
            }
          },
          onStderr: chunk => { stderr = tail(stderr + chunk, 4000) }
        })
        active.handle = handle
        const result = await handle.done
        active.handle = null
        active.phase = 'wait'
        if (seen.contact) {
          lastContact = Date.now()
          backoff = this.reconnectMinMs
          this.markNode(node.id, true, null)
        }
        const end = seen.end
        if (end !== null) {
          active.persist()
          if (end === 'gone') return active.cancelRequested
            ? this.cancelled(job, active, `Cancelled; ${node.id} no longer had it.`)
            : this.finish(job, 'lost', `${node.id} has no record of it any more (its state folder is gone).`)
          if (end === 'dead') return active.cancelRequested
            ? this.cancelled(job, active, `Cancelled; ${node.id} had already lost it.`)
            : this.finish(job, 'lost', `${node.id} lost it before it reported an exit code (the node restarted, or its supervisor was killed).`)
          return this.ended(job, node, active, end.exit, end.reason)
        }
        if (active.detaching) { active.persist(); return }
        // A cancel asked for during this session: reconnect at once to deliver it.
        if (active.cancelRequested && !cancel) continue
        // The session ran its course: renew it.
        if (seen.contact && result.code === 0) continue
        if (!seen.contact) this.markNode(node.id, false, lastLines(stderr) || result.error || (result.timedOut ? 'no answer' : `ssh exited ${result.code ?? result.signal}`))
        if (Date.now() > giveUpAt && Date.now() - lastContact > this.detachedGraceMs) {
          active.persist()
          return this.finish(job, 'lost', `No contact with ${node.id} for ${Math.round((Date.now() - lastContact) / 60_000)} min, past its deadline; whatever it did there is unknown.`)
        }
        await this.pause(active, backoff)
        backoff = Math.min(backoff * 2, this.reconnectMaxMs)
      }
    } finally {
      clearInterval(flush)
      active.persist = null
    }
  }

  private pause(active: Active, ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); active.wake = null; resolve() }
      const timer = setTimeout(done, ms)
      active.wake = done
    })
  }

  /** A detached job reported its exit: bring back its artifacts, clear its state on the node, record it. */
  private async ended(start: RemoteJob, node: ExecutionNode, active: Active, exitCode: number, reason: 'timeout' | 'cancelled' | null): Promise<void> {
    let job: RemoteJob = { ...start, exitCode }
    job = await this.withArtifacts(job, node)
    await this.transport(node).exec({ command: buildCleanCommand(job.id), timeoutMs: this.probeTimeoutMs }).done.catch(() => undefined)
    if (reason === 'timeout') return this.finish(job, 'timed-out', `Stopped by the node after ${job.timeoutSec} s.`)
    if (reason === 'cancelled') return this.finish({ ...job, cancelReason: active.cancelReason ?? job.cancelReason ?? 'cancelled on the node' }, 'cancelled', 'Cancelled; the node stopped its processes.')
    return this.finish(job, exitCode === 0 ? 'succeeded' : 'failed', exitCode === 0 ? null : `Exited with code ${exitCode}.`)
  }

  /** The job's automatic artifact fetch, when it asked for one; a failed fetch never fails the job. */
  private async withArtifacts(job: RemoteJob, node: ExecutionNode): Promise<RemoteJob> {
    if (!job.artifacts?.length || !job.artifactsDir) return job
    this.save({ ...job, detail: `Fetching artifacts from ${node.id}` })
    return { ...job, artifactFetch: await this.fetchInto(job, node, job.artifacts, job.artifactsDir) }
  }

  /**
   * Brings paths or globs under a job's working directory back into `dir` (nodes.fetch). Works
   * while the job runs and after it ended, as long as the files are still on the node.
   */
  async fetchArtifacts(id: string, patterns: string[], dir: string): Promise<ArtifactFetch> {
    const job = this.getJob(id)
    const fetched = await this.fetchInto(job, this.node(job.nodeId), checkArtifactPatterns(patterns), dir)
    // The record is only this process's to write once nobody follows the job any more.
    const current = this.getJob(id)
    if (TERMINAL_REMOTE_JOB_STATUSES.includes(current.status)) this.save({ ...current, artifactFetch: fetched })
    return fetched
  }

  private async fetchInto(job: RemoteJob, node: ExecutionNode, patterns: string[], dir: string): Promise<ArtifactFetch> {
    const cap = this.artifactCapBytes
    const fetched: ArtifactFetch = { at: this.now(), dir, patterns, files: 0, bytes: 0, skipped: [], missing: [], error: null }
    let extractor: TarExtractor
    try { extractor = new TarExtractor(dir, cap) } catch (error) { return { ...fetched, error: `Cannot write ${dir}: ${error instanceof Error ? error.message : String(error)}` } }
    const nonce = this.nonce()
    const gunzip = createGunzip()
    const unpacked = new Promise<string | null>(resolve => { gunzip.once('end', () => resolve(null)); gunzip.once('error', error => resolve(error.message)) })
    gunzip.on('data', (chunk: Buffer) => { extractor.push(chunk); if (extractor.error) stop() })
    let received = 0
    let overCap = false
    let stderr = ''
    let handle: ExecHandle | null = null
    const stop = (): void => { handle?.kill() }
    handle = this.transport(node).exec({
      command: buildFetchCommand({ cwd: job.cwd, capBytes: cap, nonce, patterns }),
      timeoutMs: this.artifactTimeoutMs,
      onStdoutBytes: chunk => {
        if (overCap || extractor.done) return
        received += chunk.length
        if (received > cap) { overCap = true; stop(); return }
        gunzip.write(chunk)
      },
      onStderr: chunk => { stderr = tail(stderr + chunk, 64_000) }
    })
    const result = await handle.done
    let unzipError: string | null = null
    if (received && !overCap && !extractor.error) { gunzip.end(); unzipError = await unpacked } else gunzip.destroy()
    extractor.finish()
    const { marks, other } = parseFetchMarks(stderr, nonce)
    fetched.files = extractor.files
    fetched.bytes = extractor.bytes
    fetched.missing = marks.flatMap(mark => mark.kind === 'missing' ? [mark.pattern] : [])
    fetched.skipped = [...marks.flatMap(mark => mark.kind === 'skipped' ? [`${mark.path} (symbolic link or outside the working directory)`] : []), ...extractor.skipped]
    const tooLarge = marks.find(mark => mark.kind === 'too-large')
    const markError = marks.find(mark => mark.kind === 'error')
    const tar = marks.find(mark => mark.kind === 'tar')
    fetched.error = tooLarge && tooLarge.kind === 'too-large' ? `The matches are ${tooLarge.bytes} bytes, over the ${cap}-byte cap; fetch a narrower path`
      : markError && markError.kind === 'error' ? (markError.error === 'cwd' ? `The working directory ${job.cwd || '~'} is gone from ${node.id}` : `The node could not pack them (${markError.error})`)
        : overCap ? `More than ${cap} bytes arrived; stopped`
          : extractor.error ?? unzipError
            ?? (tar && tar.kind === 'tar' && tar.code !== 0 ? `tar on ${node.id} exited ${tar.code}: ${lastLines(other) || 'no output'}` : null)
            ?? (result.code !== 0 ? `The fetch from ${node.id} failed: ${lastLines(other) || result.error || (result.timedOut ? 'timed out' : `exit ${result.code ?? result.signal}`)}` : null)
    if (result.code === 0) this.markNode(node.id, true, null)
    return fetched
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
