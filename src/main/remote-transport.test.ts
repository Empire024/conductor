import { describe, expect, it } from 'vitest'
import type { RemoteConnection } from '../shared/remote-control'
import { REMOTE_STREAM_PROTOCOL, type StreamHostFrame } from '../shared/remote-stream'
import { generateDeviceKey } from './device-key'
import type { RemoteControlServer, UpgradeHandler } from './remote-control-server'
import type { RemotePeers } from './remote-peers'
import type { StreamSocket } from './remote-stream-client'
import { RemoteTransport } from './remote-transport'
import type { RelaySocketEvents, RelaySocketOptions } from './relay-socket'
import { TailscaleService } from './tailscale'

const KEY = generateDeviceKey('laptop')

const connection = (overrides: Partial<RemoteConnection> = {}): RemoteConnection => ({
  machineId: 'render-desktop', machineName: 'Render Desktop', accountLogin: 'Empire024',
  host: '100.80.1.2', port: 51840, fingerprint: 'AA:BB', peerId: 'peer-1', transport: 'tailscale',
  generation: 1, projectGrants: [], remoteProjects: [], remoteProjectsAt: null, unconfirmedRemoteProjectIds: [],
  connectedAt: '2026-09-16T09:00:00.000Z', lastContactAt: '2026-09-16T09:30:00.000Z', status: 'connected', message: null,
  ...overrides
})

/** `tailscale status --json` with the desktop reached over a DERP relay rather than directly. */
const statusJson = (curAddr = '', relay = 'fra'): string => JSON.stringify({
  BackendState: 'Running',
  Self: { ID: 'nSELF', HostName: 'laptop', DNSName: 'laptop.tail1.ts.net.', TailscaleIPs: ['100.80.9.9'], Online: true, UserID: 1 },
  Peer: {
    nodekey1: {
      ID: 'nDESK', HostName: 'render-desktop', DNSName: 'render-desktop.tail1.ts.net.',
      TailscaleIPs: ['100.80.1.2'], Online: true, UserID: 1, CurAddr: curAddr, Relay: relay
    }
  },
  User: { 1: { LoginName: 'Empire024@github' } }
})

class FakeStream implements StreamSocket {
  connected = false
  closedWith: string | null = null
  constructor(readonly url: string, readonly events: RelaySocketEvents, readonly options: RelaySocketOptions) {}
  connect(): void { /* opened by the test */ }
  send(): void { /* the facade does not read these back */ }
  ping(): void { /* nothing under this socket */ }
  close(_code?: number, reason?: string): void { this.connected = false; this.closedWith = reason ?? '' }
  welcome(): void {
    this.connected = true
    this.events.open()
    this.events.frame({ type: 'welcome', protocol: REMOTE_STREAM_PROTOCOL, machineId: 'render-desktop', machineName: 'Render Desktop', generation: 0 })
  }
}

function fixture(records: RemoteConnection[] = [connection()], status = statusJson()) {
  let connections = records
  const sockets: FakeStream[] = []
  const frames: Array<{ machineId: string; frame: StreamHostFrame }> = []
  const upgrades = new Map<string, UpgradeHandler>()
  const tailscale = new TailscaleService({
    platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => true, run: async () => status, now: () => Date.parse('2026-09-16T10:00:00.000Z')
  })
  const server = {
    onUpgrade: (path: string, handler: UpgradeHandler) => { upgrades.set(path, handler); return () => { upgrades.delete(path) } },
    identity: () => ({ fingerprint: 'AA:BB' })
  } as unknown as RemoteControlServer
  const transport = new RemoteTransport({
    tailscale,
    server,
    peers: { machineId: 'laptop-machine', getSettings: () => ({ machineName: 'This Laptop' }) } as unknown as RemotePeers,
    connections: () => connections,
    deviceKey: () => KEY,
    machineId: () => 'laptop-machine',
    machineName: () => 'This Laptop',
    onFrame: (machineId, frame) => frames.push({ machineId, frame }),
    changed: () => { /* the ipc layer republishes; nothing to assert here */ },
    cursors: machineId => (machineId === 'render-desktop' ? [{ localSessionId: 'local-1', remoteSequence: 42 }] : []),
    after: () => ({ cancel: () => { /* no timers run in these tests */ } }),
    createSocket: (url, events, options) => {
      const socket = new FakeStream(url, events, options)
      sockets.push(socket)
      return socket
    }
  })
  return {
    transport, sockets, frames, tailscale, upgrades,
    set: (next: RemoteConnection[]) => { connections = next },
    latest: () => sockets[sockets.length - 1]
  }
}

