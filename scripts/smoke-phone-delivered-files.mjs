import { _electron as electron, chromium, expect, webkit } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// Delivered files on the phone (owner, 2026-10-21: "File should be preview able and downloadable"):
// a Claude conversation (the synthetic fake-claude provider, no inference) delivers a PNG and a PDF
// whose name has spaces. The served phone app, headless in WebKit and Chromium at a phone viewport,
// shows them as Delivered chips; a tap opens the file sheet, which previews the image in place,
// opens the PDF in a browser tab as application/pdf with its name, and downloads by name. The
// computer serves only files that conversation linked, inside its project. The Electron window is
// parked off-screen (CONDUCTOR_TEST_USER_DATA). Run under scripts/smoke-lock.mjs;
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-delivered-'))
const output = resolve('.conductor-scratch/phone-delivered-files')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const playwright = { chromium, webkit }
const installedBuild = engine => {
  if (existsSync(playwright[engine].executablePath())) return {}
  const folder = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const builds = existsSync(folder) ? readdirSync(folder).filter(name => new RegExp('^' + engine + '-\\d+$').test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : []
  const executable = builds.map(name => join(folder, name, engine === 'webkit' ? 'Playwright.exe' : 'chrome-win/chrome.exe')).find(path => existsSync(path))
  if (!executable) throw new Error(`No ${engine} build is installed for Playwright; run npx playwright install ${engine}.`)
  console.log(`Using the installed ${engine} at ${executable}`)
  return { executablePath: executable }
}
const errors = [], checks = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const busy = ['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting']

const png = (width, height) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; const red = x > y; rows[at] = red ? 220 : 30; rows[at + 1] = 40; rows[at + 2] = red ? 30 : 220 }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

const call = (origin, path, { method, token, body, ca, headers } = {}) => new Promise((done, fail) => {
  method ??= body === undefined ? 'GET' : 'POST'
  const url = new URL(path, origin)
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const req = httpsRequest({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, ca, rejectUnauthorized: true, headers: { host: url.host, ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const raw = Buffer.concat(chunks), text = raw.toString('utf8'); let json; try { json = JSON.parse(text) } catch { json = undefined } done({ status: response.statusCode, headers: response.headers, raw, text, json }) })
  })
  req.once('error', fail)
  req.end(payload)
})

