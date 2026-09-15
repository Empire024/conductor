import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import type { RemotePeerRecord } from '../shared/remote-control'
import {
  REMOTE_TUNNEL_PATH,
  TUNNEL_MAX_CONNECTIONS,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_SERVICE_HEADER
} from '../shared/remote-services'
import { CLOSE_PROTOCOL_ERROR, FrameDecoder, acceptKey, encodeBinary, encodeClose, encodePong } from '../shared/websocket-framing'
import { refuseUpgrade, type RemoteControlServer } from './remote-control-server'
import { NONCE_HEADER, PEER_HEADER, RemoteAccessError, SIGNATURE_HEADER, TIMESTAMP_HEADER, type RemotePeers } from './remote-peers'

/**
 * The host's half of a preview tunnel: one WebSocket per TCP connection to one registered service.
 *
 * What makes this safe to have at all is what it refuses to take from the caller. A controller
 * names a service id, never a port and never a host; the id is resolved here, through the grant,
 * to a port its owner registered, and the only address this file ever dials is 127.0.0.1. There is
 * no proxy, no redirect and no path: a connection either lands on exactly that loopback port or it
 * is refused before a byte moves.
 *
 * One WebSocket per TCP connection rather than one multiplexed channel, because a dev server's
 * connections are independent - an HTTP request, a hot-reload WebSocket, an EventSource that stays
 * open for an hour - and multiplexing them would mean writing framing, ordering and close semantics
 * that TCP already has. Bytes pass through untouched in binary frames, so an upgrade, a chunked
 * response or a binary protocol the service happens to speak all survive the trip unexamined.
 */

const CLOSE_NORMAL = 1000
const CLOSE_POLICY = 1008

export interface RemoteTunnelHostDependencies {
  peers: RemotePeers
  /** The registry's grant-enforcing hook; the only thing that ever turns an id into a port. */
  services: { tunnelTarget(serviceId: unknown, peer: RemotePeerRecord): { port: number } | null }
  /** The certificate this listener serves; every challenge is signed against it. */
  fingerprint(): string
  /**
   * Injected only so a test can stand in for a service. It is handed a port and nothing else -
   * there is deliberately no host parameter anywhere in this file for a caller to reach.
   */
  connect?(port: number): Socket
}

interface TunnelConnection {
  id: string
  peerId: string
  serviceId: string
  port: number
  ws: Socket
  tcp: Socket
  decoder: FrameDecoder
  closed: boolean
}

export class RemoteTunnelHost {
  private readonly connections = new Map<string, TunnelConnection>()
  private detach: (() => void) | null = null

  constructor(private readonly deps: RemoteTunnelHostDependencies) {}

  /** Serves /v1/tunnel on the pinned listener. The server has already refused browsers by here. */
  listenOn(server: RemoteControlServer): void {
    this.detach?.()
    this.detach = server.onUpgrade(REMOTE_TUNNEL_PATH, (request, socket, head) => { void this.accept(request, socket, head) })
  }

  /** How many tunnelled connections are open, which is what the diagnostics view reports. */
  get openConnections(): number { return this.connections.size }

  /** How many one machine is holding, which is what the cap is counted against. */
  connectionsFor(peerId: string): number {
    let total = 0
    for (const connection of this.connections.values()) if (connection.peerId === peerId) total++
    return total
  }

