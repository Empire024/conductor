import { afterEach, describe, expect, it } from 'vitest'
import { generateDeviceKey, signStatement } from '../main/device-key.ts'
import { generateRoomSecret, proofsMatch, roomIdFor, roomProofFor, welcomeProofFor } from '../main/relay-room.ts'
import {
  RELAY_HELLO_STATEMENT_KIND,
  RELAY_PROTOCOL_VERSION,
  RELAY_SOCKET_PATH,
  relayHelloStatement,
  type RelayServerFrame
} from '../shared/relay-protocol.ts'
import { RelaySocket } from '../main/relay-socket.ts'
import { RelayServer } from './server.ts'

/**
 * The relay is exercised the way it will actually be used: a real listening server, the same socket
 * client the app connects with, real device keys and real proofs. Nothing here mocks the transport,
 * because the transport - hand-written framing and a handshake that has to refuse the wrong machine
 * - is the part worth proving.
 */

const running: RelayServer[] = []

afterEach(async () => {
  while (running.length) await running.pop()?.close()
})

async function startServer(secrets: string[]): Promise<{ server: RelayServer; port: number }> {
  const server = new RelayServer({ secrets, port: 0, host: '127.0.0.1' })
  running.push(server)
  const bound = await server.listen()
  return { server, port: bound.port }
}

interface TestClient {
  socket: RelaySocket
  frames: RelayServerFrame[]
  next(type: string, timeoutMs?: number): Promise<RelayServerFrame>
  /** The next frame of a kind that also says what the test is waiting for, since a machine sees
   *  its own arrival announced before it sees anyone else's. */
  until(type: string, matches: (frame: RelayServerFrame) => boolean, timeoutMs?: number): Promise<RelayServerFrame>
  send(frame: unknown): void
  closed: Promise<{ code: number; reason: string }>
}

function open(port: number): Promise<TestClient> {
  const frames: RelayServerFrame[] = []
  const waiters: Array<{ type: string; matches(frame: RelayServerFrame): boolean; resolve(frame: RelayServerFrame): void }> = []
  let closedWith: { code: number; reason: string } | null = null
  let settleClosed: (value: { code: number; reason: string }) => void = () => {}
  const closed = new Promise<{ code: number; reason: string }>(resolve => { settleClosed = resolve })
  let settleOpen: (client: TestClient) => void = () => {}
  const opened = new Promise<TestClient>(resolve => { settleOpen = resolve })

  const socket = new RelaySocket(`ws://127.0.0.1:${port}${RELAY_SOCKET_PATH}`, {
    open: () => settleOpen(client),
    frame: frame => {
      frames.push(frame as unknown as RelayServerFrame)
      const index = waiters.findIndex(waiter => waiter.type === (frame as { t: string }).t && waiter.matches(frame as unknown as RelayServerFrame))
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(frame as unknown as RelayServerFrame)
    },
    closed: detail => {
      closedWith = { code: detail.code, reason: detail.reason }
      settleClosed(closedWith)
    }
  }, { maxMessageBytes: 8 * 1024 * 1024 })

  const client: TestClient = {
    socket,
    frames,
    closed,
    send: frame => socket.send(frame),
    next: (type, timeoutMs = 4000) => client.until(type, () => true, timeoutMs),
    until: (type, matches, timeoutMs = 4000) => new Promise<RelayServerFrame>((resolve, reject) => {
      const found = frames.find(frame => frame.t === type && matches(frame))
      if (found) return resolve(found)
      const timer = setTimeout(() => reject(new Error(`No ${type} frame arrived${closedWith ? ` (socket closed ${closedWith.code}: ${closedWith.reason})` : ''}`)), timeoutMs)
      waiters.push({ type, matches, resolve: frame => { clearTimeout(timer); resolve(frame) } })
    })
  }
  socket.connect()
  return opened
}

interface Machine {
  machineId: string
  key: ReturnType<typeof generateDeviceKey>
  client: TestClient
}

async function join(port: number, secret: string, machineId: string, options: { machineName?: string; key?: ReturnType<typeof generateDeviceKey> } = {}): Promise<Machine> {
  const key = options.key ?? generateDeviceKey(machineId)
  const client = await open(port)
  const challenge = await client.next('challenge')
  const hello = {
    protocol: RELAY_PROTOCOL_VERSION,
    roomId: roomIdFor(secret),
    machineId,
    machineName: options.machineName ?? machineId,
    deviceKey: key.publicKey,
    nonce: (challenge as { nonce: string }).nonce,
    issuedAt: Date.now()
  }
  const statement = relayHelloStatement(hello)
  client.send({
    t: 'hello',
    ...hello,
    keyProof: signStatement(key.privateKeyPem, RELAY_HELLO_STATEMENT_KIND, statement),
    roomProof: roomProofFor(secret, statement)
  })
  return { machineId, key, client }
}

