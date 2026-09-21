import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto'

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

/* ------------------------------------------------------------------------- *
 * A two-tier identity for the phone listener.
 *
 * A pinned self-signed certificate is the right shape between two Conductors, which carry the
 * fingerprint across by hand. A phone browser cannot pin: it trusts a certificate authority the
 * owner installed on the phone, or nothing. Installing is a one-time chore with several taps, so
 * the thing installed has to outlive every reason the serving certificate changes - a new LAN
 * address, a Tailscale name, an expiry. Hence a long-lived CA that signs a short-lived server
 * certificate; the server certificate can be re-issued as often as needed and the phone never
 * has to be touched again. The CA key is used for nothing but that signature.
 * ------------------------------------------------------------------------- */

export interface CertificateAuthority {
  certificatePem: string
  privateKeyPem: string
  fingerprint: string
  notAfter: string
}

export interface IssuedCertificate extends RemoteTlsIdentity {
  /** The names and addresses baked into the certificate, so a change in them can be noticed. */
  hosts: string[]
}

const pem = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${(der.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`

const commonName = (value: string): Buffer => sequence(setOf(sequence(objectIdentifier('2.5.4.3'), utf8String(value.slice(0, 64)))))

/**
 * RFC 5280 key identifier, method 1: SHA-1 of the public key bits. A P-256 SPKI ends in the
 * 65-byte uncompressed point, which is exactly the BIT STRING content the method hashes.
 */
const keyIdentifier = (spki: Buffer): Buffer => createHash('sha1').update(spki.subarray(spki.length - 65)).digest()

/** Expands an IPv6 address to its 16 bytes; null when the text is not one. */
export function ipv6Bytes(value: string): Buffer | null {
  const address = value.split('%')[0]!.replace(/^\[|\]$/g, '')
  if (!address.includes(':') || !/^[0-9a-f:.]+$/i.test(address)) return null
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two more hextets.
  const tail = address.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  const text = tail ? address.slice(0, -tail[0].length) + ((Number(tail[1]) << 8) | Number(tail[2])).toString(16) + ':' + ((Number(tail[3]) << 8) | Number(tail[4])).toString(16) : address
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const words = part.split(':').map(word => (/^[0-9a-f]{1,4}$/i.test(word) ? parseInt(word, 16) : -1))
    return words.some(word => word < 0) ? null : words
  }
  const head = parse(halves[0]!), rest = halves.length === 2 ? parse(halves[1]!) : []
  if (!head || !rest) return null
  const missing = 8 - head.length - rest.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const words = [...head, ...new Array<number>(missing).fill(0), ...rest]
  const bytes = Buffer.alloc(16)
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2))
  return bytes
}

/** A SAN entry for whatever the host text is: IPv4, IPv6 or a DNS name. */
const anyGeneralName = (host: string): Buffer => {
  const v6 = ipv6Bytes(host)
  return v6 ? tlv(0x87, v6) : generalName(host)
}

interface CertificateShape {
  subject: string
  issuer: string
  subjectPublicKeyDer: Buffer
  signingKey: KeyObject
  issuerPublicKeyDer: Buffer
  notBefore: Date
  notAfter: Date
  extensions: Buffer[]
}

function buildCertificate(shape: CertificateShape): Buffer {
  const algorithm = sequence(objectIdentifier('1.2.840.10045.4.3.2'))
  const tbs = sequence(
    explicit(0, derInteger(Buffer.from([2]))),
    derInteger(randomBytes(16)),
    algorithm,
    commonName(shape.issuer),
    sequence(utcTime(shape.notBefore), utcTime(shape.notAfter)),
    commonName(shape.subject),
    shape.subjectPublicKeyDer,
    explicit(3, sequence(
      ...shape.extensions,
      extension('2.5.29.14', false, tlv(0x04, keyIdentifier(shape.subjectPublicKeyDer))),
      extension('2.5.29.35', false, sequence(tlv(0x80, keyIdentifier(shape.issuerPublicKeyDer))))
    ))
  )
  return sequence(tbs, algorithm, bitString(sign('sha256', tbs, shape.signingKey)))
}

/** Ten years by default: the phone installs this once and should not be asked again. */
export function createCertificateAuthority(name: string, days = 3652, now = new Date()): CertificateAuthority {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const notAfter = new Date(now.getTime() + days * 86400000)
  const der = buildCertificate({
    subject: name, issuer: name, subjectPublicKeyDer: spki, issuerPublicKeyDer: spki, signingKey: privateKey,
    notBefore: new Date(now.getTime() - 3600000), notAfter,
    extensions: [
      // A CA that may sign end-entity certificates only: pathLen 0 keeps a leaked leaf key from
      // minting anything below it, and Android's installer insists on the CA flag being here.
      extension('2.5.29.19', true, sequence(boolean(true), derInteger(Buffer.from([0])))),
      // keyCertSign | cRLSign
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([1, 0x06])))
    ]
  })
  const certificatePem = pem(der)
  return { certificatePem, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), fingerprint: new X509Certificate(certificatePem).fingerprint256, notAfter: notAfter.toISOString() }
}

/**
 * A server certificate the CA vouches for. 397 days is the longest validity Apple and Chrome
 * still accept for a leaf, and the listener re-issues well before that anyway - whenever the set
 * of addresses it answers on changes.
 */
export function issueServerCertificate(authority: Pick<CertificateAuthority, 'certificatePem' | 'privateKeyPem'>, name: string, hosts: string[], days = 397, now = new Date()): IssuedCertificate {
  const names = [...new Set(['localhost', '127.0.0.1', ...hosts.map(host => host.trim())])].filter(host => host && host.length <= 253)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const issuer = new X509Certificate(authority.certificatePem)
  const notAfter = new Date(now.getTime() + days * 86400000)
  const der = buildCertificate({
    subject: name, issuer: issuer.subject.replace(/^CN=/, ''),
    subjectPublicKeyDer: publicKey.export({ type: 'spki', format: 'der' }),
    issuerPublicKeyDer: issuer.publicKey.export({ type: 'spki', format: 'der' }),
    signingKey: createPrivateKey(authority.privateKeyPem),
    notBefore: new Date(now.getTime() - 3600000), notAfter,
    extensions: [
      extension('2.5.29.19', true, sequence()),
      // digitalSignature | keyEncipherment
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([5, 0xa0]))),
      // serverAuth, clientAuth
      extension('2.5.29.37', false, sequence(objectIdentifier('1.3.6.1.5.5.7.3.1'), objectIdentifier('1.3.6.1.5.5.7.3.2'))),
      extension('2.5.29.17', false, sequence(...names.map(anyGeneralName)))
    ]
  })
  const certificatePem = pem(der)
  return {
    certificatePem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: new X509Certificate(certificatePem).fingerprint256,
    notAfter: notAfter.toISOString(),
    hosts: names
  }
}
