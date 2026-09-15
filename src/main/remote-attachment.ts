/**
 * Detach and attach: the decoupling half of multi-device operation.
 *
 * "Use this computer independently" is the promise that the laptop is never hostage to MAIN. It
 * therefore needs *nothing* from MAIN to run: no round trip, no acknowledgement, no reachability.
 * It works when MAIN is asleep, on another continent, or in a skip. That constraint is why every
 * step below is local, and why `transport.detach` is told to tear this end down rather than asked
 * whether it may.
 *
 * What it does, in order, and why each part is needed:
 *
 *  - Marks the connection detached and *persists* that. A restart that came back attached would
 *    make the decision a session preference rather than a decision.
 *  - Bumps the generation. Requests already in flight cannot be recalled, and their replies may
 *    arrive seconds later; every reply is stamped with the generation it was asked under, so an
 *    older one is dropped instead of writing into the state the owner is now using locally.
 *  - Tells the transport to stop: close the stream, cancel reconnects, drop subscriptions. This is
 *    a local teardown; the host is not notified and nothing there changes.
 *  - Drops anything queued for the host. Nothing is replayed, ever - not on attach, not on the
 *    host coming back. A keystroke or a write that could not be sent is gone, and said to be gone,
 *    because a command silently arriving twenty minutes later on a machine the owner has stopped
 *    watching is the worst outcome available here.
 *  - Retains unsaved remote edits as labelled recovery drafts, so the one thing that was genuinely
 *    the owner's and nowhere else - what they typed - survives.
 *
 * What it explicitly is not: it is not "forget this machine" (the pairing stays, and revocation is
 * a different, outward-facing act), and it is not "become a host". Attaching again is always an
 * explicit act; nothing here reattaches on its own, not even when the host reappears.
 */

import type { MachineConnection } from '../shared/remote-control'

/** The slice of the connection store this needs; the transport engineer owns the real one. */
export interface AttachmentConnections {
  get(machineId: string): { machineId: string; machineName: string; detached?: boolean; generation?: number; status?: string } | null
  /** Persisted immediately: a restart must come back to exactly the state the owner chose. */
  mark(machineId: string, patch: { detached?: boolean; generation?: number }): void
}

export interface AttachmentTransport {
  /** Local teardown: close the stream, cancel reconnects, drop subscriptions. Must not need the host. */
  detach(machineId: string): void
  /** Dial again under the new generation. May fail; the attachment itself has already happened. */
  attach(machineId: string): void
}

export interface AttachmentQueues {
  /**
   * Discards everything waiting to go to that host and reports how much was discarded, so the
   * owner can be told rather than left to discover it. Nothing here is ever replayed.
   */
  dropPending(machineId: string): number
}

export interface AttachmentDrafts {
  /** Keeps unsaved edits made against that host as labelled recovery drafts; returns how many. */
  retainRemote(machineId: string): number
}

export interface AttachmentMirror {
  /**
   * Marks mirrored sessions from that host as unavailable. The bindings are kept - the owner's
   * tabs do not vanish - they simply stop claiming to be live.
   */
  markUnavailable(machineId: string): void
}

export interface RemoteAttachmentDeps {
  connections: AttachmentConnections
  transport: AttachmentTransport
  drafts: AttachmentDrafts
  /** Optional: a build with no queue or no mirror still detaches correctly. */
  queues?: AttachmentQueues
  mirror?: AttachmentMirror
  /** Publish the new state to the renderer. */
  changed(): void
}

/** What one detach actually did, for the sentence the owner is shown. */
export interface DetachResult {
  machineId: string
  machineName: string
  generation: number
  /** Queued operations thrown away rather than replayed. */
  droppedOperations: number
  /** Unsaved edits kept as recovery drafts. */
  retainedDrafts: number
  /** True when the machine was already detached, so nothing changed and no generation was spent. */
  alreadyDetached: boolean
}

export interface AttachResult {
  machineId: string
  machineName: string
  generation: number
  alreadyAttached: boolean
}

export class RemoteAttachment {
  constructor(private readonly deps: RemoteAttachmentDeps) {}

