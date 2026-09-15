import type { MachineConnection, RemoteConnection } from '../../../shared/remote-control'

/**
 * How a paired machine's connection reads in the settings panel, from the stored record alone.
 *
 * This deliberately mirrors `describeConnection` in src/main/machines.ts rather than importing it:
 * that file is main-process code and has no business in a renderer bundle. What must not drift is
 * the *order of precedence*, and it is the same here - the owner's own decision to detach outranks
 * everything, then revocation, then whether the last contact worked - because "is my work going to
 * MAIN or not" is the one question these two surfaces must never answer differently.
 */
export function describeConnectionRecord(connection: RemoteConnection): MachineConnection {
  const generation = connection.generation ?? 0
  if (connection.detached) {
    return { state: 'detached', path: 'unknown', transport: null, failure: null, detail: 'Using this computer independently.', generation }
  }
  if (connection.status === 'revoked') {
    return { state: 'offline', path: 'unknown', transport: null, failure: 'authorization', detail: connection.message, generation }
  }
  if (connection.status === 'connected') {
    return { state: 'connected', path: 'unknown', transport: connection.transport ?? null, failure: null, detail: null, generation }
  }
  return { state: 'offline', path: 'unknown', transport: connection.transport ?? null, failure: 'network', detail: connection.message, generation }
}

/**
 * What detaching means, in the words docs/multi-device.md uses for it.
 *
 * The list is shown *before* the owner confirms, not after, because most of it is something they
 * cannot undo by attaching again: a queued write is gone, an operation already sent may already
 * have run, and MAIN is never told any of this happened. The one promise in the other direction -
 * that their unsaved edits survive - is here for the same reason.
 */
export function detachExplanationLines(machineName: string): string[] {
  return [
    `${machineName}'s files, services, models and running sessions stop being available from this computer.`,
    `Work already running on ${machineName} keeps running there on its own. Nothing is stopped, and ${machineName} is not told.`,
    'Anything already sent may have completed. Anything still waiting to be sent is dropped and never replayed.',
    'Unsaved edits to that machine’s files are kept here as labelled recovery drafts you can read, copy or save elsewhere.',
    `This is not "forget this machine": the pairing stays. Attaching again is something you do on purpose - nothing reattaches by itself, even when ${machineName} comes back.`
  ]
}
