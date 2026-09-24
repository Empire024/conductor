/**
 * Phone access: the owner's phones as thin controllers of this Conductor.
 *
 * One HTTPS listener on this machine serves a small installable web app and a JSON API. A phone
 * pairs once with a short code the desktop shows, holds a bearer token from then on, and can watch
 * every conversation, answer questions and approvals, send follow-ups, start a task on any machine
 * that can run the project, and read the machine's own load. Push notifications tell it when a
 * conversation finishes or needs a decision, whether or not the app is open.
 *
 * Everything the desktop settings panel, the main process and the phone web app agree on lives in
 * this file. The phone app is plain JavaScript and cannot import it, so the wire shapes below are
 * the contract it is written against; keep the comments on them honest.
 */

import type { AgentActivityPhase, AgentProviderId, RuntimeProcessSummary } from './models'
import type { ProjectTaskKind, ProjectTaskPriority, ProjectTaskStatus, ProjectTaskWeight } from './project-backlog'
import type { PendingInteraction, SessionPhase, StructuredProvider, TimelineItem } from './structured-agent'
import type { SystemMetricsSnapshot } from './system-metrics'
import type { WeeklyModelUsageReport } from './weekly-model-usage'

/** Fixed rather than 0 so a phone bookmark and a QR code stay valid across restarts. */
export const DEFAULT_PHONE_PORT = 51841

/** How long a pairing code shown on the desktop stays redeemable. */
export const PHONE_PAIRING_TTL_MS = 10 * 60 * 1000

/**
 * 'network' listens on every interface of this machine so a phone on the same Wi-Fi can reach it;
 * 'tailscale' binds only this machine's tailnet address and fails closed when there is none, the
 * same rule remote control follows.
 */
export type PhoneExposure = 'network' | 'tailscale'

export interface PhoneAccessSettings {
  enabled: boolean
  exposure: PhoneExposure
  port: number
  /** Master switch for push notifications; each phone still opts in from its own settings. */
  notifications: boolean
  /**
   * Ask Tailscale for a publicly trusted certificate for this machine's MagicDNS name, so a phone
   * on the tailnet needs no certificate installed. Off by default because the request publishes
   * the machine name to public certificate-transparency logs, which is the owner's call to make.
   */
  tailscaleCertificate: boolean
}

export const DEFAULT_PHONE_SETTINGS: PhoneAccessSettings = {
  enabled: false,
  exposure: 'network',
  port: DEFAULT_PHONE_PORT,
  notifications: true,
  tailscaleCertificate: false
}

/** A paired phone as the desktop lists it. The token itself is never returned. */
export interface PhoneDevice {
  id: string
  name: string
  createdAt: string
  lastSeenAt: string | null
  userAgent: string
  /** The phone registered a push subscription and notifications are on for it. */
  pushEnabled: boolean
  /** Consecutive push deliveries the push service rejected; cleared on the next success. */
  pushFailures: number
  /** A live stream from that phone is open right now. */
  connected: boolean
}

export interface PhonePairingOffer {
  code: string
  /** The address to open on the phone; the code rides in the fragment so the QR does both. */
  url: string
  /** The https origin `url` names: one of PhoneAccessState.endpoints, chosen when the code was made. */
  endpoint: string
  expiresAt: string
}

/**
 * A phone-shaped node on this machine's tailnet, as `tailscale status` lists it. Used by the setup
 * steps to say "your iPhone joined the tailnet" without the phone having to talk to Conductor
 * first: a phone that installed Tailscale and signed in appears here before it ever opens the app.
 */
export interface PhoneTailnetPeer {
  hostName: string
  /** Lower-case OS word as Tailscale reports it: 'ios', 'android', 'windows', 'macos', 'linux'… */
  os: string
  online: boolean
  /** Tailnet IPv4 first. */
  addresses: string[]
}

/** The tailnet as the phone setup sees it; every field is a fact read from Tailscale, never a guess. */
export interface PhoneTailnetView {
  address: string | null
  dnsName: string | null
  /** Whether a Let's Encrypt certificate from Tailscale is serving the MagicDNS name. */
  certificate: 'off' | 'pending' | 'active' | 'failed'
  message: string | null
  /** The CLI was found on this machine. */
  installed: boolean
  /** Straight from `tailscale status --json`: Running, NeedsLogin, Stopped…; null when unknown. */
  backendState: string | null
  /** The account this machine is signed into, so the phone can be told which one to use. */
  loginName: string | null
  /**
   * Whether HTTPS certificates are enabled for the tailnet (Tailscale lists CertDomains only then).
   * null while Tailscale has not answered; false means the admin DNS page still needs the switch.
   */
  httpsEnabled: boolean | null
  /** Peers that look like phones or tablets (iOS, iPadOS, Android), any state. */
  phones: PhoneTailnetPeer[]
  /** When the tailnet was last read, ISO; null if never. */
  checkedAt: string | null
}

