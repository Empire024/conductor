import type { PhoneAccessState, PhoneDevice, PhoneExposure, PhonePairingOffer, PhoneTailnetPeer, PhoneTailnetView } from '../../../shared/phone-access'
import { DEFAULT_PHONE_PORT } from '../../../shared/phone-access'

/**
 * The words and numbers the phone access panel puts on screen, kept away from the JSX.
 *
 * Every function here is a pure reading of state the main process already decided: none of them
 * guess whether the listener is up, whether a phone is reachable or whether push works. That
 * matters because these lines are the only place an owner learns why their phone cannot reach this
 * computer, and a helpful-sounding sentence invented in the renderer would be a lie about a thing
 * only the main process can know.
 */

/** Below 1024 a listener needs administrator rights on every platform we support. */
export const PHONE_PORT_MIN = 1024
export const PHONE_PORT_MAX = 65535

export type TailscaleCertificateState = PhoneAccessState['tailscale']['certificate']

/** What the status line under the master switch says, and how loudly. */
export interface PhoneStatusLine {
  kind: 'idle' | 'ok' | 'warning' | 'error'
  text: string
}

type StatusInput = Pick<PhoneAccessState, 'settings' | 'listening' | 'primaryEndpoint' | 'message' | 'secureStorage'> & {
  /** Optional because a main process older than the setup steps does not send it. */
  recommendedEndpoint?: string | null
}

/**
 * Where phone access stands in one line.
 *
 * Missing secure storage outranks everything else, including the switch being on: without the OS
 * credential store there is nowhere to keep the certificate key or a phone's token, so nothing is
 * served at all and saying "reachable at…" would be false. The address named is the one the phone
 * should keep, so the line and the address below it never disagree.
 */
export function accessStatus(state: StatusInput): PhoneStatusLine {
  if (!state.secureStorage) {
    return {
      kind: 'error',
      text: 'This computer has no available credential store, so the certificate and your phones’ tokens cannot be kept. Nothing is served until the OS keychain is unlocked.'
    }
  }
  if (!state.settings.enabled) return { kind: 'idle', text: '' }
  const endpoint = state.recommendedEndpoint ?? state.primaryEndpoint
  if (state.listening && endpoint) return { kind: 'ok', text: `Reachable at ${endpoint}` }
  return { kind: 'warning', text: state.message ?? 'Not listening yet.' }
}

/** The addresses worth showing small, beside the one the QR code names. */
export function otherEndpoints(endpoints: readonly string[], primary: string | null): string[] {
  return endpoints.filter(endpoint => endpoint !== primary)
}

/**
 * Eight bytes of the certificate authority's SHA-256, grouped in fours.
 *
 * Deliberately the same shortening the machines section uses for a device key: an owner comparing
 * what the phone shows with what this panel shows should be reading the same shape in both places.
 */
