import type { ProjectRecord } from '../../../shared/models'
import type { MachineDescriptor } from '../../../shared/remote-control'
import { remoteProjectBadge, type RemoteProjectBadge } from './execution-target'

/**
 * What the explorer should show for one project row.
 *
 * The explorer is the last place that still reached for this computer's disk on behalf of a project
 * that lives somewhere else. It did not do anything dangerous - the main-process guard refuses it -
 * but it turned a project the owner can perfectly well browse into an error string, which reads as
 * a bug rather than as a machine being unreachable. There are only three honest answers, and this
 * picks between them so the component never has to.
 *
 * `unavailable` is deliberately not an error and never falls back to the local lister. A host that
 * is detached or offline means the files cannot be read *from here*, which is a state, not a
 * failure; showing this computer's folder of the same path instead would be the one outcome that
 * keying a remote project by machine id exists to prevent.
 */
export type RemoteExplorerView =
  | { kind: 'local' }
  | { kind: 'remote'; machineId: string; projectId: string; machineName: string; badge: RemoteProjectBadge }
  | { kind: 'unavailable'; machineId: string; machineName: string; badge: RemoteProjectBadge; message: string }

export function remoteExplorerView(
  project: Pick<ProjectRecord, 'remote'> | null | undefined,
  machines: MachineDescriptor[]
): RemoteExplorerView {
  const origin = project?.remote
  if (!origin?.machineId) return { kind: 'local' }
  const badge = remoteProjectBadge(project, machines)
  const machineName = origin.machineName || 'another machine'
  // `remoteProjectBadge` already decides what "usable" means for a host - detached, offline and
  // unpaired all land on `unavailable` there - so the two surfaces cannot disagree about whether a
  // project can be opened, which is the disagreement the owner would actually act on.
  if (!badge || badge.unavailable) {
    return {
      kind: 'unavailable',
      machineId: origin.machineId,
      machineName,
      badge: badge ?? { label: `${machineName} unavailable`, title: '', unavailable: true },
      // The badge's own title is the sentence that explains which of the three it is.
      message: badge?.title ?? `${machineName} cannot be reached from this computer right now.`
    }
  }
  return {
    kind: 'remote',
    machineId: origin.machineId,
    // The host's own id for the project. Ours is private to this computer and naming it to the
    // host would ask about a project the host has never heard of.
    projectId: origin.remoteProjectId,
    machineName,
    badge
  }
}
