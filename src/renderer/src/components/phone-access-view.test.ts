import { describe, expect, it } from 'vitest'
import { DEFAULT_PHONE_SETTINGS } from '../../../shared/phone-access'
import type { PhoneAccessSettings } from '../../../shared/phone-access'
import {
  accessStatus,
  certificateUrl,
  countdownText,
  exposureExplanation,
  fingerprintGroups,
  notificationLabel,
  otherEndpoints,
  parsePort,
  portProblem,
  portToCommit,
  pushFailureWarning,
  relativeTime,
  renameToCommit,
  tailscaleCertificateWord,
  testResultText
} from './phone-access-view'

const settings = (patch: Partial<PhoneAccessSettings> = {}): PhoneAccessSettings => ({ ...DEFAULT_PHONE_SETTINGS, ...patch })
const status = (patch: Partial<Parameters<typeof accessStatus>[0]> = {}): Parameters<typeof accessStatus>[0] => ({
  settings: settings({ enabled: true }), listening: true, primaryEndpoint: 'https://192.168.1.4:51841', message: null, secureStorage: true, ...patch
})

describe('the status line under the phone access switch', () => {
  it('names the address a phone should open while the listener is up', () => {
    expect(accessStatus(status())).toEqual({ kind: 'ok', text: 'Reachable at https://192.168.1.4:51841' })
  })

  it('says nothing at all while the owner has phone access switched off', () => {
    expect(accessStatus(status({ settings: settings({ enabled: false }) }))).toEqual({ kind: 'idle', text: '' })
  })

  it('passes on the main process’s own reason when it is on but not listening', () => {
    expect(accessStatus(status({ listening: false, primaryEndpoint: null, message: 'Port 51841 is already in use.' })))
      .toEqual({ kind: 'warning', text: 'Port 51841 is already in use.' })
    // No message is still not a claim that it works.
    expect(accessStatus(status({ listening: false, primaryEndpoint: null })).kind).toBe('warning')
  })

  it('reports the missing credential store above everything else, including the switch', () => {
    const locked = accessStatus(status({ secureStorage: false }))
    expect(locked.kind).toBe('error')
    expect(locked.text).toContain('credential store')
    // Even switched off, because turning it on would not help until the keychain is unlocked.
    expect(accessStatus(status({ secureStorage: false, settings: settings({ enabled: false }) })).kind).toBe('error')
  })
})

describe('the addresses and the certificate link', () => {
  it('lists every address but the one the pairing code already names', () => {
    const endpoints = ['https://192.168.1.4:51841', 'https://100.84.2.9:51841', 'https://desk.tail1234.ts.net:51841']
    expect(otherEndpoints(endpoints, 'https://192.168.1.4:51841')).toEqual(['https://100.84.2.9:51841', 'https://desk.tail1234.ts.net:51841'])
    expect(otherEndpoints(endpoints, null)).toEqual(endpoints)
    expect(otherEndpoints([], 'https://192.168.1.4:51841')).toEqual([])
  })

  it('hangs the certificate download off the address without doubling the slash', () => {
    expect(certificateUrl('https://192.168.1.4:51841')).toBe('https://192.168.1.4:51841/ca.crt')
    expect(certificateUrl('https://192.168.1.4:51841/')).toBe('https://192.168.1.4:51841/ca.crt')
    expect(certificateUrl(null)).toBe('')
  })

  it('groups the certificate fingerprint the way the machines section groups a device key', () => {
    expect(fingerprintGroups('AB:CD:EF:01:23:45:67:89:AA:BB:CC:DD:EE:FF:00:11')).toBe('ABCD EF01 2345 6789')
    expect(fingerprintGroups(null)).toBe('')
  })
})

describe('what an exposure choice means', () => {
  it('says the local network is enough on "this network"', () => {
    expect(exposureExplanation('network', { address: null, dnsName: null })).toContain('same Wi-Fi')
  })

  it('names the tailnet address a phone will use, preferring the name over the number', () => {
    expect(exposureExplanation('tailscale', { address: '100.84.2.9', dnsName: 'desk.tail1234.ts.net' })).toContain('desk.tail1234.ts.net')
    expect(exposureExplanation('tailscale', { address: '100.84.2.9', dnsName: null })).toContain('100.84.2.9')
  })

  it('says outright that nothing is served when Tailscale is chosen without a tailnet address', () => {
    const explanation = exposureExplanation('tailscale', { address: null, dnsName: null })
    expect(explanation).toContain('nothing is served')
    expect(explanation).toContain('Nothing falls back to your network.')
  })

  it('has a word for every state a Tailscale certificate can be in', () => {
    expect(tailscaleCertificateWord('off')).toBe('Off')
    expect(tailscaleCertificateWord('pending')).toBe('Being issued')
    expect(tailscaleCertificateWord('active')).toBe('Active')
    expect(tailscaleCertificateWord('failed')).toBe('Failed')
  })
})