export function fingerprintGroups(value: string | null): string {
  return value ? value.replace(/:/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim() : ''
}

/** Where a phone downloads the certificate authority from; empty while there is no address. */
export function certificateUrl(primaryEndpoint: string | null): string {
  return primaryEndpoint ? `${primaryEndpoint.replace(/\/+$/, '')}/ca.crt` : ''
}

/** What choosing this exposure means for who can reach this computer, in the owner's terms. */
export function exposureExplanation(exposure: PhoneExposure, tailscale: Pick<PhoneAccessState['tailscale'], 'address' | 'dnsName'>): string {
  if (exposure === 'network') {
    return 'Any phone on the same Wi-Fi can reach this computer. It still has to be paired here before it sees anything.'
  }
  const address = tailscale.dnsName ?? tailscale.address
  return address
    ? `Only phones signed into your tailnet reach this computer, at ${address}.`
    : 'This computer has no Tailscale address, so nothing is served at all until Tailscale is signed in. Nothing falls back to your network.'
}

/** The one word for a Tailscale certificate's state; the message beside it carries the detail. */
export function tailscaleCertificateWord(status: TailscaleCertificateState): string {
  if (status === 'active') return 'Active'
  if (status === 'pending') return 'Being issued'
  if (status === 'failed') return 'Failed'
  return 'Off'
}

/**
 * How long ago a phone was last heard from.
 *
 * A phone that has never checked in says so rather than reading as "0 min ago", because the two
 * mean different things when the owner is working out whether pairing actually finished.
 */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'not seen yet'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 'not seen yet'
  // A phone's clock is not this computer's clock, so a timestamp slightly in the future is skew,
  // not a reason to print a negative age.
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** The pairing code's remaining life; empty once it is spent, so the caller hides the line. */
export function countdownText(expiresAt: string, now: number): string {
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return ''
  const left = Math.floor((at - now) / 1000)
  if (left <= 0) return ''
  return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** Why a typed port cannot be used; empty when it can. */
export function portProblem(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return `A port is needed. The default is ${DEFAULT_PHONE_PORT}.`
  if (!/^\d+$/.test(trimmed)) return `A port is a plain number between ${PHONE_PORT_MIN} and ${PHONE_PORT_MAX}.`
  const port = Number(trimmed)
  if (port < PHONE_PORT_MIN || port > PHONE_PORT_MAX) {
    return `Pick a port between ${PHONE_PORT_MIN} and ${PHONE_PORT_MAX}. Lower ports need administrator rights.`
  }
  return ''
}

/** The port to save, or null when the box does not hold a usable one. */
export function parsePort(value: string): number | null {
  return portProblem(value) ? null : Number(value.trim())
}

/** Whether a typed port is worth sending: usable, and not the one already saved. */
export function portToCommit(value: string, current: number): number | null {
  const port = parsePort(value)
  return port === null || port === current ? null : port
}

/** Whether this phone is set up to be notified, said the way the phone's own settings say it. */
export function notificationLabel(device: Pick<PhoneDevice, 'pushEnabled'>): string {
  return device.pushEnabled ? 'notifications on' : 'notifications off'
}

/**
 * What repeated push rejections mean for this phone; empty while there are none.
 *
 * Failures are the owner's business rather than a detail to swallow: a push service drops a
 * subscription permanently, and the only fix is on the phone, so silence here would leave them
 * believing a phone is still being notified when it stopped being days ago.
 */
export function pushFailureWarning(device: Pick<PhoneDevice, 'pushFailures'>): string {
  if (device.pushFailures <= 0) return ''
  const tries = `${device.pushFailures} notification${device.pushFailures === 1 ? '' : 's'} in a row`
  return `${tries} came back rejected. Open Conductor on that phone once to register it again.`
}

/** What a test notification did, including the case where it went nowhere. */
export function testResultText(result: { sent: number; message: string | null }): string {
  if (result.sent > 0) {
    return `Sent to ${result.sent} phone${result.sent === 1 ? '' : 's'}.${result.message ? ` ${result.message}` : ''}`
  }
  return result.message ?? 'Nothing was sent. That phone has not turned notifications on for itself yet.'
}

/** A renamed phone keeps its old name when the box is left empty, rather than losing it. */
export function renameToCommit(draft: string, current: string): string | null {
  const name = draft.trim().slice(0, 60)
  return !name || name === current ? null : name
}

/* ------------------------------------------------------------------------- *
 * The guided setup: four steps, each with a status read from PhoneAccessState.
 *
 * A step is 'done' only on a fact the main process reported (a phone on the tailnet, an active
 * certificate, a new paired device, a push subscription). Anything this computer cannot observe
 * stays 'waiting' and says what would count as done, because a green chip that is wrong sends the
 * owner looking for a fault in the wrong place.
 * ------------------------------------------------------------------------- */

export type SetupStepState = 'waiting' | 'done' | 'problem'

export interface SetupStepStatus {
  state: SetupStepState
  /** The fact behind the chip, in one sentence. */
  text: string
  /** What to do about it; present for problems and for waits the owner can act on. */
  fix?: string
}

/** The chip's word. */
export function stepStateWord(state: SetupStepState): string {
  if (state === 'done') return 'Done'
  if (state === 'problem') return 'Needs a fix'
  return 'Waiting'
}

/**
 * The tailnet view with every field present.
 *
 * A running main process older than the setup steps sends only address, dnsName, certificate and
 * message. The missing fields read as "never checked", which is what they are, rather than as an
 * empty tailnet or a missing install.
 */
export function tailnetOf(tailscale: Partial<PhoneTailnetView> | null | undefined): PhoneTailnetView {
  const view = tailscale ?? {}
  return {
    address: view.address ?? null,
    dnsName: view.dnsName ?? null,
    certificate: view.certificate ?? 'off',
    message: view.message ?? null,
    installed: view.installed ?? false,
    backendState: view.backendState ?? null,
    loginName: view.loginName ?? null,
    httpsEnabled: view.httpsEnabled ?? null,
    phones: Array.isArray(view.phones) ? view.phones : [],
    checkedAt: view.checkedAt ?? null
  }
}

/** The address a phone should keep; the first endpoint when the main process does not name one. */
export function recommendedEndpointOf(state: Pick<PhoneAccessState, 'listening' | 'endpoints' | 'primaryEndpoint'> & { recommendedEndpoint?: string | null }): string | null {
  if (!state.listening) return null
  return state.recommendedEndpoint ?? state.primaryEndpoint ?? state.endpoints[0] ?? null
}

/** The host of an https origin, lower case and without IPv6 brackets; empty when unreadable. */
export function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { return '' }
}

/** Tailscale hands out 100.64.0.0/10 and fd7a:115c:a1e0::/48, and nothing else. */
const isTailnetAddress = (host: string): boolean => {
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) { const second = Number(v4[1]); return second >= 64 && second <= 127 }
  return host.startsWith('fd7a:115c:a1e0:')
}

