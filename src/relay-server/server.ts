import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import {
  RELAY_HANDSHAKE_DEADLINE_MS,
  RELAY_HANDSHAKE_MAX_BYTES,
  RELAY_HEALTH_PATH,
  RELAY_HEARTBEAT_MS,
  RELAY_HEARTBEAT_TIMEOUT_MS,
  RELAY_HELLO_SKEW_MS,
  RELAY_ID_PATTERN,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_SEND_BURST,
  RELAY_SEND_RATE_PER_SEC,
  RELAY_SOCKET_PATH,
  RELAY_DIRECTORY_MAX_ENTRY_BYTES,
  RELAY_HELLO_STATEMENT_KIND,
  relayHelloStatement,
  type RelayErrorCode,
  type RelayServerFrame
} from '../shared/relay-protocol.ts'
import { verifyStatement } from '../main/device-key.ts'
import { proofsMatch, roomIdFor, roomProofFor, welcomeProofFor } from '../main/relay-room.ts'
import { CLOSE_PROTOCOL_ERROR, CLOSE_TOO_LARGE, FrameDecoder, acceptKey, encodeClose, encodePing, encodePong, encodeText } from '../shared/websocket-framing.ts'
import { RelayRooms, type RelaySocketHandle } from './rooms.ts'

/**
 * Conductor's own relay.
 *
 * It exists because the alternative did not work: routing the owner's messages through somebody
 * else's API meant living inside somebody else's rate limit, and one machine that happened to be
 * switched off was enough to spend the whole budget and leave every machine looking offline. This
 * server does one job - hand a sealed envelope to the machine it is addressed to - and it does it
 * over a socket that is already open, so an idle pair of machines costs nothing at all.
 *
 * It is written to be run by the person whose machines it links: no accounts, no database, no
 * third-party service, one secret, and nothing on disk. It never sees a plaintext message, and the
 * app refuses anything this server did not carry exactly as its sender sealed and signed it.
 */

export interface RelayServerOptions {
  /** Room secrets this relay serves. Anything that cannot prove one of them is not let in. */
  secrets: string[]
  port?: number
  host?: string
  /** Serve TLS directly instead of behind a proxy that terminates it. */
  tls?: { key: string | Buffer; cert: string | Buffer }
  now?(): number
  log?(line: string): void
}

interface Connection {
  id: string
  socket: Socket
  decoder: FrameDecoder
  nonce: string
  /** Set once the hello is accepted; before that the socket may do almost nothing. */
  roomId: string | null
  machineId: string | null
  helloBytes: number
  tokens: number
  tokensAt: number
  awaitingPong: boolean
  closed: boolean
  handshakeTimer: NodeJS.Timeout
}

const ok = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const CLOSE_NORMAL = 1000
const CLOSE_POLICY = 1008

/** Close codes the owner can act on are carried in the reason, since a client reads both. */
const closeCodeFor = (code: RelayErrorCode): number =>
  code === 'too-large' ? CLOSE_TOO_LARGE : code === 'protocol' ? CLOSE_PROTOCOL_ERROR : CLOSE_POLICY

export class RelayServer {
  readonly rooms: RelayRooms
  private http: Server
  private connections = new Map<string, Connection>()
  /** roomId -> the secret that produced it, so a hello never carries the secret itself. */
  private secrets = new Map<string, string>()
  private heartbeat: NodeJS.Timeout | null = null
  private sweeper: NodeJS.Timeout | null = null
  private started = 0
  /** Set when the relay runs inside something else, whose life it must not extend. */
  private detached = false

  private readonly options: RelayServerOptions

  constructor(options: RelayServerOptions) {
    this.options = options
    const secrets = options.secrets.map(secret => secret.trim()).filter(Boolean)
    if (!secrets.length) throw new Error('A relay server needs at least one room secret')
    for (const secret of secrets) {
      if (secret.length < 16) throw new Error('A relay room secret must be at least 16 characters')
      this.secrets.set(roomIdFor(secret), secret)
    }
    this.rooms = new RelayRooms({ now: () => this.now() })
    const handler = (request: IncomingMessage, response: import('node:http').ServerResponse): void => this.serveHttp(request, response)
    this.http = options.tls
      ? createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, handler)
      : createHttpServer(handler)
    this.http.on('upgrade', (request, socket, head) => this.upgrade(request, socket as Socket, head))
    // A socket that connects and says nothing must not be able to hold a file descriptor for ever.
    this.http.headersTimeout = 10_000
    this.http.requestTimeout = 15_000
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
  private log(line: string): void { this.options.log?.(line) }

