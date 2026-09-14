import { afterEach, describe, expect, it } from 'vitest'
import { RelayServer } from '../relay-server/server.ts'
import { relayHelloStatement } from '../shared/relay-protocol.ts'
import { ConductorRelay, relayEndpointUrl, type ConductorRelayDependencies } from './conductor-relay.ts'
import { generateDeviceKey, type DeviceKeyPair } from './device-key.ts'
import { generateSealKey, signDirectoryEntry, type RelaySealKeyPair } from './relay-crypto.ts'
import { buildEnvelopes } from './relay-envelope.ts'
import { generateRoomSecret, roomIdFor, welcomeProofFor } from './relay-room.ts'
import type { RelaySocketEvents } from './relay-socket.ts'

/**
 * Two machines linked through a relay that is actually listening, with real keys and real seals.
 *
 * The point of the relay is that it is not trusted, so the tests that matter are the refusals: an
 * answer signed by the wrong key, a relay that cannot prove it is the owner's, and a peer that is
 * simply not there. Each one is driven through the same code path a real call takes.
 */

const running: RelayServer[] = []
const relays: ConductorRelay[] = []

afterEach(async () => {
  while (relays.length) relays.pop()?.stop()
  while (running.length) await running.pop()?.close()
})

interface Machine {
  id: string
  key: DeviceKeyPair
  seal: RelaySealKeyPair
  relay: ConductorRelay
  served: Array<{ path: string; body: string }>
}

function machine(id: string, endpoint: string, secret: string, peers: Map<string, string>, overrides: Partial<ConductorRelayDependencies> = {}): Machine {
  const key = generateDeviceKey(id)
  const seal = generateSealKey()
  const served: Array<{ path: string; body: string }> = []
  peers.set(id, key.publicKey)
  const relay = new ConductorRelay({
    endpoint: () => endpoint,
    roomSecret: () => secret,
    machineId: () => id,
    machineName: () => id,
    deviceKey: () => key,
    sealKey: () => seal,
    fingerprint: () => `SHA256:${id}`,
    peerDeviceKey: peerId => peers.get(peerId) ?? null,
    handle: async (path, body) => {
      served.push({ path, body: body.toString('utf8') })
      return { status: 200, body: JSON.stringify({ result: { answered: path } }) }
    },
    enabled: () => true,
    ...overrides
  })
  relays.push(relay)
  return { id, key, seal, relay, served }
}

async function startServer(secret: string): Promise<string> {
  const server = new RelayServer({ secrets: [secret], port: 0, host: '127.0.0.1' })
  running.push(server)
  const bound = await server.listen()
  return `ws://127.0.0.1:${bound.port}`
}

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