/** Where the Tailscale app for a phone lives; QR-encoded by the setup steps. */
export const TAILSCALE_APP_LINKS = {
  ios: 'https://apps.apple.com/app/tailscale/id1470499037',
  android: 'https://play.google.com/store/apps/details?id=com.tailscale.ipn',
  /** Tailscale's own chooser page, for a QR that should work on either platform. */
  any: 'https://tailscale.com/download'
} as const

/** The admin page where HTTPS certificates are switched on for a tailnet. */
export const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns'

/** What a phone opens to install the Conductor certificate: a page that hands off to Safari, then /ca.crt. */
export const trustPageUrl = (endpoint: string): string => `${endpoint.replace(/\/+$/, '')}/#trust`

/** Which of a phone's OS words count as a phone for the setup steps. */
export const isPhoneOs = (os: string): boolean => /^(ios|ipados|android)$/i.test(os.trim())

export interface PhoneAccessState {
  settings: PhoneAccessSettings
  listening: boolean
  /** Every https origin this listener answers on, best first: LAN address, tailnet address, MagicDNS name. */
  endpoints: string[]
  /** What the QR code and pairing URL name; null while not listening. */
  primaryEndpoint: string | null
  message: string | null
  /** SHA-256 of the certificate authority a phone installs once; colon-separated uppercase hex. */
  caFingerprint: string | null
  devices: PhoneDevice[]
  pairing: PhonePairingOffer | null
  /** False when the OS credential store is unavailable, in which case nothing can be served. */
  secureStorage: boolean
  tailscale: PhoneTailnetView
  /**
   * The origin a phone should keep: the tailnet one whenever this machine has a tailnet address
   * (it answers at home and away, as long as Tailscale is on), otherwise the first endpoint. The
   * MagicDNS name wins over the tailnet IP once a Tailscale certificate is active. Null while not
   * listening. This is the default `endpoint` for pair().
   */
  recommendedEndpoint: string | null
  /** Whether push keys exist, so the panel can say why a test notification cannot go out. */
  pushConfigured: boolean
}

/** What the renderer may ask the main process, exposed as window.conductor.phone. */
export interface PhoneAccessBridge {
  state(): Promise<PhoneAccessState>
  setSettings(patch: Partial<PhoneAccessSettings>): Promise<PhoneAccessState>
  /**
   * Creates (or refreshes) the single active pairing code and returns it in the state. `endpoint`
   * must be one of state.endpoints and names the origin the QR and URL carry; omitted, the
   * recommended endpoint is used.
   */
  pair(endpoint?: string): Promise<PhoneAccessState>
  cancelPairing(): Promise<PhoneAccessState>
  /**
   * Re-reads Tailscale (peers, HTTPS setting, address) and re-publishes the state without
   * restarting the listener; the setup steps' "Check again". Restarts the listener only if the
   * tailnet address it is bound to has changed.
   */
  check(): Promise<PhoneAccessState>
  revoke(deviceId: string): Promise<PhoneAccessState>
  rename(deviceId: string, name: string): Promise<PhoneAccessState>
  /** Saves the CA certificate through a native save dialog; null when the owner cancelled. */
  saveCertificate(): Promise<string | null>
  /** Sends a test push to one phone or to every phone with notifications on. */
  testNotification(deviceId?: string): Promise<{ sent: number; message: string | null }>
  onChanged(callback: (state: PhoneAccessState) => void): () => void
}

