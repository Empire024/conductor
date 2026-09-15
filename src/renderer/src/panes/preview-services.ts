import type { ProjectRecord } from '../../../shared/models'
import type { RemoteServiceRecord } from '../../../shared/remote-services'
import { LOCAL_MACHINE_ID } from '../../../shared/remote-control'

/**
 * Preview services: a dev server on one computer, watched from the other.
 *
 * The shape of this feature is deliberately narrow, and the copy here has to keep saying so.
 * Registering is an act by the *host's* owner, on the host, naming one loopback port. A controller
 * may list what was registered and open a tunnel to one of those, and nothing else: no URL of its
 * choosing, no port of its choosing, no route to anything but 127.0.0.1 on the host at exactly the
 * registered port. So nothing in this UI ever asks for or shows a URL to reach a service by, and
 * nothing offers "another host" - the only two things an owner types are a label and a port that is
 * already listening on their own machine.
 *
 * On the controller the tunnel ends at a loopback port of *this* computer, which is what the
 * browser pane loads. That is exactly why the pane has to be labelled with the host: a laptop
 * looking at `http://127.0.0.1:...` that is really MAIN's dev server, sitting next to the laptop's
 * own dev server on a similar port, is the mistake this label exists to prevent.
 */

/** Where a browser pane's preview comes from: this computer, or a service registered on a host. */
export type PreviewTarget =
  | { mode: 'host' }
  | { mode: 'controller'; machineId: string; machineName: string; projectId: string }

/**
 * Decides which of the two a pane is in.
 *
 * A project that *lives* on a host is named to it by the host's own project id, which its origin
 * carries. A project *paired* between two working copies is named by our id and mapped through the
 * grant in the main process - the same single rule tab placement and the launcher's terminal list
 * already follow, so a service and a terminal for one project are never scoped differently.
 */
export function previewTarget(
  project: Pick<ProjectRecord, 'id' | 'remote'> | null | undefined,
  tabMachineId?: string,
  machineName?: string
): PreviewTarget {
  const origin = project?.remote
  if (origin?.machineId) {
    return { mode: 'controller', machineId: origin.machineId, machineName: origin.machineName || 'that machine', projectId: origin.remoteProjectId }
  }
  if (project && tabMachineId && tabMachineId !== LOCAL_MACHINE_ID) {
    return { mode: 'controller', machineId: tabMachineId, machineName: machineName || 'that machine', projectId: project.id }
  }
  return { mode: 'host' }
}

/** A loopback port that is already listening on this computer; nothing else is accepted. */
export function normalizeServicePort(value: unknown): number | null {
  const port = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/**
 * Whether a registration can be made, with the reason when it cannot. A duplicate port is refused
 * rather than merged: two labels pointing at one port would make "which one did I open" unanswerable
 * on the other machine, where the port itself is never shown.
 */
export function validateRegistration(
  input: { label: string; port: string | number },
  existing: RemoteServiceRecord[]
): { ok: boolean; message: string; port: number; label: string } {
  const label = String(input.label ?? '').trim().slice(0, 60)
  const port = normalizeServicePort(input.port)
  if (!label) return { ok: false, message: 'Give this service a name, so you can tell it apart on your other computer.', port: 0, label }
  if (port === null) return { ok: false, message: 'Enter the port your dev server is already listening on, between 1 and 65535.', port: 0, label }
  if (existing.some(service => service.port === port)) {
    const clash = existing.find(service => service.port === port)!
    return { ok: false, message: `Port ${port} is already registered as “${clash.label}”. Remove that one first, or use the port of a different server.`, port, label }
  }
  return { ok: true, message: '', port, label }
}

/** What the host's owner is told they are actually doing. It never promises a URL or another host. */
export const HOST_SERVICE_NOTE =
  'A registered port becomes reachable from your paired machines through Conductor, and through nothing else. No address is published, nothing is opened to your network or the internet, and a paired machine can reach only the exact ports you list here on this computer - not a port of its choosing and not any other host.'

/** The single line under the register form, for the port field. */
export const HOST_PORT_HINT =
  'The port your dev server already listens on here, on 127.0.0.1. Conductor does not start it.'

/** What a controller sees when the host has registered nothing. It says where to go and what to do. */
export function noServicesMessage(machineName: string): string {
  return `No preview services are registered on ${machineName}. Register a dev server on ${machineName} under Preview services, then check again.`
}

/** The action for one service, naming the machine every time it is offered. */
export function serviceActionLabel(service: Pick<RemoteServiceRecord, 'label'>, machineName: string): string {
  return `Open on ${machineName}: ${service.label}`
}

/**
 * The line under the address bar while a host's service is being viewed.
 *
 * It names the machine rather than the address on purpose. The address is a loopback port on *this*
 * computer - the controller end of the tunnel - so reading it tells the owner the opposite of the
 * truth about whose dev server they are looking at.
 */
export function previewOriginNote(service: Pick<RemoteServiceRecord, 'label' | 'port'>, machineName: string): string {
  return `You are viewing “${service.label}” running on ${machineName} (port ${service.port} there). This address is the local end of that connection, not a server on this computer.`
}

/** Sorted the way the owner registered them, newest last, so a list does not reshuffle under them. */
export function orderServices(services: RemoteServiceRecord[]): RemoteServiceRecord[] {
  return [...services].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.label.localeCompare(b.label))
}

/**
 * Whether the page on screen really is the host's service.
 *
 * The address bar keeps working while a tunnel is open, so the owner can navigate to their own
 * localhost without closing anything. From that moment the pane is no longer showing the host, and
 * labelling it by *mode* would put "Remote: MAIN" over the laptop's own dev server - the same
 * confusion the label exists to prevent, pointing the other way. So every piece of copy that names
 * the host is gated on this, not on which mode the pane is in.
 */
export function viewingService(currentUrl: string | undefined, serviceOrigin: string): boolean {
  if (!currentUrl || !serviceOrigin) return false
  try { return new URL(currentUrl).origin === serviceOrigin } catch { return false }
}

/**
 * Whether the host behind an open preview has gone. Detaching already closes every tunnel in the
 * main process, so there is nothing to tear down here; what is left to get right is not leaving a
 * pane labelled as a live view of a machine this computer is no longer talking to.
 */
export function previewHostLost(
  machines: Array<{ id: string; status: string; connection: { state: string } }>,
  machineId: string
): boolean {
  const host = machines.find(entry => entry.id === machineId)
  return !host || host.status !== 'online' || host.connection.state === 'detached'
}