describe('the transport facade', () => {
  it('serves the push channel and opens one stream client per attached host', () => {
    const fix = fixture()
    fix.transport.start()
    expect([...fix.upgrades.keys()]).toEqual(['/v1/stream'])
    expect(fix.sockets).toHaveLength(1)
    expect(fix.latest()?.url).toBe('wss://100.80.1.2:51840/v1/stream')
  })

  it('never dials a host the owner detached from, or one that was revoked or never approved', () => {
    const fix = fixture([
      connection({ machineId: 'detached-host', detached: true }),
      connection({ machineId: 'revoked-host', status: 'revoked' }),
      connection({ machineId: 'pending-host', peerId: '' })
    ])
    fix.transport.start()
    expect(fix.sockets).toHaveLength(0)
    // No client means no overlay at all: the stored record speaks for itself rather than being
    // contradicted by a socket that does not exist.
    expect(fix.transport.connection('detached-host')).toBeUndefined()
  })

  it('stops and drops a client when the owner detaches, and builds a new one when they attach', () => {
    const fix = fixture()
    fix.transport.start()
    const first = fix.latest()
    fix.set([connection({ detached: true })])
    fix.transport.detach('render-desktop')
    expect(first?.closedWith).toMatch(/independently/)
    expect(fix.transport.streaming('render-desktop')).toBe(false)
    // Attaching while still detached must stay a no-op; nothing reattaches on its own.
    fix.transport.attach('render-desktop')
    expect(fix.sockets).toHaveLength(1)
    fix.set([connection({ detached: false, generation: 2 })])
    fix.transport.attach('render-desktop')
    expect(fix.sockets).toHaveLength(2)
  })

  it('reports the path Tailscale reports, not the one the socket could guess at', async () => {
    const fix = fixture()
    await fix.transport.tailscaleState()
    fix.transport.start()
    fix.latest()?.welcome()
    expect(fix.transport.connection('render-desktop')).toMatchObject({
      state: 'connected', transport: 'tailscale', path: 'relayed', generation: 1
    })

    const direct = fixture([connection()], statusJson('203.0.113.7:41641', 'fra'))
    await direct.transport.tailscaleState()
    direct.transport.start()
    direct.latest()?.welcome()
    expect(direct.transport.connection('render-desktop')?.path).toBe('direct')
  })

  it('leaves the path unknown when the tailnet has not been read or does not know that peer', () => {
    const fix = fixture()
    fix.transport.start()
    fix.latest()?.welcome()
    // Nothing has run `tailscale status` yet, so there is nothing honest to say about the path.
    expect(fix.transport.connection('render-desktop')?.path).toBe('unknown')
  })

  it('gathers everything the diagnostics view shows about one host in a single answer', async () => {
    const fix = fixture()
    await fix.transport.tailscaleState()
    fix.transport.start()
    fix.latest()?.welcome()
    const diagnostics = fix.transport.diagnostics('render-desktop')
    expect(diagnostics).toMatchObject({
      machineId: 'render-desktop',
      machineName: 'Render Desktop',
      endpoint: { host: '100.80.1.2', port: 51840, fingerprint: 'AA:BB' },
      lastContactAt: '2026-09-16T09:30:00.000Z',
      cursors: [{ localSessionId: 'local-1', remoteSequence: 42 }]
    })
    expect(diagnostics.connection).toMatchObject({ state: 'connected', path: 'relayed' })
    expect(diagnostics.tailscalePeer).toMatchObject({ hostName: 'render-desktop', relay: 'fra', path: 'relayed' })
    expect(diagnostics.stream.open).toBe(true)
  })

  it('answers about a machine it has never heard of without inventing an endpoint', () => {
    const fix = fixture()
    fix.transport.start()
    const diagnostics = fix.transport.diagnostics('nobody')
    expect(diagnostics.endpoint).toBeNull()
    expect(diagnostics.tailscalePeer).toBeNull()
    expect(diagnostics.connection).toMatchObject({ state: 'offline', failure: 'authorization' })
  })

  it('passes host frames on, tagged with the machine they came from', () => {
    const fix = fixture()
    fix.transport.start()
    fix.latest()?.welcome()
    fix.latest()?.events.frame({ type: 'tasks.changed', projectId: 'remote-a' })
    expect(fix.frames.at(-1)).toEqual({ machineId: 'render-desktop', frame: { type: 'tasks.changed', projectId: 'remote-a' } })
  })

  it('closes every client and stops serving when the app shuts down', () => {
    const fix = fixture()
    fix.transport.start()
    fix.transport.stop()
    expect(fix.latest()?.closedWith).toMatch(/shutting down/)
    expect(fix.upgrades.size).toBe(0)
    expect(fix.transport.connection('render-desktop')).toBeUndefined()
  })
})