  /**
   * Revocation. docs/multi-device.md promises a revoked device's access ends immediately, and a
   * tunnel already open is access: it is dropped here rather than left to notice on its next byte.
   */
  closePeer(peerId: string): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.peerId === peerId) this.shutdown(connection, CLOSE_POLICY, 'Access to this machine was revoked.')
    }
  }

  dispose(): void {
    this.detach?.()
    this.detach = null
    for (const connection of [...this.connections.values()]) this.shutdown(connection, CLOSE_NORMAL, '')
  }

  /** The only dial in this file. A port, loopback, and nothing a caller can influence. */
  private dial(port: number): Socket {
    return this.deps.connect ? this.deps.connect(port) : netConnect({ host: '127.0.0.1', port })
  }

  private async accept(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const header = (name: string): string => {
      const value = request.headers[name]
      return typeof value === 'string' ? value : ''
    }
    let peer: RemotePeerRecord
    try {
      // The same authority a call goes through, with 'tunnel' inside the signed bytes: a signature
      // captured from a call or from the push channel cannot open a tunnel, and one made for a
      // tunnel cannot do anything else.
      const authenticated = await this.deps.peers.authenticate({
        peerId: header(PEER_HEADER),
        nonce: header(NONCE_HEADER),
        timestamp: Number(header(TIMESTAMP_HEADER)),
        signature: header(SIGNATURE_HEADER),
        body: Buffer.alloc(0),
        fingerprint: this.deps.fingerprint(),
        purpose: 'tunnel'
      })
      peer = authenticated.peer
    } catch (error) {
      const status = error instanceof RemoteAccessError ? error.status : 401
      return refuseUpgrade(socket, status === 403 ? 403 : status === 401 ? 401 : 503, error instanceof Error ? error.message : 'Unauthorized')
    }
    // Authenticating crosses GitHub, which takes as long as it takes; the owner may have closed
    // the lid meanwhile, and writing 101 to a dead socket would leave a connection nobody holds.
    if (socket.destroyed || !socket.writable) { socket.destroy(); return }

    const serviceId = header(TUNNEL_SERVICE_HEADER)
    let target: { port: number } | null
    try {
      target = this.deps.services.tunnelTarget(serviceId, peer)
    } catch (error) {
      return refuseUpgrade(socket, error instanceof RemoteAccessError ? error.status : 403, error instanceof Error ? error.message : 'Forbidden')
    }
    if (!target) return refuseUpgrade(socket, 404, 'No service with that id is registered on this machine.')

    // The cap is refused as HTTP rather than as a close frame on an opened socket: a 101 followed
    // immediately by a close reads to the other end as "the service accepted and then hung up",
    // which is a different thing to tell the owner than "this machine is holding too many already".
    if (this.connectionsFor(peer.id) >= TUNNEL_MAX_CONNECTIONS) {
      return refuseUpgrade(socket, 429, `That machine already holds ${TUNNEL_MAX_CONNECTIONS} tunnelled connections to this one.`)
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') return refuseUpgrade(socket, 400, 'Bad Request')

    const port = target.port
    let tcp: Socket
    try { tcp = this.dial(port) }
    catch { return refuseUpgrade(socket, 502, 'That service could not be reached on this machine.') }
    // Connect first and upgrade afterwards. A service that is registered but not running is the
    // ordinary case - the owner has not started it yet - and it deserves a plain refusal the pane
    // can show, not a WebSocket that opens and dies.
    let settled = false
    tcp.once('error', () => {
      if (settled) return
      settled = true
      tcp.destroy()
      refuseUpgrade(socket, 502, `Nothing is listening on port ${port} of this machine. The service is probably not running.`)
    })
    tcp.once('connect', () => {
      if (settled) return
      settled = true
      if (socket.destroyed || !socket.writable) { tcp.destroy(); socket.destroy(); return }
      this.attach(peer, serviceId, port, socket, tcp, key, head)
    })
    socket.once('close', () => {
      // The controller gave up while the service was still being dialled; nothing should be left
      // half-open on this machine because of it.
      if (!settled) { settled = true; tcp.destroy() }
    })
  }

  private attach(peer: RemotePeerRecord, serviceId: string, port: number, ws: Socket, tcp: Socket, key: string, head: Buffer): void {
    ws.setNoDelay(true)
    ws.setTimeout(0)
    tcp.setNoDelay(true)
    ws.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )

    const connection: TunnelConnection = {
      id: randomUUID(), peerId: peer.id, serviceId, port, ws, tcp,
      decoder: null as unknown as FrameDecoder, closed: false
    }
    connection.decoder = new FrameDecoder({ maxMessageBytes: TUNNEL_MAX_FRAME_BYTES, requireMask: true }, {
      message: message => {
        // A tunnel carries a TCP connection. Text would mean this side had decided an encoding for
        // bytes that have none, so a text frame here is a controller speaking a different protocol.
        if (message.kind !== 'binary') return this.shutdown(connection, CLOSE_PROTOCOL_ERROR, 'A tunnel carries binary frames only.')
        if (!tcp.writable) return
        // False means the service is not reading as fast as the controller is sending. Stop reading
        // the WebSocket until it catches up, rather than queueing the transfer in this process.
        if (!tcp.write(message.data)) ws.pause()
      },
      ping: payload => { if (!connection.closed && ws.writable) ws.write(encodePong(payload)) },
      pong: () => { /* nothing here measures liveness; TCP's own close is the signal */ },
      close: () => this.shutdown(connection, CLOSE_NORMAL, ''),
      fail: (code, message) => this.shutdown(connection, code, message)
    })
    this.connections.set(connection.id, connection)

    ws.on('data', chunk => connection.decoder.push(chunk as Buffer))
    ws.on('drain', () => { if (!connection.closed) tcp.resume() })
    ws.on('error', () => this.shutdown(connection, CLOSE_NORMAL, ''))
    ws.on('close', () => this.shutdown(connection, CLOSE_NORMAL, ''))

    tcp.on('data', chunk => {
      const bytes = chunk as Buffer
      // One frame is bounded, so a single large read becomes several frames rather than one the
      // other end is entitled to refuse.
      for (let at = 0; at < bytes.length; at += TUNNEL_MAX_FRAME_BYTES) {
        if (connection.closed || !ws.writable) return
        if (!ws.write(encodeBinary(bytes.subarray(at, at + TUNNEL_MAX_FRAME_BYTES)))) tcp.pause()
      }
    })
    tcp.on('drain', () => { if (!connection.closed) ws.resume() })
    tcp.on('end', () => this.shutdown(connection, CLOSE_NORMAL, 'The service closed the connection.'))
    tcp.on('close', () => this.shutdown(connection, CLOSE_NORMAL, ''))
    tcp.on('error', () => this.shutdown(connection, CLOSE_NORMAL, ''))

    if (head?.length) connection.decoder.push(head)
  }

  private shutdown(connection: TunnelConnection, code: number, reason: string): void {
    if (connection.closed) return
    connection.closed = true
    connection.decoder.stop()
    this.connections.delete(connection.id)
    try {
      if (!connection.ws.destroyed) {
        connection.ws.write(encodeClose(code, reason))
        connection.ws.end()
      }
    } catch { /* already gone, which is the outcome */ }
    connection.ws.destroy()
    try { if (!connection.tcp.destroyed) connection.tcp.end() } catch { /* the same */ }
    connection.tcp.destroy()
  }
}
