import { describe, expect, it, vi } from 'vitest'
import { generateDeviceKey } from './device-key'
import { GitHubRelayMailbox, RelayUnavailableError, type RelayApiResult } from './github-relay'
import {
  generateSealKey,
  openMessage,
  readDirectoryEntry,
  readEnvelope,
  sealMessage,
  signDirectoryEntry,
  signMessage,
  verifyDirectoryEntry,
  type RelayBinding
} from './relay-crypto'
import { RemoteRelay } from './remote-relay'
import {
  RELAY_ACK_FILE,
  RELAY_BACKGROUND_ACTIVE_MS,
  RELAY_BACKGROUND_CALL_TIMEOUT_MS,
  RELAY_CALL_TIMEOUT_MS,
  RELAY_DIRECTORY_FILE,
  RELAY_GIST_DESCRIPTION,
  RELAY_POLL_ACTIVE_MS,
  RELAY_POLL_IDLE_MS,
  parseRelayFileName,
  relayFileName
} from '../shared/remote-relay'

/**
 * A GitHub stand-in that behaves like the gist API in the ways the relay depends on: files are
 * merged rather than replaced, a null content deletes, a listing carries names without content, and
 * a conditional read answers 304. Two relays can then talk to each other with nothing on the wire
 * except what would really be stored on the account.
 */
function fakeGitHub(): { api(login: string): (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<RelayApiResult>; gists: Map<string, { id: string; description: string; owner: string; files: Map<string, string>; version: number }> } {
  const gists = new Map<string, { id: string; description: string; owner: string; files: Map<string, string>; version: number }>()
  let next = 1
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): RelayApiResult => ({
    response: {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
    },
    body
  })
  const describe = (gist: { id: string; description: string; files: Map<string, string> }, withContent: boolean): unknown => ({
    id: gist.id,
    description: gist.description,
    updated_at: new Date().toISOString(),
    files: Object.fromEntries([...gist.files].map(([name, content]) => [name, {
      filename: name, size: content.length, truncated: false, ...(withContent ? { content } : { raw_url: `https://raw/${gist.id}/${name}` })
    }]))
  })
  return {
    gists,
    api: (login: string) => async (path, init) => {
      const method = init?.method ?? 'GET'
      if (path.startsWith('/gists?') && method === 'GET') {
        // Every gist here belongs to the one account both machines are signed into, which is what
        // the real listing returns for any of them; `owner` only records which one wrote it.
        const account = [...gists.values()]
        const tag = `"list-${account.map(gist => `${gist.id}:${gist.version}`).join(',')}"`
        if (init?.headers?.['If-None-Match'] === tag) return reply(304, {}, { etag: tag })
        return reply(200, account.map(gist => describe(gist, false)), { etag: tag })
      }
      const match = /^\/gists\/([^/?]+)$/.exec(path)
      if (match) {
        const gist = gists.get(decodeURIComponent(match[1]!))
        if (!gist) return reply(404, { message: 'Not Found' })
        if (method === 'PATCH') {
          const payload = JSON.parse(init?.body ?? '{}') as { files?: Record<string, { content: string } | null> }
          for (const [name, file] of Object.entries(payload.files ?? {})) {
            if (file === null) gist.files.delete(name)
            else gist.files.set(name, file.content)
          }
          gist.version++
          return reply(200, describe(gist, true))
        }
        const tag = `"${gist.id}-${gist.version}"`
        if (init?.headers?.['If-None-Match'] === tag) return reply(304, {}, { etag: tag })
        return reply(200, describe(gist, true), { etag: tag })
      }
      if (path === '/gists' && method === 'POST') {
        const payload = JSON.parse(init?.body ?? '{}') as { description?: string; files?: Record<string, { content: string }> }
        const gist = {
          id: `gist-${next++}`,
          description: payload.description ?? '',
          owner: login,
          files: new Map(Object.entries(payload.files ?? {}).map(([name, file]) => [name, file.content])),
          version: 1
        }
        gists.set(gist.id, gist)
        return reply(201, describe(gist, true))
      }
      return reply(404, { message: 'Not Found' })
    }
  }
}