/* ------------------------------------------------------------------------- *
 * Wire contract for the phone web app.
 *
 * Every /api route except POST /api/pair requires `Authorization: Bearer <token>`; the token is
 * handed out once by pairing and stored by the app. A 401 means the token is no longer valid and
 * the app must go back to pairing. Bodies and replies are JSON; failures reply { error: string }.
 *
 *   POST /api/pair                        { code, name }            -> { token, device: PhoneSelf }
 *   GET  /api/me                                                    -> PhoneSelf
 *   POST /api/me                          { name }                  -> PhoneSelf
 *   POST /api/unpair                                                -> { ok: true }
 *   GET  /api/state                                                 -> PhoneState
 *   GET  /api/stream                      text/event-stream: `state` (PhoneState), `session`
 *                                         ({ id, sequence, phase }), `notification`
 *                                         (PhoneNotification), `ping`
 *   GET  /api/sessions/:id                                          -> PhoneConversation
 *   POST /api/sessions/:id/message        { text, mode? }           -> { phase, mode }
 *   POST /api/sessions/:id/respond        { requestId, decision?, answers? } -> { phase }
 *   POST /api/sessions/:id/interrupt                                -> { phase }
 *   POST /api/sessions/:id/resume                                   -> { phase }
 *   POST /api/tabs/open                   PhoneOpenTabRequest       -> PhoneOpenTabResult
 *   GET  /api/projects/:id/tasks?offset=&limit=                     -> PhoneProjectTaskPage
 *   POST /api/projects/:id/tasks          PhoneProjectTaskRequest   -> PhoneProjectTaskResult
 *   GET  /api/metrics                                               -> PhoneMetrics
 *   POST /api/push/subscribe              { subscription }          -> { ok: true }
 *   POST /api/push/unsubscribe                                      -> { ok: true }
 *   POST /api/push/test                                             -> { ok: true }
 *   POST /api/notifications               { prefs: PhoneNotificationPrefs } -> PhoneSelf
 *   GET  /api/health                      no auth                   -> PhoneHealth
 *   GET  /ca.crt                          the CA certificate, PEM, no auth
 *
 * Shell assets, all GET and unauthenticated: /, /index.html, /boot.js, /app.js, /app.css, /sw.js,
 * /manifest.webmanifest, /icon.svg, /icon-180.png, /icon-192.png, /icon-512.png.
 *
 * Hash routes the shell understands (no server round trip):
 *   #/                          the app (session list, or the pairing screen without a token)
 *   #pair=CODE                  pairing with the code filled in; the fragment is dropped at once
 *   #trust                      the certificate page: explains, hands off to Safari on iOS
 *                               (x-safari-https://), then links /ca.crt
 *   #diagnose                   the connection check page, also shown when the shell cannot boot
 * ------------------------------------------------------------------------- */

/**
 * The one unauthenticated JSON answer, for a phone to prove it is talking to Conductor at all:
 * the connection check calls it before anything else, and a failure here means TLS, address or
 * network, never pairing.
 */
export interface PhoneHealth {
  ok: true
  /** Conductor's package version. */
  version: string
  exposure: PhoneExposure
  /** ISO time on this machine. */
  at: string
  /** Whether the socket that asked came in over the tailnet. */
  viaTailscale: boolean
}

/**
 * Which notification categories this device wants, chosen on the phone and stored per device.
 * `taskDone` covers a controller or main (non-coworker) conversation finishing; `needsYou` covers
 * an approval, a question, or an error; `coworkerDone` covers a dispatched coworker finishing,
 * which is off by default since a controller already hears about it.
 */
export interface PhoneNotificationPrefs {
  taskDone: boolean
  needsYou: boolean
  coworkerDone: boolean
}

export const DEFAULT_PHONE_NOTIFICATION_PREFS: PhoneNotificationPrefs = { taskDone: true, needsYou: true, coworkerDone: false }

/** The phone's own record, as the app shows it in its settings. */
export interface PhoneSelf {
  id: string
  name: string
  machineName: string
  /** Base64url uncompressed P-256 public key for PushManager.subscribe, or null when push is off. */
  vapidPublicKey: string | null
  pushEnabled: boolean
  /** The desktop's master notification switch; the app explains itself when it is off. */
  notificationsAllowed: boolean
  notificationPrefs: PhoneNotificationPrefs
  version: string
}

/** The one word the list badge, the filter chips and a push notification all key on. */
export type PhoneSessionState = 'attention' | 'working' | 'limited' | 'failed' | 'disconnected' | 'stopped' | 'done' | 'idle'

/** A tool call the claude CLI's own auto-mode classifier refused: attention without a phase behind it. */
export interface PhoneAutoModeDenial { id: string; tool: string; reason: string }

export interface PhoneSessionSummary {
  id: string
  projectId: string
  projectName: string
  workspaceId: string
  workspaceName: string
  /** Null when the conversation is only in history, with no open tab. */
  tabId: string | null
  title: string
  provider: AgentProviderId
  model?: string
  effort?: string
  machineId: string
  machineName: string
  phase: SessionPhase
  activity: AgentActivityPhase
  state: PhoneSessionState
  /** What an 'attention' state is waiting for. */
  needs: 'approval' | 'question' | null
  /** The pending interaction's id, so a second question in a row still reads as new. */
  pendingId?: string
  pendingTitle?: string
  /** Classifier denials recorded in the conversation, oldest first; each is announced once. */
  autoModeDenials?: PhoneAutoModeDenial[]
  updatedAt: string
  /** The owner's most recent prompt in the running turn, for an elapsed-time label. */
  turnStartedAt?: string
  lastText?: string
  lastRole?: 'user' | 'assistant'
  limitResumeAt?: string
  backgroundTasks?: number
  queued: number
  archived: boolean
  /** Present when this conversation was opened and is controlled by another visible agent. */
  controllerId?: string
  usage?: { totalTokens?: number; costUsd?: number; estimated: boolean }
}

