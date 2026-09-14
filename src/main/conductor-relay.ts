import { randomUUID } from 'node:crypto'
import {
  RELAY_HEARTBEAT_MS,
  RELAY_HEARTBEAT_TIMEOUT_MS,
  RELAY_HELLO_STATEMENT_KIND,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_SOCKET_PATH,
  relayHelloStatement,
  type RelayPresence
} from '../shared/relay-protocol'
import {
  RELAY_BACKGROUND_CALL_TIMEOUT_MS,
  RELAY_CALL_TIMEOUT_MS,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_MESSAGE_TTL_MS,
  RELAY_SEEN_TTL_MS,
  type RelayDirectoryEntry,
  type RelayEnvelope,
  type RelayRequestBody,
  type RelayResponseBody,
  type RelayStatus
} from '../shared/remote-relay'
import { signStatement, type DeviceKeyPair } from './device-key'
import {
  openMessage,
  readDirectoryEntry,
  readEnvelope,
  signDirectoryEntry,
  verifyDirectoryEntry,
  type RelaySealKeyPair
} from './relay-crypto'
import { bindingOf, buildEnvelopes, envelopeIsAuthentic } from './relay-envelope'
import { proofsMatch, roomIdFor, roomProofFor, welcomeProofFor } from './relay-room'
import { RelaySocket, type RelaySocketEvents } from './relay-socket'
import { RemoteAccessError } from './remote-peers'
import type { RelayCallOptions } from './remote-relay'

/**
 * The off-network route when the owner runs their own relay.
 *
 * It carries exactly what the direct HTTPS transport carries - the same path, the same signed
 * headers, the same request bytes - so every rule about who may do what still lives in remote-peers
 * and remote-control-host and is enforced identically whichever way a request arrived. What changes
 * against the gist route is only the road: a socket that is already open, so a message leaves the
 * moment it is written instead of on the next poll, presence is stated rather than discovered, and
 * an idle pair of machines costs nothing rather than a request every fifteen seconds against an
 * account budget that a single unreachable machine could drain on its own.
 *
 * The relay is not trusted with any of it. Messages are sealed to a key published in a directory
 * entry signed by the account's device key, the routing fields are authenticated, and a machine
 * still proves itself to the server with both the room secret and its own device key - so a relay
 * that is hostile, compromised, or simply the wrong one can drop traffic but can neither read it
 * nor write a message that any machine will act on.
 */

export interface ConductorRelayDependencies {
  /** ws:// or wss:// address of the owner's relay, or null when they run none. */
  endpoint(): string | null
  /** Other addresses the same relay answers on, tried in turn when the first cannot be reached. */
  alternateEndpoints?(): string[]
  /** The room secret both machines and the server share; never sent, only proved. */
  roomSecret(): string | null
  machineId(): string
  machineName(): string
  deviceKey(): DeviceKeyPair | null
  sealKey(): RelaySealKeyPair | null
  fingerprint(): string | null
  peerDeviceKey(machineId: string): string | null
  /** Serves an inbound request exactly as the HTTPS listener does. */
  handle(path: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: string }>
  enabled(): boolean
  changed?(status: RelayStatus): void
  now?(): number
  /** Test seams: deterministic time, deterministic reconnects, and a socket that can be faked. */
  schedule?(run: () => void, ms: number): { cancel(): void }
  createSocket?(url: string, events: RelaySocketEvents): { connect(): void; send(value: unknown): void; close(code?: number, reason?: string): void }
  /** The relay certificate pinned for this machine, when it is one the owner runs themselves. */
  pinnedFingerprint?(): string | null
}

interface PendingCall {
  resolve(value: RelayResponseBody): void
  reject(error: Error): void
  expiresAt: number
  peerMachineId: string
  peerDeviceKey: string
}

interface PendingSend {
  resolve(): void
  reject(error: Error): void
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Only the pairing endpoints carry a device key the receiver has not approved yet. */
const pairingKeyFromBody = (path: string, body: Buffer): string | null => {
  if (path !== '/remote/pair' && path !== '/remote/pair/status') return null
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    return isRecord(parsed) && typeof parsed.publicKey === 'string' && parsed.publicKey ? parsed.publicKey : null
  } catch { return null }
}

