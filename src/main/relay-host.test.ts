import { afterEach, describe, expect, it } from 'vitest'
import { ConductorRelay } from './conductor-relay.ts'
import { generateDeviceKey } from './device-key.ts'
import { generateSealKey } from './relay-crypto.ts'
import { RelayHost, type RelayHostDependencies } from './relay-host.ts'
import { RelayRoute } from './relay-route.ts'
import { generateRoomSecret } from './relay-room.ts'
import type { PortMapping } from './port-mapping.ts'
import { PortMappingError } from './port-mapping.ts'

/**
 * The relay Conductor runs for itself: started from a setting rather than a terminal, reached over
 * its own certificate, and - when the owner asks - announced at an address the router opened.
 *
 * The test that matters most is the last one: a machine must refuse a relay whose certificate is not
 * the one in the pairing code, because a relay on a home machine has nothing but that pin between it
 * and whatever else answers that address.
 */

const hosts: RelayHost[] = []
const relays: ConductorRelay[] = []

afterEach(async () => {
  while (relays.length) relays.pop()?.stop()
  while (hosts.length) await hosts.pop()?.stop()
})

function host(secret: string | null, overrides: Partial<RelayHostDependencies> = {}, settings: Partial<{ enabled: boolean; port: number; internet: boolean }> = {}): RelayHost {
  const values = new Map<string, string>()
  const vault = new Map<string, string>()
  const made = new RelayHost({
    store: {
      getSetting: key => values.get(key) ?? null,
      setSetting: (key, value) => { values.set(key, value) },
      removeSetting: key => { values.delete(key) }
    },
    vault: {
      available: () => true,
      read: name => vault.get(name) ?? null,
      write: (name, value) => { vault.set(name, value) }
    },
    settings: () => ({ enabled: true, port: 0, internet: false, ...settings }),
    machineName: () => 'Test machine',
    secret: () => secret,
    ...overrides
  })
  hosts.push(made)
  return made
}

const mapping = (port: number): PortMapping => ({
  externalAddress: '203.0.113.9',
  externalPort: port,
  controlUrl: 'http://192.168.0.1/ctl',
  serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
  internalAddress: '192.168.0.205',
  internalPort: port,
  expiresAt: Date.now() + 3600_000
})

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

describe('a relay that cannot be reached from where this machine is', () => {
  /** A stand-in for the gist mailbox: it only has to say whether it was asked to run. */
  const mailbox = (): { started: boolean; start(): void; stop(): void; getStatus(): { phase: string; reachable: never[]; lastPollAt: null; message: null } } => {
    const state = {
      started: false,
      start(): void { state.started = true },
      stop(): void { state.started = false },
      getStatus: () => ({ phase: 'ready' as const, reachable: [] as never[], lastPollAt: null, message: null })
    }
    return state
  }

  it('hands the machine to the mailbox once waiting for the relay stops being reasonable', async () => {
    let now = 1_000_000
    const github = mailbox()
    // An address nothing answers on, which is what a laptop on a network without IPv6 finds.
    const relay = new ConductorRelay({
      endpoint: () => 'ws://127.0.0.1:9/v1/socket',
      roomSecret: () => generateRoomSecret(),
      machineId: () => 'laptop',
      machineName: () => 'laptop',
      deviceKey: () => generateDeviceKey('laptop'),
      sealKey: () => generateSealKey(),
      fingerprint: () => null,
      peerDeviceKey: () => null,
      handle: async () => ({ status: 200, body: '{}' }),
      enabled: () => true,
      now: () => now,
      schedule: (run, ms) => {
        const handle = setTimeout(run, Math.min(ms, 5))
        return { cancel: () => clearTimeout(handle) }
      }
    })
    relays.push(relay)
    const route = new RelayRoute({ server: relay, github: github as never, endpoint: () => 'ws://127.0.0.1:9/v1/socket', awaitedPeers: () => [] })

    route.start()
    expect(route.usingServer()).toBe(true)
    expect(github.started).toBe(false)

    await waitFor(() => relay.getStatus().phase === 'unavailable', 'the relay to be out of reach')
    // Still the relay's job for now: a connection that drops is not a connection that is gone.
    expect(route.usingServer()).toBe(true)

    now += 46_000
    expect(relay.stranded()).toBe(true)
    route.start()
    expect(route.usingServer()).toBe(false)
    expect(github.started).toBe(true)
    // And the panel says why, rather than reporting the mailbox as if it had been chosen.
    expect(route.getStatus().route).toBe('github')
    expect(route.getStatus().message).toContain('cannot be reached from here')
  })
})

