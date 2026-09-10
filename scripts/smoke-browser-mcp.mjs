import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

// Proves the owner's report is fixed: a Claude session started by this app is handed a real MCP
// server at launch, and an agent-side tool call over that server drives the browser view the
// owner can see. Real Electron main/preload/renderer, a real loopback MCP endpoint, a real page
// served over HTTP; only the provider process is synthetic. `--live-cli` additionally runs the
// installed claude CLI against the very configuration the app generated.
const liveCli = process.argv.includes('--live-cli')
const root = await mkdtemp(join(tmpdir(), 'conductor-browser-mcp-'))
const output = resolve('artifacts/browser-mcp')
await mkdir(output, { recursive: true })
const capture = join(root, 'mcp-config.json')
const results = { synthetic: true, root, checks: [], failures: [], toolNames: [], liveCli: null }
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
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
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
// What the guest webContents — the actual <webview> the owner is looking at — is showing.
const guestUrls = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && contents.getType() === 'webview').map(contents => contents.getURL()))

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Browser MCP smoke'))
  await page.evaluate(() => window.conductor.projects.create('Other project'))
  await page.reload()

  // (1) Every Claude session is handed the bridge at launch — nothing to reconnect, nothing to
  // opt into. The credential goes on the CLI's own --mcp-config, never into the prompt.
  const mine = await startSession('Browser MCP smoke')
  assert.equal(mine.raw.mcpServers['conductor-browser'].type, 'http')
  assert.match(mine.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.match(mine.headers.Authorization, /^Bearer [a-f0-9]{64}$/)
  check('A Claude session is launched with a loopback --mcp-config carrying its own 256-bit secret')

  const initialized = await rpc(mine, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.267' } })
  assert.equal(initialized.serverInfo.name, 'conductor-browser')
  await fetch(mine.url, { method: 'POST', headers: { ...mine.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  const listed = await rpc(mine, 'tools/list', {})
  results.toolNames = listed.tools.map(tool => 'mcp__conductor-browser__' + tool.name)
  assert.deepEqual(results.toolNames, ['browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_console', 'browser_click', 'browser_type', 'browser_evaluate'].map(name => 'mcp__conductor-browser__' + name))
  check('The session sees exactly seven tools: ' + results.toolNames.join(', '))

  // (2) The first navigate opens a visible browser tab in the agent's own workspace and drives it.
  assert.equal(await page.locator('.browser-pane').count(), 0)
  const navigated = await callTool(mine, 'browser_navigate', { url: origin + '/' })
  assert.match(navigated.content[0].text, /Opened http:\/\/127\.0\.0\.1:\d+\/ — "Preview home"/)
  await expect(page.locator('.browser-pane')).toHaveCount(1)
  await expect(page.locator('.browser-toolbar input[aria-label="Address"]')).toHaveValue(origin + '/')
  assert.ok((await guestUrls()).includes(origin + '/'), 'the real <webview> guest must be on the page the agent opened')
  const myTabId = navigated.structuredContent.tabId
  check('browser_navigate opened a Browser tab in the workspace and moved the real webview guest to the page')

  // (3) Reading the page back: text, console, and arbitrary evaluation.
  const snapshot = await callTool(mine, 'browser_snapshot', {})
  const snapshotBody = JSON.parse(snapshot.content[0].text)
  assert.equal(snapshotBody.title, 'Preview home')
  assert.match(snapshotBody.text, /Conductor preview/)
  assert.ok(snapshotBody.headings.includes('h1: Conductor preview'), JSON.stringify(snapshotBody.headings))
  assert.ok(snapshotBody.fields.some(field => field.name === 'who'), JSON.stringify(snapshotBody.fields))
  const logs = await callTool(mine, 'browser_console', {})
  assert.match(logs.content[0].text, /preview boot warning 42/)
  const evaluated = await callTool(mine, 'browser_evaluate', { code: 'document.querySelectorAll("a").length' })
  assert.equal(JSON.parse(evaluated.content[0].text), 1)
  check('browser_snapshot, browser_console and browser_evaluate read the live page, its console and its DOM')

  // (4) Driving the page, and seeing the result in the same view the owner is watching.
  await callTool(mine, 'browser_click', { selector: '#go' })
  await expect.poll(async () => (await callTool(mine, 'browser_evaluate', { code: 'document.getElementById("headline").textContent' })).content[0].text).toContain('Clicked by the agent')
  await callTool(mine, 'browser_type', { selector: '#who', text: 'the owner', submit: true })
  await expect.poll(async () => (await callTool(mine, 'browser_evaluate', { code: 'document.getElementById("headline").textContent' })).content[0].text).toContain('Submitted: the owner')
  const shot = await callTool(mine, 'browser_screenshot', {})
  const image = shot.content.find(part => part.type === 'image')
  assert.ok(image && image.mimeType === 'image/png' && image.data.length > 1000, 'browser_screenshot must return a PNG image block')
  check('browser_click, browser_type and browser_screenshot act on and capture the same view')

  // (5) Optional: the installed claude CLI, against the configuration this app generated.
  if (liveCli) {
    // The CLI reads --mcp-config from a file or an inline string; a file keeps the app-generated
    // JSON out of this smoke run's own command line.
    const configFile = join(root, 'live-mcp-config.json')
    await writeFile(configFile, JSON.stringify(mine.raw))
    const cliOutput = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.env.CONDUCTOR_CLAUDE_PATH ?? 'claude.exe', ['-p', `Call the browser_navigate tool with url "${origin}/second", then browser_snapshot, and reply with the page title only.`,
        '--mcp-config', configFile, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json',
        '--allowedTools', 'mcp__conductor-browser__browser_navigate', 'mcp__conductor-browser__browser_snapshot'],
      { cwd: root, windowsHide: true })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => process.stderr.write(chunk))
      child.on('error', rejectRun)
      child.on('close', () => resolveRun(out))
    })
    const report = JSON.parse(cliOutput)
    results.liveCli = { result: report.result, isError: report.is_error, denials: report.permission_denials }
    assert.equal(report.is_error, false)
    assert.match(report.result, /Second page/)
    assert.ok((await guestUrls()).includes(origin + '/second'))
    check('The installed claude CLI called mcp__conductor-browser__browser_navigate and drove this workspace’s view')
    // Put the view back where the scope checks below expect to find it.
    await callTool(mine, 'browser_navigate', { url: origin + '/' })
  }

  // (6) Scope. A second workspace's session holds a different secret, cannot reuse this one, and
  // resolves to its own browser tab — never the one belonging to another project.
  const other = await startSession('Other project')
  assert.notEqual(other.headers.Authorization, mine.headers.Authorization)
  const crossed = await fetch(mine.url, { method: 'POST', headers: { Authorization: 'Bearer ' + 'f'.repeat(64), 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/list' }) })
  assert.equal(crossed.status, 401)
  const theirs = await callTool(other, 'browser_navigate', { url: origin + '/second' })
  assert.notEqual(theirs.structuredContent.tabId, myTabId, 'a session in another project must not resolve another workspace’s browser tab')
  assert.deepEqual(await guestUrls(), [origin + '/second'], 'the other project drives its own view only')
  // The first session is still live and still holds a valid secret, but its workspace is not the
  // one on screen: it resolves nothing at all rather than falling through to the view that is.
  const stranded = await rpc(mine, 'tools/call', { name: 'browser_navigate', arguments: { url: origin + '/second' } })
  assert.equal(stranded.isError, true)
  assert.match(stranded.content[0].text, /not open yet/)
  // The first workspace's own browser tab is still parked on the page its session opened, from
  // the persisted layout rather than whatever happens to be mounted right now.
  const parked = await page.evaluate(async ({ projectId, tabId }) => {
    const found = []
    const visit = node => node.type === 'split' ? node.children.forEach(visit) : node.tabs.forEach(tab => { if (tab.id === tabId) found.push(tab) })
    for (const workspace of await window.conductor.sessions.list(projectId)) visit(workspace.layout.root)
    return found[0]
  }, { projectId: project.id, tabId: myTabId })
  assert.ok(parked, 'the first workspace must still own its browser tab')
  assert.equal(parked.state.url, origin + '/')
  check('A session in another project gets its own view, cannot use this session’s secret, and never moves this workspace’s tab')

  // (7) The bridge refuses everything that is not this session speaking JSON-RPC on loopback.
  assert.equal((await fetch(mine.url, { method: 'GET', headers: mine.headers })).status, 405)
  assert.equal((await fetch(mine.url, { method: 'POST', headers: { ...mine.headers, 'Content-Type': 'application/json', Origin: origin }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })).status, 403)
  await callTool(mine, 'browser_navigate', { url: 'file:///C:/Windows/win.ini' }).then(() => { throw new Error('file:// must be refused') }, () => {})
  check('GET, page-originated calls and non-http targets are all refused')

  await page.screenshot({ path: join(output, 'browser-mcp.png') })
  assert.deepEqual(errors, [], 'renderer errors: ' + errors.join(', '))
} catch (error) {
  results.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  await page.screenshot({ path: join(output, 'browser-mcp-failure.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close().catch(() => {})
  site.close()
  console.log(results.failures.length ? 'FAILED' : 'OK ' + results.checks.length + ' checks')
}
