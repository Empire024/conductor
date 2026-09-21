import { describe, expect, it } from 'vitest'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import {
  encryptWebPushPayload,
  generateVapidKeys,
  isValidVapidKeys,
  sendWebPush,
  vapidAuthorization,
  type PushSubscriptionLike,
  type VapidKeys
} from './web-push'

const decode = (value: string): Buffer => Buffer.from(value, 'base64url')

/** RFC 8291 Appendix A, verbatim. Every value here is base64url. */
const vector = {
  plaintext: 'When I grow up, I want to be a watermelon',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  sharedSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  contentKey: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6Tlz' +
    'AC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

/**
 * The browser's half of RFC 8291, written out here rather than imported: a round trip through an
 * independent implementation is what proves the sender is interoperable, and a shared helper would
 * only prove that the module agrees with itself.
 */
const decryptWebPushBody = (body: Buffer, receiverPrivateKey: Buffer, authSecret: Buffer): Buffer => {
  const salt = body.subarray(0, 16)
  const recordSize = body.readUInt32BE(16)
  const senderPublic = body.subarray(21, 21 + body[20]!)
  const ciphertext = body.subarray(21 + body[20]!)
  if (recordSize !== 4096) throw new Error(`unexpected record size ${recordSize}`)
  const receiver = createECDH('prime256v1')
  receiver.setPrivateKey(receiverPrivateKey)
  const shared = receiver.computeSecret(senderPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), receiver.getPublicKey(), senderPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, info, 32))
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  let end = record.length
  while (end > 0 && record[end - 1] === 0) end -= 1
  if (record[end - 1] !== 0x02) throw new Error('record is not marked as the last one')
  return record.subarray(0, end - 1)
}

/** A subscription backed by a key pair the test holds, so it can decrypt what the module sends. */
const freshSubscription = (endpoint = 'https://push.example.net/send/abc123'): {
  subscription: PushSubscriptionLike
  privateKey: Buffer
  authSecret: Buffer
} => {
  const receiver = createECDH('prime256v1')
  receiver.generateKeys()
  const authSecret = randomBytes(16)
  return {
    subscription: {
      endpoint,
      expirationTime: null,
      keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') }
    },
    privateKey: receiver.getPrivateKey(),
    authSecret
  }
}

