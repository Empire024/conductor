import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RemotePeerRecord, RemoteProjectSummary } from '../shared/remote-control'
import {
  REMOTE_STREAM_PATH,
  REMOTE_STREAM_PROTOCOL,
  STREAM_MAX_QUEUED_FRAMES,
  STREAM_TIMEOUT_MS,
  type StreamClientFrame,
  type StreamHostFrame
} from '../shared/remote-stream'
import { FrameDecoder, encodeMaskedText, encodeMaskedPong } from '../shared/websocket-framing'
import { generateDeviceKey, signChallenge, type ChallengePayload, type DeviceKeyPair } from './device-key'
import type { RemoteControlServer, UpgradeHandler } from './remote-control-server'
import { hashBody, NONCE_HEADER, PEER_HEADER, RemotePeers, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './remote-peers'
import { RemoteStreamHost, type TerminalSubscription } from './remote-stream-host'
import { signUpgrade } from './remote-stream-client'
import type { SecretKeyValueStore } from './secret-store'

const FINGERPRINT = 'AA:BB:CC:DD'
const IDENTITY = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: '/tmp/a', name: 'Conductor' }
const OTHER_IDENTITY = { key: 'b'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: '/tmp/b', name: 'Other' }
const PROJECTS: RemoteProjectSummary[] = [
  { id: 'project-a', name: 'Conductor', path: '/tmp/a', identity: IDENTITY, identityError: null },
  { id: 'project-b', name: 'Other', path: '/tmp/b', identity: OTHER_IDENTITY, identityError: null }
]

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

/**
 * A socket with no network under it: the host writes bytes here and the test reads them, which is
 * what makes backpressure and heartbeat testable at all - a real loopback socket never refuses a
 * write small enough to matter.
 */
class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = []
  blocked = false
  destroyed = false
  writable = true
  ended = false
  setNoDelay(): void { /* nothing under this socket to tune */ }
  setTimeout(): void { /* the host runs its own heartbeat */ }
  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, 'utf8'))
    return !this.blocked
  }
  end(chunk?: Buffer | string): void {
    if (chunk) this.written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, 'utf8'))
    this.ended = true
  }
  destroy(): void { if (!this.destroyed) { this.destroyed = true; this.emit('close') } }
  /** Bytes from the controller, masked exactly as a real client masks them. */
  fromClient(frame: StreamClientFrame | Buffer): void {
    this.emit('data', Buffer.isBuffer(frame) ? frame : encodeMaskedText(JSON.stringify(frame)))
  }
}

/** Decodes what the host has written so far: the 101, then frames. */
class Wire {
  readonly frames: StreamHostFrame[] = []
  readonly pings: Buffer[] = []
  readonly closes: Array<{ code: number; reason: string }> = []
  private consumed = 0
  private handshake = ''
  private decoder = new FrameDecoder({ maxMessageBytes: 1024 * 1024, requireMask: false }, {
    message: message => { this.frames.push(JSON.parse(message.data.toString('utf8')) as StreamHostFrame) },
    ping: payload => { this.pings.push(payload) },
    pong: () => { /* a host never pongs unprompted */ },
    close: (code, reason) => { this.closes.push({ code, reason }) },
    fail: (code, reason) => { this.closes.push({ code, reason }) }
  })

  constructor(private readonly socket: FakeSocket) {}

  read(): this {
    while (this.consumed < this.socket.written.length) {
      let chunk = this.socket.written[this.consumed++]!
      if (!this.handshake) {
        const text = chunk.toString('latin1')
        const end = text.indexOf('\r\n\r\n')
        if (end < 0) { this.handshake = ''; continue }
        this.handshake = text.slice(0, end)
        chunk = chunk.subarray(end + 4)
      }
      if (chunk.length) this.decoder.push(chunk)
    }
    return this
  }

