import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:https'
import { request as httpsRequest } from 'node:https'
import { encodeTicket, type RemotePeerRecord, type RemoteProjectSummary } from '../shared/remote-control'
import { generateDeviceKey, signChallenge, type ChallengePayload } from './device-key'
import { RemoteControlClient } from './remote-control-client'
import type { RemoteControlHost } from './remote-control-host'
import { RemoteControlServer } from './remote-control-server'
import { RemoteAccessError, RemotePeers } from './remote-peers'
import { createRemoteTlsIdentity } from './remote-tls'
import { StoredSecretVault, type SecretCipher, type SecretKeyValueStore } from './secret-store'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
  dump(): string { return [...this.values.entries()].map(([key, value]) => `${key}=${value}`).join('\n') }
}

const cipher: SecretCipher = {
  available: () => true,
  encrypt: value => Buffer.from('enc:' + Buffer.from(value, 'utf8').toString('hex'), 'utf8'),
  decrypt: value => Buffer.from(value.toString('utf8').replace(/^enc:/, ''), 'hex').toString('utf8')
}

const PROJECT_IDENTITY = { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: '/tmp/a', name: 'Conductor' }
const PROJECTS: RemoteProjectSummary[] = [{ id: 'project-a', name: 'Conductor', path: '/tmp/a', identity: PROJECT_IDENTITY, identityError: null }]
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function hostFixture() {
  const store = new MapStore()
  const vault = new StoredSecretVault(store, cipher)
  const ownerKey = generateDeviceKey('owner')
  const calls: Array<{ peer: RemotePeerRecord; method: string; args: unknown }> = []
  const peers = new RemotePeers({
    store,
    accountId: () => 4242,
    accountLogin: () => 'Empire024',
    accountKeys: async () => [ownerKey.publicKey],
    projects: () => PROJECTS
  })
  peers.updateSettings({ enabled: true, port: 0, machineName: 'Render Desktop' })
  const host = {
    call: vi.fn(async (peer: RemotePeerRecord, method: string, args: unknown) => { calls.push({ peer, method, args }); return { echoed: method, projects: peer.grantedProjects.map(granted => granted.projectId) } })
  } as unknown as RemoteControlHost
  const server = new RemoteControlServer({
    peers, host, store, vault,
    machineName: () => 'Render Desktop',
    accountLogin: () => 'Empire024'
  })
  const status = await server.apply()
  cleanup.push(() => server.close())
  // apply() reports a listen failure through status instead of throwing, so without this a dead
  // fixture server surfaces as whatever unrelated assertion the test happened to make next.
  if (!status.listening) throw new Error('fixture server did not start: ' + (status.message ?? 'no reason reported'))
  return { store, vault, peers, server, host, calls, ownerKey, status }
}

function clientFixture(key = generateDeviceKey('laptop')) {
  const store = new MapStore()
  const client = new RemoteControlClient({
    store,
    machineId: () => 'laptop-machine-id',
    machineName: () => 'Laptop',
    deviceKey: () => key
  })
  return { store, client, key }
}

/** Drives pairing to completion, approving on the controlled machine at the first poll. */
async function pair(fix: Awaited<ReturnType<typeof hostFixture>>, client: RemoteControlClient) {
  const ticket = fix.server.ticket()
  return client.connect(encodeTicket(ticket), async () => {
    const pending = fix.peers.listPending()
    if (pending[0]) fix.peers.approve(pending[0].id, ['project-a'])
  })
}

const rawPost = (port: number, path: string, body: string, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const call = httpsRequest({
      host: '127.0.0.1', port, path, method, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...headers }
    }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
    })
    call.on('error', reject)
    call.end(body)
  })

describe('the remote control server', () => {
  it('serves HTTPS on loopback and reports the certificate to pin', async () => {
    const fix = await hostFixture()
    expect(fix.status.listening).toBe(true)
    expect(fix.status.endpoint).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/)
    expect(fix.status.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2})+$/)
    expect(fix.store.dump()).not.toContain('PRIVATE KEY')
  })

  it('does not listen at all while remote control is switched off', async () => {
    const fix = await hostFixture()
    fix.peers.updateSettings({ enabled: false })
    const status = await fix.server.apply()
    expect(status.listening).toBe(false)
    expect(status.endpoint).toBeNull()
    expect(() => fix.server.ticket()).toThrow(/Switch remote control on/)
  })

  it('will not listen while this machine is signed out of GitHub', async () => {
    const store = new MapStore()
    const peers = new RemotePeers({ store, accountId: () => null, accountLogin: () => null, accountKeys: async () => [], projects: () => PROJECTS })
    peers.updateSettings({ enabled: true, port: 0 })
    const server = new RemoteControlServer({
      peers, host: { call: vi.fn() } as unknown as RemoteControlHost, store, vault: new StoredSecretVault(store, cipher),
      machineName: () => 'Desktop', accountLogin: () => null
    })
    cleanup.push(() => server.close())
    const status = await server.apply()
    expect(status.listening).toBe(false)
    expect(status.message).toMatch(/Sign in to GitHub/)
  })
})