describe('time as the panel shows it', () => {
  const now = Date.parse('2026-09-21T12:00:00.000Z')
  const ago = (ms: number): string => relativeTime(new Date(now - ms).toISOString(), now)

  it('ages a phone’s last contact in the owner’s units', () => {
    expect(ago(4_000)).toBe('just now')
    expect(ago(50_000)).toBe('1 min ago')
    expect(ago(2 * 60_000)).toBe('2 min ago')
    expect(ago(59 * 60_000)).toBe('59 min ago')
    expect(ago(90 * 60_000)).toBe('1 hr ago')
    expect(ago(26 * 3600_000)).toBe('1 day ago')
    expect(ago(3 * 86_400_000)).toBe('3 days ago')
  })

  it('distinguishes a phone that has never checked in from one seen a moment ago', () => {
    expect(relativeTime(null, now)).toBe('not seen yet')
    expect(relativeTime('not a date', now)).toBe('not seen yet')
  })

  it('treats a phone clock running ahead as skew rather than printing a negative age', () => {
    expect(relativeTime(new Date(now + 30_000).toISOString(), now)).toBe('just now')
  })

  it('counts the pairing code down to the second and then says nothing', () => {
    const expires = (seconds: number): string => countdownText(new Date(now + seconds * 1000).toISOString(), now)
    expect(expires(582)).toBe('Expires in 9:42')
    expect(expires(60)).toBe('Expires in 1:00')
    expect(expires(9)).toBe('Expires in 0:09')
    // Past its life the line disappears instead of counting backwards.
    expect(expires(0)).toBe('')
    expect(expires(-30)).toBe('')
    expect(countdownText('not a date', now)).toBe('')
  })
})

describe('the port box', () => {
  it('accepts a port a listener may actually bind without administrator rights', () => {
    expect(portProblem('51841')).toBe('')
    expect(portProblem(' 1024 ')).toBe('')
    expect(portProblem('65535')).toBe('')
    expect(parsePort(' 51841 ')).toBe(51841)
  })

  it('refuses everything else, and says which range is allowed', () => {
    expect(portProblem('')).toContain('51841')
    expect(portProblem('80')).toContain('1024')
    expect(portProblem('65536')).toContain('65535')
    expect(portProblem('51841.5')).toContain('plain number')
    expect(portProblem('abc')).toContain('plain number')
    expect(parsePort('80')).toBeNull()
    expect(parsePort('')).toBeNull()
  })

  it('sends nothing when the box still holds the saved port, so a blur is not a restart', () => {
    expect(portToCommit('51841', 51841)).toBeNull()
    expect(portToCommit('51999', 51841)).toBe(51999)
    expect(portToCommit('70000', 51841)).toBeNull()
  })
})

describe('what each paired phone reads as', () => {
  it('says whether that phone is set up to be notified', () => {
    expect(notificationLabel({ pushEnabled: true })).toBe('notifications on')
    expect(notificationLabel({ pushEnabled: false })).toBe('notifications off')
  })

  it('warns once a push service has been rejecting deliveries, and stays quiet otherwise', () => {
    expect(pushFailureWarning({ pushFailures: 0 })).toBe('')
    expect(pushFailureWarning({ pushFailures: 1 })).toContain('1 notification in a row')
    expect(pushFailureWarning({ pushFailures: 4 })).toContain('4 notifications in a row')
  })

  it('reports a test notification, including when it reached nobody', () => {
    expect(testResultText({ sent: 1, message: null })).toBe('Sent to 1 phone.')
    expect(testResultText({ sent: 2, message: null })).toBe('Sent to 2 phones.')
    expect(testResultText({ sent: 1, message: 'Delivered in 120 ms.' })).toBe('Sent to 1 phone. Delivered in 120 ms.')
    expect(testResultText({ sent: 0, message: 'Push keys are not set up yet.' })).toBe('Push keys are not set up yet.')
    expect(testResultText({ sent: 0, message: null })).toContain('Nothing was sent')
  })

  it('keeps the old name when a rename is left empty or unchanged', () => {
    expect(renameToCommit('  Work iPhone  ', 'iPhone')).toBe('Work iPhone')
    expect(renameToCommit('   ', 'iPhone')).toBeNull()
    expect(renameToCommit('iPhone', 'iPhone')).toBeNull()
    expect(renameToCommit('x'.repeat(80), 'iPhone')).toHaveLength(60)
  })
})
