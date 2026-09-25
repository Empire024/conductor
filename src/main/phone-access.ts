import { isConversationActivity } from '../shared/conversation-activity'
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto'
import type { AgentControlUiRequest } from '../shared/agent-control'
import { makeId, type AgentProviderInfo, type AgentSpec, type DetachedWindowRecord, type LayoutNode, type PaneTab, type ProjectRecord, type RuntimeEnsureResult, type RuntimeProcessSummary, type SessionRecord } from '../shared/models'
import type { MachineDescriptor } from '../shared/remote-control'
import { LOCAL_MACHINE_ID } from '../shared/remote-control'
import { PROJECT_TASK_MAX_LENGTH, projectTaskKinds, projectTaskPriorities, projectTaskWeights, type ProjectTaskKind, type ProjectTaskPriority, type ProjectTaskWeight } from '../shared/project-backlog'
import type { ContextAttachment, InteractionResponse, PromptOrigin, SessionProjection, SessionSettings, StructuredProvider, TimelineItem } from '../shared/structured-agent'
import { settingsForRuntime } from '../shared/structured-agent'
import type { SystemMetricsSnapshot } from '../shared/system-metrics'
import { normalizeUsageWindows, summarizeUsage, updatedSequence, usageWindowAppliesToModel, type UsageWindow } from '../shared/usage-accounting'
import {
  DEFAULT_PHONE_NOTIFICATION_PREFS, DEFAULT_PHONE_SETTINGS, PHONE_PAIRING_TTL_MS, PHONE_STATE_LIMITS,
  type PhoneAccessSettings, type PhoneAccessState, type PhoneConversation, type PhoneDevice, type PhoneMessageMode, type PhoneMetrics,
  type PhoneNotification, type PhoneNotificationPrefs, type PhoneOpenTabRequest, type PhoneOpenTabResult, type PhonePairingOffer, type PhoneProjectTaskPage, type PhoneProjectTaskRequest, type PhoneProjectTaskResult, type PhonePushSubscription,
  type PhoneSelf, type PhoneSessionSummary, type PhoneState, type PhoneTailnetView, type PhoneTimelineItem, type PhoneUsageWindow
} from '../shared/phone-access'
import { rememberedPermission } from './app-settings'
import type { AgentActivityRow } from './project-activity'
import { tabMachineId } from './machines'
import { AttentionGate } from './attention-log'
import { autoModeDenials, describeDenialMoments, describeTransition, lastMessage, pendingInteraction, phoneSessionState, previewText, type PhoneActivity } from './phone-notifications'
import { createCertificateAuthority, issueServerCertificate, tlsIdentityUsable, type CertificateAuthority } from './remote-tls'
import type { SecretKeyValueStore, SecretVault } from './secret-store'
import { generateVapidKeys, isValidVapidKeys, sendWebPush, type VapidKeys } from './web-push'
import { PhoneLock } from './phone-lock'
import type { WeeklyModelUsageReport } from '../shared/weekly-model-usage'

const SETTINGS_KEY = 'phone-access.settings'
const DEVICES_KEY = 'phone-access.devices'
const CA_CERT_KEY = 'phone-access.tls.ca.certificate'
const CA_EXPIRY_KEY = 'phone-access.tls.ca.notAfter'
const CA_PRIVATE_KEY = 'phone-access.tls.ca.key'
const LEAF_CERT_KEY = 'phone-access.tls.leaf.certificate'
const LEAF_EXPIRY_KEY = 'phone-access.tls.leaf.notAfter'
const LEAF_HOSTS_KEY = 'phone-access.tls.leaf.hosts'
const LEAF_PRIVATE_KEY = 'phone-access.tls.leaf.key'
const VAPID_PUBLIC_KEY = 'phone-access.push.publicKey'
const VAPID_PRIVATE_KEY = 'phone-access.push.privateKey'

/** No 0/O, 1/I or similar: the owner reads this off one screen and types it on another. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_DEVICES = 20
/** Failed pairing attempts one address may make before it is ignored for a while. */
const PAIR_FAILURE_LIMIT = 5
const PAIR_LOCKOUT_MS = 10 * 60 * 1000
/** How often the phone list's "last seen" is written back; every request would be a write per tap. */
const SEEN_WRITE_INTERVAL_MS = 30_000
const REFRESH_DEBOUNCE_MS = 400

export class PhoneAccessError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

interface StoredDevice {
  id: string
  name: string
  tokenHash: string
  createdAt: string
  lastSeenAt: string | null
  userAgent: string
  subscription: PhonePushSubscription | null
  pushFailures: number
  notificationPrefs?: PhoneNotificationPrefs
}

/** The slice of the database this feature reads; narrow so a test can hand in plain objects. */
export interface PhoneDatabase {
  listProjects(): ProjectRecord[]
  getProject(id: string): ProjectRecord | null
  listSessions(projectId: string): SessionRecord[]
  listDetachedWindows(): DetachedWindowRecord[]
  listProcesses(): RuntimeProcessSummary[]
  listAgentActivity(): AgentActivityRow[]
  structured: {
    snapshot(id: string): SessionProjection | null
    spec<T>(id: string): T | null
    history(projectId: string): Array<{ id: string; title: string; provider: StructuredProvider; archived: boolean; phase: SessionProjection['phase'] }>
    update(id: string, values: Partial<Pick<SessionProjection, 'title' | 'archived' | 'settings'>>): void
  }
}

export interface PhoneSessions {
  ensure(spec: AgentSpec): RuntimeEnsureResult
  connectSession(id: string): Promise<void>
  submit(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[], origin?: PromptOrigin): Promise<void>
  steer(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[], origin?: PromptOrigin): Promise<void>
  queue(id: string, text: string, settings: SessionSettings, attachments?: ContextAttachment[], origin?: PromptOrigin): Promise<void>
  respond(response: InteractionResponse): Promise<void>
  interrupt(id: string, expediteSubmittedInput?: boolean): Promise<void>
  resume(id: string, settings?: SessionSettings): Promise<void>
}

/** Conversations mirrored from a paired machine take the same actions through that machine. */
export interface PhoneRemoteSessions {
  isRemote(localSessionId: string): boolean
  openTab(request: { machineId: string; projectId: string; sessionId: string; provider?: string; model?: string; effort?: string; title?: string }): Promise<{ localSessionId: string; machineId: string; machineName: string }>
  connect(localSessionId: string): Promise<void>
  submit(localSessionId: string, prompt: string, method: 'agents.submit' | 'agents.steer', settings?: SessionSettings): Promise<void>
  queue(localSessionId: string, prompt: string, settings: SessionSettings): Promise<void>
  respond(response: InteractionResponse): Promise<void>
  interrupt(localSessionId: string, expediteSubmittedInput?: boolean): Promise<void>
  resume(localSessionId: string, settings?: SessionSettings): Promise<void>
}

export interface PhoneProjectTasks {
  list(project: ProjectRecord, query: { offset: number; limit: number }): Promise<PhoneProjectTaskPage>
  create(project: ProjectRecord, input: { title: string; kind: ProjectTaskKind; priority: ProjectTaskPriority; weight: ProjectTaskWeight }): Promise<PhoneProjectTaskResult>
}

/** What the listener reports about itself, kept here so the desktop state is one object. */
export interface PhoneListenerStatus {
  listening: boolean
  endpoints: string[]
  message: string | null
  tailscaleCertificate: PhoneAccessState['tailscale']['certificate']
  tailscaleMessage: string | null
  tailscaleAddress: string | null
  tailscaleDnsName: string | null
  /** The rest of the tailnet reading the setup steps show; absent when Tailscale was never read. */
  tailnet?: PhoneTailnetDetail
}

/** What the listener learned about the tailnet beyond its own address: filled by the server. */
export type PhoneTailnetDetail = Pick<PhoneTailnetView, 'installed' | 'backendState' | 'loginName' | 'httpsEnabled' | 'phones' | 'checkedAt'>

const NO_TAILNET: PhoneTailnetDetail = { installed: false, backendState: null, loginName: null, httpsEnabled: null, phones: [], checkedAt: null }

/**
 * The origin a phone should keep. A tailnet origin answers at home and away as long as Tailscale
 * is on, so it wins whenever this machine has one; the MagicDNS name only once the publicly
 * trusted certificate serves it, because until then the name is the same self-signed chain as the
 * address with one more thing that can fail (MagicDNS on the phone).
 */
