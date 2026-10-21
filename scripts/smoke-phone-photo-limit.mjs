import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// Several large photos from the phone in one message (owner, haf-stuff, 2026-10-21: three iPhone
// photos sent from the phone were accepted, then refused with "Claude image attachments exceed the
// 4 MiB combined message limit"). Three photo-sized images are uploaded over the real HTTPS
// listener and saved by the real importer (each up to 2 MiB, ~2.7 MiB base64), then sent with one
// message to the synthetic Claude fixture. The adapter must fit them into the message with Electron's
// real nativeImage, and the fixture reports what arrived: three decodable JPEGs in a message under
// 4 MiB. No model inference happens. The window is parked off-screen (CONDUCTOR_TEST_USER_DATA).
// Run under scripts/smoke-lock.mjs; CONDUCTOR_SMOKE_MAIN points at another build's main entry.
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-photo-limit-'))
const output = resolve('.conductor-scratch/phone-photo-limit')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }

/** A decodable PNG of random pixels: compresses as badly as a detailed photo, so the importer stores
 *  it near its 2 MiB ceiling, which is what a real iPhone photo does. */
const noisyPng = (width, height) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = randomBytes((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 1 })), chunk('IEND', Buffer.alloc(0))])
}

const call = (origin, path, { method, token, body, raw, type, ca } = {}) => new Promise((done, fail) => {
  method ??= body === undefined && raw === undefined ? 'GET' : 'POST'
  const url = new URL(path, origin)
  const payload = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)))
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, ca, rejectUnauthorized: true, headers: { host: url.host, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(payload ? { 'content-type': type ?? 'application/json', 'content-length': payload.length } : {}) } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } done({ status: response.statusCode, headers: response.headers, text, json }) })
  })
  req.once('error', fail)
  req.end(payload)
})
const api = async (origin, path, options) => {
  const reply = await call(origin, path, options)
  assert.equal(reply.status, 200, `${path}: ${reply.text}`)
  return reply.json
}
const until = async (read, predicate, label, timeout = 30000) => {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(value).slice(0, 1200))
    await new Promise(done => setTimeout(done, 250))
  }
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  const project = await page.evaluate(() => window.conductor.projects.create('haf-stuff'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  await expect(launcherTile(page, 'Claude').first()).toBeVisible()
  const desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const ca = await new Promise((done, fail) => {
    const url = new URL('/ca.crt', origin)
    httpsRequest({ host: url.hostname, port: url.port, path: '/ca.crt', rejectUnauthorized: false, headers: { host: url.host } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => done(Buffer.concat(chunks).toString('utf8'))) }).once('error', fail).end()
  })
  const pairing = await page.evaluate(() => window.conductor.phone.pair())
  const { token } = await api(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Photo phone' } })
  const state = await api(origin, '/api/state', { ca, token })
  const phoneProject = state.projects.find(entry => entry.id === project.id)
  const claude = state.providers.find(entry => entry.id === 'claude')
  const opened = await api(origin, '/api/tabs/open', { ca, token, body: { projectId: project.id, workspaceId: phoneProject.workspaces[0].id, machineId: phoneProject.machineId, provider: 'claude', model: claude.models[0].id, title: 'Binder photos' } })
  await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }), conversation => conversation.canAttachImages === true, 'the conversation to accept images')

  // ---- three photo-sized uploads, as the phone sends them -----------------------------------
  const photos = []
  let stored = 0
  for (const name of ['IMG_0428.jpg', 'IMG_0429.jpg', 'IMG_0430.jpg']) {
    const image = await api(origin, '/api/sessions/' + opened.sessionId + '/images?name=' + name, { ca, token, raw: noisyPng(1800, 1350), type: 'image/png' })
    const size = (await stat(join(project.path, image.path))).size
    stored += Math.ceil(size / 3) * 4
    photos.push(image)
  }
  assert.ok(stored > 4 * 1024 * 1024, `the three stored photos must exceed the 4 MiB message budget once encoded (they are ${stored} bytes), or this smoke proves nothing`)
  check(`Three photo-sized images were uploaded from the phone and stored by the importer; together they are ${(stored / 1048576).toFixed(1)} MiB base64, past Claude's 4 MiB message budget`)

  // ---- one message carrying all three --------------------------------------------------------
  const sent = await call(origin, '/api/sessions/' + opened.sessionId + '/message', { ca, token, body: { text: 'SYNTHETIC PHOTOS make sure the binder fits the three holes', mode: 'auto', attachments: photos } })
  assert.equal(sent.status, 200, 'the phone send was refused: ' + sent.text)
  const done = await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }),
    conversation => conversation.items.some(item => item.data.type === 'error') || conversation.items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.startsWith('Synthetic photos received')),
    'the fixture to receive the photos')
  const failure = done.items.find(item => item.data.type === 'error')
  assert.equal(failure, undefined, 'the conversation reported an error: ' + JSON.stringify(failure?.data))
  const report = done.items.find(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.startsWith('Synthetic photos received')).data.text
  const match = /^Synthetic photos received: (\d+); types: ([^;]*); decodable: (yes|no); message bytes: (\d+)$/.exec(report)
  assert.ok(match, report)
  assert.equal(Number(match[1]), 3, report)
  assert.equal(match[3], 'yes', report)
  assert.ok(Number(match[4]) <= 4 * 1024 * 1024, report)
  const user = done.items.find(item => item.data.type === 'text' && item.data.role === 'user')
  assert.deepEqual(user.data.attachments.map(attachment => attachment.name), ['IMG_0428.jpg', 'IMG_0429.jpg', 'IMG_0430.jpg'])
  check(`The message with all three photos was delivered: the fixture received ${match[1]} decodable images (${match[2]}) in a ${(Number(match[4]) / 1048576).toFixed(2)} MiB message, with no error`)

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, report, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
