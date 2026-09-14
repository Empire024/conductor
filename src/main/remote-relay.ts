import { randomUUID } from 'node:crypto'
import {
  RELAY_ACK_FILE,
  RELAY_CALL_TIMEOUT_MS,
  RELAY_CHUNK_BYTES,
  RELAY_DIRECTORY_FILE,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_MESSAGE_TTL_MS,
  RELAY_POLL_ACTIVE_MS,
  RELAY_POLL_IDLE_MS,
  RELAY_SEEN_TTL_MS,
  parseRelayFileName,
  relayFileName,
  type RelayDirectoryEntry,
  type RelayEnvelope,
  type RelayRequestBody,
  type RelayResponseBody,
  type RelayStatus
} from '../shared/remote-relay'
import type { DeviceKeyPair } from './device-key'
import { GitHubRelayMailbox, RelayUnavailableError, type GistSummary } from './github-relay'
import {
  openMessage,
  readDirectoryEntry,
  readEnvelope,
  sealMessage,
  signDirectoryEntry,
  signMessage,
  verifyDirectoryEntry,
  verifyMessageSignature,
  type RelayBinding,
  type RelaySealKeyPair
} from './relay-crypto'
import { RemoteAccessError } from './remote-peers'

/**
 * The transport that makes a paired machine reachable from another network.
 *
 * It carries exactly what the direct HTTPS transport carries — the same path, the same signed
 * headers, the same request bytes — so every rule about who may do what still lives in
 * remote-peers and remote-control-host and is enforced identically on both routes. What the relay
 * adds is confidentiality and a route: each message is sealed to the recipient's published key
 * before it is written to a private gist, and neither machine has to accept an inbound connection.
 *
 * One loop serves both directions. A machine is a host (inbound requests to answer) and a
 * controller (outbound calls awaiting answers) at the same time, over the same mailbox.
 */

export interface RemoteRelayDependencies {
  mailbox: GitHubRelayMailbox
  machineId(): string
  machineName(): string
  accountLogin(): string | null
  deviceKey(): DeviceKeyPair | null
  sealKey(): RelaySealKeyPair | null
  /** This machine's TLS certificate fingerprint; challenges are bound to it on either transport. */
  fingerprint(): string | null
  /** The device key this machine has already approved for a peer, or null if it knows none yet. */
  peerDeviceKey(machineId: string): string | null
  /** Serves an inbound request exactly as the HTTPS listener does. */
  handle(path: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: string }>
  enabled(): boolean
  changed?(status: RelayStatus): void
  now?(): number
  /** Test seam; production schedules the next poll with setTimeout. */
  schedule?(run: () => void, ms: number): { cancel(): void }
}

interface PendingCall {
  resolve(value: RelayResponseBody): void
  reject(error: Error): void
  expiresAt: number
  peerMachineId: string
  /** The device key this call was addressed to; only that key may answer it. */
  peerDeviceKey: string
}

interface PartialMessage {
  chunks: Map<number, string>
  envelope: RelayEnvelope
  firstSeenAt: number
}

interface ResolvedPeer {
  gistId: string
  entry: RelayDirectoryEntry
  resolvedAt: number
}

const DIRECTORY_TTL_MS = 5 * 60_000

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Only the pairing endpoints carry a device key the receiver has not approved yet. */
const pairingKeyFromBody = (path: string, body: Buffer): string | null => {
  if (path !== '/remote/pair' && path !== '/remote/pair/status') return null
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    return isRecord(parsed) && typeof parsed.publicKey === 'string' && parsed.publicKey ? parsed.publicKey : null
  } catch { return null }
}

/**
 * One sweep touches several mailboxes, and a failure in any of them must not lose the one thing the
 * loop schedules on: `tick` picks its backoff and its status phase from `RelayUnavailableError`, so
 * a rate limit or a missing gist scope is re-thrown as itself — with the longest wait any of them
 * asked for — rather than flattened into a plain error the loop would retry in 1.5 seconds.
 */
