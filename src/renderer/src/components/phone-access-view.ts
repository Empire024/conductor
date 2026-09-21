import type { PhoneAccessState, PhoneDevice, PhoneExposure } from '../../../shared/phone-access'
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

type StatusInput = Pick<PhoneAccessState, 'settings' | 'listening' | 'primaryEndpoint' | 'message' | 'secureStorage'>

/**
 * Where phone access stands in one line.
 *
 * Missing secure storage outranks everything else, including the switch being on: without the OS
 * credential store there is nowhere to keep the certificate key or a phone's token, so nothing is
 * served at all and saying "reachable at…" would be false.
 */
export function accessStatus(state: StatusInput): PhoneStatusLine {
  if (!state.secureStorage) {
    return {
      kind: 'error',
      text: 'This computer has no available credential store, so the certificate and your phones’ tokens cannot be kept. Nothing is served until the OS keychain is unlocked.'
    }
  }
  if (!state.settings.enabled) return { kind: 'idle', text: '' }
  if (state.listening && state.primaryEndpoint) return { kind: 'ok', text: `Reachable at ${state.primaryEndpoint}` }
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