  /** Whether the owner has chosen to run independently of this host. */
  isDetached(machineId: string): boolean {
    return this.deps.connections.get(machineId)?.detached === true
  }

  /**
   * Use this computer independently of that host. Local, immediate and remembered; the host is not
   * told and nothing on it changes. Work already running there continues on its own lifecycle, and
   * anything already sent may have completed.
   */
  detach(machineId: string): DetachResult {
    const connection = this.deps.connections.get(machineId)
    if (!connection) throw new Error('That machine is not paired with this one.')
    if (connection.detached) {
      return {
        machineId, machineName: connection.machineName, generation: connection.generation ?? 0,
        droppedOperations: 0, retainedDrafts: 0, alreadyDetached: true
      }
    }
    const generation = (connection.generation ?? 0) + 1
    // Persist first. If anything below throws, the owner is still detached - which is the safe
    // direction to fail in, and the only direction that keeps the promise this action makes.
    this.deps.connections.mark(machineId, { detached: true, generation })
    // Retained before the teardown, because the drafts are the one thing that cannot be recreated.
    const retainedDrafts = safely(() => this.deps.drafts.retainRemote(machineId), 0)
    const droppedOperations = safely(() => this.deps.queues?.dropPending(machineId) ?? 0, 0)
    safely(() => { this.deps.transport.detach(machineId) }, undefined)
    safely(() => { this.deps.mirror?.markUnavailable(machineId) }, undefined)
    this.deps.changed()
    return { machineId, machineName: connection.machineName, generation, droppedOperations, retainedDrafts, alreadyDetached: false }
  }

  /**
   * The explicit way back. A new generation is taken before anything is dialled, so replies to the
   * pre-detach generation still cannot land, and the connection starts from nothing rather than
   * from whatever it believed before: no queue is resumed and no retained draft is replayed.
   */
  attach(machineId: string): AttachResult {
    const connection = this.deps.connections.get(machineId)
    if (!connection) throw new Error('That machine is not paired with this one.')
    if (!connection.detached) {
      return { machineId, machineName: connection.machineName, generation: connection.generation ?? 0, alreadyAttached: true }
    }
    const generation = (connection.generation ?? 0) + 1
    this.deps.connections.mark(machineId, { detached: false, generation })
    safely(() => { this.deps.transport.attach(machineId) }, undefined)
    this.deps.changed()
    return { machineId, machineName: connection.machineName, generation, alreadyAttached: false }
  }

  /**
   * The single action from docs/multi-device.md: this computer, on its own, from now on. Every
   * host is detached; one that cannot be torn down cleanly does not stop the others, because a
   * half-independent computer is not what the owner asked for.
   */
  useIndependently(machineIds: string[]): DetachResult[] {
    return machineIds.flatMap(machineId => {
      try { return [this.detach(machineId)] } catch { return [] }
    })
  }

  /**
   * How a detached host is described, whatever the transport last believed. A detached machine is
   * not offline and not failing: nothing is being attempted, by the owner's own decision.
   */
  describe(machineId: string): MachineConnection | null {
    const connection = this.deps.connections.get(machineId)
    if (!connection?.detached) return null
    return {
      state: 'detached', path: 'unknown', transport: null, failure: null,
      detail: 'Using this computer independently.', generation: connection.generation ?? 0
    }
  }
}

/** One step failing must not leave the owner half-detached; the decision is already persisted. */
function safely<T>(action: () => T, fallback: T): T {
  try { return action() } catch { return fallback }
}

/**
 * The words shown after detaching. Written out here rather than in the component because the same
 * promises are made in docs/multi-device.md and they have to stay the same promises.
 */
export function detachExplanation(machineName: string): string[] {
  return [
    `${machineName}'s files, services, models and running sessions are not available from this computer while you are detached.`,
    `Work already running on ${machineName} keeps running there on its own; nothing is stopped or told to stop.`,
    'Anything already sent may have completed. Nothing waiting to be sent is kept, and nothing is replayed later.',
    'Unsaved edits to that machine’s files are kept here as labelled recovery drafts you can read, copy or save somewhere else.',
    `This is not forgetting the pairing: ${machineName} stays paired and nothing there changes. Attaching again is something you do on purpose.`
  ]
}
