// Parked smoke for the project browser's media tools (feature-list browser-watch-media):
//   1. browser_screenshot in background presentation, after the Browser pane was mounted, is a real
//      non-empty image (it used to be an empty 0x0 PNG), and the guest goes back hidden;
//   2. browser_video_frames seeks a local test video and writes its red/green/blue frames as files,
//      and audio:true records a non-silent WAV of the same window;
//   3. browser_download fetches with the browser's own cookie and referer into refs/, saves the
//      <video> source with fromVideo, refuses a blob: source and a path outside the project.
// Real Electron, loopback MCP and a loopback site; the provider is the offline fixture, so no
// provider credits are spent. The window is parked (CONDUCTOR_TEST_USER_DATA) and never activated.
// Run it under the smoke lock, one at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-browser-watch-media.mjs
import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'
import { launcherTile } from './lib/launcher-tile.mjs'

const root = await mkdtemp(join(tmpdir(), 'conductor-browser-media-'))
const output = resolve('artifacts/browser-watch-media')
const capture = join(root, 'mcp-config.json')
await mkdir(output, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const report = { stamp, syntheticProvider: true, checks: [], failures: [], root }
const check = label => { report.checks.push(label); console.log('PASS ' + label) }

const video = await readFile(resolve('scripts/fixtures/browser-media/tiny.webm'))
const secret = Buffer.from('reference bytes only a signed-in browser gets\n')
const seen = []
const site = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname === '/tiny.webm') {
    // Byte ranges, as a real media server answers them: Chromium seeks with Range requests.
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '')
    if (range) {
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : video.length - 1
      response.writeHead(206, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${video.length}`, 'Content-Length': end - start + 1 })
      response.end(video.subarray(start, end + 1))
    } else {
      response.writeHead(200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': video.length })
      response.end(video)
    }
    return
  }
  if (pathname === '/secret.bin') {
    seen.push({ cookie: request.headers.cookie ?? '', referer: request.headers.referer ?? '', agent: request.headers['user-agent'] ?? '' })
    if (!/(?:^|; )session=signed-in(?:;|$)/.test(request.headers.cookie ?? '')) { response.writeHead(403); response.end('sign in first'); return }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="reference.bin"' })
    response.end(secret)
    return
  }
  if (pathname === '/blob') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Blob video</title><video id="clip" muted></video><script>fetch("/tiny.webm").then(r => r.blob()).then(b => { document.getElementById("clip").src = URL.createObjectURL(b) })</script>')
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'session=signed-in; Path=/; HttpOnly; SameSite=Lax' })
  response.end('<!doctype html><html><head><title>Media smoke</title><style>body{margin:0;background:#fff}h1{font:32px sans-serif;margin:16px}video{display:block;width:480px;height:270px;margin:16px}</style></head><body><h1 id="page">Media smoke</h1><video id="clip" src="/tiny.webm" preload="auto" playsinline></video></body></html>')
})
await new Promise(resolvePort => site.listen(0, '127.0.0.1', resolvePort))
const origin = `http://127.0.0.1:${site.address().port}`

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_BROWSER_MCP_CAPTURE: capture, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_BACKGROUND_WINDOWS: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(20_000)
const rendererErrors = []; page.on('pageerror', error => { if (error.message !== 'Canceled') rendererErrors.push(error.stack ?? error.message) })
let rpcId = 0
const rpc = async (mcp, method, params = {}) => {
  const response = await fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  assert.equal(response.status, 200, `${method} returned ${response.status}`)
  const body = await response.json(); assert.ok(!body.error, JSON.stringify(body.error)); return body.result
}
const call = async (mcp, name, args = {}) => {
  const result = await rpc(mcp, 'tools/call', { name, arguments: args })
  assert.notEqual(result.isError, true, `${name}: ${result.content?.[0]?.text}`); return result
}
const refused = async (mcp, name, args, pattern) => {
  const result = await rpc(mcp, 'tools/call', { name, arguments: args })
  assert.equal(result.isError, true, `${name} should have been refused: ${result.content?.[0]?.text}`)
  assert.match(result.content[0].text, pattern)
  return result.content[0].text
}
const ownedContents = () => app.evaluate(({ BrowserWindow, webContents }) => {
  const windows = new Set(BrowserWindow.getAllWindows().map(window => window.webContents.id))
  return webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && !windows.has(contents.id)).map(contents => ({ id: contents.id, url: contents.getURL() }))
})
const surface = id => app.evaluate(({ BrowserWindow }, wanted) => {
  for (const window of BrowserWindow.getAllWindows()) {
    for (const child of window.contentView.children ?? []) {
      if (child.webContents?.id === wanted) return { title: window.getTitle(), visible: child.getVisible(), hostShown: window.isVisible(), parking: !window.isFocusable() && window.getBounds().x < -10_000 }
    }
  }
  return null
}, id)
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
/** The colour at the centre of an image file, read through Electron's own decoder. */
const centre = path => app.evaluate(({ nativeImage }, file) => {
  const image = nativeImage.createFromPath(file), { width, height } = image.getSize(), bitmap = image.toBitmap()
  const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4
  return { width, height, b: bitmap[at], g: bitmap[at + 1], r: bitmap[at + 2] }
}, path)
const dominant = ({ r, g, b }) => r > 150 && g < 100 && b < 100 ? 'red' : g > 150 && r < 100 && b < 100 ? 'green' : b > 150 && r < 100 && g < 100 ? 'blue' : `rgb(${r},${g},${b})`
let originalFailure, cleanupFailure

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.browser))
  const project = await page.evaluate(async () => window.conductor.projects.create('Media project'))
  // Created now so it is listed after the reload; its browser is first touched near the end.
  const lazy = await page.evaluate(async () => window.conductor.projects.create('Lazy media project'))
  assert.ok(project.path && existsSync(project.path), JSON.stringify(project))
  await page.reload()
  await page.locator('.project-row').filter({ has: page.getByText(project.name, { exact: true }) }).click()
  await launcherTile(page, 'Claude').click()
  const pane = page.locator('.structured-agent-pane:visible')
  await expect(pane.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const sessionId = await pane.getAttribute('data-structured-session')
  // Browser tools may already be on for a new conversation (the composer then offers "Disable browser
  // tools"); otherwise the globe toggle, or the same settings call it makes.
  const toggled = await pane.getByRole('button', { name: 'Enable browser tools', exact: true }).click({ timeout: 5000 }).then(() => true, () => false)
  if (!toggled) {
    report.toggle = { fallback: 'structured.saveSettings', paneButtons: await pane.locator('button[aria-label]').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))) }
    await page.evaluate(async id => { const snapshot = await window.conductor.structured.snapshot(id); await window.conductor.structured.saveSettings(id, { ...snapshot.settings, browserMcp: true }) }, sessionId)
  }
  await page.evaluate(id => window.conductor.structured.connect(id), sessionId)
  await expect.poll(() => readFile(capture, 'utf8').then(text => text.includes('conductor-browser')).catch(() => false)).toBe(true)
  const server = JSON.parse(await readFile(capture, 'utf8')).mcpServers['conductor-browser']
  const mcp = { url: server.url, headers: server.headers }
  const init = await rpc(mcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'media-smoke', version: '1' } })
  assert.match(init.instructions, /browser_download and browser_video_frames instead of curl/)
  const tools = (await rpc(mcp, 'tools/list')).tools.map(tool => tool.name)
  assert.ok(tools.includes('browser_video_frames') && tools.includes('browser_download'), tools.join(','))
  check('The conductor-browser server offers browser_video_frames and browser_download and tells agents to use them instead of curl')

  // The reported configuration: the Browser pane mounted the guest in the workspace window, then the
  // owner chose "Keep running in background", which hides the guest inside that window.
  await page.getByRole('navigation', { name: 'Activity' }).getByRole('button', { name: 'Browser', exact: true }).click()
  const browser = page.locator('.browser-sidebar:not([hidden])')
  await expect(browser).toBeVisible()
  await call(mcp, 'browser_navigate', { url: origin + '/' })
  const [guest] = await ownedContents()
  const backgrounded = await browser.getByRole('button', { name: 'Keep browser running in background', exact: true }).click({ timeout: 5000 }).then(() => true, () => false)
  if (!backgrounded) { report.background = 'browser_present'; await call(mcp, 'browser_present', { mode: 'background' }) }
  await expect.poll(async () => (await surface(guest.id))?.visible).toBe(false)
  const hidden = await surface(guest.id)
  assert.equal(hidden.parking, false, 'the guest must be hidden in the workspace window, the configuration that captured 0x0')
  const windowsBefore = await windowCount()
  const shot = await call(mcp, 'browser_screenshot')
  const image = shot.content.find(block => block.type === 'image')
  assert.ok(image && image.data.length > 1000, `screenshot image has ${image?.data.length ?? 0} base64 characters`)
  const size = /\((\d+)×(\d+)\)/.exec(shot.content[0].text)
  assert.ok(size && Number(size[1]) > 0 && Number(size[2]) > 0, shot.content[0].text)
  await writeFile(join(output, `background-screenshot-${stamp}.png`), Buffer.from(image.data, 'base64'))
  const after = await surface(guest.id)
  assert.deepEqual({ visible: after.visible, parking: after.parking }, { visible: false, parking: false }, 'the guest goes back hidden into its workspace window')
  await expect.poll(windowCount, { message: 'the borrowed off-screen capture host is closed again' }).toBe(windowsBefore)
  check(`browser_screenshot in background presentation returns a real ${size[1]}x${size[2]} PNG, and the guest returns hidden`)

  const frames = await call(mcp, 'browser_video_frames', { selector: '#clip', fps: 1, maxFrames: 3, start: 0.5, end: 2.5 })
  const result = frames.structuredContent
  assert.equal(result.mode, 'seek')
  assert.equal(result.frames.length, 3, frames.content[0].text)
  assert.ok(result.directory.startsWith(join(project.path, '.conductor', 'browser-captures')), result.directory)
  const colours = []
  for (const frame of result.frames) {
    assert.ok(existsSync(frame.path), frame.path)
    const pixel = await centre(frame.path)
    assert.ok(pixel.width >= 300 && pixel.width <= 1000 && pixel.height > 100, JSON.stringify(pixel))
    colours.push(dominant(pixel))
  }
  assert.deepEqual(colours, ['red', 'green', 'blue'], `frames at ${result.frames.map(frame => frame.time).join(', ')} s`)
  assert.deepEqual(result.frames.map(frame => Math.round(frame.time * 10) / 10), [0.5, 1.5, 2.5])
  check(`browser_video_frames seeks the video and writes red, green and blue ${result.width}x${result.height} frames to ${result.directory}`)

  const recorded = await call(mcp, 'browser_video_frames', { selector: '#clip', fps: 2, maxFrames: 4, start: 0, end: 2, audio: true, format: 'jpeg', scale: 0.5 })
  const played = recorded.structuredContent
  assert.equal(played.mode, 'play')
  assert.ok(played.frames.length >= 2 && played.frames.every(frame => frame.path.endsWith('.jpg') && existsSync(frame.path)), recorded.content[0].text)
  assert.ok(played.audio && 'path' in played.audio, `audio was not recorded: ${JSON.stringify(played.audio)}`)
  const wav = await readFile(played.audio.path)
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE')
  let peak = 0
  for (let offset = 44; offset + 1 < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)))
  assert.ok(played.audio.seconds > 1 && peak > 1000, `WAV ${played.audio.seconds} s, peak ${peak}`)
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isAudioMuted(), guest.id), false, 'the page is unmuted again afterwards')
  check(`audio:true plays the window in real time and writes a ${played.audio.seconds} s WAV (peak ${peak}) beside ${played.frames.length} frames`)

  const saved = await call(mcp, 'browser_download', { url: origin + '/secret.bin' })
  const download = saved.structuredContent
  assert.equal(download.relativePath, 'refs/reference.bin')
  assert.deepEqual(await readFile(download.path), secret)
  assert.match(seen.at(-1).cookie, /session=signed-in/)
  assert.equal(seen.at(-1).referer, origin + '/')
  assert.match(seen.at(-1).agent, /Chrome\//)
  check('browser_download fetches with the browser session cookie, page referer and user agent into refs/reference.bin')

  const again = await call(mcp, 'browser_download', { url: origin + '/secret.bin' })
  assert.equal(again.structuredContent.relativePath, 'refs/reference-1.bin')
  await refused(mcp, 'browser_download', { url: origin + '/secret.bin', path: 'refs/reference.bin' }, /already exists; a download never replaces a file/)
  await refused(mcp, 'browser_download', { url: origin + '/secret.bin', path: '../escape.bin' }, /outside the project/)
  await refused(mcp, 'browser_download', { url: origin + '/secret.bin', path: '.git/hooks/post-checkout' }, /protected location/)
  assert.equal(existsSync(join(project.path, '..', 'escape.bin')), false)
  await refused(mcp, 'browser_download', { url: origin + '/tiny.webm', maxMB: 0.001 }, /is 18 KB, over the 2 KB cap; pass maxMB/)
  check('A second download is numbered, and replacing, traversal, protected paths and the size cap are refused')

  const source = await call(mcp, 'browser_download', { fromVideo: true, selector: '#clip' })
  assert.equal(source.structuredContent.relativePath, 'refs/tiny.webm')
  assert.deepEqual(await readFile(source.structuredContent.path), video)
  await call(mcp, 'browser_navigate', { url: origin + '/blob' })
  await expect.poll(async () => JSON.parse((await call(mcp, 'browser_evaluate', { code: 'document.getElementById("clip").currentSrc' })).content[0].text)).toMatch(/^blob:/)
  await refused(mcp, 'browser_download', { fromVideo: true }, /blob: source .*browser_video_frames/)
  check('fromVideo saves the <video> source file, and a blob: source is refused with a pointer to browser_video_frames')

  // The installed app's case (videos wizard, 2026-10-20, on c597c04): a project whose browser only
  // MCP ever drove. Its guest has lived in the hidden parking host from the start and was never
  // painted in a shown window, so Electron has no surface for it: capturePage refuses with "Current
  // display surface not available for capture" (or comes back empty) until DevTools asks for a frame.
  // Playwright itself drives Electron over DevTools, which gives the guest a surface, so under this
  // smoke the plain capture usually works (report.lazyPlainCapture); the faithful reproduction is
  // scripts/probe-browser-background-capture.mjs, which runs BrowserViews with no DevTools client.
  await page.locator('.project-row').filter({ has: page.getByText(lazy.name, { exact: true }) }).click()
  await launcherTile(page, 'Claude').click()
  const lazyPane = page.locator('.structured-agent-pane:visible')
  await expect(lazyPane.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const lazySession = await lazyPane.getAttribute('data-structured-session')
  await page.evaluate(async id => { const snapshot = await window.conductor.structured.snapshot(id); await window.conductor.structured.saveSettings(id, { ...snapshot.settings, browserMcp: true }); await window.conductor.structured.connect(id) }, lazySession)
  await expect.poll(async () => JSON.parse(await readFile(capture, 'utf8')).mcpServers['conductor-browser'].headers.Authorization).not.toBe(server.headers.Authorization)
  const lazyServer = JSON.parse(await readFile(capture, 'utf8')).mcpServers['conductor-browser']
  const lazyMcp = { url: lazyServer.url, headers: lazyServer.headers }
  await rpc(lazyMcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'media-smoke-lazy', version: '1' } })
  const known = new Set((await ownedContents()).map(item => item.id))
  await call(lazyMcp, 'browser_navigate', { url: origin + '/' })
  const lazyGuest = (await ownedContents()).find(item => !known.has(item.id))
  assert.ok(lazyGuest, 'project B got its own guest')
  assert.equal((await surface(lazyGuest.id)).parking, true, 'the lazy guest lives in the parking host')
  // Whether this run reproduces the bug: a plain capturePage of the never-painted guest.
  report.lazyPlainCapture = await app.evaluate(async ({ webContents }, id) => {
    try { const image = await webContents.fromId(id).capturePage(); return image.isEmpty() ? 'empty' : `${image.getSize().width}x${image.getSize().height}` }
    catch (error) { return 'refused: ' + error.message }
  }, lazyGuest.id)
  const lazyShot = await call(lazyMcp, 'browser_screenshot')
  const lazyImage = lazyShot.content.find(block => block.type === 'image')
  assert.ok(lazyImage && lazyImage.data.length > 1000, lazyShot.content[0].text)
  await writeFile(join(output, `lazy-screenshot-${stamp}.png`), Buffer.from(lazyImage.data, 'base64'))
  const lazyFrames = (await call(lazyMcp, 'browser_video_frames', { selector: '#clip', fps: 1, maxFrames: 2, start: 0.5, end: 1.5 })).structuredContent
  assert.deepEqual(await Promise.all(lazyFrames.frames.map(async frame => dominant(await centre(frame.path)))), ['red', 'green'])
  assert.ok(lazyFrames.directory.startsWith(join(lazy.path, '.conductor', 'browser-captures')), lazyFrames.directory)
  check(`A never-painted background guest (plain capturePage: ${report.lazyPlainCapture}) still screenshots and yields red/green video frames`)

  // Only the lazy project's own hidden parking host is added.
  await expect.poll(windowCount, { message: 'no window was left behind' }).toBe(windowsBefore + 1)
  await page.screenshot({ path: join(output, `workspace-${stamp}.png`) })
  assert.deepEqual(rendererErrors, [])
} catch (error) {
  originalFailure = error
  report.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, `failure-${stamp}.png`) }).catch(() => {})
} finally {
  try { await cleanupFixtureApp(app, report, 'browser media fixture cleanup') }
  catch (error) { cleanupFailure = error; report.failures.push(error.stack ?? String(error)) }
  await writeFile(join(output, `report-${stamp}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  site.close()
}
const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))
