import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteProjectSummary } from '../shared/remote-control'
import { generateDeviceKey, signChallenge, type ChallengePayload } from './device-key'
import type { RemoteControlHost } from './remote-control-host'
import { RemoteControlServer } from './remote-control-server'
import { RemotePeers } from './remote-peers'
import { RemoteServiceRegistry } from './remote-services'
import { RemoteServiceTunnels } from './remote-tunnel-client'
import { RemoteTunnelHost } from './remote-tunnel-host'
import { StoredSecretVault, type SecretCipher, type SecretKeyValueStore } from './secret-store'

/**
 * The whole chain, with nothing faked in the middle: a TCP client on this computer, a loopback
 * listener, a pinned WebSocket over a real HTTPS server, a real signed upgrade, and a real TCP
 * service on the other side. What matters is that bytes arrive unaltered - a preview is a browser
 * talking to a dev server, and a tunnel that reorders, merges or re-encodes anything breaks a
 * protocol somebody else wrote.
 */

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

const cipher: SecretCipher = {
  available: () => true,
  encrypt: value => Buffer.from('enc:' + Buffer.from(value, 'utf8').toString('hex'), 'utf8'),
  decrypt: value => Buffer.from(value.toString('utf8').replace(/^enc:/, ''), 'hex').toString('utf8')
}

