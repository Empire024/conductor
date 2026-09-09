import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateDeviceKey, keyFingerprint, signChallenge, type ChallengePayload, type DeviceKeyPair } from './device-key'
import { hashBody, RemoteAccessError, RemotePeers, type PairingAttempt } from './remote-peers'
import type { SecretKeyValueStore } from './secret-store'
import type { RemoteProjectSummary } from '../shared/remote-control'
import type { ProjectIdentity } from '../shared/project-identity'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

const FINGERPRINT = 'AA:BB:CC:DD'
const identityOf = (key: string, path: string, name: string, createdAt = '2026-01-01T00:00:00.000Z'): ProjectIdentity =>
  ({ key, keyCreatedAt: createdAt, path, name })
const PROJECTS: RemoteProjectSummary[] = [
  { id: 'project-a', name: 'Conductor', path: '/tmp/a', identity: identityOf('a'.repeat(32), '/tmp/a', 'Conductor'), identityError: null },
  { id: 'project-b', name: 'Renders', path: '/tmp/b', identity: identityOf('b'.repeat(32), '/tmp/b', 'Renders'), identityError: null }
]

function fixture(options: { accountKeys?: DeviceKeyPair[]; accountId?: number | null } = {}) {
  const store = new MapStore()
  const owner = generateDeviceKey('owner laptop')
  const accountKeys = options.accountKeys ?? [owner]
  let accountId: number | null = options.accountId === undefined ? 4242 : options.accountId
  let clock = Date.parse('2026-03-01T12:00:00.000Z')
  const keysFn = vi.fn(async () => accountKeys.map(key => key.publicKey))
  const activity = vi.fn()
  const peers = new RemotePeers({
    store,
    accountId: () => accountId,
    accountLogin: () => 'Empire024',
    accountKeys: keysFn,
    projects: () => PROJECTS,
    now: () => clock,
    activity,
    revalidateMs: 1000,
    offlineGraceMs: 5000
  })
  peers.setFingerprint(FINGERPRINT)
  peers.updateSettings({ enabled: true })
  return {
    store, peers, owner, keysFn, activity,
    setAccountId(value: number | null) { accountId = value },
    setAccountKeys(keys: DeviceKeyPair[]) { accountKeys.splice(0, accountKeys.length, ...keys) },
    advance(ms: number) { clock += ms },
    now: () => clock
  }
}

function pairingAttempt(key: DeviceKeyPair, code: string, now: number, overrides: Partial<PairingAttempt> = {}): PairingAttempt {
  const payload: ChallengePayload = {
    audienceMachineId: overrides.machineId === undefined ? '' : overrides.machineId,
    fingerprint: FINGERPRINT,
    nonce: 'nonce-' + Math.random().toString(36).slice(2, 12) + 'padding',
    purpose: 'pair',
    bodyHash: '',
    issuedAt: now
  }
  return {
    machineId: 'laptop-machine',
    machineName: 'Laptop',
    publicKey: key.publicKey,
    signature: signChallenge(key.privateKeyPem, payload),
    nonce: payload.nonce,
    timestamp: now,
    code,
    fingerprint: FINGERPRINT,
    ...overrides
  }
}

/** Signs a pairing attempt against the real audience machine id, which only the host knows. */
function attemptFor(peers: RemotePeers, key: DeviceKeyPair, code: string, now: number, mutate: Partial<ChallengePayload> = {}) {
  const payload: ChallengePayload = {
    audienceMachineId: peers.machineId,
    fingerprint: FINGERPRINT,
    nonce: 'nonce-abcdefghijklmnop',
    purpose: 'pair',
    bodyHash: '',
    issuedAt: now,
    ...mutate
  }
  const attempt = pairingAttempt(key, code, now)
  return { ...attempt, nonce: payload.nonce, signature: signChallenge(key.privateKeyPem, payload), timestamp: payload.issuedAt }
}

async function pairAndApprove(fix: ReturnType<typeof fixture>, key: DeviceKeyPair, projectIds = ['project-a']) {
  const { code } = fix.peers.issueTicket()
  const request = await fix.peers.beginPairing(attemptFor(fix.peers, key, code, fix.now()))
  return fix.peers.approve(request.id, projectIds)
}

