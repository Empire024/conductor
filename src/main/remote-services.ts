import { randomUUID } from 'node:crypto'
import type { RemotePeerRecord } from '../shared/remote-control'
import type { RemoteServiceRecord } from '../shared/remote-services'
import { RemoteAccessError } from './remote-peers'

/**
 * Preview services on this machine, as a paired machine is allowed to see them.
 *
 * A service is a loopback port with a label, registered here by this machine's owner. That is the
 * whole of the model, and the reason for it: a controller may list what was registered and ask for
 * one of those, and never name a port itself. Without that rule "open a preview" would be "connect
 * to any port on the host", which is a different feature with a different trust boundary from the
 * one docs/multi-device.md describes.
 *
 * The tunnel that actually carries bytes is the next wave. `tunnelTarget` is where it attaches:
 * it resolves a registered id to the port behind it, under the project grant, and is the only
 * place a port is ever produced for a remote caller.
 */

const SERVICES_SETTING = 'remote-control.services'
/** Registrations per project. High enough never to be reached in practice, low enough to bound the setting. */
const MAX_SERVICES_PER_PROJECT = 32
const MAX_LABEL_LENGTH = 60

export function readServiceRecords(raw: string | undefined): RemoteServiceRecord[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Partial<RemoteServiceRecord>
    if (typeof value.id !== 'string' || !value.id) return []
    if (typeof value.projectId !== 'string' || !value.projectId) return []
    if (typeof value.label !== 'string' || !value.label) return []
    if (!Number.isSafeInteger(value.port) || value.port! < 1 || value.port! > 65535) return []
    return [{
      id: value.id,
      projectId: value.projectId,
      port: value.port!,
      label: value.label.slice(0, MAX_LABEL_LENGTH),
      createdAt: typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : new Date(0).toISOString()
    }]
  })
}

export interface RemoteServiceRegistryDependencies {
  settings: { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
  /** The project grant. A peer never reaches a registration for a project it was not given. */
  peers: {
    requireProject(peer: RemotePeerRecord, projectId: unknown): unknown
    requireCurrentProject(peer: RemotePeerRecord, projectId: unknown, expectedRevision?: number): unknown
  }
  /** Registrations are the owner's, so they only exist for projects this machine actually has. */
  project(projectId: string): { id: string } | null
  now?(): number
}

export class RemoteServiceRegistry {
  private services: RemoteServiceRecord[]

  constructor(private readonly deps: RemoteServiceRegistryDependencies) {
    this.services = readServiceRecords(this.deps.settings.getSetting(SERVICES_SETTING) || undefined)
  }

  /** The owner's own registrations for a project on this machine. */
  registered(projectId: string): RemoteServiceRecord[] {
    return this.services.filter(service => service.projectId === projectId).map(service => ({ ...service }))
  }

  register(request: { projectId: string; port: number; label: string }): RemoteServiceRecord {
    const projectId = typeof request?.projectId === 'string' ? request.projectId : ''
    if (!projectId || !this.deps.project(projectId)) {
      throw new RemoteAccessError('Register a preview service against a project on this machine.', 404)
    }
    const port = request.port
    if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new RemoteAccessError('A service port is a whole number between 1 and 65535.', 400)
    }
    const label = typeof request.label === 'string' ? request.label.trim() : ''
    // Control characters would travel into the other machine's UI as a label; refuse rather than
    // strip, so what the owner typed and what the other computer shows are the same string.
    if (!label || label.length > MAX_LABEL_LENGTH || /[\u0000-]/.test(label)) {
      throw new RemoteAccessError(`Give the service a name of at most ${MAX_LABEL_LENGTH} characters.`, 400)
    }
    if (this.registered(projectId).length >= MAX_SERVICES_PER_PROJECT) {
      throw new RemoteAccessError(`A project can share at most ${MAX_SERVICES_PER_PROJECT} services.`, 409)
    }
    const record: RemoteServiceRecord = {
      id: randomUUID(),
      projectId,
      port,
      label,
      createdAt: new Date(this.deps.now?.() ?? Date.now()).toISOString()
    }
    this.services = [...this.services, record]
    this.save()
    return { ...record }
  }

  unregister(serviceId: string): void {
    const remaining = this.services.filter(service => service.id !== serviceId)
    if (remaining.length === this.services.length) return
    this.services = remaining
    this.save()
  }

  /** What a paired machine may see, under the grant for that project and nothing wider. */
  list(peer: RemotePeerRecord, projectId: unknown): RemoteServiceRecord[] {
    const project = this.deps.peers.requireProject(peer, projectId) as { id: string }
    return this.registered(project.id)
  }

  /**
   * The loopback port behind a registered service, for the tunnel that will carry it. A port is
   * never taken from the caller: the id is looked up here and the grant is re-checked at the
   * moment of use, so a revocation between listing and connecting refuses the connection.
   */
  tunnelTarget(serviceId: unknown, peer: RemotePeerRecord): { port: number } | null {
    if (typeof serviceId !== 'string' || !serviceId) return null
    const record = this.services.find(service => service.id === serviceId)
    if (!record) return null
    this.deps.peers.requireCurrentProject(peer, record.projectId)
    return { port: record.port }
  }

  async call(peer: RemotePeerRecord, method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method !== 'services.list') throw new RemoteAccessError('Unknown remote method; use tools.list.', 400)
    return this.list(peer, args.projectId)
  }

  private save(): void {
    this.deps.settings.setSetting(SERVICES_SETTING, JSON.stringify(this.services))
  }
}