export function recommendEndpoint(status: Pick<PhoneListenerStatus, 'listening' | 'endpoints' | 'tailscaleAddress' | 'tailscaleDnsName' | 'tailscaleCertificate'>): string | null {
  if (!status.listening || !status.endpoints.length) return null
  const hostOf = (endpoint: string): string => { try { return new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { return '' } }
  const dnsName = (status.tailscaleDnsName ?? '').toLowerCase()
  if (status.tailscaleCertificate === 'active' && dnsName) {
    const named = status.endpoints.find(endpoint => hostOf(endpoint) === dnsName)
    if (named) return named
  }
  const address = (status.tailscaleAddress ?? '').toLowerCase()
  if (address) {
    const byAddress = status.endpoints.find(endpoint => hostOf(endpoint) === address)
    if (byAddress) return byAddress
  }
  return status.endpoints[0] ?? null
}

export interface PhoneAccessDependencies {
  store: SecretKeyValueStore
  vault: SecretVault
  database: PhoneDatabase
  sessions: PhoneSessions
  remote?: PhoneRemoteSessions
  projectTasks?: PhoneProjectTasks
  weeklyUsage?: { read(): WeeklyModelUsageReport }
  providers(): AgentProviderInfo[]
  machines(): MachineDescriptor[]
  machineName(): string
  version: string
  ui(request: AgentControlUiRequest): Promise<unknown>
  metrics(): Promise<SystemMetricsSnapshot>
  /** Injected for tests; defaults to the real sender over global fetch. */
  push?: typeof sendWebPush
  now?(): number
  /** The desktop panel's state changed (a phone paired, a code expired, a push failed). */
  changed?(): void
  log?(message: string, error?: unknown): void
  /** The app log's audit trail: lock lockouts, resets and code changes. Never a code. */
  audit?(line: string): void
}

/**
 * A phone's unlocked session ended. A null session means every session that phone had (it was
 * unpaired); a null device means every phone (a code was set or changed).
 */
export type PhoneLockedListener = (deviceId: string | null, unlockSessionId: string | null) => void

export interface PhoneStreamWriter { (event: string, data: unknown): void }

interface Stream { deviceId: string; write: PhoneStreamWriter }

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

const sameHash = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex'), b = Buffer.from(right, 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export const normalizePairingCode = (value: unknown): string => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export function normalizePhoneSettings(value: unknown): PhoneAccessSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const port = Number(raw.port)
  return {
    enabled: raw.enabled === true,
    exposure: raw.exposure === 'tailscale' ? 'tailscale' : 'network',
    // 0 lets the OS pick, as remote control allows; a QR code then names whatever it picked.
    port: Number.isInteger(port) && (port === 0 || port >= 1024) && port <= 65535 ? port : DEFAULT_PHONE_SETTINGS.port,
    notifications: raw.notifications !== false,
    tailscaleCertificate: raw.tailscaleCertificate === true
  }
}

/** Whether a device's stored preference covers this notification's category. A device with no
 *  preference recorded yet gets the defaults, same as `self()` reports before any choice is made. */
const wantsNotification = (prefs: PhoneNotificationPrefs | undefined, notification: PhoneNotification): boolean => {
  const chosen = prefs ?? DEFAULT_PHONE_NOTIFICATION_PREFS
  if (notification.kind === 'done') return notification.isCoworker ? chosen.coworkerDone : chosen.taskDone
  if (notification.kind === 'attention' || notification.kind === 'failed' || notification.kind === 'limited') return chosen.needsYou
  return true
}

const activeSessionPhases: ReadonlySet<SessionProjection['phase']> = new Set(['running', 'starting', 'waiting_approval', 'waiting_input', 'interrupting'])
const providerLabels: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', local: 'Local model' }

/**
 * Everything phone access knows and does, apart from the socket. The listener hands requests in
 * here already authenticated to a device; the desktop panel reaches the same object over IPC.
 */
export class PhoneAccessService {
  private settings: PhoneAccessSettings
  private devices: StoredDevice[]
  private pairing: (PhonePairingOffer & { normalized: string }) | null = null
  private pairFailures = new Map<string, { failures: number; until: number }>()
  private lastSeenWritten = new Map<string, number>()
  private streams = new Set<Stream>()
  private listener: PhoneListenerStatus = { listening: false, endpoints: [], message: null, tailscaleCertificate: 'off', tailscaleMessage: null, tailscaleAddress: null, tailscaleDnsName: null }
  /** The last state each conversation was seen in, which is what a transition is measured from. */
  private known = new Map<string, Pick<PhoneSessionSummary, 'state' | 'pendingId' | 'autoModeDenials'>>()
  /** The last refresh's summaries, for the attention gate's later look at a held moment. */
  private latest = new Map<string, PhoneSessionSummary>()
  /** "Needs you" waits out a grace period and goes out only if still blocked (attention-log.ts). */
  readonly attention: AttentionGate
  private seeded = false
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private touched = new Set<string>()
  private usageCache = new Map<string, { sequence: number; windows: UsageWindow[]; reportedAt: string; summary: PhoneSessionSummary['usage'] }>()
  private disposed = false
  private lockedListeners = new Set<PhoneLockedListener>()
  /** The 6-digit code in front of every phone API call (src/main/phone-lock.ts). */
  readonly lock: PhoneLock

  constructor(private readonly deps: PhoneAccessDependencies) {
    this.attention = new AttentionGate({
      view: id => {
        const summary = this.latest.get(id)
        return { open: Boolean(summary?.tabId), ...(summary ? { state: summary.state, ...(summary.pendingId ? { pendingId: summary.pendingId } : {}) } : {}), items: this.deps.database.structured.snapshot(id)?.items ?? [] }
      },
      send: notification => this.deliver(notification),
      store: deps.store,
      changed: () => this.deps.changed?.(),
      now: () => this.now()
    })
    this.settings = normalizePhoneSettings(parseJson(deps.store.getSetting(SETTINGS_KEY), {}))
    this.devices = parseJson<StoredDevice[]>(deps.store.getSetting(DEVICES_KEY), []).filter(device => device && typeof device.id === 'string' && typeof device.tokenHash === 'string')
    this.lock = new PhoneLock({
      store: deps.store, vault: deps.vault, now: () => this.now(),
      audit: line => this.audit(line),
      locked: (deviceId, sessionId) => { this.emitLocked(deviceId, sessionId); this.deps.changed?.() },
      everyPhone: () => { this.emitLocked(null, null); this.deps.changed?.() }
    })
  }

  audit(line: string): void { (this.deps.audit ?? ((text: string) => console.info(text)))(line) }

  /** Streams and terminals close through this when a phone locks or is unpaired. */
  onLocked(listener: PhoneLockedListener): () => void {
    this.lockedListeners.add(listener)
    return () => { this.lockedListeners.delete(listener) }
  }

  private emitLocked(deviceId: string | null, sessionId: string | null): void {
    for (const listener of [...this.lockedListeners]) {
      try { listener(deviceId, sessionId) } catch (error) { this.log('Phone lock listener failed', error) }
    }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private log(message: string, error?: unknown): void { (this.deps.log ?? ((text: string, reason?: unknown) => console.warn(text, reason ?? '')))(message, error) }

  /* ----------------------------------------------------------------------- *
   * Settings and the desktop's view
   * ----------------------------------------------------------------------- */

  getSettings(): PhoneAccessSettings { return { ...this.settings } }

  updateSettings(patch: Partial<PhoneAccessSettings>): PhoneAccessSettings {
    if (patch.port !== undefined && (!Number.isInteger(patch.port) || (patch.port !== 0 && patch.port < 1024) || patch.port > 65535)) throw new PhoneAccessError('Choose a port between 1024 and 65535.')
    this.settings = normalizePhoneSettings({ ...this.settings, ...patch })
    this.deps.store.setSetting(SETTINGS_KEY, JSON.stringify(this.settings))
    if (!this.settings.enabled) this.pairing = null
    this.deps.changed?.()
    return this.getSettings()
  }

  setListenerStatus(status: PhoneListenerStatus): void {
    this.listener = status
    // A code names the address it was made for; once the listener moves or stops, it is stale.
    if (!status.listening) this.pairing = null
    this.deps.changed?.()
  }

  listenerStatus(): PhoneListenerStatus { return { ...this.listener } }

  desktopState(): PhoneAccessState {
    this.expirePairing()
    const connected = new Set([...this.streams].map(stream => stream.deviceId))
    return {
      settings: this.getSettings(),
      listening: this.listener.listening,
      endpoints: [...this.listener.endpoints],
      primaryEndpoint: this.listener.endpoints[0] ?? null,
      message: this.listener.message,
      caFingerprint: this.deps.vault.available() ? this.certificateAuthority().fingerprint : null,
      devices: this.devices.map(device => this.describeDevice(device, connected)),
      pairing: this.pairing ? { code: this.pairing.code, url: this.pairing.url, endpoint: this.pairing.endpoint, expiresAt: this.pairing.expiresAt } : null,
      secureStorage: this.deps.vault.available(),
      tailscale: {
        address: this.listener.tailscaleAddress, dnsName: this.listener.tailscaleDnsName, certificate: this.listener.tailscaleCertificate, message: this.listener.tailscaleMessage,
        ...(this.listener.tailnet ?? NO_TAILNET),
        phones: [...(this.listener.tailnet?.phones ?? [])]
      },
      recommendedEndpoint: recommendEndpoint(this.listener),
      pushConfigured: Boolean(this.deps.store.getSetting(VAPID_PUBLIC_KEY)),
      lock: this.lock.status(),
      attentionLog: this.attention.entries()
    }
  }

  machineName(): string { return this.deps.machineName() }

  /** A phone unlocked: the desktop panel lists which phones are open. */
  changedLock(): void { this.deps.changed?.() }

  /** Conductor's own version, for the unauthenticated health answer. */
  version(): string { return this.deps.version }

  private describeDevice(device: StoredDevice, connected: Set<string>): PhoneDevice {
    return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, userAgent: device.userAgent, pushEnabled: Boolean(device.subscription), pushFailures: device.pushFailures, connected: connected.has(device.id) }
  }