/** Accepts what an owner is likely to paste and turns it into the socket address. */
export function relayEndpointUrl(configured: string): string {
  const trimmed = configured.trim()
  if (!trimmed) throw new RemoteAccessError('This machine has no relay address.', 503)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`
  let url: URL
  try { url = new URL(withScheme) } catch { throw new RemoteAccessError(`"${configured}" is not a relay address.`, 400) }
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new RemoteAccessError(`A relay address has to be ws:// or wss://, not "${url.protocol}".`, 400)
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = RELAY_SOCKET_PATH
  return url.toString()
}

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000
/** How long `call` waits for a connection that is on its way up before giving the owner an answer. */
const CONNECT_WAIT_MS = 12_000
/**
 * How long a relay may be unreachable before this machine stops waiting for it.
 *
 * Past this, the machine is stranded: the relay it was told to use cannot be reached from where it
 * is - no IPv6 on this network, the machine running it asleep, an address that was true at home and
 * is not here - and going on refusing every other route would mean the owner's machines simply
 * cannot meet. Long enough that an ordinary reconnection is not mistaken for it.
 */
const STRANDED_AFTER_MS = 45_000

export class ConductorRelay {
  private socket: { connect(): void; send(value: unknown): void; close(code?: number, reason?: string): void } | null = null
  private pending = new Map<string, PendingCall>()
  private sends = new Map<string, PendingSend>()
  private presence = new Map<string, RelayPresence>()
  private seen = new Map<string, number>()
  private partial = new Map<string, { chunks: Map<number, string>; envelope: RelayEnvelope; firstSeenAt: number }>()
  private helloStatement = ''
  private published = ''
  private attempt = 0
  /** Which of the relay's addresses to try next; a machine's best address depends on where it is. */
  private address = 0
  private timer: { cancel(): void } | null = null
  private expiry: { cancel(): void } | null = null
  private heartbeat: { cancel(): void } | null = null
  private pongDeadline = 0
  private ready = false
  /** Set while the owner has switched this off, so a closing socket cannot reconnect behind them. */
  private stopped = false
  /** When this machine first failed to reach the relay, cleared the moment it does. */
  private failingSince: number | null = null
  private strandedTimer: { cancel(): void } | null = null
  private waiters: Array<{ resolve(): void; reject(error: Error): void }> = []
  private status: RelayStatus = { phase: 'off', reachable: [], lastPollAt: null, message: null, route: 'server' }

  constructor(private readonly deps: ConductorRelayDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  getStatus(): RelayStatus { return { ...this.status, reachable: [...this.status.reachable] } }

  /** True when this machine is set up to use a relay of the owner's own at all. */
  configured(): boolean {
    return Boolean(this.deps.endpoint() && this.deps.roomSecret())
  }

  /**
   * True when the relay has been out of reach long enough that waiting for it is no longer the
   * right thing to do. The connection keeps being retried, so this reverses itself the moment the
   * relay can be reached again.
   */
  stranded(): boolean {
    return this.failingSince !== null && this.now() - this.failingSince >= STRANDED_AFTER_MS
  }

  private setStatus(patch: Partial<RelayStatus>): void {
    const next = { ...this.status, ...patch }
    // The address is part of what changed, not decoration: this machine moves between the relay's
    // addresses, and a status that kept saying the first one would name a relay it is not on.
    if (next.phase === this.status.phase && next.message === this.status.message &&
        next.endpoint === this.status.endpoint &&
        next.lastPollAt === this.status.lastPollAt && next.reachable.join() === this.status.reachable.join()) return
    this.status = next
    this.deps.changed?.(this.getStatus())
  }

  private schedule(run: () => void, ms: number): { cancel(): void } {
    if (this.deps.schedule) return this.deps.schedule(run, ms)
    const handle = setTimeout(run, ms)
    // A pending reconnect is not a reason to keep the app alive while it is trying to close.
    handle.unref?.()
    return { cancel: () => clearTimeout(handle) }
  }

  /** Re-reads settings and identity, then opens or closes the connection to match. */
  start(): void {
    if (!this.deps.enabled() || !this.configured() || !this.deps.deviceKey() || !this.deps.sealKey()) { this.stop(); return }
    this.stopped = false
    if (this.socket) return
    this.open()
  }

  stop(): void {
    this.stopped = true
    this.expiry?.cancel()
    this.heartbeat?.cancel()
    this.expiry = this.heartbeat = null
    this.ready = false
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'Remote control was switched off here.')
    // Closing is what tells the reconnect logic the socket went away, so the timer it may have
    // just armed is cancelled after the close rather than before it. Otherwise switching remote
    // control off - or quitting - would be followed a second later by connecting again.
    this.timer?.cancel()
    this.timer = null
    this.attempt = 0
    this.failingSince = null
    this.strandedTimer?.cancel()
    this.strandedTimer = null
    this.presence.clear()
    this.published = ''
    this.failWaiters(new RemoteAccessError('The relay was switched off while this request was pending.', 503))
    for (const [id, call] of this.pending) {
      this.pending.delete(id)
      call.reject(new RemoteAccessError('The relay was switched off while this request was pending.', 503))
    }
    for (const [ref, send] of this.sends) {
      this.sends.delete(ref)
      send.reject(new RemoteAccessError('The relay was switched off while this request was pending.', 503))
    }
    this.setStatus({ phase: 'off', reachable: [], message: null })
  }