function callCredentials(peers: RemotePeers, key: DeviceKeyPair, peerId: string, body: string, now: number, mutate: Partial<ChallengePayload> = {}) {
  const payload: ChallengePayload = {
    audienceMachineId: peers.machineId,
    fingerprint: FINGERPRINT,
    nonce: 'call-' + Math.random().toString(36).slice(2, 14) + 'pad',
    purpose: 'call',
    bodyHash: hashBody(body),
    issuedAt: now,
    ...mutate
  }
  return { peerId, nonce: payload.nonce, timestamp: payload.issuedAt, signature: signChallenge(key.privateKeyPem, payload), body, fingerprint: FINGERPRINT }
}

describe('pairing a machine', () => {
  let fix: ReturnType<typeof fixture>
  beforeEach(() => { fix = fixture() })

  it('refuses a device key that is not registered on this GitHub account', async () => {
    const stranger = generateDeviceKey('someone else')
    const { code } = fix.peers.issueTicket()
    await expect(fix.peers.beginPairing(attemptFor(fix.peers, stranger, code, fix.now())))
      .rejects.toThrow(/not signed in to the same GitHub account/)
    expect(fix.peers.listPending()).toHaveLength(0)
    expect(fix.peers.listPeers()).toHaveLength(0)
  })

  it('refuses a request whose signature does not match the key it presents', async () => {
    const impostor = generateDeviceKey('impostor')
    const { code } = fix.peers.issueTicket()
    const attempt = attemptFor(fix.peers, impostor, code, fix.now())
    // Same-account key, but the signature was produced by a key the caller does not hold.
    await expect(fix.peers.beginPairing({ ...attempt, publicKey: fix.owner.publicKey }))
      .rejects.toThrow(/not signed by the key it presented/)
  })

  it('refuses a signature aimed at a different machine, so a proxied pairing cannot be replayed here', async () => {
    const { code } = fix.peers.issueTicket()
    const attempt = attemptFor(fix.peers, fix.owner, code, fix.now(), { audienceMachineId: 'some-other-machine' })
    await expect(fix.peers.beginPairing(attempt)).rejects.toThrow(/not signed by the key it presented/)
  })

  it('refuses a signature bound to another certificate', async () => {
    const { code } = fix.peers.issueTicket()
    const attempt = attemptFor(fix.peers, fix.owner, code, fix.now(), { fingerprint: 'FF:FF:FF:FF' })
    await expect(fix.peers.beginPairing(attempt)).rejects.toThrow(/not signed by the key it presented/)
  })

  it('requires a pairing code the owner created on this machine, and burns it after one use', async () => {
    await expect(fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, 'made-up-code', fix.now())))
      .rejects.toThrow(/not valid on this machine/)
    const { code } = fix.peers.issueTicket()
    await fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, code, fix.now()))
    await expect(fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, code, fix.now())))
      .rejects.toThrow(/not valid on this machine/)
  })

  it('refuses a pairing request signed outside the clock-skew window', async () => {
    const { code } = fix.peers.issueTicket()
    await expect(fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, code, fix.now() - 10 * 60000)))
      .rejects.toThrow(/too old/)
    expect(fix.peers.listPending()).toHaveLength(0)
  })

  it('refuses a pairing request that reuses a nonce, even with a fresh code', async () => {
    await fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, fix.peers.issueTicket().code, fix.now()))
    await expect(fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, fix.peers.issueTicket().code, fix.now())))
      .rejects.toThrow(/already used/)
  })

  it('grants nothing until the owner approves, and then only the chosen projects', async () => {
    const { code } = fix.peers.issueTicket()
    const request = await fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, code, fix.now()))
    expect(fix.peers.listPeers()).toHaveLength(0)
    expect(request.grants.map(grant => grant.label)).toContain('Not granted')
    const peer = fix.peers.approve(request.id, ['project-a', 'not-a-real-project'])
    expect(peer.grantedProjects.map(granted => granted.projectId)).toEqual(['project-a'])
    // What the owner approved is the working copy, recorded so a swapped folder can be noticed.
    expect(peer.grantedProjects[0]?.identity).toEqual(PROJECTS[0]!.identity)
    expect(request.grants[0]?.detail).toContain('/tmp/a')
    expect(fix.peers.listPending()).toHaveLength(0)
  })

  it('refuses an approval that shares no registered project', async () => {
    const { code } = fix.peers.issueTicket()
    const request = await fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, code, fix.now()))
    expect(() => fix.peers.approve(request.id, ['nope'])).toThrow(/at least one registered project/)
  })

  it('reports a denied request to the waiting machine without pairing it', async () => {
    const { code } = fix.peers.issueTicket()
    const request = await fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, code, fix.now()))
    expect(fix.peers.pairingResult(request.keyFingerprint).status).toBe('pending')
    fix.peers.deny(request.id)
    expect(fix.peers.pairingResult(request.keyFingerprint).status).toBe('denied')
    expect(fix.peers.listPeers()).toHaveLength(0)
  })

  it('will not pair while this machine is signed out of GitHub', async () => {
    fix.setAccountId(null)
    const { code } = fix.peers.issueTicket()
    await expect(fix.peers.beginPairing(attemptFor(fix.peers, fix.owner, code, fix.now())))
      .rejects.toThrow(/not signed in to GitHub/)
  })
})

