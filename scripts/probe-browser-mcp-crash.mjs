import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Does an oversized page value take the main process down? There is no uncaughtException handler
// in this app and BrowserMcpServer dispatches with a bare `void this.handle(...)`, so any throw on
// the reply path is an unhandled rejection and an unrecoverable main-process exit.
const output = resolve('artifacts/browser-mcp-attack')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-mcp-crash-'))
const capture = join(root, 'mcp-config.json')
const log = []
const record = line => { log.push(line); console.log(line) }

const site = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><title>Blank</title><body>blank</body>')
})
await new Promise(done => site.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${site.address().port}`

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_BROWSER_MCP_CAPTURE: capture, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
let exited = false
app.process().on('exit', code => { exited = true; record(`MAIN PROCESS EXITED code=${code}`) })
app.process().stderr?.on('data', chunk => { const text = String(chunk); if (/RangeError|FATAL|out of memory|Invalid string/i.test(text)) record('STDERR ' + text.split('\n').slice(0, 6).join(' | ')) })

let rpcId = 0
const call = async (mcp, name, args = {}) => {
  const response = await fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) })
  const text = await response.text()
  const body = text ? JSON.parse(text) : undefined
  return { status: response.status, isError: Boolean(body?.result?.isError || body?.error), text: body?.result?.content?.[0]?.text ?? JSON.stringify(body?.error ?? '') }
}
const alive = async () => { try { await app.evaluate(() => 1); return true } catch { return false } }

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Crash target'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Crash target' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async sessionId => { await window.conductor.structured.connect(sessionId) }, id)
  await expect.poll(() => readFile(capture, 'utf8').then(text => text.includes('conductor-browser')).catch(() => false)).toBe(true)
  const server = JSON.parse(await readFile(capture, 'utf8')).mcpServers['conductor-browser']
  const mcp = { url: server.url, headers: server.headers }
  record('navigate: ' + (await call(mcp, 'browser_navigate', { url: origin + '/' })).text.slice(0, 80))

  // The tool text and the structuredContent both carry the value, and reply() re-stringifies the
  // whole envelope: one page string is escaped into the response two more times.
  for (const size of [400e6, 520e6]) {
    const started = Date.now()
    let outcome
    try { outcome = await call(mcp, 'browser_evaluate', { code: `"x".repeat(${size})` }) }
    catch (error) { outcome = { status: 0, isError: true, text: 'transport: ' + String(error?.cause?.code ?? error?.message ?? error) } }
    record(`evaluate ${size} chars -> status ${outcome.status} ${outcome.isError ? 'error ' + outcome.text.slice(0, 90) : 'ok, ' + outcome.text.length + ' chars'} in ${Date.now() - started}ms`)
    const up = await alive()
    record('main process alive after ' + size + ': ' + up)
    if (!up || exited) { record('CRASHED at ' + size); break }
  }
} catch (error) {
  record('probe threw: ' + (error?.stack ?? String(error)))
} finally {
  await writeFile(join(output, 'crash.json'), JSON.stringify({ log, exited }, null, 2))
  await app.close().catch(() => {})
  site.close()
  console.log('\n=== SUMMARY ===\n' + log.join('\n'))
}
