import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutionNode, RemoteJob } from './types.ts'
import { TERMINAL_REMOTE_JOB_STATUSES } from './types.ts'

/**
 * Nodes and jobs on disk, apart from the (very large) journal database: nodes.json, and one
 * directory per job with job.json, stdout.log and stderr.log. Plain files, so the logs can be
 * opened directly and a command-line tool on this machine sees the same records the app does.
 *
 * Every JSON write goes to a temporary file first and is renamed over the old one, so a crash
 * leaves either the old record or the new one, never half of one.
 *
 * The app and scripts/mac-node.mjs may use one folder at the same time. Each process owns the jobs
 * it runs; records another process writes are re-read from disk until they are finished, and
 * nodes.json is re-read whenever it changed on disk.
 */
export const REMOTE_JOB_RETENTION = 300

const writeJson = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

const stampOf = (file: string): string => { const stat = statSync(file); return `${stat.mtimeMs}:${stat.size}:${stat.ino}` }

export type LogStream = 'stdout' | 'stderr'

export class RemoteJobStore {
  readonly root: string
  private nodes: ExecutionNode[] = []
  private nodesStamp = ''
  private readonly jobs = new Map<string, RemoteJob>()
  /** Jobs whose latest record this process wrote; the rest are re-read until finished. */
  private readonly written = new Set<string>()

  constructor(root: string) {
    this.root = root
    mkdirSync(join(root, 'jobs'), { recursive: true })
    this.refreshNodes()
    this.refreshJobs()
  }

  private refreshNodes(): void {
    const file = join(this.root, 'nodes.json')
    const stamp = existsSync(file) ? stampOf(file) : ''
    if (stamp === this.nodesStamp) return
    this.nodesStamp = stamp
    if (!stamp) { this.nodes = []; return }
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { nodes?: ExecutionNode[] }
    this.nodes = Array.isArray(stored.nodes) ? stored.nodes : []
  }

  private refreshJob(id: string): void {
    const known = this.jobs.get(id)
    if (known && (this.written.has(id) || TERMINAL_REMOTE_JOB_STATUSES.includes(known.status))) return
    try { this.jobs.set(id, JSON.parse(readFileSync(join(this.root, 'jobs', id, 'job.json'), 'utf8')) as RemoteJob) } catch { /* a directory without a readable record is not a job */ }
  }

  private refreshJobs(): void {
    const present = new Set(readdirSync(join(this.root, 'jobs')))
    for (const id of present) this.refreshJob(id)
    for (const id of this.jobs.keys()) if (!present.has(id)) this.jobs.delete(id)
  }

  get knownHostsFile(): string { return join(this.root, 'known_hosts') }

  listNodes(): ExecutionNode[] { this.refreshNodes(); return this.nodes.map(node => ({ ...node })) }
  getNode(id: string): ExecutionNode | undefined {
    this.refreshNodes()
    const node = this.nodes.find(entry => entry.id === id)
    return node ? { ...node } : undefined
  }
  saveNode(node: ExecutionNode): void {
    this.refreshNodes()
    this.nodes = [...this.nodes.filter(entry => entry.id !== node.id), node].sort((a, b) => a.id.localeCompare(b.id))
    this.writeNodes()
  }
  removeNode(id: string): void {
    this.refreshNodes()
    this.nodes = this.nodes.filter(entry => entry.id !== id)
    this.writeNodes()
  }
  private writeNodes(): void {
    const file = join(this.root, 'nodes.json')
    writeJson(file, { version: 1, nodes: this.nodes })
    this.nodesStamp = stampOf(file)
  }

  listJobs(): RemoteJob[] {
    this.refreshJobs()
    return [...this.jobs.values()].map(job => ({ ...job })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)) }
  getJob(id: string): RemoteJob | undefined {
    if (/^[\w-]+$/.test(id) && existsSync(join(this.root, 'jobs', id))) this.refreshJob(id)
    const job = this.jobs.get(id)
    return job ? { ...job } : undefined
  }
  jobDir(id: string): string { return join(this.root, 'jobs', id) }
  logPath(id: string, stream: LogStream): string { return join(this.jobDir(id), `${stream}.log`) }

  saveJob(job: RemoteJob): void {
    mkdirSync(this.jobDir(job.id), { recursive: true })
    this.jobs.set(job.id, { ...job })
    this.written.add(job.id)
    writeJson(join(this.jobDir(job.id), 'job.json'), job)
  }

  appendLog(id: string, stream: LogStream, text: string): void {
    if (text) appendFileSync(this.logPath(id, stream), text)
  }

  /** The last `bytes` of a log, from the file, so it is right even after a restart. */
  readLog(id: string, stream: LogStream, bytes: number): { text: string; size: number } {
    const path = this.logPath(id, stream)
    if (!existsSync(path)) return { text: '', size: 0 }
    const size = statSync(path).size
    const buffer = readFileSync(path)
    return { text: buffer.subarray(Math.max(0, size - bytes)).toString('utf8'), size }
  }

  /** Drops the oldest finished jobs beyond the retention count, logs and all. */
  prune(keep = REMOTE_JOB_RETENTION): string[] {
    const finished = this.listJobs().filter(job => TERMINAL_REMOTE_JOB_STATUSES.includes(job.status))
    const removed = finished.slice(keep).map(job => job.id)
    for (const id of removed) {
      this.jobs.delete(id)
      this.written.delete(id)
      rmSync(this.jobDir(id), { recursive: true, force: true })
    }
    return removed
  }
}