describe('polling for the owner answer', () => {
  let fix: ReturnType<typeof fixture>
  beforeEach(() => { fix = fixture() })

  const poll = (key: DeviceKeyPair, now: number) => {
    const payload: ChallengePayload = {
      audienceMachineId: fix.peers.machineId, fingerprint: FINGERPRINT,
      nonce: 'poll-' + Math.random().toString(36).slice(2, 14) + 'pad', purpose: 'pair', bodyHash: '', issuedAt: now
    }
    return { publicKey: key.publicKey, nonce: payload.nonce, timestamp: payload.issuedAt, signature: signChallenge(key.privateKeyPem, payload), fingerprint: FINGERPRINT }
  }

  it('answers a freshly signed poll with the fingerprint of the key that signed it', () => {
    expect(fix.peers.verifyPairingPoll(poll(fix.owner, fix.now()))).toBe(keyFingerprint(fix.owner.publicKey))
  })

  it('refuses a poll that is replayed, stale, or bound to another certificate', () => {
    const once = poll(fix.owner, fix.now())
    fix.peers.verifyPairingPoll(once)
    expect(() => fix.peers.verifyPairingPoll(once)).toThrow(/already used/)
    expect(() => fix.peers.verifyPairingPoll(poll(fix.owner, fix.now() - 10 * 60000))).toThrow(/too old/)
    expect(() => fix.peers.verifyPairingPoll({ ...poll(fix.owner, fix.now()), fingerprint: 'FF:FF' })).toThrow(/different connection/)
  })

  it('refuses a poll nobody signed for the key it presents', () => {
    expect(() => fix.peers.verifyPairingPoll({ ...poll(generateDeviceKey('impostor'), fix.now()), publicKey: fix.owner.publicKey }))
      .toThrow(/not signed by the key it presented/)
  })
})

