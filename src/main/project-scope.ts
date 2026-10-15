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

/**
 * Thrown instead of doing local work for a project that lives on another machine. Features that
 * the host does serve (tasks, renaming, files, terminals, tabs, previews) are forwarded to it before
 * any guard is reached; the features that still meet this error are the ones listed as `local`
 * in src/shared/remote-project-support.ts, and the renderer does not offer them for such a project.
 */
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
  /**
   * Every row, so a project that lives on a paired machine can also be found by that machine's own
   * id for it. Optional only so a lookup that never sees an adopted row stays one function.
   */
  listProjects?(): ProjectRecord[]
}

/**
 * A project row here, named either way the renderer names it.
 *
 * A project adopted from a paired machine has two ids: this computer's row id, and the host's own
 * id for it, which its origin records and which every surface that talks to the host (launcher,
 * file tree, terminals, previews) sends. Each main-process entry point used to accept only the row
 * id, so a host id reaching one of them read as "this project does not exist" - the class of
 * failure behind "Error invoking remote method" all over a "Remote: MAIN" project. This is the one
 * resolver every project-scoped path goes through, so no two of them can disagree about which
 * project an id means.
 *
 * `machineId` narrows a host id to that machine's rows. Without it a host id that two paired
 * machines happen to share resolves to nothing rather than to a guess.
 */
export function findProjectRecord(lookup: ProjectLookup, projectId: unknown, machineId?: string): ProjectRecord | null {
  if (typeof projectId !== 'string' || !projectId) return null
  const own = lookup.getProject(projectId)
  if (own) return own
  const adopted = (lookup.listProjects?.() ?? []).filter(entry =>
    entry.remote?.remoteProjectId === projectId && (!machineId || entry.remote.machineId === machineId))
  return adopted.length === 1 ? adopted[0]! : null
}

/** Where a project's work happens: on this computer, or on the paired machine whose disk holds it. */
export type ProjectRoute =
  | { kind: 'local'; project: ProjectRecord }
  | { kind: 'remote'; project: ProjectRecord; machineId: string; machineName: string; remoteProjectId: string }

/**
 * The route for a project, by either of its ids. A remote route carries this computer's row (whose
 * id every local binding is kept under) and the host's id (the only one the host understands).
 */
export function routeProject(lookup: ProjectLookup, projectId: unknown): ProjectRoute {
  const project = findProjectRecord(lookup, projectId)
  if (!project) throw new Error('Project not found')
  const origin = project.remote
  if (!origin?.machineId) return { kind: 'local', project }
  return { kind: 'remote', project, machineId: origin.machineId, machineName: origin.machineName || 'the other machine', remoteProjectId: origin.remoteProjectId }
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
  // Either id: a host id must be refused as "that runs on MAIN", not reported as a missing project.
  const record = findProjectRecord(lookup, projectId)
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
