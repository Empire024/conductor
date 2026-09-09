import { randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { RemoteConnection, RemotePairingTicket } from '../shared/remote-control'
import { decodeTicket } from '../shared/remote-control'
import { signChallenge, type ChallengePayload } from './device-key'
import type { DeviceKeyPair } from './device-key'
import { hashBody, NONCE_HEADER, PEER_HEADER, RemoteAccessError, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './remote-peers'
import type { SecretKeyValueStore } from './secret-store'

const CONNECTIONS_SETTING = 'remote-control.connections'
const REQUEST_TIMEOUT_MS = 60000

export interface RemoteControlClientDependencies {
  store: SecretKeyValueStore
  machineId(): string
  machineName(): string
  deviceKey(): DeviceKeyPair | null
  now?(): number
  changed?(): void
}

interface WireResponse { result?: unknown; error?: string; code?: string }

/**
 * Everything in a pair-status answer comes from the other machine, and the peer id goes straight
 * into a request header afterwards, so it is checked here rather than trusted for having arrived
 * over a pinned certificate.
 */
function readPairingResult(value: unknown): { status: string; peerId?: string; grantedProjectIds?: string[] } {
  const result = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    status: typeof result.status === 'string' ? result.status : 'pending',
    peerId: typeof result.peerId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(result.peerId) ? result.peerId : undefined,
    grantedProjectIds: Array.isArray(result.grantedProjectIds)
      ? result.grantedProjectIds.filter((id): id is string => typeof id === 'string').slice(0, 200)
      : []
  }
}

/**
 * The socket is fully established and its certificate checked against the pinned fingerprint
 * before the request is written, so a substituted certificate never sees a signed request it
 * could replay at the real machine.
 */
async function pinnedSocket(host: string, port: number, fingerprint: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, rejectUnauthorized: false, servername: 'localhost', minVersion: 'TLSv1.2' })
    const fail = (error: Error): void => { socket.destroy(); reject(error) }
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new RemoteAccessError('That machine did not answer in time.', 504)))
    socket.once('error', error => fail(error instanceof Error ? error : new Error(String(error))))
    socket.once('secureConnect', () => {
      const presented = socket.getPeerCertificate()?.fingerprint256 ?? ''
      if (!presented || presented.toUpperCase() !== fingerprint.toUpperCase()) {
        fail(new RemoteAccessError('That machine presented a different certificate than the one in the pairing code. Nothing was sent.', 495))
        return
      }
      socket.setTimeout(0)
      resolve(socket)
    })
  })
}

async function post(host: string, port: number, fingerprint: string, path: string, body: Buffer, headers: Record<string, string>): Promise<unknown> {
  const socket = await pinnedSocket(host, port, fingerprint)
  return new Promise((resolve, reject) => {
    let call: ReturnType<typeof httpsRequest>
    try {
      call = httpsRequest({
        host, port, path, method: 'POST',
        createConnection: () => socket,
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length), ...headers }
      }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) { call.destroy(); reject(new RemoteAccessError('That machine sent too much data.', 502)) } else chunks.push(chunk as Buffer) })
        response.on('end', () => {
          let payload: WireResponse = {}
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as WireResponse } catch { /* reported below */ }
          if ((response.statusCode ?? 500) >= 400 || payload.error) {
            reject(new RemoteAccessError(payload.error || `That machine refused the request (${response.statusCode}).`,
              response.statusCode ?? 500, payload.code === 'peer-revoked' ? 'peer-revoked' : undefined))
          } else resolve(payload.result)
        })
      })
    } catch (error) {
      // A header value the other machine supplied can make this throw before the request owns the
      // socket, and a pinned socket nobody closes stays open against that machine.
      socket.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    call.setTimeout(REQUEST_TIMEOUT_MS, () => { call.destroy(new RemoteAccessError('That machine did not answer in time.', 504)) })
    call.on('error', error => reject(error))
    call.end(body)
  })
}

/** This machine acting as the controller: pairing with, and then calling, other machines. */
export class RemoteControlClient {
  private connections: RemoteConnection[] = []

  constructor(private readonly deps: RemoteControlClientDependencies) {
    this.connections = this.read()
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private read(): RemoteConnection[] {
    const raw = this.deps.store.getSetting(CONNECTIONS_SETTING)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((entry): entry is RemoteConnection => Boolean(entry) && typeof entry === 'object' && typeof (entry as RemoteConnection).machineId === 'string') : []
    } catch { return [] }
  }

  private persist(): void {
    this.deps.store.setSetting(CONNECTIONS_SETTING, JSON.stringify(this.connections))
    this.deps.changed?.()
  }

  list(): RemoteConnection[] { return this.connections.map(connection => ({ ...connection })) }

  get(machineId: string): RemoteConnection | undefined { return this.connections.find(connection => connection.machineId === machineId) }

  forget(machineId: string): void {
    this.connections = this.connections.filter(connection => connection.machineId !== machineId)
    this.persist()
  }

  private key(): DeviceKeyPair {
    const key = this.deps.deviceKey()
    if (!key) throw new RemoteAccessError('Sign in to GitHub on this machine first; it has no device key yet.', 401)
    return key
  }

