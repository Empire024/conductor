import { _electron as electron, chromium, expect, webkit } from '@playwright/test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

// Project files on the phone (feature-list phone-project-file-viewer): a paired phone lists a
// project folder shaped like the miron logo delivery over the real HTTPS listener, reads its files
// through a folder capability, and the served phone app browses it headless in WebKit and Chromium:
// thumbnails load, the HTML page opens in its own tab with its relative assets and runs sandboxed
// (no storage, no API), and Download names the file. Unpairing ends the capability. No model runs.
// The window is parked off-screen (CONDUCTOR_TEST_USER_DATA). Run under scripts/smoke-lock.mjs;
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-files-'))
const output = resolve('.conductor-scratch/phone-files')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const playwright = { chromium, webkit }
/** The engine build this Playwright wants, or else the newest one installed (a smoke never
 *  downloads browsers); the version used is printed. */
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

/** A real, decodable PNG: `width` x `height`, a red/blue diagonal so it is not a flat colour. */
const png = (width, height) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]) }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3; const red = x > y; rows[at] = red ? 220 : 30; rows[at + 1] = 40; rows[at + 2] = red ? 30 : 220 }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** One HTTPS call as the paired phone makes it. */
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
const api = async (origin, path, options) => {
  const reply = await call(origin, path, options)
  assert.equal(reply.status, 200, `${path}: ${reply.text}`)
  return reply.json
}