describe('an end-to-end pairing and call between two machines', () => {
  it('pairs after the owner approves, then runs signed calls scoped to the granted project', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const connection = await pair(fix, laptop.client)
    expect(connection.status).toBe('connected')
    // Pairing tells this machine what the other one shares, identity and all, but confirms no
    // mapping on its own: which project here is which over there stays the owner's answer.
    expect(connection.remoteProjects.map(project => project.id)).toEqual(['project-a'])
    expect(connection.remoteProjects[0]?.identity).toEqual(PROJECT_IDENTITY)
    expect(connection.projectGrants).toEqual([])
    expect(connection.machineName).toBe('Render Desktop')

    const result = await laptop.client.call(connection.machineId, 'projects.list', { projectId: 'project-a' })
    expect(result).toEqual({ echoed: 'projects.list', projects: ['project-a'] })
    expect(fix.calls[0]?.peer.machineName).toBe('Laptop')
    expect(fix.peers.listPeers()[0]?.lastSeenAt).not.toBeNull()
  })

  it('stops working the moment the owner revokes the peer', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const connection = await pair(fix, laptop.client)
    await laptop.client.call(connection.machineId, 'projects.list')
    fix.peers.revoke(fix.peers.listPeers()[0]!.id)
    await expect(laptop.client.call(connection.machineId, 'projects.list')).rejects.toThrow(/revoked/)
    expect(laptop.client.get(connection.machineId)?.status).toBe('revoked')
  })

  it('refuses a machine whose device key is not on the same GitHub account', async () => {
    const fix = await hostFixture()
    const stranger = clientFixture(generateDeviceKey('stranger laptop'))
    await expect(pair(fix, stranger.client)).rejects.toThrow(/not signed in to the same GitHub account/)
    expect(fix.peers.listPeers()).toHaveLength(0)
  })

  it('refuses to pair without a code the owner made on the controlled machine', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const ticket = { ...fix.server.ticket(), code: 'forged-code' }
    await expect(laptop.client.connect(encodeTicket(ticket), async () => {})).rejects.toThrow(/not valid on this machine/)
  })

  it('gives up when the owner declines the pairing request', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const ticket = fix.server.ticket()
    await expect(laptop.client.connect(encodeTicket(ticket), async () => {
      const pending = fix.peers.listPending()
      if (pending[0]) fix.peers.deny(pending[0].id)
    })).rejects.toThrow(/declined this pairing/)
    expect(laptop.client.list()).toHaveLength(0)
  })
})

describe('what the server refuses on the wire', () => {
  it('rejects an unsigned or wrongly signed call', async () => {
    const fix = await hostFixture()
    const port = Number(new URL(fix.status.endpoint!).port)
    const unsigned = await rawPost(port, '/remote/call', JSON.stringify({ method: 'projects.list' }))
    expect(unsigned.status).toBe(401)
    expect(unsigned.body).toMatch(/does not know that peer/)
  })

  it('refuses a pair-status poll that is replayed onto a second connection', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const ticket = fix.server.ticket()
    await laptop.client.connect(encodeTicket(ticket), async () => {
      const pending = fix.peers.listPending()
      if (pending[0]) fix.peers.approve(pending[0].id, ['project-a'])
    })
    const payload: ChallengePayload = {
      audienceMachineId: fix.peers.machineId, fingerprint: fix.status.fingerprint ?? '',
      nonce: 'replayable-poll-nonce', purpose: 'pair', bodyHash: '', issuedAt: Date.now()
    }
    const body = JSON.stringify({ publicKey: fix.ownerKey.publicKey, signature: signChallenge(fix.ownerKey.privateKeyPem, payload), nonce: payload.nonce, timestamp: payload.issuedAt })
    const first = await rawPost(ticket.port, '/remote/pair/status', body)
    expect(first.status).toBe(200)
    expect(first.body).toContain('peerId')
    // Same bytes, brand new connection: the poll is spent, so the peer id is not handed out twice.
    const replay = await rawPost(ticket.port, '/remote/pair/status', body)
    expect(replay.status).toBe(401)
    expect(replay.body).not.toContain('peerId')
  })

  it('keeps handling errors after it is listening, instead of taking the app down', async () => {
    const fix = await hostFixture()
    const listener = (fix.server as unknown as { server: import('node:https').Server }).server
    expect(listener.listenerCount('error')).toBeGreaterThan(0)
    expect(() => listener.emit('error', new Error('the network interface went away'))).not.toThrow()
    expect(fix.server.getStatus().message).toContain('network interface went away')
  })

  it('caps how many sockets an unauthenticated caller can hold open', async () => {
    const fix = await hostFixture()
    const listener = (fix.server as unknown as { server: import('node:https').Server }).server
    expect(listener.maxConnections).toBeGreaterThan(0)
  })

  it('rejects browser-shaped requests, other verbs and unknown endpoints', async () => {
    const fix = await hostFixture()
    const port = Number(new URL(fix.status.endpoint!).port)
    expect((await rawPost(port, '/remote/call', '{}', { Origin: 'https://evil.example' })).status).toBe(405)
    expect((await rawPost(port, '/remote/call', '{}', {}, 'GET')).status).toBe(405)
    expect((await rawPost(port, '/remote/call', '{}', { 'Content-Type': 'text/plain' })).status).toBe(405)
    expect((await rawPost(port, '/nope', '{}')).status).toBe(404)
  })

  it('will not reveal a pairing result to anyone who cannot sign for the key', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const ticket = fix.server.ticket()
    const port = ticket.port
    await laptop.client.connect(encodeTicket(ticket), async () => {
      const pending = fix.peers.listPending()
      if (pending[0]) fix.peers.approve(pending[0].id, ['project-a'])
    })
    const snooped = await rawPost(port, '/remote/pair/status', JSON.stringify({
      publicKey: fix.ownerKey.publicKey, signature: Buffer.alloc(64).toString('base64'), nonce: 'guessed-nonce-1234', timestamp: Date.now()
    }))
    expect(snooped.status).toBe(401)
    expect(snooped.body).not.toContain('peerId')
  })
})