describe('authenticating each remote call', () => {
  let fix: ReturnType<typeof fixture>
  let peerId: string
  beforeEach(async () => {
    fix = fixture()
    peerId = (await pairAndApprove(fix, fix.owner)).id
  })

  it('accepts a correctly signed call from an approved peer', async () => {
    const body = JSON.stringify({ method: 'projects.list', args: {} })
    const result = await fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, body, fix.now()))
    expect(result.peer.id).toBe(peerId)
    expect(result.grantedProjects.map(granted => granted.projectId)).toEqual(['project-a'])
    expect(fix.peers.listPeers()[0]?.lastSeenAt).not.toBeNull()
  })

  it('rejects a call whose body was changed after signing', async () => {
    const credentials = callCredentials(fix.peers, fix.owner, peerId, JSON.stringify({ method: 'files.read' }), fix.now())
    await expect(fix.peers.authenticate({ ...credentials, body: JSON.stringify({ method: 'files.write' }) }))
      .rejects.toThrow(/signature does not match/)
  })

  it('rejects a replayed request', async () => {
    const credentials = callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())
    await expect(fix.peers.authenticate(credentials)).resolves.toBeTruthy()
    await expect(fix.peers.authenticate(credentials)).rejects.toThrow(/already used/)
  })

  it('will not let unsigned traffic flush the replay memory and revive a used request', async () => {
    const captured = callCredentials(fix.peers, fix.owner, peerId, JSON.stringify({ method: 'files.write' }), fix.now())
    await expect(fix.peers.authenticate(captured)).resolves.toBeTruthy()
    await expect(fix.peers.authenticate(captured)).rejects.toThrow(/already used/)
    // A stranger holds no device key, so none of this can push the spent nonce out of memory.
    for (let index = 0; index < 5000; index++) {
      await expect(fix.peers.authenticate({ ...captured, nonce: `junk-${String(index).padStart(12, '0')}`, signature: 'AA' }))
        .rejects.toThrow(/does not match this machine/)
    }
    await expect(fix.peers.authenticate(captured)).rejects.toThrow(/already used/)
  })

  it('refuses a burst rather than forgetting a nonce that is still replayable', async () => {
    const captured = callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())
    await expect(fix.peers.authenticate(captured)).resolves.toBeTruthy()
    const seen = (fix.peers as unknown as { seenNonces: Map<string, number> }).seenNonces
    for (let index = 0; index < 4095; index++) seen.set(`filler-${index}`, fix.now())
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())))
      .rejects.toThrow(/Too many remote requests/)
    // Refusing the burst is only safe because the spent nonce survives it.
    await expect(fix.peers.authenticate(captured)).rejects.toThrow(/already used/)
  })

  it('rejects a request that is older than the clock-skew window', async () => {
    const credentials = callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now() - 5 * 60000)
    await expect(fix.peers.authenticate(credentials)).rejects.toThrow(/too old/)
  })

  it('rejects a request signed for a different machine or a different certificate', async () => {
    const stale = callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now(), { audienceMachineId: 'elsewhere' })
    await expect(fix.peers.authenticate(stale)).rejects.toThrow(/signature does not match/)
    const swapped = callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now(), { fingerprint: 'ZZ:ZZ' })
    await expect(fix.peers.authenticate({ ...swapped, fingerprint: 'ZZ:ZZ' })).rejects.toThrow(/signed for a different connection/)
  })

  it('rejects a peer this machine never approved', async () => {
    const credentials = callCredentials(fix.peers, fix.owner, 'not-a-peer', '{}', fix.now())
    await expect(fix.peers.authenticate(credentials)).rejects.toThrow(/does not know that peer/)
  })

  it('rejects a revoked peer immediately', async () => {
    fix.peers.revoke(peerId)
    const credentials = callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())
    await expect(fix.peers.authenticate(credentials)).rejects.toThrow(/was revoked/)
  })

  it('rejects every peer once this machine signs out of GitHub', async () => {
    fix.setAccountId(null)
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())))
      .rejects.toThrow(/not signed in to GitHub/)
  })

  it('rejects a peer paired under a different GitHub account', async () => {
    fix.setAccountId(9999)
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())))
      .rejects.toThrow(/different GitHub account/)
  })

  it('rejects everything while remote control is switched off', async () => {
    fix.peers.updateSettings({ enabled: false })
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())))
      .rejects.toThrow(/switched off/)
  })

  it('revokes a peer whose device key is removed from the GitHub account', async () => {
    fix.setAccountKeys([generateDeviceKey('a replacement key')])
    fix.advance(2000)
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())))
      .rejects.toThrow(/no longer registered on this GitHub account/)
    expect(fix.peers.listPeers()[0]?.revokedAt).not.toBeNull()
  })

  it('stops at once when this machine cannot use its own GitHub credential', async () => {
    // What GitHubAuth raises when the keychain will not return the token, or GitHub rejected it.
    // Unlike an unreachable network, no amount of waiting can confirm the account, so the grace
    // window must not cover it.
    fix.keysFn.mockRejectedValue(Object.assign(new Error('Sign in to GitHub first'), { accountUnverifiable: true }))
    fix.advance(2000)
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())))
      .rejects.toThrow(/cannot use its own GitHub credential/)
  })

  it('marks a dead pairing so the controlling machine can tell it from a refused call', async () => {
    fix.peers.revoke(peerId)
    const error = await fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())).catch(reason => reason as RemoteAccessError)
    expect((error as RemoteAccessError).code).toBe('peer-revoked')
  })

  it('pauses remote access when GitHub has not confirmed the account for too long', async () => {
    fix.keysFn.mockRejectedValue(new Error('offline'))
    fix.advance(2000)
    // Inside the grace window the peer keeps working on the last good confirmation.
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now()))).resolves.toBeTruthy()
    fix.advance(60000)
    await expect(fix.peers.authenticate(callCredentials(fix.peers, fix.owner, peerId, '{}', fix.now())))
      .rejects.toThrow(/has not confirmed this account recently/)
  })
})