  /** Publishes this machine's entry so another one can find and seal to it. */
  async checkIn(): Promise<void> {
    this.start()
    this.publish()
  }

  /** Every address this relay is known to answer on, best first. */
  private addresses(): string[] {
    const primary = this.deps.endpoint()
    return [...(primary ? [primary] : []), ...(this.deps.alternateEndpoints?.() ?? [])].filter(Boolean)
  }

  private open(): void {
    const addresses = this.addresses()
    const endpoint = addresses[this.address % Math.max(1, addresses.length)]
    if (!endpoint) return
    let url: string
    try { url = relayEndpointUrl(endpoint) }
    catch (error) {
      this.setStatus({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }
    this.setStatus({
      phase: this.attempt ? this.status.phase : 'connecting',
      message: this.attempt ? this.status.message : null,
      endpoint
    })
    const events: RelaySocketEvents = {
      open: () => { /* nothing is true yet: the challenge and the proofs decide that */ },
      frame: frame => this.onFrame(frame),
      closed: detail => this.onClosed(detail)
    }
    this.socket = this.deps.createSocket
      ? this.deps.createSocket(url, events)
      : new RelaySocket(url, events, {
          maxMessageBytes: RELAY_MAX_FRAME_BYTES,
          ...(this.deps.pinnedFingerprint?.() ? { fingerprint: this.deps.pinnedFingerprint()! } : {})
        })
    this.socket.connect()
  }

  private onClosed(detail: { code: number; reason: string; error?: Error }): void {
    if (this.stopped) { this.socket = null; this.ready = false; return }
    const wasReady = this.ready
    this.ready = false
    this.socket = null
    this.heartbeat?.cancel()
    this.heartbeat = null
    this.presence.clear()
    this.published = ''
    for (const [ref, send] of this.sends) {
      this.sends.delete(ref)
      send.reject(new RemoteAccessError('The relay connection dropped before that message was accepted.', 503))
    }
    const reason = detail.error?.message || detail.reason || 'The relay closed the connection.'
    this.failWaiters(new RemoteAccessError(reason, 503))
    if (!this.deps.enabled() || !this.configured()) { this.setStatus({ phase: 'off', reachable: [], message: null }); return }
    if (this.failingSince === null) {
      this.failingSince = this.now()
      // Being stranded is the passage of time rather than an event, and nothing else would notice
      // it: the reconnect backoff may be longer than the threshold, and a status that repeats itself
      // publishes nothing. So the moment is announced on its own.
      this.strandedTimer?.cancel()
      this.strandedTimer = this.schedule(() => {
        this.strandedTimer = null
        if (this.stranded()) this.deps.changed?.(this.getStatus())
      }, STRANDED_AFTER_MS)
    }
    this.setStatus({ phase: 'unavailable', reachable: [], message: reason })
    // A relay that is down is not a reason to stop trying, but it is a reason to stop trying hard:
    // the backoff is what keeps a dead address from turning into a busy loop on a laptop battery.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.attempt, 5))
    this.attempt = wasReady ? 1 : this.attempt + 1
    // An address that did not answer is not the address to keep trying: the next attempt takes the
    // next one the relay is known to answer on, which is how a machine that came home finds it.
    if (!wasReady) this.address += 1
    this.timer?.cancel()
    this.timer = this.schedule(() => { this.timer = null; this.start() }, delay)
  }

  private send(frame: unknown): void {
    this.socket?.send(frame)
  }

  private onFrame(frame: Record<string, unknown>): void {
    const type = String(frame.t ?? '')
    if (type === 'challenge') return this.onChallenge(frame)
    if (type === 'welcome') return this.onWelcome(frame)
    if (type === 'presence') return this.onPresence(frame)
    if (type === 'envelope') { void this.onEnvelope(frame.envelope); return }
    if (type === 'accepted') return this.settleSend(String(frame.ref ?? ''), null)
    if (type === 'rejected') {
      return this.settleSend(String(frame.ref ?? ''), new RemoteAccessError(
        typeof frame.message === 'string' && frame.message ? frame.message : 'The relay refused that message.',
        frame.code === 'unknown-peer' ? 503 : frame.code === 'too-large' ? 413 : frame.code === 'rate-limited' ? 429 : 502))
    }
    if (type === 'pong') { this.pongDeadline = 0; return }
    if (type === 'error') {
      const message = typeof frame.message === 'string' ? frame.message : 'The relay refused this machine.'
      this.setStatus({ phase: frame.code === 'unauthorized' || frame.code === 'unknown-room' ? 'error' : 'unavailable', message })
      this.socket?.close(1000, 'refused')
    }
  }

  private onChallenge(frame: Record<string, unknown>): void {
    const key = this.deps.deviceKey()
    const secret = this.deps.roomSecret()
    if (!key || !secret) return
    const protocol = Number(frame.protocol)
    if (protocol !== RELAY_PROTOCOL_VERSION) {
      this.setStatus({ phase: 'error', message: `That relay speaks protocol ${protocol}; this Conductor speaks ${RELAY_PROTOCOL_VERSION}. Update whichever is older.` })
      this.socket?.close(1000, 'protocol')
      return
    }
    const hello = {
      protocol: RELAY_PROTOCOL_VERSION,
      roomId: roomIdFor(secret),
      machineId: this.deps.machineId(),
      machineName: this.deps.machineName(),
      deviceKey: key.publicKey,
      nonce: String(frame.nonce ?? ''),
      issuedAt: this.now()
    }
    this.helloStatement = relayHelloStatement(hello)
    this.send({
      t: 'hello',
      ...hello,
      keyProof: signStatement(key.privateKeyPem, RELAY_HELLO_STATEMENT_KIND, this.helloStatement),
      roomProof: roomProofFor(secret, this.helloStatement)
    })
  }

  private onWelcome(frame: Record<string, unknown>): void {
    const secret = this.deps.roomSecret()
    const sessionId = String(frame.sessionId ?? '')
    // The room secret proves the relay as well as the machine. Without this a machine would happily
    // hand its traffic - and the fact that it exists at all - to whatever answered that address.
    if (!secret || !proofsMatch(String(frame.serverProof ?? ''), welcomeProofFor(secret, this.helloStatement, sessionId))) {
      this.setStatus({ phase: 'error', message: 'That address answered, but it could not prove it is your relay. Nothing was sent to it.' })
      this.socket?.close(1000, 'unproven relay')
      return
    }
    this.ready = true
    this.attempt = 0
    this.failingSince = null
    this.strandedTimer?.cancel()
    this.strandedTimer = null
    this.setStatus({ phase: 'ready', message: null, lastPollAt: new Date(this.now()).toISOString() })
    this.published = ''
    this.publish()
    this.onPresence(frame)
    for (const waiter of this.waiters.splice(0)) waiter.resolve()
    this.beat()
  }

  private onPresence(frame: Record<string, unknown>): void {
    const entries = Array.isArray(frame.presence) ? frame.presence : []
    this.presence.clear()
    const reachable: string[] = []
    for (const raw of entries) {
      if (!isRecord(raw) || typeof raw.machineId !== 'string') continue
      const presence: RelayPresence = {
        machineId: raw.machineId,
        online: raw.online === true,
        entry: raw.entry,
        lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : ''
      }
      this.presence.set(presence.machineId, presence)
      // The relay says who is connected; only a signature says who they are. A machine counts as
      // reachable when a device key this machine has already approved signed for it.
      const known = this.deps.peerDeviceKey(presence.machineId)
      const entry = this.directoryOf(presence)
      if (presence.online && known && entry && verifyDirectoryEntry(entry, known)) reachable.push(presence.machineId)
    }
    this.setStatus({ reachable, lastPollAt: new Date(this.now()).toISOString() })
  }

  private directoryOf(presence: RelayPresence | undefined): RelayDirectoryEntry | null {
    if (!presence || !presence.entry) return null
    try { return readDirectoryEntry(presence.entry) } catch { return null }
  }

  /** This machine's own entry, rewritten only when something in it actually changed. */
  private publish(): void {
    const key = this.deps.deviceKey()
    const seal = this.deps.sealKey()
    if (!key || !seal || !this.ready) return
    const entry = {
      version: 1 as const,
      machineId: this.deps.machineId(),
      machineName: this.deps.machineName(),
      accountLogin: '',
      deviceKey: key.publicKey,
      sealKey: seal.publicKey,
      fingerprint: this.deps.fingerprint() ?? '',
      updatedAt: new Date(this.now()).toISOString()
    }
    const stamp = JSON.stringify({ ...entry, updatedAt: '' })
    if (stamp === this.published) return
    this.send({ t: 'publish', entry: signDirectoryEntry(key.privateKeyPem, entry) })
    this.published = stamp
  }

  /** Asks the relay whether this connection is still alive, since a dead socket is usually silent. */
  private beat(): void {
    this.heartbeat?.cancel()
    this.heartbeat = this.schedule(() => {
      if (!this.ready) return
      if (this.pongDeadline && this.now() > this.pongDeadline) {
        this.socket?.close(1000, 'The relay stopped answering.')
        return
      }
      this.pongDeadline = this.now() + RELAY_HEARTBEAT_TIMEOUT_MS
      this.send({ t: 'ping', ref: 'beat' })
      this.beat()
    }, RELAY_HEARTBEAT_MS)
  }

  private failWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  /** Resolves once the connection is usable, or fails with the reason it is not. */
  private async connected(): Promise<void> {
    if (this.ready) return
    this.start()
    if (this.ready) return
    if (!this.socket) throw new RemoteAccessError(this.status.message ?? 'This machine is not connected to a relay.', 503)
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { give.cancel(); resolve() },
        reject: (error: Error) => { give.cancel(); reject(error) }
      }
      const give = this.schedule(() => {
        this.waiters = this.waiters.filter(entry => entry !== waiter)
        reject(new RemoteAccessError(this.status.message ?? 'The relay did not answer in time.', 503))
      }, CONNECT_WAIT_MS)
      this.waiters.push(waiter)
    })
  }

  /**
   * One request to a paired machine over the relay. The bytes handed in are the identical bytes the
   * direct transport would have written, so the signature in `headers` verifies unchanged there.
   */
  async call(machineId: string, expectedDeviceKey: string, path: string, body: Buffer, headers: Record<string, string>, expectedSealKey?: string, options: RelayCallOptions = {}): Promise<RelayResponseBody> {
    if (!this.deps.enabled()) throw new RemoteAccessError('The relay is switched off on this machine.', 503)
    if (body.length > RELAY_MAX_MESSAGE_BYTES) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
    const key = this.deps.deviceKey()
    const seal = this.deps.sealKey()
    if (!key || !seal) throw new RemoteAccessError('This machine has no relay key yet; sign in to GitHub first.', 401)
    await this.connected()

    const entry = this.peerEntry(machineId, expectedDeviceKey, expectedSealKey)
    const id = randomUUID()
    const payload: RelayRequestBody = { path, headers, body: body.toString('base64') }
    // The call is registered before the message is handed over, because the relay's acknowledgement
    // and the peer's answer can arrive in the same read: the decoder then delivers both frames in
    // one synchronous pass, and an answer that arrives before its call is registered would be
    // refused as unsolicited and the caller left waiting out the full timeout for an answer that
    // already came. Nobody is awaiting `answer` yet, so it is marked handled until it is returned.
    const expiresAt = this.now() + (options.background === true ? RELAY_BACKGROUND_CALL_TIMEOUT_MS : RELAY_CALL_TIMEOUT_MS)
    const answer = new Promise<RelayResponseBody>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, expiresAt, peerMachineId: machineId, peerDeviceKey: expectedDeviceKey })
    })
    answer.catch(() => undefined)
    this.armExpiry()
    try {
      // A relay that refuses the message - the peer is not there, it is too large - says so at once,
      // and the owner gets that instead of a minute and a half of silence.
      await this.deliver(key, entry, { from: this.deps.machineId(), to: machineId, id, kind: 'request', correlationId: id }, Buffer.from(JSON.stringify(payload), 'utf8'))
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return answer
  }

  /** The peer's published entry, accepted only once the key pinned at pairing has signed for it. */
  private peerEntry(machineId: string, expectedDeviceKey: string, expectedSealKey?: string): RelayDirectoryEntry {
    const presence = this.presence.get(machineId)
    const entry = this.directoryOf(presence)
    if (!entry || entry.machineId !== machineId) {
      throw new RemoteAccessError('That machine has not checked in to your relay. Open Conductor on it and make sure it points at the same relay.', 503)
    }
    if (!verifyDirectoryEntry(entry, expectedDeviceKey)) {
      throw new RemoteAccessError('That machine published a relay entry its device key did not sign. Nothing was sent.', 495)
    }
    if (expectedSealKey && entry.sealKey !== expectedSealKey) {
      throw new RemoteAccessError('That machine published a different relay key than the one in the pairing code. Nothing was sent.', 495)
    }
    return entry
  }

  /** Seals, signs and hands one message to the relay, resolving when the relay says it has it. */
  private async deliver(key: DeviceKeyPair, entry: RelayDirectoryEntry, binding: ReturnType<typeof bindingOf>, plaintext: Buffer): Promise<void> {
    const [envelope] = buildEnvelopes({
      privateKeyPem: key.privateKeyPem,
      recipientSealKey: entry.sealKey,
      binding,
      plaintext,
      // One socket frame carries a whole message; the gist route chunks only because a gist file
      // over a megabyte stops being served inline.
      chunkBytes: Number.MAX_SAFE_INTEGER,
      now: this.now()
    })
    if (!envelope) throw new RemoteAccessError('That message could not be sealed.', 500)
    if (!this.ready) throw new RemoteAccessError(this.status.message ?? 'This machine is not connected to a relay.', 503)
    try { await this.hand(envelope, binding.to) }
    catch (error) {
      // A throttled message is the one refusal worth a second attempt: the relay is saying "not
      // this instant", and giving up would cost the owner a call they would only make again. Every
      // other refusal - too large, nobody there - would be refused identically a moment later.
      if (!(error instanceof RemoteAccessError) || error.status !== 429) throw error
      await new Promise<void>(resolve => { this.schedule(() => resolve(), 300) })
      if (!this.ready) throw error
      await this.hand(envelope, binding.to)
    }
  }

  /** Hands one envelope to the relay and settles when the relay says it has it. */
  private async hand(envelope: RelayEnvelope, to: string): Promise<void> {
    const ref = envelope.id
    const accepted = new Promise<void>((resolve, reject) => {
      // A relay that takes a message and then says nothing must not hold a caller for ever. The
      // heartbeat would notice a dead socket on its own; this is the shorter, message-sized answer.
      const give = this.schedule(() => this.settleSend(ref, new RemoteAccessError('The relay did not acknowledge that message.', 504)), RELAY_HEARTBEAT_MS + RELAY_HEARTBEAT_TIMEOUT_MS)
      this.sends.set(ref, {
        resolve: () => { give.cancel(); resolve() },
        reject: error => { give.cancel(); reject(error) }
      })
    })
    this.send({ t: 'send', ref, to, envelope })
    await accepted
  }

  private settleSend(ref: string, error: Error | null): void {
    const send = this.sends.get(ref)
    if (!send) return
    this.sends.delete(ref)
    if (error) send.reject(error)
    else send.resolve()
  }

  private async onEnvelope(raw: unknown): Promise<void> {
    const seal = this.deps.sealKey()
    const envelope = readEnvelope(raw)
    if (!seal || !envelope || envelope.to !== this.deps.machineId()) return
    if (this.seen.has(envelope.id)) return
    const ciphertext = this.collect(envelope)
    if (!ciphertext) return
    this.seen.set(envelope.id, this.now())

    const binding = bindingOf(envelope)
    const call = this.pending.get(envelope.correlationId)
    if (!envelopeIsAuthentic(envelope, binding, {
      answeringPeer: call ? { machineId: call.peerMachineId, deviceKey: call.peerDeviceKey } : null,
      knownPeerKey: this.deps.peerDeviceKey(envelope.from)
    })) return

    let plaintext: Buffer
    try { plaintext = openMessage(seal.privateKey, envelope, binding, ciphertext) } catch { return }
    let parsed: unknown
    try { parsed = JSON.parse(plaintext.toString('utf8')) } catch { return }
    if (!isRecord(parsed)) return
    if (envelope.kind === 'response') { this.settle(envelope, parsed); return }
    await this.serve(envelope, parsed)
  }

  /** A whole message usually arrives in one frame; a chunked one is reassembled the same way the
   *  gist route does, so an older machine on the other side is still understood. */
  private collect(envelope: RelayEnvelope): Buffer | null {
    if (envelope.total === 1) return Buffer.from(envelope.chunk, 'base64')
    const held = this.partial.get(envelope.id) ?? { chunks: new Map<number, string>(), envelope, firstSeenAt: this.now() }
    if (held.envelope.ephemeralKey !== envelope.ephemeralKey || held.envelope.tag !== envelope.tag || held.envelope.total !== envelope.total) return null
    held.chunks.set(envelope.index, envelope.chunk)
    this.partial.set(envelope.id, held)
    if (held.chunks.size < envelope.total) return null
    this.partial.delete(envelope.id)
    let encoded = ''
    for (let index = 0; index < envelope.total; index++) encoded += held.chunks.get(index) ?? ''
    return Buffer.from(encoded, 'base64')
  }

  private settle(envelope: RelayEnvelope, parsed: Record<string, unknown>): void {
    const call = this.pending.get(envelope.correlationId)
    if (!call || call.peerMachineId !== envelope.from) return
    this.pending.delete(envelope.correlationId)
    const status = Number(parsed.status)
    call.resolve({
      status: Number.isInteger(status) && status >= 100 && status < 600 ? status : 502,
      body: typeof parsed.body === 'string' ? parsed.body : ''
    })
  }

  /**
   * An inbound request. It goes through the very same handler the HTTPS listener uses, so the
   * account check, the owner's approval, project scope and replay protection all apply before
   * anything happens - the relay never becomes a second, weaker way in.
   */
  private async serve(envelope: RelayEnvelope, parsed: Record<string, unknown>): Promise<void> {
    const key = this.deps.deviceKey()
    if (!key) return
    const path = typeof parsed.path === 'string' ? parsed.path : ''
    const headers: Record<string, string> = {}
    if (isRecord(parsed.headers)) {
      for (const [name, value] of Object.entries(parsed.headers)) {
        if (typeof value === 'string' && value.length <= 4096) headers[name.toLowerCase()] = value
      }
    }
    let body: Buffer
    try { body = Buffer.from(typeof parsed.body === 'string' ? parsed.body : '', 'base64') } catch { return }
    if (body.length > RELAY_MAX_MESSAGE_BYTES) return

    let answer: { status: number; body: string }
    try { answer = await this.deps.handle(path, body, headers) }
    catch (error) {
      const status = error instanceof RemoteAccessError ? error.status : 400
      answer = { status, body: JSON.stringify({ error: error instanceof Error ? error.message : 'Remote request failed' }) }
    }

    // The answer is sealed to an entry signed by a key this machine has reason to trust: the peer
    // record for an established pairing, or the key inside the pairing request itself. An
    // unverifiable sender simply gets no answer.
    const expected = this.deps.peerDeviceKey(envelope.from) ?? pairingKeyFromBody(path, body)
    if (!expected) return
    const entry = this.directoryOf(this.presence.get(envelope.from))
    if (!entry || entry.machineId !== envelope.from || !verifyDirectoryEntry(entry, expected)) return

    const payload: RelayResponseBody = { status: answer.status, body: Buffer.from(answer.body, 'utf8').toString('base64') }
    try {
      await this.deliver(key, entry, {
        from: this.deps.machineId(), to: envelope.from, id: randomUUID(), kind: 'response', correlationId: envelope.id
      }, Buffer.from(JSON.stringify(payload), 'utf8'))
    } catch { /* the caller will time out, which is the honest outcome when the relay would not take it */ }
  }

  /** Drops what has aged out: timed-out calls, half-arrived messages, and the replay memory. */
  private armExpiry(): void {
    if (this.expiry) return
    this.expiry = this.schedule(() => {
      this.expiry = null
      const now = this.now()
      for (const [id, call] of this.pending) {
        if (call.expiresAt > now) continue
        this.pending.delete(id)
        call.reject(new RemoteAccessError('That machine did not answer over the relay in time.', 504))
      }
      for (const [id, held] of this.partial) if (now - held.firstSeenAt > RELAY_MESSAGE_TTL_MS) this.partial.delete(id)
      for (const [id, at] of this.seen) if (now - at > RELAY_SEEN_TTL_MS) this.seen.delete(id)
      if (this.pending.size || this.partial.size || this.seen.size) this.armExpiry()
    }, 1000)
  }
}
