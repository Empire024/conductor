import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

/**
 * Web push, written out from the specs instead of pulled from npm.
 *
 * Conductor notifies the owner's phone through whatever push service its browser already trusts —
 * FCM for Chrome on Android, APNs for an installed iOS Safari app, Mozilla autopush for Firefox.
 * All three speak the same three documents: RFC 8030 for the POST, RFC 8291 (aes128gcm, RFC 8188)
 * for a body only that browser can decrypt, and RFC 8292 for the VAPID signature that says which
 * application server is asking. The payload is encrypted against keys only the subscribing browser
 * holds, so the push service relays bytes it cannot read — which is the whole reason a desktop can
 * route "your agent needs a decision" through Google or Apple without leaking the conversation.
 *
 * Doing it here rather than with the `web-push` package keeps a transitive dependency tree out of
 * the Electron main process for roughly two hundred lines of node:crypto, and the RFC ships a test
 * vector that pins the encryption byte for byte (see web-push.test.ts).
 */

/** Both halves base64url without padding: the public key is the 65-byte uncompressed P-256 point
 *  a phone passes to pushManager.subscribe() as applicationServerKey, so rotating it silently
 *  invalidates every subscription already registered against it. */
export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/** The JSON shape `PushSubscription.toJSON()` produces in the browser, relayed to us as-is. */
export interface PushSubscriptionLike {
  endpoint: string
  expirationTime?: number | null
  keys: {
    /** Receiver's uncompressed P-256 public point, base64url. */
    p256dh: string
    /** 16-byte authentication secret, base64url. */
    auth: string
  }
}

/** RFC 8188 record size. One record carries any notification we would ever send, and a fixed rs
 *  keeps the header constant, so there is no reason to negotiate it. */
const RECORD_SIZE = 4096

/**
 * The arithmetic for aes128gcm alone would allow rs − 16 (GCM tag) − 1 (padding delimiter) = 4079
 * bytes. The limit every deployed push service and client library actually enforces is 4078, one
 * byte lower, inherited from the older aesgcm scheme whose records began with a two-byte padding
 * length. Refusing at 4078 fails here with a clear message instead of at a push service with a
 * 413 that names nothing.
 */
const MAX_PAYLOAD_BYTES = 4078

/** RFC 8291 §3.4 and RFC 8188 §2.2 info strings. The trailing NUL is part of each one. */
const KEY_INFO = Buffer.from('WebPush: info\0', 'utf8')
const CONTENT_ENCRYPTION_KEY_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8')
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8')

/** RFC 8292 §2 caps a VAPID token at 24 hours; half that leaves room for a slow clock on either
 *  end without ever handing a push service a token it will refuse as too long-lived. */
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60

const DEFAULT_TTL_SECONDS = 86400
const DEFAULT_TIMEOUT_MS = 15000

/**
 * Subscriptions arrive as base64url, but keys that pass through a config file or an older server
 * are often standard base64, padded or not. Buffer's decoder reads both alphabets and silently
 * drops everything else, so a typo would quietly become a short key; the shape check up front and
 * the length check at the call site turn that into an error naming the field.
 */
const decodeBase64 = (value: string | Buffer, label: string): Buffer => {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  const text = typeof value === 'string' ? value.trim().replace(/=+$/, '') : ''
  if (!text || !/^[A-Za-z0-9+/_-]+$/.test(text) || text.length % 4 === 1) throw new Error(`${label} is not base64`)
  return Buffer.from(text, 'base64')
}

const decodeFixed = (value: string | Buffer | undefined, label: string, size: number): Buffer => {
  if (value === undefined || value === null) throw new Error(`${label} is missing`)
  const raw = decodeBase64(value, label)
  if (raw.length !== size) throw new Error(`${label} must be ${size} bytes, got ${raw.length}`)
  return raw
}

/** 0x04 is the uncompressed-point tag; a compressed point would decode to 33 bytes and fail the
 *  length check first, but a 65-byte blob with any other tag is not a point at all. */
const decodePoint = (value: string | Buffer | undefined, label: string): Buffer => {
  const raw = decodeFixed(value, label, 65)
  if (raw[0] !== 0x04) throw new Error(`${label} must be an uncompressed P-256 point`)
  return raw
}

/** OpenSSL returns the scalar with leading zero bytes trimmed, so about one key in 256 comes back
 *  as 31 bytes (measured: 15 of 3000). A JWK `d` that is not exactly 32 bytes is rejected
 *  outright, so pad it back — and accept a stored key that is short for the same reason. */
