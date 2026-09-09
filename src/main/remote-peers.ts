import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  PendingPairingRequest,
  RemoteActivityEntry,
  RemoteControlSettings,
  RemoteGrant,
  RemotePeerRecord,
  RemoteProjectSummary
} from '../shared/remote-control'
import { normalizeRemoteSettings } from '../shared/remote-control'
import { keyFingerprint, secretsMatch, verifyChallenge, type ChallengePayload } from './device-key'
import type { SecretKeyValueStore } from './secret-store'

export const PEER_HEADER = 'x-conductor-peer'
export const NONCE_HEADER = 'x-conductor-nonce'
export const TIMESTAMP_HEADER = 'x-conductor-timestamp'
export const SIGNATURE_HEADER = 'x-conductor-signature'

const PEERS_SETTING = 'remote-control.peers'
const SETTINGS_SETTING = 'remote-control.settings'
const MACHINE_ID_SETTING = 'remote-control.machineId'

/** A signature older or newer than this is refused outright, before any key work happens. */
const CLOCK_SKEW_MS = 120000
const NONCE_MEMORY = 4096
const PAIRING_TICKET_MS = 10 * 60000
const PAIRING_REQUEST_MS = 10 * 60000
const ACTIVITY_LIMIT = 200

export interface RemotePeersDependencies {
  store: SecretKeyValueStore
  /** The account this machine is signed in as; null while signed out, which disables every peer. */
  accountId(): number | null
  accountLogin(): string | null
  /** SSH keys registered on this machine's own GitHub account. */
  accountKeys(force?: boolean): Promise<string[]>
  projects(): RemoteProjectSummary[]
  now?(): number
  changed?(): void
  /** Remote work is surfaced in this machine's UI through here, like local agent activity. */
  activity?(entry: RemoteActivityEntry): void
  /** How long a paired key may go unchecked against the account before it is re-read from GitHub. */
  revalidateMs?: number
  /** How long the last good key check stays usable while GitHub is unreachable. */
  offlineGraceMs?: number
}

export interface PairingAttempt {
  machineId: string
  machineName: string
  publicKey: string
  signature: string
  nonce: string
  timestamp: number
  /** The code from the ticket the owner copied off this machine. */
  code: string
  /** The TLS fingerprint the peer saw, which must be this machine's own. */
  fingerprint: string
}

export interface AuthenticatedPeer {
  peer: RemotePeerRecord
  grantedProjectIds: string[]
}

export class RemoteAccessError extends Error {
  /** `peer-revoked` means the pairing itself is finished, not that this one call was denied. */
  constructor(message: string, readonly status = 403, readonly code?: 'peer-revoked') { super(message) }
}

/**
 * True when the account check failed for a reason waiting cannot fix: GitHub rejected the
 * credential, or this machine has no usable one to ask with. The offline grace exists for a flaky
 * network, so it must never be stretched over a state where "same account" was never established.
 */
const accountUnverifiable = (error: unknown): boolean =>
  Boolean(error) && typeof error === 'object' && (error as { accountUnverifiable?: unknown }).accountUnverifiable === true

interface PairingTicket { code: string; expiresAt: number }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const hashBody = (body: Buffer | string): string =>
  createHash('sha256').update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body).digest('base64url')

/**
 * The trust boundary for remote control. Every rule that decides whether another machine may act
 * on this one lives here so it can be tested without a socket: same GitHub account, owner
 * approval, live revocation, project scope, and freshness of each individual request.
 */
export class RemotePeers {
  private peers: RemotePeerRecord[] = []
  private settings: RemoteControlSettings
  private pending: PendingPairingRequest[] = []
  private tickets: PairingTicket[] = []
  private seenNonces = new Map<string, number>()
  private lastKeyCheck = 0
  private keyCheckOk = 0
  private activityLog: RemoteActivityEntry[] = []
  readonly machineId: string

