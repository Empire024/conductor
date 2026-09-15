/**
 * The one place that decides whether a projectId may touch this computer.
 *
 * A remote project is a window onto another machine's working copy (see docs/multi-device.md). Its
 * `path` is that machine's path, and this computer almost certainly has nothing at it - or, worse,
 * has something else at it. Running `git status`, opening a shell, writing a file or starting an
 * agent "for" such a project on this disk is not a degraded version of the feature: it is silent,
 * confident work on the wrong files. So every main-process entry point that would reach the local
 * filesystem, git, a pty, an agent, a preview, a snapshot, a task or memory goes through
 * `localProject` first and is refused with a sentence that names the host and the feature.
 *
 * The refusal is deliberately not a fallback. There is no "well, the path exists here too" branch,
 * because a local C:\project and MAIN's C:\project are two working copies and the whole point of
 * keying a remote project by machine id is that they are never the same thing.
 */

import type { ProjectRecord } from '../shared/models'

/** Thrown instead of doing local work for a project that lives on another machine. */
export class RemoteProjectError extends Error {
  /** Marks the error across the IPC boundary, where only `name` and `message` survive. */
  readonly code = 'remote-project'
  constructor(
    readonly machineName: string,
    readonly feature: string,
    message: string
  ) {
    super(message)
    this.name = 'RemoteProjectError'
  }
}

/** The smallest shape `localProject` needs, so tests and callers never build a whole Database. */
export interface ProjectLookup {
  getProject(id: string): ProjectRecord | null
}

/** True when this project's files, terminals, agents and tasks all live on another machine. */
export function isRemoteProject(record: Pick<ProjectRecord, 'remote'> | null | undefined): boolean {
  return Boolean(record?.remote?.machineId)
}

/**
 * The sentence the owner reads. It names the host, because "not available" without saying where the
 * work actually is leaves them looking for a bug; and it names the feature, because the same
 * project does work remotely for files and conversations and they need to know which half stopped.
 */
export function remoteProjectMessage(machineName: string, feature: string): string {
  return `This project lives on ${machineName}. ${feature} runs there; it is not available from this computer yet.`
}

/**
 * The project record for work that must happen on this computer's disk.
 *
 * Throws `RemoteProjectError` for a project that lives on a paired machine, and a plain error for a
 * project id that is not in the database at all - those are different mistakes and a caller that
 * wants to distinguish them can.
 */
export function localProject(lookup: ProjectLookup, projectId: string, feature = 'That'): ProjectRecord {
  const record = lookup.getProject(projectId)
  if (!record) throw new Error('Project not found')
  if (isRemoteProject(record)) {
    const machineName = record.remote!.machineName || 'the other machine'
    throw new RemoteProjectError(machineName, feature, remoteProjectMessage(machineName, feature))
  }
  return record
}

/**
 * Guards a call without needing the record. Used where the handler already has everything it needs
 * and only the refusal is missing.
 */
export function requireLocalProject(lookup: ProjectLookup, projectId: string, feature = 'That'): void {
  localProject(lookup, projectId, feature)
}

/**
 * Guards an optional project id: `null`/`undefined` means "not project-scoped", which is allowed,
 * because several handlers take a project id only to narrow a list.
 */
export function requireLocalProjectIfGiven(lookup: ProjectLookup, projectId: string | null | undefined, feature = 'That'): void {
  if (typeof projectId === 'string' && projectId) localProject(lookup, projectId, feature)
}