describe('project scope', () => {
  it('only allows projects that are both registered here and granted to that peer', async () => {
    const fix = fixture()
    const peer = await pairAndApprove(fix, fix.owner, ['project-a'])
    expect(fix.peers.requireProject(peer, 'project-a').name).toBe('Conductor')
    expect(() => fix.peers.requireProject(peer, 'project-b')).toThrow(/not shared with this machine/)
    expect(() => fix.peers.requireProject(peer, 'unknown')).toThrow(/not shared with this machine/)
    expect(() => fix.peers.requireProject(peer, undefined)).toThrow(/Name a project/)
  })

  it('refuses a project that was removed from this machine after pairing', async () => {
    const store = new MapStore()
    let projects = [...PROJECTS]
    const owner = generateDeviceKey('owner')
    const peers = new RemotePeers({
      store, accountId: () => 1, accountLogin: () => 'owner',
      accountKeys: async () => [owner.publicKey], projects: () => projects, now: () => 1000
    })
    peers.setFingerprint(FINGERPRINT)
    peers.updateSettings({ enabled: true })
    const { code } = peers.issueTicket()
    const request = await peers.beginPairing(attemptFor(peers, owner, code, 1000))
    const peer = peers.approve(request.id, ['project-a'])
    projects = projects.filter(project => project.id !== 'project-a')
    expect(() => peers.requireProject(peer, 'project-a')).toThrow(/no longer registered/)
  })

  /**
   * The identity is what proves a shared project id still points at the working copy the owner
   * approved. Without it, repointing a project at another folder would silently hand a paired
   * machine a different repository under a name it already trusts.
   */
  it('refuses a shared project whose folder now holds a different working copy', async () => {
    const fix = fixture()
    const peer = await pairAndApprove(fix, fix.owner, ['project-a'])
    const swapped = { ...PROJECTS[0]!, identity: identityOf('c'.repeat(32), '/tmp/a', 'Conductor') }
    const peers = new RemotePeers({
      store: fix.store, accountId: () => 4242, accountLogin: () => 'Empire024',
      accountKeys: async () => [fix.owner.publicKey], projects: () => [swapped, PROJECTS[1]!]
    })
    expect(() => peers.requireProject(peers.listPeers()[0]!, 'project-a')).toThrow(/different working copy/)
    expect(() => peers.reshareProject(peer.id, 'project-a')).toThrow(/cannot be confirmed as a move/)
  })

  it('refuses a shared project that moved, until the owner confirms the new location here', async () => {
    const fix = fixture()
    const peer = await pairAndApprove(fix, fix.owner, ['project-a'])
    const moved = { ...PROJECTS[0]!, path: '/tmp/moved', identity: identityOf('a'.repeat(32), '/tmp/moved', 'Conductor') }
    const peers = new RemotePeers({
      store: fix.store, accountId: () => 4242, accountLogin: () => 'Empire024',
      accountKeys: async () => [fix.owner.publicKey], projects: () => [moved, PROJECTS[1]!]
    })
    expect(() => peers.requireProject(peers.listPeers()[0]!, 'project-a')).toThrow(/moved from \/tmp\/a to \/tmp\/moved/)
    // The project is still advertised, carrying the reason, rather than quietly disappearing.
    expect(peers.sharedProjects(peers.listPeers()[0]!)[0]?.identityError).toMatch(/moved from/)
    peers.reshareProject(peer.id, 'project-a')
    expect(peers.requireProject(peers.listPeers()[0]!, 'project-a').path).toBe('/tmp/moved')
  })

  it('will not share a project whose identity cannot be read', async () => {
    const store = new MapStore()
    const owner = generateDeviceKey('owner')
    const peers = new RemotePeers({
      store, accountId: () => 1, accountLogin: () => 'owner', accountKeys: async () => [owner.publicKey], now: () => 1000,
      projects: () => [{ ...PROJECTS[0]!, identity: null, identityError: 'project.json is not readable JSON.' }]
    })
    peers.setFingerprint(FINGERPRINT)
    peers.updateSettings({ enabled: true })
    const request = await peers.beginPairing(attemptFor(peers, owner, peers.issueTicket().code, 1000))
    expect(() => peers.approve(request.id, ['project-a'])).toThrow(/not readable JSON/)
  })
})

