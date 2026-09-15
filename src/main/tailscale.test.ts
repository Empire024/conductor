import { describe, expect, it } from 'vitest'
import {
  INSTALL_TAILSCALE_MESSAGE,
  TailscaleService,
  findTailscalePeer,
  isTailscaleAddress,
  normalizeAddress,
  orderTailscaleAddresses,
  pathFor,
  readTailscaleStatus,
  type TailscaleServiceDependencies
} from './tailscale'

const NOW = Date.parse('2026-09-16T10:00:00.000Z')

/** One `tailscale status --json` document, shaped exactly as the CLI prints it. */
const statusJson = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  Version: '1.74.1',
  BackendState: 'Running',
  TailscaleIPs: ['100.80.1.2', 'fd7a:115c:a1e0::1234'],
  CurrentTailnet: { Name: 'empire024.github' },
  Self: {
    ID: 'nSELF',
    HostName: 'render-desktop',
    DNSName: 'render-desktop.tail1234.ts.net.',
    TailscaleIPs: ['100.80.1.2', 'fd7a:115c:a1e0::1234'],
    Online: true,
    UserID: 77,
    CurAddr: '',
    Relay: ''
  },
  Peer: {
    nodekey1: {
      ID: 'nLAPTOP',
      HostName: 'laptop',
      DNSName: 'laptop.tail1234.ts.net.',
      TailscaleIPs: ['100.80.9.9', 'fd7a:115c:a1e0::9999'],
      Online: true,
      UserID: 77,
      CurAddr: '203.0.113.7:41641',
      Relay: 'fra',
      Active: true,
      LastSeen: '2026-09-16T09:59:00Z',
      LastHandshake: '2026-09-16T09:59:30Z'
    }
  },
  User: { 77: { LoginName: 'Empire024@github', DisplayName: 'Empire024' } },
  ...overrides
})

const service = (over: Partial<TailscaleServiceDependencies> = {}): TailscaleService =>
  new TailscaleService({
    platform: 'win32',
    env: { PATH: '', ProgramFiles: 'C:\\Program Files' },
    exists: path => path === 'C:\\Program Files\\Tailscale\\tailscale.exe',
    now: () => NOW,
    run: async () => statusJson(),
    ...over
  })

describe('recognising a tailnet address', () => {
  it('accepts the whole of 100.64.0.0/10 and the tailnet IPv6 prefix, and nothing else', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true)
    expect(isTailscaleAddress('100.127.255.254')).toBe(true)
    expect(isTailscaleAddress('100.80.1.2')).toBe(true)
    expect(isTailscaleAddress('fd7a:115c:a1e0::1234')).toBe(true)
    // 100.63 and 100.128 are ordinary public addresses that merely look adjacent.
    expect(isTailscaleAddress('100.63.255.255')).toBe(false)
    expect(isTailscaleAddress('100.128.0.1')).toBe(false)
    expect(isTailscaleAddress('192.168.1.5')).toBe(false)
    expect(isTailscaleAddress('127.0.0.1')).toBe(false)
    expect(isTailscaleAddress('0.0.0.0')).toBe(false)
    expect(isTailscaleAddress('2001:db8::1')).toBe(false)
    expect(isTailscaleAddress('fd00:115c:a1e0::1')).toBe(false)
    expect(isTailscaleAddress('')).toBe(false)
    expect(isTailscaleAddress('100.80.1')).toBe(false)
    expect(isTailscaleAddress('100.080.1.2x')).toBe(false)
  })

  it('reads the forms an address really arrives in', () => {
    // A Node socket reports an IPv4 peer over a dual-stack listener in mapped form, and a URL
    // keeps its brackets. Refusing either would refuse the owner's own laptop.
    expect(normalizeAddress('::ffff:100.80.1.2')).toBe('100.80.1.2')
    expect(isTailscaleAddress('::ffff:100.80.1.2')).toBe(true)
    expect(isTailscaleAddress('[fd7a:115c:a1e0::1]')).toBe(true)
    expect(isTailscaleAddress('fe80::1%eth0')).toBe(false)
  })

  it('puts the IPv4 address first and drops anything that is not on the tailnet', () => {
    expect(orderTailscaleAddresses(['fd7a:115c:a1e0::9', '100.80.1.2', '192.168.1.5'])).toEqual(['100.80.1.2', 'fd7a:115c:a1e0::9'])
    expect(orderTailscaleAddresses('not an array')).toEqual([])
  })
})

describe('the path Tailscale reports', () => {
  it('is direct only with a current address, relayed only with a DERP region, unknown otherwise', () => {
    expect(pathFor('203.0.113.7:41641', '')).toBe('direct')
    expect(pathFor('', 'fra')).toBe('relayed')
    // Before traffic flows Tailscale knows neither, and a guess here would be a confident lie.
    expect(pathFor('', '')).toBe('unknown')
    // A peer that has a direct path also names the region it fell back from; direct still wins.
    expect(pathFor('203.0.113.7:41641', 'fra')).toBe('direct')
  })
})

