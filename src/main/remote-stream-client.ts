import { randomBytes } from 'node:crypto'
import type { ConnectionFailure, ConnectionState, MachineConnection, RemoteConnection } from '../shared/remote-control'
import {
  REMOTE_STREAM_PATH,
  REMOTE_STREAM_PROTOCOL,
  STREAM_HEARTBEAT_MS,
  STREAM_MAX_FRAME_BYTES,
  STREAM_RECONNECT_MAX_MS,
  STREAM_RECONNECT_MIN_MS,
  STREAM_TIMEOUT_MS,
  readStreamFrame,
  type StreamClientFrame,
  type StreamHostFrame
} from '../shared/remote-stream'
import { signChallenge, type ChallengePayload, type DeviceKeyPair } from './device-key'
import { RelaySocket, type RelaySocketEvents, type RelaySocketOptions } from './relay-socket'
import { hashBody, NONCE_HEADER, PEER_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './remote-peers'
import { isTailscaleAddress } from './tailscale'

/**
 * The controlling machine's half of the push channel: one socket per host, opened over the host's
 * pinned certificate and signed with this machine's device key at the upgrade itself.
 *
 * The signature is on the upgrade request rather than a frame after it, because a socket that is
 * already open is already trusted - putting the proof afterwards would mean the host had to hold a
 * connection for something that had proved nothing yet, which is exactly the thing a stranger on
 * the tailnet would use.
 *
 * Reconnecting is deliberately dumb and deliberately bounded. Nothing on this side is lost by a
 * dropped socket: subscriptions are re-sent on the next welcome and the mirror resyncs from its
 * cursors, so backing off and trying again is the whole recovery. What it must not do is retry
 * something that will never work - a revoked pairing or a version mismatch - because that is how a
 * laptop spends a night knocking on a door that will not open.
 */

/** The socket half this client needs, so a test can hand it something that is not a network. */
/** How long an `error` frame stays the explanation for a close that follows it. */
const REFUSAL_VERDICT_MS = 2_000

export interface StreamSocket {
  readonly connected: boolean
  connect(): void
  send(value: unknown): void
  ping(): void
  close(code?: number, reason?: string): void
}

export interface RemoteStreamClientDependencies {
  /** The pairing record as it is now; re-read on every dial so a changed address is honoured. */
  connection(): RemoteConnection | undefined
  deviceKey(): DeviceKeyPair | null
  machineId(): string
  onFrame(frame: StreamHostFrame): void
  /** The state below changed; the machines list and the diagnostics view read it again. */
  changed?(): void
  now?(): number
  /** One-shot timer. Injected so backoff and heartbeat are exercised without waiting. */
  after?(ms: number, run: () => void): { cancel(): void }
  /** Jitter source, injected so a test asserts a delay instead of a range. */
  random?(): number
  createSocket?(url: string, events: RelaySocketEvents, options: RelaySocketOptions): StreamSocket
}

/**
 * The signed headers that open a stream or a tunnel. Both ends build the challenge from this one
 * function, so "what exactly is signed" is a single fact rather than two that have to agree.
 */
export function signUpgrade(
  key: DeviceKeyPair,
  target: { machineId: string; fingerprint: string; peerId: string },
  purpose: 'stream' | 'tunnel',
  issuedAt: number
): Record<string, string> {
  const payload: ChallengePayload = {
    audienceMachineId: target.machineId,
    fingerprint: target.fingerprint,
    nonce: randomBytes(18).toString('base64url'),
    purpose,
    // An upgrade carries no body, and the host hashes the empty buffer on its side. Signing the
    // literal empty string instead would be a different challenge that silently never verifies.
    bodyHash: hashBody(Buffer.alloc(0)),
    issuedAt
  }
  return {
    [PEER_HEADER]: target.peerId,
    [NONCE_HEADER]: payload.nonce,
    [TIMESTAMP_HEADER]: String(payload.issuedAt),
    [SIGNATURE_HEADER]: signChallenge(key.privateKeyPem, payload)
  }
}

export function streamUrl(host: string, port: number): string {
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `wss://${address}:${port}${REMOTE_STREAM_PATH}`
}

export class RemoteStreamClient {
  private socket: StreamSocket | null = null
  private state: ConnectionState = 'offline'
  private failure: ConnectionFailure = null
  private detail: string | null = null
  private attempts = 0
  private reconnects = 0
  private lastHeardAt: number | null = null
  private started = false
  /** Set when retrying cannot help: a revoked pairing, a version mismatch, a host off the tailnet. */
  private fatal = false
  /**
   * The last `error` frame, kept only until the host proves it is still talking or hangs up. The
   * host answers a refused subscription with one and keeps the connection; it sends one and then
   * closes when it means the whole connection. The frame alone is therefore not a verdict - the
   * close that may follow it is, and this is what tells that close what it was about.
   */
  private refused: { failure: ConnectionFailure; message: string; at: number } | null = null
  private retry: { cancel(): void } | null = null
  private beat: { cancel(): void } | null = null
  private readonly subscriptions = new Map<string, { projectId: string; sessionId: string }>()
  private readonly terminals = new Map<string, { projectId: string; sessionId: string; fromOffset: number }>()

  constructor(private readonly deps: RemoteStreamClientDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private after(ms: number, run: () => void): { cancel(): void } {
    if (this.deps.after) return this.deps.after(ms, run)
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return { cancel: () => clearTimeout(handle) }
  }

  /** How this host is reached right now, as the machines list and the diagnostics view show it. */
  snapshot(): MachineConnection {
    const connection = this.deps.connection()
    return {
      state: connection?.detached ? 'detached' : this.state,
      // Whether the tailnet carries this directly or over DERP is Tailscale's answer, not this
      // socket's; the transport facade overlays it from `tailscale status`.
      path: 'unknown',
      transport: connection?.transport ?? null,
      failure: connection?.detached ? null : this.failure,
      detail: connection?.detached ? 'Using this computer independently.' : this.detail,
      generation: connection?.generation ?? 0
    }
  }

  get open(): boolean { return this.state === 'connected' }
  get stats(): { open: boolean; lastHeardAt: string | null; reconnects: number } {
    return { open: this.open, lastHeardAt: this.lastHeardAt === null ? null : new Date(this.lastHeardAt).toISOString(), reconnects: this.reconnects }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.fatal = false
    this.attempts = 0
    this.dial()
  }

  stop(reason = 'Stopped.'): void {
    this.started = false
    this.retry?.cancel(); this.retry = null
    this.beat?.cancel(); this.beat = null
    const socket = this.socket
    this.socket = null
    socket?.close(1000, reason.slice(0, 100))
    this.publish(this.deps.connection()?.detached ? 'detached' : 'offline', this.failure, this.detail)
  }

  subscribe(projectId: string, sessionId: string): void {
    this.subscriptions.set(`${projectId}\u0000${sessionId}`, { projectId, sessionId })
    this.send({ type: 'subscribe', projectId, sessionId })
  }

  unsubscribe(projectId: string, sessionId: string): void {
    if (!this.subscriptions.delete(`${projectId}\u0000${sessionId}`)) return
    this.send({ type: 'unsubscribe', projectId, sessionId })
  }

  terminalSubscribe(projectId: string, sessionId: string, terminalId: string, fromOffset: number): void {
    this.terminals.set(terminalId, { projectId, sessionId, fromOffset })
    this.send({ type: 'terminal.subscribe', projectId, sessionId, terminalId, fromOffset })
  }

  terminalUnsubscribe(terminalId: string): void {
    if (!this.terminals.delete(terminalId)) return
    this.send({ type: 'terminal.unsubscribe', terminalId })
  }

  /**
   * Where the controller's own cursor moved on. A reconnect asks from here rather than from the
   * offset it first attached at, so the bytes it already showed are not replayed into the pane.
   */
  terminalProgress(terminalId: string, offset: number): void {
    const entry = this.terminals.get(terminalId)
    if (entry && offset > entry.fromOffset) entry.fromOffset = offset
  }

  private send(frame: StreamClientFrame): void {
    if (this.state !== 'connected' || !this.socket) return
    this.socket.send(frame)
  }

  private dial(): void {
    if (!this.started || this.fatal || this.socket) return
    const connection = this.deps.connection()
    if (!connection) return this.settle('offline', 'network', 'This machine is not paired with that one.', { fatal: true })
    if (connection.detached) return this.settle('detached', null, 'Using this computer independently.', { fatal: true })
    if (connection.status === 'revoked') return this.settle('offline', 'authorization', connection.message ?? 'That machine revoked this pairing.', { fatal: true })
    if (!connection.peerId) return this.settle('offline', 'authorization', 'That pairing has not been approved yet.', { fatal: true })
    // The whole promise of a Tailscale pairing in one line: this connection has exactly one route,
    // and a stored address that is not on the tailnet is not it. Dialling it anyway would send the
    // owner's signed request somewhere their tailnet does not reach and their firewall does not
    // cover, which is the fallback this exposure exists to refuse.
    if (connection.transport === 'tailscale' && !isTailscaleAddress(connection.host)) {
      return this.settle('offline', 'network',
        `${connection.machineName} was paired over Tailscale, but ${connection.host || 'no address'} is not a tailnet address. Create a new pairing code on that machine.`,
        { fatal: true })
    }
    const key = this.deps.deviceKey()
    if (!key) return this.settle('offline', 'authorization', 'This machine has no device key yet; sign in to GitHub here first.', { fatal: true })

    const opening = this.attempts === 0 ? 'connecting' : 'reconnecting'
    this.attempts += 1
    this.publish(opening, null, null)
    const events: RelaySocketEvents = {
      open: () => { this.lastHeardAt = this.now() },
      pong: () => { this.lastHeardAt = this.now() },
      frame: frame => this.onFrame(frame),
      closed: detail => this.onClosed(socket, detail)
    }
    const options: RelaySocketOptions = {
      maxMessageBytes: STREAM_MAX_FRAME_BYTES,
      fingerprint: connection.fingerprint,
      subject: 'host',
      headers: signUpgrade(key, { machineId: connection.machineId, fingerprint: connection.fingerprint, peerId: connection.peerId }, 'stream', this.now())
    }
    const url = streamUrl(connection.host, connection.port)
    const socket: StreamSocket = this.deps.createSocket
      ? this.deps.createSocket(url, events, options)
      : new RelaySocket(url, events, options)
    this.socket = socket
    socket.connect()
  }

  private onFrame(raw: Record<string, unknown>): void {
    this.lastHeardAt = this.now()
    const frame = readStreamFrame(raw) as StreamHostFrame | null
    if (!frame) return this.hangUp('protocol', 'That machine sent something this build does not understand.')
    if (frame.type === 'welcome') {
      if (frame.protocol !== REMOTE_STREAM_PROTOCOL) {
        return this.hangUp('protocol', `That machine speaks stream protocol ${frame.protocol}, this one speaks ${REMOTE_STREAM_PROTOCOL}. Update both computers.`)
      }
      this.attempts = 0
      const connection = this.deps.connection()
      // Hello and the replays go out before anyone hears "connected": a listener that subscribes the
      // moment the state changes would otherwise put its frame on the wire ahead of hello, and the
      // host rightly refuses a subscription from a peer that has not said who it is.
      this.socket?.send({ type: 'hello', protocol: REMOTE_STREAM_PROTOCOL, machineId: this.deps.machineId(), generation: connection?.generation ?? 0 } satisfies StreamClientFrame)
      // Everything this machine was watching before the socket dropped, asked for again. The host
      // keeps no subscription across a connection, by design: the controller is the one that knows
      // what it is still looking at.
      for (const entry of this.subscriptions.values()) this.socket?.send({ type: 'subscribe', ...entry } satisfies StreamClientFrame)
      for (const [terminalId, entry] of this.terminals) {
        this.socket?.send({ type: 'terminal.subscribe', terminalId, projectId: entry.projectId, sessionId: entry.sessionId, fromOffset: entry.fromOffset } satisfies StreamClientFrame)
      }
      this.publish('connected', null, null)
      this.armHeartbeat()
      this.deps.onFrame(frame)
      return
    }
    if (frame.type === 'revoked') {
      this.deps.onFrame(frame)
      return this.hangUp('authorization', frame.reason || 'That machine revoked this pairing.')
    }
    if (frame.type === 'error') {
      this.deps.onFrame(frame)
      if (frame.code === 'overloaded') {
        // Being too slow is a state, not a verdict. Reconnecting resyncs from cursors and costs
        // one round trip, so this one is retried like any dropped socket.
        return this.hangUp(null, frame.message || 'That connection fell behind and was closed.', { retry: true })
      }
      // Not a verdict on the connection by itself (see `refused`). A host that means the whole
      // connection closes it right behind this frame; one that refused a single subscription keeps
      // talking, and the refusal is left in the diagnostics rather than in the connection state.
      this.refused = {
        failure: (frame.code === 'authorization' ? 'authorization' : 'protocol') as ConnectionFailure,
        message: frame.message || 'That machine refused this connection.',
        at: this.now()
      }
      this.detail = this.refused.message
      return
    }
    // Anything else the host sends after a refusal proves the refusal was about one subscription,
    // not the connection.
    this.refused = null
    if (frame.type === 'terminal.data') this.terminalProgress(frame.terminalId, frame.offset + Buffer.byteLength(frame.data, 'base64'))
    if (frame.type === 'terminal.gap') this.terminalProgress(frame.terminalId, frame.offset)
    this.deps.onFrame(frame)
  }

  /** Closes this socket for a reason of our own, and decides whether to try again. */
  private hangUp(failure: ConnectionFailure, detail: string, options: { retry?: boolean } = {}): void {
    const socket = this.socket
    this.socket = null
    this.beat?.cancel(); this.beat = null
    socket?.close(1000, detail.slice(0, 100))
    if (options.retry) {
      this.failure = failure
      this.detail = detail
      this.scheduleRetry()
      return
    }
    this.settle('offline', failure, detail, { fatal: true })
  }

  private onClosed(socket: StreamSocket, detail: { code: number; reason: string; error?: Error }): void {
    if (this.socket !== socket) return
    this.socket = null
    this.beat?.cancel(); this.beat = null
    if (!this.started) return
    const wasConnected = this.state === 'connected'
    if (wasConnected) this.reconnects += 1
    // A close right behind an `error` frame is that error's verdict; anything else is read from
    // the close itself.
    const refused = this.refused
    this.refused = null
    // A host that means the connection closes it right behind its error frame; a refusal that is
    // seconds old belongs to a subscription, and a later drop is read for what it is.
    const verdict = refused && !detail.error && this.now() - refused.at <= REFUSAL_VERDICT_MS
    const { failure, fatal, message } = verdict
      ? { failure: refused.failure, fatal: true, message: refused.message }
      : classifyClose(detail, wasConnected)
    this.failure = failure
    this.detail = message
    if (fatal) return this.settle('offline', failure, message, { fatal: true })
    this.scheduleRetry()
  }

  /**
   * Backoff with jitter, doubling from one second to thirty. The jitter is not decoration: two
   * machines that lost the same network come back at the same instant and knock in lockstep for as
   * long as it stays down.
   */
  private scheduleRetry(): void {
    if (!this.started || this.retry) return
    const exponent = Math.max(0, this.attempts - 1)
    const ceiling = Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_MIN_MS * 2 ** exponent)
    const random = this.deps.random?.() ?? Math.random()
    const wait = Math.max(STREAM_RECONNECT_MIN_MS, Math.round(ceiling * (0.5 + 0.5 * Math.min(1, Math.max(0, random)))))
    this.publish('reconnecting', this.failure, this.detail)
    this.retry = this.after(wait, () => { this.retry = null; this.dial() })
  }

  /** How long the next attempt waits, for tests and for explaining the schedule. */
  nextRetryMs(): number {
    const exponent = Math.max(0, this.attempts - 1)
    return Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_MIN_MS * 2 ** exponent)
  }

  private armHeartbeat(): void {
    this.beat?.cancel()
    this.beat = this.after(STREAM_HEARTBEAT_MS, () => {
      this.beat = null
      if (this.state !== 'connected' || !this.socket) return
      if (this.now() - (this.lastHeardAt ?? 0) >= STREAM_TIMEOUT_MS) {
        // Silence on a TCP connection is indistinguishable from a working one until something is
        // written, and a laptop that slept through a network change has exactly this shape.
        const socket = this.socket
        this.socket = null
        socket.close(1001, 'No answer')
        this.failure = 'network'
        this.detail = 'That machine stopped answering the connection.'
        this.reconnects += 1
        this.scheduleRetry()
        return
      }
      this.socket.ping()
      this.armHeartbeat()
    })
  }

  private settle(state: ConnectionState, failure: ConnectionFailure, detail: string | null, options: { fatal?: boolean } = {}): void {
    if (options.fatal) {
      this.fatal = true
      this.retry?.cancel(); this.retry = null
      this.beat?.cancel(); this.beat = null
    }
    this.publish(state, failure, detail)
  }

  private publish(state: ConnectionState, failure: ConnectionFailure, detail: string | null): void {
    if (this.state === state && this.failure === failure && this.detail === detail) return
    this.state = state
    this.failure = failure
    this.detail = detail
    this.deps.changed?.()
  }
}

