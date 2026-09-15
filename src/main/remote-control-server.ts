import { randomUUID, X509Certificate } from 'node:crypto'
import { localAddresses } from './network-addresses'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { RemoteControlSettings, RemotePairingTicket, RemoteProjectSummary } from '../shared/remote-control'
import type { RemoteControlHost } from './remote-control-host'
import { NONCE_HEADER, PEER_HEADER, RemoteAccessError, SIGNATURE_HEADER, TIMESTAMP_HEADER, type RemotePeers } from './remote-peers'
import type { SecretKeyValueStore, SecretVault } from './secret-store'
import { createRemoteTlsIdentity, tlsIdentityUsable, type RemoteTlsIdentity } from './remote-tls'
import { INSTALL_TAILSCALE_MESSAGE, isTailscaleAddress, type TailscaleReader } from './tailscale'

const CERT_SETTING = 'remote-control.tls.certificate'
const CERT_EXPIRY_SETTING = 'remote-control.tls.notAfter'
const TLS_KEY_SECRET = 'remote-control.tls.key'
const MAX_BODY = 3 * 1024 * 1024
/**
 * Anyone who can reach the port can open a socket, long before they can prove anything, so the
 * count is capped. A paired machine holds one long-lived stream, one short-lived connection per
 * call, and one tunnelled connection per open preview connection - a page opens a handful, and a
 * peer is capped at TUNNEL_MAX_CONNECTIONS of those - so the ceiling leaves room for all of that
 * from two machines without letting the 65th stranger's socket be the one that is silently dropped.
 */
const MAX_SOCKETS = 192
/** A WebSocket upgrade carries a handful of short headers; anything larger is not one of ours. */
const MAX_UPGRADE_HEADER_BYTES = 8 * 1024

/**
 * Loopback keeps the socket on this machine; 'network' is the deliberate choice that lets it be
 * reached from elsewhere; 'tailscale' binds this machine's own tailnet address and nothing else.
 *
 * Null is a real answer and the important one: in Tailscale exposure with no tailnet address there
 * is no host to bind that would still mean "only reachable over the tailnet", so the listener does
 * not start. Widening to loopback would look like it worked and quietly be unreachable; widening to
 * anything else would be the one promise this exposure exists to keep, broken silently. Nothing
 * else in the server may widen the bind address.
 */
export function resolveBindHost(settings: Pick<RemoteControlSettings, 'exposure'>, tailscaleAddress?: string | null): string | null {
  if (settings.exposure === 'tailscale') {
    const address = String(tailscaleAddress ?? '').trim()
    return address && isTailscaleAddress(address) ? address : null
  }
  return settings.exposure === 'network' ? '0.0.0.0' : '127.0.0.1'
}

/** A socket that is about to be upgraded, before anything has been written to it. */
export type UpgradeHandler = (request: IncomingMessage, socket: Socket, head: Buffer) => void

/**
 * Ends an upgrade attempt with a plain HTTP answer, without ever speaking WebSocket to it.
 *
 * The reason phrase is stripped of everything but printable ASCII. It often carries the message
 * from a RemoteAccessError, which may in turn carry text from GitHub or an operating system error,
 * and a newline in a status line is not a rude message - it is a second header this machine did not
 * write.
 */