describe('RFC 8291 payload encryption', () => {
  it('derives the shared secret, IKM, content key and nonce the RFC prints', () => {
    const receiver = createECDH('prime256v1')
    receiver.setPrivateKey(decode(vector.receiverPrivate))
    expect(receiver.getPublicKey().toString('base64url')).toBe(vector.receiverPublic)
    const shared = receiver.computeSecret(decode(vector.senderPublic))
    expect(shared.toString('base64url')).toBe(vector.sharedSecret)
    const info = Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      decode(vector.receiverPublic),
      decode(vector.senderPublic)
    ])
    const ikm = Buffer.from(hkdfSync('sha256', shared, decode(vector.authSecret), info, 32))
    expect(ikm.toString('base64url')).toBe(vector.ikm)
    const salt = decode(vector.salt)
    const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))
    expect(key.toString('base64url')).toBe(vector.contentKey)
    expect(nonce.toString('base64url')).toBe(vector.nonce)
  })

  it('reproduces the Appendix A body byte for byte', () => {
    const body = encryptWebPushPayload(
      { keys: { p256dh: vector.receiverPublic, auth: vector.authSecret } },
      vector.plaintext,
      { salt: decode(vector.salt), localPrivateKey: vector.senderPrivate }
    )
    expect(body.toString('base64url')).toBe(vector.body)
    // Spelled out so a header regression names the field that moved rather than a base64 diff.
    expect(body.subarray(0, 16).toString('base64url')).toBe(vector.salt)
    expect(body.readUInt32BE(16)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(body.subarray(21, 86).toString('base64url')).toBe(vector.senderPublic)
  })

  it('round-trips through an independent decryption with fresh random keys', () => {
    const { subscription, privateKey, authSecret } = freshSubscription()
    const payload = JSON.stringify({ title: 'Agent needs a decision', tab: 'conductor/main' })
    const body = encryptWebPushPayload(subscription, payload)
    expect(decryptWebPushBody(body, privateKey, authSecret).toString('utf8')).toBe(payload)
    // A fresh salt and ephemeral key per send, or the same key and nonce would encrypt twice.
    const again = encryptWebPushPayload(subscription, payload)
    expect(again.subarray(0, 86).equals(body.subarray(0, 86))).toBe(false)
    expect(decryptWebPushBody(again, privateKey, authSecret).toString('utf8')).toBe(payload)
  })

  it('accepts a Buffer payload and the largest payload the ecosystem allows', () => {
    const { subscription, privateKey, authSecret } = freshSubscription()
    const largest = Buffer.alloc(4078, 0x61)
    expect(decryptWebPushBody(encryptWebPushPayload(subscription, largest), privateKey, authSecret).equals(largest)).toBe(true)
    expect(() => encryptWebPushPayload(subscription, Buffer.alloc(4079, 0x61))).toThrow(/4078 bytes/)
  })

  it('names the malformed field instead of sending an unreadable body', () => {
    const { subscription } = freshSubscription()
    const keys = subscription.keys
    expect(() => encryptWebPushPayload({ keys: { ...keys, p256dh: '' } }, 'x')).toThrow(/p256dh/)
    expect(() => encryptWebPushPayload({ keys: { ...keys, p256dh: 'not base64!!' } }, 'x')).toThrow(/p256dh/)
    expect(() => encryptWebPushPayload({ keys: { ...keys, p256dh: randomBytes(64).toString('base64url') } }, 'x')).toThrow(/65 bytes/)
    expect(() => encryptWebPushPayload({ keys: { ...keys, p256dh: Buffer.concat([Buffer.from([0x03]), randomBytes(64)]).toString('base64url') } }, 'x'))
      .toThrow(/uncompressed/)
    expect(() => encryptWebPushPayload({ keys: { ...keys, auth: randomBytes(8).toString('base64url') } }, 'x')).toThrow(/16 bytes/)
    expect(() => encryptWebPushPayload({ keys: { ...keys, auth: undefined as unknown as string } }, 'x')).toThrow(/auth secret is missing/)
  })

  it('reads standard base64 subscription keys as well as base64url', () => {
    const { subscription, privateKey, authSecret } = freshSubscription()
    const standard = {
      p256dh: Buffer.from(subscription.keys.p256dh, 'base64url').toString('base64'),
      auth: Buffer.from(subscription.keys.auth, 'base64url').toString('base64')
    }
    // A '+' or '/' in a re-encoded key is the classic way a subscription copied through a config
    // file stops matching, so both alphabets have to decode to the same point.
    expect(standard.p256dh.endsWith('=')).toBe(true)
    const body = encryptWebPushPayload({ keys: standard }, 'hello phone')
    expect(decryptWebPushBody(body, privateKey, authSecret).toString('utf8')).toBe('hello phone')
  })
})