  /* ----------------------------------------------------------------------- *
   * Pairing and devices
   * ----------------------------------------------------------------------- */

  private saveDevices(): void {
    this.deps.store.setSetting(DEVICES_KEY, JSON.stringify(this.devices))
    this.deps.changed?.()
  }

  private expirePairing(): void {
    if (this.pairing && Date.parse(this.pairing.expiresAt) <= this.now()) { this.pairing = null; this.deps.changed?.() }
  }

  /**
   * One live code at a time: showing a second one silently retires the first. The code names the
   * origin the phone will keep: the recommended one unless the owner picked another the listener
   * answers on. Anything else is refused rather than encoded, since a QR naming an address this
   * machine does not serve is the blank-screen failure this setup exists to end.
   */
  createPairing(endpoint?: string): PhonePairingOffer {
    if (!this.settings.enabled) throw new PhoneAccessError('Switch phone access on before pairing a phone.', 409)
    const chosen = endpoint ? this.listener.endpoints.find(known => known.toLowerCase() === endpoint.trim().replace(/\/+$/, '').toLowerCase()) : recommendEndpoint(this.listener)
    if (!this.listener.listening || !this.listener.endpoints.length) throw new PhoneAccessError(this.listener.message ?? 'The phone listener is not running yet.', 409)
    if (!chosen) throw new PhoneAccessError('This computer does not answer at that address. Pick one of the addresses it is listening on.', 400)
    if (this.devices.length >= MAX_DEVICES) throw new PhoneAccessError('Revoke a phone before pairing another; the list is full.', 409)
    const bytes = randomBytes(8)
    const raw = [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
    const code = raw.slice(0, 4) + '-' + raw.slice(4)
    this.pairing = { code, normalized: raw, url: `${chosen}/#pair=${code}`, endpoint: chosen, expiresAt: new Date(this.now() + PHONE_PAIRING_TTL_MS).toISOString() }
    this.deps.changed?.()
    return { code, url: this.pairing.url, endpoint: chosen, expiresAt: this.pairing.expiresAt }
  }

  cancelPairing(): void { this.pairing = null; this.deps.changed?.() }

  /** Redeems a code for a token. Address-keyed failure counting keeps guessing from paying off. */
  redeemPairing(input: { code: unknown; name: unknown; userAgent?: string; address: string }): { token: string; device: PhoneSelf } {
    const gate = this.pairFailures.get(input.address)
    if (gate && gate.failures >= PAIR_FAILURE_LIMIT && gate.until > this.now()) throw new PhoneAccessError('Too many failed pairing attempts from this address. Try again later.', 429)
    this.expirePairing()
    const attempt = normalizePairingCode(input.code)
    const live = this.pairing
    if (!live || attempt.length !== live.normalized.length || !timingSafeEqual(Buffer.from(attempt), Buffer.from(live.normalized))) {
      const failures = (gate && gate.until > this.now() ? gate.failures : 0) + 1
      this.pairFailures.set(input.address, { failures, until: this.now() + PAIR_LOCKOUT_MS })
      throw new PhoneAccessError(live ? 'That code did not match. Check the code on the computer and try again.' : 'No pairing code is active. Show one in Conductor’s settings first.', 403)
    }
    this.pairFailures.delete(input.address)
    this.pairing = null
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Phone'
    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = { id: makeId('phone'), name, tokenHash: hashToken(token), createdAt: new Date(this.now()).toISOString(), lastSeenAt: new Date(this.now()).toISOString(), userAgent: String(input.userAgent ?? '').slice(0, 300), subscription: null, pushFailures: 0 }
    this.devices.push(device)
    this.saveDevices()
    return { token, device: this.self(device) }
  }

  /** The device a bearer token belongs to, or null. Hashes are compared in constant time. */
  authenticate(token: string | undefined): PhoneDevice | null {
    if (!token || token.length > 200) return null
    const hash = hashToken(token)
    const device = this.devices.find(candidate => sameHash(candidate.tokenHash, hash))
    if (!device) return null
    const at = this.now()
    if (at - (this.lastSeenWritten.get(device.id) ?? 0) > SEEN_WRITE_INTERVAL_MS) {
      device.lastSeenAt = new Date(at).toISOString()
      this.lastSeenWritten.set(device.id, at)
      this.saveDevices()
    }
    return this.describeDevice(device, new Set([...this.streams].map(stream => stream.deviceId)))
  }

  private stored(deviceId: string): StoredDevice {
    const device = this.devices.find(candidate => candidate.id === deviceId)
    if (!device) throw new PhoneAccessError('That phone is no longer paired.', 401)
    return device
  }

  self(deviceId: string | StoredDevice): PhoneSelf {
    const device = typeof deviceId === 'string' ? this.stored(deviceId) : deviceId
    return {
      id: device.id, name: device.name, machineName: this.deps.machineName(),
      vapidPublicKey: this.settings.notifications ? this.vapid()?.publicKey ?? null : null,
      pushEnabled: Boolean(device.subscription), notificationsAllowed: this.settings.notifications,
      notificationPrefs: device.notificationPrefs ?? DEFAULT_PHONE_NOTIFICATION_PREFS,
      version: this.deps.version
    }
  }

  setNotificationPrefs(deviceId: string, prefs: unknown): PhoneSelf {
    const device = this.stored(deviceId)
    const raw = (prefs && typeof prefs === 'object' ? prefs : {}) as Record<string, unknown>
    device.notificationPrefs = {
      taskDone: raw.taskDone !== false,
      needsYou: raw.needsYou !== false,
      coworkerDone: raw.coworkerDone === true
    }
    this.saveDevices()
    return this.self(device)
  }

  rename(deviceId: string, name: unknown): PhoneSelf {
    const device = this.stored(deviceId)
    const cleaned = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (!cleaned) throw new PhoneAccessError('Give the phone a name.')
    device.name = cleaned
    this.saveDevices()
    return this.self(device)
  }

  revoke(deviceId: string): void {
    const before = this.devices.length
    this.devices = this.devices.filter(device => device.id !== deviceId)
    if (this.devices.length === before) throw new PhoneAccessError('That phone is not paired.', 404)
    for (const stream of [...this.streams]) if (stream.deviceId === deviceId) this.streams.delete(stream)
    this.lock.lockDevice(deviceId)
    this.emitLocked(deviceId, null)
    this.saveDevices()
  }

  listDevices(): PhoneDevice[] { return this.desktopState().devices }

  /* ----------------------------------------------------------------------- *
   * TLS identity
   * ----------------------------------------------------------------------- */

  certificateAuthority(): CertificateAuthority {
    const certificatePem = this.deps.store.getSetting(CA_CERT_KEY) ?? ''
    const privateKeyPem = this.deps.vault.read(CA_PRIVATE_KEY) ?? ''
    const notAfter = this.deps.store.getSetting(CA_EXPIRY_KEY) ?? ''
    if (tlsIdentityUsable({ certificatePem, privateKeyPem, notAfter })) {
      try { return { certificatePem, privateKeyPem, notAfter, fingerprint: fingerprintOf(certificatePem) } }
      catch { /* a damaged certificate is replaced, and every phone has to trust the new one */ }
    }
    const created = createCertificateAuthority(`Conductor Phone Access · ${this.deps.machineName()}`)
    this.deps.vault.write(CA_PRIVATE_KEY, created.privateKeyPem)
    this.deps.store.setSetting(CA_CERT_KEY, created.certificatePem)
    this.deps.store.setSetting(CA_EXPIRY_KEY, created.notAfter)
    // The old server certificate was signed by the old authority; it has to go too.
    this.deps.store.removeSetting(LEAF_CERT_KEY)
    return created
  }

  /**
   * The certificate the socket presents, re-issued whenever the addresses it must name change.
   * Returned as the chain a browser expects: the leaf first, the authority after it.
   */
  serverIdentity(hosts: string[]): { certificatePem: string; privateKeyPem: string; fingerprint: string; hosts: string[] } {
    const authority = this.certificateAuthority()
    const wanted = [...new Set(['localhost', '127.0.0.1', ...hosts.map(host => host.trim()).filter(Boolean)])]
    const stored = { certificatePem: this.deps.store.getSetting(LEAF_CERT_KEY) ?? '', privateKeyPem: this.deps.vault.read(LEAF_PRIVATE_KEY) ?? '', notAfter: this.deps.store.getSetting(LEAF_EXPIRY_KEY) ?? '' }
    const storedHosts = parseJson<string[]>(this.deps.store.getSetting(LEAF_HOSTS_KEY), [])
    if (tlsIdentityUsable(stored, new Date(this.now() + 23 * 86400000)) && JSON.stringify(storedHosts) === JSON.stringify(wanted)) {
      try { return { certificatePem: stored.certificatePem + authority.certificatePem, privateKeyPem: stored.privateKeyPem, fingerprint: fingerprintOf(stored.certificatePem), hosts: storedHosts } }
      catch { /* re-issued below */ }
    }
    const issued = issueServerCertificate(authority, `Conductor · ${this.deps.machineName()}`, wanted, 397, new Date(this.now()))
    this.deps.vault.write(LEAF_PRIVATE_KEY, issued.privateKeyPem)
    this.deps.store.setSetting(LEAF_CERT_KEY, issued.certificatePem)
    this.deps.store.setSetting(LEAF_EXPIRY_KEY, issued.notAfter)
    this.deps.store.setSetting(LEAF_HOSTS_KEY, JSON.stringify(issued.hosts))
    return { certificatePem: issued.certificatePem + authority.certificatePem, privateKeyPem: issued.privateKeyPem, fingerprint: issued.fingerprint, hosts: issued.hosts }
  }

  /* ----------------------------------------------------------------------- *
   * Push
   * ----------------------------------------------------------------------- */

  private vapid(): VapidKeys | null {
    if (!this.deps.vault.available()) return null
    const publicKey = this.deps.store.getSetting(VAPID_PUBLIC_KEY) ?? ''
    const privateKey = this.deps.vault.read(VAPID_PRIVATE_KEY) ?? ''
    const stored = { publicKey, privateKey }
    if (isValidVapidKeys(stored)) return stored
    const created = generateVapidKeys()
    this.deps.vault.write(VAPID_PRIVATE_KEY, created.privateKey)
    this.deps.store.setSetting(VAPID_PUBLIC_KEY, created.publicKey)
    return created
  }

  /** Minting the keys before the first phone asks lets the panel show that push is configured. */
  ensurePushKeys(): boolean { return this.vapid() !== null }

  setSubscription(deviceId: string, subscription: unknown): PhoneSelf {
    const device = this.stored(deviceId)
    if (subscription === null) { device.subscription = null; device.pushFailures = 0; this.saveDevices(); return this.self(device) }
    const raw = (subscription && typeof subscription === 'object' ? subscription : {}) as Record<string, unknown>
    const keys = (raw.keys && typeof raw.keys === 'object' ? raw.keys : {}) as Record<string, unknown>
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint : ''
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || !keys.p256dh || !keys.auth) throw new PhoneAccessError('That push subscription is incomplete.')
    device.subscription = { endpoint, expirationTime: typeof raw.expirationTime === 'number' ? raw.expirationTime : null, keys: { p256dh: keys.p256dh, auth: keys.auth } }
    device.pushFailures = 0
    this.saveDevices()
    return this.self(device)
  }

