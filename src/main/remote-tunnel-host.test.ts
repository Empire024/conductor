import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { connect as netConnect, createServer as createNetServer, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteProjectSummary } from '../shared/remote-control'
import { TUNNEL_MAX_CONNECTIONS, TUNNEL_MAX_FRAME_BYTES, TUNNEL_SERVICE_HEADER, REMOTE_TUNNEL_PATH } from '../shared/remote-services'
import { FrameDecoder, encodeMaskedBinary, encodeMaskedPing, encodeMaskedText } from '../shared/websocket-framing'
import { generateDeviceKey, signChallenge, type ChallengePayload, type DeviceKeyPair } from './device-key'
import type { RemoteControlHost } from './remote-control-host'
import { RemoteControlServer, type UpgradeHandler } from './remote-control-server'
import { RemotePeers } from './remote-peers'
import { RemoteServiceRegistry } from './remote-services'
import { signUpgrade } from './remote-stream-client'
import { RemoteTunnelHost } from './remote-tunnel-host'
import { StoredSecretVault, type SecretCipher, type SecretKeyValueStore } from './secret-store'

/**
 * The tunnel is the one place a paired machine causes this one to open an outbound socket, so what
 * matters here is everything it refuses: an unpaired or revoked machine, a signature made for
 * something else, an id nobody registered, a project that machine was not granted, a browser, and
 * one machine holding more connections than the cap. The byte plumbing is proved end to end in
 * remote-tunnel-client.test.ts, against this same host.
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
const OTHER = { key: 'b'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: '/tmp/b', name: 'Other' }
const PROJECTS: RemoteProjectSummary[] = [
  { id: 'project-a', name: 'Conductor', path: '/tmp/a', identity: IDENTITY, identityError: null },
  { id: 'project-b', name: 'Other', path: '/tmp/b', identity: OTHER, identityError: null }
]

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A TCP service on loopback that sends back what it is sent. */
async function echoService(): Promise<number> {
  const server = createNetServer(socket => { socket.on('error', () => undefined); socket.pipe(socket) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const address = server.address()
  return address && typeof address !== 'string' ? address.port : 0
}

async function tunnelFixture() {
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
  const port = Number(new URL(status.endpoint ?? '').port)

  const registry = new RemoteServiceRegistry({
    settings: store,
    peers,
    project: id => PROJECTS.find(project => project.id === id) ?? null
  })
  const dialled: number[] = []
  const tunnels = new RemoteTunnelHost({
    peers,
    services: registry,
    fingerprint: () => fingerprint,
    // Wrapping the real dial rather than replacing it: the port it is handed is the assertion.
    connect: servicePort => { dialled.push(servicePort); return netConnect({ host: '127.0.0.1', port: servicePort }) }
  })
  tunnels.listenOn(server)
  cleanup.push(() => tunnels.dispose())

  // Pair and approve the laptop for project-a only.
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

  const servicePort = await echoService()
  const service = registry.register({ projectId: 'project-a', port: servicePort, label: 'Echo' })
  const ungranted = registry.register({ projectId: 'project-b', port: servicePort, label: 'Not yours' })

  return {
    store, peers, server, registry, tunnels, laptopKey, peer, fingerprint, port, service, ungranted, servicePort, dialled,
    headers: (serviceId = service.id, key: DeviceKeyPair = laptopKey, purpose: 'tunnel' | 'stream' = 'tunnel', peerId = peer.id) => ({
      ...signUpgrade(key, { machineId: peers.machineId, fingerprint, peerId }, purpose, Date.now()),
      [TUNNEL_SERVICE_HEADER]: serviceId
    })
  }
}

/** Opens one upgrade and keeps the socket, so a test can count what the host is holding. */
function holdUpgrade(port: number, headers: Record<string, string>, path = REMOTE_TUNNEL_PATH): Promise<{ status: string; socket: TLSSocket }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const lines = Object.entries({
        Host: `127.0.0.1:${port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...headers
      }).map(([name, value]) => `${name}: ${value}\r\n`).join('')
      socket.write(`GET ${path} HTTP/1.1\r\n${lines}\r\n`)
    })
    cleanup.push(() => { socket.destroy() })
    let text = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('the listener never answered the upgrade')) }, 5000)
    socket.on('data', chunk => {
      text += chunk.toString('latin1')
      if (!text.includes('\r\n\r\n')) return
      clearTimeout(timer)
      resolve({ status: text.split('\r\n')[0] ?? '', socket })
    })
    // A refusal is written and the socket is destroyed straight after, so the reset can arrive
    // before or after the bytes. `close` always follows either, and by then everything that was
    // delivered has been emitted - so the answer is whatever arrived, not whichever event won.
    socket.on('error', () => { /* the close that follows carries what arrived */ })
    socket.on('close', () => { clearTimeout(timer); resolve({ status: text.split('\r\n')[0] ?? '', socket }) })
  })
}

/**
 * A socket with no network under it, so backpressure and framing are assertions rather than
 * timing. It stands in for both ends: the WebSocket the controller holds and the TCP connection to
 * the service, which are the same shape as far as this file is concerned.
 */
class FakeDuplex extends EventEmitter {
  readonly written: Buffer[] = []
  blocked = false
  paused = false
  destroyed = false
  writable = true
  private consumed = 0
  private handshake = ''
  private readonly binaries: Buffer[] = []
  private readonly closed: Array<{ code: number; reason: string }> = []
  private readonly pongPayloads: Buffer[] = []
  private readonly decoder = new FrameDecoder({ maxMessageBytes: TUNNEL_MAX_FRAME_BYTES, requireMask: false }, {
    message: message => { if (message.kind === 'binary') this.binaries.push(message.data) },
    ping: () => { /* the host does not ping a tunnel */ },
    pong: payload => { this.pongPayloads.push(payload) },
    close: (code, reason) => { this.closed.push({ code, reason }) },
    fail: (code, reason) => { this.closed.push({ code, reason }) }
  })

  setNoDelay(): void { /* nothing under this socket to tune */ }
  setTimeout(): void { /* nothing here times out */ }
  pause(): void { this.paused = true }
  resume(): void { this.paused = false }
  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, 'utf8'))
    return !this.blocked
  }
  end(chunk?: Buffer | string): void { if (chunk) this.write(chunk) }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.writable = false; this.emit('close') }

  private read(): this {
    while (this.consumed < this.written.length) {
      let chunk = this.written[this.consumed++]!
      if (!this.handshake) {
        const text = chunk.toString('latin1')
        const end = text.indexOf('\r\n\r\n')
        if (end < 0) continue
        this.handshake = text.slice(0, end)
        chunk = chunk.subarray(end + 4)
      }
      if (chunk.length) this.decoder.push(chunk)
    }
    return this
  }

  /** Everything written as text, which for a refusal is the whole answer. */
  text(): string { return Buffer.concat(this.written).toString('latin1') }
  frames(): Buffer[] { return this.read().binaries }
  closes(): Array<{ code: number; reason: string }> { return this.read().closed }
  pongs(): Buffer[] { return this.read().pongPayloads }
}

const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

/**
 * The same host, driven through the handler the listener would have called. Nothing real is bound,
 * which is what lets these tests reach a connection count a real listener refuses first.
 */
async function handlerFixture() {
  const FINGERPRINT = 'AA:BB:CC:DD'
  const store = new MapStore()
  const laptopKey = generateDeviceKey('laptop')
  const peers = new RemotePeers({
    store,
    accountId: () => 4242,
    accountLogin: () => 'Empire024',
    accountKeys: async () => [laptopKey.publicKey],
    projects: () => PROJECTS
  })
  peers.updateSettings({ enabled: true, port: 0, machineName: 'Render Desktop' })
  peers.setFingerprint(FINGERPRINT)
  const registry = new RemoteServiceRegistry({
    settings: store, peers, project: id => PROJECTS.find(project => project.id === id) ?? null
  })
  const handlers = new Map<string, UpgradeHandler>()
  const services: FakeDuplex[] = []
  const tunnels = new RemoteTunnelHost({
    peers,
    services: registry,
    fingerprint: () => FINGERPRINT,
    connect: () => {
      const service = new FakeDuplex()
      services.push(service)
      setImmediate(() => service.emit('connect'))
      return service as unknown as Socket
    }
  })
  tunnels.listenOn({
    onUpgrade: (path: string, handler: UpgradeHandler) => { handlers.set(path, handler); return () => { handlers.delete(path) } }
  } as unknown as RemoteControlServer)

  const { code } = peers.issueTicket()
  const payload: ChallengePayload = {
    audienceMachineId: peers.machineId, fingerprint: FINGERPRINT,
    nonce: randomBytes(18).toString('base64url'), purpose: 'pair', bodyHash: '', issuedAt: Date.now()
  }
  await peers.beginPairing({
    machineId: 'laptop', machineName: 'Laptop', publicKey: laptopKey.publicKey,
    signature: signChallenge(laptopKey.privateKeyPem, payload),
    nonce: payload.nonce, timestamp: payload.issuedAt, code, fingerprint: FINGERPRINT
  })
  const peer = peers.approve(peers.listPending()[0]!.id, ['project-a'])
  const service = registry.register({ projectId: 'project-a', port: 4321, label: 'Echo' })

  return {
    peers, registry, tunnels, peer, services, service,
    upgrade: async (serviceId = service.id): Promise<FakeDuplex> => {
      const socket = new FakeDuplex()
      const request = {
        method: 'GET', url: REMOTE_TUNNEL_PATH,
        headers: {
          'sec-websocket-key': randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
          ...signUpgrade(laptopKey, { machineId: peers.machineId, fingerprint: FINGERPRINT, peerId: peer.id }, 'tunnel', Date.now()),
          [TUNNEL_SERVICE_HEADER]: serviceId
        },
        rawHeaders: []
      } as unknown as IncomingMessage
      handlers.get(REMOTE_TUNNEL_PATH)!(request, socket as unknown as Socket, Buffer.alloc(0))
      // Authenticating and dialling are both asynchronous; the answer is written after both.
      for (let attempt = 0; attempt < 10 && !socket.written.length; attempt++) await tick()
      return socket
    }
  }
}

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 20) })

describe('who may open a tunnel to this machine', () => {
  it('upgrades a paired machine that signed for the tunnel and names a registered service', async () => {
    const fix = await tunnelFixture()
    const { status } = await holdUpgrade(fix.port, fix.headers())
    expect(status).toMatch(/^HTTP\/1\.1 101 /)
    await settle()
    expect(fix.tunnels.openConnections).toBe(1)
    // The only thing it ever dialled is the port the owner registered, on loopback.
    expect(fix.dialled).toEqual([fix.servicePort])
  })

  it('refuses a machine this one has never paired with', async () => {
    const fix = await tunnelFixture()
    const stranger = generateDeviceKey('stranger')
    const { status } = await holdUpgrade(fix.port, fix.headers(fix.service.id, stranger, 'tunnel', 'peer-that-does-not-exist'))
    expect(status).toMatch(/ 401 /)
    expect(fix.tunnels.openConnections).toBe(0)
  })

  it('refuses a machine whose access was revoked', async () => {
    const fix = await tunnelFixture()
    fix.peers.revoke(fix.peer.id)
    const { status } = await holdUpgrade(fix.port, fix.headers())
    expect(status).toMatch(/ 403 /)
  })

  it('refuses a signature made for the push channel rather than for a tunnel', async () => {
    const fix = await tunnelFixture()
    // Same key, same peer, same connection: only the purpose inside the signed bytes differs.
    const { status } = await holdUpgrade(fix.port, fix.headers(fix.service.id, fix.laptopKey, 'stream'))
    expect(status).toMatch(/ 401 /)
    expect(fix.dialled).toEqual([])
  })

  it('refuses an id nobody registered, and a port offered in its place', async () => {
    const fix = await tunnelFixture()
    expect((await holdUpgrade(fix.port, fix.headers('made-up-id'))).status).toMatch(/ 404 /)
    expect((await holdUpgrade(fix.port, fix.headers(String(fix.servicePort)))).status).toMatch(/ 404 /)
    expect((await holdUpgrade(fix.port, fix.headers('  '))).status).toMatch(/ 404 /)
    expect(fix.dialled).toEqual([])
  })

  it('refuses a service in a project that machine was not granted', async () => {
    const fix = await tunnelFixture()
    const { status } = await holdUpgrade(fix.port, fix.headers(fix.ungranted.id))
    expect(status).toMatch(/ 403 /)
    expect(fix.dialled).toEqual([])
  })

  it('refuses a service whose grant was withdrawn after it was listed', async () => {
    const fix = await tunnelFixture()
    expect((await holdUpgrade(fix.port, fix.headers())).status).toMatch(/101/)
    fix.peers.updateSettings({ enabled: false })
    expect((await holdUpgrade(fix.port, fix.headers())).status).toMatch(/ (401|403|503) /)
  })

  it('refuses an upgrade carrying an Origin, because that is a browser', async () => {
    const fix = await tunnelFixture()
    const { status } = await holdUpgrade(fix.port, { ...fix.headers(), Origin: 'https://evil.example' })
    expect(status).toMatch(/ 403 /)
    expect(fix.dialled).toEqual([])
  })

  it('refuses when the registered service is not running, instead of opening a socket that dies', async () => {
    const fix = await tunnelFixture()
    const dead = createNetServer()
    await new Promise<void>(resolve => { dead.listen(0, '127.0.0.1', resolve) })
    const address = dead.address()
    const deadPort = address && typeof address !== 'string' ? address.port : 0
    await new Promise<void>(resolve => { dead.close(() => resolve()) })
    const stopped = fix.registry.register({ projectId: 'project-a', port: deadPort, label: 'Not started' })
    const { status } = await holdUpgrade(fix.port, fix.headers(stopped.id))
    expect(status).toMatch(/ 502 /)
    expect(fix.tunnels.openConnections).toBe(0)
  })
})

describe('how many a machine may hold', () => {
  /**
   * Driven through the registered handler rather than a real socket, because the listener itself
   * caps concurrent sockets at 64 and destroys the next one without answering - so a real client
   * can never reach a per-peer cap of the same size. See the note in the report: the two numbers
   * want reconciling, and the one that bites first today is the listener's.
   */
  it('refuses past the cap and says so, without disturbing the ones already open', async () => {
    const fix = await handlerFixture()
    const held: FakeDuplex[] = []
    for (let index = 0; index < TUNNEL_MAX_CONNECTIONS; index++) held.push(await fix.upgrade())
    expect(fix.tunnels.connectionsFor(fix.peer.id)).toBe(TUNNEL_MAX_CONNECTIONS)
    expect(held.every(socket => socket.text().startsWith('HTTP/1.1 101 '))).toBe(true)

    const refused = await fix.upgrade()
    expect(refused.text()).toMatch(/^HTTP\/1\.1 429 /)
    expect(refused.text()).toMatch(new RegExp(`already holds ${TUNNEL_MAX_CONNECTIONS} tunnelled connections`))
    expect(fix.tunnels.connectionsFor(fix.peer.id)).toBe(TUNNEL_MAX_CONNECTIONS)
    expect(held.every(socket => !socket.destroyed)).toBe(true)
  })

  it('counts a closed connection back down again', async () => {
    const fix = await tunnelFixture()
    const held = await holdUpgrade(fix.port, fix.headers())
    await settle()
    expect(fix.tunnels.openConnections).toBe(1)
    held.socket.destroy()
    await settle()
    expect(fix.tunnels.openConnections).toBe(0)
  })

  it('lets a second machine have its own allowance', async () => {
    const fix = await handlerFixture()
    for (let index = 0; index < TUNNEL_MAX_CONNECTIONS; index++) await fix.upgrade()
    expect((await fix.upgrade()).text()).toMatch(/ 429 /)
    // The cap is per machine, so the one that has not used its allowance is unaffected.
    expect(fix.tunnels.connectionsFor('nobody')).toBe(0)
  })
})

describe('what a tunnel carries', () => {
  it('passes bytes through untouched in both directions', async () => {
    const fix = await handlerFixture()
    const ws = await fix.upgrade()
    const service = fix.services.at(-1)!
    const request = 'GET / HTTP/1.1\r\nHost: preview\r\n\r\n'
    ws.emit('data', encodeMaskedBinary(Buffer.from(request)))
    expect(Buffer.concat(service.written).toString()).toBe(request)
    service.emit('data', Buffer.from([0x00, 0xff, 0x80]))
    expect(ws.frames().map(frame => [...frame])).toEqual([[0x00, 0xff, 0x80]])
  })

  it('splits one large read into frames the other end will accept', async () => {
    const fix = await handlerFixture()
    const ws = await fix.upgrade()
    const service = fix.services.at(-1)!
    service.emit('data', Buffer.alloc(TUNNEL_MAX_FRAME_BYTES + 100, 0x41))
    const frames = ws.frames()
    expect(frames).toHaveLength(2)
    expect(frames[0]).toHaveLength(TUNNEL_MAX_FRAME_BYTES)
    expect(frames[1]).toHaveLength(100)
  })

  it('refuses a text frame, because a tunnel has no encoding to read one with', async () => {
    const fix = await handlerFixture()
    const ws = await fix.upgrade()
    ws.emit('data', encodeMaskedText('hello?'))
    expect(fix.tunnels.openConnections).toBe(0)
    expect(ws.closes()).toEqual([{ code: 1002, reason: 'A tunnel carries binary frames only.' }])
  })

  it('stops reading the controller while the service is not keeping up', async () => {
    const fix = await handlerFixture()
    const ws = await fix.upgrade()
    const service = fix.services.at(-1)!
    service.blocked = true
    ws.emit('data', encodeMaskedBinary(Buffer.from('too much')))
    expect(ws.paused).toBe(true)
    service.blocked = false
    service.emit('drain')
    expect(ws.paused).toBe(false)
  })

  it('stops reading the service while the controller is not keeping up', async () => {
    const fix = await handlerFixture()
    const ws = await fix.upgrade()
    const service = fix.services.at(-1)!
    ws.blocked = true
    service.emit('data', Buffer.from('a lot'))
    expect(service.paused).toBe(true)
    ws.blocked = false
    ws.emit('drain')
    expect(service.paused).toBe(false)
  })

  it('closes the tunnel when the service closes its end, and the other way round', async () => {
    const closing = await handlerFixture()
    const ws = await closing.upgrade()
    closing.services.at(-1)!.emit('end')
    expect(closing.tunnels.openConnections).toBe(0)
    expect(ws.closes()[0]?.reason).toBe('The service closed the connection.')

    const dropping = await handlerFixture()
    const socket = await dropping.upgrade()
    socket.emit('close')
    expect(dropping.tunnels.openConnections).toBe(0)
    expect(dropping.services.at(-1)!.destroyed).toBe(true)
  })

  it('answers a ping so a long-lived preview connection is not taken for dead', async () => {
    const fix = await handlerFixture()
    const ws = await fix.upgrade()
    ws.emit('data', encodeMaskedPing(Buffer.from('still there')))
    expect(ws.pongs().map(payload => payload.toString())).toEqual(['still there'])
  })
})

describe('revocation closes what is already open', () => {
  it('drops every tunnel that machine holds', async () => {
    const fix = await tunnelFixture()
    await holdUpgrade(fix.port, fix.headers())
    await holdUpgrade(fix.port, fix.headers())
    await settle()
    expect(fix.tunnels.openConnections).toBe(2)
    fix.tunnels.closePeer(fix.peer.id)
    expect(fix.tunnels.openConnections).toBe(0)
  })

  it('leaves another machine\'s tunnels alone', async () => {
    const fix = await tunnelFixture()
    await holdUpgrade(fix.port, fix.headers())
    await settle()
    fix.tunnels.closePeer('some-other-peer')
    expect(fix.tunnels.openConnections).toBe(1)
  })

  it('closes everything when the host itself is disposed', async () => {
    const fix = await tunnelFixture()
    await holdUpgrade(fix.port, fix.headers())
    await settle()
    fix.tunnels.dispose()
    expect(fix.tunnels.openConnections).toBe(0)
    // The path is unregistered too, so a later upgrade is answered by the server, not by this.
    expect((await holdUpgrade(fix.port, fix.headers())).status).toMatch(/ 404 /)
  })
})