type TailnetNames = Pick<PhoneTailnetView, 'address' | 'dnsName'>

/** Whether a phone reaches this origin through Tailscale, so it answers away from home too. */
export function isTailnetEndpoint(endpoint: string, tailnet: TailnetNames): boolean {
  const host = endpointHost(endpoint)
  if (!host) return false
  if (tailnet.dnsName && host === tailnet.dnsName.toLowerCase().replace(/\.$/, '')) return true
  if (tailnet.address && host === tailnet.address.toLowerCase()) return true
  return isTailnetAddress(host)
}

/** Why the owner should keep this address, in one sentence. */
export function recommendedEndpointSentence(endpoint: string | null, tailnet: TailnetNames): string {
  if (!endpoint) return ''
  return isTailnetEndpoint(endpoint, tailnet)
    ? 'Keep this address on your phone. It works at home and away while Tailscale is on.'
    : 'Keep this address on your phone. It works only on this network until Tailscale is set up in step 1.'
}

/** How the pairing step names an address. */
export function endpointLabel(endpoint: string, tailnet: TailnetNames): string {
  const host = endpointHost(endpoint)
  if (tailnet.dnsName && host === tailnet.dnsName.toLowerCase().replace(/\.$/, '')) return 'Tailscale name, works anywhere'
  if (isTailnetEndpoint(endpoint, tailnet)) return 'Tailscale, works anywhere'
  return 'This Wi-Fi only'
}

export interface EndpointChoice {
  endpoint: string
  label: string
  recommended: boolean
}

/** The addresses a pairing code may name, the recommended one first, each once. */
export function endpointChoices(endpoints: readonly string[], recommended: string | null, tailnet: TailnetNames): EndpointChoice[] {
  const ordered = recommended && endpoints.includes(recommended) ? [recommended, ...endpoints] : [...endpoints]
  return [...new Set(ordered)].map(endpoint => ({ endpoint, label: endpointLabel(endpoint, tailnet), recommended: endpoint === recommended }))
}

/** The address the pairing step will use: the owner's pick while it still exists, else the recommended one. */
export function chosenEndpoint(chosen: string | null, endpoints: readonly string[], recommended: string | null): string | null {
  if (chosen && endpoints.includes(chosen)) return chosen
  return recommended && endpoints.includes(recommended) ? recommended : endpoints[0] ?? null
}

const OS_NAMES: Record<string, string> = { ios: 'iOS', ipados: 'iPadOS', android: 'Android' }

/** Tailscale's OS word as the owner would write it. */
export function osName(os: string): string {
  const word = os.trim().toLowerCase()
  return OS_NAMES[word] ?? (os.trim() || 'unknown OS')
}