const sweepFailure = (failures: unknown[]): Error => {
  let wait: RelayUnavailableError | null = null
  for (const failure of failures) {
    if (failure instanceof RelayUnavailableError && (!wait || failure.retryAfterMs > wait.retryAfterMs)) wait = failure
  }
  if (wait) return wait
  const first = failures[0]
  return new Error(`The relay could not deliver ${failures.length} message(s): ${first instanceof Error ? first.message : String(first)}`)
}

export class RemoteRelay {
  private pending = new Map<string, PendingCall>()
  private partial = new Map<string, PartialMessage>()
  private seen = new Map<string, number>()
  private peers = new Map<string, ResolvedPeer>()
  /** Message ids this machine wrote and is still waiting to see acknowledged. */
  private outbound = new Map<string, { to: string; files: string[]; writtenAt: number }>()
  private acked = new Map<string, number>()
  private ackDirty = false
  private timer: { cancel(): void } | null = null
  private polling = false
  private published = ''
  private status: RelayStatus = { phase: 'off', reachable: [], lastPollAt: null, message: null }

  constructor(private readonly deps: RemoteRelayDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  getStatus(): RelayStatus { return { ...this.status, reachable: [...this.status.reachable] } }

  private setStatus(patch: Partial<RelayStatus>): void {
    const next = { ...this.status, ...patch }
    if (next.phase === this.status.phase && next.message === this.status.message &&
        next.lastPollAt === this.status.lastPollAt && next.reachable.join() === this.status.reachable.join()) return
    this.status = next
    this.deps.changed?.(this.getStatus())
  }

  /** Re-reads the owner's settings and identity, then starts or stops the loop to match. */
  start(): void {
    if (!this.deps.enabled() || !this.deps.deviceKey() || !this.deps.sealKey() || this.deps.accountLogin() === null) { this.stop(); return }
    if (this.status.phase === 'off') this.setStatus({ phase: 'connecting', message: null })
    if (!this.timer && !this.polling) this.schedule(0)
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = null
    for (const [id, call] of this.pending) {
      this.pending.delete(id)
      call.reject(new RemoteAccessError('The encrypted relay was switched off while this request was pending.', 503))
    }
    this.partial.clear()
    this.peers.clear()
    this.published = ''
    this.deps.mailbox.forget()
    this.setStatus({ phase: 'off', reachable: [], message: null })
  }

  private schedule(ms: number): void {
    this.timer?.cancel()
    const run = (): void => { this.timer = null; void this.tick() }
    this.timer = this.deps.schedule
      ? this.deps.schedule(run, ms)
      : (t => ({ cancel: () => clearTimeout(t) }))(setTimeout(run, ms))
  }

  /** Fast while a call is in flight or a message just arrived, slow when nothing is happening. */
  private interval(busy: boolean): number {
    return this.pending.size > 0 || busy ? RELAY_POLL_ACTIVE_MS : RELAY_POLL_IDLE_MS
  }

  /** Publishes this machine's entry so another one can find and seal to it. */
  async checkIn(): Promise<void> {
    await this.publish()
  }

  /**
   * One full cycle — check in, collect, answer, clean up — with no scheduling around it. The loop
   * calls it on a timer; a test calls it directly, which is also how two relays are driven against
   * each other without real time passing.
   */
  async pollOnce(): Promise<boolean> {
    // A sweep that ends in an error still has to age out timed-out calls and half-arrived
    // messages, or one failing poll would leave a caller waiting for ever.
    try {
      await this.publish()
      return await this.poll()
    } finally {
      this.expire()
    }
  }

  private async tick(): Promise<void> {
    if (this.polling) return
    if (!this.deps.enabled() || !this.deps.deviceKey() || !this.deps.sealKey()) { this.stop(); return }
    this.polling = true
    let busy = false
    let delay = 0
    try {
      await this.publish()
      busy = await this.poll()
      this.setStatus({ phase: 'ready', message: null, lastPollAt: new Date(this.now()).toISOString() })
    } catch (error) {
      const unavailable = error instanceof RelayUnavailableError
      delay = unavailable ? error.retryAfterMs : 0
      this.setStatus({
        phase: unavailable ? 'unavailable' : 'error',
        message: error instanceof Error ? error.message : String(error),
        lastPollAt: new Date(this.now()).toISOString()
      })
    } finally {
      this.polling = false
      this.expire()
      if (this.deps.enabled()) this.schedule(Math.max(delay, this.interval(busy)))
    }
  }

  /** This machine's own entry, rewritten only when something in it actually changed. */
  private async publish(): Promise<void> {
    const key = this.deps.deviceKey()
    const seal = this.deps.sealKey()
    if (!key || !seal) return
    const entry = {
      version: 1 as const,
      machineId: this.deps.machineId(),
      machineName: this.deps.machineName(),
      accountLogin: this.deps.accountLogin() ?? '',
      deviceKey: key.publicKey,
      sealKey: seal.publicKey,
      fingerprint: this.deps.fingerprint() ?? '',
      updatedAt: new Date(this.now()).toISOString()
    }
    const stamp = JSON.stringify({ ...entry, updatedAt: '' })
    if (stamp === this.published) return
    await this.deps.mailbox.publishDirectory(signDirectoryEntry(key.privateKeyPem, entry))
    this.published = stamp
  }

  /**
   * Finds a peer's mailbox and the entry it publishes about itself. The entry is only accepted
   * after its signature checks out against a device key this machine already approved, so what
   * GitHub serves decides where a message goes but never who can open it.
   */
  async resolvePeer(machineId: string, expectedDeviceKey: string, expectedSealKey?: string): Promise<ResolvedPeer> {
    const cached = this.peers.get(machineId)
    if (cached && this.now() - cached.resolvedAt < DIRECTORY_TTL_MS && cached.entry.deviceKey === expectedDeviceKey) return cached
    for (const summary of await this.deps.mailbox.peerGists()) {
      const gist = await this.deps.mailbox.read(summary.id)
      const entry = gist ? await this.directoryOf(gist) : null
      if (!entry || entry.machineId !== machineId) continue
      if (!verifyDirectoryEntry(entry, expectedDeviceKey)) {
        throw new RemoteAccessError('That machine published a mailbox entry its device key did not sign. Nothing was sent.', 495)
      }
      if (expectedSealKey && entry.sealKey !== expectedSealKey) {
        throw new RemoteAccessError('That machine published a different relay key than the one in the pairing code. Nothing was sent.', 495)
      }
      const resolved: ResolvedPeer = { gistId: summary.id, entry, resolvedAt: this.now() }
      this.peers.set(machineId, resolved)
      return resolved
    }
    throw new RemoteAccessError('That machine has not checked in to the encrypted relay. Open Conductor on it and make sure it is signed into the same GitHub account.', 503)
  }

  /**
   * One request to a paired machine over the relay. The bytes handed in are the identical bytes the
   * direct transport would have written, so the signature in `headers` verifies unchanged there.
   */
  async call(machineId: string, expectedDeviceKey: string, path: string, body: Buffer, headers: Record<string, string>, expectedSealKey?: string): Promise<RelayResponseBody> {
    if (!this.deps.enabled()) throw new RemoteAccessError('The encrypted relay is switched off on this machine.', 503)
    if (body.length > RELAY_MAX_MESSAGE_BYTES) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
    const seal = this.deps.sealKey()
    if (!seal) throw new RemoteAccessError('This machine has no relay key yet; sign in to GitHub first.', 401)
    const peer = await this.resolvePeer(machineId, expectedDeviceKey, expectedSealKey)
    const id = randomUUID()
    const payload: RelayRequestBody = { path, headers, body: body.toString('base64') }
    await this.send(peer.entry, { from: this.deps.machineId(), to: machineId, id, kind: 'request', correlationId: id }, Buffer.from(JSON.stringify(payload), 'utf8'))
    const answer = new Promise<RelayResponseBody>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, expiresAt: this.now() + RELAY_CALL_TIMEOUT_MS, peerMachineId: machineId, peerDeviceKey: expectedDeviceKey })
    })
    this.start()
    this.schedule(0)
    return answer
  }

  private async send(entry: RelayDirectoryEntry, binding: RelayBinding, plaintext: Buffer): Promise<void> {
    const key = this.deps.deviceKey()
    if (!key) throw new RemoteAccessError('This machine has no device key yet; sign in to GitHub first.', 401)
    const sealed = sealMessage(entry.sealKey, binding, plaintext)
    const senderSignature = signMessage(key.privateKeyPem, binding, sealed)
    const encoded = sealed.ciphertext.toString('base64')
    const total = Math.max(1, Math.ceil(encoded.length / RELAY_CHUNK_BYTES))
    if (total > 64) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
    const files: Record<string, string | null> = {}
    const names: string[] = []
    for (let index = 0; index < total; index++) {
      const envelope: RelayEnvelope = {
        version: 1,
        id: binding.id,
        from: binding.from,
        to: binding.to,
        kind: binding.kind,
        correlationId: binding.correlationId,
        index,
        total,
        ephemeralKey: sealed.ephemeralKey,
        nonce: sealed.nonce,
        tag: sealed.tag,
        chunk: encoded.slice(index * RELAY_CHUNK_BYTES, (index + 1) * RELAY_CHUNK_BYTES),
        createdAt: new Date(this.now()).toISOString(),
        senderSignature
      }
      const name = relayFileName(envelope)
      files[name] = JSON.stringify(envelope)
      names.push(name)
    }
    await this.deps.mailbox.write(files)
    this.outbound.set(binding.id, { to: binding.to, files: names, writtenAt: this.now() })
  }

  /** One sweep of every peer mailbox. Returns true when anything was actually delivered. */
  private async poll(): Promise<boolean> {
    const listed = await this.deps.mailbox.peerGists()
    const me = this.deps.machineId()
    const reachable: string[] = []
    let delivered = false
    const collectedAcks: string[] = []
    const failures: unknown[] = []
    for (const summary of listed) {
      // The list carries file names only; this is the conditional read that brings their contents,
      // and it costs nothing against the rate limit while a mailbox is unchanged.
      const gist = await this.deps.mailbox.read(summary.id)
      if (!gist) continue
      const entry = await this.directoryOf(gist)
      // Any gist on the account can claim to be any machine, so a claim only counts once a device
      // key this machine already approved has signed for it.
      const claimant = entry ? this.deps.peerDeviceKey(entry.machineId) : null
      if (entry && claimant && verifyDirectoryEntry(entry, claimant)) reachable.push(entry.machineId)
      collectedAcks.push(...await this.readAcks(gist))
      for (const [name, file] of Object.entries(gist.files)) {
        const parsed = parseRelayFileName(name)
        if (!parsed || parsed.to !== me) continue
        const raw = await this.deps.mailbox.content(file)
        if (!raw) continue
        let value: unknown
        try { value = JSON.parse(raw) } catch { continue }
        const envelope = readEnvelope(value)
        if (!envelope || envelope.to !== me || envelope.id !== parsed.id || envelope.index !== parsed.index) continue
        if (this.seen.has(envelope.id)) { this.ack(envelope.id); continue }
        const complete = this.collect(envelope)
        if (!complete) continue
        // Acknowledged before it is served, so a message is never served twice: the sender's
        // signature carries a nonce that would be refused on a second attempt anyway, and a
        // duplicate that did get through would be a duplicate action. A send that then fails costs
        // the caller a timeout, which it can retry, rather than costing an action that ran twice.
        this.seen.set(envelope.id, this.now())
        this.ack(envelope.id)
        delivered = true
        // One unreadable or undeliverable message must not stop the rest of the sweep, or a single
        // bad file in a mailbox would stall every conversation running through it.
        try { await this.deliver(envelope, complete, gist) }
        catch (error) { failures.push(error) }
      }
    }
    await this.prune(collectedAcks)
    this.setStatus({ reachable })
    if (failures.length) throw sweepFailure(failures)
    return delivered
  }

  private async directoryOf(gist: GistSummary): Promise<RelayDirectoryEntry | null> {
    const file = gist.files[RELAY_DIRECTORY_FILE]
    if (!file) return null
    const raw = await this.deps.mailbox.content(file)
    if (!raw) return null
    try { return readDirectoryEntry(JSON.parse(raw)) } catch { return null }
  }

  /** Reassembles a chunked message; returns the full ciphertext once every part has arrived. */
  private collect(envelope: RelayEnvelope): Buffer | null {
    if (envelope.total === 1) return Buffer.from(envelope.chunk, 'base64')
    const held = this.partial.get(envelope.id) ?? { chunks: new Map<number, string>(), envelope, firstSeenAt: this.now() }
    // A later part claiming a different seal would let two messages be spliced into one.
    if (held.envelope.ephemeralKey !== envelope.ephemeralKey || held.envelope.tag !== envelope.tag || held.envelope.total !== envelope.total) return null
    held.chunks.set(envelope.index, envelope.chunk)
    this.partial.set(envelope.id, held)
    if (held.chunks.size < envelope.total) return null
    this.partial.delete(envelope.id)
    let encoded = ''
    for (let index = 0; index < envelope.total; index++) encoded += held.chunks.get(index) ?? ''
    return Buffer.from(encoded, 'base64')
  }

  private async deliver(envelope: RelayEnvelope, ciphertext: Buffer, gist: GistSummary): Promise<void> {
    const seal = this.deps.sealKey()
    if (!seal) return
    const binding: RelayBinding = {
      from: envelope.from, to: envelope.to, id: envelope.id, kind: envelope.kind, correlationId: envelope.correlationId
    }
    if (!this.authentic(envelope, binding)) return
    let plaintext: Buffer
    try { plaintext = openMessage(seal.privateKey, envelope, binding, ciphertext) }
    catch { return }
    let parsed: unknown
    try { parsed = JSON.parse(plaintext.toString('utf8')) } catch { return }
    if (!isRecord(parsed)) return
    if (envelope.kind === 'response') { this.settle(envelope, parsed); return }
    await this.serve(envelope, parsed, gist)
  }

  /**
   * Whether the machine this message names as its sender is the one that actually wrote it. Being
   * sealed to this machine proves nothing about that — the seal key is published — so an answer is
   * only accepted from the device key the call was addressed to, and a request from an established
   * peer only from that peer's stored key. The one message whose sender is not approved yet is a
   * first pairing request, which `handleRequest` authenticates by its own challenge and `serve`
   * answers only into a mailbox that key signed for.
   */
  private authentic(envelope: RelayEnvelope, binding: RelayBinding): boolean {
    if (envelope.kind === 'response') {
      const call = this.pending.get(envelope.correlationId)
      if (!call || call.peerMachineId !== envelope.from) return false
      return verifyMessageSignature(call.peerDeviceKey, binding, envelope, envelope.senderSignature)
    }
    const known = this.deps.peerDeviceKey(envelope.from)
    return !known || verifyMessageSignature(known, binding, envelope, envelope.senderSignature)
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
   * anything happens — the relay never becomes a second, weaker way in.
   */
  private async serve(envelope: RelayEnvelope, parsed: Record<string, unknown>, gist: GistSummary): Promise<void> {
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

    // The answer only goes back to a mailbox whose entry is signed by a device key this machine has
    // reason to trust: the peer record for an established pairing, or the key inside the pairing
    // request itself. An unverifiable sender simply gets no answer.
    const expected = this.deps.peerDeviceKey(envelope.from) ?? pairingKeyFromBody(path, body)
    if (!expected) return
    const entry = await this.directoryOf(gist)
    if (!entry || entry.machineId !== envelope.from || !verifyDirectoryEntry(entry, expected)) return

    const payload: RelayResponseBody = { status: answer.status, body: Buffer.from(answer.body, 'utf8').toString('base64') }
    await this.send(entry, {
      from: this.deps.machineId(), to: envelope.from, id: randomUUID(), kind: 'response', correlationId: envelope.id
    }, Buffer.from(JSON.stringify(payload), 'utf8'))
  }

  private ack(messageId: string): void {
    if (this.acked.has(messageId)) return
    this.acked.set(messageId, this.now())
    this.ackDirty = true
  }

  private async readAcks(gist: GistSummary): Promise<string[]> {
    const file = gist.files[RELAY_ACK_FILE]
    if (!file) return []
    const raw = await this.deps.mailbox.content(file)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || !Array.isArray(parsed.acked)) return []
      return parsed.acked.filter((id): id is string => typeof id === 'string' && id.length <= 100).slice(0, 2000)
    } catch { return [] }
  }

  /**
   * Only the machine that wrote a file can delete it, so collection is cooperative: each side
   * publishes what it has consumed and each side removes its own delivered files. A peer that never
   * comes back cannot leave a message in the mailbox for ever — the age check removes it anyway.
   */
  private async prune(peerAcks: string[]): Promise<void> {
    const acked = new Set(peerAcks)
    const removals: Record<string, string | null> = {}
    for (const [id, sent] of this.outbound) {
      const expired = this.now() - sent.writtenAt > RELAY_MESSAGE_TTL_MS
      if (!acked.has(id) && !expired) continue
      for (const name of sent.files) removals[name] = null
      this.outbound.delete(id)
    }
    // `outbound` only knows what this run wrote. Anything left by an earlier run — the app was
    // closed mid-call, the peer never came back — is collected from the mailbox itself, so a
    // restart is not a way to accumulate files for ever.
    const own = await this.deps.mailbox.own()
    for (const [name, file] of Object.entries(own?.files ?? {})) {
      const parsed = parseRelayFileName(name)
      if (!parsed || this.outbound.has(parsed.id) || removals[name] === null) continue
      if (acked.has(parsed.id)) { removals[name] = null; continue }
      const raw = await this.deps.mailbox.content(file)
      let createdAt = 0
      try {
        const envelope = raw ? readEnvelope(JSON.parse(raw)) : null
        createdAt = envelope ? Date.parse(envelope.createdAt) : 0
      } catch { createdAt = 0 }
      if (!Number.isFinite(createdAt) || this.now() - createdAt > RELAY_MESSAGE_TTL_MS) removals[name] = null
    }
    const writes: Record<string, string | null> = { ...removals }
    if (this.ackDirty) {
      writes[RELAY_ACK_FILE] = JSON.stringify({ version: 1, acked: [...this.acked.keys()].slice(-2000) })
      this.ackDirty = false
    }
    if (Object.keys(writes).length) await this.deps.mailbox.write(writes)
  }

  /** Drops what has aged out: timed-out calls, half-arrived messages, and the replay memory. */
  private expire(): void {
    const now = this.now()
    for (const [id, call] of this.pending) {
      if (call.expiresAt > now) continue
      this.pending.delete(id)
      call.reject(new RemoteAccessError('That machine did not answer over the encrypted relay in time.', 504))
    }
    for (const [id, held] of this.partial) if (now - held.firstSeenAt > RELAY_MESSAGE_TTL_MS) this.partial.delete(id)
    for (const [id, at] of this.seen) if (now - at > RELAY_SEEN_TTL_MS) this.seen.delete(id)
    for (const [id, at] of this.acked) if (now - at > RELAY_SEEN_TTL_MS * 2) this.acked.delete(id)
  }
}
