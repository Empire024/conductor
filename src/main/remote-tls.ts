import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'

/**
 * A self-signed P-256 certificate, minted here so enabling the server never asks the owner to
 * find openssl. It is not meant to chain to a public CA: the pairing ticket carries this
 * certificate's SHA-256 fingerprint and the controlling machine pins it, which is stronger than
 * name-based trust for a channel between two machines the same person owns.
 */
export interface RemoteTlsIdentity {
  certificatePem: string
  privateKeyPem: string
  /** Colon-separated uppercase hex, matching X509Certificate.fingerprint256. */
  fingerprint: string
  notAfter: string
}

const length = (size: number): Buffer => {
  if (size < 0x80) return Buffer.from([size])
  const bytes: number[] = []
  for (let value = size; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(body.length), body])
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const setOf = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))
const explicit = (index: number, body: Buffer): Buffer => tlv(0xa0 | index, body)
/** DER INTEGER, minimal two's-complement. Both halves matter for a random 16-byte serial: a
 *  leading 0x00 that is not needed for the sign is illegal padding and OpenSSL rejects the whole
 *  certificate, while a high bit with no 0x00 in front would read as negative. Getting only the
 *  second half right made roughly one server start in a few hundred fail to listen. */
export const derInteger = (value: Buffer): Buffer => {
  let start = 0
  while (start < value.length - 1 && value[start] === 0 && !(value[start + 1]! & 0x80)) start += 1
  const trimmed = value.subarray(start)
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}
const bitString = (value: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), value]))
const utf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'))
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))

const objectIdentifier = (dotted: string): Buffer => {
  const parts = dotted.split('.').map(Number)
  const bytes = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    const chunk: number[] = []
    for (let value = part; ; value = Math.floor(value / 128)) { chunk.unshift(value % 128); if (value < 128) break }
    for (let index = 0; index < chunk.length - 1; index++) chunk[index]! |= 0x80
    bytes.push(...chunk)
  }
  return tlv(0x06, Buffer.from(bytes))
}

const pad = (value: number): string => String(value).padStart(2, '0')
const utcTime = (date: Date): Buffer => tlv(0x17, Buffer.from(
  `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`,
  'ascii'))

const generalName = (host: string): Buffer => {
  const octets = host.split('.').map(Number)
  return octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? tlv(0x87, Buffer.from(octets))
    : tlv(0x82, Buffer.from(host, 'ascii'))
}

const extension = (id: string, critical: boolean, value: Buffer): Buffer =>
  sequence(objectIdentifier(id), ...(critical ? [boolean(true)] : []), tlv(0x04, value))

export function createRemoteTlsIdentity(commonName: string, hosts: string[], days = 397, now = new Date()): RemoteTlsIdentity {
  const names = [...new Set(['localhost', '127.0.0.1', ...hosts])].filter(host => host && host.length <= 253)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const algorithm = sequence(objectIdentifier('1.2.840.10045.4.3.2'))
  const name = sequence(setOf(sequence(objectIdentifier('2.5.4.3'), utf8String(commonName.slice(0, 64)))))
  const notAfter = new Date(now.getTime() + days * 86400000)
  const tbs = sequence(
    explicit(0, derInteger(Buffer.from([2]))),
    derInteger(randomBytes(16)),
    algorithm,
    name,
    sequence(utcTime(new Date(now.getTime() - 3600000)), utcTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(
      extension('2.5.29.19', true, sequence(boolean(true))),
      // digitalSignature | keyEncipherment | keyCertSign
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([2, 0xa4]))),
      // serverAuth, clientAuth
      extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'), objectIdentifier('1.3.6.1.5.5.7.3.2'))),
      extension('2.5.29.17', false, sequence(...names.map(generalName)))
    ))
  )
  const der = sequence(tbs, algorithm, bitString(sign('sha256', tbs, privateKey)))
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`
  return {
    certificatePem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: new X509Certificate(certificatePem).fingerprint256,
    notAfter: notAfter.toISOString()
  }
}

/** True while the certificate is still comfortably valid; otherwise the server mints a new one. */
export function tlsIdentityUsable(identity: Pick<RemoteTlsIdentity, 'certificatePem' | 'privateKeyPem' | 'notAfter'>, now = new Date()): boolean {
  if (!identity.certificatePem?.includes('BEGIN CERTIFICATE') || !identity.privateKeyPem?.includes('PRIVATE KEY')) return false
  const expiry = Date.parse(identity.notAfter)
  return Number.isFinite(expiry) && expiry - now.getTime() > 7 * 86400000
}
