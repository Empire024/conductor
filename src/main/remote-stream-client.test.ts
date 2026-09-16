import { beforeEach, describe, expect, it } from 'vitest'
import type { RemoteConnection } from '../shared/remote-control'
import {
  REMOTE_STREAM_PROTOCOL,
  STREAM_HEARTBEAT_MS,
  STREAM_RECONNECT_MAX_MS,
  STREAM_TIMEOUT_MS,
  type StreamClientFrame,
  type StreamHostFrame
} from '../shared/remote-stream'
import { challengeBytes, generateDeviceKey, verifyChallenge, type ChallengePayload } from './device-key'
import { hashBody, NONCE_HEADER, PEER_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './remote-peers'
import { RemoteStreamClient, classifyClose, signUpgrade, streamUrl, type StreamSocket } from './remote-stream-client'
import type { RelaySocketEvents, RelaySocketOptions } from './relay-socket'

const HOST_KEY = generateDeviceKey('laptop')

const connection = (overrides: Partial<RemoteConnection> = {}): RemoteConnection => ({
  machineId: 'render-desktop',
  machineName: 'Render Desktop',
  accountLogin: 'Empire024',
  host: '100.80.1.2',
  port: 51840,
  fingerprint: 'AA:BB:CC',
  peerId: 'peer-1',
  transport: 'tailscale',
  generation: 3,
  projectGrants: [],
  remoteProjects: [],
  remoteProjectsAt: null,
  unconfirmedRemoteProjectIds: [],
  connectedAt: '2026-09-16T09:00:00.000Z',
  lastContactAt: null,
  status: 'connected',
  message: null,
  ...overrides
})

/** A socket the test opens, feeds and breaks by hand. */
class FakeStream implements StreamSocket {
  connected = false
  readonly sent: StreamClientFrame[] = []
  pings = 0
  closedWith: { code?: number; reason?: string } | null = null
  constructor(readonly url: string, readonly events: RelaySocketEvents, readonly options: RelaySocketOptions) {}
  connect(): void { /* the test decides when this one opens */ }
  send(value: unknown): void { this.sent.push(value as StreamClientFrame) }
  ping(): void { this.pings += 1 }
  close(code?: number, reason?: string): void { this.connected = false; this.closedWith = { code, reason } }
  /** The host answering: upgrade, then whatever frame the test wants. */
  welcome(generation = 0, protocol = REMOTE_STREAM_PROTOCOL): void {
    this.connected = true
    this.events.open()
    this.events.frame({ type: 'welcome', protocol, machineId: 'render-desktop', machineName: 'Render Desktop', generation })
  }
  deliver(frame: StreamHostFrame): void { this.events.frame(frame as unknown as Record<string, unknown>) }
  broke(error?: Error & { code?: string; status?: number }, code = 1006): void {
    this.connected = false
    this.events.closed({ code, reason: error?.message ?? '', ...(error ? { error } : {}) })
  }
}

function fixture(record: RemoteConnection | undefined = connection(), random = 1) {
  let clock = Date.parse('2026-09-16T10:00:00.000Z')
  let current = record
  const sockets: FakeStream[] = []
  const frames: StreamHostFrame[] = []
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = []
  let changed = 0
  const client = new RemoteStreamClient({
    connection: () => current,
    deviceKey: () => HOST_KEY,
    machineId: () => 'laptop-machine',
    onFrame: frame => frames.push(frame),
    changed: () => { changed += 1 },
    now: () => clock,
    random: () => random,
    after: (ms, run) => {
      const entry = { ms, run, cancelled: false }
      timers.push(entry)
      return { cancel: () => { entry.cancelled = true } }
    },
    createSocket: (url, events, options) => {
      const socket = new FakeStream(url, events, options)
      sockets.push(socket)
      return socket
    }
  })
  return {
    client, sockets, frames, timers,
    changes: () => changed,
    advance: (ms: number) => { clock += ms },
    /** Runs every timer that is still armed, as a scheduler would. */
    fire: (ms?: number) => {
      const due = timers.filter(timer => !timer.cancelled && (ms === undefined || timer.ms === ms))
      for (const timer of due) { timer.cancelled = true; timer.run() }
      return due.map(timer => timer.ms)
    },
    latest: () => sockets[sockets.length - 1]!,
    retries: () => timers.filter(timer => timer.ms !== STREAM_HEARTBEAT_MS).map(timer => timer.ms)
  }
}

describe('opening the push channel from the controlling machine', () => {
  it('signs the upgrade for the stream, over the host that is being dialled', () => {
    const headers = signUpgrade(HOST_KEY, { machineId: 'render-desktop', fingerprint: 'AA:BB:CC', peerId: 'peer-1' }, 'stream', 1_700_000)
    const payload: ChallengePayload = {
      audienceMachineId: 'render-desktop',
      fingerprint: 'AA:BB:CC',
      nonce: headers[NONCE_HEADER]!,
      purpose: 'stream',
      bodyHash: hashBody(Buffer.alloc(0)),
      issuedAt: 1_700_000
    }
    expect(headers[PEER_HEADER]).toBe('peer-1')
    expect(headers[TIMESTAMP_HEADER]).toBe('1700000')
    expect(verifyChallenge(HOST_KEY.publicKey, payload, headers[SIGNATURE_HEADER]!)).toBe(true)
    // The same signature over the same bytes with 'call' in them is a different challenge, which
    // is what keeps a captured call from opening a stream and the other way round.
    expect(challengeBytes({ ...payload, purpose: 'call' }).equals(challengeBytes(payload))).toBe(false)
  })

  it('dials the host tailnet address over wss and brackets an IPv6 one', () => {
    expect(streamUrl('100.80.1.2', 51840)).toBe('wss://100.80.1.2:51840/v1/stream')
    expect(streamUrl('fd7a:115c:a1e0::1', 51840)).toBe('wss://[fd7a:115c:a1e0::1]:51840/v1/stream')
  })

  it('pins the host certificate and carries the signed headers on the upgrade', () => {
    const fix = fixture()
    fix.client.start()
    const socket = fix.latest()
    expect(socket.url).toBe('wss://100.80.1.2:51840/v1/stream')
    expect(socket.options.fingerprint).toBe('AA:BB:CC')
    expect(socket.options.headers?.[PEER_HEADER]).toBe('peer-1')
    expect(fix.client.snapshot()).toMatchObject({ state: 'connecting', transport: 'tailscale', generation: 3, failure: null })
  })

  it('refuses to dial anywhere but the tailnet for a Tailscale pairing', () => {
    const fix = fixture(connection({ host: '192.168.1.40' }))
    fix.client.start()
    // Not a socket that failed - a socket that was never opened. The address in the record cannot
    // be the paired machine over a tailnet, so sending a signed request to it is the fallback this
    // whole exposure exists to refuse.
    expect(fix.sockets).toHaveLength(0)
    expect(fix.client.snapshot()).toMatchObject({ state: 'offline', failure: 'network' })
    expect(fix.client.snapshot().detail).toMatch(/not a tailnet address/)
    expect(fix.retries()).toEqual([])
  })

  it('waits for an approval instead of calling it a refusal', () => {
    // A record still pending has no peer id to sign as. That is the owner not having pressed
    // approve yet, not a refusal, so nothing is dialled and nothing is given up on.
    const fix = fixture({ ...connection(), peerId: '' })
    fix.client.start()
    expect(fix.sockets).toHaveLength(0)
    expect(fix.client.snapshot()).toMatchObject({ state: 'offline', failure: null })
    expect(fix.client.snapshot().detail).toMatch(/approval/)
    expect(fix.retries()).toHaveLength(1)
  })

  it('never dials a host the owner detached from', () => {
    const fix = fixture(connection({ detached: true }))
    fix.client.start()
    expect(fix.sockets).toHaveLength(0)
    expect(fix.client.snapshot()).toMatchObject({ state: 'detached', failure: null, detail: 'Using this computer independently.' })
    expect(fix.retries()).toEqual([])
  })

  it('greets the host with this attachment generation and re-sends what it was watching', () => {
    const fix = fixture()
    fix.client.subscribe('project-a', 'session-1')
    fix.client.terminalSubscribe('project-a', 'session-1', 'pty-1', 4096)
    fix.client.start()
    fix.latest().welcome()
    expect(fix.client.snapshot()).toMatchObject({ state: 'connected', failure: null })
    expect(fix.latest().sent).toEqual([
      { type: 'hello', protocol: REMOTE_STREAM_PROTOCOL, machineId: 'laptop-machine', generation: 3 },
      { type: 'subscribe', projectId: 'project-a', sessionId: 'session-1' },
      { type: 'terminal.subscribe', terminalId: 'pty-1', projectId: 'project-a', sessionId: 'session-1', fromOffset: 4096 }
    ])
  })

  it('resumes a terminal from where the controller actually got to, not where it first attached', () => {
    const fix = fixture()
    fix.client.terminalSubscribe('project-a', 'session-1', 'pty-1', 0)
    fix.client.start()
    fix.latest().welcome()
    fix.latest().deliver({ type: 'terminal.data', terminalId: 'pty-1', offset: 0, data: Buffer.from('hello there').toString('base64') })
    fix.latest().broke()
    fix.fire()
    fix.latest().welcome()
    const resubscribe = fix.latest().sent.find(frame => frame.type === 'terminal.subscribe')
    expect(resubscribe).toMatchObject({ fromOffset: 11 })
  })
})

describe('what the controller does when the channel breaks', () => {
  let fix: ReturnType<typeof fixture>
  beforeEach(() => { fix = fixture() })

  it('calls a refused connection a host that is not running and backs off, doubling with a ceiling', () => {
    fix.client.start()
    for (let attempt = 0; attempt < 8; attempt++) {
      fix.latest().broke(Object.assign(new Error('Nothing is listening'), { code: 'ECONNREFUSED' }))
      if (attempt === 0) expect(fix.client.snapshot()).toMatchObject({ state: 'reconnecting', failure: 'host-not-running' })
      fix.fire()
    }
    // One second, doubling, and never past thirty: a laptop left open against a desktop that is
    // switched off must not keep knocking once a minute for ever, or once a millisecond either.
    expect(fix.retries()).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_MAX_MS])
  })

  it('jitters the wait rather than knocking in lockstep', () => {
    const twice = (fix: ReturnType<typeof fixture>): number[] => {
      fix.client.start()
      fix.latest().broke(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      fix.fire()
      fix.latest().broke(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
      return fix.retries()
    }
    // The same schedule under different dice. Two machines that lost the same network come back at
    // the same instant and knock in step for as long as it stays down; the jitter is what stops
    // that, and the one-second floor is what stops it becoming a flood.
    expect(twice(fixture(connection(), 1))).toEqual([1_000, 2_000])
    expect(twice(fixture(connection(), 0))).toEqual([1_000, 1_000])
    const unlucky = fixture(connection(), 0.5)
    expect(twice(unlucky)).toEqual([1_000, 1_500])
    expect(unlucky.client.nextRetryMs()).toBe(2_000)
  })

  it('calls an unreachable network a network problem and keeps trying', () => {
    fix.client.start()
    fix.latest().broke(Object.assign(new Error('no route'), { code: 'ENETUNREACH' }))
    expect(fix.client.snapshot()).toMatchObject({ state: 'reconnecting', failure: 'network' })
    expect(fix.retries()).toEqual([1_000])
  })

  it('stops for good when the host refuses the upgrade as unauthorized', () => {
    fix.client.start()
    fix.latest().broke(Object.assign(new Error('The host refused the connection (403).'), { status: 403 }))
    expect(fix.client.snapshot()).toMatchObject({ state: 'offline', failure: 'authorization' })
    expect(fix.retries()).toEqual([])
  })

  it('stops for good when something other than the paired machine answers that address', () => {
    fix.client.start()
    fix.latest().broke(Object.assign(new Error('different certificate'), { code: 'ERR_TLS_CERT_PIN' }))
    expect(fix.client.snapshot()).toMatchObject({ state: 'offline', failure: 'authorization' })
    expect(fix.retries()).toEqual([])
  })

  it('stops for good when the pairing is revoked mid-stream, and passes the frame on', () => {
    fix.client.start()
    fix.latest().welcome()
    fix.latest().deliver({ type: 'revoked', reason: 'Access for this machine was revoked.' })
    expect(fix.frames.at(-1)).toMatchObject({ type: 'revoked' })
    expect(fix.client.snapshot()).toMatchObject({ state: 'offline', failure: 'authorization' })
    expect(fix.retries()).toEqual([])
  })

  it('stops for good on a protocol the two machines do not share', () => {
    fix.client.start()
    fix.latest().welcome(0, REMOTE_STREAM_PROTOCOL + 4)
    expect(fix.client.snapshot()).toMatchObject({ state: 'offline', failure: 'protocol' })
    expect(fix.client.snapshot().detail).toMatch(/Update both computers/)
    expect(fix.retries()).toEqual([])

    // The host says why and then closes, in that order; the close is what carries the verdict.
    const errored = fixture()
    errored.client.start()
    errored.latest().welcome()
    errored.latest().deliver({ type: 'error', code: 'protocol', message: 'unknown frame' })
    errored.latest().broke(undefined, 1002)
    expect(errored.client.snapshot()).toMatchObject({ state: 'offline', failure: 'protocol' })
    expect(errored.client.snapshot().detail).toMatch(/unknown frame/)
    expect(errored.retries()).toEqual([])
  })

  it('keeps a connection the host only refused one subscription on', () => {
    // A refused subscription is answered with an error frame and nothing else: the socket stays up
    // and the rest of what this machine watches keeps flowing. That is not a reason to give up.
    fix.client.start()
    fix.latest().welcome()
    fix.client.subscribe('project-b', 'workspace-b')
    fix.latest().deliver({ type: 'error', code: 'authorization', message: 'That project is not shared with this machine.' })
    expect(fix.client.snapshot()).toMatchObject({ state: 'connected', failure: null })
    expect(fix.client.snapshot().detail).toMatch(/not shared/)
    fix.latest().deliver({ type: 'tasks.changed', projectId: 'project-a' })
    expect(fix.client.snapshot().state).toBe('connected')
    // A socket that later drops for an ordinary reason is still an ordinary drop.
    fix.latest().broke()
    expect(fix.client.snapshot()).toMatchObject({ state: 'reconnecting' })
    expect(fix.retries().length).toBe(1)
  })

  it('reconnects after the host says it fell behind, because that one fixes itself', () => {
    fix.client.start()
    fix.latest().welcome()
    fix.latest().deliver({ type: 'error', code: 'overloaded', message: 'too far behind' })
    expect(fix.client.snapshot()).toMatchObject({ state: 'reconnecting' })
    expect(fix.retries()).toEqual([1_000])
  })

  it('hangs up on a host that has gone quiet and reconnects', () => {
    fix.client.start()
    fix.latest().welcome()
    const first = fix.latest()
    fix.advance(STREAM_HEARTBEAT_MS)
    fix.fire(STREAM_HEARTBEAT_MS)
    expect(first.pings).toBe(1)
    // Silence on an open TCP connection looks exactly like a working one until something times out.
    fix.advance(STREAM_TIMEOUT_MS)
    fix.fire(STREAM_HEARTBEAT_MS)
    expect(first.closedWith).toMatchObject({ code: 1001 })
    expect(fix.client.snapshot()).toMatchObject({ state: 'reconnecting', failure: 'network' })
    expect(fix.client.stats.reconnects).toBe(1)
  })

  it('stops dialling altogether when the owner stops it', () => {
    fix.client.start()
    fix.latest().welcome()
    fix.client.stop()
    expect(fix.latest().closedWith).toMatchObject({ code: 1000 })
    expect(fix.client.snapshot()).toMatchObject({ state: 'offline' })
    fix.latest().broke()
    expect(fix.retries()).toEqual([])
  })
})

describe('classifying why a socket ended', () => {
  it('separates the four things that each need a different fix', () => {
    expect(classifyClose({ code: 1006, reason: '', error: Object.assign(new Error('x'), { status: 401 }) }, false))
      .toMatchObject({ failure: 'authorization', fatal: true })
    expect(classifyClose({ code: 1006, reason: '', error: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }, false))
      .toMatchObject({ failure: 'host-not-running', fatal: false })
    expect(classifyClose({ code: 1006, reason: '', error: Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }) }, false))
      .toMatchObject({ failure: 'network', fatal: false })
    expect(classifyClose({ code: 1006, reason: '', error: Object.assign(new Error('x'), { status: 404 }) }, false))
      .toMatchObject({ failure: 'protocol', fatal: true })
    // Nothing named a cause: a socket that was working and ended is the host going away, and one
    // that never opened is this machine failing to reach it. Both are worth trying again.
    expect(classifyClose({ code: 1000, reason: '' }, true)).toMatchObject({ failure: 'host-not-running', fatal: false })
    expect(classifyClose({ code: 1006, reason: '' }, false)).toMatchObject({ failure: 'network', fatal: false })
  })
})
