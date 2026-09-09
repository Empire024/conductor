import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  challengeBytes,
  encodeOpenSshEd25519,
  generateDeviceKey,
  keyFingerprint,
  parseOpenSshEd25519,
  secretsMatch,
  signChallenge,
  verifyChallenge,
  type ChallengePayload
} from './device-key'

const payload = (overrides: Partial<ChallengePayload> = {}): ChallengePayload => ({
  audienceMachineId: 'desktop-1',
  fingerprint: 'AA:BB',
  nonce: 'nonce-value-1234',
  purpose: 'call',
  bodyHash: 'body-hash',
  issuedAt: 1772000000000,
  ...overrides
})

describe('OpenSSH device keys', () => {
  it('round-trips through the exact authorized-keys form GitHub stores', () => {
    const key = generateDeviceKey('Conductor device: Laptop')
    expect(key.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    expect(key.publicKey.endsWith(' Conductor device: Laptop')).toBe(true)
    const raw = parseOpenSshEd25519(key.publicKey)
    expect(raw).toHaveLength(32)
    expect(encodeOpenSshEd25519(raw)).toBe(key.publicKey.split(' ').slice(0, 2).join(' '))
  })

  it('produces the same SHA256 fingerprint ssh-keygen prints, ignoring the comment', () => {
    const key = generateDeviceKey('one comment')
    const blob = Buffer.from(key.publicKey.split(' ')[1]!, 'base64')
    expect(key.fingerprint).toBe('SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, ''))
    expect(keyFingerprint(key.publicKey.split(' ').slice(0, 2).join(' ') + ' another comment')).toBe(key.fingerprint)
  })

  it('refuses key types and blobs it cannot verify', () => {
    for (const value of ['', 'ssh-rsa AAAAB3NzaC1yc2E=', 'ssh-ed25519', 'ssh-ed25519 not-base64!!', 'ssh-ed25519 AAAA']) {
      expect(() => parseOpenSshEd25519(value)).toThrow()
    }
  })
})

describe('challenge signatures', () => {
  it('verifies a signature made by the matching private key', () => {
    const key = generateDeviceKey('device')
    const signature = signChallenge(key.privateKeyPem, payload())
    expect(verifyChallenge(key.publicKey, payload(), signature)).toBe(true)
  })

  it('refuses a signature from any other key', () => {
    const key = generateDeviceKey('device'), other = generateDeviceKey('other')
    const signature = signChallenge(other.privateKeyPem, payload())
    expect(verifyChallenge(key.publicKey, payload(), signature)).toBe(false)
  })

  it('binds the signature to every field, so nothing about the request can be swapped', () => {
    const key = generateDeviceKey('device')
    const signature = signChallenge(key.privateKeyPem, payload())
    const mutations: Array<Partial<ChallengePayload>> = [
      { audienceMachineId: 'another-machine' },
      { fingerprint: 'CC:DD' },
      { nonce: 'different-nonce-99' },
      { purpose: 'pair' },
      { bodyHash: 'other-body' },
      { issuedAt: 1772000000001 }
    ]
    for (const mutation of mutations) expect(verifyChallenge(key.publicKey, payload(mutation), signature)).toBe(false)
  })

  it('treats malformed signatures and keys as a failed check rather than throwing', () => {
    const key = generateDeviceKey('device')
    expect(verifyChallenge(key.publicKey, payload(), 'not-base64-signature')).toBe(false)
    expect(verifyChallenge(key.publicKey, payload(), Buffer.alloc(64).toString('base64'))).toBe(false)
    expect(verifyChallenge('ssh-rsa AAAA', payload(), 'x')).toBe(false)
  })

  it('separates fields so concatenated values cannot be shifted between them', () => {
    const a = challengeBytes(payload({ audienceMachineId: 'ab', nonce: 'cd-1234567890123' }))
    const b = challengeBytes(payload({ audienceMachineId: 'a', nonce: 'bcd-1234567890123' }))
    expect(a.equals(b)).toBe(false)
  })
})

describe('secret comparison', () => {
  it('matches identical secrets and rejects different or empty ones', () => {
    expect(secretsMatch('abc123', 'abc123')).toBe(true)
    expect(secretsMatch('abc123', 'abc124')).toBe(false)
    expect(secretsMatch('abc', 'abcd')).toBe(false)
    expect(secretsMatch('', '')).toBe(false)
  })
})
