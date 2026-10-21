import { _electron as electron, chromium, expect, webkit } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { launcherTile } from './lib/launcher-tile.mjs'

// Shared files of a conversation (owner, 2026-10-21: "if I tap the header of this chat I can see
// stuff like the files (like these pdfs) shared within these chats"): a Claude conversation (the
// synthetic fake-claude provider, no inference) delivers a PNG, a PDF whose name has spaces and a
// PDF that is deleted afterwards. The served phone app, headless in WebKit and Chromium at a phone
// viewport, opens the conversation; tapping its header opens the Files sheet, which lists the three
// newest first by type with the deleted one as no longer on disk, filters to PDFs, and opens the PDF
// and the image in the file sheet. GET /api/sessions/:id/files needs the phone's token and lists
// nothing the file capability refuses. On the laptop, the session bar's empty middle opens the
// Links & files rail. The Electron window is parked off-screen (CONDUCTOR_TEST_USER_DATA). Run
// under scripts/smoke-lock.mjs; CONDUCTOR_SMOKE_MAIN points at another build's main entry (default
// out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-shared-'))
const output = resolve('.conductor-scratch/phone-shared-files')
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
  const gonePath = join(project.path, 'output', 'first run.pdf')
  const secretPath = join(project.path, '.env')
  await writeFile(pngPath, png(900, 600))
  await writeFile(pdfPath, PDF)
  await writeFile(gonePath, PDF)
  await writeFile(secretPath, 'SECRET=1')

  // ---- a conversation delivers the files (and links .env, which no phone is ever sent) -----------
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'haf-stuff' }).click()
  await launcherTile(page, 'Claude').click()
  const pane = page.locator('.structured-agent-pane:visible').last()
  const composer = pane.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  for (const path of [secretPath, pngPath, pdfPath, gonePath]) {
    await expect(composer).toBeEnabled()
    await composer.fill('SYNTHETIC DELIVERED ' + path.replaceAll('\\', '/'))
    await pane.getByRole('button', { name: 'Send message', exact: true }).click()
    sessionId = await pane.getAttribute('data-structured-session')
    await expect.poll(async () => (await snapshot())?.phase, { timeout: 30000 }).toBe('completed')
  }
  await rm(gonePath)
  check('A Claude conversation (synthetic provider) delivered a PNG, a PDF named with spaces, a PDF since deleted, and linked .env')

  // ---- the laptop: the session bar's empty middle opens the Links & files rail -------------------
  const rail = pane.locator('aside.sa-links-rail')
  if (await rail.count()) await pane.getByRole('button', { name: 'Close links and files', exact: true }).click()
  await expect(rail).toHaveCount(0)
  await pane.locator('button.sa-header-links').click()
  await expect(rail).toBeVisible()
  await expect(rail).toContainText('HAF scale log.pdf')
  await page.screenshot({ path: join(output, 'laptop-rail.png') })
  check('On the laptop, clicking the empty middle of the conversation header opens the Links & files rail with the delivered files')

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
  const listApi = '/api/sessions/' + encodeURIComponent(sessionId) + '/files'
  assert.equal((await call(origin, listApi, { ca })).status, 401)
  const listed = await call(origin, listApi, { ca, token })
  assert.equal(listed.status, 200, listed.text)
  assert.deepEqual(listed.json.files.map(file => [file.name, file.kind, file.folder, file.missing]), [
    ['first run.pdf', 'pdf', 'output', true],
    ['HAF scale log.pdf', 'pdf', 'output/owner picks', false],
    ['HAF scale sheet.png', 'image', 'output/owner picks', false]
  ])
  for (const file of listed.json.files) {
    const served = await call(origin, fileApi, { ca, token, body: { path: file.path } })
    assert.equal(served.status, file.missing ? 404 : 200, file.name + ': ' + served.text)
  }
  assert.ok(!listed.text.includes('.env'), 'the list never names a file the capability refuses')
  check('GET /files needs the token and lists the PNG and PDF newest first, the deleted PDF as missing (404 from the capability), and never .env')

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
      await expect(phone.locator('button.delivered-file').filter({ hasText: 'HAF scale log.pdf' })).toHaveCount(1, { timeout: 20000 })

      // Tapping the conversation's header opens the Files sheet: newest first, labeled by type.
      const heading = phone.locator('.conversation-heading.opens-files')
      await expect(heading).toHaveAttribute('role', 'button')
      await heading.click()
      const files = phone.locator('.shared-files-sheet')
      await expect(files).toBeVisible()
      const rows = files.locator('button.shared-file')
      await expect(rows).toHaveCount(3)
      await expect(rows.locator('.shared-file-name')).toHaveText(['first run.pdf', 'HAF scale log.pdf', 'HAF scale sheet.png'])
      await expect(rows.locator('.shared-file-kind')).toHaveText(['PDF', 'PDF', 'Image'])
      await expect(rows.nth(0)).toBeDisabled()
      await expect(rows.nth(0)).toContainText('No longer on disk')
      await expect(rows.nth(1)).toContainText('output/owner picks')
      await expect(files.locator('.file-sheet-note')).toContainText('3 files')
      await phone.screenshot({ path: join(output, engine + '-files-sheet.png') })

      // The PDFs filter, then the PDF opens in the file sheet above the list.
      await files.getByRole('button', { name: 'PDFs 2' }).click()
      await expect(rows).toHaveCount(2)
      await rows.nth(1).click()
      const sheet = phone.locator('.file-sheet:not(.shared-files-sheet)')
      await expect(sheet).toBeVisible()
      await expect(sheet.locator('.file-sheet-note')).toContainText('PDF')
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
      await sheet.getByRole('button', { name: 'Close' }).click()
      await expect(sheet).toHaveCount(0)
      await expect(files).toBeVisible()

      // Back to all files; the image previews in place.
      await files.getByRole('button', { name: 'All 3' }).click()
      await files.locator('button.shared-file').filter({ hasText: 'HAF scale sheet.png' }).click()
      await expect(sheet.locator('img.file-sheet-image')).toHaveCount(1)
      await phone.waitForFunction(() => { const node = document.querySelector('img.file-sheet-image'); return Boolean(node && node.complete && node.naturalWidth === 900) })
      await expect(sheet.getByRole('link', { name: 'Open full size' })).toBeVisible()
      await phone.screenshot({ path: join(output, engine + '-image-sheet.png') })
      await sheet.getByRole('button', { name: 'Close' }).click()
      await files.getByRole('button', { name: 'Close' }).click()
      await expect(phone.locator('.file-sheet')).toHaveCount(0)
      assert.deepEqual(problems, [], engine + ' page errors')
    } finally { await browser.close() }
    check(`The phone app in ${engine === 'webkit' ? 'WebKit (Safari engine)' : 'Chromium (mobile)'}: tapping the conversation header opens the Files sheet (3 files newest first, labeled PDF/Image, the deleted PDF disabled as no longer on disk); the PDFs filter, then the PDF opens in the file sheet (Open PDF served as application/pdf with its name${engine === 'chromium' ? ', Download by name' : ''}), and the image previews in place`)
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