/**
 * Why a socket ended, in the four terms that each need a different thing done about them.
 *
 * The operating system's error code is the input wherever there is one, because it is the only
 * part of this that is not a guess. A host that refused the connection is not running Conductor; a
 * network that has no route to it is a network problem; a 401 or 403 on the upgrade is a pairing
 * that is over and must stop being retried; and anything this build cannot speak is a version
 * mismatch that waiting will not fix either.
 */
export function classifyClose(
  detail: { code: number; reason: string; error?: Error },
  wasConnected: boolean
): { failure: ConnectionFailure; fatal: boolean; message: string } {
  const error = detail.error as (Error & { code?: string; status?: number }) | undefined
  const status = error?.status ?? 0
  const code = error?.code ?? ''
  const message = (error?.message || detail.reason || 'That machine closed the connection.').slice(0, 300)
  if (status === 401 || status === 403) return { failure: 'authorization', fatal: true, message }
  // A certificate that is not the pinned one means something else is answering at that address.
  // Retrying cannot turn it back into the paired machine; only a new pairing code can.
  if (code === 'ERR_TLS_CERT_PIN') return { failure: 'authorization', fatal: true, message }
  if (status === 404 || status === 426 || status === 400) return { failure: 'protocol', fatal: true, message }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return { failure: 'host-not-running', fatal: false, message }
  if (code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { failure: 'network', fatal: false, message }
  }
  // Nothing named a cause. A socket that had been working and simply ended is the host going away;
  // one that never opened at all is this machine failing to reach it.
  return { failure: wasConnected ? 'host-not-running' : 'network', fatal: false, message }
}