const padScalar = (scalar: Buffer): Buffer =>
  scalar.length >= 32 ? scalar : Buffer.concat([Buffer.alloc(32 - scalar.length), scalar])

const decodeScalar = (value: string | Buffer | undefined, label: string): Buffer => {
  if (value === undefined || value === null) throw new Error(`${label} is missing`)
  const raw = decodeBase64(value, label)
  if (raw.length === 0 || raw.length > 32) throw new Error(`${label} must be a 32-byte P-256 scalar, got ${raw.length}`)
  return padScalar(raw)
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: padScalar(ecdh.getPrivateKey()).toString('base64url')
  }
}

/**
 * Shape and length, plus the one check that catches the failure seen in practice: a pair where
 * only one half survived a settings migration or a regeneration. Signing with a mismatched pair
 * fails at the push service with a bare 401 that explains nothing, so derive the point from the
 * scalar and compare instead.
 */
export function isValidVapidKeys(value: unknown): value is VapidKeys {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<VapidKeys>
  if (typeof candidate.publicKey !== 'string' || typeof candidate.privateKey !== 'string') return false
  try {
    const point = decodePoint(candidate.publicKey, 'VAPID public key')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(decodeScalar(candidate.privateKey, 'VAPID private key'))
    return ecdh.getPublicKey().equals(point)
  } catch {
    return false
  }
}

const encodeJwtPart = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

/**
 * The `Authorization: vapid t=<jwt>,k=<public key>` header of RFC 8292 §3. The audience must be
 * the push endpoint's origin and nothing more — a token whose `aud` carries the full endpoint path
 * is rejected by FCM, and one signed for a different service's origin is a token that service
 * could replay.
 */
export function vapidAuthorization(audience: string, subject: string, keys: VapidKeys, now: number = Date.now()): string {
  let origin: string
  try {
    origin = new URL(audience).origin
  } catch {
    throw new Error('VAPID audience must be an absolute URL')
  }
  if (!origin.startsWith('http')) throw new Error('VAPID audience must be an http(s) origin')
  // RFC 8292 §2.1: the subject has to be a way to reach whoever runs this application server, so
  // a push service can complain to a human before it starts blocking.
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(String(subject ?? ''))) {
    throw new Error('VAPID subject must be a mailto: address or an https:// URL')
  }
  const point = decodePoint(keys?.publicKey, 'VAPID public key')
  const scalar = decodeScalar(keys?.privateKey, 'VAPID private key')
  const privateKey = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: scalar.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url')
    },
    format: 'jwk'
  })
  const expiry = Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS
  const signingInput = `${encodeJwtPart({ typ: 'JWT', alg: 'ES256' })}.${encodeJwtPart({ aud: origin, exp: expiry, sub: subject })}`
  // ES256 is a raw r‖s pair. Node emits DER for ECDSA unless told otherwise, and a DER signature
  // here is another silent 401: it is a valid signature in the wrong envelope.
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${signingInput}.${signature.toString('base64url')},k=${point.toString('base64url')}`
}

/**
 * RFC 8291 encryption. The options exist so the RFC's Appendix A vector can be reproduced with its
 * fixed salt and ephemeral key; real sends leave both out and get fresh randomness, which they
 * must — reusing a salt with the same key pair repeats a GCM nonce and breaks the encryption.
 */
export function encryptWebPushPayload(
  subscription: Pick<PushSubscriptionLike, 'keys'>,
  payload: string | Buffer,
  options: { salt?: Buffer; localPrivateKey?: Buffer | string } = {}
): Buffer {
  const receiverPublic = decodePoint(subscription?.keys?.p256dh, 'Subscription p256dh key')
  const authSecret = decodeFixed(subscription?.keys?.auth, 'Subscription auth secret', 16)
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8')
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Web push payloads are limited to ${MAX_PAYLOAD_BYTES} bytes, got ${plaintext.length}`)
  }
  const salt = options.salt === undefined ? randomBytes(16) : decodeFixed(options.salt, 'Salt', 16)
  const ecdh = createECDH('prime256v1')
  if (options.localPrivateKey === undefined) ecdh.generateKeys()
  else ecdh.setPrivateKey(decodeFixed(options.localPrivateKey, 'Sender private key', 32))
  const senderPublic = ecdh.getPublicKey()

  // computeSecret returns the x coordinate alone, which is exactly the ECDH secret RFC 8291 feeds
  // to the first HKDF. The auth secret is the salt there: it is the part of the subscription the
  // push service never sees, so without it the derived key is not reachable from the wire.
  const ikm = hkdf(authSecret, ecdh.computeSecret(receiverPublic), Buffer.concat([KEY_INFO, receiverPublic, senderPublic]), 32)
  const contentKey = hkdf(salt, ikm, CONTENT_ENCRYPTION_KEY_INFO, 16)
  const nonce = hkdf(salt, ikm, NONCE_INFO, 12)

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  // 0x02 marks the last record; 0x01 would tell the browser more records follow and decryption
  // would fail. No padding beyond the delimiter — it would only hide a length the ciphertext size
  // already gives away.
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag()
  ])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(senderPublic.length, 20)
  return Buffer.concat([header, senderPublic, ciphertext])
}