describe('a relay only the machine hosting it can reach', () => {
  /**
   * The host dials its own relay over loopback, so its own connection always works: `stranded` is
   * false for ever and the fallback every other machine relies on never fires here. The only
   * evidence a host has that a peer cannot get in is that the peer never arrives.
   */
  const hosted = (reachable: string[]): ConductorRelay => ({
    configured: () => true,
    stranded: () => false,
    start: () => {},
    stop: () => {},
    getStatus: () => ({ phase: 'ready', reachable, lastPollAt: null, message: null, route: 'server' }),
    call: async () => { throw new Error('A machine that is not on the relay must not be addressed through it') }
  } as unknown as ConductorRelay)

  const mailbox = (): { started: boolean; calls: string[]; start(): void; stop(): void; getStatus(): unknown; call(machineId: string): Promise<{ status: number; body: string }> } => {
    const state = {
      started: false,
      calls: [] as string[],
      start(): void { state.started = true },
      stop(): void { state.started = false },
      getStatus: () => ({ phase: 'ready' as const, reachable: [] as never[], lastPollAt: null, message: null }),
      call: async (machineId: string) => { state.calls.push(machineId); return { status: 200, body: '' } }
    }
    return state
  }

  const routeTo = (github: ReturnType<typeof mailbox>, reachable: string[], awaited: string[]): RelayRoute =>
    new RelayRoute({ server: hosted(reachable), github: github as never, endpoint: () => 'wss://127.0.0.1:8787/v1/socket', awaitedPeers: () => awaited })

  it('answers in the mailbox too while a paired machine has not arrived on the relay', () => {
    const github = mailbox()
    routeTo(github, [], ['laptop']).start()
    // Not stranded - loopback answered - and still has to be findable where the laptop is looking.
    expect(github.started).toBe(true)
  })

  it('addresses a peer the relay does not list through the mailbox instead', async () => {
    const github = mailbox()
    const route = routeTo(github, [], ['laptop'])
    route.start()
    await route.call('laptop', 'device-key', '/v1/rpc', Buffer.from('{}'), {})
    expect(github.calls).toEqual(['laptop'])
  })

  it('leaves the mailbox alone once every paired machine is on the relay', () => {
    const github = mailbox()
    routeTo(github, ['laptop'], []).start()
    expect(github.started).toBe(false)
  })
})