describe('the relay Conductor runs itself', () => {
  it('carries a real request between two machines and brings the answer back', async () => {
    const secret = generateRoomSecret()
    const endpoint = await startServer(secret)
    const peers = new Map<string, string>()
    const laptop = machine('laptop', endpoint, secret, peers)
    const desktop = machine('desktop', endpoint, secret, peers)

    laptop.relay.start()
    desktop.relay.start()
    await waitFor(() => laptop.relay.getStatus().reachable.includes('desktop'), 'the desktop to appear')

    const answer = await laptop.relay.call(
      'desktop', desktop.key.publicKey, '/remote/projects',
      Buffer.from(JSON.stringify({ method: 'projects' }), 'utf8'),
      { 'x-conductor-peer': 'laptop' },
      desktop.seal.publicKey
    )

    expect(answer.status).toBe(200)
    expect(JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'))).toEqual({ result: { answered: '/remote/projects' } })
    expect(desktop.served).toEqual([{ path: '/remote/projects', body: JSON.stringify({ method: 'projects' }) }])
  })

  it('says a machine is not there at once, instead of holding the caller for the full timeout', async () => {
    const secret = generateRoomSecret()
    const endpoint = await startServer(secret)
    const peers = new Map<string, string>()
    const laptop = machine('laptop', endpoint, secret, peers)
    const absent = generateDeviceKey('absent')

    laptop.relay.start()
    await waitFor(() => laptop.relay.getStatus().phase === 'ready', 'the relay to connect')

    const started = Date.now()
    await expect(laptop.relay.call('absent', absent.publicKey, '/remote/projects', Buffer.alloc(0), {}))
      .rejects.toThrow(/has not checked in/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('counts a machine as reachable only when a key it already approved signed for it', async () => {
    const secret = generateRoomSecret()
    const endpoint = await startServer(secret)
    const peers = new Map<string, string>()
    const laptop = machine('laptop', endpoint, secret, peers)
    // The desktop is in the room and online, but the laptop has never approved its key.
    const strangerPeers = new Map<string, string>()
    const stranger = machine('stranger', endpoint, secret, strangerPeers)

    laptop.relay.start()
    stranger.relay.start()
    await waitFor(() => laptop.relay.getStatus().phase === 'ready', 'the relay to connect')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(laptop.relay.getStatus().reachable).not.toContain('stranger')
  })

  it('refuses a relay that cannot prove it is the one the owner set up', async () => {
    const secret = generateRoomSecret()
    const peers = new Map<string, string>()
    let events: RelaySocketEvents | null = null
    const sent: Array<Record<string, unknown>> = []
    const laptop = machine('laptop', 'ws://127.0.0.1:1/v1/socket', secret, peers, {
      createSocket: (_url, socketEvents) => {
        events = socketEvents
        return {
          connect: () => socketEvents.open(),
          send: frame => { sent.push(frame as Record<string, unknown>) },
          close: () => { /* the test drives the lifecycle */ }
        }
      }
    })

    laptop.relay.start()
    events!.frame({ t: 'challenge', protocol: 1, nonce: 'abc', serverId: 'imposter' })
    expect(sent[0]?.t).toBe('hello')
    events!.frame({ t: 'welcome', sessionId: 's1', heartbeatMs: 25000, maxMessageBytes: 1024, serverProof: 'not a proof at all', presence: [] })

    expect(laptop.relay.getStatus().phase).toBe('error')
    expect(laptop.relay.getStatus().message).toContain('could not prove it is your relay')
    // Nothing of this machine's was published to something that could not prove itself.
    expect(sent.some(frame => frame.t === 'publish')).toBe(false)
  })

  it('ignores an answer that the machine the call went to did not sign', async () => {
    const secret = generateRoomSecret()
    const peers = new Map<string, string>()
    const desktopKey = generateDeviceKey('desktop')
    const desktopSeal = generateSealKey()
    peers.set('desktop', desktopKey.publicKey)

    let events: RelaySocketEvents | null = null
    const sent: Array<Record<string, unknown>> = []
    const laptop = machine('laptop', 'ws://127.0.0.1:1/v1/socket', secret, peers, {
      createSocket: (_url, socketEvents) => {
        events = socketEvents
        return {
          connect: () => socketEvents.open(),
          send: frame => { sent.push(frame as Record<string, unknown>) },
          close: () => { /* the test drives the lifecycle */ }
        }
      }
    })

    laptop.relay.start()
    events!.frame({ t: 'challenge', protocol: 1, nonce: 'abc', serverId: 'relay' })
    const hello = sent.find(frame => frame.t === 'hello') as Record<string, unknown>
    const statement = relayHelloStatement({
      protocol: Number(hello.protocol),
      roomId: String(hello.roomId),
      machineId: String(hello.machineId),
      machineName: String(hello.machineName),
      deviceKey: String(hello.deviceKey),
      nonce: String(hello.nonce),
      issuedAt: Number(hello.issuedAt)
    })
    expect(String(hello.roomId)).toBe(roomIdFor(secret))

    const entry = signDirectoryEntry(desktopKey.privateKeyPem, {
      version: 1,
      machineId: 'desktop',
      machineName: 'desktop',
      accountLogin: '',
      deviceKey: desktopKey.publicKey,
      sealKey: desktopSeal.publicKey,
      fingerprint: 'SHA256:desktop',
      updatedAt: new Date().toISOString()
    })
    events!.frame({
      t: 'welcome',
      sessionId: 's1',
      heartbeatMs: 25000,
      maxMessageBytes: 6 * 1024 * 1024,
      serverProof: welcomeProofFor(secret, statement, 's1'),
      presence: [{ machineId: 'desktop', online: true, entry, lastSeenAt: new Date().toISOString() }]
    })
    expect(laptop.relay.getStatus().reachable).toContain('desktop')

    let settled = false
    const call = laptop.relay.call('desktop', desktopKey.publicKey, '/remote/projects', Buffer.alloc(0), {}, desktopSeal.publicKey)
      .then(() => { settled = true }, () => { settled = true })
    await waitFor(() => sent.some(frame => frame.t === 'send'), 'the request to be handed over')
    const request = sent.find(frame => frame.t === 'send') as { ref: string; envelope: { id: string } }
    events!.frame({ t: 'accepted', ref: request.ref, delivery: 'online' })
    await new Promise(resolve => setTimeout(resolve, 10))

    // An answer sealed to this machine, correctly addressed, and signed by a key that is not the
    // one the call was made to. Sealing proves nothing: the seal key is published.
    const impostor = generateDeviceKey('impostor')
    const laptopSeal = laptop.seal.publicKey
    const [forged] = buildEnvelopes({
      privateKeyPem: impostor.privateKeyPem,
      recipientSealKey: laptopSeal,
      binding: { from: 'desktop', to: 'laptop', id: 'forged-1', kind: 'response', correlationId: request.envelope.id },
      plaintext: Buffer.from(JSON.stringify({ status: 200, body: '' }), 'utf8'),
      chunkBytes: Number.MAX_SAFE_INTEGER,
      now: Date.now()
    })
    events!.frame({ t: 'envelope', envelope: forged })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    // The real machine's answer, over the same route, is taken.
    const [real] = buildEnvelopes({
      privateKeyPem: desktopKey.privateKeyPem,
      recipientSealKey: laptopSeal,
      binding: { from: 'desktop', to: 'laptop', id: 'real-1', kind: 'response', correlationId: request.envelope.id },
      plaintext: Buffer.from(JSON.stringify({ status: 204, body: '' }), 'utf8'),
      chunkBytes: Number.MAX_SAFE_INTEGER,
      now: Date.now()
    })
    events!.frame({ t: 'envelope', envelope: real })
    await call
    expect(settled).toBe(true)
  })

  it('tries a throttled message once more instead of failing the call', async () => {
    const secret = generateRoomSecret()
    const peers = new Map<string, string>()
    const desktopKey = generateDeviceKey('desktop')
    const desktopSeal = generateSealKey()
    peers.set('desktop', desktopKey.publicKey)

    let events: RelaySocketEvents | null = null
    const sent: Array<Record<string, unknown>> = []
    const laptop = machine('laptop', 'ws://127.0.0.1:1/v1/socket', secret, peers, {
      createSocket: (_url, socketEvents) => {
        events = socketEvents
        return {
          connect: () => socketEvents.open(),
          send: frame => { sent.push(frame as Record<string, unknown>) },
          close: () => { /* the test drives the lifecycle */ }
        }
      }
    })

    laptop.relay.start()
    events!.frame({ t: 'challenge', protocol: 1, nonce: 'abc', serverId: 'relay' })
    const hello = sent.find(frame => frame.t === 'hello') as Record<string, unknown>
    const statement = relayHelloStatement({
      protocol: Number(hello.protocol), roomId: String(hello.roomId), machineId: String(hello.machineId),
      machineName: String(hello.machineName), deviceKey: String(hello.deviceKey), nonce: String(hello.nonce),
      issuedAt: Number(hello.issuedAt)
    })
    const entry = signDirectoryEntry(desktopKey.privateKeyPem, {
      version: 1, machineId: 'desktop', machineName: 'desktop', accountLogin: '',
      deviceKey: desktopKey.publicKey, sealKey: desktopSeal.publicKey, fingerprint: 'SHA256:desktop',
      updatedAt: new Date().toISOString()
    })
    events!.frame({
      t: 'welcome', sessionId: 's1', heartbeatMs: 25000, maxMessageBytes: 6 * 1024 * 1024,
      serverProof: welcomeProofFor(secret, statement, 's1'),
      presence: [{ machineId: 'desktop', online: true, entry, lastSeenAt: new Date().toISOString() }]
    })

    const call = laptop.relay.call('desktop', desktopKey.publicKey, '/remote/projects', Buffer.alloc(0), {}, desktopSeal.publicKey)
    await waitFor(() => sent.some(frame => frame.t === 'send'), 'the first attempt')
    const first = sent.find(frame => frame.t === 'send') as { ref: string; envelope: { id: string } }
    events!.frame({ t: 'rejected', ref: first.ref, code: 'rate-limited', message: 'Slow down.' })

    // The same message goes out again rather than the call failing in the owner's face.
    await waitFor(() => sent.filter(frame => frame.t === 'send').length === 2, 'the second attempt')
    const second = sent.filter(frame => frame.t === 'send')[1] as { ref: string }
    expect(second.ref).toBe(first.ref)
    events!.frame({ t: 'accepted', ref: second.ref, delivery: 'online' })

    const [answer] = buildEnvelopes({
      privateKeyPem: desktopKey.privateKeyPem,
      recipientSealKey: laptop.seal.publicKey,
      binding: { from: 'desktop', to: 'laptop', id: 'answer-1', kind: 'response', correlationId: first.envelope.id },
      plaintext: Buffer.from(JSON.stringify({ status: 200, body: '' }), 'utf8'),
      chunkBytes: Number.MAX_SAFE_INTEGER,
      now: Date.now()
    })
    events!.frame({ t: 'envelope', envelope: answer })
    expect((await call).status).toBe(200)
  })

  it('takes the relay address an owner is likely to paste', () => {
    expect(relayEndpointUrl('relay.example.com')).toBe('wss://relay.example.com/v1/socket')
    expect(relayEndpointUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/v1/socket')
    expect(relayEndpointUrl('wss://relay.example.com/custom')).toBe('wss://relay.example.com/custom')
    expect(() => relayEndpointUrl('ftp://relay.example.com')).toThrow(/ws:\/\/ or wss:\/\//)
  })
})