const envelope = (from: string, to: string, id = 'msg-1'): Record<string, unknown> => ({
  version: 1, id, from, to, kind: 'request', correlationId: id, index: 0, total: 1,
  ephemeralKey: 'x', nonce: 'y', tag: 'z', chunk: 'AAAA', createdAt: new Date().toISOString(), senderSignature: 's'
})

describe('the relay server', () => {
  it('lets two machines that hold the room secret meet, and moves a sealed message between them', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])

    const laptop = await join(port, secret, 'laptop')
    const welcome = await laptop.client.next('welcome') as { sessionId: string; serverProof: string }
    expect(welcome.serverProof.length).toBeGreaterThan(0)

    const desktop = await join(port, secret, 'desktop')
    await desktop.client.next('welcome')

    // Each machine learns the other is there without asking anybody: presence is pushed.
    const presence = await laptop.client.until('presence', frame =>
      (frame as { presence: Array<{ machineId: string }> }).presence.some(entry => entry.machineId === 'desktop')
    ) as { presence: Array<{ machineId: string; online: boolean }> }
    expect(presence.presence.some(entry => entry.machineId === 'desktop' && entry.online)).toBe(true)

    desktop.client.send({ t: 'send', ref: 'r1', to: 'laptop', envelope: envelope('desktop', 'laptop') })
    const accepted = await desktop.client.next('accepted') as { delivery: string }
    expect(accepted.delivery).toBe('online')

    const delivered = await laptop.client.next('envelope') as { envelope: { id: string; from: string } }
    expect(delivered.envelope.id).toBe('msg-1')
    expect(delivered.envelope.from).toBe('desktop')
  })

  it('refuses a machine that cannot prove the room secret, and one that cannot prove its device key', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])

    const stranger = await open(port)
    const challenge = await stranger.next('challenge') as { nonce: string }
    const key = generateDeviceKey('stranger')
    const hello = {
      protocol: RELAY_PROTOCOL_VERSION,
      roomId: roomIdFor(secret),
      machineId: 'stranger',
      machineName: 'stranger',
      deviceKey: key.publicKey,
      nonce: challenge.nonce,
      issuedAt: Date.now()
    }
    const statement = relayHelloStatement(hello)
    stranger.send({
      t: 'hello',
      ...hello,
      keyProof: signStatement(key.privateKeyPem, RELAY_HELLO_STATEMENT_KIND, statement),
      roomProof: roomProofFor('a completely different secret value', statement)
    })
    const refused = await stranger.next('error') as { code: string }
    expect(refused.code).toBe('unauthorized')

    const liar = await open(port)
    const secondChallenge = await liar.next('challenge') as { nonce: string }
    const otherKey = generateDeviceKey('other')
    const liarHello = { ...hello, machineId: 'liar', machineName: 'liar', nonce: secondChallenge.nonce, issuedAt: Date.now() }
    const liarStatement = relayHelloStatement(liarHello)
    liar.send({
      t: 'hello',
      ...liarHello,
      // Signed by a key that is not the one the hello claims.
      keyProof: signStatement(otherKey.privateKeyPem, RELAY_HELLO_STATEMENT_KIND, liarStatement),
      roomProof: roomProofFor(secret, liarStatement)
    })
    const second = await liar.next('error') as { code: string }
    expect(second.code).toBe('unauthorized')
  })

  it('refuses a proof made for another socket, so a captured hello cannot be replayed', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])

    const first = await open(port)
    const challenge = await first.next('challenge') as { nonce: string }
    const key = generateDeviceKey('laptop')
    const hello = {
      protocol: RELAY_PROTOCOL_VERSION,
      roomId: roomIdFor(secret),
      machineId: 'laptop',
      machineName: 'laptop',
      deviceKey: key.publicKey,
      nonce: challenge.nonce,
      issuedAt: Date.now()
    }
    const statement = relayHelloStatement(hello)
    const proofs = {
      keyProof: signStatement(key.privateKeyPem, RELAY_HELLO_STATEMENT_KIND, statement),
      roomProof: roomProofFor(secret, statement)
    }

    const second = await open(port)
    await second.next('challenge')
    second.send({ t: 'hello', ...hello, ...proofs })
    const refused = await second.next('error') as { code: string }
    expect(refused.code).toBe('unauthorized')
  })

  it('holds a message for a machine that is away and hands it over the moment it arrives', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])

    const desktop = await join(port, secret, 'desktop')
    await desktop.client.next('welcome')
    const laptop = await join(port, secret, 'laptop')
    await laptop.client.next('welcome')
    laptop.client.socket.close()
    await laptop.client.closed
    // Presence tells the sender the peer went away, without anybody polling for it.
    await desktop.client.until('presence', frame =>
      (frame as { presence: Array<{ machineId: string; online: boolean }> }).presence.some(entry => entry.machineId === 'laptop' && !entry.online)
    )

    desktop.client.send({ t: 'send', ref: 'r1', to: 'laptop', envelope: envelope('desktop', 'laptop', 'queued-1') })
    const accepted = await desktop.client.next('accepted') as { delivery: string }
    expect(accepted.delivery).toBe('queued')

    const returned = await join(port, secret, 'laptop', { key: laptop.key })
    await returned.client.next('welcome')
    const delivered = await returned.client.next('envelope') as { envelope: { id: string } }
    expect(delivered.envelope.id).toBe('queued-1')
  })

  it('will not carry an envelope that is addressed differently from the way it was sent', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])
    const desktop = await join(port, secret, 'desktop')
    await desktop.client.next('welcome')
    await join(port, secret, 'laptop').then(machine => machine.client.next('welcome'))

    desktop.client.send({ t: 'send', ref: 'r1', to: 'laptop', envelope: envelope('laptop', 'laptop') })
    const rejected = await desktop.client.next('rejected') as { code: string }
    expect(rejected.code).toBe('unauthorized')
  })

  it('answers an unknown peer immediately rather than leaving the caller to time out', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])
    const desktop = await join(port, secret, 'desktop')
    await desktop.client.next('welcome')

    desktop.client.send({ t: 'send', ref: 'r1', to: 'never-seen', envelope: envelope('desktop', 'never-seen') })
    const rejected = await desktop.client.next('rejected') as { code: string }
    expect(rejected.code).toBe('unknown-peer')
  })

  it('keeps rooms apart: two secrets on one relay never see each other', async () => {
    const first = generateRoomSecret()
    const second = generateRoomSecret()
    const { port } = await startServer([first, second])

    const mine = await join(port, first, 'mine')
    await mine.client.next('welcome')
    const theirs = await join(port, second, 'theirs')
    const welcome = await theirs.client.next('welcome') as { presence: Array<{ machineId: string }> }
    expect(welcome.presence.map(entry => entry.machineId)).toEqual(['theirs'])

    theirs.client.send({ t: 'send', ref: 'r1', to: 'mine', envelope: envelope('theirs', 'mine') })
    const rejected = await theirs.client.next('rejected') as { code: string }
    expect(rejected.code).toBe('unknown-peer')
  })

  it('refuses a socket that says anything before it says hello', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])
    const client = await open(port)
    await client.next('challenge')
    client.send({ t: 'send', ref: 'r1', to: 'somebody', envelope: envelope('nobody', 'somebody') })
    const refused = await client.next('error') as { code: string }
    expect(refused.code).toBe('unauthorized')
  })

  it('serves a health check that says the relay is alive and nothing about who is on it', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])
    const machine = await join(port, secret, 'laptop')
    await machine.client.next('welcome')

    const response = await fetch(`http://127.0.0.1:${port}/v1/health`)
    const body = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(body.service).toBe('conductor-relay')
    expect(body.connections).toBe(1)
    expect(JSON.stringify(body)).not.toContain('laptop')
  })

  it('proves to the client that it is the relay the owner set up', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])
    const client = await open(port)
    const challenge = await client.next('challenge') as { nonce: string }
    const key = generateDeviceKey('laptop')
    const hello = {
      protocol: RELAY_PROTOCOL_VERSION,
      roomId: roomIdFor(secret),
      machineId: 'laptop',
      machineName: 'laptop',
      deviceKey: key.publicKey,
      nonce: challenge.nonce,
      issuedAt: Date.now()
    }
    const statement = relayHelloStatement(hello)
    client.send({
      t: 'hello',
      ...hello,
      keyProof: signStatement(key.privateKeyPem, RELAY_HELLO_STATEMENT_KIND, statement),
      roomProof: roomProofFor(secret, statement)
    })
    const welcome = await client.next('welcome') as { sessionId: string; serverProof: string }
    expect(proofsMatch(welcome.serverProof, welcomeProofFor(secret, statement, welcome.sessionId))).toBe(true)
    expect(proofsMatch(welcome.serverProof, welcomeProofFor('some other secret entirely', statement, welcome.sessionId))).toBe(false)
  })

  it('refuses a message larger than it accepts without taking the socket down for the ones that fit', async () => {
    const secret = generateRoomSecret()
    const { port } = await startServer([secret])
    const desktop = await join(port, secret, 'desktop')
    await desktop.client.next('welcome')
    const laptop = await join(port, secret, 'laptop')
    await laptop.client.next('welcome')

    // Well under the frame cap, so the socket survives; the relay only forwards what it is given.
    const big = { ...envelope('desktop', 'laptop', 'big'), chunk: 'A'.repeat(64 * 1024) }
    desktop.client.send({ t: 'send', ref: 'big', to: 'laptop', envelope: big })
    const delivered = await laptop.client.next('envelope') as { envelope: { id: string } }
    expect(delivered.envelope.id).toBe('big')
  })
})