export function refuseUpgrade(socket: Socket, status: number, message: string): void {
  const reason = String(message ?? '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 120) || 'Refused'
  try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
  catch { /* a socket already gone needs no answer */ }
  socket.destroy()
}

/** What the open listener is, as the pairing code has to describe it. */
export interface BoundListener {
  exposure: RemoteControlSettings['exposure']
  host: string
  dnsName?: string
}

/** The relay half of a pairing code, when there is one to hand over. */
export interface TicketRelay {
  relayKey: string | null
  deviceKey: string | null
  room: { endpoint: string; secret: string; fingerprint?: string; alternates?: string[] } | null
}

/**
 * How a pairing code says this machine is reached. Pulled out of `ticket()` so the rule can be
 * checked without a socket - and the rule worth checking is a negative one: a Tailscale code
 * carries no relay key, no relay address and no room secret, so a machine paired with it has
 * nothing to fall back to and never polls a gist on the owner's account. "We simply do not send
 * it" is only true if nothing downstream quietly adds it back, which is what this makes testable.
 */
export function ticketRoute(
  settings: Pick<RemoteControlSettings, 'exposure' | 'relay'>,
  bound: BoundListener | null,
  relay: TicketRelay
): Pick<RemotePairingTicket, 'host' | 'transport' | 'dnsName' | 'relayKey' | 'deviceKey' | 'relayEndpoint' | 'relayEndpointAlternates' | 'relaySecret' | 'relayFingerprint'> {
  if (settings.exposure === 'tailscale') {
    if (!bound || bound.exposure !== 'tailscale') {
      throw new RemoteAccessError('This machine is not listening on its Tailscale address yet.', 409)
    }
    return { host: bound.host, transport: 'tailscale', ...(bound.dnsName ? { dnsName: bound.dnsName } : {}) }
  }
  return {
    host: settings.exposure === 'network' ? localAddresses()[0] ?? '127.0.0.1' : '127.0.0.1',
    ...(settings.relay && relay.relayKey && relay.deviceKey ? { relayKey: relay.relayKey, deviceKey: relay.deviceKey } : {}),
    // The machine being paired has to reach this one, and if this one is only reachable through a
    // relay the other machine has never heard of, a code that omits it is a code that cannot work.
    ...(settings.relay && relay.room
      ? {
          relayEndpoint: relay.room.endpoint,
          relaySecret: relay.room.secret,
          ...(relay.room.fingerprint ? { relayFingerprint: relay.room.fingerprint } : {}),
          ...(relay.room.alternates?.length ? { relayEndpointAlternates: relay.room.alternates } : {})
        }
      : {})
  }
}

/**
 * Addresses a peer could dial, used for the certificate's SAN list and the pairing ticket.
 *
 * Re-exported rather than defined here: the relay needs the same answer, and a machine that names a
 * virtual switch's address in its pairing code is unreachable for a reason nobody can see.
 */
export { localAddresses }

export interface RemoteControlServerDependencies {
  peers: RemotePeers
  host: RemoteControlHost
  store: SecretKeyValueStore
  vault: SecretVault
  machineName(): string
  accountLogin(): string | null
  /** Published in a pairing code so the other machine can reach this one off-network. */
  relayKey?(): string | null
  deviceKey?(): string | null
  /** The owner's own relay, handed to the other machine so pairing carries the whole route. */
  relayRoom?(): { endpoint: string; secret: string; fingerprint?: string; alternates?: string[] } | null
  /**
   * The tailnet as this machine sees it. Absent on a build with no Tailscale support, which makes
   * 'tailscale' exposure fail closed rather than fall through to something wider.
   */
  tailscale?: TailscaleReader
  changed?(): void
}

export interface RemoteServerStatus {
  listening: boolean
  endpoint: string | null
  fingerprint: string | null
  message: string | null
}

/**
 * HTTPS only. The certificate is self-signed and its fingerprint travels in the pairing ticket,
 * so the controlling machine pins this exact certificate instead of trusting a name.
 */
export class RemoteControlServer {
  private server?: Server
  /** Includes a socket from creation through shutdown, not only after its listen callback. */
  private sockets = new Set<Server>()
  private closing = new Map<Server, Promise<void>>()
  /** Every apply/stop/close is an intent; an older continuation may close itself but never publish. */
  private intent = 0
  private tls?: RemoteTlsIdentity
  private status: RemoteServerStatus = { listening: false, endpoint: null, fingerprint: null, message: null }
  /**
   * What the open listener actually is, rather than what the settings say now. A request arriving
   * on a socket that was bound under Tailscale exposure has to be judged by that bind, because the
   * owner may have changed the setting a millisecond ago and the socket is still the old one.
   */
  private bound: { exposure: RemoteControlSettings['exposure']; host: string; dnsName?: string } | null = null
  /** Paths another part of the app serves over this same pinned listener: /v1/stream, /v1/tunnel. */
  private readonly upgrades = new Map<string, UpgradeHandler>()

  constructor(private readonly deps: RemoteControlServerDependencies) {}

  /**
   * Registers the one handler for a WebSocket path. There is deliberately no chain: two things
   * answering the same upgrade would mean two answers on one socket, so a second registration for
   * a path replaces the first and the returned function removes exactly what it added.
   */
  onUpgrade(path: string, handler: UpgradeHandler): () => void {
    this.upgrades.set(path, handler)
    return () => { if (this.upgrades.get(path) === handler) this.upgrades.delete(path) }
  }

  /** The address the listener is bound to, which in Tailscale exposure is this node's own. */
  boundHost(): string | null { return this.bound?.host ?? null }

  getStatus(): RemoteServerStatus { return { ...this.status } }

  private tlsIdentity(): RemoteTlsIdentity {
    const certificatePem = this.deps.store.getSetting(CERT_SETTING) ?? ''
    const privateKeyPem = this.deps.vault.read(TLS_KEY_SECRET) ?? ''
    const notAfter = this.deps.store.getSetting(CERT_EXPIRY_SETTING) ?? ''
    const stored = { certificatePem, privateKeyPem, notAfter }
    if (tlsIdentityUsable(stored)) {
      try { return { ...stored, fingerprint: new X509Certificate(certificatePem).fingerprint256 } }
      catch { /* a corrupted certificate is replaced rather than trusted */ }
    }
    const created = createRemoteTlsIdentity(`Conductor · ${this.deps.machineName()}`, localAddresses())
    this.deps.vault.write(TLS_KEY_SECRET, created.privateKeyPem)
    this.deps.store.setSetting(CERT_SETTING, created.certificatePem)
    this.deps.store.setSetting(CERT_EXPIRY_SETTING, created.notAfter)
    return created
  }

  /** Starts, restarts or stops the listener to match the owner's current settings. */
  async apply(): Promise<RemoteServerStatus> {
    const intent = ++this.intent
    const settings = { ...this.deps.peers.getSettings() }
    await this.stopSockets()
    if (intent !== this.intent) return this.getStatus()
    if (!settings.enabled) { this.setStopped(); return this.getStatus() }
    if (this.deps.accountLogin() === null) {
      this.status = { listening: false, endpoint: null, fingerprint: null, message: 'Sign in to GitHub before other machines can connect.' }
      this.deps.changed?.()
      return this.getStatus()
    }
    if (!this.deps.vault.available()) {
      this.status = { listening: false, endpoint: null, fingerprint: null, message: 'The OS credential store is unavailable, so the server key cannot be protected.' }
      this.deps.changed?.()
      return this.getStatus()
    }
    // Resolved before anything is created, because in Tailscale exposure "no address" is not a
    // failure to recover from - it is the answer, and the listener must not exist at all.
    let tailscaleAddress: string | null = null
    let tailscaleDnsName = ''
    if (settings.exposure === 'tailscale') {
      const state = await this.deps.tailscale?.state()
      if (intent !== this.intent) return this.getStatus()
      tailscaleAddress = resolveBindHost(settings, state?.self?.addresses.find(isTailscaleAddress) ?? null)
      tailscaleDnsName = state?.self?.dnsName ?? ''
      if (!tailscaleAddress) {
        this.bound = null
        this.status = {
          listening: false, endpoint: null, fingerprint: null,
          message: state?.message ?? (state ? 'Tailscale has no address for this machine, so nothing is listening.' : INSTALL_TAILSCALE_MESSAGE)
        }
        this.deps.changed?.()
        return this.getStatus()
      }
    }
    let candidate: Server | undefined
    try {
      const tls = this.tlsIdentity()
      const server = createServer({ cert: tls.certificatePem, key: tls.privateKeyPem, minVersion: 'TLSv1.2' }, (request, response) => { void this.handle(request, response) })
      candidate = server
      this.sockets.add(server)
      server.requestTimeout = 120000
      server.headersTimeout = 10000
      server.maxHeadersCount = 30
      server.maxConnections = MAX_SOCKETS
      server.on('upgrade', (request, socket, head) => this.upgrade(request, socket as Socket, head))
      const bindHost = resolveBindHost(settings, tailscaleAddress)
      if (!bindHost) throw new RemoteAccessError('There is no address to listen on for this exposure.', 409)
      await this.listen(server, settings.port, bindHost)
      if (intent !== this.intent) { await this.closeSocket(server); return this.getStatus() }
      // Once listening there is no promise left to reject into, and an unhandled 'error' event on
      // a network-facing listener would take the whole app down. It is surfaced in the status the
      // owner already sees instead.
      server.on('error', error => {
        if (this.server !== server) return
        this.status = { ...this.status, message: error instanceof Error ? error.message : String(error) }
        this.deps.changed?.()
      })
      this.server = server
      this.tls = tls
      this.bound = { exposure: settings.exposure, host: bindHost, ...(tailscaleDnsName ? { dnsName: tailscaleDnsName } : {}) }
      this.deps.peers.setFingerprint(tls.fingerprint)
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : settings.port
      this.status = {
        listening: true,
        endpoint: `https://${settings.exposure === 'tailscale' ? bindHost : bindHost === '0.0.0.0' ? localAddresses()[0] ?? '127.0.0.1' : '127.0.0.1'}:${port}`,
        fingerprint: tls.fingerprint,
        message: settings.exposure === 'network'
          ? 'Reachable from your network. Only paired machines on your GitHub account can connect.'
          : settings.exposure === 'tailscale'
            ? `Reachable over Tailscale at ${bindHost} and nowhere else. Only paired machines on your GitHub account can connect.`
            : null
      }
    } catch (error) {
      if (candidate) await this.closeSocket(candidate)
      if (intent !== this.intent) return this.getStatus()
      this.bound = null
      this.status = { listening: false, endpoint: null, fingerprint: null, message: error instanceof Error ? error.message : String(error) }
    }
    this.deps.changed?.()
    return this.getStatus()
  }

  private listen(server: Server, port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        server.off('error', failed)
        server.off('listening', listening)
        server.off('close', closed)
      }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const listening = (): void => { cleanup(); resolve() }
      const closed = (): void => { cleanup(); reject(new Error('Remote control listener stopped before startup completed.')) }
      server.once('error', failed)
      server.once('listening', listening)
      server.once('close', closed)
      try { server.listen(port, host) } catch (error) { cleanup(); reject(error) }
    })
  }

  private setStopped(): void {
    this.bound = null
    this.status = { listening: false, endpoint: null, fingerprint: null, message: null }
    this.deps.changed?.()
  }

  /**
   * The ticket carries the address and the certificate to pin, plus a single-use pairing code, plus
   * whatever the route it names needs. The keys are here for the same reason the fingerprint is:
   * the owner moves this code between their own two machines by hand, which is the one channel an
   * attacker who controls the network — or the account's gists — is not on.
   */
  ticket(): RemotePairingTicket {
    const settings = this.deps.peers.getSettings()
    // Either route is enough to be paired over. A machine reachable only through the relay has no
    // listener worth mentioning, and refusing it a code would make the off-network case unpairable.
    if (!settings.enabled || (!this.status.listening && !settings.relay)) {
      throw new RemoteAccessError('Switch remote control on before creating a pairing code.', 409)
    }
    const address = this.server?.address()
    const port = address && typeof address !== 'string' ? address.port : settings.port
    // A Tailscale code names the address this listener is actually bound to, so the route is
    // resolved before a single-use code is spent on a machine that cannot yet be reached.
    const route = ticketRoute(settings, this.bound, {
      relayKey: this.deps.relayKey?.() ?? null,
      deviceKey: this.deps.deviceKey?.() ?? null,
      room: this.deps.relayRoom?.() ?? null
    })
    const { code, expiresAt } = this.deps.peers.issueTicket()
    return {
      version: 1,
      machineId: this.deps.peers.machineId,
      machineName: this.deps.machineName(),
      accountLogin: this.deps.accountLogin() ?? '',
      port,
      fingerprint: this.identity().fingerprint,
      code,
      expiresAt,
      ...route
    }
  }

  private async body(request: IncomingMessage): Promise<Buffer> {
    if (Number(request.headers['content-length']) > MAX_BODY) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk as Buffer)
      if (size > MAX_BODY) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
      chunks.push(Buffer.from(chunk as Buffer))
    }
    return Buffer.concat(chunks)
  }

  /**
   * One remote request, independent of how it arrived. The HTTPS listener and the encrypted relay
   * both land here with the same path, the same raw body and the same signed headers, so there is
   * exactly one place where a peer's authority is decided and neither route can be the weaker one.
   */
  async handleRequest(path: string, raw: Buffer, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    const encode = (status: number, body: unknown): { status: number; body: string } => {
      try { return { status, body: JSON.stringify(body) ?? '{}' } }
      catch { return { status: 500, body: JSON.stringify({ error: 'That result could not be encoded for the wire.' }) } }
    }
    try {
      if (raw.length > MAX_BODY) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
      let payload: Record<string, unknown>
      try { payload = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown> }
      catch { throw new RemoteAccessError('Malformed JSON body.', 400) }
      if (path === '/remote/pair') return encode(200, { result: await this.pair(payload) })
      if (path === '/remote/pair/status') return encode(200, { result: await this.pairStatus(payload) })
      if (path === '/remote/call') return encode(200, { result: await this.callMethod(headers, raw, payload) })
      throw new RemoteAccessError('Unknown remote endpoint.', 404)
    } catch (error) {
      const status = error instanceof RemoteAccessError ? error.status : 400
      const code = error instanceof RemoteAccessError ? error.code : undefined
      return encode(status, { error: error instanceof Error ? error.message : 'Remote request failed', ...(code ? { code } : {}) })
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Serialising first keeps a body that cannot be encoded from leaving a half-written response
    // that the error path would then try to write again, which would escape this handler entirely.
    const reply = (status: number, body: string): void => {
      if (response.destroyed || response.writableEnded || response.headersSent) return
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(body)
    }
    try {
      this.requireTailnetSocket(request.socket as Socket)
      // A browser is never a legitimate client here, so anything carrying an Origin is refused
      // before it can be used as a confused deputy.
      if (request.method !== 'POST' || request.headers.origin || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw new RemoteAccessError('Only JSON remote-control requests are accepted.', 405)
      }
      const path = (request.url ?? '').split('?')[0]
      const raw = await this.body(request)
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers[name.toLowerCase()] = value
      const answer = await this.handleRequest(path ?? '', raw, headers)
      reply(answer.status, answer.body)
    } catch (error) {
      request.resume()
      const status = error instanceof RemoteAccessError ? error.status : 400
      const code = error instanceof RemoteAccessError ? error.code : undefined
      reply(status, JSON.stringify({ error: error instanceof Error ? error.message : 'Remote request failed', ...(code ? { code } : {}) }))
    }
  }

  /**
   * Defence in depth for Tailscale exposure. The listener is already bound to the tailnet address
   * alone, so nothing off the tailnet should be able to reach it at all; this refuses it a second
   * time from the socket's own address. It costs nothing and it covers the cases a bind cannot:
   * a proxy or port forward somebody set up on this machine, and a future bug that widens the bind
   * without anyone noticing that the promise in the settings panel quietly stopped being true.
   */
  private requireTailnetSocket(socket: Socket | undefined): void {
    if (this.bound?.exposure !== 'tailscale') return
    if (isTailscaleAddress(socket?.remoteAddress ?? '')) return
    throw new RemoteAccessError('This machine only accepts connections over Tailscale.', 403)
  }

  /**
   * The one door for every WebSocket on this listener. Whatever registered the path decides who
   * may speak it; this decides that the thing knocking is a WebSocket client of ours at all.
   *
   * An Origin header is the whole check that matters here. A pinned self-signed certificate does
   * not stop a page in the owner's browser from opening a WebSocket - the browser sends the
   * upgrade with the owner's network position and no same-origin policy applies to WebSockets - so
   * a request carrying an Origin is a browser, a browser is never one of ours, and it is refused
   * before a single frame is read.
   */
  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    socket.on('error', () => { /* an upgrade socket that breaks has nothing left to report */ })
    try { this.requireTailnetSocket(socket) }
    catch { return refuseUpgrade(socket, 403, 'Forbidden') }
    if (request.headers.origin) return refuseUpgrade(socket, 403, 'Forbidden')
    // rawHeaders is name/value pairs; a client that fits inside the header limit but sends a
    // megabyte of them is still holding memory this listener never agreed to hold.
    const headerBytes = request.rawHeaders.reduce((total, part) => total + part.length, 0)
    if (headerBytes > MAX_UPGRADE_HEADER_BYTES) return refuseUpgrade(socket, 431, 'Request Header Fields Too Large')
    if ((request.method ?? 'GET').toUpperCase() !== 'GET') return refuseUpgrade(socket, 405, 'Method Not Allowed')
    if (String(request.headers['sec-websocket-version'] ?? '') !== '13') {
      try { socket.end('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n') } catch { /* gone */ }
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) return refuseUpgrade(socket, 400, 'Bad Request')
    // We negotiate no extensions and no subprotocol, so a client asking for either is speaking
    // frames this build does not read. Saying so now is better than closing mid-conversation.
    if (request.headers['sec-websocket-extensions'] || request.headers['sec-websocket-protocol']) return refuseUpgrade(socket, 400, 'Bad Request')
    const handler = this.upgrades.get((request.url ?? '').split('?')[0] ?? '')
    if (!handler) return refuseUpgrade(socket, 404, 'Not Found')
    try { handler(request, socket, head ?? Buffer.alloc(0)) }
    catch { refuseUpgrade(socket, 500, 'Internal Server Error') }
  }

  /**
   * This machine's certificate, minted on first use. A challenge signature is bound to it on both
   * transports, so the relay needs it even when the owner never opened the listener at all — the
   * certificate is this machine's stable name here, not only what a TLS handshake presents.
   */
  identity(): RemoteTlsIdentity {
    if (!this.tls) {
      this.tls = this.tlsIdentity()
      this.deps.peers.setFingerprint(this.tls.fingerprint)
    }
    return this.tls
  }

  private fingerprint(): string {
    return this.identity().fingerprint
  }

  private async pair(payload: Record<string, unknown>): Promise<{ status: 'pending'; requestId: string; keyFingerprint: string }> {
    const publicKey = String(payload.publicKey ?? '')
    const request = await this.deps.peers.beginPairing({
      machineId: String(payload.machineId ?? ''),
      machineName: String(payload.machineName ?? ''),
      publicKey,
      signature: String(payload.signature ?? ''),
      nonce: String(payload.nonce ?? ''),
      timestamp: Number(payload.timestamp),
      code: String(payload.code ?? ''),
      fingerprint: this.fingerprint()
    })
    return { status: 'pending', requestId: request.id, keyFingerprint: request.keyFingerprint }
  }

  /**
   * The waiting machine asks whether the owner approved. It must sign the poll with the same
   * device key, so the answer — including its peer id — is only ever handed to the key holder.
   */
  private async pairStatus(payload: Record<string, unknown>): Promise<{ status: string; peerId?: string; projects?: RemoteProjectSummary[]; machineName?: string }> {
    const fingerprint = this.deps.peers.verifyPairingPoll({
      publicKey: String(payload.publicKey ?? ''),
      nonce: String(payload.nonce ?? ''),
      timestamp: Number(payload.timestamp),
      signature: String(payload.signature ?? ''),
      fingerprint: this.fingerprint()
    })
    const result = this.deps.peers.pairingResult(fingerprint)
    // The shared projects go back with their identities so the controlling machine can put the
    // owner's confirmation of which project is which in front of them straight after pairing.
    return result.peer
      ? { status: result.status, peerId: result.peer.id, projects: this.deps.peers.sharedProjects(result.peer), machineName: this.deps.machineName() }
      : { status: result.status }
  }

  private async callMethod(requestHeaders: Record<string, string>, raw: Buffer, payload: Record<string, unknown>): Promise<unknown> {
    const header = (name: string): string => String(requestHeaders[name] ?? '')
    const { peer } = await this.deps.peers.authenticate({
      peerId: header(PEER_HEADER),
      nonce: header(NONCE_HEADER),
      timestamp: Number(header(TIMESTAMP_HEADER)),
      signature: header(SIGNATURE_HEADER),
      body: raw,
      fingerprint: this.fingerprint()
    })
    const method = typeof payload.method === 'string' && payload.method.length <= 100 ? payload.method : ''
    if (!method) throw new RemoteAccessError('Provide a method and args object.', 400)
    return this.deps.host.call(peer, method, payload.args ?? {})
  }

  private closeSocket(server: Server): Promise<void> {
    const active = this.closing.get(server)
    if (active) return active
    const closing = new Promise<void>(resolve => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        server.off('close', done)
        resolve()
      }
      server.once('close', done)
      try { server.closeAllConnections() } catch { /* a half-created listener may have no connections */ }
      try { server.close(() => done()) } catch { done() }
    }).finally(() => {
      this.sockets.delete(server)
      this.closing.delete(server)
    })
    this.closing.set(server, closing)
    return closing
  }

  private async stopSockets(): Promise<void> {
    this.server = undefined
    // `tls` is deliberately kept. It is this machine's identity, and the relay signs against it
    // whether or not a socket is open; dropping it here would silently invalidate every pairing the
    // owner made while the listener happened to be running.
    if (this.status.listening || this.status.endpoint || this.status.fingerprint) this.setStopped()
    await Promise.all([...this.sockets].map(server => this.closeSocket(server)))
  }

  async stop(): Promise<void> {
    const intent = ++this.intent
    await this.stopSockets()
    if (intent === this.intent) this.setStopped()
  }

  async close(): Promise<void> {
    await this.stop()
  }
}

export const remoteRequestId = (): string => randomUUID()