  /**
   * Stops the relay from being a reason for its host process to stay alive.
   *
   * On its own - `npm run relay` - the listening socket is the only thing holding the process open
   * and must keep doing so. Inside Conductor it is the opposite: the window decides when the app
   * lives, and a listening socket plus a handful of long-lived connections would otherwise leave
   * the process running after the owner has closed it.
   */
  unref(): void {
    this.detached = true
    this.http.unref?.()
    for (const connection of this.connections.values()) connection.socket.unref?.()
  }

  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.http.once('error', onError)
      this.http.listen(this.options.port ?? 8787, this.options.host ?? '0.0.0.0', () => {
        this.http.off('error', onError)
        resolve()
      })
    })
    this.started = this.now()
    this.heartbeat = setInterval(() => this.beat(), RELAY_HEARTBEAT_MS)
    this.sweeper = setInterval(() => this.rooms.sweep(), RELAY_HEARTBEAT_MS)
    // A relay's own housekeeping is not a reason for the process around it to stay alive. Inside
    // Conductor this is the difference between the app closing and the app appearing to hang.
    this.heartbeat.unref?.()
    this.sweeper.unref?.()
    const address = this.http.address()
    const bound = typeof address === 'object' && address ? address : { address: this.options.host ?? '0.0.0.0', port: this.options.port ?? 8787 }
    return { host: bound.address, port: bound.port }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.sweeper) clearInterval(this.sweeper)
    this.heartbeat = null
    this.sweeper = null
    this.rooms.closeAll('shutting-down', 'This relay is shutting down.')
    for (const connection of [...this.connections.values()]) {
      const socket = connection.socket
      this.shutdown(connection, CLOSE_NORMAL, 'Relay shutting down')
      // A relay's connections are long-lived by design, and http.close() waits for every one of
      // them to end by itself. Asking politely has already happened; this is what makes closing
      // finish rather than wait for peers that may be asleep.
      socket.destroy()
    }
    await new Promise<void>(resolve => this.http.close(() => resolve()))
  }

  private serveHttp(request: IncomingMessage, response: import('node:http').ServerResponse): void {
    const path = (request.url ?? '').split('?')[0]
    if (request.method === 'GET' && path === RELAY_HEALTH_PATH) {
      // Deliberately says nothing about who is here: counts prove the relay is alive without
      // telling an unauthenticated caller anything about the owner's machines.
      const stats = this.rooms.stats()
      const body = JSON.stringify({
        service: 'conductor-relay',
        protocol: RELAY_PROTOCOL_VERSION,
        uptimeMs: Math.max(0, this.now() - this.started),
        rooms: stats.rooms,
        connections: stats.online
      })
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(body)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: 'Not found' }))
  }

  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const path = (request.url ?? '').split('?')[0]
    const key = request.headers['sec-websocket-key']
    const version = request.headers['sec-websocket-version']
    if (path !== RELAY_SOCKET_PATH) return this.refuse(socket, 404, 'Not found')
    if (String(version) !== '13') {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n')
      return
    }
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return this.refuse(socket, 400, 'Bad request')

    socket.setNoDelay(true)
    socket.setTimeout(0)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )

    const id = randomUUID()
    const connection: Connection = {
      id,
      socket,
      decoder: null as unknown as FrameDecoder,
      nonce: randomBytes(24).toString('base64url'),
      roomId: null,
      machineId: null,
      helloBytes: 0,
      tokens: RELAY_SEND_BURST,
      tokensAt: this.now(),
      awaitingPong: false,
      closed: false,
      handshakeTimer: setTimeout(() => this.reject(connection, 'unauthorized', 'This socket did not authenticate in time.'), RELAY_HANDSHAKE_DEADLINE_MS)
    }
    connection.decoder = new FrameDecoder({ maxMessageBytes: RELAY_MAX_FRAME_BYTES, requireMask: true }, {
      message: message => this.onMessage(connection, message.data),
      ping: payload => this.write(connection, encodePong(payload)),
      pong: () => { connection.awaitingPong = false },
      close: () => this.shutdown(connection, CLOSE_NORMAL, ''),
      fail: (code, message) => this.shutdown(connection, code, message)
    })
    this.connections.set(id, connection)

    socket.on('data', (chunk: Buffer) => connection.decoder.push(chunk))
    socket.on('error', () => this.shutdown(connection, CLOSE_NORMAL, ''))
    socket.on('close', () => this.shutdown(connection, CLOSE_NORMAL, ''))

    this.send(connection, { t: 'challenge', protocol: RELAY_PROTOCOL_VERSION, nonce: connection.nonce, serverId: 'conductor-relay' })
    if (head?.length) connection.decoder.push(head)
  }

  private refuse(socket: Socket, status: number, message: string): void {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  private write(connection: Connection, frame: Buffer): void {
    if (connection.closed || connection.socket.destroyed) return
    connection.socket.write(frame)
  }

  private send(connection: Connection, frame: RelayServerFrame): void {
    this.write(connection, encodeText(JSON.stringify(frame)))
  }

  private reject(connection: Connection, code: RelayErrorCode, message: string): void {
    this.send(connection, { t: 'error', code, message })
    this.shutdown(connection, closeCodeFor(code), message)
  }

  private shutdown(connection: Connection, code: number, reason: string): void {
    if (connection.closed) return
    connection.closed = true
    clearTimeout(connection.handshakeTimer)
    connection.decoder.stop()
    this.connections.delete(connection.id)
    this.rooms.leave(connection.id)
    try {
      if (!connection.socket.destroyed) {
        connection.socket.write(encodeClose(code, reason))
        connection.socket.end()
      }
    } catch { /* the socket is already gone, which is the outcome we wanted */ }
  }

  private onMessage(connection: Connection, data: Buffer): void {
    if (connection.closed) return
    if (!connection.machineId) {
      // Before a hello is accepted a socket may send one small frame. Anything else is either a
      // client that is confused or something probing, and neither gets to keep the connection.
      connection.helloBytes += data.length
      if (connection.helloBytes > RELAY_HANDSHAKE_MAX_BYTES) {
        return this.reject(connection, 'too-large', 'The handshake was larger than this relay accepts.')
      }
    }
    let frame: unknown
    try { frame = JSON.parse(data.toString('utf8')) } catch { return this.reject(connection, 'protocol', 'That was not a relay frame.') }
    if (!ok(frame) || typeof frame.t !== 'string') return this.reject(connection, 'protocol', 'That was not a relay frame.')

    if (frame.t === 'hello') return this.onHello(connection, frame)
    if (!connection.machineId) return this.reject(connection, 'unauthorized', 'Say hello before anything else.')
    if (frame.t === 'ping') return this.send(connection, { t: 'pong', ref: typeof frame.ref === 'string' ? frame.ref : '' })
    if (frame.t === 'pong') return
    if (frame.t === 'publish') return this.onPublish(connection, frame)
    if (frame.t === 'send') return this.onSend(connection, frame)
    this.reject(connection, 'protocol', `This relay does not know the frame "${frame.t}".`)
  }

  /**
   * The one moment that decides whether a socket is the owner's.
   *
   * Two independent proofs have to hold over the same statement: an HMAC under the room secret,
   * which is what the stranger on the internet does not have, and an Ed25519 signature by the
   * device key the machine claims to be, which is what one of the owner's own machines cannot forge
   * for another. The statement contains this socket's own nonce, so neither proof can be replayed
   * onto a different connection.
   */
  private onHello(connection: Connection, frame: Record<string, unknown>): void {
    if (connection.machineId) return this.reject(connection, 'protocol', 'This socket has already said hello.')
    const protocol = Number(frame.protocol)
    const roomId = String(frame.roomId ?? '')
    const machineId = String(frame.machineId ?? '')
    const machineName = String(frame.machineName ?? '')
    const deviceKey = String(frame.deviceKey ?? '')
    const nonce = String(frame.nonce ?? '')
    const issuedAt = Number(frame.issuedAt)
    const keyProof = String(frame.keyProof ?? '')
    const roomProof = String(frame.roomProof ?? '')

    if (protocol !== RELAY_PROTOCOL_VERSION) {
      return this.reject(connection, 'protocol', `This relay speaks protocol ${RELAY_PROTOCOL_VERSION}; that machine speaks ${Number.isFinite(protocol) ? protocol : 'something else'}. Update the older one.`)
    }
    if (!RELAY_ID_PATTERN.test(machineId) || !RELAY_ID_PATTERN.test(roomId)) {
      return this.reject(connection, 'protocol', 'That machine or room id is not one this relay can route.')
    }
    if (machineName.length > 200 || deviceKey.length > 1000) return this.reject(connection, 'protocol', 'That hello is larger than one.')
    // The nonce is this socket's own, so a proof made for another connection cannot be presented here.
    if (nonce !== connection.nonce) return this.reject(connection, 'unauthorized', 'That hello answers a different challenge.')
    if (!Number.isFinite(issuedAt) || Math.abs(this.now() - issuedAt) > RELAY_HELLO_SKEW_MS) {
      return this.reject(connection, 'unauthorized', 'That hello is stale; check the clock on that machine.')
    }
    const secret = this.secrets.get(roomId)
    if (!secret) return this.reject(connection, 'unknown-room', 'This relay does not serve that room.')

    const statement = relayHelloStatement({ protocol, roomId, machineId, machineName, deviceKey, nonce, issuedAt })
    if (!proofsMatch(roomProof, roomProofFor(secret, statement))) {
      return this.reject(connection, 'unauthorized', 'That machine did not prove it holds this room secret.')
    }
    if (!verifyStatement(deviceKey, RELAY_HELLO_STATEMENT_KIND, statement, keyProof)) {
      return this.reject(connection, 'unauthorized', 'That machine did not prove it holds the device key it claims.')
    }

    const handle: RelaySocketHandle = {
      id: connection.id,
      send: outgoing => this.send(connection, outgoing),
      close: (code, message) => this.reject(connection, code, message)
    }
    const joined = this.rooms.join(handle, { roomId, machineId, machineName, deviceKey })
    if (!joined.ok) return this.reject(connection, joined.code, joined.message)

    clearTimeout(connection.handshakeTimer)
    connection.roomId = roomId
    connection.machineId = machineId
    this.log(`relay: ${machineId} joined room ${roomId.slice(0, 8)}`)
    this.send(connection, {
      t: 'welcome',
      sessionId: connection.id,
      heartbeatMs: RELAY_HEARTBEAT_MS,
      maxMessageBytes: RELAY_MAX_FRAME_BYTES,
      serverProof: welcomeProofFor(secret, statement, connection.id),
      presence: joined.presence
    })
    // Whatever arrived while this machine was away, then everyone hears that it is back.
    this.rooms.drain(connection.id)
    this.rooms.announce(connection.id)
  }

  private onPublish(connection: Connection, frame: Record<string, unknown>): void {
    const entry = frame.entry
    if (!ok(entry)) return this.reject(connection, 'protocol', 'A directory entry has to be an object.')
    if (JSON.stringify(entry).length > RELAY_DIRECTORY_MAX_ENTRY_BYTES) {
      return this.reject(connection, 'too-large', 'That directory entry is larger than one.')
    }
    // Signed by the publishing machine and checked by whoever reads it; this relay only stores it.
    this.rooms.publish(connection.id, entry)
  }

  private onSend(connection: Connection, frame: Record<string, unknown>): void {
    const ref = typeof frame.ref === 'string' && frame.ref.length <= 100 ? frame.ref : ''
    const to = String(frame.to ?? '')
    const envelope = frame.envelope
    if (!RELAY_ID_PATTERN.test(to)) return this.send(connection, { t: 'rejected', ref, code: 'protocol', message: 'That is not a machine this relay can route to.' })
    if (!ok(envelope)) return this.send(connection, { t: 'rejected', ref, code: 'protocol', message: 'That is not an envelope.' })
    // The relay cannot read an envelope, but it can insist that the outside of one agrees with the
    // socket that sent it: a machine may only send as itself, and only to where it says it is going.
    if (envelope.from !== connection.machineId || envelope.to !== to) {
      return this.send(connection, { t: 'rejected', ref, code: 'unauthorized', message: 'That envelope is addressed differently from the way it was sent.' })
    }
    const bytes = JSON.stringify(envelope).length
    if (bytes > RELAY_MAX_FRAME_BYTES) return this.send(connection, { t: 'rejected', ref, code: 'too-large', message: 'That message is larger than this relay accepts.' })
    if (!this.spend(connection)) {
      return this.send(connection, { t: 'rejected', ref, code: 'rate-limited', message: 'That machine is sending faster than this relay accepts.' })
    }
    const outcome = this.rooms.route(connection.id, to, envelope, bytes)
    if (outcome.ok) this.send(connection, { t: 'accepted', ref, delivery: outcome.delivery })
    else this.send(connection, { t: 'rejected', ref, code: outcome.code, message: outcome.message })
  }

  /** A token bucket per socket: bursts are normal, a flood is not. */
  private spend(connection: Connection): boolean {
    const now = this.now()
    const elapsed = Math.max(0, now - connection.tokensAt) / 1000
    connection.tokensAt = now
    connection.tokens = Math.min(RELAY_SEND_BURST, connection.tokens + elapsed * RELAY_SEND_RATE_PER_SEC)
    if (connection.tokens < 1) return false
    connection.tokens -= 1
    return true
  }

  /**
   * A dropped connection is usually silent, and a relay that keeps routing into one is a relay that
   * loses messages. Every heartbeat asks, and a socket that has not answered the last one is gone.
   */
  private beat(): void {
    for (const connection of [...this.connections.values()]) {
      if (connection.awaitingPong) {
        this.shutdown(connection, CLOSE_NORMAL, 'No answer to the last heartbeat')
        continue
      }
      connection.awaitingPong = true
      this.write(connection, encodePing())
    }
    setTimeout(() => {
      for (const connection of [...this.connections.values()]) {
        if (connection.awaitingPong) this.shutdown(connection, CLOSE_NORMAL, 'No answer to the last heartbeat')
      }
    }, RELAY_HEARTBEAT_TIMEOUT_MS).unref?.()
  }
}

export async function startRelayServer(options: RelayServerOptions): Promise<{ server: RelayServer; host: string; port: number }> {
  const server = new RelayServer(options)
  const bound = await server.listen()
  return { server, ...bound }
}
