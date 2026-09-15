import type { ConnectionFailure, MachineConnection, MachineDescriptor } from '../../../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'

/**
 * What the small indicator beside the composer says.
 *
 * The rule it exists to keep is narrow and absolute: it only ever repeats what the transport
 * actually reported. Whether a connection is direct or relayed is decided by the networks the two
 * computers are on and is answered by Tailscale itself; guessing it from a fast round trip would
 * be a confident lie about the one thing an owner would use to judge whether a shell will feel
 * usable. Likewise "over Tailscale" is said only when the transport really is Tailscale, because
 * that word is what tells them the traffic is inside the tunnel rather than merely over TLS.
 */

export interface ExecutionTarget {
  /** `Local: <this machine>` or `Remote: <host>`. */
  label: string
  machineId: string
  machineName: string
  local: boolean
  /** Connecting / Connected / Reconnecting / Offline / Detached. */
  state: string
  /** Direct / Relayed / Unknown, and only when `connection.path` says so; empty otherwise. */
  path: string
  /** 'over Tailscale' only when the transport really is Tailscale; empty otherwise. */
  transport: string
  /** The failure in words, when there is one. */
  failure: string
  /** One sentence for the tooltip and for the row underneath. */
  detail: string
  /** True while nothing is being attempted because the owner said so. */
  detached: boolean
}

const STATE_WORDS: Record<MachineConnection['state'], string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  detached: 'Detached'
}

/** The four failures that each need a different fix, said the way the owner would describe them. */
export function failureWords(failure: ConnectionFailure): string {
  if (failure === 'network') return 'network'
  if (failure === 'host-not-running') return 'host not running'
  if (failure === 'authorization') return 'authorization'
  if (failure === 'protocol') return 'protocol mismatch'
  return ''
}

/** A longer form for the diagnostics block, where there is room to say what to do about it. */
export function failureExplanation(failure: ConnectionFailure, machineName: string): string {
  if (failure === 'network') return `No route to ${machineName} right now. Check that both computers are on the same tailnet and signed in.`
  if (failure === 'host-not-running') return `${machineName} is reachable, but Conductor is not accepting connections there. Open it on that computer and turn remote control on.`
  if (failure === 'authorization') return `${machineName} refused this computer. The pairing may have been revoked there, or this device key is no longer registered.`
  if (failure === 'protocol') return `${machineName} speaks a different version of this protocol. Update Conductor on both computers.`
  return ''
}

/**
 * How the route is described. `path` is the only input, deliberately: Tailscale is what decides
 * and reports direct versus relayed, and nothing here is allowed to infer it from anything else.
 */
export function pathWords(connection: Pick<MachineConnection, 'path' | 'state'>): string {
  // While nothing is connected, the last known route describes nothing, so it is not shown.
  if (connection.state === 'detached' || connection.state === 'offline') return ''
  if (connection.path === 'direct') return 'Direct'
  if (connection.path === 'relayed') return 'Relayed'
  return 'Unknown'
}

/** Said only for a real Tailscale transport. Never say "encrypted" for anything else. */
export function transportWords(connection: Pick<MachineConnection, 'transport'>): string {
  return connection.transport === 'tailscale' ? 'over Tailscale' : ''
}

export function describeExecutionTarget(machines: MachineDescriptor[], machineId: string, localName = 'This machine'): ExecutionTarget {
  const machine = machines.find(entry => entry.id === machineId)
  const local = machineId === LOCAL_MACHINE_ID || machine?.kind === 'local'
  const machineName = machine?.name ?? (local ? localName : 'Unknown machine')
  const connection: MachineConnection = machine?.connection
    ?? { state: local ? 'connected' : 'offline', path: 'unknown', transport: null, failure: local ? null : 'network', detail: null, generation: 0 }

  if (local) {
    return {
      label: `Local: ${machineName}`, machineId: LOCAL_MACHINE_ID, machineName, local: true,
      state: 'Connected', path: '', transport: '', failure: '',
      detail: 'Work opened here runs on this computer.', detached: false
    }
  }

  const state = STATE_WORDS[connection.state]
  const failure = failureWords(connection.failure)
  const path = pathWords(connection)
  const transport = transportWords(connection)
  const detached = connection.state === 'detached'
  const detail = detached
    ? `You are using this computer independently of ${machineName}. Nothing is sent to it until you attach again.`
    : connection.detail
      ?? (connection.state === 'connected'
        ? `Work opened here runs on ${machineName}; you drive it from this window.`
        : connection.state === 'offline'
          ? `${machineName} cannot be reached right now${failure ? ` (${failure})` : ''}.`
          : `${machineName} is ${state.toLowerCase()}.`)

  return { label: `Remote: ${machineName}`, machineId, machineName, local: false, state, path, transport, failure, detail, detached }
}

/**
 * The one line under the label: state, then route, then transport, each only when it has something
 * true to say. Joined with a middle dot exactly as the rest of the panel already joins facts.
 */
export function executionTargetSummary(target: ExecutionTarget): string {
  return [target.state, target.path, target.transport].filter(Boolean).join(' · ')
}

/** The compact badge a project that lives on another machine carries in the project list. */
export interface RemoteProjectBadge {
  label: string
  title: string
  /** True when nothing of this project can be reached right now, so it must not look like a working local one. */
  unavailable: boolean
}

/**
 * How a remote project appears in the sidebar.
 *
 * A workspace whose host is detached or offline is the dangerous case this exists for: every file
 * in it is unreadable and every command in it unrunnable, and a row that looks exactly like a
 * local project invites the owner to work in it and only find out several clicks later. So the
 * badge changes, rather than merely the tooltip, and it names the machine either way.
 */
export function remoteProjectBadge(
  project: { remote?: { machineId: string; machineName: string } } | null | undefined,
  machines: MachineDescriptor[]
): RemoteProjectBadge | null {
  const origin = project?.remote
  if (!origin?.machineId) return null
  const name = origin.machineName || 'another machine'
  const machine = machines.find(entry => entry.id === origin.machineId)
  const connection = machine?.connection
  if (!machine) {
    return { label: `${name} unavailable`, title: `This project lives on ${name}, which is no longer paired with this computer. Nothing in it can be opened from here.`, unavailable: true }
  }
  if (connection?.state === 'detached') {
    return { label: `${name} unavailable`, title: `You are using this computer independently of ${name}. Nothing in this project can be opened until you attach again.`, unavailable: true }
  }
  if (machine.status !== 'online' || connection?.state === 'offline') {
    const why = connection ? failureWords(connection.failure) : ''
    return { label: `${name} unavailable`, title: `${name} cannot be reached right now${why ? ` (${why})` : ''}, so nothing in this project can be opened.`, unavailable: true }
  }
  return { label: `Remote: ${name}`, title: `This project lives on ${name}. Its files, terminals and agents run there.`, unavailable: false }
}