  get status(): string { return this.handshake.split('\r\n')[0] ?? '' }
  last(): StreamHostFrame | undefined { return this.read().frames[this.frames.length - 1] }
  typed<T extends StreamHostFrame['type']>(type: T): Array<Extract<StreamHostFrame, { type: T }>> {
    return this.read().frames.filter((frame): frame is Extract<StreamHostFrame, { type: T }> => frame.type === type)
  }
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function fixture() {
  let clock = Date.parse('2026-09-16T10:00:00.000Z')
  const store = new MapStore()
  const laptopKey = generateDeviceKey('laptop')
  const peers = new RemotePeers({
    store,
    accountId: () => 4242,
    accountLogin: () => 'Empire024',
    accountKeys: async () => [laptopKey.publicKey],
    projects: () => PROJECTS,
    now: () => clock
  })
  peers.updateSettings({ enabled: true, port: 0, machineName: 'Render Desktop' })
  peers.setFingerprint(FINGERPRINT)
  const upgrades = new Map<string, UpgradeHandler>()
  const server = {
    onUpgrade: (path: string, handler: UpgradeHandler) => { upgrades.set(path, handler); return () => { upgrades.delete(path) } },
    identity: () => ({ fingerprint: FINGERPRINT })
  } as unknown as RemoteControlServer
  const beats: Array<() => void> = []
  const terminalSubscribes: TerminalSubscription[] = []
  const terminalUnsubscribes: Array<{ peerId: string; terminalId: string }> = []
  const host = new RemoteStreamHost({
    peers,
    machineName: () => 'Render Desktop',
    fingerprint: () => FINGERPRINT,
    now: () => clock,
    schedule: run => { beats.push(run); return { cancel: () => { const at = beats.indexOf(run); if (at >= 0) beats.splice(at, 1) } } }
  })
  host.onTerminalSubscribe(entry => terminalSubscribes.push(entry))
  host.onTerminalUnsubscribe(entry => terminalUnsubscribes.push(entry))
  host.listenOn(server)
  return {
    peers, host, laptopKey, terminalSubscribes, terminalUnsubscribes,
    advance: (ms: number) => { clock += ms },
    now: () => clock,
    beat: () => { for (const run of [...beats]) run() },
    upgrade: (headers: Record<string, string>, socket: FakeSocket) => {
      const handler = upgrades.get(REMOTE_STREAM_PATH)
      if (!handler) throw new Error('nothing registered /v1/stream')
      const request = {
        method: 'GET',
        url: REMOTE_STREAM_PATH,
        headers: { 'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13', ...headers },
        rawHeaders: []
      } as unknown as IncomingMessage
      handler(request, socket as unknown as Socket, Buffer.alloc(0))
    }
  }
}

/** Pairs a laptop and approves it for the projects named. */
async function approve(fix: ReturnType<typeof fixture>, projectIds = ['project-a']): Promise<RemotePeerRecord> {
  const { code } = fix.peers.issueTicket()
  const payload: ChallengePayload = {
    audienceMachineId: fix.peers.machineId, fingerprint: FINGERPRINT,
    nonce: randomBytes(18).toString('base64url'), purpose: 'pair', bodyHash: '', issuedAt: fix.now()
  }
  await fix.peers.beginPairing({
    machineId: 'laptop', machineName: 'Laptop', publicKey: fix.laptopKey.publicKey,
    signature: signChallenge(fix.laptopKey.privateKeyPem, payload),
    nonce: payload.nonce, timestamp: payload.issuedAt, code, fingerprint: FINGERPRINT
  })
  return fix.peers.approve(fix.peers.listPending()[0]!.id, projectIds)
}

/** One authenticated, greeted controller on an open socket. */
async function connect(fix: ReturnType<typeof fixture>, peer: RemotePeerRecord, key?: DeviceKeyPair) {
  const socket = new FakeSocket()
  fix.upgrade(signUpgrade(key ?? fix.laptopKey, { machineId: fix.peers.machineId, fingerprint: FINGERPRINT, peerId: peer.id }, 'stream', fix.now()), socket)
  await flush()
  const wire = new Wire(socket)
  socket.fromClient({ type: 'hello', protocol: REMOTE_STREAM_PROTOCOL, machineId: 'laptop', generation: 1 })
  return { socket, wire }
}

describe('opening the push channel', () => {
  let fix: ReturnType<typeof fixture>
  beforeEach(() => { fix = fixture() })

  it('upgrades an approved peer that signed the challenge for this connection and greets it', async () => {
    const peer = await approve(fix)
    const { wire } = await connect(fix, peer)
    expect(wire.read().status).toMatch(/^HTTP\/1\.1 101 /)
    expect(wire.frames[0]).toEqual({
      type: 'welcome', protocol: REMOTE_STREAM_PROTOCOL, machineId: fix.peers.machineId, machineName: 'Render Desktop', generation: 0
    })
    expect(fix.host.openSessions).toBe(1)
  })

  it('refuses a signature made for an ordinary call rather than for the stream', async () => {
    const peer = await approve(fix)
    const socket = new FakeSocket()
    // Same key, same peer, same connection - only the purpose inside the signed bytes differs, and
    // that is exactly what stops a captured call from being replayed as a subscription.
    const payload: ChallengePayload = {
      audienceMachineId: fix.peers.machineId, fingerprint: FINGERPRINT,
      nonce: randomBytes(18).toString('base64url'), purpose: 'call', bodyHash: hashBody(Buffer.alloc(0)), issuedAt: fix.now()
    }
    fix.upgrade({
      [PEER_HEADER]: peer.id, [NONCE_HEADER]: payload.nonce,
      [TIMESTAMP_HEADER]: String(payload.issuedAt),
      [SIGNATURE_HEADER]: signChallenge(fix.laptopKey.privateKeyPem, payload)
    }, socket)
    await flush()
    expect(new Wire(socket).read().status).toMatch(/^HTTP\/1\.1 401 /)
    expect(fix.host.openSessions).toBe(0)
  })

  it('refuses a machine that was never paired and one whose access was revoked', async () => {
    const stranger = new FakeSocket()
    const strangerKey = generateDeviceKey('stranger')
    fix.upgrade(signUpgrade(strangerKey, { machineId: fix.peers.machineId, fingerprint: FINGERPRINT, peerId: 'made-up' }, 'stream', fix.now()), stranger)
    await flush()
    expect(new Wire(stranger).read().status).toMatch(/^HTTP\/1\.1 401 /)

    const peer = await approve(fix)
    fix.peers.revoke(peer.id)
    const revoked = new FakeSocket()
    fix.upgrade(signUpgrade(fix.laptopKey, { machineId: fix.peers.machineId, fingerprint: FINGERPRINT, peerId: peer.id }, 'stream', fix.now()), revoked)
    await flush()
    expect(new Wire(revoked).read().status).toMatch(/^HTTP\/1\.1 403 /)
    expect(fix.host.openSessions).toBe(0)
  })

  it('hangs up on a controller that speaks a different protocol version', async () => {
    const peer = await approve(fix)
    const socket = new FakeSocket()
    fix.upgrade(signUpgrade(fix.laptopKey, { machineId: fix.peers.machineId, fingerprint: FINGERPRINT, peerId: peer.id }, 'stream', fix.now()), socket)
    await flush()
    const wire = new Wire(socket)
    socket.fromClient({ type: 'hello', protocol: REMOTE_STREAM_PROTOCOL + 9, machineId: 'laptop', generation: 1 })
    expect(wire.typed('error')[0]).toMatchObject({ code: 'protocol' })
    expect(socket.destroyed).toBe(true)
    expect(fix.host.openSessions).toBe(0)
  })

  it('refuses to answer anything before a hello', async () => {
    const peer = await approve(fix)
    const socket = new FakeSocket()
    fix.upgrade(signUpgrade(fix.laptopKey, { machineId: fix.peers.machineId, fingerprint: FINGERPRINT, peerId: peer.id }, 'stream', fix.now()), socket)
    await flush()
    const wire = new Wire(socket)
    socket.fromClient({ type: 'subscribe', projectId: 'project-a', sessionId: 'session-1' })
    expect(wire.typed('error')[0]).toMatchObject({ code: 'protocol' })
    expect(socket.destroyed).toBe(true)
  })
})

describe('what a subscribed controller is told', () => {
  let fix: ReturnType<typeof fixture>
  beforeEach(() => { fix = fixture() })

  it('refuses a subscription to a project that was never shared, and keeps the connection', async () => {
    const peer = await approve(fix, ['project-a'])
    const { socket, wire } = await connect(fix, peer)
    socket.fromClient({ type: 'subscribe', projectId: 'project-b', sessionId: 'session-1' })
    expect(wire.typed('error')[0]).toMatchObject({ code: 'authorization' })
    // One refused subscription is not a broken connection: everything else it watches still works.
    expect(socket.destroyed).toBe(false)
    fix.host.notifyTabs('project-b', 'session-1')
    expect(wire.typed('tabs.changed')).toHaveLength(0)
  })

  it('sends a notice only to the connections subscribed to that conversation', async () => {
    const peer = await approve(fix, ['project-a'])
    const watching = await connect(fix, peer)
    watching.socket.fromClient({ type: 'subscribe', projectId: 'project-a', sessionId: 'session-1' })
    fix.host.notifyAgents('project-a', 'session-1', 'agent-7', 42)
    fix.host.notifyAgents('project-a', 'session-2', 'agent-8', 43)
    fix.host.notifyTasks('project-a')
    fix.host.notifyFiles('project-a', 'src/main.ts')
    expect(watching.wire.typed('agents.changed')).toEqual([
      { type: 'agents.changed', projectId: 'project-a', sessionId: 'session-1', agentSessionId: 'agent-7', sequence: 42 }
    ])
    expect(watching.wire.typed('tasks.changed')).toHaveLength(1)
    expect(watching.wire.typed('files.changed')[0]).toMatchObject({ path: 'src/main.ts' })
  })

  it('tells whoever feeds the terminals who attached and from which offset', async () => {
    const peer = await approve(fix, ['project-a'])
    const { socket, wire } = await connect(fix, peer)
    socket.fromClient({ type: 'terminal.subscribe', projectId: 'project-a', sessionId: 'session-1', terminalId: 'pty-1', fromOffset: 2048 })
    expect(fix.terminalSubscribes).toEqual([{ peerId: peer.id, terminalId: 'pty-1', projectId: 'project-a', sessionId: 'session-1', fromOffset: 2048 }])
    fix.host.terminalData('pty-1', 2048, Buffer.from('hello').toString('base64'))
    fix.host.terminalGap('pty-1', 99, 2200)
    fix.host.terminalExit('pty-1', 0)
    fix.host.terminalData('pty-other', 0, 'aGk=')
    expect(wire.typed('terminal.data')).toEqual([{ type: 'terminal.data', terminalId: 'pty-1', offset: 2048, data: Buffer.from('hello').toString('base64') }])
    expect(wire.typed('terminal.gap')[0]).toMatchObject({ lostBytes: 99, offset: 2200 })
    expect(wire.typed('terminal.exit')[0]).toMatchObject({ exitCode: 0 })
    socket.fromClient({ type: 'terminal.unsubscribe', terminalId: 'pty-1' })
    expect(fix.terminalUnsubscribes).toEqual([{ peerId: peer.id, terminalId: 'pty-1' }])
  })

  it('judges every subscription against the grant as it is now, not as it was at the upgrade', async () => {
    const peer = await approve(fix, ['project-a'])
    const { socket, wire } = await connect(fix, peer)
    socket.fromClient({ type: 'subscribe', projectId: 'project-a', sessionId: 'session-1' })
    fix.host.notifyTabs('project-a', 'session-1')
    expect(wire.typed('tabs.changed')).toHaveLength(1)
    // Revoking is normally followed by closePeer, which hangs the socket up. This is the layer
    // underneath: even on a socket that somehow outlived the revocation, nothing more is granted.
    fix.peers.revoke(peer.id)
    socket.fromClient({ type: 'subscribe', projectId: 'project-a', sessionId: 'session-2' })
    expect(wire.typed('error').at(-1)).toMatchObject({ code: 'authorization' })
    fix.host.notifyTabs('project-a', 'session-2')
    expect(wire.typed('tabs.changed')).toHaveLength(1)
  })
})

describe('keeping the channel honest', () => {
  let fix: ReturnType<typeof fixture>
  beforeEach(() => { fix = fixture() })

  it('pings while a controller answers and hangs up once it has gone silent', async () => {
    const peer = await approve(fix)
    const { socket, wire } = await connect(fix, peer)
    fix.advance(20_000)
    fix.beat()
    expect(wire.read().pings).toHaveLength(1)
    // A pong is the controller proving it is there; the clock moving past the timeout without one
    // is a socket that is open in this process and gone on the wire.
    socket.emit('data', encodeMaskedPong(Buffer.alloc(0)))
    fix.advance(STREAM_TIMEOUT_MS - 1)
    fix.beat()
    expect(socket.destroyed).toBe(false)
    fix.advance(STREAM_TIMEOUT_MS)
    fix.beat()
    expect(socket.destroyed).toBe(true)
    expect(fix.host.openSessions).toBe(0)
  })

  it('closes a controller that falls too far behind instead of queueing for it', async () => {
    const peer = await approve(fix)
    const { socket, wire } = await connect(fix, peer)
    socket.fromClient({ type: 'subscribe', projectId: 'project-a', sessionId: 'session-1' })
    socket.blocked = true
    // Distinct terminals, so nothing coalesces and the queue really grows.
    for (let index = 0; index <= STREAM_MAX_QUEUED_FRAMES + 2; index++) {
      socket.fromClient({ type: 'terminal.subscribe', projectId: 'project-a', sessionId: 'session-1', terminalId: `pty-${index}`, fromOffset: 0 })
      fix.host.terminalData(`pty-${index}`, 0, 'aGk=')
    }
    expect(wire.typed('error').at(-1)).toMatchObject({ code: 'overloaded' })
    expect(socket.destroyed).toBe(true)
  })

  it('collapses repeated notices for the same thing while the socket is blocked', async () => {
    const peer = await approve(fix)
    const { socket, wire } = await connect(fix, peer)
    socket.fromClient({ type: 'subscribe', projectId: 'project-a', sessionId: 'session-1' })
    socket.blocked = true
    for (let sequence = 1; sequence <= 50; sequence++) fix.host.notifyAgents('project-a', 'session-1', 'agent-7', sequence)
    socket.blocked = false
    socket.emit('drain')
    const notices = wire.typed('agents.changed')
    // The first was already handed to the socket before it said it was full; the other forty-nine
    // collapsed into one carrying the newest cursor. The controller fetches from its own cursor up
    // to that, so the forty-eight dropped frames said nothing it will not learn from this one.
    expect(notices).toHaveLength(2)
    expect(notices.map(notice => notice.sequence)).toEqual([1, 50])
    expect(socket.destroyed).toBe(false)
  })

  it('closes a revoked peer immediately and says why', async () => {
    const peer = await approve(fix)
    const { socket, wire } = await connect(fix, peer)
    fix.host.closePeer(peer.id, 'Access for this machine was revoked.')
    expect(wire.typed('revoked')[0]).toMatchObject({ reason: 'Access for this machine was revoked.' })
    expect(socket.destroyed).toBe(true)
    expect(fix.host.openSessions).toBe(0)
  })

  it('refuses a frame larger than the protocol allows rather than buffering it', async () => {
    const peer = await approve(fix)
    const { socket } = await connect(fix, peer)
    socket.fromClient(encodeMaskedText('x'.repeat(300 * 1024)))
    expect(socket.destroyed).toBe(true)
    expect(fix.host.openSessions).toBe(0)
  })

  it('drops every connection when the host stops serving', async () => {
    const peer = await approve(fix)
    const { socket } = await connect(fix, peer)
    fix.host.stop()
    expect(socket.destroyed).toBe(true)
    expect(fix.host.openSessions).toBe(0)
  })
})