export interface WebPushResult {
  status: number
  /** 404 or 410: the subscription is dead and must be dropped, not retried. */
  gone: boolean
  /** Retry-After seconds when the service asked to wait, else null. */
  retryAfter: number | null
  body: string
}

/** RFC 7231 allows delta-seconds or an HTTP date. Anything unparseable reads as "no advice given"
 *  rather than a guess, so the caller falls back to its own backoff. */
const parseRetryAfter = (value: string | null | undefined, now: number): number | null => {
  const text = (value ?? '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  const when = Date.parse(text)
  return Number.isFinite(when) ? Math.max(0, Math.round((when - now) / 1000)) : null
}

const assertEndpoint = (endpoint: unknown): string => {
  const text = typeof endpoint === 'string' ? endpoint.trim() : ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('Push subscription endpoint is not a URL')
  }
  // The endpoint is a bearer capability: anyone holding it can push to that browser. http would
  // hand it to the network, so refuse rather than downgrade.
  if (url.protocol !== 'https:') throw new Error('Push subscription endpoints must be https')
  return text
}

/**
 * POSTs one encrypted notification. A non-2xx status is an answer, not a fault — `gone` and
 * `retryAfter` are the two the caller has to act on — so only a network failure, a timeout, or
 * input we refuse to send throws.
 */
export async function sendWebPush(
  subscription: PushSubscriptionLike,
  payload: string | Buffer,
  options: {
    keys: VapidKeys
    subject: string
    ttl?: number
    urgency?: 'very-low' | 'low' | 'normal' | 'high'
    topic?: string
    fetch?: typeof fetch
    timeoutMs?: number
  }
): Promise<WebPushResult> {
  const endpoint = assertEndpoint(subscription?.endpoint)
  const ttl = options.ttl ?? DEFAULT_TTL_SECONDS
  if (!Number.isInteger(ttl) || ttl < 0) throw new Error('Web push TTL must be a non-negative whole number of seconds')
  const urgency = options.urgency ?? 'normal'
  if (!['very-low', 'low', 'normal', 'high'].includes(urgency)) throw new Error(`Unknown web push urgency: ${urgency}`)
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthorization(new URL(endpoint).origin, options.subject, options.keys)
  }
  if (options.topic !== undefined) {
    // RFC 8030 §5.4: at most 32 characters from the URL-safe base64 alphabet, because the service
    // puts it in a header and compares it as an opaque string when collapsing older messages.
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.topic)) {
      throw new Error('Web push topic must be 1-32 URL-safe base64 characters')
    }
    headers.Topic = options.topic
  }
  const body = encryptWebPushPayload(subscription, payload)
  const send = options.fetch ?? globalThis.fetch
  if (typeof send !== 'function') throw new Error('No fetch implementation is available to send web push')

  const response = await send(endpoint, {
    method: 'POST',
    headers,
    // A Buffer is a perfectly good BodyInit at runtime; the cast is only because this project
    // compiles with the DOM lib, whose BufferSource is pinned to ArrayBuffer-backed views while a
    // Node Buffer is typed over ArrayBufferLike.
    body: body as unknown as BodyInit,
    // A push service that accepts the connection and then stalls would otherwise hold a
    // notification open for as long as the OS lets it.
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })
  // The error text is the only diagnostic these services give, and a body that cannot be read is
  // never worth turning a delivered-or-not answer into a thrown error.
  const text = await response.text().catch(() => '')
  return {
    status: response.status,
    gone: response.status === 404 || response.status === 410,
    retryAfter: parseRetryAfter(response.headers?.get('retry-after'), Date.now()),
    body: text
  }
}