  private sign(ticket: Pick<RemotePairingTicket, 'machineId' | 'fingerprint'>, purpose: 'pair' | 'call', bodyHash: string): { payload: ChallengePayload; signature: string } {
    const payload: ChallengePayload = {
      audienceMachineId: ticket.machineId,
      fingerprint: ticket.fingerprint,
      nonce: randomBytes(18).toString('base64url'),
      purpose,
      bodyHash,
      issuedAt: this.now()
    }
    return { payload, signature: signChallenge(this.key().privateKeyPem, payload) }
  }

  /**
   * Presents this machine's device key to the other machine and waits for its owner to approve.
   * The remote side decides whether the key really belongs to the same GitHub account.
   */
  async connect(encodedTicket: string, poll?: (attempt: number) => Promise<void>): Promise<RemoteConnection> {
    const ticket = decodeTicket(encodedTicket)
    if (Date.parse(ticket.expiresAt) <= this.now()) throw new RemoteAccessError('That pairing code has expired. Create a new one on the other machine.', 410)
    const key = this.key()
    const { payload, signature } = this.sign(ticket, 'pair', '')
    const body = Buffer.from(JSON.stringify({
      machineId: this.deps.machineId(),
      machineName: this.deps.machineName(),
      publicKey: key.publicKey,
      signature,
      nonce: payload.nonce,
      timestamp: payload.issuedAt,
      code: ticket.code
    }), 'utf8')
    await post(ticket.host, ticket.port, ticket.fingerprint, '/remote/pair', body, {})
    const pending: RemoteConnection = {
      machineId: ticket.machineId,
      machineName: ticket.machineName,
      accountLogin: ticket.accountLogin,
      host: ticket.host,
      port: ticket.port,
      fingerprint: ticket.fingerprint,
      peerId: '',
      grantedProjectIds: [],
      connectedAt: new Date(this.now()).toISOString(),
      lastContactAt: null,
      status: 'pending',
      message: 'Waiting for approval on the other machine.'
    }
    this.connections = [...this.connections.filter(entry => entry.machineId !== ticket.machineId), pending]
    this.persist()
    for (let attempt = 0; attempt < 60; attempt++) {
      await (poll ? poll(attempt) : new Promise<void>(resolve => setTimeout(resolve, 2000)))
      const status = await this.pollPairing(ticket)
      if (status.status === 'approved' && status.peerId) {
        const connected: RemoteConnection = { ...pending, peerId: status.peerId, grantedProjectIds: status.grantedProjectIds ?? [], status: 'connected', message: null, lastContactAt: new Date(this.now()).toISOString() }
        this.connections = [...this.connections.filter(entry => entry.machineId !== ticket.machineId), connected]
        this.persist()
        return connected
      }
      if (status.status === 'denied') {
        this.forget(ticket.machineId)
        throw new RemoteAccessError('The other machine declined this pairing request.', 403)
      }
    }
    throw new RemoteAccessError('The other machine did not approve in time. Try pairing again.', 408)
  }

  private async pollPairing(ticket: RemotePairingTicket): Promise<{ status: string; peerId?: string; grantedProjectIds?: string[] }> {
    const key = this.key()
    const { payload, signature } = this.sign(ticket, 'pair', '')
    const body = Buffer.from(JSON.stringify({ publicKey: key.publicKey, signature, nonce: payload.nonce, timestamp: payload.issuedAt }), 'utf8')
    return readPairingResult(await post(ticket.host, ticket.port, ticket.fingerprint, '/remote/pair/status', body, {}))
  }

  /** One authenticated call to a paired machine. Every call is signed over its exact body. */
  async call(machineId: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const connection = this.get(machineId)
    if (!connection) throw new RemoteAccessError('This machine is not paired with that one.', 404)
    if (connection.status === 'revoked') throw new RemoteAccessError('That machine revoked this pairing.', 403)
    if (!connection.peerId) throw new RemoteAccessError('That pairing has not been approved yet.', 409)
    const body = Buffer.from(JSON.stringify({ method, args }), 'utf8')
    const { payload, signature } = this.sign(connection, 'call', hashBody(body))
    try {
      const result = await post(connection.host, connection.port, connection.fingerprint, '/remote/call', body, {
        [PEER_HEADER]: connection.peerId,
        [NONCE_HEADER]: payload.nonce,
        [TIMESTAMP_HEADER]: String(payload.issuedAt),
        [SIGNATURE_HEADER]: signature
      })
      this.mark(machineId, { status: 'connected', message: null, lastContactAt: new Date(this.now()).toISOString() })
      return result
    } catch (error) {
      // Only a dead pairing marks the machine revoked. One call being refused — an unshared
      // project, a workspace that moved — must not brick every later call to that machine.
      // A 4xx it answered with also proves it is reachable; a timeout or bad certificate does not.
      const revoked = error instanceof RemoteAccessError && error.code === 'peer-revoked'
      const answered = error instanceof RemoteAccessError && error.status >= 400 && error.status < 500 && error.status !== 495
      this.mark(machineId, {
        status: revoked ? 'revoked' : answered ? 'connected' : 'unreachable',
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private mark(machineId: string, patch: Partial<RemoteConnection>): void {
    const connection = this.connections.find(entry => entry.machineId === machineId)
    if (!connection) return
    Object.assign(connection, patch)
    this.persist()
  }

  /** Signing out drops every outbound pairing; they were only ever valid for that account. */
  clear(): void {
    this.connections = []
    this.persist()
  }
}
