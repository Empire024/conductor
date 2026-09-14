/** Identity, pairing and machine-placement contracts shared by main, preload and renderer. */

import type { ProjectIdentity, RemoteProjectGrant } from './project-identity'
import { isProjectKey } from './project-identity'

export type { ProjectIdentity, RemoteProjectGrant }

export interface GitHubIdentity {
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

/** What the owner has to type into github.com/login/device to finish the device flow. */
export interface GitHubDevicePrompt {
  userCode: string
  verificationUri: string
  expiresAt: string
  interval: number
}

export type GitHubAuthPhase = 'signed-out' | 'awaiting-authorization' | 'signed-in'

export interface GitHubAuthState {
  phase: GitHubAuthPhase
  identity: GitHubIdentity | null
  prompt: GitHubDevicePrompt | null
  /** OpenSSH SHA256 fingerprint of this machine's device key, registered on the account. */
  deviceKeyFingerprint: string | null
  /** False when the OS credential store is unavailable; sign-in refuses rather than storing plaintext. */
  secureStorageAvailable: boolean
  clientIdConfigured: boolean
  message: string | null
}

export type RemoteExposure = 'loopback' | 'network'

export interface RemoteControlSettings {
  enabled: boolean
  /** Loopback by default. 'network' is the deliberate, labelled choice to leave this machine. */
  exposure: RemoteExposure
  /** 0 asks the OS for a free port; a fixed port keeps paired machines reachable after a restart. */
  port: number
  machineName: string
  /**
   * Reach machines that are not on this network, through an encrypted mailbox in a private gist on
   * the owner's own GitHub account. No address is published and nothing is opened for inbound
   * connections; the direct route is still preferred whenever it works.
   */
  relay: boolean
  /**
   * The address of a relay the owner runs themselves, which replaces the gist mailbox entirely when
   * it is set. The gist route was only ever a way to need no server; it is also a way to live inside
   * an API budget that one unreachable machine can spend on its own, so an owner who runs a relay
   * should never be put back on it silently. Empty means "use the gist mailbox".
   */
  relayEndpoint: string
  /**
   * Other addresses the same relay answers on, tried in turn when the first one cannot be reached.
   * A relay at home has a public address and a local one, and which of them works depends on where
   * the machine reading this happens to be.
   */
  relayEndpointAlternates: string[]
  /** SHA-256 of the certificate that relay serves, pinned exactly as the direct listener's is. */
  relayFingerprint: string
  /** Run the relay on this machine, so linking needs no server and no terminal. */
  relayHosting: boolean
  relayHostPort: number
  /** Ask the router to forward that port, which is what makes the link work off this network. */
  relayHostInternet: boolean
}

/** What the relay running on this machine is doing, in the terms the owner set it up in. */
export interface RelayHostStatus {
  running: boolean
  port: number | null
  fingerprint: string | null
  /** Addresses on this network another machine can use, best first. */
  addresses: string[]
  /**
   * Whether this relay can be reached from outside the network it is on. Two computers behind two
   * routers have no route to each other, so this is the difference between linking machines in one
   * building and linking them anywhere - and when it cannot be done, the reason is what the owner
   * needs, not the fact.
   */
  internet: { state: 'off' | 'opening' | 'open' | 'failed'; address: string | null; message: string | null }
  message: string | null
}

export interface RemoteGrant {
  label: string
  detail: string
}

/**
 * One project this machine shares with a peer, with the working copy the owner approved. A peer's
 * call names this machine's own project id, so the id is what scopes it; the identity is what
 * proves the folder still holds the copy that was approved rather than one swapped in since.
 */
export interface RemoteGrantedProject {
  projectId: string
  /** Null only for a pairing approved before projects carried an identity. */
  identity: ProjectIdentity | null
}

export interface RemotePeerRecord {
  id: string
  machineId: string
  machineName: string
  accountId: number
  accountLogin: string
  keyFingerprint: string
  publicKey: string
  grantedProjects: RemoteGrantedProject[]
  approvedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

export interface PendingPairingRequest {
  id: string
  machineId: string
  machineName: string
  accountId: number
  accountLogin: string
  keyFingerprint: string
  publicKey: string
  requestedAt: string
  expiresAt: string
  grants: RemoteGrant[]
}

export interface RemoteActivityEntry {
  id: string
  peerId: string
  machineName: string
  accountLogin: string
  method: string
  projectId: string | null
  detail: string
  at: string
  outcome: 'allowed' | 'denied'
  message?: string
}

/** Everything the controlling machine needs to reach this one, including the cert to pin. */
export interface RemotePairingTicket {
  version: 1
  machineId: string
  machineName: string
  accountLogin: string
  host: string
  port: number
  fingerprint: string
  code: string
  expiresAt: string
  /**
   * Base64 X25519 public key for the encrypted relay. It travels with the certificate fingerprint
   * for the same reason: the owner carries both out of band, so the first contact pins a key
   * rather than trusting whatever the account's gists happen to advertise.
   */
  relayKey?: string
  /** The device key that signs this machine's relay directory entry. */
  deviceKey?: string
  /**
   * The relay this machine uses and the room secret for it, so pairing carries the whole route.
   *
   * The owner already carries this code between their own two machines through a channel they
   * trust, which is exactly the channel a shared secret needs. Making them paste the address and
   * the secret separately on the second machine would add a step whose only effect is a chance to
   * get it wrong. A machine that already has a relay of its own keeps it.
   */
  relayEndpoint?: string
  /** The same relay's other addresses, so the machine being paired can use the one that works. */
  relayEndpointAlternates?: string[]
  relaySecret?: string
  /** The relay's certificate fingerprint, so the machine being paired pins it rather than trusting
   *  whatever answers that address. A relay on a home machine has no certificate authority behind
   *  it, and does not need one when the owner carries the fingerprint across by hand. */
  relayFingerprint?: string
}

/** What a machine advertises about a project it shares, including who that working copy is. */
export interface RemoteProjectSummary {
  id: string
  name: string
  path: string
  identity: ProjectIdentity | null
  /** Why the identity could not be read; the project is never given a new one to paper over this. */
  identityError: string | null
}

export interface RemoteConnection {
  machineId: string
  machineName: string
  accountLogin: string
  host: string
  port: number
  fingerprint: string
  peerId: string
  /** Pinned at pairing: what the relay seals to, and the key whose signature vouches for it. */
  relayKey?: string
  deviceKey?: string
  /** Which route last carried a call to this machine, so the owner can see how it is reached. */
  transport?: 'direct' | 'relay'
  /** Project pairs the owner confirmed for this machine; the only way work reaches it. */
  projectGrants: RemoteProjectGrant[]
  /** What that machine last said it shares, so a swapped or moved project is noticed here. */
  remoteProjects: RemoteProjectSummary[]
  remoteProjectsAt: string | null
  /**
   * Shared project ids carried over from a pairing made before identities existed. The pairing is
   * kept, but each still needs one confirmation, because no identity was ever recorded for it.
   */
  unconfirmedRemoteProjectIds: string[]
  connectedAt: string
  lastContactAt: string | null
  status: 'pending' | 'connected' | 'unreachable' | 'revoked'
  message: string | null
}

export interface RemoteControlState {
  machineId: string
  settings: RemoteControlSettings
  listening: boolean
  /** Present only while listening; the https origin peers dial. */
  endpoint: string | null
  fingerprint: string | null
  message: string | null
  /** The encrypted off-network route: whether it is on, and which machines it can currently see. */
  relay: import('./remote-relay').RelayStatus
  /** Whether a room secret for the owner's own relay is held here. The secret itself never leaves
   *  the credential store, so the renderer is told that it exists and nothing more. */
  relaySecretSet: boolean
  /** The relay this machine runs itself, if it runs one. */
  relayHost: RelayHostStatus
  projects: RemoteProjectSummary[]
  peers: RemotePeerRecord[]
  pending: PendingPairingRequest[]
  activity: RemoteActivityEntry[]
  connections: RemoteConnection[]
}

export const LOCAL_MACHINE_ID = 'local'

export type MachineStatus = 'online' | 'offline' | 'revoked'

/** A confirmed project pair, next to what that machine says about it now. */
export interface MachineProjectLink {
  grant: RemoteProjectGrant
  /** The identity that machine last advertised for the granted project; null when it stopped. */
  observed: ProjectIdentity | null
}

export interface MachineDescriptor {
  id: string
  name: string
  kind: 'local' | 'peer'
  status: MachineStatus
  accountLogin: string | null
  /** Confirmed project pairs; empty for the local machine, which runs all of its own projects. */
  projects: MachineProjectLink[]
}

export interface RemoteControlBridge {
  /** Remote-only file operations. Keeping them nested prevents accidental local-disk fallback. */
  files: import('./remote-files').RemoteFilesBridge & import('./remote-files').RemoteFileResourceBridge
  githubState(): Promise<GitHubAuthState>
  signIn(): Promise<GitHubAuthState>
  cancelSignIn(): Promise<GitHubAuthState>
  signOut(): Promise<GitHubAuthState>
  onGitHubState(callback: (state: GitHubAuthState) => void): () => void
  state(): Promise<RemoteControlState>
  setSettings(patch: Partial<RemoteControlSettings>): Promise<RemoteControlState>
  /**
   * Points this machine at a relay of the owner's own. Passing null for the secret leaves the one
   * already stored alone; passing an empty string clears it, which puts the machine back on the
   * gist mailbox. The secret is write-only from here: nothing ever reads it back out.
   */
  setRelayServer(endpoint: string, secret: string | null): Promise<RemoteControlState>
  /** Starts, stops or reconfigures the relay this machine runs for itself and its other machines. */
  setRelayHosting(patch: { enabled?: boolean; port?: number; internet?: boolean }): Promise<RemoteControlState>
  createTicket(): Promise<{ ticket: RemotePairingTicket; encoded: string }>
  approve(pendingId: string, grantedProjectIds: string[]): Promise<RemoteControlState>
  /** Re-approves a shared project whose folder moved, after the owner has seen both paths. */
  reshareProject(peerId: string, projectId: string): Promise<RemoteControlState>
  deny(pendingId: string): Promise<RemoteControlState>
  revoke(peerId: string): Promise<RemoteControlState>
  connect(ticket: string): Promise<RemoteControlState>
  forget(machineId: string): Promise<RemoteControlState>
  /** Asks a paired machine which projects it shares, so the owner can confirm a pair. */
  remoteProjects(machineId: string): Promise<RemoteProjectSummary[]>
  /** Records that this project here is that project there. Nothing is placed remotely without it. */
  confirmProject(machineId: string, localProjectId: string, remoteProjectId: string): Promise<RemoteControlState>
  releaseProject(machineId: string, localProjectId: string): Promise<RemoteControlState>
  machines(): Promise<MachineDescriptor[]>
  /**
   * Probes every paired machine and returns what is reachable now. A machine's status is otherwise
   * only a side effect of real work, so one failed call leaves it looking offline indefinitely.
   */
  refreshMachines(): Promise<MachineDescriptor[]>
  /**
   * Places a new conversation on a paired machine and mirrors it into a local tab. The returned
   * session id is the local one the tab binds to; the remote machine's own ids stay private to it.
   */
  openTab(request: RemoteTabRequest): Promise<{ localSessionId: string; machineId: string; machineName: string }>
  /**
   * Closes a placed tab on the machine that runs it and stops mirroring it here. `message` says
   * why the other machine could not be told; the tab is closed here regardless.
   */
  closeTab(localSessionId: string): Promise<{ closed: boolean; message?: string }>
  /** Durable execution owner for a mirrored session, including released/offline tombstones. */
  sessionMachine(localSessionId: string): Promise<string>
  /** Machine and workspace root used to resolve file links for this conversation. */
  sessionFileContext(localSessionId: string): Promise<{ machineId: string; cwd: string | null }>
  onState(callback: (state: RemoteControlState) => void): () => void
}

export interface RemoteTabRequest {
  machineId: string
  projectId: string
  sessionId: string
  provider?: string
  model?: string
  effort?: string
  title?: string
}

export const DEFAULT_REMOTE_PORT = 51840
/** The relay's default port when Conductor runs one itself. */
export const DEFAULT_RELAY_PORT = 8787

export function normalizeRemoteSettings(stored: unknown): RemoteControlSettings {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const port = Number(value.port)
  const port2 = Number(value.relayHostPort)
  const machineName = typeof value.machineName === 'string' ? value.machineName.trim().slice(0, 60) : ''
  return {
    enabled: value.enabled === true,
    exposure: value.exposure === 'network' ? 'network' : 'loopback',
    port: port === 0 || Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_REMOTE_PORT,
    machineName: machineName || 'This machine',
    // On by default: it publishes no address and opens no port, and without it a machine that moved
    // off this network simply stops answering. Settings written before it existed still get it.
    relay: value.relay !== false,
    relayEndpoint: typeof value.relayEndpoint === 'string' ? value.relayEndpoint.trim().slice(0, 300) : '',
    relayEndpointAlternates: Array.isArray(value.relayEndpointAlternates)
      ? value.relayEndpointAlternates.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 300).slice(0, 8)
      : [],
    relayFingerprint: typeof value.relayFingerprint === 'string' ? value.relayFingerprint.trim().slice(0, 200) : '',
    relayHosting: value.relayHosting === true,
    relayHostPort: Number.isInteger(port2) && port2 >= 1024 && port2 <= 65535 ? port2 : DEFAULT_RELAY_PORT,
    relayHostInternet: value.relayHostInternet === true
  }
}

export function encodeTicket(ticket: RemotePairingTicket): string {
  return Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A stored identity is only usable whole; a partial one is not an identity and never matches. */
export function readStoredIdentity(value: unknown): ProjectIdentity | null {
  if (!isRecord(value)) return null
  const { key, keyCreatedAt, path, name } = value as Partial<ProjectIdentity>
  if (!isProjectKey(key) || typeof keyCreatedAt !== 'string' || !Number.isFinite(Date.parse(keyCreatedAt))) return null
  if (typeof path !== 'string' || !path) return null
  return { key, keyCreatedAt, path, name: typeof name === 'string' ? name : '' }
}

/**
 * Reads the projects shared with a peer, including pairings stored before identities existed.
 * Those keep working exactly as they did — the pairing is not dropped — but they carry no recorded
 * identity, so nothing pretends the owner ever confirmed one.
 */
export function readGrantedProjects(stored: unknown): RemoteGrantedProject[] {
  const record = isRecord(stored) ? stored : {}
  if (Array.isArray(record.grantedProjects)) {
    return record.grantedProjects.flatMap(entry => {
      if (typeof entry === 'string') return entry ? [{ projectId: entry, identity: null }] : []
      if (!isRecord(entry) || typeof entry.projectId !== 'string' || !entry.projectId) return []
      return [{ projectId: entry.projectId, identity: readStoredIdentity(entry.identity) }]
    })
  }
  if (Array.isArray(record.grantedProjectIds)) {
    return record.grantedProjectIds.filter((id): id is string => typeof id === 'string' && Boolean(id)).map(projectId => ({ projectId, identity: null }))
  }
  return []
}

/** Only a whole mapping is a mapping; half of one would be a guess about what the owner confirmed. */
export function readProjectGrants(value: unknown): RemoteProjectGrant[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (!isRecord(entry)) return []
    const local = readStoredIdentity(entry.local)
    const remote = readStoredIdentity(entry.remote)
    if (!local || !remote) return []
    if (typeof entry.localProjectId !== 'string' || !entry.localProjectId) return []
    if (typeof entry.remoteProjectId !== 'string' || !entry.remoteProjectId) return []
    return [{
      localProjectId: entry.localProjectId,
      local,
      remoteProjectId: entry.remoteProjectId,
      remote,
      confirmedAt: typeof entry.confirmedAt === 'string' ? entry.confirmedAt : new Date(0).toISOString()
    }]
  })
}

