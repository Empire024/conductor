import { _electron as electron, chromium, expect, webkit } from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

// Images from the phone (feature-list 6528fe02): a paired phone uploads raw image bytes over the
// real HTTPS listener, they are saved by the real importer (src/main/prompt-images.ts, Electron's
// nativeImage), sent with a message as a native image attachment to the synthetic Claude fixture,
// and embedded in a project task the desktop task pane shows. No model inference happens.
// The window is parked off-screen (CONDUCTOR_TEST_USER_DATA). Run under scripts/smoke-lock.mjs;
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-phone-images-'))
const output = resolve('.conductor-scratch/phone-redesign/images')
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

/** One HTTPS call as the paired phone makes it; `raw` sends bytes with their own type. */
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
const until = async (read, predicate, label, timeout = 20000) => {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(value).slice(0, 400))
    await new Promise(done => setTimeout(done, 250))
  }
}

try {
  await page.waitForFunction(() => Boolean(window.conductor?.phone))
  const project = await page.evaluate(() => window.conductor.projects.create('Phone images'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Phone images' }).click()
  await expect(page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).first()).toBeVisible()
  const desktop = await page.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(desktop.listening, 'listener starts: ' + desktop.message)
  const origin = `https://127.0.0.1:${new URL(desktop.primaryEndpoint).port}`
  // The CA comes over the not-yet-trusted connection, as a phone fetches it before installing it.
  const ca = await new Promise((done, fail) => {
    const url = new URL('/ca.crt', origin)
    httpsRequest({ host: url.hostname, port: url.port, path: '/ca.crt', rejectUnauthorized: false, headers: { host: url.host } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => done(Buffer.concat(chunks).toString('utf8'))) }).once('error', fail).end()
  })
  const pairing = await page.evaluate(() => window.conductor.phone.pair())
  const { token } = await api(origin, '/api/pair', { ca, body: { code: pairing.pairing.code, name: 'Image phone' } })
  const manifest = await api(origin, '/manifest.webmanifest', { ca })
  assert.equal(manifest.share_target?.action, '/share')
  const shared = await call(origin, '/share', { ca, raw: Buffer.from('--x--'), type: 'multipart/form-data; boundary=x' })
  assert.equal(shared.status, 303)
  assert.equal(shared.headers.location, '/#/share')
  check('The installed app declares a share target, and a share POST that reaches the computer is redirected to #/share unread')

  const state = await api(origin, '/api/state', { ca, token })
  const phoneProject = state.projects.find(entry => entry.id === project.id)
  const claude = state.providers.find(entry => entry.id === 'claude')
  const opened = await api(origin, '/api/tabs/open', { ca, token, body: { projectId: project.id, workspaceId: phoneProject.workspaces[0].id, machineId: phoneProject.machineId, provider: 'claude', model: claude.models[0].id, title: 'Image chat' } })
  const idle = await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }), conversation => conversation.canAttachImages === true, 'the conversation to accept images')
  assert.equal(idle.canAttachImages, true)

  const screenshot = png(1080, 2400)
  assert.equal((await call(origin, '/api/sessions/' + opened.sessionId + '/images?name=shot.png', { ca, raw: screenshot, type: 'image/png' })).status, 401)
  assert.equal((await call(origin, '/api/sessions/' + opened.sessionId + '/images?name=notes.txt', { ca, token, raw: Buffer.from('plain text, not an image'), type: 'image/png' })).status, 400)
  const image = await api(origin, '/api/sessions/' + opened.sessionId + '/images?name=' + encodeURIComponent('Screenshot 2026-10-03.png'), { ca, token, raw: screenshot, type: 'image/png' })
  assert.equal(image.kind, 'image')
  assert.match(image.path, /^\.conductor\/prompt-images\/[0-9a-f-]{36}\.(png|jpg)$/)
  const saved = await stat(join(project.path, image.path))
  assert.ok(saved.size > 0 && saved.size <= 2 * 1024 * 1024)
  assert.equal(await readFile(join(project.path, '.conductor/prompt-images/.gitignore'), 'utf8'), '*\n!.gitignore\n')
  check('An upload from the paired phone is decoded and saved by the desktop importer as a gitignored workspace prompt image; unpaired and non-image uploads are refused')

  const sent = await api(origin, '/api/sessions/' + opened.sessionId + '/message', { ca, token, body: { text: 'SYNTHETIC IMAGES look at this screenshot', mode: 'auto', attachments: [image] } })
  assert.equal(sent.mode, 'submit')
  const delivered = await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }), conversation => conversation.summary.state === 'done' && conversation.items.some(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.includes('Synthetic native images received: 1')), 'the fixture to receive the PNG as a native image block')
  const user = delivered.items.find(item => item.data.type === 'text' && item.data.role === 'user')
  assert.equal(user.data.attachments[0].name, 'Screenshot 2026-10-03.png')
  const forged = await call(origin, '/api/sessions/' + opened.sessionId + '/message', { ca, token, body: { text: 'x', attachments: [{ ...image, path: '../../secrets.png' }] } })
  assert.equal(forged.status, 400)
  check('A message from the phone carries the uploaded image to the agent: the Claude CLI receives it as a native PNG image block; a forged path is refused')

  const taskImage = await api(origin, '/api/projects/' + project.id + '/images?name=' + encodeURIComponent('Bug photo.png'), { ca, token, raw: png(800, 600), type: 'image/png' })
  const created = await api(origin, '/api/projects/' + project.id + '/tasks', { ca, token, body: { title: 'SYNTHETIC settings page overflows', kind: 'bug', images: [taskImage] } })
  assert.ok(created.id)
  const listFile = await readFile(join(project.path, 'feature-list.md'), 'utf8')
  assert.ok(listFile.includes('SYNTHETIC settings page overflows'))
  assert.ok(listFile.includes('![Bug photo.png](' + taskImage.path + ')'), 'the task embeds the image line')
  const tasks = await api(origin, '/api/projects/' + project.id + '/tasks', { ca, token })
  assert.ok(tasks.tasks.some(task => task.title.includes(taskImage.path)))
  check('A task added from the phone embeds its uploaded image as the desktop task pane does, in feature-list.md')

  await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  await expect(page.locator('.project-backlog')).toBeVisible()
  const row = page.locator('.project-task').filter({ hasText: 'SYNTHETIC settings page overflows' }).first()
  await expect(row).toBeVisible()
  await expect(row.locator('.project-task-images img').first()).toBeVisible()
  await page.screenshot({ path: join(output, 'desktop-task-with-phone-image.png') })
  check('The desktop Project tasks view shows the phone task with its image')

  // The phone app itself, headless (no window anywhere), in the Safari and Chrome engines: a photo
  // picked through the real file chooser is downscaled in the page before upload, shown as a
  // thumbnail, sent with a message, and a gallery image goes with a new task.
  const imageSize = path => app.evaluate(({ nativeImage }, file) => nativeImage.createFromPath(file).getSize(), path)
  for (const engine of ['webkit', 'chromium']) {
    const browser = await playwright[engine].launch({ headless: true, ...installedBuild(engine) })
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' })
      await context.addInitScript(value => { window.localStorage.setItem('conductor.phone.token', value) }, token)
      const phone = await context.newPage()
      const problems = []
      phone.on('pageerror', error => problems.push(error.message))
      phone.on('console', message => { if (message.type() === 'error') problems.push(message.text()) })
      await phone.goto(origin + '/#/session/' + encodeURIComponent(opened.sessionId))
      await phone.locator('.composer-attach').waitFor({ state: 'visible' })
      const chooser = phone.waitForEvent('filechooser')
      await phone.locator('.composer-attach').click()
      await (await chooser).setFiles([{ name: engine + '-camera.png', mimeType: 'image/png', buffer: png(4000, 3000) }, { name: engine + '-screen.png', mimeType: 'image/png', buffer: png(600, 1300) }])
      await expect(phone.locator('.image-thumb')).toHaveCount(2, { timeout: 30000 })
      await phone.locator('.image-thumb').nth(1).locator('.image-remove').click()
      await expect(phone.locator('.image-thumb')).toHaveCount(1)
      await phone.locator('.composer-input').fill('SYNTHETIC IMAGES photo from the ' + engine + ' phone')
      await phone.screenshot({ path: join(output, engine + '-composer.png') })
      await phone.locator('.composer-send').click()
      await expect(phone.locator('.image-thumb')).toHaveCount(0, { timeout: 30000 })
      const withPhoto = await until(() => api(origin, '/api/sessions/' + opened.sessionId, { ca, token }), conversation => conversation.summary.state === 'done' && conversation.items.some(item => item.data.type === 'text' && item.data.role === 'user' && (item.data.attachments ?? []).some(attachment => attachment.name === engine + '-camera.jpg')) && conversation.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant' && item.data.text.includes('Synthetic native images received: 1')).length === (engine === 'webkit' ? 2 : 3), 'the ' + engine + ' photo to reach the fixture')
      assert.ok(!withPhoto.items.some(item => (item.data.attachments ?? []).some(attachment => attachment.name.startsWith(engine + '-screen'))), 'the removed image was not sent')
      const sentPhoto = (await readdir(join(project.path, '.conductor/prompt-images'))).filter(name => name !== '.gitignore')
      const sizes = []
      // One at a time: parallel app.evaluate calls lose their promises in Playwright's Electron bridge.
      for (const name of sentPhoto) sizes.push(await imageSize(join(project.path, '.conductor/prompt-images', name)))
      // 4000 px left the phone as 2560: the desktop importer alone would have kept 4000 (its cap is 4096).
      assert.ok(sizes.some(size => size.width === 2560 && size.height === 1920), engine + ' downscaled the photo before upload: ' + JSON.stringify(sizes))

      await phone.goto(origin + '/#/tasks')
      await phone.getByRole('button', { name: 'Add images' }).waitFor({ state: 'visible' })
      const galleryChooser = phone.waitForEvent('filechooser')
      await phone.getByRole('button', { name: 'Add images' }).click()
      await (await galleryChooser).setFiles([{ name: engine + '-bug.png', mimeType: 'image/png', buffer: png(900, 1600) }])
      await expect(phone.locator('.image-thumb')).toHaveCount(1, { timeout: 30000 })
      await phone.getByRole('textbox', { name: 'New project task' }).fill('SYNTHETIC ' + engine + ' task with a screenshot')
      await expect(phone.getByRole('button', { name: 'Add task with 1 image' })).toBeEnabled()
      await phone.screenshot({ path: join(output, engine + '-task.png') })
      await phone.getByRole('button', { name: 'Add task with 1 image' }).click()
      await expect(phone.locator('.phone-task').filter({ hasText: 'SYNTHETIC ' + engine + ' task with a screenshot' })).toContainText('1 image', { timeout: 30000 })
      const tasksFile = await readFile(join(project.path, 'feature-list.md'), 'utf8')
      assert.match(tasksFile, new RegExp('SYNTHETIC ' + engine + ' task with a screenshot <!-- conductor-task:[^>]+-->\\s+!\\[' + engine + '-bug\\.png\\]\\(\\.conductor/prompt-images/[0-9a-f-]{36}\\.(png|jpg)\\)'))
      assert.deepEqual(problems, [], engine + ' page errors')
    } finally { await browser.close() }
    check(`The phone app in ${engine === 'webkit' ? 'WebKit (Safari engine)' : 'Chromium'} picks images through the file chooser, shows removable thumbnails, downscales a photo to 2560 px before upload, and sends images with a message and a new task`)
  }

  const images = (await readdir(join(project.path, '.conductor/prompt-images'))).filter(name => name !== '.gitignore')
  assert.equal(images.length, 6)
  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, inference: 'none', providerBoundary: 'synthetic raw process' }, null, 2))
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
