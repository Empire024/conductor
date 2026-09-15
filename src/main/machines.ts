import type { MachineConnection, MachineDescriptor, MachineProjectLink, RemoteConnection } from '../shared/remote-control'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID } from '../shared/remote-control'
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

/**
 * How a paired machine is reached, from what the connection record alone can say. The transport
 * layer overrides this with live stream state where it has it; this is the answer when it does not.
 */
export function describeConnection(connection: RemoteConnection, live?: Partial<MachineConnection>): MachineConnection {
  const base: MachineConnection = connection.detached
    ? { state: 'detached', path: 'unknown', transport: null, failure: null, detail: 'Using this computer independently.', generation: connection.generation ?? 0 }
    : connection.status === 'revoked'
      ? { state: 'offline', path: 'unknown', transport: null, failure: 'authorization', detail: connection.message, generation: connection.generation ?? 0 }
      : connection.status === 'connected'
        ? { state: 'connected', path: 'unknown', transport: connection.transport ?? null, failure: null, detail: null, generation: connection.generation ?? 0 }
        : { state: 'offline', path: 'unknown', transport: connection.transport ?? null, failure: 'network', detail: connection.message, generation: connection.generation ?? 0 }
  return { ...base, ...live }
}

export function describeMachines(localName: string, connections: RemoteConnection[], live?: (machineId: string) => Partial<MachineConnection> | undefined): MachineDescriptor[] {
  return [
    { id: LOCAL_MACHINE_ID, name: localName, kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION },
    ...connections.map((connection): MachineDescriptor => ({
      id: connection.machineId,
      name: connection.machineName,
      kind: 'peer',
      // A detached host is not offline - it may be perfectly reachable - but nothing runs there
      // from here until the owner attaches again, and the launcher must not offer it.
      status: connection.status === 'revoked' ? 'revoked' : connection.detached ? 'offline'
        // A stream that is open right now outranks what the last call recorded.
        : live?.(connection.machineId)?.state === 'connected' || connection.status === 'connected' ? 'online' : 'offline',
      accountLogin: connection.accountLogin || null,
      connection: describeConnection(connection, live?.(connection.machineId)),
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

/**
 * How much longer to wait after each consecutive silent probe, as a multiple of the base interval.
 *
 * With the 60 s base that gives 60 s, 2 min, 5 min, then 15 min for ever. A machine that is simply
 * switched off costs four probes in the first eight minutes and four an hour after that, instead of
 * sixty an hour — and every one of those probes was a GitHub write plus a relay call that held the
 * poll loop open. Nothing is lost by waiting: a peer that comes back republishes its relay mailbox,
 * and `probeMachinesSeenOnRelay` clears the backoff and probes it the moment that is noticed.
 */
export const MACHINE_PROBE_BACKOFF_STEPS = [1, 2, 5, 15] as const

/**
 * When each paired machine is next worth probing, and which probes are already in flight.
 *
 * The in-flight set is the half that makes the interval safe rather than merely polite: a probe's
 * own call can outlast the timer that started it, and starting a second probe for a machine whose
 * first has not come back is what kept a call pending at every instant — which is what held the
 * relay at its fast poll cadence indefinitely. One probe per machine at a time, always.
 */
export class MachineProbeSchedule {
  private readonly silent = new Map<string, { failures: number; nextAt: number }>()
  private readonly inFlight = new Set<string>()

  constructor(private readonly baseMs: number) {}

  /** Whether a scheduled sweep should probe this machine now. */
  due(machineId: string, now: number): boolean {
    if (this.inFlight.has(machineId)) return false
    const state = this.silent.get(machineId)
    return !state || state.nextAt <= now
  }

  /** Claims this machine for one probe; false when a probe for it is still outstanding. */
  begin(machineId: string): boolean {
    if (this.inFlight.has(machineId)) return false
    this.inFlight.add(machineId)
    return true
  }

  /** Records how a probe ended. Answering at all puts the machine back on the base interval. */
  settle(machineId: string, answered: boolean, now: number): void {
    this.inFlight.delete(machineId)
    if (answered) { this.silent.delete(machineId); return }
    const failures = (this.silent.get(machineId)?.failures ?? 0) + 1
    const step = MACHINE_PROBE_BACKOFF_STEPS[Math.min(failures, MACHINE_PROBE_BACKOFF_STEPS.length) - 1] ?? 1
    this.silent.set(machineId, { failures, nextAt: now + this.baseMs * step })
  }

  /** A machine that republished its relay mailbox is worth trying again straight away. */
  reappeared(machineId: string): void { this.silent.delete(machineId) }

  /** How long a silent machine still has to wait, for tests and for explaining the schedule. */
  waitMs(machineId: string, now: number): number {
    const state = this.silent.get(machineId)
    return state ? Math.max(0, state.nextAt - now) : 0
  }
}