let sessionId
const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone && window.conductor?.structured))
  const project = await page.evaluate(() => window.conductor.projects.create('haf-stuff'))
  const out = join(project.path, 'output', 'owner picks')
  await mkdir(out, { recursive: true })
  const pngPath = join(out, 'HAF scale sheet.png')
  const pdfPath = join(out, 'HAF scale log.pdf')
  await writeFile(pngPath, png(900, 600))
  await writeFile(pdfPath, PDF)
  await writeFile(join(project.path, '.env'), 'SECRET=1')

  // ---- a conversation delivers both files ------------------------------------------------------
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  await launcherTile(page, 'Claude').click()
  const pane = page.locator('.structured-agent-pane:visible').last()
  const composer = pane.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  for (const path of [pngPath, pdfPath]) {
    await expect(composer).toBeEnabled()
    await composer.fill('SYNTHETIC DELIVERED ' + path.replaceAll('\\', '/'))
    await pane.getByRole('button', { name: 'Send message', exact: true }).click()
    sessionId = await pane.getAttribute('data-structured-session')
    await expect.poll(async () => (await snapshot())?.phase, { timeout: 30000 }).toBe('completed')
  }
  check('A Claude conversation (synthetic provider) delivered a PNG and a PDF named with spaces')

  // ---- the computer serves exactly those files, for that conversation ---------------------------
  const desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const ca = await new Promise((done, fail) => {
    const url = new URL('/ca.crt', origin)
    httpsRequest({ host: url.hostname, port: url.port, path: '/ca.crt', rejectUnauthorized: false, headers: { host: url.host } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => done(Buffer.concat(chunks).toString('utf8'))) }).once('error', fail).end()
  })
  const pairing = await page.evaluate(() => window.conductor.phone.pair())
  const paired = await call(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Delivered phone' } })
  assert.equal(paired.status, 200, paired.text)
  const token = paired.json.token
  const fileApi = '/api/sessions/' + encodeURIComponent(sessionId) + '/file'
  assert.equal((await call(origin, fileApi, { ca, body: { path: pdfPath } })).status, 401)
  const pdfFile = await call(origin, fileApi, { ca, token, body: { path: pdfPath } })
  assert.equal(pdfFile.status, 200, pdfFile.text)
  assert.equal(pdfFile.json.preview, 'pdf')
  const pdfBytes = await call(origin, pdfFile.json.url, { ca })
  assert.equal(pdfBytes.headers['content-type'], 'application/pdf')
  assert.equal(pdfBytes.headers['content-disposition'], `inline; filename="HAF scale log.pdf"; filename*=UTF-8''HAF%20scale%20log.pdf`)
  assert.equal(pdfBytes.text, PDF)
  for (const path of [join(project.path, '.env'), join(project.path, 'output', 'other.pdf'), join(root, 'profile', 'conductor.db')]) {
    const refused = await call(origin, fileApi, { ca, token, body: { path } })
    assert.ok(refused.status >= 400, path + ' is refused: ' + refused.status)
    assert.ok(!refused.text.includes('SECRET'), path + ' leaks nothing')
  }
  check('The phone API hands over the delivered PDF inline with its name and refuses files the conversation never linked, hidden files and paths outside the project')

  // ---- the phone app: chips, sheet, preview, open, download --------------------------------------
  for (const engine of ['webkit', 'chromium']) {
    const browser = await playwright[engine].launch({ headless: true, ...installedBuild(engine) })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: engine === 'chromium', serviceWorkers: 'block', acceptDownloads: true })
      await context.addInitScript(value => { window.localStorage.setItem('conductor.phone.token', value) }, token)
      const phone = await context.newPage()
      const problems = []
      phone.on('pageerror', error => problems.push(error.message))
      phone.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push(message.text()) })
      await phone.goto(origin + '/#/session/' + encodeURIComponent(sessionId))
      const chips = phone.locator('button.delivered-file')
      await expect(chips).toHaveCount(2, { timeout: 20000 })
      await expect(chips.nth(0)).toHaveText('HAF scale sheet.png')
      await expect(chips.nth(1)).toHaveText('HAF scale log.pdf')

      // The image: previewed in the sheet, opened full size, downloaded by name.
      await chips.nth(0).click()
      const sheet = phone.locator('.file-sheet')
      await expect(sheet).toBeVisible()
      const image = sheet.locator('img.file-sheet-image')
      await expect(image).toHaveCount(1)
      await phone.waitForFunction(() => { const node = document.querySelector('img.file-sheet-image'); return Boolean(node && node.complete && node.naturalWidth === 900) })
      await expect(sheet.getByRole('link', { name: 'Open full size' })).toBeVisible()
      await phone.screenshot({ path: join(output, engine + '-image-sheet.png') })
      if (engine === 'chromium') {
        const [download] = await Promise.all([phone.waitForEvent('download'), sheet.getByRole('link', { name: 'Download' }).click()])
        assert.equal(download.suggestedFilename(), 'HAF scale sheet.png')
        assert.equal((await download.failure()) ?? null, null)
      }
      await sheet.getByRole('button', { name: 'Close' }).click()
      await expect(sheet).toHaveCount(0)

      // The PDF: no inline image, Open PDF opens a browser tab served as a PDF with its name.
      await chips.nth(1).click()
      await expect(sheet.locator('.file-sheet-note')).toContainText('PDF')
      await expect(sheet.locator('img.file-sheet-image')).toHaveCount(0)
      const open = sheet.getByRole('link', { name: 'Open PDF' })
      await expect(open).toHaveAttribute('target', '_blank')
      const href = await open.getAttribute('href')
      const served = await phone.evaluate(async url => { const response = await fetch(url); return { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), text: await response.text() } }, href)
      assert.deepEqual(served, { status: 200, type: 'application/pdf', disposition: `inline; filename="HAF scale log.pdf"; filename*=UTF-8''HAF%20scale%20log.pdf`, text: PDF })
      await phone.screenshot({ path: join(output, engine + '-pdf-sheet.png') })
      if (engine === 'chromium') {
        const [download] = await Promise.all([phone.waitForEvent('download'), sheet.getByRole('link', { name: 'Download' }).click()])
        assert.equal(download.suggestedFilename(), 'HAF scale log.pdf')
      }
      assert.deepEqual(problems, [], engine + ' page errors')
    } finally { await browser.close() }
    check(`The phone app in ${engine === 'webkit' ? 'WebKit (Safari engine)' : 'Chromium (mobile)'} shows both Delivered chips; a tap opens the file sheet, which previews the PNG in place with Open full size, and offers Open PDF (a new tab served as application/pdf with its name)${engine === 'chromium' ? '; Download saves each file under its own name' : ''}`)
  }

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} finally {
  if (sessionId) {
    const phase = (await snapshot().catch(() => null))?.phase
    if (busy.includes(phase)) await page.evaluate(id => window.conductor.structured.interrupt(id, false), sessionId).catch(() => {})
  }
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
