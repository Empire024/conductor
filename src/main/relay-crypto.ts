import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import type { RelayDirectoryEntry, RelayEnvelope, RelayMessageKind } from '../shared/remote-relay'
import { signStatement, verifyStatement } from './device-key'

/**
 * The confidentiality layer for relayed messages. GitHub holds the ciphertext, so everything that
 * decides who can read a message has to be decided here: the recipient's X25519 key is published in
 * a directory entry signed by the account's device key, each message gets a fresh ephemeral key,
 * and the routing fields are authenticated as associated data so a stored message cannot be
 * re-addressed, replayed back in the other direction, or presented as the answer to a different
 * request.
 */

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export interface RelaySealKeyPair {
  /** Base64 raw 32-byte public key, as it is published in the directory entry. */
  publicKey: string
  /** Base64 raw 32-byte private key; only ever persisted through the OS credential store. */
  privateKey: string
}

export function generateSealKey(): RelaySealKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
  return {
    publicKey: spki.subarray(spki.length - KEY_BYTES).toString('base64'),
    privateKey: pkcs8.subarray(pkcs8.length - KEY_BYTES).toString('base64')
  }
}

const rawKey = (value: string, label: string): Buffer => {
  let decoded: Buffer
  try { decoded = Buffer.from(String(value ?? ''), 'base64') } catch { throw new Error(`Malformed ${label}`) }
  if (decoded.length !== KEY_BYTES) throw new Error(`Malformed ${label}`)
  return decoded
}

export const sealPublicKey = (base64: string): ReturnType<typeof createPublicKey> =>
  createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, rawKey(base64, 'relay public key')]), format: 'der', type: 'spki' })

export const sealPrivateKey = (base64: string): ReturnType<typeof createPrivateKey> =>
  createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, rawKey(base64, 'relay private key')]), format: 'der', type: 'pkcs8' })

export interface RelayBinding {
  from: string
  to: string
  id: string
  kind: RelayMessageKind
  correlationId: string
}

/** What both sides must agree on for a message to open: who sent it, to whom, which one it is, and
 *  whether it is the request or the answer. Any disagreement changes the AAD and the tag fails. */
const bindingBytes = (binding: RelayBinding): Buffer => Buffer.from(
  ['conductor-relay/1', binding.kind, binding.from, binding.to, binding.id, binding.correlationId].join('\n'), 'utf8')

const derive = (shared: Buffer, salt: Buffer, binding: RelayBinding): Buffer =>
  Buffer.from(hkdfSync('sha256', shared, salt, bindingBytes(binding), KEY_BYTES))

export interface SealedMessage {
  ephemeralKey: string
  nonce: string
  tag: string
  ciphertext: Buffer
}

export function sealMessage(recipientSealKey: string, binding: RelayBinding, plaintext: Buffer): SealedMessage {
  const ephemeral = generateKeyPairSync('x25519')
  const ephemeralSpki = ephemeral.publicKey.export({ type: 'spki', format: 'der' })
  const ephemeralRaw = ephemeralSpki.subarray(ephemeralSpki.length - KEY_BYTES)
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: sealPublicKey(recipientSealKey) })
  const key = derive(shared, ephemeralRaw, binding)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(bindingBytes(binding))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ephemeralKey: ephemeralRaw.toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext
  }
}

export function openMessage(recipientPrivateKey: string, sealed: Omit<SealedMessage, 'ciphertext'>, binding: RelayBinding, ciphertext: Buffer): Buffer {
  const shared = diffieHellman({ privateKey: sealPrivateKey(recipientPrivateKey), publicKey: sealPublicKey(sealed.ephemeralKey) })
  const key = derive(shared, rawKey(sealed.ephemeralKey, 'relay ephemeral key'), binding)
  const nonce = Buffer.from(sealed.nonce, 'base64')
  if (nonce.length !== NONCE_BYTES) throw new Error('Malformed relay nonce')
  const tag = Buffer.from(sealed.tag, 'base64')
  if (tag.length !== TAG_BYTES) throw new Error('Malformed relay tag')
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(bindingBytes(binding))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

const DIRECTORY_STATEMENT = 'relay-directory'

const directoryStatement = (entry: Omit<RelayDirectoryEntry, 'signature'>): string => [
  entry.version, entry.machineId, entry.machineName, entry.accountLogin, entry.deviceKey, entry.sealKey, entry.fingerprint, entry.updatedAt
].join('\n')

export function signDirectoryEntry(devicePrivateKeyPem: string, entry: Omit<RelayDirectoryEntry, 'signature'>): RelayDirectoryEntry {
  return { ...entry, signature: signStatement(devicePrivateKeyPem, DIRECTORY_STATEMENT, directoryStatement(entry)) }
}

/**
 * A directory entry is only ever used after this returns true, and the device key it is checked
 * against is one the owner already approved: the pairing ticket's for a first contact, the stored
 * peer record's afterwards. An entry GitHub served but nothing signed for is not an identity, so a
 * stolen gist scope can delete or corrupt a mailbox but can never redirect a message to its own key.
 */
export function verifyDirectoryEntry(entry: RelayDirectoryEntry, expectedDeviceKey: string): boolean {
  if (!entry || entry.version !== 1 || typeof entry.signature !== 'string') return false
  const { signature, ...rest } = entry
  return verifyStatement(expectedDeviceKey, DIRECTORY_STATEMENT, directoryStatement(rest), signature)
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown, max: number): string => (typeof value === 'string' && value.length <= max ? value : '')

/** Everything here arrived from GitHub, so each field is rebuilt rather than spread through. */
export function readDirectoryEntry(value: unknown): RelayDirectoryEntry | null {
  if (!isRecord(value) || value.version !== 1) return null
  const entry: RelayDirectoryEntry = {
    version: 1,
    machineId: str(value.machineId, 100),
    machineName: str(value.machineName, 200),
    accountLogin: str(value.accountLogin, 100),
    deviceKey: str(value.deviceKey, 1000),
    sealKey: str(value.sealKey, 100),
    fingerprint: str(value.fingerprint, 200),
    updatedAt: str(value.updatedAt, 40),
    signature: str(value.signature, 200)
  }
  return entry.machineId && entry.deviceKey && entry.sealKey && entry.signature ? entry : null
}

export function readEnvelope(value: unknown): RelayEnvelope | null {
  if (!isRecord(value) || value.version !== 1) return null
  const kind = value.kind === 'request' || value.kind === 'response' ? value.kind : null
  const index = Number(value.index)
  const total = Number(value.total)
  if (!kind || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 64 || index < 0 || index >= total) return null
  const envelope: RelayEnvelope = {
    version: 1,
    id: str(value.id, 100),
    from: str(value.from, 100),
    to: str(value.to, 100),
    kind,
    correlationId: str(value.correlationId, 100),
    index,
    total,
    ephemeralKey: str(value.ephemeralKey, 100),
    nonce: str(value.nonce, 40),
    tag: str(value.tag, 40),
    chunk: typeof value.chunk === 'string' ? value.chunk : '',
    createdAt: str(value.createdAt, 40)
  }
  return envelope.id && envelope.from && envelope.to && envelope.correlationId && envelope.ephemeralKey && envelope.nonce && envelope.tag ? envelope : null
}