/**
 * A pairing the owner already approved must survive this change. What cannot survive is a claim
 * that they approved a particular working copy, because no identity was recorded back then.
 */
describe('pairings stored before projects carried an identity', () => {
  it('keeps the peer and everything it was granted, with nothing invented for it', () => {
    const store = new MapStore()
    const owner = generateDeviceKey('owner')
    store.setSetting('remote-control.peers', JSON.stringify([{
      id: 'peer-1', machineId: 'laptop', machineName: 'Laptop', accountId: 4242, accountLogin: 'Empire024',
      keyFingerprint: 'SHA256:stale', publicKey: owner.publicKey, grantedProjectIds: ['project-a', 'project-b'],
      approvedAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-02T00:00:00.000Z', revokedAt: null
    }]))
    const peers = new RemotePeers({
      store, accountId: () => 4242, accountLogin: () => 'Empire024',
      accountKeys: async () => [owner.publicKey], projects: () => PROJECTS
    })
    const peer = peers.listPeers()[0]!
    expect(peer.machineName).toBe('Laptop')
    expect(peer.grantedProjects).toEqual([
      { projectId: 'project-a', identity: null },
      { projectId: 'project-b', identity: null }
    ])
    // It keeps exactly the access it had, and gains nothing: no identity is adopted on first use.
    expect(peers.requireProject(peer, 'project-a').name).toBe('Conductor')
    expect(() => peers.requireProject(peer, 'unknown')).toThrow(/not shared with this machine/)
    expect(peers.listPeers()[0]?.grantedProjects[0]?.identity).toBeNull()
  })
})

describe('owner control', () => {
  it('revokes every peer when the owner signs out, and survives a restart', async () => {
    const fix = fixture()
    await pairAndApprove(fix, fix.owner)
    fix.peers.revokeAll()
    expect(fix.peers.listPeers().every(peer => peer.revokedAt)).toBe(true)
    const reloaded = new RemotePeers({
      store: fix.store, accountId: () => 4242, accountLogin: () => 'Empire024',
      accountKeys: async () => [fix.owner.publicKey], projects: () => PROJECTS
    })
    expect(reloaded.listPeers().every(peer => peer.revokedAt)).toBe(true)
    expect(reloaded.machineId).toBe(fix.peers.machineId)
  })

  it('keeps a visible record of what each peer did, allowed or denied', async () => {
    const fix = fixture()
    const peer = await pairAndApprove(fix, fix.owner)
    fix.peers.record(peer, 'files.write', 'project-a', 'files.write src/main.ts', 'allowed')
    fix.peers.record(peer, 'files.write', 'project-b', 'files.write elsewhere', 'denied', 'not shared')
    const entries = fix.peers.listActivity()
    expect(entries[0]).toMatchObject({ method: 'files.write', outcome: 'denied', projectId: 'project-b' })
    expect(entries[1]).toMatchObject({ method: 'files.write', outcome: 'allowed', machineName: 'Laptop' })
    expect(fix.activity).toHaveBeenCalled()
  })

  it('defaults to switched off and loopback, and stores nothing sensitive in the settings store', () => {
    const store = new MapStore()
    const peers = new RemotePeers({ store, accountId: () => 1, accountLogin: () => 'owner', accountKeys: async () => [], projects: () => [] })
    expect(peers.getSettings()).toMatchObject({ enabled: false, exposure: 'loopback' })
    expect([...store.values.values()].join(' ')).not.toMatch(/PRIVATE KEY/)
  })

  it('reports a RemoteAccessError status so the server answers with the right code', async () => {
    const fix = fixture()
    const error = await fix.peers.authenticate(callCredentials(fix.peers, fix.owner, 'ghost', '{}', fix.now())).catch(reason => reason as RemoteAccessError)
    expect(error).toBeInstanceOf(RemoteAccessError)
    expect((error as RemoteAccessError).status).toBe(401)
  })
})