  constructor(private readonly deps: RemotePeersDependencies) {
    this.peers = this.readPeers()
    this.settings = normalizeRemoteSettings(this.readJson(SETTINGS_SETTING))
    this.machineId = this.deps.store.getSetting(MACHINE_ID_SETTING) || randomUUID()
    this.deps.store.setSetting(MACHINE_ID_SETTING, this.machineId)
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private readJson(key: string): unknown {
    const raw = this.deps.store.getSetting(key)
    if (!raw) return null
    try { return JSON.parse(raw) as unknown } catch { return null }
  }

  private readPeers(): RemotePeerRecord[] {
    const parsed = this.readJson(PEERS_SETTING)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecord).flatMap(entry => {
      const record = entry as Partial<RemotePeerRecord>
      if (typeof record.id !== 'string' || typeof record.publicKey !== 'string' || typeof record.accountId !== 'number') return []
      let fingerprint: string
      try { fingerprint = keyFingerprint(record.publicKey) } catch { return [] }
      return [{
        id: record.id,
        machineId: String(record.machineId ?? ''),
        machineName: String(record.machineName ?? 'Unnamed machine'),
        accountId: record.accountId,
        accountLogin: String(record.accountLogin ?? ''),
        keyFingerprint: fingerprint,
        publicKey: record.publicKey,
        grantedProjectIds: Array.isArray(record.grantedProjectIds) ? record.grantedProjectIds.filter((id): id is string => typeof id === 'string') : [],
        approvedAt: String(record.approvedAt ?? new Date(0).toISOString()),
        lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : null,
        revokedAt: typeof record.revokedAt === 'string' ? record.revokedAt : null
      }]
    })
  }

  private persist(): void {
    this.deps.store.setSetting(PEERS_SETTING, JSON.stringify(this.peers))
    this.deps.changed?.()
  }

  listPeers(): RemotePeerRecord[] { return this.peers.map(peer => ({ ...peer })) }
  listPending(): PendingPairingRequest[] {
    const now = this.now()
    this.pending = this.pending.filter(request => Date.parse(request.expiresAt) > now)
    return this.pending.map(request => ({ ...request }))
  }
  listActivity(): RemoteActivityEntry[] { return this.activityLog.map(entry => ({ ...entry })) }

  getSettings(): RemoteControlSettings { return { ...this.settings } }

  updateSettings(patch: Partial<RemoteControlSettings>): RemoteControlSettings {
    this.settings = normalizeRemoteSettings({ ...this.settings, ...patch })
    this.deps.store.setSetting(SETTINGS_SETTING, JSON.stringify(this.settings))
    this.deps.changed?.()
    return this.getSettings()
  }

  /** A short-lived code the owner carries to the machine that will do the controlling. */
  issueTicket(): { code: string; expiresAt: string } {
    const now = this.now()
    this.tickets = this.tickets.filter(ticket => ticket.expiresAt > now)
    const code = randomBytes(24).toString('base64url')
    const expiresAt = now + PAIRING_TICKET_MS
    this.tickets.push({ code, expiresAt })
    return { code, expiresAt: new Date(expiresAt).toISOString() }
  }

  private consumeTicket(code: string): void {
    const now = this.now()
    this.tickets = this.tickets.filter(ticket => ticket.expiresAt > now)
    const index = this.tickets.findIndex(ticket => secretsMatch(ticket.code, code))
    if (index < 0) throw new RemoteAccessError('That pairing code is not valid on this machine, or it has expired.', 401)
    this.tickets.splice(index, 1)
  }

  /**
   * Only ever reached once a signature has proved the caller holds the device key, so a stranger
   * cannot put entries in this map. That matters more than it looks: if unauthenticated traffic
   * could fill it, a flood would evict a nonce that is still inside its replay window and the
   * captured request it belongs to would become replayable again.
   *
   * The arrival time is recorded rather than the caller's timestamp, so how long a nonce is
   * remembered stays this machine's decision and always outlasts the window it is valid in.
   */
  private rememberNonce(nonce: string): void {
    const now = this.now()
    for (const [seen, at] of this.seenNonces) if (now - at > CLOCK_SKEW_MS * 2) this.seenNonces.delete(seen)
    if (this.seenNonces.has(nonce)) throw new RemoteAccessError('This request was already used.', 401)
    // Evicting a live nonce would reopen the replay window, so a burst is refused instead.
    if (this.seenNonces.size >= NONCE_MEMORY) throw new RemoteAccessError('Too many remote requests at once; retry in a moment.', 429)
    this.seenNonces.set(nonce, now)
  }

