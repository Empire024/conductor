import type { ProjectRecord } from '../shared/models'
import type { RemoteProjectSummary } from '../shared/remote-control'
import type { ProjectIdentity, RemoteProjectGrant } from '../shared/project-identity'
import { samePath } from '../shared/project-identity'

/**
 * Turning what a paired machine shares into projects in this computer's own list.
 *
 * This is the whole of "linking two machines", and what it replaced is worth stating: projects used
 * to be *paired* - the owner told Conductor that this folder here was that folder there, in a
 * settings panel, and work then went to whichever machine that mapping happened to name. It was one
 * decision too many and one decision too late, and it left a project that plainly lived on the
 * laptop labelled as local here.
 *
 * A project now belongs to exactly one computer: the one whose disk holds it. A machine's projects
 * appear in the other machine's list as that machine's, marked with its name, and nothing here ever
 * maps one onto a project of this computer's. The grant is still written, because every remote path
 * (files, tabs, terminals, tasks) resolves through it, but it maps an adopted row onto the host's
 * own project rather than onto a working copy here.
 */
export interface RemoteProjectAdoptionDependencies {
  /** Every project registered here, local and adopted alike. */
  listProjects(): ProjectRecord[]
  /** Creates or refreshes the row for a host project. Adopting the same one twice is one row. */
  addRemoteProject(request: { name: string; path: string; remote: { machineId: string; machineName: string; remoteProjectId: string; path: string; identity: ProjectIdentity } }): ProjectRecord
  /**
   * Puts the adopted project on the desk. A desk that was saved with an explicit project list shows
   * only those, so without this a machine's projects would be adopted into a list nobody can see.
   */
  includeInDesk(projectId: string): void
  /** Whether the owner took this host project off their list. */
  isDismissed(machineId: string, remoteProjectId: string): boolean
  /** The grant currently recorded for a row, so an unchanged one is left alone. */
  grantFor(machineId: string, localProjectId: string): RemoteProjectGrant | undefined
  confirmProject(machineId: string, grant: RemoteProjectGrant): void
  now?(): number
}

export interface RemoteProjectAdoption {
  /** The rows this machine's projects now occupy here, in the order the host listed them. */
  adopted: ProjectRecord[]
  /** True when a row appeared, or its name or its folder on the host changed. */
  changed: boolean
}

/** One host project, adopted. Null when the host could not say what working copy it is. */
export function adoptRemoteProject(
  deps: RemoteProjectAdoptionDependencies,
  machineId: string,
  machineName: string,
  summary: RemoteProjectSummary
): ProjectRecord | null {
  if (!summary.identity) return null
  const record = deps.addRemoteProject({
    name: summary.name,
    path: summary.path,
    remote: { machineId, machineName, remoteProjectId: summary.id, path: summary.path, identity: summary.identity }
  })
  deps.includeInDesk(record.id)
  const grant = deps.grantFor(machineId, record.id)
  // Rewriting an unchanged grant bumps the authority revision, which cancels the calls in flight
  // under it - and adoption runs on every probe, so an unconditional write would make a remote file
  // read during a probe a coin toss.
  const current = grant
    && grant.remoteProjectId === summary.id
    && grant.remote.key === summary.identity.key
    && grant.remote.keyCreatedAt === summary.identity.keyCreatedAt
    && samePath(grant.remote.path, summary.identity.path)
  if (!current) {
    deps.confirmProject(machineId, {
      localProjectId: record.id,
      local: summary.identity,
      remoteProjectId: summary.id,
      remote: summary.identity,
      confirmedAt: new Date(deps.now?.() ?? Date.now()).toISOString()
    })
  }
  return record
}

/**
 * Every project a machine shares, adopted. A project the owner removed from the list stays removed,
 * and a project whose identity that machine cannot read is skipped rather than adopted under a
 * blank one - an identity is what later tells this computer the project over there is still the one
 * it has been working in.
 */
export function adoptRemoteProjects(
  deps: RemoteProjectAdoptionDependencies,
  machineId: string,
  machineName: string,
  summaries: RemoteProjectSummary[]
): RemoteProjectAdoption {
  const rowsFor = (): ProjectRecord[] => deps.listProjects().filter(project => project.remote?.machineId === machineId)
  const before = rowsFor()
  const adopted: ProjectRecord[] = []
  for (const summary of summaries) {
    if (!summary.identity || deps.isDismissed(machineId, summary.id)) continue
    try {
      const record = adoptRemoteProject(deps, machineId, machineName, summary)
      if (record) adopted.push(record)
    } catch { /* one unusable project must not stop the rest of that machine's list appearing */ }
  }
  const after = rowsFor()
  const changed = after.length !== before.length || after.some(project => {
    const previous = before.find(entry => entry.id === project.id)
    return !previous || previous.name !== project.name || previous.remote?.path !== project.remote?.path
  })
  return { adopted, changed }
}