interface Machine {
  id: string
  relay: RemoteRelay
  device: ReturnType<typeof generateDeviceKey>
  seal: ReturnType<typeof generateSealKey>
  served: Array<{ path: string; body: string; headers: Record<string, string> }>
  answer: (path: string, body: Buffer, headers: Record<string, string>) => Promise<{ status: number; body: string }>
}

type FakeApi = (path: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<RelayApiResult>

function machine(
  name: string,
  github: ReturnType<typeof fakeGitHub>,
  peers: Map<string, string>,
  options: { fingerprint?: string; api?: FakeApi; now?: () => number; schedule?: (run: () => void, ms: number) => { cancel(): void } } = {}
): Machine {
  const device = generateDeviceKey(`conductor ${name}`)
  const seal = generateSealKey()
  const settings = new Map<string, string>()
  const served: Machine['served'] = []
  const self: Machine = {
    id: name,
    device,
    seal,
    served,
    answer: async (path, body) => ({ status: 200, body: JSON.stringify({ result: { echoed: path, size: body.length } }) }),
    relay: null as unknown as RemoteRelay
  }
  self.relay = new RemoteRelay({
    mailbox: new GitHubRelayMailbox({
      api: options.api ?? github.api(name),
      fetchRaw: async url => {
        const [, gistId, file] = /^https:\/\/raw\/([^/]+)\/(.+)$/.exec(url) ?? []
        return github.gists.get(gistId ?? '')?.files.get(file ?? '') ?? ''
      },
      getSetting: key => settings.get(key) ?? null,
      setSetting: (key, value) => { settings.set(key, value) }
    }),
    machineId: () => name,
    machineName: () => name,
    accountLogin: () => 'owner',
    deviceKey: () => device,
    sealKey: () => seal,
    fingerprint: () => options.fingerprint ?? `FP:${name}`,
    peerDeviceKey: id => peers.get(id) ?? null,
    handle: async (path, body, headers) => {
      served.push({ path, body: body.toString('utf8'), headers })
      return await self.answer(path, body, headers)
    },
    enabled: () => true,
    ...(options.now ? { now: options.now } : {}),
    // Nothing schedules itself in a test; every poll is driven explicitly, except where a test is
    // about the cadence the loop picks, which is exactly what this seam records.
    schedule: options.schedule ?? (() => ({ cancel: () => undefined }))
  })
  return self
}

/** Waits until the caller's message is actually sitting in a mailbox, the way a poll would find it. */
async function sent(github: ReturnType<typeof fakeGitHub>): Promise<void> {
  await vi.waitFor(() => {
    const names = [...github.gists.values()].flatMap(gist => [...gist.files.keys()])
    expect(names.some(name => parseRelayFileName(name))).toBe(true)
  })
}

/** Drives both sides until the outstanding call settles, the way the real poll loop would. */
async function settle(call: Promise<unknown>, machines: Machine[], rounds = 6): Promise<unknown> {
  for (let round = 0; round < rounds; round++) {
    for (const entry of machines) await entry.relay.pollOnce()
    const raced = await Promise.race([call, Promise.resolve('pending' as const)])
    if (raced !== 'pending') return raced
  }
  return await call
}

describe('relay message sealing', () => {
  const binding: RelayBinding = { from: 'a', to: 'b', id: 'msg-1', kind: 'request', correlationId: 'msg-1' }

  it('opens only with the recipient key it was sealed to', () => {
    const recipient = generateSealKey()
    const other = generateSealKey()
    const sealed = sealMessage(recipient.publicKey, binding, Buffer.from('the prompt'))
    expect(openMessage(recipient.privateKey, sealed, binding, sealed.ciphertext).toString()).toBe('the prompt')
    expect(() => openMessage(other.privateKey, sealed, binding, sealed.ciphertext)).toThrow()
  })

  it('refuses a message that was re-addressed, re-labelled or replayed back the other way', () => {
    const recipient = generateSealKey()
    const sealed = sealMessage(recipient.publicKey, binding, Buffer.from('tabs.open'))
    for (const tampered of [
      { ...binding, to: 'c' },
      { ...binding, from: 'z' },
      { ...binding, kind: 'response' as const },
      { ...binding, correlationId: 'msg-2' }
    ]) {
      expect(() => openMessage(recipient.privateKey, sealed, tampered, sealed.ciphertext)).toThrow()
    }
  })

  it('refuses ciphertext that was edited in the mailbox', () => {
    const recipient = generateSealKey()
    const sealed = sealMessage(recipient.publicKey, binding, Buffer.from('files.write'))
    const edited = Buffer.from(sealed.ciphertext)
    edited.writeUInt8(edited.readUInt8(0) ^ 0xff, 0)
    expect(() => openMessage(recipient.privateKey, sealed, binding, edited)).toThrow()
  })
})

describe('relay directory entries', () => {
  it('only verifies against the device key that signed it', () => {
    const mine = generateDeviceKey('mine')
    const theirs = generateDeviceKey('theirs')
    const seal = generateSealKey()
    const entry = signDirectoryEntry(mine.privateKeyPem, {
      version: 1, machineId: 'm1', machineName: 'Studio', accountLogin: 'owner',
      deviceKey: mine.publicKey, sealKey: seal.publicKey, fingerprint: 'FP', updatedAt: new Date().toISOString()
    })
    expect(verifyDirectoryEntry(entry, mine.publicKey)).toBe(true)
    expect(verifyDirectoryEntry(entry, theirs.publicKey)).toBe(false)
  })

  it('refuses an entry whose published key was swapped for another', () => {
    const mine = generateDeviceKey('mine')
    const seal = generateSealKey()
    const attacker = generateSealKey()
    const entry = signDirectoryEntry(mine.privateKeyPem, {
      version: 1, machineId: 'm1', machineName: 'Studio', accountLogin: 'owner',
      deviceKey: mine.publicKey, sealKey: seal.publicKey, fingerprint: 'FP', updatedAt: new Date().toISOString()
    })
    expect(verifyDirectoryEntry({ ...entry, sealKey: attacker.publicKey }, mine.publicKey)).toBe(false)
    expect(verifyDirectoryEntry({ ...entry, fingerprint: 'OTHER' }, mine.publicKey)).toBe(false)
    expect(verifyDirectoryEntry({ ...entry, machineId: 'm2' }, mine.publicKey)).toBe(false)
  })

  it('rejects a malformed entry rather than partially reading it', () => {
    expect(readDirectoryEntry({ version: 2 })).toBeNull()
    expect(readDirectoryEntry({ version: 1, machineId: 'm1' })).toBeNull()
    expect(readEnvelope({ version: 1, id: 'a', from: 'b', to: 'c', kind: 'other' })).toBeNull()
    expect(readEnvelope({ version: 1, id: 'a', from: 'b', to: 'c', kind: 'request', index: 3, total: 2 })).toBeNull()
  })
})

describe('relay transport', () => {
  it('carries a request to the other machine and brings its answer back', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    peers.set('alice', alice.device.publicKey)
    peers.set('bob', bob.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const body = Buffer.from(JSON.stringify({ method: 'tabs.open', args: { projectId: 'p1' } }), 'utf8')
    const answer = await settle(
      alice.relay.call('bob', bob.device.publicKey, '/remote/call', body, { 'x-conductor-peer': 'peer-1' }, bob.seal.publicKey),
      [bob, alice]
    ) as { status: number; body: string }

    expect(bob.served).toHaveLength(1)
    expect(bob.served[0]!.path).toBe('/remote/call')
    // The bytes the host sees are the exact bytes the caller signed over, or its signature check
    // would fail; this is the whole reason the relay carries a body rather than a parsed request.
    expect(bob.served[0]!.body).toBe(body.toString('utf8'))
    expect(bob.served[0]!.headers['x-conductor-peer']).toBe('peer-1')
    expect(answer.status).toBe(200)
    expect(JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'))).toEqual({ result: { echoed: '/remote/call', size: body.length } })
  })

  it('never writes a readable request to the mailbox', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    peers.set('bob', bob.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const secret = 'delete everything in C:/Claude'
    void alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from(secret, 'utf8'), {}, bob.seal.publicKey).catch(() => undefined)
    await sent(github)
    for (const gist of github.gists.values()) {
      for (const [name, content] of gist.files) {
        if (!parseRelayFileName(name)) continue
        expect(content).not.toContain(secret)
        expect(content).not.toContain('remote/call')
        const envelope = readEnvelope(JSON.parse(content))
        // Routing has to be readable for the mailbox to work at all; nothing else is.
        expect(envelope?.to).toBe('bob')
        expect(Object.keys(JSON.parse(content) as Record<string, unknown>).sort()).toEqual([
          'chunk', 'correlationId', 'createdAt', 'ephemeralKey', 'from', 'id', 'index', 'kind', 'nonce',
          'senderSignature', 'tag', 'to', 'total', 'version'
        ])
      }
    }
  })

  it('refuses a mailbox entry that the expected device key did not sign', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    await bob.relay.checkIn()

    const impostor = generateDeviceKey('impostor')
    await expect(alice.relay.resolvePeer('bob', impostor.publicKey)).rejects.toThrow(/did not sign/i)
  })

  it('refuses a machine that published a relay key other than the pinned one', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    await bob.relay.checkIn()

    const pinnedElsewhere = generateSealKey().publicKey
    await expect(alice.relay.resolvePeer('bob', bob.device.publicKey, pinnedElsewhere)).rejects.toThrow(/different relay key/i)
  })

  it('gives no answer to a sender whose identity it cannot vouch for', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    // bob knows nothing about alice, and this is not a pairing request
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const call = alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey)
    await sent(github)
    await bob.relay.pollOnce()
    await alice.relay.pollOnce()
    void call.catch(() => undefined)
    // The request is still served — refusing it is the host's job, not the transport's — but the
    // answer is not sealed back to a mailbox nothing signed for.
    expect(bob.served).toHaveLength(1)
    const responses = [...github.gists.values()].flatMap(gist => [...gist.files.keys()])
      .map(parseRelayFileName).filter(entry => entry?.to === 'alice')
    expect(responses).toHaveLength(0)
  })

  it('answers a pairing request from a machine it has never seen', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    await alice.relay.checkIn()
    await bob.relay.checkIn()
    bob.answer = async () => ({ status: 200, body: JSON.stringify({ result: { status: 'pending' } }) })

    const body = Buffer.from(JSON.stringify({ publicKey: alice.device.publicKey, code: '123456' }), 'utf8')
    const answer = await settle(
      alice.relay.call('bob', bob.device.publicKey, '/remote/pair', body, {}, bob.seal.publicKey),
      [bob, alice]
    ) as { status: number; body: string }
    expect(answer.status).toBe(200)
    expect(JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8'))).toEqual({ result: { status: 'pending' } })
  })

  it('delivers a message too large for one mailbox file', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    peers.set('alice', alice.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const big = Buffer.from('x'.repeat(900 * 1024), 'utf8')
    const call = alice.relay.call('bob', bob.device.publicKey, '/remote/call', big, {}, bob.seal.publicKey)
    await sent(github)
    // Counted while the message is still in the mailbox: once it is collected the files are gone.
    const parts = [...github.gists.values()].flatMap(gist => [...gist.files.keys()])
      .map(parseRelayFileName).filter(entry => entry?.to === 'bob')
    expect(parts.length).toBeGreaterThan(1)
    expect(new Set(parts.map(part => part!.id)).size).toBe(1)

    const answer = await settle(call, [bob, alice]) as { status: number; body: string }
    expect(bob.served[0]!.body).toHaveLength(big.length)
    expect(answer.status).toBe(200)
  })

  it('serves an inbound request exactly once even if its files are read again', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    peers.set('alice', alice.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    void alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey).catch(() => undefined)
    await sent(github)
    await bob.relay.pollOnce()
    expect(bob.served).toHaveLength(1)
    // Re-running the poll finds the same files still sitting there until alice collects her answer.
    await bob.relay.pollOnce()
    await bob.relay.pollOnce()
    expect(bob.served).toHaveLength(1)
  })

  it('publishes a directory entry and an ack file, and nothing else, before any call', async () => {
    const github = fakeGitHub()
    const bob = machine('bob', github, new Map())
    await bob.relay.checkIn()
    const gist = [...github.gists.values()][0]
    expect(gist?.description).toBe(RELAY_GIST_DESCRIPTION)
    expect([...(gist?.files.keys() ?? [])].sort()).toEqual([RELAY_ACK_FILE, RELAY_DIRECTORY_FILE])
    const entry = readDirectoryEntry(JSON.parse(gist!.files.get(RELAY_DIRECTORY_FILE)!))
    expect(entry?.machineId).toBe('bob')
    expect(entry?.sealKey).toBe(bob.seal.publicKey)
    expect(verifyDirectoryEntry(entry!, bob.device.publicKey)).toBe(true)
  })

  /**
   * The attack this refuses: something that holds the account's gist scope — a leaked token, another
   * app the owner authorized — writes its own mailbox gist. The correlation id is in the file name
   * of the call in flight and the victim's seal key is published in her directory entry, so it can
   * seal a perfectly well-formed answer in the peer's name. Only a signature by the device key the
   * call was addressed to separates that from the real answer.
   */
  it("refuses a response forged by another gist on the account in the peer's name", async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    peers.set('alice', alice.device.publicKey)
    peers.set('bob', bob.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const call = alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey)
    void call.catch(() => undefined)
    await sent(github)

    const outgoing = [...github.gists.values()].flatMap(gist => [...gist.files.keys()])
      .map(parseRelayFileName).find(parsed => parsed?.to === 'bob')!
    const aliceGist = [...github.gists.values()].find(gist => gist.owner === 'alice')!
    const published = readDirectoryEntry(JSON.parse(aliceGist.files.get(RELAY_DIRECTORY_FILE)!))!

    const binding: RelayBinding = { from: 'bob', to: 'alice', id: 'forged-1', kind: 'response', correlationId: outgoing.id }
    const sealed = sealMessage(published.sealKey, binding, Buffer.from(JSON.stringify({
      status: 200, body: Buffer.from(JSON.stringify({ result: { owned: true } }), 'utf8').toString('base64')
    }), 'utf8'))
    const forged = {
      version: 1, ...binding, index: 0, total: 1,
      ephemeralKey: sealed.ephemeralKey, nonce: sealed.nonce, tag: sealed.tag,
      chunk: sealed.ciphertext.toString('base64'), createdAt: new Date().toISOString()
    }
    await github.api('mallory')('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: RELAY_GIST_DESCRIPTION,
        public: false,
        files: { [relayFileName(forged)]: { content: JSON.stringify(forged) } }
      })
    })

    for (let round = 0; round < 3; round++) await alice.relay.pollOnce()
    expect(await Promise.race([call, Promise.resolve('pending' as const)])).toBe('pending')

    // The real peer's answer still settles the same call, so this refuses the forgery rather than
    // the correlation id.
    const answer = await settle(call, [bob, alice]) as { status: number; body: string }
    expect(JSON.parse(Buffer.from(answer.body, 'base64').toString('utf8')))
      .toEqual({ result: { echoed: '/remote/call', size: 2 } })
  })

  it('refuses a response signed by a device key other than the one the call was addressed to', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    peers.set('bob', bob.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const call = alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey)
    void call.catch(() => undefined)
    await sent(github)

    const outgoing = [...github.gists.values()].flatMap(gist => [...gist.files.keys()])
      .map(parseRelayFileName).find(parsed => parsed?.to === 'bob')!
    const aliceGist = [...github.gists.values()].find(gist => gist.owner === 'alice')!
    const published = readDirectoryEntry(JSON.parse(aliceGist.files.get(RELAY_DIRECTORY_FILE)!))!

    const impostor = generateDeviceKey('impostor')
    const binding: RelayBinding = { from: 'bob', to: 'alice', id: 'forged-2', kind: 'response', correlationId: outgoing.id }
    const sealed = sealMessage(published.sealKey, binding, Buffer.from(JSON.stringify({ status: 200, body: '' }), 'utf8'))
    const forged = {
      version: 1, ...binding, index: 0, total: 1,
      ephemeralKey: sealed.ephemeralKey, nonce: sealed.nonce, tag: sealed.tag,
      chunk: sealed.ciphertext.toString('base64'), createdAt: new Date().toISOString(),
      senderSignature: signMessage(impostor.privateKeyPem, binding, sealed)
    }
    await github.api('mallory')('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: RELAY_GIST_DESCRIPTION,
        public: false,
        files: { [relayFileName(forged)]: { content: JSON.stringify(forged) } }
      })
    })

    for (let round = 0; round < 3; round++) await alice.relay.pollOnce()
    expect(await Promise.race([call, Promise.resolve('pending' as const)])).toBe('pending')
  })

  it('counts a machine as checked in only when an approved device key signed its entry', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers)
    const carol = generateDeviceKey('carol')
    const impostor = generateDeviceKey('impostor')
    peers.set('bob', bob.device.publicKey)
    peers.set('carol', carol.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const claim = signDirectoryEntry(impostor.privateKeyPem, {
      version: 1, machineId: 'carol', machineName: 'Carol', accountLogin: 'owner',
      deviceKey: impostor.publicKey, sealKey: generateSealKey().publicKey, fingerprint: 'FP:carol',
      updatedAt: new Date().toISOString()
    })
    await github.api('mallory')('/gists', {
      method: 'POST',
      body: JSON.stringify({
        description: RELAY_GIST_DESCRIPTION,
        public: false,
        files: { [RELAY_DIRECTORY_FILE]: { content: JSON.stringify(claim) } }
      })
    })

    await alice.relay.pollOnce()
    expect(alice.relay.getStatus().reachable).toEqual(['bob'])
  })

  it('keeps a GitHub failure typed when the sweep collects it, so the loop backs off', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    let blocked = false
    const upstream = github.api('bob')
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers, {
      api: async (path, init) => {
        if (blocked && init?.method === 'PATCH' && (init.body ?? '').includes('"m.alice.')) {
          return {
            response: {
              status: 403,
              ok: false,
              headers: { get: (name: string) => (name.toLowerCase() === 'x-oauth-scopes' ? 'repo' : null) }
            },
            body: {}
          }
        }
        return await upstream(path, init)
      }
    })
    peers.set('alice', alice.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    void alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey).catch(() => undefined)
    await sent(github)
    blocked = true
    // Answering fails, and the sweep collects that failure. `tick` chooses its wait and its status
    // phase from the error type, so it has to arrive as itself rather than as a plain Error.
    await expect(bob.relay.pollOnce()).rejects.toBeInstanceOf(RelayUnavailableError)
  })

  /**
   * What an offline paired machine costs. The launcher re-probes every peer on a timer, and that
   * probe is a real call, so it sits in `pending` for as long as its deadline. Reading "a call is
   * pending" as "somebody is waiting" meant one switched-off machine held the loop at 1.5 s polling
   * against GitHub for ever - roughly 2,400 poll cycles an hour out of a 5,000 request budget.
   */
  it('does not sit at the fast cadence while only a background probe to an absent machine is outstanding', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    let clock = Date.parse('2026-03-02T09:00:00.000Z')
    const delays: number[] = []
    let next: (() => void) | null = null
    const alice = machine('alice', github, peers, {
      now: () => clock,
      schedule: (run, ms) => { delays.push(ms); next = run; return { cancel: () => undefined } }
    })
    // Bob checks in once and is then switched off: his mailbox is on the account, but nothing on
    // that machine will ever read it or answer.
    const bob = machine('bob', github, peers)
    peers.set('alice', alice.device.publicKey)
    await bob.relay.checkIn()
    await alice.relay.checkIn()

    const probe = alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey, { background: true })
    void probe.catch(() => undefined)
    await sent(github)
    clock += RELAY_BACKGROUND_ACTIVE_MS + 1

    const before = delays.length
    ;(next as unknown as () => void)()
    await vi.waitFor(() => { expect(delays.length).toBeGreaterThan(before) })
    // The probe is still outstanding - its deadline has not passed - and the loop is idle anyway.
    expect(alice.relay.nextPollDelayMs()).toBe(RELAY_POLL_IDLE_MS)
    expect(delays.at(-1)).toBe(RELAY_POLL_IDLE_MS)
  })

  it('still answers a waiting owner promptly, because only a background call decays', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    let clock = Date.parse('2026-03-02T09:00:00.000Z')
    const delays: number[] = []
    let next: (() => void) | null = null
    const alice = machine('alice', github, peers, {
      now: () => clock,
      schedule: (run, ms) => { delays.push(ms); next = run; return { cancel: () => undefined } }
    })
    const bob = machine('bob', github, peers)
    peers.set('alice', alice.device.publicKey)
    await bob.relay.checkIn()
    await alice.relay.checkIn()

    const call = alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey)
    void call.catch(() => undefined)
    await sent(github)
    clock += RELAY_BACKGROUND_ACTIVE_MS + 1

    const before = delays.length
    ;(next as unknown as () => void)()
    await vi.waitFor(() => { expect(delays.length).toBeGreaterThan(before) })
    expect(delays.at(-1)).toBe(RELAY_POLL_ACTIVE_MS)
  })

  it('gives a probe a shorter deadline than a call somebody is waiting on', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    let clock = Date.parse('2026-03-02T09:00:00.000Z')
    const alice = machine('alice', github, peers, { now: () => clock })
    const bob = machine('bob', github, peers)
    peers.set('alice', alice.device.publicKey)
    await bob.relay.checkIn()
    await alice.relay.checkIn()

    const probe = alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey, { background: true })
    const waited = alice.relay.call('bob', bob.device.publicKey, '/remote/call', Buffer.from('{}'), {}, bob.seal.publicKey)
    const settled = waited.then(() => 'answered', () => 'gave up')
    await sent(github)

    clock += RELAY_BACKGROUND_CALL_TIMEOUT_MS + 1
    await alice.relay.pollOnce()
    await expect(probe).rejects.toThrow(/did not answer/i)
    // The owner's own call is still open at the moment the probe has already been given up on.
    expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending')
    clock += RELAY_CALL_TIMEOUT_MS
    await alice.relay.pollOnce()
    await expect(settled).resolves.toBe('gave up')
  })

  it('still ages out a timed-out call when the sweep itself fails', async () => {
    const github = fakeGitHub()
    const peers = new Map<string, string>()
    let blocked = false
    let clock = Date.now()
    const upstream = github.api('bob')
    const alice = machine('alice', github, peers)
    const bob = machine('bob', github, peers, {
      now: () => clock,
      api: async (path, init) => {
        if (blocked && path.startsWith('/gists?')) {
          return {
            response: {
              status: 403,
              ok: false,
              headers: { get: (name: string) => (name.toLowerCase() === 'x-oauth-scopes' ? 'repo' : null) }
            },
            body: {}
          }
        }
        return await upstream(path, init)
      }
    })
    peers.set('alice', alice.device.publicKey)
    await alice.relay.checkIn()
    await bob.relay.checkIn()

    const call = bob.relay.call('alice', alice.device.publicKey, '/remote/call', Buffer.from('{}'), {}, alice.seal.publicKey)
    const outcome = call.then(() => 'resolved', (error: Error) => error.message)
    await sent(github)
    blocked = true
    clock += RELAY_CALL_TIMEOUT_MS + 1

    await expect(bob.relay.pollOnce()).rejects.toThrow()
    await expect(outcome).resolves.toMatch(/did not answer/i)
  })
})