export interface PhoneUsageWindow {
  provider: StructuredProvider
  model?: string
  label: string
  kind: 'weekly' | 'short' | 'other'
  usedPercent: number
  resetsAt?: string
  reportedAt: string
}

export interface PhoneState {
  observedAt: string
  machineName: string
  projects: Array<{ id: string; name: string; machineId: string; workspaces: Array<{ id: string; name: string }> }>
  machines: Array<{ id: string; name: string; kind: 'local' | 'peer'; status: 'online' | 'offline' | 'revoked'; projectIds: string[] }>
  providers: Array<{ id: StructuredProvider; displayName: string; available: boolean; models: Array<{ id: string; label: string; effort?: string[]; defaultEffort?: string; isDefault?: boolean }> }>
  sessions: PhoneSessionSummary[]
  usage: PhoneUsageWindow[]
  /** Durable provider token reports from the rolling last seven days, grouped by exact model. */
  weeklyUsage: WeeklyModelUsageReport
  projectTaskMaxLength: number
  counts: { attention: number; working: number }
}

/** A timeline item as the phone shows it: same shape as the desktop's, with long text trimmed. */
export type PhoneTimelineItem = Pick<TimelineItem, 'id' | 'sequence' | 'timestamp' | 'parentId' | 'data'>

export interface PhoneConversation {
  summary: PhoneSessionSummary
  sequence: number
  items: PhoneTimelineItem[]
  pending: PendingInteraction[]
  queued: Array<{ id: string; text: string }>
  truncated: boolean
  /** The provider accepts a message into the running turn (Steer); otherwise it queues. */
  canSteer: boolean
  /** The conversation must be resumed before it takes a message. */
  needsResume: boolean
}

export type PhoneMessageMode = 'auto' | 'submit' | 'steer' | 'queue'

export interface PhoneOpenTabRequest {
  projectId: string
  workspaceId: string
  machineId: string
  provider: StructuredProvider
  model: string
  effort?: string
  title?: string
  /** Sent as the first message once the tab is open; omitted, the tab opens idle. */
  prompt?: string
}

export interface PhoneOpenTabResult {
  sessionId: string
  tabId: string
  machineId: string
  machineName: string
}

export interface PhoneProjectTaskRequest {
  title: string
  kind: ProjectTaskKind
  priority?: ProjectTaskPriority
  weight?: ProjectTaskWeight
}

export interface PhoneProjectTaskResult {
  id: string
  projectId: string
  title: string
  kind: ProjectTaskKind
  priority: ProjectTaskPriority
  weight: ProjectTaskWeight
}

export interface PhoneProjectTask {
  id: string
  title: string
  kind: ProjectTaskKind
  status: ProjectTaskStatus
  priority: ProjectTaskPriority
  weight: ProjectTaskWeight
}

export interface PhoneProjectTaskPage {
  projectId: string
  tasks: PhoneProjectTask[]
  page: { offset: number; limit: number; total: number; hasMore: boolean }
}

export interface PhoneRuntimeProcess extends RuntimeProcessSummary {
  projectName: string
  workspaceName: string
}

export interface PhoneMetrics {
  system: SystemMetricsSnapshot
  runtimes: PhoneRuntimeProcess[]
}

export type PhoneNotificationKind = 'attention' | 'done' | 'failed' | 'limited' | 'test'

export interface PhoneNotification {
  id: string
  kind: PhoneNotificationKind
  sessionId: string | null
  title: string
  body: string
  at: string
  /** Where a tap should land: the conversation, or the session list. */
  url: string
  /** A dispatched coworker's conversation rather than a controller or main task; drives which
   *  device wants a 'done' notification about it. Absent for kinds other than 'done'. */
  isCoworker?: boolean
}

/** What PushSubscription.toJSON() gives the app, stored per phone. */
export interface PhonePushSubscription {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export const PHONE_STATE_LIMITS = {
  /** Root timeline items a conversation reply carries; older ones are dropped, never trimmed mid-turn. */
  items: 120,
  textChars: 6000,
  toolOutputChars: 1200,
  toolInputChars: 800,
  previewChars: 200
} as const