const IDENTITY = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: '/tmp/a', name: 'Conductor' }
const PROJECTS: RemoteProjectSummary[] = [{ id: 'project-a', name: 'Conductor', path: '/tmp/a', identity: IDENTITY, identityError: null }]

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A TCP service on loopback. `serve` decides what it does with each connection. */
async function service(serve: (socket: Socket) => void): Promise<number> {
  const server = createNetServer(socket => { socket.on('error', () => undefined); serve(socket) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const address = server.address()
  return address && typeof address !== 'string' ? address.port : 0
}

async function fixture(options: { connected?: boolean } = {}) {
  const store = new MapStore()
  const vault = new StoredSecretVault(store, cipher)
  const laptopKey = generateDeviceKey('laptop')
  const peers = new RemotePeers({
    store,
    accountId: () => 4242,
    accountLogin: () => 'Empire024',
    accountKeys: async () => [laptopKey.publicKey],
    projects: () => PROJECTS
  })
  peers.updateSettings({ enabled: true, port: 0, machineName: 'Render Desktop' })
  const server = new RemoteControlServer({
    peers,
    host: { call: async () => ({}) } as unknown as RemoteControlHost,
    store, vault,
    machineName: () => 'Render Desktop',
    accountLogin: () => 'Empire024'
  })
  const status = await server.apply()
  cleanup.push(() => server.close())
  if (!status.listening) throw new Error('fixture server did not start: ' + (status.message ?? 'no reason'))
  const fingerprint = status.fingerprint ?? ''
  const hostPort = Number(new URL(status.endpoint ?? '').port)

  const registry = new RemoteServiceRegistry({
    settings: store, peers, project: id => PROJECTS.find(project => project.id === id) ?? null
  })
  const tunnelHost = new RemoteTunnelHost({ peers, services: registry, fingerprint: () => fingerprint })
  tunnelHost.listenOn(server)
  cleanup.push(() => tunnelHost.dispose())

  const { code } = peers.issueTicket()
  const payload: ChallengePayload = {
    audienceMachineId: peers.machineId, fingerprint,
    nonce: randomBytes(18).toString('base64url'), purpose: 'pair', bodyHash: '', issuedAt: Date.now()
  }
  await peers.beginPairing({
    machineId: 'laptop', machineName: 'Laptop', publicKey: laptopKey.publicKey,
    signature: signChallenge(laptopKey.privateKeyPem, payload),
    nonce: payload.nonce, timestamp: payload.issuedAt, code, fingerprint
  })
  const peer = peers.approve(peers.listPending()[0]!.id, ['project-a'])

  const tunnels = new RemoteServiceTunnels({
    deviceKey: () => laptopKey,
    machineId: () => 'laptop',
    connected: () => options.connected ?? true
  })
  cleanup.push(() => tunnels.dispose())

  const target = {
    host: '127.0.0.1', port: hostPort, fingerprint, peerId: peer.id,
    machineId: peers.machineId, machineName: 'Render Desktop'
  }
  return {
    peers, registry, tunnelHost, tunnels, peer, target, laptopKey,
    /** Registers a service on the host and opens the local port that leads to it. */
    preview: async (servicePort: number, projectId = 'project-a') => {
      const registered = registry.register({ projectId, port: servicePort, label: 'Preview' })
      const opened = await tunnels.open({
        machineId: peers.machineId, projectId: 'local-project', serviceId: registered.id, target
      })
      return { ...opened, serviceId: registered.id, port: Number(new URL(opened.localUrl).port) }
    }
  }
}

/** Opens a TCP connection to the local end of a tunnel and collects everything it sends back. */
function connectLocal(port: number): { socket: Socket; received: Buffer[]; closed: Promise<void> } {
  const received: Buffer[] = []
  const socket = netConnect({ host: '127.0.0.1', port })
  cleanup.push(() => { socket.destroy() })
  socket.on('data', chunk => received.push(chunk))
  socket.on('error', () => { /* a closed tunnel shows up as the close below */ })
  const closed = new Promise<void>(resolve => { socket.on('close', () => resolve()) })
  return { socket, received, closed }
}

/** Waits until the collected bytes reach a length, or gives up with what it has. */
async function until(received: Buffer[], bytes: number, timeoutMs = 10_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs
  while (Buffer.concat(received).length < bytes && Date.now() < deadline) {
    await new Promise(resolve => { setTimeout(resolve, 5) })
  }
  return Buffer.concat(received)
}

const settle = (ms = 60): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

describe('a preview on this computer that is really running on another', () => {
  it('answers on a loopback port and carries bytes both ways', async () => {
    const fix = await fixture()
    const echo = await service(socket => { socket.pipe(socket) })
    const preview = await fix.preview(echo)
    expect(preview.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

    const local = connectLocal(preview.port)
    local.socket.write('hello through the tunnel')
    expect((await until(local.received, 24)).toString()).toBe('hello through the tunnel')
  })

  it('carries a WebSocket handshake through byte for byte, which is what hot reload is', async () => {
    const fix = await fixture()
    // A dev server's hot-reload socket: an upgrade request, a 101 back, then frames. Nothing in
    // the tunnel may look at, rewrite or reorder any of it.
    const handshake = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n'
    const afterwards = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x82, 0x02, 0x00, 0xff])
    let seen = ''
    const hmr = await service(socket => {
      socket.on('data', chunk => {
        seen += chunk.toString('latin1')
        if (!seen.includes('\r\n\r\n')) return
        socket.write(handshake)
        socket.write(afterwards)
      })
    })
    const preview = await fix.preview(hmr)
    const local = connectLocal(preview.port)
    const request = 'GET /hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    local.socket.write(request)

    const answer = await until(local.received, handshake.length + afterwards.length)
    expect(answer.subarray(0, handshake.length).toString('latin1')).toBe(handshake)
    expect([...answer.subarray(handshake.length)]).toEqual([...afterwards])
    // And the service saw exactly the request the client wrote, header for header.
    expect(seen).toBe(request)
  })

  it('carries four megabytes in both directions without losing or reordering a byte', async () => {
    const fix = await fixture()
    const echo = await service(socket => { socket.pipe(socket) })
    const preview = await fix.preview(echo)
    const local = connectLocal(preview.port)

    const payload = randomBytes(4 * 1024 * 1024)
    let offset = 0
    const pump = (): void => {
      while (offset < payload.length) {
        const chunk = payload.subarray(offset, offset + 128 * 1024)
        offset += chunk.length
        // Honouring the answer is the point: this is the path that would otherwise buffer four
        // megabytes in whichever process is slowest.
        if (!local.socket.write(chunk)) { local.socket.once('drain', pump); return }
      }
    }
    pump()
    const answer = await until(local.received, payload.length, 30_000)
    expect(answer.length).toBe(payload.length)
    expect(createHash('sha256').update(answer).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
  }, 40_000)

  it('keeps the local port open while nothing is connected through it', async () => {
    const fix = await fixture()
    const echo = await service(socket => { socket.pipe(socket) })
    const preview = await fix.preview(echo)
    const first = connectLocal(preview.port)
    first.socket.write('one')
    await until(first.received, 3)
    first.socket.destroy()
    await settle()
    expect(fix.tunnels.list()[0]).toMatchObject({ connections: 0, localUrl: preview.localUrl })

    // The listener outlives its connections, so the pane can reload without reopening the tunnel.
    const second = connectLocal(preview.port)
    second.socket.write('two')
    expect((await until(second.received, 3)).toString()).toBe('two')
  })

  it('answers a second open for the same service with the port that is already there', async () => {
    const fix = await fixture()
    const echo = await service(socket => { socket.pipe(socket) })
    const preview = await fix.preview(echo)
    const again = await fix.tunnels.open({
      machineId: fix.peers.machineId, projectId: 'local-project', serviceId: preview.serviceId, target: fix.target
    })
    expect(again.localUrl).toBe(preview.localUrl)
    expect(fix.tunnels.list()).toHaveLength(1)
  })
})

describe('when a preview must stop', () => {
  it('closes the local port and every connection through it, on both machines', async () => {
    const fix = await fixture()
    const echo = await service(socket => { socket.pipe(socket) })
    const preview = await fix.preview(echo)
    const local = connectLocal(preview.port)
    local.socket.write('still here')
    await until(local.received, 10)
    await settle()
    expect(fix.tunnelHost.openConnections).toBe(1)

    await fix.tunnels.close({ machineId: fix.peers.machineId, projectId: 'local-project', serviceId: preview.serviceId })
    await local.closed
    await settle()
    expect(fix.tunnels.list()).toEqual([])
    expect(fix.tunnelHost.openConnections).toBe(0)
    // The port is gone, so nothing can reach that service through this computer any more.
    const refused = connectLocal(preview.port)
    await refused.closed
  })

  it('drops every preview onto a machine the owner detached from', async () => {
    const fix = await fixture()
    const echo = await service(socket => { socket.pipe(socket) })
    await fix.preview(echo)
    await fix.preview(echo)
    expect(fix.tunnels.list()).toHaveLength(2)
    await fix.tunnels.closeMachine(fix.peers.machineId)
    expect(fix.tunnels.list()).toEqual([])
  })

  it('leaves another machine\'s previews alone', async () => {
    const fix = await fixture()
    const echo = await service(socket => { socket.pipe(socket) })
    await fix.preview(echo)
    await fix.tunnels.closeMachine('some-other-machine')
    expect(fix.tunnels.list()).toHaveLength(1)
  })

  it('closing one that was never open is not an error', async () => {
    const fix = await fixture()
    await expect(fix.tunnels.close({ machineId: 'nobody', projectId: 'p', serviceId: 's' })).resolves.toBeUndefined()
  })
})

describe('what the controller refuses to do', () => {
  it('will not open a preview to a machine this computer is detached from', async () => {
    const fix = await fixture({ connected: false })
    const registered = fix.registry.register({ projectId: 'project-a', port: 4321, label: 'Preview' })
    await expect(fix.tunnels.open({
      machineId: fix.peers.machineId, projectId: 'local-project', serviceId: registered.id, target: fix.target
    })).rejects.toThrow(/not attached to Render Desktop/)
    expect(fix.tunnels.list()).toEqual([])
  })

  it('will not open one without a device key to prove who it is', async () => {
    const fix = await fixture()
    const keyless = new RemoteServiceTunnels({ deviceKey: () => null, machineId: () => 'laptop' })
    await expect(keyless.open({
      machineId: fix.peers.machineId, projectId: 'local-project', serviceId: 'anything', target: fix.target
    })).rejects.toThrow(/no device key/)
  })

  it.each([
    ['no machine', { machineId: '' }],
    ['no project', { projectId: '  ' }],
    ['no service', { serviceId: '' }]
  ])('refuses a request with %s', async (_label, patch) => {
    const fix = await fixture()
    await expect(fix.tunnels.open({
      machineId: fix.peers.machineId, projectId: 'local-project', serviceId: 'service', target: fix.target, ...patch
    })).rejects.toThrow(/A service tunnel needs/)
  })

  it('refuses a target without a certificate to pin, rather than trusting whatever answers', async () => {
    const fix = await fixture()
    await expect(fix.tunnels.open({
      machineId: fix.peers.machineId, projectId: 'local-project', serviceId: 'service',
      target: { ...fix.target, fingerprint: '' }
    })).rejects.toThrow(/certificate to pin/)
  })

  it('opens the port, then closes each connection the host refuses', async () => {
    const fix = await fixture()
    // The local listener exists before anything is known about whether the host will allow it -
    // the pane has a URL to load either way - so the refusal arrives as a connection that closes.
    const opened = await fix.tunnels.open({
      machineId: fix.peers.machineId, projectId: 'local-project', serviceId: 'never-registered', target: fix.target
    })
    const local = connectLocal(Number(new URL(opened.localUrl).port))
    local.socket.write('anyone there?')
    await local.closed
    expect(Buffer.concat(local.received)).toHaveLength(0)
    expect(fix.tunnelHost.openConnections).toBe(0)
  })

  it('closes the connection when the service on the host is not running', async () => {
    const fix = await fixture()
    const dead = createNetServer()
    await new Promise<void>(resolve => { dead.listen(0, '127.0.0.1', resolve) })
    const address = dead.address()
    const deadPort = address && typeof address !== 'string' ? address.port : 0
    await new Promise<void>(resolve => { dead.close(() => resolve()) })

    const preview = await fix.preview(deadPort)
    const local = connectLocal(preview.port)
    local.socket.write('hello?')
    await local.closed
    expect(Buffer.concat(local.received)).toHaveLength(0)
  })

  it('ends the local connection when the service closes its own end', async () => {
    const fix = await fixture()
    const hangUp = await service(socket => { socket.on('data', () => socket.end('bye')) })
    const preview = await fix.preview(hangUp)
    const local = connectLocal(preview.port)
    local.socket.write('are you there?')
    await local.closed
    expect(Buffer.concat(local.received).toString()).toBe('bye')
    await settle()
    expect(fix.tunnelHost.openConnections).toBe(0)
  })
})