/** The miron delivery folder, plus what the phone must never see. */
const writeTree = async projectPath => {
  const concepts = join(projectPath, 'output', 'haf-logo-concepts')
  const outside = join(root, 'outside')
  await mkdir(join(concepts, 'individual-assets'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'passwords.txt'), 'hunter2')
  await writeFile(join(concepts, 'index.html'), [
    '<!doctype html><html><head><meta charset="utf-8"><title>HAF lettermarks</title><link rel="stylesheet" href="individual-assets/page.css"></head>',
    '<body><h1>HAF / Lettermark studies</h1><img id="sheet" src="contact-sheet-color.png" alt="sheet"><img id="mark" src="individual-assets/mark-01.png" alt="mark">',
    '<p id="probe">pending</p><script>',
    'let storage = "readable"; try { window.localStorage.getItem("conductor.phone.token") } catch (error) { storage = "blocked" }',
    'fetch("/api/state").then(response => "api " + response.status, () => "api blocked").then(api => { document.getElementById("probe").textContent = "ran; storage " + storage + "; " + api })',
    '</script></body></html>'
  ].join('\n'))
  await writeFile(join(concepts, 'individual-assets', 'page.css'), 'body { background: rgb(243, 241, 232); font-family: Arial, sans-serif } img { max-width: 45% }')
  await writeFile(join(concepts, 'contact-sheet-color.png'), png(1200, 800))
  await writeFile(join(concepts, 'shortlist.png'), png(900, 600))
  await writeFile(join(concepts, 'individual-assets', 'mark-01.png'), png(400, 400))
  await writeFile(join(concepts, 'haf-lettermarks-delivery.zip'), Buffer.alloc(64 * 1024, 7))
  await writeFile(join(concepts, '.env'), 'SECRET=1')
  await symlink(outside, join(concepts, 'escape'), 'junction')
  return concepts
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  const project = await page.evaluate(() => window.conductor.projects.create('miron'))
  await writeTree(project.path)
  const desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  const ca = await new Promise((done, fail) => {
    const url = new URL('/ca.crt', origin)
    httpsRequest({ host: url.hostname, port: url.port, path: '/ca.crt', rejectUnauthorized: false, headers: { host: url.host } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => done(Buffer.concat(chunks).toString('utf8'))) }).once('error', fail).end()
  })
  const pairing = await page.evaluate(() => window.conductor.phone.pair())
  const { token } = await api(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Files phone' } })
  const base = '/api/projects/' + encodeURIComponent(project.id) + '/files'

  assert.equal((await call(origin, base + '?path=output', { ca })).status, 401)
  const listing = await api(origin, base + '?path=' + encodeURIComponent('output/haf-logo-concepts'), { ca, token })
  assert.deepEqual(listing.entries.map(entry => entry.name), ['individual-assets', 'contact-sheet-color.png', 'haf-lettermarks-delivery.zip', 'index.html', 'shortlist.png'])
  assert.equal((await call(origin, base + '?path=' + encodeURIComponent('output/haf-logo-concepts/escape'), { ca, token })).status, 403)
  assert.equal((await call(origin, base + '?path=..', { ca, token })).status, 400)
  const capability = await api(origin, base + '/capability', { ca, token, body: { path: 'output/haf-logo-concepts' } })
  assert.match(capability.url, /^\/files\/[A-Za-z0-9_-]{43}\/$/)
  const html = await call(origin, capability.url + 'index.html', { ca })
  assert.equal(html.status, 200)
  assert.equal(html.headers['content-security-policy'], "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data: blob:")
  assert.equal(html.headers['x-content-type-options'], 'nosniff')
  const zip = await call(origin, capability.url + 'haf-lettermarks-delivery.zip?download=1', { ca, headers: { range: 'bytes=0-1023' } })
  assert.equal(zip.status, 206)
  assert.equal(zip.raw.length, 1024)
  assert.match(String(zip.headers['content-disposition']), /^attachment; filename="haf-lettermarks-delivery.zip"/)
  for (const path of ['', 'individual-assets/', '.env', 'escape/passwords.txt', '..%2F..%2F..%2Fprofile']) {
    const refused = await call(origin, capability.url + path, { ca })
    assert.ok(refused.status >= 400, path + ' is refused: ' + refused.status)
    assert.ok(!refused.text.includes('hunter2') && !refused.text.includes('SECRET'), path + ' leaks nothing')
  }
  check('A paired phone lists the folder without dotfiles or links that leave the project, and reads files through a folder capability with sandbox, nosniff, Range and download headers; no listing or escape through it')

  for (const engine of ['webkit', 'chromium']) {
    const browser = await playwright[engine].launch({ headless: true, ...installedBuild(engine) })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block', acceptDownloads: true })
      await context.addInitScript(value => { window.localStorage.setItem('conductor.phone.token', value) }, token)
      const phone = await context.newPage()
      const problems = []
      phone.on('pageerror', error => problems.push(error.message))
      phone.on('console', message => { if (message.type() === 'error') problems.push(message.text()) })
      await phone.goto(origin + '/#/more')
      await phone.locator('.more-row').filter({ hasText: 'Project files' }).click()
      await phone.locator('.files-dir').filter({ hasText: 'output' }).click()
      await phone.locator('.files-dir').filter({ hasText: 'haf-logo-concepts' }).click()
      await expect(phone.locator('.files-file')).toHaveCount(4)
      await expect(phone.locator('.files-phone')).not.toContainText('.env')
      const thumbs = phone.locator('img.files-thumb')
      await expect(thumbs).toHaveCount(2)
      await phone.waitForFunction(() => [...document.querySelectorAll('img.files-thumb')].every(image => image.complete && image.naturalWidth > 0))
      await thumbs.first().click()
      await expect(thumbs.first()).toHaveClass(/expanded/)
      await phone.screenshot({ path: join(output, engine + '-folder.png'), fullPage: true })

      const card = phone.locator('.files-file').filter({ hasText: 'index.html' })
      const [popup] = await Promise.all([context.waitForEvent('page'), card.getByRole('link', { name: 'Open page' }).click()])
      await popup.waitForLoadState('load')
      await expect(popup.locator('#probe')).toHaveText(/^ran; storage blocked; api (blocked|401)$/, { timeout: 15000 })
      await popup.waitForFunction(() => ['sheet', 'mark'].every(id => document.getElementById(id).naturalWidth > 0))
      assert.equal(await popup.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(243, 241, 232)')
      await popup.screenshot({ path: join(output, engine + '-page.png') })
      await popup.close()

      if (engine === 'chromium') {
        const [download] = await Promise.all([phone.waitForEvent('download'), phone.locator('.files-file').filter({ hasText: 'haf-lettermarks-delivery.zip' }).getByRole('link', { name: 'Download' }).click()])
        assert.equal(download.suggestedFilename(), 'haf-lettermarks-delivery.zip')
        assert.equal((await download.failure()) ?? null, null)
      }
      assert.deepEqual(problems, [], engine + ' page errors')
    } finally { await browser.close() }
    check(`The phone app in ${engine === 'webkit' ? 'WebKit (Safari engine)' : 'Chromium'} browses More > Project files down to the folder, shows image thumbnails that grow on tap, opens index.html in its own tab with its relative image, style and script working while it cannot read the phone's storage or the API${engine === 'chromium' ? ', and downloads the zip by name' : ''}`)
  }

  const fresh = await api(origin, base + '/capability', { ca, token, body: { path: 'output/haf-logo-concepts' } })
  assert.equal((await call(origin, fresh.url + 'shortlist.png', { ca })).status, 200)
  assert.equal((await call(origin, '/api/unpair', { ca, token, body: {} })).status, 200)
  assert.equal((await call(origin, fresh.url + 'shortlist.png', { ca })).status, 404)
  check('Unpairing the phone ends its file links at once')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none' }, null, 2))
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