  /**
   * Delivers one notification to phones. Every phone with a subscription hears about a
   * conversation; a test goes only where it was asked. A push service that says the subscription
   * is gone has the last word: the phone unsubscribed or reinstalled, and nothing will bring that
   * endpoint back. Anything else is counted so the panel can say a phone is not being reached.
   */
  async sendNotification(notification: PhoneNotification, deviceIds?: string[]): Promise<{ sent: number; message: string | null }> {
    if (!this.settings.notifications && notification.kind !== 'test') return { sent: 0, message: 'Notifications are switched off.' }
    const keys = this.vapid()
    if (!keys) return { sent: 0, message: 'Push keys need the OS credential store, which is unavailable.' }
    const targets = this.devices.filter(device => device.subscription && (!deviceIds || deviceIds.includes(device.id)) &&
      (notification.kind === 'test' || wantsNotification(device.notificationPrefs, notification)))
    if (!targets.length) return { sent: 0, message: deviceIds ? 'That phone has not turned notifications on.' : 'No phone has notifications on.' }
    const payload = JSON.stringify(notification)
    const lockConfigured = this.lock.configured()
    const redacted = JSON.stringify(redactNotification(notification))
    const send = this.deps.push ?? sendWebPush
    let sent = 0
    const problems: string[] = []
    let changed = false
    for (const device of targets) {
      try {
        const result = await send(device.subscription!, lockConfigured && !this.lock.unlocked(device.id) ? redacted : payload, { keys, subject: 'https://github.com/Empire024/conductor', ttl: 24 * 3600, urgency: notification.kind === 'attention' ? 'high' : 'normal', topic: notification.sessionId ? topicFor(notification.sessionId) : undefined })
        if (result.gone) { device.subscription = null; device.pushFailures = 0; changed = true; problems.push(`${device.name}: the phone dropped its subscription; turn notifications on again there.`) }
        else if (result.status >= 200 && result.status < 300) { sent += 1; if (device.pushFailures) { device.pushFailures = 0; changed = true } }
        else { device.pushFailures += 1; changed = true; problems.push(`${device.name}: push service answered ${result.status}.`) }
      } catch (error) {
        device.pushFailures += 1; changed = true
        problems.push(`${device.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (changed) this.saveDevices()
    return { sent, message: problems.length ? problems.join(' ') : null }
  }

  /** A feature's own notification (an idea run's checkpoint, docs/idea-autopilot.md): every open
   *  phone hears it at once and every phone with push on gets it pushed. Says what happened. */
  async announce(notification: PhoneNotification): Promise<string> {
    this.broadcast('notification', notification)
    const result = await this.sendNotification(notification)
    const streams = this.streams.size
    return `${result.sent ? `pushed to ${result.sent} phone${result.sent === 1 ? '' : 's'}` : result.message ?? 'not pushed'}; ${streams} open phone stream${streams === 1 ? '' : 's'}`
  }

  testNotification(deviceId?: string): Promise<{ sent: number; message: string | null }> {
    if (deviceId) this.stored(deviceId)
    return this.sendNotification({ id: randomUUID(), kind: 'test', sessionId: null, title: `Conductor on ${this.deps.machineName()}`, body: 'Notifications reach this phone.', at: new Date(this.now()).toISOString(), url: '/#/' }, deviceId ? [deviceId] : undefined)
  }

  /* ----------------------------------------------------------------------- *
   * Live streams and change observation
   * ----------------------------------------------------------------------- */

  subscribe(deviceId: string, write: PhoneStreamWriter): () => void {
    this.stored(deviceId)
    const stream: Stream = { deviceId, write }
    this.streams.add(stream)
    this.deps.changed?.()
    try { write('state', this.phoneState()) } catch (error) { this.log('Phone stream could not receive its first state', error) }
    return () => { if (this.streams.delete(stream)) this.deps.changed?.() }
  }

  connectedDeviceNames(): string[] {
    const ids = new Set([...this.streams].map(stream => stream.deviceId))
    return this.devices.filter(device => ids.has(device.id)).map(device => device.name)
  }

  streamCount(deviceId?: string): number { return [...this.streams].filter(stream => !deviceId || stream.deviceId === deviceId).length }

  private broadcast(event: string, data: unknown): void {
    for (const stream of [...this.streams]) {
      try { stream.write(event, data) } catch (error) { this.streams.delete(stream); this.log('Phone stream dropped', error) }
    }
  }

  /** Conversation events as the windows hear them; only what changed is announced immediately. */
  observeEvents(events: ReadonlyArray<{ sessionId: string; sequence: number; data: { type: string } }>): void {
    if (this.disposed) return
    const ids = new Set<string>()
    for (const event of events) { ids.add(event.sessionId); this.touched.add(event.sessionId) }
    if (this.streams.size) {
      for (const id of ids) {
        const projection = this.deps.database.structured.snapshot(id)
        if (projection) this.broadcast('session', { id, sequence: projection.sequence, phase: projection.phase })
      }
    }
    this.scheduleRefresh()
  }

  /** The persisted activity phase moved (a subagent finished, a limit lifted) without an event. */
  noteActivity(sessionId: string): void { if (!this.disposed) { this.touched.add(sessionId); this.scheduleRefresh() } }

  /** Something structural changed - a tab opened or closed, a machine came online. */
  refresh(): void { if (!this.disposed) this.scheduleRefresh() }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.runRefresh() }, REFRESH_DEBOUNCE_MS)
  }

  /** Recomputes everything, announces transitions, and sends the new picture to every phone. */
  private runRefresh(): void {
    if (this.disposed) return
    this.touched.clear()
    let state: PhoneState
    try { state = this.phoneState() } catch (error) { this.log('Phone state unavailable', error); return }
    const at = new Date(this.now()).toISOString()
    const notifications: PhoneNotification[] = []
    const seen = new Set<string>()
    this.latest.clear()
    for (const summary of state.sessions) {
      seen.add(summary.id)
      this.latest.set(summary.id, summary)
      // Only a conversation with an open tab is one the owner is waiting on; history stays quiet.
      if (summary.tabId) {
        const transition = this.seeded ? describeTransition(this.known.get(summary.id), summary, at, randomUUID()) : null
        // "Needs you" is held: it goes out only if the turn is still blocked after the grace period.
        if (transition?.kind === 'attention') this.attention.offer({ sessionId: summary.id, title: summary.title, kind: summary.needs === 'question' ? 'question' : 'approval', detail: this.askedText(summary.id) ?? transition.body, ...(summary.pendingId ? { pendingId: summary.pendingId } : {}), notification: transition })
        else if (transition) notifications.push(transition)
        if (this.seeded) for (const { denial, notification } of describeDenialMoments(this.known.get(summary.id), summary, at, randomUUID)) {
          this.attention.offer({ sessionId: summary.id, title: summary.title, kind: 'denial', detail: notification.body, denialItemId: denial.id, notification })
        }
      }
      this.known.set(summary.id, { state: summary.state, pendingId: summary.pendingId, autoModeDenials: summary.autoModeDenials })
    }
    for (const id of [...this.known.keys()]) if (!seen.has(id)) this.known.delete(id)
    this.seeded = true
    if (this.streams.size) this.broadcast('state', state)
    for (const notification of notifications) this.deliver(notification)
    this.attention.review()
  }

  /** The question itself, for the attention log, where the interaction title is only "Claude needs your input". */
  private askedText(id: string): string | undefined {
    const asked = pendingInteraction(this.deps.database.structured.snapshot(id)?.items ?? [])?.questions?.map(question => question.question).filter(Boolean).join(' / ')
    return asked ? previewText(asked, 160) : undefined
  }

  private deliver(notification: PhoneNotification): void {
    if (this.disposed) return
    this.broadcast('notification', notification)
    void this.sendNotification(notification).then(result => { if (result.message) this.log('Phone push: ' + result.message) }).catch(error => this.log('Phone push failed', error))
  }

  /** Learns the current picture without announcing it, so a restart does not re-notify old news. */
  seed(): void { if (!this.seeded) this.runRefresh() }

  /* ----------------------------------------------------------------------- *
   * What the phone sees
   * ----------------------------------------------------------------------- */

  private machineList(): MachineDescriptor[] {
    try { return this.deps.machines() } catch { return [] }
  }

  private catalog(): PhoneState['providers'] {
    const runtimeModels = new Map<string, NonNullable<SessionProjection['capabilities']>['models']>()
    for (const project of this.deps.database.listProjects()) for (const workspace of this.deps.database.listSessions(project.id)) {
      for (const tab of layoutTabs(workspace.layout.root)) {
        const provider = tab.state?.provider
        if (tab.kind !== 'agent' || !tab.resourceId || typeof provider !== 'string' || runtimeModels.has(provider)) continue
        const models = this.deps.database.structured.snapshot(tab.resourceId)?.capabilities?.models
        if (models?.length) runtimeModels.set(provider, models)
      }
    }
    return this.deps.providers().filter(provider => provider.id === 'codex' || provider.id === 'claude' || provider.id === 'grok' || provider.id === 'local').map(provider => ({
      id: provider.id as StructuredProvider, displayName: provider.displayName, available: provider.available,
      models: runtimeModels.get(provider.id) ?? provider.models.filter(model => !['default', 'auto'].includes(model.id)).map(model => ({ ...model, effort: provider.efforts.map(effort => effort.id).filter(id => id !== 'auto') }))
    }))
  }

  phoneState(): PhoneState {
    const projects = this.deps.database.listProjects()
    const machines = this.machineList()
    const detached = this.deps.database.listDetachedWindows()
    const activity = new Map(this.deps.database.listAgentActivity().map(row => [row.id, row.activityPhase]))
    const processes = new Map(this.deps.database.listProcesses().map(process => [process.id, process]))
    const sessions: PhoneSessionSummary[] = []
    const usage = new Map<string, PhoneUsageWindow>()
    const providers = this.catalog()
    for (const project of projects) {
      const workspaces = this.deps.database.listSessions(project.id)
      const open = new Set<string>()
      for (const workspace of workspaces) {
        const tabs = [...layoutTabs(workspace.layout.root), ...detached.filter(window => window.sessionId === workspace.id).flatMap(window => layoutTabs(window.layout.root))]
        for (const tab of tabs) {
          if (tab.kind !== 'agent' || !tab.resourceId || open.has(tab.resourceId)) continue
          open.add(tab.resourceId)
          const projection = this.deps.database.structured.snapshot(tab.resourceId)
          sessions.push(this.summarize(tab.resourceId, project, workspace, tab, projection, activity.get(tab.resourceId), processes.get(tab.resourceId), machines))
          if (projection) this.collectUsage(tab.resourceId, projection, usage, providers)
        }
      }
      let history: ReturnType<PhoneDatabase['structured']['history']> = []
      try { history = this.deps.database.structured.history(project.id) } catch { /* a project with no journal yet */ }
      for (const entry of history) {
        if (open.has(entry.id) || entry.archived) continue
        const spec = this.deps.database.structured.spec<AgentSpec>(entry.id)
        const workspace = spec ? workspaces.find(candidate => candidate.id === spec.sessionId) : undefined
        if (!spec || !workspace) continue
        sessions.push(this.summarize(entry.id, project, workspace, null, this.deps.database.structured.snapshot(entry.id), activity.get(entry.id), processes.get(entry.id), machines))
      }
    }
    return {
      observedAt: new Date(this.now()).toISOString(),
      machineName: this.deps.machineName(),
      projects: projects.map(project => ({ id: project.id, name: project.name, machineId: project.remote?.machineId ?? LOCAL_MACHINE_ID, workspaces: this.deps.database.listSessions(project.id).map(workspace => ({ id: workspace.id, name: workspace.name })) })),
      machines: machines.map(machine => ({
        id: machine.id, name: machine.name, kind: machine.kind, status: machine.status,
        projectIds: projects.filter(project => (project.remote?.machineId ?? LOCAL_MACHINE_ID) === machine.id).map(project => project.id)
      })),
      providers,
      sessions,
      usage: [...usage.values()].sort((a, b) => a.provider.localeCompare(b.provider) || windowOrder.indexOf(a.kind) - windowOrder.indexOf(b.kind) || a.label.localeCompare(b.label)),
      weeklyUsage: this.deps.weeklyUsage?.read() ?? { since: new Date(this.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), through: new Date(this.now()).toISOString(), days: 7, models: [], coverage: { complete: false, notes: ['Weekly usage service is not connected.'], conversationsScanned: 0, conversationsWithUsage: 0, truncatedConversations: 0, countersWithoutBaseline: 0, nestedReportsExcluded: 0 } },
      projectTaskMaxLength: PROJECT_TASK_MAX_LENGTH,
      counts: { attention: sessions.filter(session => session.tabId && session.state === 'attention').length, working: sessions.filter(session => session.tabId && session.state === 'working').length }
    }
  }

  private collectUsage(id: string, projection: SessionProjection, into: Map<string, PhoneUsageWindow>, providers = this.catalog()): void {
    const provider = projection.capabilities?.provider
    if (!provider) return
    let cached = this.usageCache.get(id)
    if (!cached || cached.sequence !== projection.sequence) {
      const summary = summarizeUsage(projection.items)
      const usageItems = projection.items.filter(item => item.data.type === 'usage')
      const latest = usageItems.reduce<TimelineItem | undefined>((best, item) => !best || updatedSequence(item) > updatedSequence(best) ? item : best, undefined)
      cached = {
        sequence: projection.sequence,
        windows: normalizeUsageWindows(summary.limits),
        reportedAt: latest?.timestamp ?? projection.items.at(-1)?.timestamp ?? new Date(this.now()).toISOString(),
        summary: summary.tokens?.totalTokens !== undefined || summary.costUsd !== undefined ? { totalTokens: summary.tokens?.totalTokens, costUsd: summary.costUsd, estimated: summary.estimated || summary.costEstimated } : undefined
      }
      this.usageCache.set(id, cached)
    }
    for (const window of cached.windows) {
      const key = `${provider}|${window.key}`
      const existing = into.get(key)
      if (existing && existing.reportedAt >= cached.reportedAt) continue
      const catalog = providers.find(entry => entry.id === provider)
      const matched = window.scope === 'model' ? catalog?.models.filter(model => usageWindowAppliesToModel(window, model)) ?? [] : []
      const reportedModel = window.scope === 'model' ? window.modelSelectors?.at(-1) : undefined
      const model = matched.length === 1 ? matched[0]!.label : reportedModel
      into.set(key, { provider, ...(model ? { model } : {}), label: window.label, kind: window.kind, usedPercent: window.usedPercent, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}), reportedAt: cached.reportedAt })
    }
  }

  private summarize(id: string, project: ProjectRecord, workspace: SessionRecord, tab: PaneTab | null, projection: SessionProjection | null, activity: PhoneActivity | undefined, process: RuntimeProcessSummary | undefined, machines: MachineDescriptor[]): PhoneSessionSummary {
    const spec = this.deps.database.structured.spec<AgentSpec>(id)
    // Newer runtimes record the usage window and outstanding background work on the projection;
    // read them loosely so a tree without those fields still builds and simply reports neither.
    const extra = (projection ?? {}) as { limitResumeAt?: string | null; backgroundTasks?: number }
    const items = projection?.items ?? []
    const pending = pendingInteraction(items)
    const denials = autoModeDenials(items)
    const last = lastMessage(items)
    const machineId = tab ? tabMachineId(tab) : spec?.machineId ?? project.remote?.machineId ?? LOCAL_MACHINE_ID
    const provider = (typeof tab?.state?.provider === 'string' ? tab.state.provider : spec?.provider ?? process?.provider ?? 'claude') as PhoneSessionSummary['provider']
    const latest = items.reduce<string | undefined>((best, item) => !best || item.timestamp > best ? item.timestamp : best, undefined)
    const running = projection ? activeSessionPhases.has(projection.phase) : activity === 'working'
    const turnStartedAt = running ? [...items].reverse().find(item => item.runtimeId === projection?.runtimeId && !item.parentId && item.data.type === 'text' && item.data.role === 'user')?.timestamp : undefined
    const usage = projection ? (this.usageCache.get(id)?.sequence === projection.sequence ? this.usageCache.get(id)!.summary : this.usageSummary(id, projection)) : undefined
    return {
      id, projectId: project.id, projectName: project.name, workspaceId: workspace.id, workspaceName: workspace.name,
      tabId: tab?.id ?? null,
      title: (tab?.title || projection?.title || spec?.title || process?.title || providerLabels[provider] || 'Conversation').trim(),
      provider,
      ...(projection?.settings.model ?? (typeof tab?.state?.model === 'string' ? tab.state.model : spec?.model ?? process?.model) ? { model: String(projection?.settings.model ?? tab?.state?.model ?? spec?.model ?? process?.model) } : {}),
      ...(projection?.settings.effort ? { effort: projection.settings.effort } : {}),
      machineId,
      machineName: machines.find(machine => machine.id === machineId)?.name ?? project.remote?.machineName ?? (machineId === LOCAL_MACHINE_ID ? this.deps.machineName() : 'Another machine'),
      phase: projection?.phase ?? 'idle',
      activity: (activity ?? 'idle') as PhoneSessionSummary['activity'],
      state: phoneSessionState(projection, activity),
      needs: pending ? pending.kind === 'approval' ? 'approval' : 'question' : null,
      ...(pending ? { pendingId: pending.id, pendingTitle: previewText(pending.title, 160) } : {}),
      ...(denials.length ? { autoModeDenials: denials } : {}),
      updatedAt: latest ?? process?.updatedAt ?? new Date(this.now()).toISOString(),
      ...(turnStartedAt ? { turnStartedAt } : {}),
      ...(last ? { lastText: previewText(last.text, PHONE_STATE_LIMITS.previewChars), lastRole: last.role } : {}),
      ...(extra.limitResumeAt ?? process?.resumeAt ? { limitResumeAt: extra.limitResumeAt ?? process?.resumeAt } : {}),
      ...(extra.backgroundTasks ? { backgroundTasks: extra.backgroundTasks } : {}),
      queued: projection?.queuedPrompts?.length ?? (projection?.queued ? 1 : 0),
      archived: projection?.archived ?? false,
      ...(this.controllerId(id) ? { controllerId: this.controllerId(id)! } : {}),
      ...(usage ? { usage } : {})
    }
  }

  private usageSummary(id: string, projection: SessionProjection): PhoneSessionSummary['usage'] {
    this.collectUsage(id, projection, new Map())
    return this.usageCache.get(id)?.summary
  }

  private controllerId(id: string): string | undefined {
    const link = parseJson<{ controllerAgentSessionId?: unknown } | null>(this.deps.store.getSetting(`agentControlParent:${id}`), null)
    return typeof link?.controllerAgentSessionId === 'string' && link.controllerAgentSessionId && link.controllerAgentSessionId !== id
      ? link.controllerAgentSessionId : undefined
  }

  private located(id: string): { project: ProjectRecord; workspace: SessionRecord; tab: PaneTab | null; projection: SessionProjection | null } {
    if (typeof id !== 'string' || !id || id.length > 160) throw new PhoneAccessError('Name a conversation.', 404)
    const spec = this.deps.database.structured.spec<AgentSpec>(id)
    const project = spec ? this.deps.database.getProject(spec.projectId) : null
    if (!spec || !project) throw new PhoneAccessError('That conversation is not open in Conductor.', 404)
    const workspace = this.deps.database.listSessions(project.id).find(candidate => candidate.id === spec.sessionId)
    if (!workspace) throw new PhoneAccessError('That conversation’s workspace is closed.', 404)
    const detached = this.deps.database.listDetachedWindows().filter(window => window.sessionId === workspace.id).flatMap(window => layoutTabs(window.layout.root))
    const tab = [...layoutTabs(workspace.layout.root), ...detached].find(candidate => candidate.kind === 'agent' && candidate.resourceId === id) ?? null
    return { project, workspace, tab, projection: this.deps.database.structured.snapshot(id) }
  }

  conversation(id: string): PhoneConversation {
    const { project, workspace, tab, projection } = this.located(id)
    const machines = this.machineList()
    const activity = this.deps.database.listAgentActivity().find(row => row.id === id)?.activityPhase
    const process = this.deps.database.listProcesses().find(candidate => candidate.id === id)
    const summary = this.summarize(id, project, workspace, tab, projection, activity, process, machines)
    const items = projection?.items ?? []
    const roots = items.filter(isConversationActivity).filter(item => !item.parentId && !['steering', 'queue', 'input_delivery'].includes(item.data.type))
    const kept = roots.slice(-PHONE_STATE_LIMITS.items)
    return {
      summary,
      sequence: projection?.sequence ?? 0,
      items: kept.map(trimItem),
      pending: items.flatMap(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending' ? [item.data.interaction] : []),
      queued: (projection?.queuedPrompts ?? (projection?.queued ? [projection.queued] : [])).map(prompt => ({ id: prompt.id, text: previewText(prompt.text, 400) })),
      truncated: Boolean(projection?.truncated) || kept.length < roots.length,
      canSteer: projection?.capabilities?.steering === true,
      needsResume: Boolean(projection?.nativeSessionId) && (projection?.phase === 'interrupted' || projection?.phase === 'disconnected')
    }
  }

  async metrics(): Promise<PhoneMetrics> {
    const projects = new Map(this.deps.database.listProjects().map(project => [project.id, project]))
    const workspaces = new Map<string, string>()
    for (const project of projects.values()) for (const workspace of this.deps.database.listSessions(project.id)) workspaces.set(workspace.id, workspace.name)
    const runtimes = this.deps.database.listProcesses().filter(process => process.status !== 'exited' && process.status !== 'unavailable').map(process => ({ ...process, projectName: projects.get(process.projectId)?.name ?? 'Project', workspaceName: workspaces.get(process.sessionId) ?? 'Workspace' }))
    return { system: await this.deps.metrics(), runtimes }
  }

  /* ----------------------------------------------------------------------- *
   * Actions
   * ----------------------------------------------------------------------- */

  private structuredOnly(id: string): { projection: SessionProjection; remote: boolean } {
    const { projection } = this.located(id)
    if (!projection) throw new PhoneAccessError('This provider can only be driven from the computer, not from a phone.', 409)
    return { projection, remote: Boolean(this.deps.remote?.isRemote(id)) }
  }

  async sendMessage(id: string, input: { text: unknown; mode?: unknown }): Promise<{ phase: SessionProjection['phase']; mode: Exclude<PhoneMessageMode, 'auto'> }> {
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text) throw new PhoneAccessError('Write a message first.')
    if (text.length > 100_000) throw new PhoneAccessError('That message is too long to send from a phone.')
    const requested = (['auto', 'submit', 'steer', 'queue'] as const).includes(input.mode as PhoneMessageMode) ? input.mode as PhoneMessageMode : 'auto'
    const { projection, remote } = this.structuredOnly(id)
    const settings = settingsForRuntime(projection.settings, projection.runtimeId)
    const active = activeSessionPhases.has(projection.phase)
    const canSteer = projection.capabilities?.steering === true
    const mode: Exclude<PhoneMessageMode, 'auto'> = requested === 'auto' ? active ? canSteer ? 'steer' : 'queue' : 'submit' : requested
    if (mode === 'steer' && !canSteer) throw new PhoneAccessError('This conversation cannot be steered mid-turn; queue the message instead.', 409)
    const needsResume = Boolean(projection.nativeSessionId) && (projection.phase === 'interrupted' || projection.phase === 'disconnected')
    if (needsResume && mode === 'submit') await (remote ? this.deps.remote!.resume(id, settings) : this.deps.sessions.resume(id, settings))
    if (remote) {
      if (mode === 'queue') await this.deps.remote!.queue(id, text, settings)
      else await this.deps.remote!.submit(id, text, mode === 'steer' ? 'agents.steer' : 'agents.submit', settings)
    } else if (mode === 'submit') await this.deps.sessions.submit(id, text, settings, [])
    else if (mode === 'steer') await this.deps.sessions.steer(id, text, settings, [])
    else await this.deps.sessions.queue(id, text, settings, [])
    return { phase: this.deps.database.structured.snapshot(id)?.phase ?? projection.phase, mode }
  }

  async respond(id: string, input: { requestId: unknown; decision?: unknown; answers?: unknown }): Promise<{ phase: SessionProjection['phase'] }> {
    const { projection, remote } = this.structuredOnly(id)
    const requestId = typeof input.requestId === 'string' ? input.requestId : ''
    if (!requestId) throw new PhoneAccessError('Name the question being answered.')
    const pending = projection.items.find(item => item.data.type === 'interaction' && item.data.interaction.id === requestId && item.data.interaction.status === 'pending')
    if (!pending) throw new PhoneAccessError('That question is no longer waiting; refresh the conversation.', 409)
    const answers = normalizeAnswers(input.answers)
    const response: InteractionResponse = { sessionId: id, runtimeId: projection.runtimeId, requestId, ...(typeof input.decision === 'string' ? { decision: input.decision.slice(0, 200) } : {}), ...(answers ? { answers } : {}) }
    await (remote ? this.deps.remote!.respond(response) : this.deps.sessions.respond(response))
    return { phase: this.deps.database.structured.snapshot(id)?.phase ?? projection.phase }
  }

  async interrupt(id: string): Promise<{ phase: SessionProjection['phase'] }> {
    const { projection, remote } = this.structuredOnly(id)
    await (remote ? this.deps.remote!.interrupt(id) : this.deps.sessions.interrupt(id))
    return { phase: this.deps.database.structured.snapshot(id)?.phase ?? projection.phase }
  }

  async resume(id: string): Promise<{ phase: SessionProjection['phase'] }> {
    const { projection, remote } = this.structuredOnly(id)
    await (remote ? this.deps.remote!.resume(id, projection.settings) : this.deps.sessions.resume(id, projection.settings))
    return { phase: this.deps.database.structured.snapshot(id)?.phase ?? projection.phase }
  }

  /**
   * Opens a visible tab, on the machine the project lives on, and optionally sends its first
   * message. A project belongs to exactly one computer, so "run on" is checked rather than chosen:
   * naming a different machine is refused with the reason, never quietly redirected.
   */
  async openTab(input: PhoneOpenTabRequest): Promise<PhoneOpenTabResult> {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
    const projectId = typeof raw.projectId === 'string' ? raw.projectId : ''
    const project = this.deps.database.getProject(projectId)
    if (!project) throw new PhoneAccessError('Choose a project that is open in Conductor.', 404)
    const workspace = this.deps.database.listSessions(project.id).find(candidate => candidate.id === raw.workspaceId)
    if (!workspace) throw new PhoneAccessError('Choose a workspace of that project.', 404)
    const home = project.remote?.machineId ?? LOCAL_MACHINE_ID
    const requested = typeof raw.machineId === 'string' && raw.machineId ? raw.machineId : home
    const machines = this.machineList()
    const machine = machines.find(candidate => candidate.id === requested)
    if (requested !== home) {
      throw new PhoneAccessError(home === LOCAL_MACHINE_ID
        ? `“${project.name}” is on ${this.deps.machineName()}, so its work runs there.`
        : `“${project.name}” lives on ${project.remote?.machineName ?? 'another machine'}, so it cannot run on ${machine?.name ?? 'that machine'}.`, 409)
    }
    if (home !== LOCAL_MACHINE_ID && (!machine || machine.status !== 'online')) throw new PhoneAccessError(`${project.remote?.machineName ?? 'That machine'} is not reachable right now.`, 409)
    const provider = raw.provider
    const entry = this.catalog().find(candidate => candidate.id === provider)
    if (!entry || !entry.available) throw new PhoneAccessError('Choose an available provider.', 400)
    const model = entry.models.find(candidate => candidate.id === raw.model) ?? (raw.model === undefined ? entry.models.find(candidate => candidate.isDefault) ?? entry.models[0] : undefined)
    if (!model) throw new PhoneAccessError('Choose one of the listed models.', 400)
    const effort = raw.effort === undefined || raw.effort === '' ? model.defaultEffort : String(raw.effort)
    if (effort && !model.effort?.includes(effort)) throw new PhoneAccessError('Choose an effort this model supports.', 400)
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : undefined
    const prompt = typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim() : undefined
    if (prompt && prompt.length > 100_000) throw new PhoneAccessError('That first message is too long to send from a phone.')
    const openTab = async (tab: PaneTab): Promise<void> => {
      await this.deps.ui({ id: randomUUID(), projectId: project.id, sessionId: workspace.id, agentSessionId: '', action: 'tabs.open', params: { tab, focus: false } })
    }
    if (home !== LOCAL_MACHINE_ID) {
      if (!this.deps.remote) throw new PhoneAccessError('Remote machines are unavailable in this Conductor.', 409)
      const placed = await this.deps.remote.openTab({ machineId: home, projectId: project.id, sessionId: workspace.id, provider: entry.id, model: model.id, ...(effort ? { effort } : {}), ...(title ? { title } : {}) })
      const tab: PaneTab = { id: makeId('tab'), kind: 'agent', title: title ?? `${providerLabels[entry.id] ?? entry.displayName} · ${placed.machineName}`, resourceId: placed.localSessionId, state: { provider: entry.id, model: model.id, effort: effort ?? 'auto', viewMode: 'visual', machineId: placed.machineId } }
      await openTab(tab)
      if (prompt) {
        await this.deps.remote.connect(placed.localSessionId)
        const settings = this.deps.database.structured.snapshot(placed.localSessionId)?.settings ?? { permission: 'default' as const, plan: false, model: model.id, ...(effort ? { effort } : {}) }
        await this.deps.remote.submit(placed.localSessionId, prompt, 'agents.submit', settings)
      }
      this.refresh()
      return { sessionId: placed.localSessionId, tabId: tab.id, machineId: placed.machineId, machineName: placed.machineName }
    }
    const spec: AgentSpec = { id: makeId('agent'), projectId: project.id, sessionId: workspace.id, provider: entry.id, model: model.id, ...(effort ? { effort: effort as AgentSpec['effort'] } : {}), title: title ?? model.label, cwd: project.path }
    const ensured = this.deps.sessions.ensure(spec)
    if (!ensured.available) throw new PhoneAccessError(ensured.message || 'That provider is unavailable right now.', 409)
    const created = this.deps.database.structured.snapshot(spec.id)
    if (created) {
      // The same default the launcher would use: the owner's remembered mode for this provider.
      const permission = rememberedPermission(key => this.deps.store.getSetting(key), entry.id) ?? created.settings.permission
      this.deps.database.structured.update(spec.id, { settings: { ...created.settings, model: model.id, ...(effort ? { effort } : {}), permission } })
    }
    const tab: PaneTab = { id: makeId('tab'), kind: 'agent', title: spec.title, resourceId: spec.id, state: { provider: entry.id, model: model.id, effort: effort ?? 'auto', viewMode: 'visual', machineId: LOCAL_MACHINE_ID } }
    await openTab(tab)
    if (prompt) {
      await this.deps.sessions.connectSession(spec.id)
      const settings = this.deps.database.structured.snapshot(spec.id)?.settings ?? { permission: 'default' as const, plan: false, model: model.id }
      await this.deps.sessions.submit(spec.id, prompt, settings, [])
    }
    this.refresh()
    return { sessionId: spec.id, tabId: tab.id, machineId: LOCAL_MACHINE_ID, machineName: this.deps.machineName() }
  }

  async createProjectTask(projectId: unknown, input: PhoneProjectTaskRequest): Promise<PhoneProjectTaskResult> {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 160) throw new PhoneAccessError('Choose a project that is open in Conductor.', 404)
    const project = this.deps.database.getProject(projectId)
    if (!project) throw new PhoneAccessError('Choose a project that is open in Conductor.', 404)
    if (!this.deps.projectTasks) throw new PhoneAccessError('Project tasks are unavailable in this Conductor.', 503)
    const raw = input && typeof input === 'object' ? input as unknown as Record<string, unknown> : {}
    if (typeof raw.title !== 'string' || !raw.title.trim()) throw new PhoneAccessError('Write the project task first.')
    const title = raw.title.replace(/\r\n?/g, '\n').trim()
    if (title.length > PROJECT_TASK_MAX_LENGTH) throw new PhoneAccessError(`Keep the project task under ${PROJECT_TASK_MAX_LENGTH.toLocaleString()} characters.`)
    if (/\0|<!--\s*conductor-task\s*:/i.test(title)) throw new PhoneAccessError('Project tasks cannot contain task markers.')
    if (!projectTaskKinds.includes(raw.kind as ProjectTaskKind)) throw new PhoneAccessError('Choose task, bug, feature, or idea.')
    const priority = raw.priority === undefined ? 'normal' : raw.priority
    if (!projectTaskPriorities.includes(priority as ProjectTaskPriority)) throw new PhoneAccessError('Choose a valid project task priority.')
    const weight = raw.weight === undefined ? 'medium' : raw.weight
    if (!projectTaskWeights.includes(weight as ProjectTaskWeight)) throw new PhoneAccessError('Choose a valid project task weight.')
    const result = await this.deps.projectTasks.create(project, { title, kind: raw.kind as ProjectTaskKind, priority: priority as ProjectTaskPriority, weight: weight as ProjectTaskWeight })
    this.refresh()
    return result
  }

  async listProjectTasks(projectId:unknown,input:{offset?:unknown;limit?:unknown}={}):Promise<PhoneProjectTaskPage> {
    if(typeof projectId!=='string' || !projectId || projectId.length>160)throw new PhoneAccessError('Choose a project that is open in Conductor.',404)
    const project=this.deps.database.getProject(projectId)
    if(!project)throw new PhoneAccessError('Choose a project that is open in Conductor.',404)
    if(!this.deps.projectTasks)throw new PhoneAccessError('Project tasks are unavailable in this Conductor.',503)
    const offset=input.offset===undefined?0:Number(input.offset), limit=input.limit===undefined?20:Number(input.limit)
    if(!Number.isInteger(offset)||offset<0)throw new PhoneAccessError('Choose a valid project task offset.')
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new PhoneAccessError('Choose between 1 and 50 project tasks at a time.')
    return this.deps.projectTasks.list(project,{offset,limit})
  }

  /**
   * Where a phone terminal starts: a workspace of a project that lives on this machine. A project
   * mirrored from a paired machine is not one; its shells belong to that machine.
   */
  terminalWorkspace(projectId: string, workspaceId: string): { cwd: string; projectName: string; workspaceName: string } | null {
    const project = this.deps.database.getProject(projectId)
    if (!project || project.remote || !project.path) return null
    const workspace = this.deps.database.listSessions(projectId).find(session => session.id === workspaceId)
    if (!workspace) return null
    return { cwd: project.path, projectName: project.name, workspaceName: workspace.name }
  }

  dispose(): void {
    this.disposed = true
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null }
    this.streams.clear()
    this.lock.dispose()
    this.attention.dispose()
  }
}

/** What a locked phone's lock screen may show: that Conductor has news, and nothing of it. */
export function redactNotification(notification: PhoneNotification): PhoneNotification {
  return { id: notification.id, kind: notification.kind, sessionId: null, title: 'Conductor', body: 'Unlock Conductor to see what changed.', at: notification.at, url: '/#/' }
}

/* --------------------------------------------------------------------------- */

const fingerprintOf = (certificatePem: string): string => new X509Certificate(certificatePem).fingerprint256

/** A push topic collapses queued notifications about one conversation; it must be short and URL-safe. */
const topicFor = (sessionId: string): string => createHash('sha256').update(sessionId).digest('base64url').slice(0, 32)

const windowOrder: PhoneUsageWindow['kind'][] = ['weekly', 'short', 'other']
const stateOrder: PhoneSessionSummary['state'][] = ['attention', 'limited', 'failed', 'working', 'disconnected', 'done', 'stopped', 'idle']
const rank = (state: PhoneSessionSummary['state']): number => { const index = stateOrder.indexOf(state); return index < 0 ? stateOrder.length : index }

export function layoutTabs(node: LayoutNode): PaneTab[] {
  return node.type === 'split' ? node.children.flatMap(layoutTabs) : node.tabs
}

function normalizeAnswers(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const answers: Record<string, string[]> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 200) continue
    const list = Array.isArray(raw) ? raw : [raw]
    answers[key] = list.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.slice(0, 4000)).slice(0, 50)
  }
  return answers
}

/** Long output is the desktop's business; the phone gets enough to know what happened. */
export function trimItem(item: TimelineItem): PhoneTimelineItem {
  const { textChars, toolOutputChars, toolInputChars } = PHONE_STATE_LIMITS
  let data = item.data
  if (data.type === 'text' && data.text.length > textChars) data = { ...data, text: data.text.slice(0, textChars) + '\n…' }
  else if (data.type === 'tool') {
    const input = data.input === undefined ? undefined : JSON.stringify(data.input)
    data = {
      ...data,
      ...(input !== undefined && input.length > toolInputChars ? { input: { preview: input.slice(0, toolInputChars), truncated: true } } : {}),
      ...(data.output && data.output.length > toolOutputChars ? { output: '…' + data.output.slice(-toolOutputChars) } : {}),
      ...(data.stderr && data.stderr.length > toolOutputChars ? { stderr: '…' + data.stderr.slice(-toolOutputChars) } : {}),
      inputDelta: undefined
    }
  } else if (data.type === 'changes') data = { ...data, changes: data.changes.map(change => ({ ...change, patch: undefined })) }
  else if (data.type === 'subagent') data = { ...data, output: data.output ? previewText(data.output, toolOutputChars) : undefined }
  else if (data.type === 'notice' && data.payload !== undefined) data = { ...data, payload: undefined }
  return { id: item.id, sequence: item.sequence, timestamp: item.timestamp, ...(item.parentId ? { parentId: item.parentId } : {}), data }
}
