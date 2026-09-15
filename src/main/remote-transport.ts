import type { MachineConnection, MachineDiagnostics, RemoteConnection, TailscaleState } from '../shared/remote-control'
import type { StreamHostFrame } from '../shared/remote-stream'
import type { DeviceKeyPair } from './device-key'
import { describeConnection } from './machines'
import type { RemoteControlServer } from './remote-control-server'
import type { RemotePeers } from './remote-peers'
import { RemoteStreamClient, type RemoteStreamClientDependencies } from './remote-stream-client'
import { RemoteStreamHost } from './remote-stream-host'
import { findTailscalePeer, type TailscaleService } from './tailscale'

/**
 * One object the rest of the app talks to about the tailnet and the push channel.
 *
 * It exists so that nothing outside this folder has to know that a host is a stream client with a
 * backoff, that the path shown next to a machine comes from `tailscale status` rather than from the
 * socket, or that "detached" means a client that is not merely disconnected but not constructed.
 * IPC asks it four things - what the tailnet looks like, what this machine's connection to that one
 * is, subscribe me to this, and tell that host something changed - and it answers all four without
 * any caller learning the shape underneath.
 */

export interface RemoteTransportDependencies {
  tailscale: TailscaleService
  server: RemoteControlServer
  peers: RemotePeers
  /** The pairings as the client holds them now, re-read rather than cached. */
  connections(): RemoteConnection[]
  deviceKey(): DeviceKeyPair | null
  machineId(): string
  machineName?(): string
  /** Every frame from any host, tagged with which host it came from. */
  onFrame(machineId: string, frame: StreamHostFrame): void
  changed(): void
  /** Mirror cursors per host, for the diagnostics view; the mirror owns them, not this. */
  cursors?(machineId: string): Array<{ localSessionId: string; remoteSequence: number }>
  now?(): number
  /** Test seams, handed straight to each stream client. */
  after?: RemoteStreamClientDependencies['after']
  random?: RemoteStreamClientDependencies['random']
  createSocket?: RemoteStreamClientDependencies['createSocket']
}

export class RemoteTransport {
  readonly host: RemoteStreamHost
  private readonly clients = new Map<string, RemoteStreamClient>()
  private running = false

  constructor(private readonly deps: RemoteTransportDependencies) {
    this.host = new RemoteStreamHost({
      peers: deps.peers,
      machineName: () => deps.machineName?.() ?? deps.peers.getSettings().machineName,
      fingerprint: () => deps.server.identity().fingerprint,
      ...(deps.now ? { now: deps.now } : {})
    })
  }

  /** The tailnet as this machine sees it, re-read now. */
  async tailscaleState(force = false): Promise<TailscaleState> {
    return this.deps.tailscale.state(force)
  }

  /** The same answer without asking again, for the paths the state snapshot is built on. */
  lastTailscaleState(): TailscaleState { return this.deps.tailscale.last() }

  start(): void {
    if (this.running) return
    this.running = true
    this.host.listenOn(this.deps.server)
    this.sync()
  }

  stop(): void {
    this.running = false
    for (const [machineId, client] of this.clients) { client.stop('This machine is shutting down.'); this.clients.delete(machineId) }
    this.host.stop()
  }

  /**
   * Brings the set of live stream clients back in line with the pairings.
   *
   * Called after anything that changes what is paired or attached. A detached host is not a client
   * that is idle: it has none at all, because "needs nothing from that host" has to include the
   * reconnect timer that would otherwise keep firing at a machine the owner has stopped using.
   */
  sync(): void {
    if (!this.running) return
    const wanted = new Map(this.deps.connections()
      .filter(connection => !connection.detached && connection.status !== 'revoked' && connection.peerId)
      .map(connection => [connection.machineId, connection] as const))
    for (const [machineId, client] of [...this.clients]) {
      if (wanted.has(machineId)) continue
      client.stop('No longer attached.')
      this.clients.delete(machineId)
    }
    for (const machineId of wanted.keys()) this.ensure(machineId).start()
  }

