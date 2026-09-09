import type { MachineDescriptor, MachineProjectLink, RemoteConnection } from '../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../shared/remote-control'
import { checkRemoteProjectPlacement, type ProjectPlacement } from '../shared/project-identity'
import type { PaneTab } from '../shared/models'

/** Where a tab actually runs. Absent state means it has always run here. */
export function tabMachineId(tab: Pick<PaneTab, 'state'> | undefined): string {
  const value = tab?.state?.machineId
  return typeof value === 'string' && value ? value : LOCAL_MACHINE_ID
}

export function machineLabel(machines: MachineDescriptor[], machineId: string): string {
  return machines.find(machine => machine.id === machineId)?.name ?? 'Unknown machine'
}

/**
 * The inheritance rule for machine placement, deliberately the same shape as the permission rule
 * a controlled tab already follows: a child tab runs wherever its parent runs, and only an
 * explicit request moves it somewhere else. An explicitly named machine that is not usable is an
 * error rather than a silent fallback to this machine, because silently running a heavy job on
 * the wrong computer is exactly the surprise this feature exists to avoid.
 */
export function inheritMachineId(parentMachineId: string, requested: unknown, machines: MachineDescriptor[]): string {
  const usable = (id: string): MachineDescriptor | undefined => machines.find(machine => machine.id === id && machine.status !== 'revoked')
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string' || !requested) throw new Error('Invalid machineId')
    if (!usable(requested)) throw new Error('That machine is not paired with this one, or its access was revoked. Use machines.list.')
    return requested
  }
  return usable(parentMachineId) ? parentMachineId : LOCAL_MACHINE_ID
}

/**
 * Whether a machine may run a tab for this project. For a peer this is an identity comparison
 * against the pair of projects the owner confirmed, never a name or a project id, because ids are
 * private to each machine and a name is exactly how work ends up in the wrong repository. The
 * whole rule lives in checkRemoteProjectPlacement; this only supplies what that machine last said.
 */
export function machineRunsProject(machine: MachineDescriptor, projectId: string): ProjectPlacement {
  if (machine.kind === 'local') return { ok: true, grant: null }
  const link = machine.projects.find(entry => entry.grant.localProjectId === projectId)
  return checkRemoteProjectPlacement({ machineName: machine.name, grant: link?.grant, advertised: link?.observed })
}

export function describeMachines(localName: string, connections: RemoteConnection[]): MachineDescriptor[] {
  return [
    { id: LOCAL_MACHINE_ID, name: localName, kind: 'local', status: 'online', accountLogin: null, projects: [] },
    ...connections.map((connection): MachineDescriptor => ({
      id: connection.machineId,
      name: connection.machineName,
      kind: 'peer',
      status: connection.status === 'revoked' ? 'revoked' : connection.status === 'connected' ? 'online' : 'offline',
      accountLogin: connection.accountLogin || null,
      projects: connection.projectGrants.map((grant): MachineProjectLink => ({
        grant,
        observed: connection.remoteProjects.find(project => project.id === grant.remoteProjectId)?.identity ?? null
      }))
    }))
  ]
}

/**
 * The sentence an agent is told about its own placement. Agents act on this when they open linked
 * tabs, so it states both where they are and what happens by default to anything they open.
 */
export function machineBriefing(machines: MachineDescriptor[], machineId: string): string {
  const current = machines.find(machine => machine.id === machineId)
  const others = machines.filter(machine => machine.id !== machineId && machine.status === 'online')
  const where = current?.kind === 'peer'
    ? `This tab runs on the paired machine “${current.name}” (machineId ${machineId}), not on the window you are shown in.`
    : `This tab runs on the local machine “${current?.name ?? 'this machine'}” (machineId ${LOCAL_MACHINE_ID}).`
  const inheritance = ' Any tab you open inherits this machine unless you pass an explicit machineId, so linked and child tabs stay on the same computer as their parent.'
  const available = others.length ? ` Other machines available: ${others.map(machine => `${machine.name} (${machine.id})`).join(', ')}; call machines.list before moving work.` : ''
  return where + inheritance + available
}