describe('reading tailscale status --json', () => {
  it('parses this machine, its peers and the account each belongs to', () => {
    const state = readTailscaleStatus(JSON.parse(statusJson()), NOW)
    expect(state.installed).toBe(true)
    expect(state.backendState).toBe('Running')
    expect(state.message).toBeNull()
    expect(state.self).toEqual({
      hostName: 'render-desktop',
      dnsName: 'render-desktop.tail1234.ts.net.',
      addresses: ['100.80.1.2', 'fd7a:115c:a1e0::1234'],
      loginName: 'Empire024@github',
      online: true
    })
    expect(state.peers).toHaveLength(1)
    expect(state.peers[0]).toMatchObject({ hostName: 'laptop', path: 'direct', relay: 'fra', online: true, loginName: 'Empire024@github' })
    expect(state.checkedAt).toBe(new Date(NOW).toISOString())
  })

  it('calls a peer with only a DERP region relayed', () => {
    const raw = JSON.parse(statusJson()) as { Peer: Record<string, Record<string, unknown>> }
    raw.Peer.nodekey1!.CurAddr = ''
    const state = readTailscaleStatus(raw, NOW)
    expect(state.peers[0]?.path).toBe('relayed')
    expect(state.peers[0]?.relay).toBe('fra')
  })

  it('says what to do when the backend needs a login, is stopped or is still starting', () => {
    expect(readTailscaleStatus({ BackendState: 'NeedsLogin' }, NOW).message).toMatch(/not signed in/i)
    expect(readTailscaleStatus({ BackendState: 'Stopped' }, NOW).message).toMatch(/stopped/i)
    expect(readTailscaleStatus({ BackendState: 'Starting' }, NOW).message).toMatch(/starting up/i)
    expect(readTailscaleStatus({ BackendState: 'NoState' }, NOW).message).toMatch(/starting up/i)
  })

  it('refuses to call a running backend usable when this machine has no tailnet address', () => {
    const raw = JSON.parse(statusJson()) as { Self: Record<string, unknown> }
    raw.Self.TailscaleIPs = ['fd7a:115c:a1e0::1234']
    const state = readTailscaleStatus(raw, NOW)
    // An IPv6-only node has no address for the listener to bind or the pairing code to carry.
    expect(state.message).toMatch(/no tailnet address/i)
  })

  it('reports an unreadable document rather than inventing a state', () => {
    expect(readTailscaleStatus('nonsense', NOW).message).toMatch(/cannot read/i)
    expect(readTailscaleStatus({}, NOW).message).toMatch(/did not say what state/i)
  })
})

describe('the Tailscale service', () => {
  it('says how to install Tailscale when the CLI is nowhere on this machine', async () => {
    const state = await service({ exists: () => false, run: async () => { throw new Error('must not run') } }).state()
    expect(state.installed).toBe(false)
    expect(state.message).toBe(INSTALL_TAILSCALE_MESSAGE)
    expect(state.self).toBeNull()
  })

  it('finds the Windows installer path, then anything on PATH', () => {
    expect(service().locate()).toBe('C:\\Program Files\\Tailscale\\tailscale.exe')
    const onPath = new TailscaleService({
      platform: 'linux',
      env: { PATH: '/usr/bin:/usr/local/bin' },
      exists: path => path === '/usr/local/bin/tailscale'
    })
    expect(onPath.locate()).toBe('/usr/local/bin/tailscale')
    const macos = new TailscaleService({
      platform: 'darwin', env: { PATH: '' },
      exists: path => path === '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    })
    expect(macos.locate()).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  })

  it('answers from cache inside the cache window and asks again once it has passed', async () => {
    let now = NOW
    let runs = 0
    const tailscale = service({ now: () => now, cacheMs: 5_000, run: async () => { runs++; return statusJson() } })
    await tailscale.state()
    await tailscale.state()
    expect(runs).toBe(1)
    now += 5_001
    await tailscale.state()
    expect(runs).toBe(2)
    // A forced reading never waits for the window; the owner pressing refresh means now.
    await tailscale.state(true)
    expect(runs).toBe(3)
  })

  it('collapses concurrent readings into one process', async () => {
    let runs = 0
    const tailscale = service({ run: async () => { runs++; return statusJson() } })
    const [left, right] = await Promise.all([tailscale.state(), tailscale.state()])
    expect(runs).toBe(1)
    expect(left).toBe(right)
  })

  it('reports a CLI that fails or answers with rubbish instead of pretending the tailnet is down', async () => {
    const failing = await service({ run: async () => { throw new Error('access is denied') } }).state()
    expect(failing.installed).toBe(true)
    expect(failing.message).toMatch(/did not answer: access is denied/)
    const garbled = await service({ run: async () => 'not json at all' }).state()
    expect(garbled.message).toMatch(/not JSON/)
  })

  it('offers only this machine own tailnet IPv4 as its address', async () => {
    expect(await service().selfAddress()).toBe('100.80.1.2')
    const noAddress = service({ run: async () => statusJson({ Self: { HostName: 'x', DNSName: 'x', TailscaleIPs: [], Online: true, UserID: 77 } }) })
    expect(await noAddress.selfAddress()).toBeNull()
  })

  it('resolves a paired machine to its tailnet peer by address and by MagicDNS name', async () => {
    const state = await service().state()
    expect(findTailscalePeer(state, '100.80.9.9')?.hostName).toBe('laptop')
    expect(findTailscalePeer(state, '10.0.0.1', 'laptop.tail1234.ts.net')?.hostName).toBe('laptop')
    expect(findTailscalePeer(state, '10.0.0.1')).toBeNull()
  })
})