  private ensure(machineId: string): RemoteStreamClient {
    const existing = this.clients.get(machineId)
    if (existing) return existing
    const client = new RemoteStreamClient({
      connection: () => this.deps.connections().find(entry => entry.machineId === machineId),
      deviceKey: () => this.deps.deviceKey(),
      machineId: () => this.deps.machineId(),
      onFrame: frame => this.deps.onFrame(machineId, frame),
      changed: () => this.deps.changed(),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.after ? { after: this.deps.after } : {}),
      ...(this.deps.random ? { random: this.deps.random } : {}),
      ...(this.deps.createSocket ? { createSocket: this.deps.createSocket } : {})
    })
    this.clients.set(machineId, client)
    return client
  }

  /** The owner attaching to a host again. Nothing reattaches on its own, so this is the only way in. */
  attach(machineId: string): void {
    if (!this.running) return
    const connection = this.deps.connections().find(entry => entry.machineId === machineId)
    if (!connection || connection.detached) return
    this.ensure(machineId).start()
  }

  /** "Use this computer independently": the client is stopped and dropped, not merely paused. */
  detach(machineId: string): void {
    const client = this.clients.get(machineId)
    if (!client) return
    client.stop('Using this computer independently.')
    this.clients.delete(machineId)
    this.deps.changed()
  }

  subscribe(machineId: string, projectId: string, sessionId: string): void {
    this.clients.get(machineId)?.subscribe(projectId, sessionId)
  }

  unsubscribe(machineId: string, projectId: string, sessionId: string): void {
    this.clients.get(machineId)?.unsubscribe(projectId, sessionId)
  }

  terminalSubscribe(machineId: string, projectId: string, sessionId: string, terminalId: string, fromOffset: number): void {
    this.clients.get(machineId)?.terminalSubscribe(projectId, sessionId, terminalId, fromOffset)
  }

  terminalUnsubscribe(machineId: string, terminalId: string): void {
    this.clients.get(machineId)?.terminalUnsubscribe(terminalId)
  }

  /** Whether that host's push channel is open, which is what slows the mirror's poll down. */
  streaming(machineId: string): boolean {
    return this.clients.get(machineId)?.open ?? false
  }

  /**
   * The live overlay describeMachines puts on top of the stored pairing.
   *
   * The path comes from Tailscale's own reading and nowhere else. A host with no client - detached,
   * revoked, never approved - gets no overlay at all, so the stored record speaks for itself rather
   * than being contradicted by a socket that does not exist.
   */
  connection(machineId: string): Partial<MachineConnection> | undefined {
    const client = this.clients.get(machineId)
    if (!client) return undefined
    const snapshot = client.snapshot()
    const path = this.pathFor(machineId)
    return path ? { ...snapshot, path } : snapshot
  }

  private pathFor(machineId: string): MachineConnection['path'] | null {
    const connection = this.deps.connections().find(entry => entry.machineId === machineId)
    if (!connection || connection.transport !== 'tailscale') return null
    const peer = findTailscalePeer(this.deps.tailscale.last(), connection.host, connection.dnsName)
    return peer ? peer.path : null
  }

  diagnostics(machineId: string): MachineDiagnostics {
    const connection = this.deps.connections().find(entry => entry.machineId === machineId)
    const client = this.clients.get(machineId)
    const stream = client?.stats ?? { open: false, lastHeardAt: null, reconnects: 0 }
    return {
      machineId,
      machineName: connection?.machineName ?? machineId,
      connection: connection
        ? describeConnection(connection, this.connection(machineId))
        : { state: 'offline', path: 'unknown', transport: null, failure: 'authorization', detail: 'This machine is not paired with that one.', generation: 0 },
      endpoint: connection ? { host: connection.host, port: connection.port, fingerprint: connection.fingerprint } : null,
      tailscalePeer: connection ? findTailscalePeer(this.deps.tailscale.last(), connection.host, connection.dnsName) : null,
      lastContactAt: connection?.lastContactAt ?? null,
      cursors: this.deps.cursors?.(machineId) ?? [],
      stream
    }
  }
}
