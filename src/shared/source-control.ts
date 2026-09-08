/** Repository facts Conductor shows next to project tasks. Never a credential or a token. */
export interface SourceControlRemote { webUrl: string; host: 'github' | 'other'; owner?: string; repo?: string }

export interface SourceControlStatus {
  projectId: string
  /** The project folder is inside a working repository and git could be run. */
  available: boolean
  /** The owner turned repository links on for this project. */
  enabled: boolean
  branch?: string
  head?: string
  remote?: SourceControlRemote
  /** Why links are unavailable, in the owner's words. */
  reason?: string
}

export interface SourceControlCommit { sha: string; author: string; date: string; subject: string; url?: string }
export interface SourceControlFile { path: string; status: string; additions?: number; deletions?: number }
export interface SourceControlChangeSet {
  taskId: string
  base?: string
  head?: string
  commits: SourceControlCommit[]
  files: SourceControlFile[]
  patch?: string
  /** Truncated patches stay honest instead of pretending to be the whole diff. */
  patchTruncated?: boolean
  compareUrl?: string
  note?: string
}

const trim = (value: string): string => value.replace(/\.git$/i, '').replace(/\/+$/, '')

/** Accept the SSH, HTTPS and scp-style forms git prints, without ever keeping credentials. */
export function parseRemoteUrl(remote: string): SourceControlRemote | null {
  const raw = remote.trim()
  if (!raw) return null
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(raw)
  const url = scp ? { hostname: scp[1]!, pathname: '/' + scp[2]! } : safeUrl(raw)
  if (!url || !url.hostname) return null
  const path = trim(url.pathname.replace(/^\/+/, ''))
  if (!path) return null
  const parts = path.split('/')
  const github = url.hostname.toLowerCase() === 'github.com'
  const webUrl = 'https://' + url.hostname.toLowerCase() + '/' + path
  if (!github) return { webUrl, host: 'other' }
  if (parts.length < 2) return null
  return { webUrl: 'https://github.com/' + parts[0] + '/' + parts[1], host: 'github', owner: parts[0], repo: parts[1] }
}

function safeUrl(raw: string): { hostname: string; pathname: string } | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null
    return { hostname: url.hostname, pathname: url.pathname }
  } catch { return null }
}

export function commitUrl(remote: SourceControlRemote | undefined, sha: string): string | undefined {
  if (!remote || remote.host !== 'github' || !/^[0-9a-f]{7,40}$/i.test(sha)) return undefined
  return remote.webUrl + '/commit/' + sha
}

/** A range link when both ends are known, otherwise the single commit that carries the work. */
export function compareUrl(remote: SourceControlRemote | undefined, base: string | undefined, head: string | undefined): string | undefined {
  if (!remote || remote.host !== 'github' || !head) return undefined
  if (!base || base === head) return commitUrl(remote, head)
  if (!/^[0-9a-f]{7,40}$/i.test(base)) return undefined
  return remote.webUrl + '/compare/' + base + '...' + head
}

const separator = String.fromCharCode(30)
const field = String.fromCharCode(31)
export const commitLogFormat = '%H%x1f%an%x1f%aI%x1f%s%x1e'

export function parseCommitLog(text: string): SourceControlCommit[] {
  return text.split(separator).map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [sha = '', author = '', date = '', subject = ''] = entry.split(field)
    return { sha, author, date, subject }
  }).filter(commit => /^[0-9a-f]{7,40}$/i.test(commit.sha))
}

/** `git diff --numstat -M` counts; binary files report `-` instead of a number. */
export function parseNumstat(text: string): SourceControlFile[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [additions = '', deletions = '', ...rest] = line.split('\t')
    const path = renamedPath(rest.join('\t'))
    return { path, status: 'modified', additions: count(additions), deletions: count(deletions) }
  }).filter(file => Boolean(file.path))
}

/** `git diff --name-status -M` letters, so renames and deletions are not shown as edits. */
export function parseNameStatus(text: string): Map<string, string> {
  const statuses = new Map<string, string>()
  const names: Record<string, string> = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'retyped' }
  for (const line of text.split('\n')) {
    const parts = line.trim().split('\t').filter(Boolean)
    if (parts.length < 2) continue
    const letter = parts[0]![0]!.toUpperCase()
    statuses.set(parts.at(-1)!, names[letter] ?? 'modified')
  }
  return statuses
}

export function mergeFileStatuses(files: SourceControlFile[], statuses: Map<string, string>): SourceControlFile[] {
  return files.map(file => ({ ...file, status: statuses.get(file.path) ?? file.status }))
}

function count(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined
}

/** Renames arrive as `old => new` or `dir/{old => new}/file`. Show where the file lives now. */
function renamedPath(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
  if (braced) return (braced[1]! + braced[3]! + braced[4]!).replace(/\/{2,}/g, '/')
  const arrow = path.split(' => ')
  return (arrow.length > 1 ? arrow.at(-1)! : path).trim()
}