/** Online phones first, so the one the owner is holding is the one named. */
const byOnline = (phones: readonly PhoneTailnetPeer[]): PhoneTailnetPeer[] => [...phones].sort((a, b) => Number(b.online) - Number(a.online))

/** Which phones are on the tailnet, in one sentence; empty when none are. */
export function tailnetPhonesSummary(phones: readonly PhoneTailnetPeer[]): string {
  if (!phones.length) return ''
  const sorted = byOnline(phones)
  const one = (phone: PhoneTailnetPeer): string => `${phone.hostName} (${osName(phone.os)}, ${phone.online ? 'online' : 'offline'})`
  if (sorted.length === 1) return `${one(sorted[0]!)} is on your tailnet.`
  if (sorted.length <= 3) return `${sorted.slice(0, -1).map(one).join(', ')} and ${one(sorted[sorted.length - 1]!)} are on your tailnet.`
  return `${one(sorted[0]!)} and ${sorted.length - 1} more phones are on your tailnet.`
}

/** When the tailnet was last read, for the line beside "Check again". */
export function checkedText(checkedAt: string | null, now: number): string {
  return checkedAt ? `Checked ${relativeTime(checkedAt, now)}` : 'Not checked yet'
}

/**
 * What stops Tailscale on this computer from carrying a phone at all; null when nothing does.
 *
 * Every branch names the fix, because the owner reading this is looking at the one computer where
 * it can be fixed.
 */
export function tailscaleHereProblem(tailnet: Pick<PhoneTailnetView, 'installed' | 'backendState' | 'checkedAt'>): SetupStepStatus | null {
  if (!tailnet.checkedAt && !tailnet.installed) return null
  if (!tailnet.installed) {
    return { state: 'problem', text: 'Tailscale is not installed on this computer.', fix: 'Install it from tailscale.com/download, sign in, then check again.' }
  }
  const backend = tailnet.backendState
  if (backend === 'Running') return null
  if (backend === 'Starting') return { state: 'waiting', text: 'Tailscale is starting on this computer.', fix: 'Check again in a moment.' }
  if (backend === 'NeedsLogin') return { state: 'problem', text: 'Tailscale is signed out on this computer.', fix: 'Open Tailscale here and sign in, then check again.' }
  if (backend === 'NeedsMachineAuth') return { state: 'problem', text: 'This computer is waiting for approval on your tailnet.', fix: 'Approve it in the Tailscale admin console, then check again.' }
  if (backend === 'Stopped') return { state: 'problem', text: 'Tailscale is turned off on this computer.', fix: 'Open Tailscale here and connect, then check again.' }
  if (backend) return { state: 'problem', text: `Tailscale on this computer reports "${backend}".`, fix: 'Open Tailscale here and connect, then check again.' }
  return { state: 'problem', text: 'Tailscale is installed on this computer but did not answer.', fix: 'Open Tailscale here, then check again.' }
}

/** Step 1: is a phone on the tailnet? */
export function phoneTailscaleStep(tailnet: PhoneTailnetView): SetupStepStatus {
  const here = tailscaleHereProblem(tailnet)
  if (here) return here
  if (!tailnet.checkedAt) return { state: 'waiting', text: 'Tailscale has not been read yet.', fix: 'Press Check again.' }
  if (tailnet.phones.length) return { state: 'done', text: tailnetPhonesSummary(tailnet.phones) }
  return { state: 'waiting', text: 'No phone has joined your tailnet yet.', fix: 'Sign in on the phone, keep Tailscale on, then check again.' }
}

/**
 * Step 2, the recommended way: a Tailscale certificate on the MagicDNS name.
 *
 * The certificate's own state comes first because it is the outcome; the HTTPS switch and the
 * setting only explain why there is no outcome yet.
 */
