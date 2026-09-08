import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ConductorDatabase } from './database'
import {
  commitLogFormat,
  commitUrl,
  compareUrl,
  mergeFileStatuses,
  parseCommitLog,
  parseNameStatus,
  parseNumstat,
  parseRemoteUrl,
  type SourceControlChangeSet,
  type SourceControlRemote,
  type SourceControlStatus
} from '../shared/source-control'

const run = promisify(execFile)
const setting = (projectId: string): string => 'sourceControl:' + projectId
const patchLimit = 400_000

/** Read-only git. Conductor never commits, pushes, or rewrites the owner's history. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['--no-pager', ...args], { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  return stdout.toString()
}

interface Cached<T> { value: T; at: number }

export class SourceControl {
  private status = new Map<string, Cached<SourceControlStatus>>()
  private heads = new Map<string, Cached<string | undefined>>()
  constructor(private readonly database: ConductorDatabase) {}

  /** The owner decides per project; a repository is only detected, never created. */
  setEnabled(projectId: string, enabled: boolean): void {
    this.database.setSetting(setting(projectId), enabled ? 'on' : 'off')
    this.status.delete(projectId)
    this.heads.delete(projectId)
  }

  isEnabled(projectId: string): boolean {
    return this.database.getSetting(setting(projectId)) !== 'off'
  }

  async describe(projectId: string): Promise<SourceControlStatus> {
    const cached = this.status.get(projectId)
    if (cached && Date.now() - cached.at < 5_000) return { ...cached.value, enabled: this.isEnabled(projectId) }
    const enabled = this.isEnabled(projectId)
    const project = this.database.getProject(projectId)
    if (!project) return { projectId, available: false, enabled, reason: 'This project is no longer loaded.' }
    let value: SourceControlStatus
    try {
      const root = (await git(project.path, ['rev-parse', '--show-toplevel'])).trim()
      const branch = (await git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      const head = await this.head(projectId)
      value = { projectId, available: Boolean(root), enabled, branch: branch === 'HEAD' ? undefined : branch, head, remote: await this.remote(project.path) }
    } catch (error) {
      value = { projectId, available: false, enabled, reason: reason(error) }
    }
    this.status.set(projectId, { value, at: Date.now() })
    return value
  }

  /** The commit a task change was recorded against. Undefined outside a repository. */
  async head(projectId: string): Promise<string | undefined> {
    const cached = this.heads.get(projectId)
    if (cached && Date.now() - cached.at < 2_000) return cached.value
    const project = this.database.getProject(projectId)
    let value: string | undefined
    if (project && this.isEnabled(projectId)) {
      try { value = (await git(project.path, ['rev-parse', 'HEAD'])).trim() || undefined } catch { value = undefined }
    }
    this.heads.set(projectId, { value, at: Date.now() })
    return value
  }

  private async remote(cwd: string): Promise<SourceControlRemote | undefined> {
    const names = ['origin', ...(await git(cwd, ['remote'])).split('\n').map(name => name.trim()).filter(Boolean)]
    for (const name of names) {
      try {
        const url = (await git(cwd, ['remote', 'get-url', name])).trim()
        const remote = parseRemoteUrl(url)
        if (remote) return remote
      } catch { /* A missing or unreadable remote simply has no web link. */ }
    }
    return undefined
  }

  /** Everything the repository recorded between a task's first and last movement. */
  async changes(projectId: string, taskId: string, base?: string, head?: string): Promise<SourceControlChangeSet> {
    const status = await this.describe(projectId)
    const project = this.database.getProject(projectId)
    if (!project) throw new Error('This project is no longer loaded.')
    if (!status.enabled) return { taskId, commits: [], files: [], note: 'Repository links are turned off for this project.' }
    if (!status.available) return { taskId, commits: [], files: [], note: status.reason ?? 'This project folder is not a git repository.' }
    const to = head ?? status.head
    if (!to) return { taskId, commits: [], files: [], note: 'This repository has no commits yet.' }
    if (base === to) return { taskId, base, head: to, commits: [], files: [], note: 'No commits landed while this task was open.' }
    const from = base
    const range = from ? from + '..' + to : to + '~1..' + to
    const changes: SourceControlChangeSet = { taskId, base: from, head: to, commits: [], files: [], compareUrl: compareUrl(status.remote, from, to) }
    try {
      changes.commits = parseCommitLog(await git(project.path, ['log', '--no-color', '--max-count=60', '--pretty=format:' + commitLogFormat, range]))
        .map(commit => ({ ...commit, url: commitUrl(status.remote, commit.sha) }))
      const files = parseNumstat(await git(project.path, ['diff', '--numstat', '-M', '--no-color', range]))
      changes.files = mergeFileStatuses(files, parseNameStatus(await git(project.path, ['diff', '--name-status', '-M', '--no-color', range])))
      const patch = await git(project.path, ['diff', '-M', '--no-color', '--stat=200', '--patch', range])
      changes.patch = patch.slice(0, patchLimit)
      changes.patchTruncated = patch.length > patchLimit
    } catch (error) {
      return { ...changes, note: reason(error) }
    }
    if (!changes.commits.length && !changes.files.length) changes.note = from ? 'No commits landed while this task was open.' : 'The recorded commit is the current one; nothing to compare yet.'
    return changes
  }
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT/.test(message)) return 'Git is not installed or is not on this machine\u2019s PATH.'
  if (/not a git repository/i.test(message)) return 'This project folder is not a git repository.'
  return message.split('\n').slice(0, 2).join(' ').slice(0, 300)
}
