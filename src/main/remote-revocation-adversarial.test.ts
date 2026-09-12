import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { generateDeviceKey, signChallenge, type ChallengePayload } from './device-key'
import { hashBody, RemotePeers } from './remote-peers'

/** Independent integration review: owner revocation must win while GitHub is slow. */
async function fixture() {
  const values = new Map<string, string>()
  const key = generateDeviceKey('adversarial fixture')
  let accountId: number | null = 42
  const accountKeys = vi.fn(async (): Promise<string[]> => [key.publicKey])
  const peers = new RemotePeers({
    store: {
      getSetting: name => values.get(name) ?? null,
      setSetting: (name, value) => { values.set(name, value) },
      removeSetting: name => { values.delete(name) }
    },
    accountId: () => accountId,
    accountLogin: () => 'fixture',
    accountKeys,
    projects: () => [{ id: 'project', name: 'Project', path: '/fixture', identityError: null,
      identity: { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: '/fixture', name: 'Project' } }]
  })
  const fingerprint = 'fixture-certificate'
  peers.setFingerprint(fingerprint)
  peers.updateSettings({ enabled: true })
  const payload = (purpose: 'pair' | 'call', body = ''): ChallengePayload => ({
    audienceMachineId: peers.machineId, fingerprint, nonce: randomUUID(), purpose,
    bodyHash: purpose === 'call' ? hashBody(body) : '', issuedAt: Date.now()
  })
  const pairing = payload('pair')
  const pending = await peers.beginPairing({ machineId: 'laptop', machineName: 'Laptop', publicKey: key.publicKey,
    nonce: pairing.nonce, timestamp: pairing.issuedAt, fingerprint,
    signature: signChallenge(key.privateKeyPem, pairing), code: peers.issueTicket().code })
  const peer = peers.approve(pending.id, ['project'])
  const call = payload('call', '{}')
  let release!: (keys: string[]) => void
  accountKeys.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const authentication = peers.authenticate({ peerId: peer.id, nonce: call.nonce, timestamp: call.issuedAt,
    fingerprint, body: '{}', signature: signChallenge(key.privateKeyPem, call) })
  return { peers, peer, authentication, release: () => release([key.publicKey]), setAccount: (next: number | null) => { accountId = next } }
}

describe('authorization changes during remote account verification', () => {
  it.each(['revoke', 'forget', 'disable', 'sign-out', 'account-switch'] as const)('rejects an in-flight call after %s', async action => {
    const fix = await fixture()
    if (action === 'revoke') fix.peers.revoke(fix.peer.id)
    if (action === 'forget') fix.peers.forget(fix.peer.id)
    if (action === 'disable') fix.peers.updateSettings({ enabled: false })
    if (action === 'sign-out') { fix.setAccount(null); fix.peers.revokeAll() }
    if (action === 'account-switch') fix.setAccount(99)
    fix.release()
    await expect(fix.authentication).rejects.toThrow()
  })
})
