import { randomUUID, X509Certificate } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RemoteControlSettings, RemotePairingTicket } from '../shared/remote-control'
import type { RemoteControlHost } from './remote-control-host'
import { NONCE_HEADER, PEER_HEADER, RemoteAccessError, SIGNATURE_HEADER, TIMESTAMP_HEADER, type RemotePeers } from './remote-peers'
import type { SecretKeyValueStore, SecretVault } from './secret-store'
import { createRemoteTlsIdentity, tlsIdentityUsable, type RemoteTlsIdentity } from './remote-tls'

const CERT_SETTING = 'remote-control.tls.certificate'
const CERT_EXPIRY_SETTING = 'remote-control.tls.notAfter'
const TLS_KEY_SECRET = 'remote-control.tls.key'
const MAX_BODY = 3 * 1024 * 1024
/**
 * Anyone who can reach the port can open a socket, long before they can prove anything, so the
 * count is capped. Paired machines use one short-lived connection per call and never come close.
 */
const MAX_SOCKETS = 64

/**
 * Loopback keeps the socket on this machine; 'network' is the deliberate choice that lets it be
 * reached from elsewhere. Nothing else in the server may widen the bind address.
 */
export function resolveBindHost(settings: Pick<RemoteControlSettings, 'exposure'>): string {
  return settings.exposure === 'network' ? '0.0.0.0' : '127.0.0.1'
}

/** Addresses a peer could dial, used for the certificate's SAN list and the pairing ticket. */
export function localAddresses(): string[] {
  const found: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address)
  }
  return found
}

export interface RemoteControlServerDependencies {
  peers: RemotePeers
  host: RemoteControlHost
  store: SecretKeyValueStore
  vault: SecretVault
  machineName(): string
  accountLogin(): string | null
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
  private tls?: RemoteTlsIdentity
  private status: RemoteServerStatus = { listening: false, endpoint: null, fingerprint: null, message: null }

  constructor(private readonly deps: RemoteControlServerDependencies) {}

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
    const settings = this.deps.peers.getSettings()
    await this.stop()
    if (!settings.enabled) { this.status = { listening: false, endpoint: null, fingerprint: null, message: null }; this.deps.changed?.(); return this.getStatus() }
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
    try {
      const tls = this.tlsIdentity()
      this.tls = tls
      this.deps.peers.setFingerprint(tls.fingerprint)
      const server = createServer({ cert: tls.certificatePem, key: tls.privateKeyPem, minVersion: 'TLSv1.2' }, (request, response) => { void this.handle(request, response) })
      server.requestTimeout = 120000
      server.headersTimeout = 10000
      server.maxHeadersCount = 30
      server.maxConnections = MAX_SOCKETS
      const bindHost = resolveBindHost(settings)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(settings.port, bindHost, () => { server.off('error', reject); resolve() })
      })
      // Once listening there is no promise left to reject into, and an unhandled 'error' event on
      // a network-facing listener would take the whole app down. It is surfaced in the status the
      // owner already sees instead.
      server.on('error', error => {
        if (this.server !== server) return
        this.status = { ...this.status, message: error instanceof Error ? error.message : String(error) }
        this.deps.changed?.()
      })
      this.server = server
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : settings.port
      this.status = {
        listening: true,
        endpoint: `https://${bindHost === '0.0.0.0' ? localAddresses()[0] ?? '127.0.0.1' : '127.0.0.1'}:${port}`,
        fingerprint: tls.fingerprint,
        message: settings.exposure === 'network' ? 'Reachable from your network. Only paired machines on your GitHub account can connect.' : null
      }
    } catch (error) {
      this.status = { listening: false, endpoint: null, fingerprint: null, message: error instanceof Error ? error.message : String(error) }
    }
    this.deps.changed?.()
    return this.getStatus()
  }

  /** The ticket carries the address and the certificate to pin, plus a single-use pairing code. */
  ticket(): RemotePairingTicket {
    if (!this.status.listening || !this.tls) throw new RemoteAccessError('Switch remote control on before creating a pairing code.', 409)
    const settings = this.deps.peers.getSettings()
    const address = this.server?.address()
    const port = address && typeof address !== 'string' ? address.port : settings.port
    const { code, expiresAt } = this.deps.peers.issueTicket()
    return {
      version: 1,
      machineId: this.deps.peers.machineId,
      machineName: this.deps.machineName(),
      accountLogin: this.deps.accountLogin() ?? '',
      host: settings.exposure === 'network' ? localAddresses()[0] ?? '127.0.0.1' : '127.0.0.1',
      port,
      fingerprint: this.tls.fingerprint,
      code,
      expiresAt
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Serialising first keeps a body that cannot be encoded from leaving a half-written response
    // that the error path would then try to write again, which would escape this handler entirely.
    const reply = (status: number, body: unknown): void => {
      if (response.destroyed || response.writableEnded || response.headersSent) return
      let encoded: string
      try { encoded = JSON.stringify(body) ?? '{}' }
      catch { encoded = JSON.stringify({ error: 'That result could not be encoded for the wire.' }) }
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(encoded)
    }
    try {
      // A browser is never a legitimate client here, so anything carrying an Origin is refused
      // before it can be used as a confused deputy.
      if (request.method !== 'POST' || request.headers.origin || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw new RemoteAccessError('Only JSON remote-control requests are accepted.', 405)
      }
      const path = (request.url ?? '').split('?')[0]
      const raw = await this.body(request)
      let payload: Record<string, unknown>
      try { payload = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown> }
      catch { throw new RemoteAccessError('Malformed JSON body.', 400) }
      if (path === '/remote/pair') { reply(200, { result: await this.pair(payload) }); return }
      if (path === '/remote/pair/status') { reply(200, { result: await this.pairStatus(payload) }); return }
      if (path === '/remote/call') { reply(200, { result: await this.callMethod(request, raw, payload) }); return }
      throw new RemoteAccessError('Unknown remote endpoint.', 404)
    } catch (error) {
      request.resume()
      const status = error instanceof RemoteAccessError ? error.status : 400
      const code = error instanceof RemoteAccessError ? error.code : undefined
      reply(status, { error: error instanceof Error ? error.message : 'Remote request failed', ...(code ? { code } : {}) })
    }
  }

  private fingerprint(): string {
    if (!this.tls) throw new RemoteAccessError('Remote control is not listening.', 503)
    return this.tls.fingerprint
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
  private async pairStatus(payload: Record<string, unknown>): Promise<{ status: string; peerId?: string; grantedProjectIds?: string[]; machineName?: string }> {
    const fingerprint = this.deps.peers.verifyPairingPoll({
      publicKey: String(payload.publicKey ?? ''),
      nonce: String(payload.nonce ?? ''),
      timestamp: Number(payload.timestamp),
      signature: String(payload.signature ?? ''),
      fingerprint: this.fingerprint()
    })
    const result = this.deps.peers.pairingResult(fingerprint)
    return result.peer
      ? { status: result.status, peerId: result.peer.id, grantedProjectIds: result.peer.grantedProjectIds, machineName: this.deps.machineName() }
      : { status: result.status }
  }

  private async callMethod(request: IncomingMessage, raw: Buffer, payload: Record<string, unknown>): Promise<unknown> {
    const header = (name: string): string => String(request.headers[name] ?? '')
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

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.tls = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  async close(): Promise<void> {
    await this.stop()
    this.status = { listening: false, endpoint: null, fingerprint: null, message: null }
  }
}

export const remoteRequestId = (): string => randomUUID()
