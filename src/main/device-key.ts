import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, verify } from 'node:crypto'

/**
 * This machine's device identity: an Ed25519 key registered on the owner's GitHub account as an
 * SSH key. A peer proves it is the same account by signing a challenge with a key the account
 * actually lists, so the check never depends on a claim the peer makes about itself, and no
 * access token is ever transmitted between machines.
 */
export interface DeviceKeyPair {
  /** OpenSSH authorized-keys form, exactly as GitHub stores and returns it. */
  publicKey: string
  /** PKCS#8 PEM; only ever persisted through the OS credential store. */
  privateKeyPem: string
  fingerprint: string
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const KEY_TYPE = 'ssh-ed25519'

const sshString = (value: Buffer | string): Buffer => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

const readSshString = (blob: Buffer, offset: number): { value: Buffer; next: number } => {
  if (offset + 4 > blob.length) throw new Error('Malformed SSH key blob')
  const length = blob.readUInt32BE(offset)
  if (length > 4096 || offset + 4 + length > blob.length) throw new Error('Malformed SSH key blob')
  return { value: blob.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length }
}

/** Accepts an authorized-keys line with or without a comment and returns the raw 32-byte key. */
export function parseOpenSshEd25519(authorizedKey: string): Buffer {
  const parts = String(authorizedKey ?? '').trim().split(/\s+/)
  const encoded = parts[0] === KEY_TYPE ? parts[1] : undefined
  if (!encoded) throw new Error('Only ssh-ed25519 device keys are accepted')
  let blob: Buffer
  try { blob = Buffer.from(encoded, 'base64') } catch { throw new Error('Malformed SSH key blob') }
  if (Buffer.from(blob).toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('Malformed SSH key blob')
  const type = readSshString(blob, 0)
  if (type.value.toString('utf8') !== KEY_TYPE) throw new Error('Only ssh-ed25519 device keys are accepted')
  const key = readSshString(blob, type.next)
  if (key.next !== blob.length || key.value.length !== 32) throw new Error('Malformed SSH key blob')
  return Buffer.from(key.value)
}

export function encodeOpenSshEd25519(rawPublicKey: Buffer, comment = ''): string {
  if (rawPublicKey.length !== 32) throw new Error('Ed25519 public keys are 32 bytes')
  const blob = Buffer.concat([sshString(KEY_TYPE), sshString(rawPublicKey)])
  return `${KEY_TYPE} ${blob.toString('base64')}${comment ? ' ' + comment : ''}`
}

/** The `SHA256:...` form GitHub and ssh-keygen both print, so the owner can compare by eye. */
export function keyFingerprint(authorizedKey: string): string {
  const raw = parseOpenSshEd25519(authorizedKey)
  const blob = Buffer.concat([sshString(KEY_TYPE), sshString(raw)])
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

export function generateDeviceKey(comment: string): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const authorizedKey = encodeOpenSshEd25519(spki.subarray(spki.length - 32), comment)
  return {
    publicKey: authorizedKey,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: keyFingerprint(authorizedKey)
  }
}

/**
 * The signed payload always names the audience machine and the certificate it was presented over,
 * so a signature captured by one host cannot be replayed at another or through a proxied cert.
 */
export interface ChallengePayload {
  audienceMachineId: string
  fingerprint: string
  nonce: string
  purpose: 'pair' | 'call'
  /** SHA-256 of the request body for calls; the empty string while pairing. */
  bodyHash: string
  issuedAt: number
}

export function challengeBytes(payload: ChallengePayload): Buffer {
  return Buffer.from([
    'conductor-remote-control/1',
    payload.purpose,
    payload.audienceMachineId,
    payload.fingerprint,
    payload.nonce,
    payload.bodyHash,
    String(payload.issuedAt)
  ].join('\n'), 'utf8')
}

export function signChallenge(privateKeyPem: string, payload: ChallengePayload): string {
  return sign(null, challengeBytes(payload), createPrivateKey(privateKeyPem)).toString('base64')
}

export function verifyChallenge(authorizedKey: string, payload: ChallengePayload, signature: string): boolean {
  let raw: Buffer, decoded: Buffer
  try {
    raw = parseOpenSshEd25519(authorizedKey)
    decoded = Buffer.from(signature, 'base64')
  } catch { return false }
  if (decoded.length !== 64) return false
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
  try { return verify(null, challengeBytes(payload), key, decoded) } catch { return false }
}

/** Constant-time comparison for the short pairing codes and issued peer secrets. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(String(a ?? ''), 'utf8'), right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length || !left.length) return false
  return timingSafeEqual(left, right)
}