  /** The checks that need no key work: shape, clock, certificate, and an already-spent nonce. */
  private checkFreshness(nonce: string, timestamp: number, fingerprint: string, expectedFingerprint: string): void {
    if (!nonce || nonce.length < 16 || nonce.length > 128) throw new RemoteAccessError('Missing request nonce.', 401)
    if (!Number.isFinite(timestamp) || Math.abs(this.now() - timestamp) > CLOCK_SKEW_MS) throw new RemoteAccessError('This request is too old; check the clock on both machines.', 401)
    if (!expectedFingerprint || fingerprint !== expectedFingerprint) throw new RemoteAccessError('The request was signed for a different connection.', 401)
    if (this.seenNonces.has(nonce)) throw new RemoteAccessError('This request was already used.', 401)
  }

  /**
   * Reads the SSH keys on this machine's own GitHub account and reports whether the presented key
   * is one of them. This is what makes "same account" a fact rather than a claim: the list comes
   * from GitHub under this machine's token, so a peer cannot influence it.
   */
  private async keyBelongsToAccount(publicKey: string, force: boolean): Promise<boolean> {
    const now = this.now()
    const revalidateMs = this.deps.revalidateMs ?? 10 * 60000
    const offlineGraceMs = this.deps.offlineGraceMs ?? 60 * 60000
    let keys: string[]
    try {
      const stale = force || now - this.lastKeyCheck > revalidateMs
      keys = await this.deps.accountKeys(stale)
      this.lastKeyCheck = now
      this.keyCheckOk = now
    } catch (error) {
      if (force) throw new RemoteAccessError(`GitHub could not confirm the account keys: ${error instanceof Error ? error.message : String(error)}`, 503)
      // A locked keychain or a rejected token is not a network blip: there is no credential left
      // to check "same account" with, so access stops now instead of coasting on the grace window.
      if (accountUnverifiable(error)) throw new RemoteAccessError('This machine cannot use its own GitHub credential, so remote access is paused until it signs in again.', 503)
      if (!this.keyCheckOk || now - this.keyCheckOk > offlineGraceMs) throw new RemoteAccessError('GitHub has not confirmed this account recently, so remote access is paused.', 503)
      return true
    }
    let fingerprint: string
    try { fingerprint = keyFingerprint(publicKey) } catch { return false }
    return keys.some(key => { try { return keyFingerprint(key) === fingerprint } catch { return false } })
  }

  private grantsFor(projectIds: string[]): RemoteGrant[] {
    const projects = this.deps.projects().filter(project => projectIds.includes(project.id))
    return [
      { label: 'Conductor projects', detail: projects.length ? projects.map(project => project.name).join(', ') : 'No projects selected yet' },
      { label: 'Project files', detail: 'Read and write files inside those project folders only' },
      { label: 'Agent tabs', detail: 'Open, steer and close agent tabs in those projects; every action shows in this window' },
      { label: 'Not granted', detail: 'No shell, no access to files outside those projects, no GitHub token' }
    ]
  }