/** Everything here came off the wire from the other machine, so every field is bounded. */
export function readRemoteProjectSummaries(value: unknown): RemoteProjectSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) return []
    const identity = readStoredIdentity(entry.identity)
    return [{
      id: entry.id.slice(0, 160),
      name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : '',
      path: typeof entry.path === 'string' ? entry.path.slice(0, 4000) : identity?.path ?? '',
      identity,
      identityError: typeof entry.identityError === 'string' ? entry.identityError.slice(0, 400) : null
    }]
  }).slice(0, 200)
}

export function decodeTicket(encoded: string): RemotePairingTicket {
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(encoded.trim(), 'base64url').toString('utf8')) }
  catch { throw new Error('That pairing code is not readable. Copy the whole code from the other machine.') }
  const ticket = parsed as Partial<RemotePairingTicket>
  const required: Array<keyof RemotePairingTicket> = ['machineId', 'machineName', 'accountLogin', 'host', 'fingerprint', 'code', 'expiresAt']
  const optionalKeys: Array<'relayKey' | 'deviceKey' | 'relayEndpoint' | 'relaySecret' | 'relayFingerprint'> =
    ['relayKey', 'deviceKey', 'relayEndpoint', 'relaySecret', 'relayFingerprint']
  if (ticket.relayEndpointAlternates !== undefined &&
      (!Array.isArray(ticket.relayEndpointAlternates) || ticket.relayEndpointAlternates.some(entry => typeof entry !== 'string'))) {
    throw new Error('That pairing code is incomplete or from an incompatible version.')
  }
  if (optionalKeys.some(key => ticket[key] !== undefined && typeof ticket[key] !== 'string')) {
    throw new Error('That pairing code is incomplete or from an incompatible version.')
  }
  if (ticket?.version !== 1 || required.some(key => typeof ticket[key] !== 'string' || !String(ticket[key]).trim()) || !Number.isInteger(ticket.port)) {
    throw new Error('That pairing code is incomplete or from an incompatible version.')
  }
  return ticket as RemotePairingTicket
}
