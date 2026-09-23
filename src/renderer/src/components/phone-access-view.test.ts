import { describe, expect, it } from 'vitest'
import { DEFAULT_PHONE_SETTINGS } from '../../../shared/phone-access'
import type { PhoneAccessSettings, PhoneTailnetPeer, PhoneTailnetView } from '../../../shared/phone-access'
import {
  accessStatus,
  certificateUrl,
  checkedText,
  chosenEndpoint,
  endpointChoices,
  endpointLabel,
  isTailnetEndpoint,
  newestDevice,
  notificationStep,
  notificationTarget,
  osName,
  pairStepStatus,
  phoneTailscaleStep,
  recommendedEndpointOf,
  recommendedEndpointSentence,
  stepStateWord,
  tailnetOf,
  tailnetPhonesSummary,
  tailscaleCertificateStep,
  tailscaleHereProblem,
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

  it('names the address the phone should keep once the main process recommends one', () => {
    expect(accessStatus(status({ recommendedEndpoint: 'https://100.84.2.9:51841' })).text).toBe('Reachable at https://100.84.2.9:51841')
    // An older main process sends no recommendation at all; the first address still stands.
    expect(accessStatus(status({ recommendedEndpoint: undefined })).text).toBe('Reachable at https://192.168.1.4:51841')
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

const LAN = 'https://192.168.0.205:51841'
const TAILNET_IP = 'https://100.72.193.87:51841'
const MAGIC = 'https://e-box.tail8216c8.ts.net:51841'
const iphone = (patch: Partial<PhoneTailnetPeer> = {}): PhoneTailnetPeer => ({ hostName: 'juraj-iphone', os: 'ios', online: true, addresses: ['100.101.1.2'], ...patch })
const tailnet = (patch: Partial<PhoneTailnetView> = {}): PhoneTailnetView => ({
  address: '100.72.193.87', dnsName: 'e-box.tail8216c8.ts.net', certificate: 'off', message: null, installed: true, backendState: 'Running',
  loginName: 'owner@github', httpsEnabled: false, phones: [], checkedAt: '2026-09-23T10:00:00.000Z', ...patch
})
const device = (id: string, createdAt: string, patch: { name?: string; pushEnabled?: boolean } = {}): { id: string; name: string; createdAt: string; pushEnabled: boolean } =>
  ({ id, name: patch.name ?? id, createdAt, pushEnabled: patch.pushEnabled ?? false })

describe('the tailnet as an older main process reports it', () => {
  it('fills every missing field with "not read yet" rather than an empty or broken tailnet', () => {
    const view = tailnetOf({ address: '100.72.193.87', dnsName: null, certificate: 'off', message: null })
    expect(view).toMatchObject({ installed: false, backendState: null, loginName: null, httpsEnabled: null, phones: [], checkedAt: null })
    expect(tailnetOf(undefined).certificate).toBe('off')
    // Never read is not a problem to fix; it is a reading to take.
    expect(phoneTailscaleStep(view)).toMatchObject({ state: 'waiting', text: 'Tailscale has not been read yet.' })
  })

  it('keeps the recommended address, or falls back to the first one, and names none while not listening', () => {
    expect(recommendedEndpointOf({ listening: true, endpoints: [LAN, TAILNET_IP], primaryEndpoint: LAN, recommendedEndpoint: TAILNET_IP })).toBe(TAILNET_IP)
    expect(recommendedEndpointOf({ listening: true, endpoints: [LAN, TAILNET_IP], primaryEndpoint: LAN })).toBe(LAN)
    expect(recommendedEndpointOf({ listening: false, endpoints: [], primaryEndpoint: null, recommendedEndpoint: null })).toBeNull()
  })
})

describe('the addresses a phone can keep', () => {
  it('knows a tailnet address by its name, its number or Tailscale’s ranges', () => {
    expect(isTailnetEndpoint(MAGIC, tailnet())).toBe(true)
    expect(isTailnetEndpoint(TAILNET_IP, tailnet({ address: null, dnsName: null }))).toBe(true)
    expect(isTailnetEndpoint('https://[fd7a:115c:a1e0::1]:51841', tailnet({ address: null, dnsName: null }))).toBe(true)
    expect(isTailnetEndpoint(LAN, tailnet())).toBe(false)
    // 100.x outside 100.64.0.0/10 is somebody's public address, not the tailnet.
    expect(isTailnetEndpoint('https://100.20.1.1:51841', tailnet({ address: null, dnsName: null }))).toBe(false)
    expect(isTailnetEndpoint('not a url', tailnet())).toBe(false)
  })

  it('says why to keep the address, and that a Wi-Fi one stops working away from home', () => {
    expect(recommendedEndpointSentence(TAILNET_IP, tailnet())).toContain('works at home and away while Tailscale is on')
    expect(recommendedEndpointSentence(LAN, tailnet())).toContain('only on this network')
    expect(recommendedEndpointSentence(null, tailnet())).toBe('')
  })

  it('labels each pairing address by where it works, the recommended one first', () => {
    expect(endpointLabel(TAILNET_IP, tailnet())).toBe('Tailscale, works anywhere')
    expect(endpointLabel(MAGIC, tailnet())).toBe('Tailscale name, works anywhere')
    expect(endpointLabel(LAN, tailnet())).toBe('This Wi-Fi only')
    expect(endpointChoices([LAN, TAILNET_IP, MAGIC], TAILNET_IP, tailnet())).toEqual([
      { endpoint: TAILNET_IP, label: 'Tailscale, works anywhere', recommended: true },
      { endpoint: LAN, label: 'This Wi-Fi only', recommended: false },
      { endpoint: MAGIC, label: 'Tailscale name, works anywhere', recommended: false }
    ])
    // A recommendation the listener no longer answers on is not offered.
    expect(endpointChoices([LAN], TAILNET_IP, tailnet()).map(choice => choice.endpoint)).toEqual([LAN])
  })

  it('keeps the owner’s pick of address only while the listener still answers on it', () => {
    expect(chosenEndpoint(LAN, [LAN, TAILNET_IP], TAILNET_IP)).toBe(LAN)
    expect(chosenEndpoint('https://10.0.0.9:51841', [LAN, TAILNET_IP], TAILNET_IP)).toBe(TAILNET_IP)
    expect(chosenEndpoint(null, [LAN], null)).toBe(LAN)
    expect(chosenEndpoint(null, [], null)).toBeNull()
  })
})

describe('step 1: Tailscale on the phone', () => {
  it('is done once a phone is on the tailnet, naming it and whether it is online', () => {
    const step = phoneTailscaleStep(tailnet({ phones: [iphone()] }))
    expect(step.state).toBe('done')
    expect(step.text).toBe('juraj-iphone (iOS, online) is on your tailnet.')
  })

  it('waits while no phone has joined', () => {
    expect(phoneTailscaleStep(tailnet())).toMatchObject({ state: 'waiting', text: 'No phone has joined your tailnet yet.' })
  })

  it('names what is wrong with Tailscale on this computer, with the fix', () => {
    expect(tailscaleHereProblem(tailnet())).toBeNull()
    expect(tailscaleHereProblem(tailnet({ installed: false, backendState: null }))).toMatchObject({ state: 'problem', text: 'Tailscale is not installed on this computer.' })
    expect(tailscaleHereProblem(tailnet({ backendState: 'NeedsLogin' }))?.fix).toContain('sign in')
    expect(tailscaleHereProblem(tailnet({ backendState: 'Stopped' }))?.text).toContain('turned off')
    expect(tailscaleHereProblem(tailnet({ backendState: 'NeedsMachineAuth' }))?.fix).toContain('admin console')
    expect(tailscaleHereProblem(tailnet({ backendState: 'Starting' }))?.state).toBe('waiting')
    expect(tailscaleHereProblem(tailnet({ backendState: 'Weird' }))?.text).toContain('"Weird"')
    expect(tailscaleHereProblem(tailnet({ backendState: null }))?.text).toContain('did not answer')
    // Not read yet is not the same as not installed.
    expect(tailscaleHereProblem(tailnet({ installed: false, backendState: null, checkedAt: null }))).toBeNull()
    // A problem here outranks a phone listed from an older reading.
    expect(phoneTailscaleStep(tailnet({ backendState: 'Stopped', phones: [iphone()] })).state).toBe('problem')
  })

  it('sums up the phones on the tailnet, online ones first', () => {
    expect(tailnetPhonesSummary([])).toBe('')
    expect(tailnetPhonesSummary([iphone({ hostName: 'old', online: false }), iphone()]))
      .toBe('juraj-iphone (iOS, online) and old (iOS, offline) are on your tailnet.')
    expect(tailnetPhonesSummary([iphone(), iphone({ hostName: 'b', os: 'android' }), iphone({ hostName: 'c' }), iphone({ hostName: 'd' })]))
      .toBe('juraj-iphone (iOS, online) and 3 more phones are on your tailnet.')
    expect(osName('ipados')).toBe('iPadOS')
    expect(osName('android')).toBe('Android')
    expect(osName('')).toBe('unknown OS')
  })

  it('says when the tailnet was last read', () => {
    const now = Date.parse('2026-09-23T10:05:00.000Z')
    expect(checkedText('2026-09-23T10:00:00.000Z', now)).toBe('Checked 5 min ago')
    expect(checkedText(null, now)).toBe('Not checked yet')
  })
})

describe('step 2: a trusted address through Tailscale', () => {
  it('says HTTPS certificates are off for the tailnet, which is the evidence on the owner’s machine', () => {
    const step = tailscaleCertificateStep(tailnet({ httpsEnabled: false }), false)
    expect(step).toMatchObject({ state: 'problem', text: 'HTTPS certificates are off for your tailnet.' })
    expect(step.fix).toContain('DNS page')
  })

  it('does not claim anything about HTTPS before Tailscale has answered', () => {
    expect(tailscaleCertificateStep(tailnet({ httpsEnabled: null }), false)).toMatchObject({ state: 'waiting' })
    expect(tailscaleCertificateStep(tailnet({ httpsEnabled: null }), false).text).toContain('not read yet')
  })

  it('asks for the switch once HTTPS is on, then waits for the certificate', () => {
    expect(tailscaleCertificateStep(tailnet({ httpsEnabled: true }), false).fix).toContain('switch below')
    expect(tailscaleCertificateStep(tailnet({ httpsEnabled: true, certificate: 'pending' }), true)).toMatchObject({ state: 'waiting', text: 'Tailscale is issuing the certificate.' })
    expect(tailscaleCertificateStep(tailnet({ httpsEnabled: true, dnsName: null }), true).state).toBe('problem')
  })

  it('is done when the certificate is active, and passes on Tailscale’s reason when it failed', () => {
    expect(tailscaleCertificateStep(tailnet({ certificate: 'active', httpsEnabled: null }), true)).toMatchObject({ state: 'done' })
    expect(tailscaleCertificateStep(tailnet({ certificate: 'active' }), true).text).toContain('e-box.tail8216c8.ts.net')
    const failed = tailscaleCertificateStep(tailnet({ certificate: 'failed', message: 'Tailscale did not issue a certificate: 500.' }), true)
    expect(failed).toMatchObject({ state: 'problem', fix: 'Tailscale did not issue a certificate: 500.' })
  })

  it('points back to step 1 while Tailscale is not running here', () => {
    expect(tailscaleCertificateStep(tailnet({ backendState: 'Stopped' }), true).text).toContain('step 1')
  })
})

describe('step 3: pairing', () => {
  const known = new Set(['a'])
  it('is done only for a phone that paired after the panel opened', () => {
    const devices = [device('a', '2026-08-01T00:00:00Z', { name: 'Old iPhone' }), device('b', '2026-09-23T10:00:00Z', { name: 'New iPhone' })]
    expect(pairStepStatus(devices, known, null, true)).toEqual({ state: 'done', text: 'New iPhone is paired.' })
  })

  it('treats a phone paired before as a fact, not as done, since it may hold an address that no longer answers', () => {
    const step = pairStepStatus([device('a', '2026-08-01T00:00:00Z', { name: 'Old iPhone' })], known, null, true)
    expect(step.state).toBe('waiting')
    expect(step.text).toBe('Old iPhone was paired before.')
  })

  it('waits for the code while one is shown, and cannot show one while not listening', () => {
    expect(pairStepStatus([], new Set(), { code: 'ABCD-EFGH' }, true).text).toContain('use the code')
    expect(pairStepStatus([], new Set(), null, false).fix).toContain('Turn on phone access')
    expect(pairStepStatus([], new Set(), null, true).text).toBe('No phone is paired yet.')
    // Before the first state nothing can be new.
    expect(pairStepStatus([device('a', '2026-09-23T10:00:00Z')], null, null, true).state).toBe('waiting')
  })

  it('finds the newest phone by when it was paired', () => {
    expect(newestDevice([device('a', '2026-08-01T00:00:00Z'), device('c', '2026-09-23T00:00:00Z'), device('b', '2026-09-01T00:00:00Z')])?.id).toBe('c')
    expect(newestDevice([])).toBeNull()
  })
})

describe('step 4: Home Screen and notifications', () => {
  it('is done when any phone has notifications on', () => {
    const devices = [device('a', '2026-08-01T00:00:00Z', { name: 'iPhone', pushEnabled: true }), device('b', '2026-09-01T00:00:00Z')]
    expect(notificationStep(devices, true, true)).toEqual({ state: 'done', text: 'Notifications are on for iPhone.' })
    expect(notificationTarget(devices)?.id).toBe('a')
    expect(notificationTarget([device('b', '2026-09-01T00:00:00Z')])?.id).toBe('b')
  })

  it('waits with the reason otherwise', () => {
    expect(notificationStep([], true, true).text).toContain('step 3')
    expect(notificationStep([device('b', '2026-09-01T00:00:00Z', { name: 'iPhone' })], true, false).text).toContain('push keys')
    expect(notificationStep([device('b', '2026-09-01T00:00:00Z', { name: 'iPhone' })], true, true).text).toBe('iPhone has not turned notifications on yet.')
  })

  it('is a problem while the master switch stops every notification', () => {
    expect(notificationStep([device('a', '2026-08-01T00:00:00Z', { pushEnabled: true })], false, true)).toMatchObject({ state: 'problem' })
  })

  it('has a word for every chip', () => {
    expect(stepStateWord('done')).toBe('Done')
    expect(stepStateWord('waiting')).toBe('Waiting')
    expect(stepStateWord('problem')).toBe('Needs a fix')
  })
})
