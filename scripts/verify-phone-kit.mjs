// Phone-side helpers for verify smokes (next to scripts/verify-kit.mjs): what a paired phone does
// over the real HTTPS listener, and a push service that decrypts what a phone would be shown.
//   const phone = phoneClient(origin); await phone.req('/api/state', { token, unlock })
//   const push = await pushService(certDir); push.subscription(name) -> body for /api/push/subscribe
// The push service needs a certificate the app trusts: launch it with NODE_EXTRA_CA_CERTS pointing at
// <certDir>/push-cert.pem (a self-signed P-256 cert for 127.0.0.1 with its push-key.pem).
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpsRequest } from 'node:https'
import { join } from 'node:path'

/** RFC 8291 aes128gcm: the plaintext JSON a subscriber with `sub` (ECDH keys, auth secret) reads. */
export function decryptPush(sub, body) {
  const salt = body.subarray(0, 16), idlen = body[20], keyid = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen)
  const secret = sub.ecdh.computeSecret(keyid)
  const ikm = Buffer.from(hkdfSync('sha256', secret, sub.auth, Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), keyid]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  return JSON.parse(plain.subarray(0, end).toString('utf8')) // drops the 0x02 delimiter and padding
}

/** A local push service on 127.0.0.1: every POST is decrypted for its subscriber and kept in `pushes`
 *  as {at, phone, payload, error}; it answers 201 like a real one. */
export async function pushService(certDir) {
  const subs = new Map(), pushes = []
  const server = createServer({ key: readFileSync(join(certDir, 'push-key.pem')), cert: readFileSync(join(certDir, 'push-cert.pem')) }, (request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const name = decodeURIComponent(request.url.split('/').pop())
      let payload = null, error = null
      try { payload = decryptPush(subs.get(name), Buffer.concat(chunks)) } catch (e) { error = String(e.message ?? e) }
      pushes.push({ at: Date.now(), phone: name, payload, error })
      response.writeHead(201); response.end()
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  return {
    pushes, port,
    /** A fresh subscriber `name`; returns the subscription a phone posts to /api/push/subscribe. */
    subscription(name) {
      const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
      const sub = { name, ecdh, auth: randomBytes(16) }
      subs.set(name, sub)
      return { endpoint: `https://127.0.0.1:${port}/push/${encodeURIComponent(name)}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: sub.auth.toString('base64url') } }
    },
    close: () => new Promise(done => server.close(() => done()))
  }
}

/** A phone's HTTPS client for the listener at `origin` (its own CA is not checked, as the fixers' smokes do). */
export function phoneClient(origin) {
  const url = new URL(origin)
  const req = (path, { method = 'GET', token, unlock, body, headers = {}, timeoutMs = 20_000 } = {}) => new Promise((done, fail) => {
    const payload = body === undefined ? (method === 'POST' ? '' : undefined) : JSON.stringify(body)
    const request = httpsRequest({ host: url.hostname, port: url.port, path, method, rejectUnauthorized: false, headers: { host: url.host, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(unlock ? { 'x-conductor-unlock': unlock } : {}), ...(payload !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } done({ status: response.statusCode, text, json }) })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`${method} ${path} timed out`)))
    request.once('error', fail)
    request.end(payload)
  })
  /** An event stream as the phone holds it: {status, events: [{type, data}], ended, close()}. */
  const stream = (path, { token, unlock }) => {
    const held = { status: null, events: [], ended: false, endedAt: null, raw: '' }
    const request = httpsRequest({ host: url.hostname, port: url.port, path, method: 'GET', rejectUnauthorized: false, headers: { host: url.host, authorization: 'Bearer ' + token, ...(unlock ? { 'x-conductor-unlock': unlock } : {}) } }, response => {
      held.status = response.statusCode
      response.setEncoding('utf8')
      response.on('data', chunk => {
        held.raw += chunk
        let at
        while ((at = held.raw.indexOf('\n\n')) >= 0) {
          const block = held.raw.slice(0, at); held.raw = held.raw.slice(at + 2)
          const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1]
          if (type) { let parsed = data; try { parsed = JSON.parse(data) } catch { /* plain text */ } held.events.push({ type, data: parsed }) }
        }
      })
      const ended = () => { held.ended = true; held.endedAt ??= Date.now() }
      response.on('end', ended); response.on('close', ended)
    })
    request.once('error', () => { held.ended = true; held.endedAt ??= Date.now() })
    request.end()
    held.close = () => request.destroy()
    return held
  }
  return { req, stream }
}

/** Pairs a phone through the desktop's pairing code (renderer `view`); returns its bearer token. */
export async function pairPhone(view, client, name) {
  const pairing = await view.evaluate(() => window.conductor.phone.pair())
  const answer = await client.req('/api/pair', { method: 'POST', body: { code: pairing.pairing.code, name } })
  if (answer.status !== 200 || !answer.json?.token) throw new Error(`pairing ${name}: ${answer.status} ${answer.text.slice(0, 200)}`)
  return answer.json.token
}
