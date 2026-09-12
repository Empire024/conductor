import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  PendingPairingRequest,
  RemoteActivityEntry,
  RemoteControlSettings,
  RemoteGrant,
  RemoteGrantedProject,
  RemotePeerRecord,
  RemoteProjectSummary
} from '../shared/remote-control'
import { normalizeRemoteSettings, readGrantedProjects } from '../shared/remote-control'
import { samePath, sameWorkingCopy } from '../shared/project-identity'
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
  grantedProjects: RemoteGrantedProject[]
}

export class RemoteAccessError extends Error {
  /** `peer-revoked` means the pairing itself is finished, not that this one call was denied. */
  constructor(message: string, readonly status = 403, readonly code?: 'peer-revoked') { super(message) }
}

/** Durable authority stamped by the authenticated host, never accepted from a remote caller. */
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
  /** Changes whenever an owner action invalidates authority already being checked asynchronously. */
  private authorityRevision = 0
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
        // A pairing stored before projects had identities keeps every project it was granted; it
        // simply has no recorded identity to compare against, which readGrantedProjects records
        // honestly rather than inventing one.
        grantedProjects: readGrantedProjects(entry),
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

  listPeers(): RemotePeerRecord[] { return this.peers.map(peer => ({ ...peer, grantedProjects: peer.grantedProjects.map(granted => ({ ...granted })) })) }
  listPending(): PendingPairingRequest[] {
    const now = this.now()
    this.pending = this.pending.filter(request => Date.parse(request.expiresAt) > now)
    return this.pending.map(request => ({ ...request }))
  }
  listActivity(): RemoteActivityEntry[] { return this.activityLog.map(entry => ({ ...entry })) }

  getSettings(): RemoteControlSettings { return { ...this.settings } }

  updateSettings(patch: Partial<RemoteControlSettings>): RemoteControlSettings {
    const before = this.settings
    this.settings = normalizeRemoteSettings({ ...this.settings, ...patch })
    if (before.enabled !== this.settings.enabled) this.authorityRevision++
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
      // Named with their folders: the same project name on two machines is exactly how work ends
      // up in the wrong checkout, so the owner approves a path, not a label.
      { label: 'Conductor projects', detail: projects.length ? projects.map(project => `${project.name} — ${project.path}`).join(', ') : 'No projects selected yet' },
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
    if (!this.settings.enabled) throw new RemoteAccessError('Remote control is switched off on this machine.', 503)
    const accountId = this.deps.accountId()
    if (accountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401)
    const authorityRevision = this.authorityRevision
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
    // GitHub is a network boundary. Re-read every piece of local authority after crossing it:
    // disabling remote control, signing out, switching account or explicitly revoking all access
    // while the request is waiting must win over the stale answer that just came back.
    if (authorityRevision !== this.authorityRevision || !this.settings.enabled) {
      throw new RemoteAccessError('Remote access changed while GitHub was confirming this machine. Start pairing again.', 409)
    }
    const currentAccountId = this.deps.accountId()
    if (currentAccountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401)
    if (currentAccountId !== accountId) throw new RemoteAccessError('This machine changed GitHub accounts while pairing. Start again.', 409)
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
    if (!this.settings.enabled) throw new RemoteAccessError('Remote control is switched off on this machine.', 503)
    const accountId = this.deps.accountId()
    if (accountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401)
    if (request.accountId !== accountId) throw new RemoteAccessError('That pairing request belongs to a different GitHub account. Start again.', 409)
    const registered = this.deps.projects()
    const chosen = [...new Set(grantedProjectIds)].flatMap(id => registered.filter(project => project.id === id))
    if (!chosen.length) throw new RemoteAccessError('Choose at least one registered project to share.', 400)
    // Refusing here keeps a project whose identity cannot be read from being shared under a
    // freshly minted one, which is the case that could later pass an identity check it should fail.
    const unreadable = chosen.find(project => !project.identity)
    if (unreadable) throw new RemoteAccessError(unreadable.identityError || `Conductor cannot read the project identity of “${unreadable.name}”, so it will not share it.`, 409)
    const granted: RemoteGrantedProject[] = chosen.map(project => ({ projectId: project.id, identity: project.identity }))
    const peer: RemotePeerRecord = {
      id: randomUUID(),
      machineId: request.machineId,
      machineName: request.machineName,
      accountId: request.accountId,
      accountLogin: request.accountLogin,
      keyFingerprint: request.keyFingerprint,
      publicKey: request.publicKey,
      grantedProjects: granted,
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
    if (!this.settings.enabled) throw new RemoteAccessError('Remote control is switched off on this machine.', 503)
    if (this.deps.accountId() === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401)
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
    if (!this.settings.enabled) throw new RemoteAccessError('Remote control is switched off on this machine.', 503)
    const accountId = this.deps.accountId()
    if (accountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401)
    const peer = this.peers.find(entry => entry.keyFingerprint === keyFingerprint && !entry.revokedAt && entry.accountId === accountId)
    if (peer) return { status: 'approved', peer: { ...peer } }
    return { status: this.listPending().some(entry => entry.keyFingerprint === keyFingerprint) ? 'pending' : 'denied' }
  }

  revoke(peerId: string): void {
    const peer = this.peers.find(entry => entry.id === peerId)
    if (!peer) return
    this.authorityRevision++
    peer.revokedAt = new Date(this.now()).toISOString()
    this.persist()
    this.record(peer, 'peer.revoke', null, `Revoked ${peer.machineName}`, 'denied')
  }

  forget(peerId: string): void {
    const peers = this.peers.filter(entry => entry.id !== peerId)
    if (peers.length === this.peers.length) return
    this.authorityRevision++
    this.peers = peers
    this.persist()
  }

  /** Signing out of GitHub takes every peer with it; nothing survives the identity it was tied to. */
  revokeAll(reason = 'Signed out of GitHub'): void {
    this.authorityRevision++
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
    const authorityRevision = this.authorityRevision
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
    // Never return the object captured before the GitHub request. Every owner-controlled source of
    // authority is mutable while that await is in flight, and revocation must take effect before
    // the remote method is dispatched.
    if (authorityRevision !== this.authorityRevision || !this.settings.enabled) {
      throw new RemoteAccessError('Remote access changed while GitHub was confirming this request.', 403, 'peer-revoked')
    }
    const currentAccountId = this.deps.accountId()
    if (currentAccountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401, 'peer-revoked')
    if (currentAccountId !== accountId) throw new RemoteAccessError('That peer was paired with a different GitHub account.', 403, 'peer-revoked')
    const currentPeer = this.peers.find(entry => entry.id === input.peerId)
    if (!currentPeer) throw new RemoteAccessError('This machine does not know that peer.', 401, 'peer-revoked')
    if (currentPeer.revokedAt) throw new RemoteAccessError('Access for this machine was revoked.', 403, 'peer-revoked')
    if (currentPeer.accountId !== currentAccountId || currentPeer.publicKey !== peer.publicKey) {
      throw new RemoteAccessError('That peer no longer belongs to this GitHub account.', 403, 'peer-revoked')
    }
    currentPeer.lastSeenAt = new Date(this.now()).toISOString()
    this.persist()
    return {
      peer: { ...currentPeer, grantedProjects: currentPeer.grantedProjects.map(granted => ({ ...granted })) },
      grantedProjects: currentPeer.grantedProjects.map(granted => ({ ...granted }))
    }
  }

  /** The fingerprint of the certificate currently being served; set by the server each time it binds. */
  private currentFingerprint = ''
  setFingerprint(fingerprint: string): void { this.currentFingerprint = fingerprint }

  /**
   * Remote calls may only name a project that is registered here, granted to that peer, and still
   * the working copy the owner approved. The last part is what stops a peer from being handed a
   * different repository because the folder behind a shared project id was swapped or moved since.
   */
  requireProject(peer: RemotePeerRecord, projectId: unknown): RemoteProjectSummary {
    if (typeof projectId !== 'string' || !projectId) throw new RemoteAccessError('Name a project for this request.', 400)
    const granted = peer.grantedProjects.find(entry => entry.projectId === projectId)
    if (!granted) throw new RemoteAccessError('That project was not shared with this machine.', 403)
    const project = this.deps.projects().find(entry => entry.id === projectId)
    if (!project) throw new RemoteAccessError('That project is no longer registered on this machine.', 404)
    // A pairing approved before identities existed has nothing recorded to compare against. It
    // keeps the access it already had; recording what it happens to find now would be this machine
    // approving a working copy on the owner's behalf.
    if (!granted.identity) return project
    if (!project.identity) throw new RemoteAccessError(project.identityError || 'This machine cannot read that project identity, so it will not act on it.', 409)
    if (!sameWorkingCopy(project.identity, granted.identity)) {
      throw new RemoteAccessError('That project folder now holds a different working copy than the one shared with this machine. Share it again from this machine first.', 409)
    }
    if (!samePath(project.identity.path, granted.identity.path)) {
      throw new RemoteAccessError(`That project moved from ${granted.identity.path} to ${project.identity.path} since it was shared. Confirm the new location on this machine first.`, 409)
    }
    return project
  }

  /**
   * Re-resolves an authenticated snapshot against owner-controlled state. Host operations call
   * this after every filesystem await so disable, sign-out, revoke, forget or grant changes win.
   */
  requireCurrentProject(peer: RemotePeerRecord, projectId: unknown, expectedRevision?: number): RemoteProjectSummary {
    if (expectedRevision !== undefined && expectedRevision !== this.authorityRevision) {
      throw new RemoteAccessError('Remote access changed while this request was pending.', 403, 'peer-revoked')
    }
    if (!this.settings.enabled) throw new RemoteAccessError('Remote control is switched off on this machine.', 503, 'peer-revoked')
    const accountId = this.deps.accountId()
    if (accountId === null) throw new RemoteAccessError('This machine is not signed in to GitHub.', 401, 'peer-revoked')
    const current = this.peers.find(entry => entry.id === peer.id)
    if (!current || current.revokedAt || current.accountId !== accountId || current.publicKey !== peer.publicKey) {
      throw new RemoteAccessError('Remote access changed while this request was pending.', 403, 'peer-revoked')
    }
    if (typeof projectId !== 'string' || !projectId) throw new RemoteAccessError('Name a project for this request.', 400)
    const captured = peer.grantedProjects.find(entry => entry.projectId === projectId)
    const granted = current.grantedProjects.find(entry => entry.projectId === projectId)
    const capturedIdentity = captured?.identity
    const currentIdentity = granted?.identity
    if (!captured || !granted
      || Boolean(capturedIdentity) !== Boolean(currentIdentity)
      || capturedIdentity && currentIdentity && (!sameWorkingCopy(capturedIdentity, currentIdentity) || !samePath(capturedIdentity.path, currentIdentity.path))) {
      throw new RemoteAccessError('The project grant changed while this request was pending.', 403)
    }
    return this.requireProject(current, projectId)
  }

  /** Reauthorizes a persisted remote-origin prompt at the instant it reaches a provider. */
  requirePromptAuthority(peerId: unknown, projectId: unknown): RemoteProjectSummary {
    if (typeof peerId !== 'string' || !peerId || peerId.length > 160) {
      throw new RemoteAccessError('Remote prompt authority has no valid peer.', 403, 'peer-revoked')
    }
    const peer = this.peers.find(entry => entry.id === peerId)
    if (!peer) throw new RemoteAccessError('The remote peer that queued this prompt is no longer paired.', 403, 'peer-revoked')
    return this.requireCurrentProject(peer, projectId)
  }

  captureProjectAuthority(peer: RemotePeerRecord, projectId: unknown): { project: RemoteProjectSummary; revision: number } {
    const revision = this.authorityRevision
    return { project: this.requireCurrentProject(peer, projectId, revision), revision }
  }

  /**
   * The projects this peer may name, as this machine sees them now. A project whose folder no
   * longer matches what was approved is still listed, carrying the reason it will be refused, so
   * the other machine can tell the owner what happened instead of the project silently vanishing.
   */
  sharedProjects(peer: RemotePeerRecord): RemoteProjectSummary[] {
    const registered = this.deps.projects()
    // Answering a peer must not depend on the shape of a stored record being well formed.
    return (Array.isArray(peer.grantedProjects) ? peer.grantedProjects : []).flatMap(granted => {
      const project = registered.find(entry => entry.id === granted.projectId)
      if (!project) return []
      try { this.requireProject(peer, granted.projectId); return [project] }
      catch (error) { return [{ ...project, identityError: error instanceof Error ? error.message : String(error) }] }
    })
  }

  /**
   * The owner confirming, on this machine, that a shared project's new location is the same
   * project. Only a move is confirmable: a folder that now holds a different working copy has to
   * go through pairing again rather than inherit an approval given to something else.
   */
  reshareProject(peerId: string, projectId: string): RemotePeerRecord {
    const peer = this.peers.find(entry => entry.id === peerId)
    if (!peer) throw new RemoteAccessError('This machine does not know that peer.', 404)
    if (peer.revokedAt) throw new RemoteAccessError('Access for this machine was revoked.', 403)
    const granted = peer.grantedProjects.find(entry => entry.projectId === projectId)
    if (!granted) throw new RemoteAccessError('That project was not shared with this machine.', 403)
    const project = this.deps.projects().find(entry => entry.id === projectId)
    if (!project?.identity) throw new RemoteAccessError(project?.identityError || 'That project is no longer registered on this machine.', 404)
    if (granted.identity && !sameWorkingCopy(project.identity, granted.identity)) {
      throw new RemoteAccessError('That folder holds a different working copy than the one shared, so it cannot be confirmed as a move. Pair the project again.', 409)
    }
    this.authorityRevision++
    granted.identity = project.identity
    this.persist()
    this.record(peer, 'peer.reshare', projectId, `Confirmed the new location of ${project.name} for ${peer.machineName}`, 'allowed')
    return { ...peer, grantedProjects: peer.grantedProjects.map(entry => ({ ...entry })) }
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
