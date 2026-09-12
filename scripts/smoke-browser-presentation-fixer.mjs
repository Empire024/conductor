import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'

// Real Electron/main-owned WebContentsView and loopback MCP; provider process is the offline
// fixture. This spends no provider credits and never activates a desktop window.
const root = await mkdtemp(join(tmpdir(), 'conductor-browser-presentation-'))
const output = resolve('artifacts/browser-presentation-fixer')
const capture = join(root, 'mcp-config.json')
const slot = JSON.parse(await readFile(resolve('artifacts/fixer-coordination/electron-slot.json'), 'utf8'))
const buildIdentity = String(slot.build ?? 'unknown-build').replace(/[^a-zA-Z0-9._-]+/g, '-')
const evidenceId = `${buildIdentity}-generation${slot.generation}`
await mkdir(output, { recursive: true })
const report = { build: slot.build, generation: slot.generation, syntheticProvider: true, checks: [], failures: [], root }
const check = label => { report.checks.push(label); console.log('PASS ' + label) }

const site = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  const body = pathname === '/second'
    ? '<!doctype html><html><head><title>Second retained page</title></head><body><h1 id="page">Second retained page</h1></body></html>'
    : '<!doctype html><html><head><title>Background preview</title></head><body><h1 id="page">Background preview</h1><button id="grow" onclick="this.textContent=innerWidth+\'x\'+innerHeight">Measure</button></body></html>'
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body)
})
await new Promise(resolvePort => site.listen(0, '127.0.0.1', resolvePort))
const origin = `http://127.0.0.1:${site.address().port}`

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_BROWSER_MCP_CAPTURE: capture, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_BACKGROUND_WINDOWS: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(20_000)
const rendererErrors = []; page.on('pageerror', error => { if (error.message !== 'Canceled') rendererErrors.push(error.stack ?? error.message) })
let rpcId = 0
const rpc = async (mcp, method, params = {}, expected = 200) => {
  const response = await fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  assert.equal(response.status, expected, `${method} returned ${response.status}`)
  if (expected !== 200) return undefined
  const body = await response.json(); assert.ok(!body.error, JSON.stringify(body.error)); return body.result
}
const call = async (mcp, name, args = {}) => {
  const result = await rpc(mcp, 'tools/call', { name, arguments: args })
  assert.notEqual(result.isError, true, result.content?.[0]?.text); return result
}
const activityRail = page.getByRole('navigation', { name: 'Activity' })
const ownedContents = () => app.evaluate(({ BrowserWindow, webContents }) => {
  const windows = new Set(BrowserWindow.getAllWindows().map(window => window.webContents.id))
  return webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && !windows.has(contents.id)).map(contents => ({ id: contents.id, url: contents.getURL(), type: contents.getType() }))
})
const surface = id => app.evaluate(({ BrowserWindow }, wanted) => {
  for (const window of BrowserWindow.getAllWindows()) {
    for (const child of window.contentView.children ?? []) {
      if (child.webContents?.id === wanted) return { title: window.getTitle(), visible: child.getVisible(), bounds: child.getBounds(), hostVisible: window.isVisible(), hostFocusable: window.isFocusable(), hostBounds: window.getBounds() }
    }
  }
  return null
}, id)
let originalFailure, cleanupFailure

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured && window.conductor?.browser))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const [projectA, projectB] = await page.evaluate(async () => [await window.conductor.projects.create('Browser project A'), await window.conductor.projects.create('Browser project B')])
  await page.reload()
  await page.locator('.project-row').filter({ hasText: projectA.name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const pane = page.locator('.structured-agent-pane:visible')
  await expect(pane.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const sessionId = await pane.getAttribute('data-structured-session')
  const toggle = pane.getByRole('button', { name: 'Enable browser tools', exact: true })
  await toggle.click()
  await expect(pane.getByRole('button', { name: 'Disable browser tools', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(id => window.conductor.structured.connect(id), sessionId)
  await expect.poll(() => readFile(capture, 'utf8').then(text => text.includes('conductor-browser')).catch(() => false)).toBe(true)
  const config = JSON.parse(await readFile(capture, 'utf8'))
  const server = config.mcpServers['conductor-browser']
  const mcp = { url: server.url, headers: server.headers }
  await rpc(mcp, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'presentation-smoke', version: '1' } })
  check('Composer browser control opts this conversation into its scoped native MCP connection without sending a prompt')

  // Keep B selected: project A's first browser tool must create only an invisible unparented
  // guest, never select A or open a browser surface on the owner.
  await page.locator('.project-row').filter({ hasText: projectB.name }).click()
  await call(mcp, 'browser_navigate', { url: origin + '/' })
  const background = await ownedContents()
  assert.equal(background.length, 1)
  const guestId = background[0].id
  assert.equal(await page.locator('.browser-sidebar').count(), 0)
  await expect(page.locator('.project-row.active')).toContainText(projectB.name)
  const parked = await surface(guestId)
  assert.equal(parked.visible, true, 'the guest itself must paint in its hidden host')
  assert.equal(parked.hostVisible, false, 'the parked host must never appear on the desktop')
  assert.equal(parked.hostFocusable, false, 'the parked host must never take keyboard focus')
  assert.ok(parked.hostBounds.x < -10_000 && parked.hostBounds.y < -10_000, JSON.stringify(parked.hostBounds))
  const dimensions = JSON.parse((await call(mcp, 'browser_evaluate', { code: '({innerWidth,innerHeight,bodyWidth:document.body.getBoundingClientRect().width})' })).content[0].text)
  assert.ok(dimensions.innerWidth >= 1000 && dimensions.innerHeight >= 700 && dimensions.bodyWidth > 0, JSON.stringify(dimensions))
  const snapshot = await call(mcp, 'browser_snapshot')
  assert.match(snapshot.content[0].text, /Background preview/)
  const screenshot = await call(mcp, 'browser_screenshot')
  assert.ok(screenshot.content.some(block => block.type === 'image' && block.data.length > 1000))
  assert.match(screenshot.content[0].text, /1440.?900/)
  check('A lazy parked guest renders a positive desktop viewport, useful DOM snapshot and PNG without focus while the owner remains in project B')

  await page.locator('.project-row').filter({ hasText: projectA.name }).click()
  await activityRail.getByRole('button', { name: 'Browser', exact: true }).click()
  const browser = page.locator('.browser-sidebar:not([hidden])')
  await expect(browser).toBeVisible()
  await expect.poll(() => browser.locator('.browser-pane').getAttribute('data-browser-web-contents-id')).toBe(String(guestId))
  assert.equal((await surface(guestId))?.visible, true)
  await browser.getByRole('button', { name: 'Phone', exact: true }).click()
  await expect.poll(async () => {
    const value = JSON.parse((await call(mcp, 'browser_evaluate', { code: '({width:innerWidth,height:innerHeight})' })).content[0].text)
    return `${value.width}x${value.height}`
  }).toBe('390x844')
  check('Opening Browser later reparents the exact same guest and Phone means a truthful 390x844 guest viewport')

  await activityRail.getByRole('button', { name: 'Explorer', exact: true }).click()
  const hiddenBrowser = page.locator('.browser-sidebar[hidden]')
  await expect(hiddenBrowser).toHaveCount(1)
  const hiddenGeometry = await hiddenBrowser.evaluate(element => ({ display: getComputedStyle(element).display, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))
  assert.deepEqual(hiddenGeometry, { display: 'none', width: 0, height: 0 })
  await expect(page.locator('.workspace-sidebar-pane[aria-label="Explorer"]')).toBeVisible()
  assert.equal((await surface(guestId))?.visible, false)
  check('Inactive Browser has explicit zero geometry and cannot occupy or cover Explorer')

  await activityRail.getByRole('button', { name: 'Browser', exact: true }).click()
  await browser.getByRole('button', { name: 'Desktop', exact: true }).click()
  await browser.getByRole('button', { name: 'Expand browser across workspace', exact: true }).click()
  await expect(browser).toHaveClass(/browser-sidebar-expanded/)
  assert.equal(await browser.locator('.browser-pane').getAttribute('data-browser-web-contents-id'), String(guestId))
  await expect.poll(async () => {
    const value = JSON.parse((await call(mcp, 'browser_evaluate', { code: '({width:innerWidth,height:innerHeight})' })).content[0].text)
    return `${value.width}x${value.height}`
  }).toBe('1440x900')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.settings-scrim')).toBeVisible()
  await expect.poll(async () => (await surface(guestId))?.visible).toBe(false)
  await page.locator('.settings-scrim').click({ position: { x: 3, y: 3 } })
  await expect.poll(async () => (await surface(guestId))?.visible).toBe(true)
  check('Expanded Desktop preserves a truthful 1440x900 guest viewport and keeps renderer dialogs reachable while occluded')

  await browser.getByRole('button', { name: 'Detach browser without taking focus', exact: true }).click()
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2)
  const detachedSurface = await surface(guestId)
  assert.match(detachedSurface.title, /Browser project A.*Browser/)
  assert.equal(detachedSurface.visible, true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => /Browser project A.*Browser/.test(window.getTitle()))?.close())
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  await browser.getByRole('button', { name: 'Expand browser across workspace', exact: true }).click()
  await expect.poll(async () => (await surface(guestId))?.visible).toBe(true)
  assert.equal(await browser.locator('.browser-pane').getAttribute('data-browser-web-contents-id'), String(guestId))
  check('Closing a detached host and reattaching normally keeps the same guest and ignores stale close callbacks')

  await browser.getByRole('button', { name: 'Keep browser running in background', exact: true }).click()
  await page.locator('.project-row').filter({ hasText: projectB.name }).click()
  await call(mcp, 'browser_navigate', { url: origin + '/second' })
  assert.equal((await ownedContents()).find(item => item.id === guestId)?.url, origin + '/second')
  assert.equal(JSON.parse((await call(mcp, 'browser_evaluate', { code: "document.getElementById('page').textContent" })).content[0].text), 'Second retained page')
  assert.equal(JSON.parse((await call(mcp, 'browser_evaluate', { code: `window.open(${JSON.stringify(origin + '/')}, '_blank') === null` })).content[0].text), true)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  check('Project A continues in background while B is selected, and popup denial remains enforced')

  await page.locator('.project-row').filter({ hasText: projectA.name }).click()
  await expect(pane.getByRole('button', { name: 'Disable browser tools', exact: true })).toBeVisible()
  await pane.getByRole('button', { name: 'Disable browser tools', exact: true }).click()
  await rpc(mcp, 'tools/list', {}, 401)
  const saved = await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
  assert.equal(saved.settings.browserMcp, false)
  check('Composer opt-out revokes the issued bearer immediately and persists browserMcp false')

  await page.screenshot({ path: join(output, `browser-presentation-${evidenceId}.png`), fullPage: true })
  assert.deepEqual(rendererErrors, [])
} catch (error) {
  originalFailure = error
  report.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, `failure-${evidenceId}.png`), fullPage: true }).catch(() => {})
} finally {
  try { await cleanupFixtureApp(app, report, 'browser presentation fixture cleanup') }
  catch (error) { cleanupFailure = error; report.failures.push(error.stack ?? String(error)) }
  await writeFile(join(output, `report-${evidenceId}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  site.close()
}
const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))