  /**
   * Step one of pairing. A request only becomes pending after the signature checks out against a
   * key the account actually lists, so the approval prompt can never be raised by a stranger.
   */
  async beginPairing(attempt: PairingAttempt): Promise<PendingPairingRequest> {
    const accountId = this.deps.accountId()
    if (accountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401)
    this.consumeTicket(attempt.code)
    this.checkFreshness(attempt.nonce, attempt.timestamp, attempt.fingerprint, this.currentFingerprint)
    const payload: ChallengePayload = {
      audienceMachineId: this.machineId,
      fingerprint: attempt.fingerprint,
      nonce: attempt.nonce,
      purpose: 'pair',
      bodyHash: '',
      issuedAt: attempt.timestamp
    }
    if (!verifyChallenge(attempt.publicKey, payload, attempt.signature)) throw new RemoteAccessError('The pairing request was not signed by the key it presented.', 401)
    this.rememberNonce(attempt.nonce)
    if (!await this.keyBelongsToAccount(attempt.publicKey, true)) {
      throw new RemoteAccessError('That machine is not signed in to the same GitHub account. Its device key is not registered on this account.', 403)
    }
    const now = this.now()
    const request: PendingPairingRequest = {
      id: randomUUID(),
      machineId: String(attempt.machineId || '').slice(0, 100),
      machineName: String(attempt.machineName || 'Unnamed machine').slice(0, 60),
      accountId,
      accountLogin: this.deps.accountLogin() ?? '',
      keyFingerprint: keyFingerprint(attempt.publicKey),
      publicKey: attempt.publicKey,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIRING_REQUEST_MS).toISOString(),
      grants: this.grantsFor(this.deps.projects().map(project => project.id))
    }
    this.pending = [...this.listPending().filter(existing => existing.keyFingerprint !== request.keyFingerprint), request]
    this.deps.changed?.()
    return { ...request }
  }

  /** Nothing is granted until the owner of this machine says so, and only for the chosen projects. */
  approve(pendingId: string, grantedProjectIds: string[]): RemotePeerRecord {
    const request = this.listPending().find(entry => entry.id === pendingId)
    if (!request) throw new RemoteAccessError('That pairing request is no longer waiting.', 404)
    const registered = new Set(this.deps.projects().map(project => project.id))
    const granted = [...new Set(grantedProjectIds.filter(id => registered.has(id)))]
    if (!granted.length) throw new RemoteAccessError('Choose at least one registered project to share.', 400)
    const peer: RemotePeerRecord = {
      id: randomUUID(),
      machineId: request.machineId,
      machineName: request.machineName,
      accountId: request.accountId,
      accountLogin: request.accountLogin,
      keyFingerprint: request.keyFingerprint,
      publicKey: request.publicKey,
      grantedProjectIds: granted,
      approvedAt: new Date(this.now()).toISOString(),
      lastSeenAt: null,
      revokedAt: null
    }
    this.pending = this.pending.filter(entry => entry.id !== pendingId)
    this.peers = [...this.peers.filter(existing => existing.keyFingerprint !== peer.keyFingerprint), peer]
    this.persist()
    this.record(peer, 'pairing.approve', null, `Paired ${peer.machineName}`, 'allowed')
    return { ...peer }
  }

  deny(pendingId: string): void {
    const request = this.listPending().find(entry => entry.id === pendingId)
    this.pending = this.pending.filter(entry => entry.id !== pendingId)
    if (request) {
      this.activity(`Denied pairing from ${request.machineName}`, { peerId: request.id, machineName: request.machineName, accountLogin: request.accountLogin, method: 'pairing.deny', projectId: null, outcome: 'denied' })
    }
    this.deps.changed?.()
  }

  /**
   * Verifies a poll asking whether the owner has approved yet. A poll carries no pairing code, so
   * without these checks a captured one would stay valid for ever and keep handing out the peer id
   * it answers with; it gets exactly the freshness rules a call gets.
   */
  verifyPairingPoll(input: { publicKey: string; nonce: string; timestamp: number; signature: string; fingerprint: string }): string {
    this.checkFreshness(input.nonce, input.timestamp, input.fingerprint, this.currentFingerprint)
    const verified = verifyChallenge(input.publicKey, {
      audienceMachineId: this.machineId,
      fingerprint: input.fingerprint,
      nonce: input.nonce,
      purpose: 'pair',
      bodyHash: '',
      issuedAt: input.timestamp
    }, input.signature)
    if (!verified) throw new RemoteAccessError('That poll was not signed by the key it presented.', 401)
    this.rememberNonce(input.nonce)
    try { return keyFingerprint(input.publicKey) } catch { throw new RemoteAccessError('Unsupported device key.', 400) }
  }

  /** A pending pairing request the peer can poll for, so it learns the owner's answer. */
  pairingResult(keyFingerprint: string): { status: 'pending' | 'approved' | 'denied'; peer?: RemotePeerRecord } {
    const peer = this.peers.find(entry => entry.keyFingerprint === keyFingerprint && !entry.revokedAt)
    if (peer) return { status: 'approved', peer: { ...peer } }
    return { status: this.listPending().some(entry => entry.keyFingerprint === keyFingerprint) ? 'pending' : 'denied' }
  }

  revoke(peerId: string): void {
    const peer = this.peers.find(entry => entry.id === peerId)
    if (!peer) return
    peer.revokedAt = new Date(this.now()).toISOString()
    this.persist()
    this.record(peer, 'peer.revoke', null, `Revoked ${peer.machineName}`, 'denied')
  }

  forget(peerId: string): void {
    this.peers = this.peers.filter(entry => entry.id !== peerId)
    this.persist()
  }

  /** Signing out of GitHub takes every peer with it; nothing survives the identity it was tied to. */
  revokeAll(reason = 'Signed out of GitHub'): void {
    const at = new Date(this.now()).toISOString()
    for (const peer of this.peers) if (!peer.revokedAt) { peer.revokedAt = at; this.record(peer, 'peer.revoke', null, reason, 'denied') }
    this.pending = []
    this.tickets = []
    this.seenNonces.clear()
    this.persist()
  }

  /**
   * Authenticates one remote call. The signature covers the exact body, this machine's id and the
   * certificate the peer connected over, so a captured request cannot be replayed here, at another
   * machine, or through a substituted certificate.
   */
  async authenticate(input: {
    peerId: string
    nonce: string
    timestamp: number
    signature: string
    body: Buffer | string
    fingerprint: string
  }): Promise<AuthenticatedPeer> {
    if (!this.settings.enabled) throw new RemoteAccessError('Remote control is switched off on this machine.', 503)
    const accountId = this.deps.accountId()
    if (accountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401)
    const peer = this.peers.find(entry => entry.id === input.peerId)
    if (!peer) throw new RemoteAccessError('This machine does not know that peer.', 401, 'peer-revoked')
    if (peer.revokedAt) throw new RemoteAccessError('Access for this machine was revoked.', 403, 'peer-revoked')
    if (peer.accountId !== accountId) throw new RemoteAccessError('That peer was paired with a different GitHub account.', 403, 'peer-revoked')
    this.checkFreshness(input.nonce, input.timestamp, input.fingerprint, this.currentFingerprint)
    const payload: ChallengePayload = {
      audienceMachineId: this.machineId,
      fingerprint: input.fingerprint,
      nonce: input.nonce,
      purpose: 'call',
      bodyHash: hashBody(input.body),
      issuedAt: input.timestamp
    }
    if (!verifyChallenge(peer.publicKey, payload, input.signature)) throw new RemoteAccessError('The request signature does not match this machine or this request.', 401)
    this.rememberNonce(input.nonce)
    if (!await this.keyBelongsToAccount(peer.publicKey, false)) {
      this.revoke(peer.id)
      throw new RemoteAccessError('That device key is no longer registered on this GitHub account, so the peer was revoked.', 403, 'peer-revoked')
    }
    peer.lastSeenAt = new Date(this.now()).toISOString()
    this.persist()
    return { peer: { ...peer }, grantedProjectIds: [...peer.grantedProjectIds] }
  }

  /** The fingerprint of the certificate currently being served; set by the server each time it binds. */
  private currentFingerprint = ''
  setFingerprint(fingerprint: string): void { this.currentFingerprint = fingerprint }

  /** Remote calls may only name a project that is both registered here and granted to that peer. */
  requireProject(peer: RemotePeerRecord, projectId: unknown): RemoteProjectSummary {
    if (typeof projectId !== 'string' || !projectId) throw new RemoteAccessError('Name a project for this request.', 400)
    if (!peer.grantedProjectIds.includes(projectId)) throw new RemoteAccessError('That project was not shared with this machine.', 403)
    const project = this.deps.projects().find(entry => entry.id === projectId)
    if (!project) throw new RemoteAccessError('That project is no longer registered on this machine.', 404)
    return project
  }

  record(peer: Pick<RemotePeerRecord, 'id' | 'machineName' | 'accountLogin'>, method: string, projectId: string | null, detail: string, outcome: 'allowed' | 'denied', message?: string): void {
    this.activity(detail, { peerId: peer.id, machineName: peer.machineName, accountLogin: peer.accountLogin, method, projectId, outcome, message })
  }

  private activity(detail: string, rest: Omit<RemoteActivityEntry, 'id' | 'at' | 'detail'>): void {
    const entry: RemoteActivityEntry = { id: randomUUID(), at: new Date(this.now()).toISOString(), detail, ...rest }
    this.activityLog = [entry, ...this.activityLog].slice(0, ACTIVITY_LIMIT)
    this.deps.activity?.(entry)
    this.deps.changed?.()
  }
}
