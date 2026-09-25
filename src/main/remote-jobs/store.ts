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
 */
export const REMOTE_JOB_RETENTION = 300

const writeJson = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporary, path)
}

export type LogStream = 'stdout' | 'stderr'

export class RemoteJobStore {
  readonly root: string
  private nodes: ExecutionNode[] = []
  private readonly jobs = new Map<string, RemoteJob>()

  constructor(root: string) {
    this.root = root
    mkdirSync(join(root, 'jobs'), { recursive: true })
    const nodesFile = join(root, 'nodes.json')
    if (existsSync(nodesFile)) {
      const stored = JSON.parse(readFileSync(nodesFile, 'utf8')) as { nodes?: ExecutionNode[] }
      this.nodes = Array.isArray(stored.nodes) ? stored.nodes : []
    }
    for (const id of readdirSync(join(root, 'jobs'))) {
      try { this.jobs.set(id, JSON.parse(readFileSync(join(root, 'jobs', id, 'job.json'), 'utf8')) as RemoteJob) } catch { /* a directory without a readable record is not a job */ }
    }
  }

  get knownHostsFile(): string { return join(this.root, 'known_hosts') }

  listNodes(): ExecutionNode[] { return this.nodes.map(node => ({ ...node })) }
  getNode(id: string): ExecutionNode | undefined {
    const node = this.nodes.find(entry => entry.id === id)
    return node ? { ...node } : undefined
  }
  saveNode(node: ExecutionNode): void {
    this.nodes = [...this.nodes.filter(entry => entry.id !== node.id), node].sort((a, b) => a.id.localeCompare(b.id))
    writeJson(join(this.root, 'nodes.json'), { version: 1, nodes: this.nodes })
  }
  removeNode(id: string): void {
    this.nodes = this.nodes.filter(entry => entry.id !== id)
    writeJson(join(this.root, 'nodes.json'), { version: 1, nodes: this.nodes })
  }

  listJobs(): RemoteJob[] { return [...this.jobs.values()].map(job => ({ ...job })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)) }
  getJob(id: string): RemoteJob | undefined {
    const job = this.jobs.get(id)
    return job ? { ...job } : undefined
  }
  jobDir(id: string): string { return join(this.root, 'jobs', id) }
  logPath(id: string, stream: LogStream): string { return join(this.jobDir(id), `${stream}.log`) }

  saveJob(job: RemoteJob): void {
    mkdirSync(this.jobDir(job.id), { recursive: true })
    this.jobs.set(job.id, { ...job })
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
      rmSync(this.jobDir(id), { recursive: true, force: true })
    }
    return removed
  }
}
