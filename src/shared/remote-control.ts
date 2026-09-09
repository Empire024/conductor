/** Identity, pairing and machine-placement contracts shared by main, preload and renderer. */

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
}

export interface RemoteGrant {
  label: string
  detail: string
}

export interface RemotePeerRecord {
  id: string
  machineId: string
  machineName: string
  accountId: number
  accountLogin: string
  keyFingerprint: string
  publicKey: string
  grantedProjectIds: string[]
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
}

export interface RemoteProjectSummary {
  id: string
  name: string
  path: string
}

export interface RemoteConnection {
  machineId: string
  machineName: string
  accountLogin: string
  host: string
  port: number
  fingerprint: string
  peerId: string
  grantedProjectIds: string[]
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
  projects: RemoteProjectSummary[]
  peers: RemotePeerRecord[]
  pending: PendingPairingRequest[]
  activity: RemoteActivityEntry[]
  connections: RemoteConnection[]
}

export const LOCAL_MACHINE_ID = 'local'

export type MachineStatus = 'online' | 'offline' | 'revoked'

export interface MachineDescriptor {
  id: string
  name: string
  kind: 'local' | 'peer'
  status: MachineStatus
  accountLogin: string | null
  /** Projects this machine will accept work in; empty for the local machine, which accepts all. */
  grantedProjectIds: string[]
}

export interface RemoteControlBridge {
  githubState(): Promise<GitHubAuthState>
  signIn(): Promise<GitHubAuthState>
  cancelSignIn(): Promise<GitHubAuthState>
  signOut(): Promise<GitHubAuthState>
  onGitHubState(callback: (state: GitHubAuthState) => void): () => void
  state(): Promise<RemoteControlState>
  setSettings(patch: Partial<RemoteControlSettings>): Promise<RemoteControlState>
  createTicket(): Promise<{ ticket: RemotePairingTicket; encoded: string }>
  approve(pendingId: string, grantedProjectIds: string[]): Promise<RemoteControlState>
  deny(pendingId: string): Promise<RemoteControlState>
  revoke(peerId: string): Promise<RemoteControlState>
  connect(ticket: string): Promise<RemoteControlState>
  forget(machineId: string): Promise<RemoteControlState>
  machines(): Promise<MachineDescriptor[]>
  onState(callback: (state: RemoteControlState) => void): () => void
}

export const DEFAULT_REMOTE_PORT = 51840

export function normalizeRemoteSettings(stored: unknown): RemoteControlSettings {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const port = Number(value.port)
  const machineName = typeof value.machineName === 'string' ? value.machineName.trim().slice(0, 60) : ''
  return {
    enabled: value.enabled === true,
    exposure: value.exposure === 'network' ? 'network' : 'loopback',
    port: port === 0 || Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_REMOTE_PORT,
    machineName: machineName || 'This machine'
  }
}

export function encodeTicket(ticket: RemotePairingTicket): string {
  return Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')
}

export function decodeTicket(encoded: string): RemotePairingTicket {
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(encoded.trim(), 'base64url').toString('utf8')) }
  catch { throw new Error('That pairing code is not readable. Copy the whole code from the other machine.') }
  const ticket = parsed as Partial<RemotePairingTicket>
  const required: Array<keyof RemotePairingTicket> = ['machineId', 'machineName', 'accountLogin', 'host', 'fingerprint', 'code', 'expiresAt']
  if (ticket?.version !== 1 || required.some(key => typeof ticket[key] !== 'string' || !String(ticket[key]).trim()) || !Number.isInteger(ticket.port)) {
    throw new Error('That pairing code is incomplete or from an incompatible version.')
  }
  return ticket as RemotePairingTicket
}