describe('VAPID keys and authorization', () => {
  const keys = generateVapidKeys()

  it('generates a usable P-256 pair in unpadded base64url', () => {
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decode(keys.publicKey)).toHaveLength(65)
    expect(decode(keys.publicKey)[0]).toBe(0x04)
    expect(decode(keys.privateKey)).toHaveLength(32)
    expect(isValidVapidKeys(keys)).toBe(true)
  })

  it('rejects anything that is not a matched pair', () => {
    expect(isValidVapidKeys(undefined)).toBe(false)
    expect(isValidVapidKeys({ publicKey: keys.publicKey })).toBe(false)
    expect(isValidVapidKeys({ publicKey: keys.publicKey, privateKey: 42 })).toBe(false)
    expect(isValidVapidKeys({ publicKey: keys.publicKey, privateKey: keys.privateKey.slice(0, 20) })).toBe(false)
    expect(isValidVapidKeys({ publicKey: keys.publicKey, privateKey: generateVapidKeys().privateKey })).toBe(false)
    expect(isValidVapidKeys({ publicKey: generateVapidKeys().publicKey, privateKey: keys.privateKey })).toBe(false)
  })

  it('accepts a private key whose leading zero byte was trimmed on the way to storage', () => {
    // A P-256 scalar starting with 0x00 is an ordinary key, and OpenSSL hands it back a byte
    // short, so roughly one pair in 256 is stored that way by some other tool. Reading it has to
    // produce the same key rather than a JWK error at the first notification.
    const scalar = Buffer.from('00c2f1a4b90d3e5678aa1b2c3d4e5f60718293a4b5c6d7e8f9012345678abcde', 'hex')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(scalar)
    const pair: VapidKeys = {
      publicKey: ecdh.getPublicKey().toString('base64url'),
      privateKey: scalar.subarray(1).toString('base64url')
    }
    expect(decode(pair.privateKey)).toHaveLength(31)
    expect(isValidVapidKeys(pair)).toBe(true)
    expect(vapidAuthorization('https://push.example.net/x', 'mailto:owner@example.com', pair)).toContain(`,k=${pair.publicKey}`)
    expect(isValidVapidKeys({ ...pair, privateKey: randomBytes(33).toString('base64url') })).toBe(false)
  })

  it('signs a token the push service can verify with the key the header advertises', () => {
    const now = Date.UTC(2026, 2, 1, 12, 0, 0)
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/xyz', 'mailto:owner@example.com', keys, now)
    const parsed = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+),k=([\w-]+)$/.exec(header)
    expect(parsed).not.toBeNull()
    const [, token, advertisedKey] = parsed as RegExpExecArray
    expect(advertisedKey).toBe(keys.publicKey)

    const [headerPart, claimsPart, signaturePart] = token!.split('.') as [string, string, string]
    expect(JSON.parse(decode(headerPart).toString('utf8'))).toEqual({ typ: 'JWT', alg: 'ES256' })
    const claims = JSON.parse(decode(claimsPart).toString('utf8'))
    // The audience is the origin alone: FCM rejects a token whose aud carries the endpoint path.
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe('mailto:owner@example.com')
    expect(claims.exp).toBe(Math.floor(now / 1000) + 12 * 60 * 60)
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(now / 1000) + 24 * 60 * 60)

    const point = decode(advertisedKey!)
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url')
      },
      format: 'jwk'
    })
    const signature = decode(signaturePart)
    // 64 raw bytes, not DER: a DER signature verifies locally and still gets a bare 401 from FCM.
    expect(signature).toHaveLength(64)
    expect(verify('sha256', Buffer.from(`${headerPart}.${claimsPart}`, 'utf8'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
    expect(verify('sha256', Buffer.from(`${headerPart}.${claimsPart}x`, 'utf8'), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(false)
  })

  it('accepts an https subject and refuses an audience or subject a service would reject', () => {
    expect(vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/g', 'https://conductor.local/contact', keys))
      .toMatch(/^vapid t=/)
    expect(() => vapidAuthorization('not a url', 'mailto:owner@example.com', keys)).toThrow(/audience/)
    expect(() => vapidAuthorization('data:text/plain,hi', 'mailto:owner@example.com', keys)).toThrow(/audience/)
    expect(() => vapidAuthorization('https://push.example.net/x', 'owner@example.com', keys)).toThrow(/subject/)
    expect(() => vapidAuthorization('https://push.example.net/x', 'http://conductor.local', keys)).toThrow(/subject/)
    expect(() => vapidAuthorization('https://push.example.net/x', 'mailto:owner@example.com', { publicKey: 'nope', privateKey: keys.privateKey }))
      .toThrow(/public key/)
  })
})

describe('sendWebPush', () => {
  const keys = generateVapidKeys()
  const calls: { url: string; init: RequestInit }[] = []
  const fetchReturning = (make: () => Response | Promise<Response>): typeof fetch =>
    (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return make()
    }) as unknown as typeof fetch

  const headersOf = (index = calls.length - 1): Record<string, string> => calls[index]!.init.headers as Record<string, string>

  it('posts an aes128gcm body the subscribing browser can decrypt', async () => {
    const { subscription, privateKey, authSecret } = freshSubscription('https://fcm.googleapis.com/fcm/send/abc?x=1')
    const result = await sendWebPush(subscription, 'ready for review', {
      keys,
      subject: 'mailto:owner@example.com',
      fetch: fetchReturning(() => new Response(null, { status: 201 }))
    })
    expect(result).toEqual({ status: 201, gone: false, retryAfter: null, body: '' })
    const call = calls[calls.length - 1]!
    expect(call.url).toBe(subscription.endpoint)
    expect(call.init.method).toBe('POST')
    expect(headersOf()).toMatchObject({
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: '86400',
      Urgency: 'normal'
    })
    expect(headersOf().Topic).toBeUndefined()
    expect(headersOf().Authorization).toMatch(new RegExp(`,k=${keys.publicKey}$`))
    const body = Buffer.from(call.init.body as Uint8Array)
    expect(decryptWebPushBody(body, privateKey, authSecret).toString('utf8')).toBe('ready for review')
  })

  it('sends the TTL, urgency and topic the caller chose', async () => {
    const { subscription } = freshSubscription()
    await sendWebPush(subscription, 'x', {
      keys,
      subject: 'mailto:owner@example.com',
      ttl: 60,
      urgency: 'high',
      topic: 'session-42',
      fetch: fetchReturning(() => new Response('', { status: 200 }))
    })
    expect(headersOf()).toMatchObject({ TTL: '60', Urgency: 'high', Topic: 'session-42' })
  })

  it('reports a dropped subscription instead of throwing', async () => {
    const { subscription } = freshSubscription()
    const send = (status: number): Promise<{ status: number; gone: boolean }> =>
      sendWebPush(subscription, 'x', {
        keys,
        subject: 'mailto:owner@example.com',
        fetch: fetchReturning(() => new Response('push subscription has unsubscribed or expired', { status }))
      })
    expect(await send(410)).toMatchObject({ status: 410, gone: true, body: 'push subscription has unsubscribed or expired' })
    expect(await send(404)).toMatchObject({ status: 404, gone: true })
    expect(await send(400)).toMatchObject({ status: 400, gone: false })
  })

  it('passes a Retry-After back to the caller in seconds', async () => {
    const { subscription } = freshSubscription()
    const throttled = await sendWebPush(subscription, 'x', {
      keys,
      subject: 'mailto:owner@example.com',
      fetch: fetchReturning(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }))
    })
    expect(throttled).toMatchObject({ status: 429, gone: false, retryAfter: 30, body: 'slow down' })

    const dated = await sendWebPush(subscription, 'x', {
      keys,
      subject: 'mailto:owner@example.com',
      fetch: fetchReturning(() => new Response('', {
        status: 503,
        headers: { 'Retry-After': new Date(Date.now() + 120_000).toUTCString() }
      }))
    })
    expect(dated.retryAfter).toBeGreaterThan(100)
    expect(dated.retryAfter).toBeLessThanOrEqual(120)

    const noAdvice = await sendWebPush(subscription, 'x', {
      keys,
      subject: 'mailto:owner@example.com',
      fetch: fetchReturning(() => new Response('', { status: 500, headers: { 'Retry-After': 'soon' } }))
    })
    expect(noAdvice.retryAfter).toBeNull()
  })

  it('lets a network failure propagate, because nothing was delivered', async () => {
    const { subscription } = freshSubscription()
    await expect(sendWebPush(subscription, 'x', {
      keys,
      subject: 'mailto:owner@example.com',
      fetch: (() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch
    })).rejects.toThrow('socket hang up')
  })

  it('refuses input it would be wrong to send, before contacting anything', async () => {
    const { subscription } = freshSubscription()
    const never = (() => Promise.reject(new Error('must not be called'))) as unknown as typeof fetch
    const options = { keys, subject: 'mailto:owner@example.com', fetch: never }
    await expect(sendWebPush({ ...subscription, endpoint: 'http://push.example.net/x' }, 'x', options)).rejects.toThrow(/https/)
    await expect(sendWebPush({ ...subscription, endpoint: 'push.example.net/x' }, 'x', options)).rejects.toThrow(/not a URL/)
    await expect(sendWebPush({ ...subscription, keys: { p256dh: '', auth: '' } }, 'x', options)).rejects.toThrow(/p256dh/)
    await expect(sendWebPush(subscription, 'x', { ...options, topic: 'has spaces' })).rejects.toThrow(/topic/)
    await expect(sendWebPush(subscription, 'x', { ...options, topic: 'a'.repeat(33) })).rejects.toThrow(/topic/)
    await expect(sendWebPush(subscription, 'x', { ...options, ttl: -1 })).rejects.toThrow(/TTL/)
    await expect(sendWebPush(subscription, 'x', { ...options, ttl: 1.5 })).rejects.toThrow(/TTL/)
    await expect(sendWebPush(subscription, 'x', { ...options, subject: 'nobody' })).rejects.toThrow(/subject/)
  })
})