export function tailscaleCertificateStep(tailnet: PhoneTailnetView, wanted: boolean): SetupStepStatus {
  if (tailnet.certificate === 'active') {
    return { state: 'done', text: `Tailscale's certificate serves ${tailnet.dnsName ?? 'this computer'}. The phone needs nothing installed.` }
  }
  if (tailnet.certificate === 'failed') {
    return { state: 'problem', text: 'Tailscale did not issue the certificate.', fix: tailnet.message ?? 'Check again, or use the Conductor certificate below.' }
  }
  if (tailnet.certificate === 'pending') return { state: 'waiting', text: 'Tailscale is issuing the certificate.' }
  const here = tailscaleHereProblem(tailnet)
  if (here) return { state: 'waiting', text: 'Tailscale has to run on this computer first (step 1).' }
  if (tailnet.httpsEnabled === false) {
    return { state: 'problem', text: 'HTTPS certificates are off for your tailnet.', fix: 'Turn on HTTPS Certificates on the Tailscale DNS page, then check again.' }
  }
  if (tailnet.httpsEnabled === null) return { state: 'waiting', text: 'Whether your tailnet allows HTTPS certificates is not read yet.', fix: 'Press Check again.' }
  if (!wanted) return { state: 'waiting', text: 'HTTPS certificates are on for your tailnet.', fix: 'Turn on the switch below to get one.' }
  if (!tailnet.dnsName) return { state: 'problem', text: tailnet.message ?? 'This computer has no MagicDNS name yet, so no certificate can be requested.', fix: 'Turn on MagicDNS on the Tailscale DNS page, then check again.' }
  return { state: 'waiting', text: 'Conductor asks Tailscale for the certificate while phone access is on.', fix: tailnet.message ?? undefined }
}

/** The paired phone added last. */
export function newestDevice<T extends Pick<PhoneDevice, 'createdAt'>>(devices: readonly T[]): T | null {
  let newest: T | null = null
  for (const device of devices) if (!newest || Date.parse(device.createdAt) > Date.parse(newest.createdAt)) newest = device
  return newest
}

/**
 * Step 3: has a phone paired?
 *
 * Done only for a device that was not there when the panel opened: a phone paired last month may
 * be holding an address that no longer answers, which is the very case this setup exists for.
 * `known` is null until the first state arrived, when nothing can be new yet.
 */
export function pairStepStatus(
  devices: readonly Pick<PhoneDevice, 'id' | 'name' | 'createdAt'>[],
  known: ReadonlySet<string> | null,
  pairing: Pick<PhonePairingOffer, 'code'> | null,
  listening: boolean
): SetupStepStatus {
  const fresh = known ? devices.filter(device => !known.has(device.id)) : []
  const newest = newestDevice(fresh)
  if (newest) return { state: 'done', text: `${newest.name} is paired.` }
  if (!listening) return { state: 'waiting', text: 'A pairing code can only be shown while this computer is listening.', fix: 'Turn on phone access at the top.' }
  if (pairing) return { state: 'waiting', text: 'Waiting for the phone to use the code.' }
  const before = newestDevice(devices)
  if (before) return { state: 'waiting', text: `${before.name} was paired before.`, fix: 'Pair again if it opens at a different address now.' }
  return { state: 'waiting', text: 'No phone is paired yet.' }
}

/** Step 4: is a phone set up to be notified? */
export function notificationStep(
  devices: readonly Pick<PhoneDevice, 'id' | 'name' | 'createdAt' | 'pushEnabled'>[],
  notifications: boolean,
  pushConfigured: boolean
): SetupStepStatus {
  const notified = newestDevice(devices.filter(device => device.pushEnabled))
  if (!notifications) return { state: 'problem', text: 'Push notifications are off for every phone.', fix: 'Turn on Send push notifications under Advanced.' }
  if (notified) return { state: 'done', text: `Notifications are on for ${notified.name}.` }
  const newest = newestDevice(devices)
  if (!newest) return { state: 'waiting', text: 'Pair a phone first (step 3).' }
  if (!pushConfigured) return { state: 'waiting', text: 'The push keys are made when this computer starts listening.' }
  return { state: 'waiting', text: `${newest.name} has not turned notifications on yet.` }
}

/** The phone a test notification in step 4 goes to: the newest one that can receive it, else the newest. */
export function notificationTarget<T extends Pick<PhoneDevice, 'createdAt' | 'pushEnabled'>>(devices: readonly T[]): T | null {
  return newestDevice(devices.filter(device => device.pushEnabled)) ?? newestDevice(devices)
}
