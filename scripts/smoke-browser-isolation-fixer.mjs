import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Copied from smoke-browser-mcp.mjs. Real Electron, Chromium storage and loopback MCP;
// only provider launch is synthetic. No paid provider calls.
const root = await mkdtemp(join(tmpdir(), 'conductor-browser-isolation-'))
const output = resolve('artifacts/browser-isolation-fixer')
await mkdir(output, { recursive: true })
const capture = join(root, 'mcp-config.json')
const results = { synthetic: true, root, checks: [], failures: [], toolNames: [], boundary: 'real Electron and MCP; synthetic provider; no paid calls' }
const check = label => { results.checks.push(label); console.log('PASS ' + label) }

// The page under test. A heading, a button that rewrites it, a field, and a console error the
// browser_console tool has to be able to hand back.
const pages = {
  '/': `<!doctype html><html><head><title>Preview home</title></head><body>
    <h1 id="headline">Conductor preview</h1>
    <p>Served for the browser MCP smoke test.</p>
    <button id="go" onclick="document.getElementById('headline').textContent='Clicked by the agent'">Run it</button>
    <form id="form" onsubmit="event.preventDefault();document.getElementById('headline').textContent='Submitted: '+document.getElementById('who').value">
      <input id="who" name="who" placeholder="Your name" />
    </form>
    <a href="/second">Second page</a>
    <script>console.error('preview boot warning 42')</script>
  </body></html>`,
  '/second': '<!doctype html><html><head><title>Second page</title></head><body><h1>Second page</h1></body></html>'
}
const site = createServer((request, response) => {
  const body = pages[new URL(request.url, 'http://127.0.0.1').pathname]
  response.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(body ?? 'not found')
})
await new Promise(resolvePort => site.listen(0, '127.0.0.1', resolvePort))
const origin = `http://127.0.0.1:${site.address().port}`

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_BROWSER_MCP_CAPTURE: capture, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
env.CONDUCTOR_BACKGROUND_WINDOWS = '1'
let app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
let page = await app.firstWindow()
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })

// The MCP client half, byte-for-byte the shape Claude Code 2.1.267 sends over Streamable HTTP.
let rpcId = 0
const rpc = async (mcp, method, params, expectStatus = 200) => {
  const response = await fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
  assert.equal(response.status, expectStatus, `${method} returned ${response.status}`)
  if (response.status !== 200) return undefined
  const body = await response.json()
  assert.ok(!body.error, `${method}: ${JSON.stringify(body.error)}`)
  return body.result
}
const callTool = async (mcp, name, args = {}) => {
  const result = await rpc(mcp, 'tools/call', { name, arguments: args })
  assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`)
  return result
}
const startSession = async (projectName) => {
  await page.locator('.project-row').filter({ hasText: projectName }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async sessionId => { await window.conductor.structured.connect(sessionId) }, id)
  await expect.poll(() => readFile(capture, 'utf8').then(text => text.includes('conductor-browser')).catch(() => false)).toBe(true)
  const configuration = JSON.parse(await readFile(capture, 'utf8'))
  await writeFile(capture, '')
  const server = configuration.mcpServers['conductor-browser']
  return { sessionId: id, raw: configuration, url: server.url, headers: server.headers }
}
const evaluate = async (mcp, code) => JSON.parse((await callTool(mcp, 'browser_evaluate', { code })).content[0].text)
const readProfile = "({cookie: document.cookie, storage: localStorage.getItem('project-secret')})"
const writeProfile = value => "(() => { document.cookie = 'project_secret=" + value + "; Path=/; Max-Age=86400; SameSite=Lax'; localStorage.setItem('project-secret', '" + value + "'); return true })()"
const guestId = () => page.locator('webview').first().evaluate(view => view.getWebContentsId())
const readyGuest = async view => {
  await expect.poll(() => view.evaluate(element => { try { return element.getWebContentsId() > 0 } catch { return false } })).toBe(true)
}
const assertGuest = async projectId => {
  const views = page.locator('webview')
  await expect(views).toHaveCount(1)
  await expect(views).toHaveAttribute('partition', 'persist:conductor-browser-' + projectId)
  await readyGuest(views)
  assert.equal(await views.evaluate(view => view.hasAttribute('allowpopups')), false)
}
const watchWindows = async () => app.evaluate(({ app, BrowserWindow }) => {
  globalThis.__isolationWindows = { created: [], focused: [] }
  app.on('browser-window-created', (_event, window) => {
    globalThis.__isolationWindows.created.push(window.id)
    window.on('focus', () => globalThis.__isolationWindows.focused.push(window.id))
  })
  for (const window of BrowserWindow.getAllWindows()) window.on('focus', () => globalThis.__isolationWindows.focused.push(window.id))
})
const assertBackground = async () => {
  const state = await app.evaluate(({ BrowserWindow, screen }) => ({
    windows: BrowserWindow.getAllWindows().map(window => ({ id: window.id, focused: window.isFocused(), bounds: window.getBounds() })),
    displays: screen.getAllDisplays().map(display => display.bounds), events: globalThis.__isolationWindows
  }))
  assert.equal(state.windows.length, 1, JSON.stringify(state))
  assert.deepEqual(state.events, { created: [], focused: [] })
  for (const window of state.windows) {
    assert.equal(window.focused, false)
    assert.equal(state.displays.some(display => window.bounds.x < display.x + display.width && window.bounds.x + window.bounds.width > display.x && window.bounds.y < display.y + display.height && window.bounds.y + window.bounds.height > display.y), false)
  }
  results.windowEvidence = state
}
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await watchWindows()
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const projectA = await page.evaluate(() => window.conductor.projects.create('Isolation project A'))
  const projectB = await page.evaluate(() => window.conductor.projects.create('Isolation project B'))
  results.projectIds = [projectA.id, projectB.id]
  await page.reload()
  const mine = await startSession('Isolation project A')
  await callTool(mine, 'browser_navigate', { url: origin + '/' })
  await assertGuest(projectA.id)
  const firstGuest = await guestId()
  assert.deepEqual(await evaluate(mine, readProfile), { cookie: '', storage: null })
  await evaluate(mine, writeProfile('secret-A'))
  assert.deepEqual(await evaluate(mine, readProfile), { cookie: 'project_secret=secret-A', storage: 'secret-A' })
  check('Project A writes real persistent Chromium cookies and localStorage at the test origin')

  const other = await startSession('Isolation project B')
  await callTool(other, 'browser_navigate', { url: origin + '/' })
  await assertGuest(projectB.id)
  assert.notEqual(await guestId(), firstGuest)
  assert.deepEqual(await evaluate(other, readProfile), { cookie: '', storage: null })
  await evaluate(other, writeProfile('secret-B'))
  check('Project B at the identical origin cannot read A cookies or localStorage and has a different guest')

  await page.locator('.project-row').filter({ hasText: 'Isolation project A' }).click()
  await callTool(mine, 'browser_navigate', { url: origin + '/' })
  await assertGuest(projectA.id)
  assert.notEqual(await guestId(), firstGuest)
  assert.deepEqual(await evaluate(mine, readProfile), { cookie: 'project_secret=secret-A', storage: 'secret-A' })
  check('Remounting A retains its own profile and cannot read B cookies or localStorage')

  assert.equal(await evaluate(mine, "window.open('" + origin + "/second', '_blank') === null"), true)
  await page.waitForTimeout(500)
  await assertBackground()
  check('window.open is denied: no BrowserWindow created, no focus event, all windows remain off display')

  // The custom event is the same application command the Browser toolbar dispatches.
  // Seed only the sidebar's saved address, not guest storage. Mount it directly at the same
  // origin so an imperative loadURL does not race its initial localhost navigation.
  await page.evaluate(({ ids, url }) => { for (const id of ids) localStorage.setItem('conductor.browserSidebar.' + id, url) }, { ids: [projectA.id, projectB.id], url: origin + '/' })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'browser' })))
  const sidebar = page.locator('.browser-sidebar webview')
  await expect(sidebar).toHaveAttribute('partition', 'persist:conductor-browser-' + projectA.id)
  await readyGuest(sidebar)
  const sidebarA = await sidebar.evaluate(view => view.getWebContentsId())
  const readSidebar = () => sidebar.evaluate(view => view.executeJavaScript("({cookie: document.cookie, storage: localStorage.getItem('project-secret')})")).catch(error => String(error))
  await expect.poll(readSidebar).toEqual({ cookie: 'project_secret=secret-A', storage: 'secret-A' })
  assert.equal(await sidebar.evaluate(view => view.hasAttribute('allowpopups')), false)
  assert.equal(await sidebar.evaluate((view, url) => view.executeJavaScript("window.open(" + JSON.stringify(url) + ", '_blank') === null"), origin + '/second'), true)
  check('Sidebar uses its explicit project profile and also has no popup attribute')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'workspace' })))
  await page.locator('.project-row').filter({ hasText: 'Isolation project B' }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'browser' })))
  await expect(sidebar).toHaveAttribute('partition', 'persist:conductor-browser-' + projectB.id)
  await readyGuest(sidebar)
  assert.notEqual(await sidebar.evaluate(view => view.getWebContentsId()), sidebarA)
  await expect.poll(readSidebar).toEqual({ cookie: 'project_secret=secret-B', storage: 'secret-B' })
  check('Sidebar in B reads only B credentials at the same origin')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'workspace' })))
  await page.locator('.project-row').filter({ hasText: 'Isolation project A' }).click()
  await callTool(mine, 'browser_navigate', { url: origin + '/' })
  await assertBackground()
  await page.screenshot({ path: join(output, 'browser-isolation.png') })
  assert.deepEqual(errors, [], 'renderer errors: ' + errors.join(', '))

  // Flush real Chromium persistent stores and relaunch with exactly the same test userData.
  await app.evaluate(async ({ session }, ids) => {
    for (const id of ids) { const profile = session.fromPartition('persist:conductor-browser-' + id); profile.flushStorageData(); await profile.cookies.flushStore() }
  }, [projectA.id, projectB.id])
  await app.close()
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
  await watchWindows()
  await page.waitForFunction(() => Boolean(window.conductor?.projects))
  for (const [project, name, secret] of [[projectA, 'Isolation project A', 'secret-A'], [projectB, 'Isolation project B', 'secret-B']]) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'workspace' })))
    await page.locator('.project-row').filter({ hasText: name }).click()
    // loadProject strips utility/browser tabs from restored layouts. Reopen the real sidebar;
    // the task under test is persistence of its profile, not restoration of the old tab.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('conductor:sidebar-mode', { detail: 'browser' })))
    await assertGuest(project.id)
    await expect.poll(() => page.locator('webview').evaluate(view => view.executeJavaScript("({cookie: document.cookie, storage: localStorage.getItem('project-secret')})")).catch(error => String(error))).toEqual({ cookie: 'project_secret=' + secret, storage: secret })
  }
  await assertBackground()
  assert.deepEqual(errors, [], 'renderer errors: ' + errors.join(', '))
  check('Full Electron restart preserves each project own cookies and localStorage, with isolation intact')
} catch (error) {
  results.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  await page.screenshot({ path: join(output, 'browser-isolation-failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close().catch(() => {})
  site.close()
  console.log(results.failures.length ? 'FAILED' : 'OK ' + results.checks.length + ' checks')
}