describe('the relay Conductor runs for itself', () => {
  it('starts from a setting, with a certificate and addresses of its own', async () => {
    const running = host(generateRoomSecret(), { publicIpv6: () => [] })
    const status = await running.apply()

    expect(status.running).toBe(true)
    expect(status.port).toBeGreaterThan(0)
    expect(status.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/)
    expect(running.localEndpoint()).toBe(`wss://127.0.0.1:${status.port}/v1/socket`)
    expect(status.internet.state).toBe('off')
  })

  it('will not start without a room secret, and says which thing is missing', async () => {
    const status = await host(null).apply()
    expect(status.running).toBe(false)
    expect(status.message).toContain('room secret')
  })

  it('moves to a free port when the chosen one is taken, rather than leaving the owner stuck', async () => {
    // Another Conductor on the same machine, or anything else holding 8787, used to end the whole
    // flow here - with nothing to do about it but go and find a port field.
    const first = host(generateRoomSecret(), { publicIpv6: () => [] })
    const taken = await first.apply()
    const second = host(generateRoomSecret(), { publicIpv6: () => [] }, { port: taken.port ?? 0 })
    const status = await second.apply()

    expect(status.running).toBe(true)
    expect(status.port).not.toBe(taken.port)
    expect(status.message).toContain('already in use')
    expect(status.message).toContain(String(status.port))
  })

  it('advertises the address the router opened, and hands the mapping back when it stops', async () => {
    let released: PortMapping | null = null
    const running = host(generateRoomSecret(), {
      mapPort: async port => mapping(port),
      unmapPort: async value => { released = value }
    }, { internet: true })

    const status = await running.apply()
    await waitFor(() => running.getStatus().internet.state === 'open', 'the port to be opened')
    expect(running.advertisedEndpoint()).toBe(`wss://203.0.113.9:${status.port}/v1/socket`)

    await running.stop()
    expect(released).not.toBeNull()
  })

  it('keeps running when the router refuses, and says which port to forward by hand instead', async () => {
    const running = host(generateRoomSecret(), {
      mapPort: async () => { throw new PortMappingError('No router on this network answered.', 'no-router') },
      publicIpv6: () => []
    }, { internet: true })

    await running.apply()
    await waitFor(() => running.getStatus().internet.state === 'failed', 'the router to refuse')
    const status = running.getStatus()
    expect(status.running).toBe(true)
    expect(status.internet.message).toContain('Forward TCP port')
  })

  it('tells a machine with no public IPv4 to allow its IPv6 address instead, and how', async () => {
    // A connection with no public IPv4 - DS-Lite, which providers now hand out as a matter of
    // course - has nothing to forward. What it has is this machine's own public IPv6 address, and a
    // router page that asks for the hardware address rather than an address that can change.
    const running = host(generateRoomSecret(), {
      mapPort: async () => { throw new PortMappingError("This connection is behind your provider's own network (100.70.1.4).", 'carrier-nat') },
      publicIpv6: () => ['2a02:8308:29d:8800::f352'],
      hardwareAddress: () => 'AC:F2:3C:CB:5F:F5'
    }, { internet: true })

    const started = await running.apply()
    await waitFor(() => running.getStatus().internet.state === 'failed', 'the carrier refusal')
    const message = running.getStatus().internet.message ?? ''
    expect(message).toContain('nothing needs forwarding')
    expect(message).toContain('AC:F2:3C:CB:5F:F5')
    expect(message).toContain(`wss://[2a02:8308:29d:8800::f352]:${started.port}/v1/socket`)
    expect(message).not.toContain('Forward TCP port')
    // And it is advertised, so a pairing code made here carries the address that actually works.
    expect(running.advertisedEndpoints()[0]).toBe(`wss://[2a02:8308:29d:8800::f352]:${started.port}/v1/socket`)
  })

  it('says plainly when the connection is behind the provider, where no port can help', async () => {
    const running = host(generateRoomSecret(), {
      mapPort: async () => { throw new PortMappingError("This connection is behind your provider's own network (100.70.1.4).", 'carrier-nat') },
      publicIpv6: () => []
    }, { internet: true })

    await running.apply()
    await waitFor(() => running.getStatus().internet.state === 'failed', 'the carrier refusal')
    expect(running.getStatus().internet.message).toContain("provider's own network")
    expect(running.getStatus().internet.message).toContain('no port to forward')
    expect(running.getStatus().internet.message).not.toContain('Forward TCP port')
  })

  it('is reached over its own certificate, and refuses to be reached over any other', async () => {
    const secret = generateRoomSecret()
    const running = host(secret)
    const status = await running.apply()
    const key = generateDeviceKey('laptop')
    const seal = generateSealKey()

    const connect = (fingerprint: string | null): ConductorRelay => {
      const relay = new ConductorRelay({
        endpoint: () => running.localEndpoint(),
        pinnedFingerprint: () => fingerprint,
        roomSecret: () => secret,
        machineId: () => 'laptop',
        machineName: () => 'laptop',
        deviceKey: () => key,
        sealKey: () => seal,
        fingerprint: () => 'SHA256:laptop',
        peerDeviceKey: () => null,
        handle: async () => ({ status: 200, body: '{}' }),
        enabled: () => true
      })
      relays.push(relay)
      relay.start()
      return relay
    }

    const pinned = connect(status.fingerprint)
    await waitFor(() => pinned.getStatus().phase === 'ready', 'the pinned connection')

    // The same address, the same room secret, a certificate the owner never carried across.
    const wrong = connect('AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99')
    await waitFor(() => wrong.getStatus().phase === 'unavailable', 'the unpinned connection to be refused')
    expect(wrong.getStatus().message).toContain('different certificate')
  })
})