describe('how the controlling machine reads a refusal', () => {
  it('keeps a machine usable when one call is denied, and drops it when the pairing is dead', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const connected = await pair(fix, laptop.client)

    // A refused call — an unshared project, a workspace that moved — is not a dead pairing.
    vi.mocked(fix.host.call).mockRejectedValueOnce(new RemoteAccessError('That project was not shared with this machine.', 403))
    await expect(laptop.client.call(connected.machineId, 'files.read', {})).rejects.toThrow(/not shared/)
    expect(laptop.client.get(connected.machineId)?.status).toBe('connected')
    await expect(laptop.client.call(connected.machineId, 'projects.list')).resolves.toBeTruthy()

    // Revocation on the controlled machine does end it, and the controller stops dialling.
    fix.peers.revoke(fix.peers.listPeers()[0]!.id)
    await expect(laptop.client.call(connected.machineId, 'projects.list')).rejects.toThrow(/revoked/)
    expect(laptop.client.get(connected.machineId)?.status).toBe('revoked')
  })

  it('ignores a peer id the other machine made up rather than putting it in a header', async () => {
    const fix = await hostFixture()
    const laptop = clientFixture(fix.ownerKey)
    const ticket = fix.server.ticket()
    vi.spyOn(fix.peers, 'pairingResult').mockReturnValue({
      status: 'approved',
      peer: { ...fix.peers.listPeers()[0], id: 'bad\r\nX-Injected: 1', grantedProjects: 'not-an-array' } as never
    })
    await expect(laptop.client.connect(encodeTicket(ticket), async () => {})).rejects.toThrow(/did not approve in time/)
    expect(laptop.client.list()[0]?.peerId).toBe('')
  })
})

describe('certificate pinning on the controlling machine', () => {
  it('sends nothing at all to a machine presenting a different certificate', async () => {
    const fix = await hostFixture()
    const impostorIdentity = createRemoteTlsIdentity('Conductor · Impostor', [])
    const received: string[] = []
    const impostor = createServer({ cert: impostorIdentity.certificatePem, key: impostorIdentity.privateKeyPem },
      (request, response) => { received.push(request.url ?? ''); response.writeHead(200); response.end('{}') })
    await new Promise<void>(resolve => impostor.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { impostor.closeAllConnections(); await new Promise<void>(resolve => impostor.close(() => resolve())) })
    const address = impostor.address()
    const impostorPort = address && typeof address !== 'string' ? address.port : 0

    const laptop = clientFixture(fix.ownerKey)
    // The real machine's fingerprint, but the connection lands on the impostor.
    const ticket = { ...fix.server.ticket(), port: impostorPort }
    await expect(laptop.client.connect(encodeTicket(ticket), async () => {}))
      .rejects.toThrow(/presented a different certificate/)
    expect(received).toEqual([])
    expect(fix.peers.listPending()).toHaveLength(0)
  })

  it('refuses an expired or unreadable pairing code before touching the network', async () => {
    const laptop = clientFixture()
    await expect(laptop.client.connect('not-a-ticket', async () => {})).rejects.toThrow(/not readable|incomplete/)
    const expired = encodeTicket({
      version: 1, machineId: 'm', machineName: 'M', accountLogin: 'o', host: '127.0.0.1', port: 1,
      fingerprint: 'AA', code: 'c', expiresAt: new Date(Date.now() - 1000).toISOString()
    })
    await expect(laptop.client.connect(expired, async () => {})).rejects.toThrow(/expired/)
  })

  it('refuses to pair at all when this machine has no device key yet', async () => {
    const store = new MapStore()
    const client = new RemoteControlClient({ store, machineId: () => 'm', machineName: () => 'M', deviceKey: () => null })
    const fix = await hostFixture()
    await expect(client.connect(encodeTicket(fix.server.ticket()), async () => {})).rejects.toThrow(/Sign in to GitHub/)
  })
})
