import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'

// Claim 5, checked against the installed CLI rather than by reading argv: are the browser tools
// gated by the permission system, or did wiring an MCP server in create a capability the owner
// never approved? Also the end-to-end check that the CLI reads the app-generated --mcp-config as a
// path — which is how the bearer token stays out of every process listing on the machine.
// Two Haiku turns. Run with: node scripts/probe-browser-mcp-approval.mjs
const output = resolve('artifacts/browser-mcp-attack')
await mkdir(output, { recursive: true })
const root = await mkdtemp(join(tmpdir(), 'conductor-mcp-approval-'))
const capture = join(root, 'mcp-config.json')
const log = []
const record = line => { log.push(line); console.log(line) }

const site = createServer((request, response) => {
  const second = new URL(request.url, 'http://127.0.0.1').pathname === '/second'
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><title>${second ? 'Approval second page' : 'Approval home'}</title><body><h1>${second ? 'Approval second page' : 'Approval home'}</h1></body>`)
})
await new Promise(done => site.listen(0, '127.0.0.1', done))
const origin = `http://127.0.0.1:${site.address().port}`

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_BROWSER_MCP_CAPTURE: capture, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(20000)

const powershell = script => new Promise((done, fail) =>
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? fail(error) : done(stdout)))
const guestUrls = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(c => !c.isDestroyed() && c.getType() === 'webview').map(c => c.getURL()))
const claude = (args) => new Promise((done, fail) => {
  const child = spawn(process.env.CONDUCTOR_CLAUDE_PATH ?? 'claude.exe', args, { cwd: root, windowsHide: true })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  child.on('error', fail)
  child.on('close', () => done(out))
})

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(() => window.conductor.projects.create('Approval target'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'Approval target' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async sessionId => { await window.conductor.structured.connect(sessionId) }, id)
  await expect.poll(() => readFile(capture, 'utf8').then(text => text.includes('conductor-browser')).catch(() => false)).toBe(true)

  // What the app actually put on the provider's command line. Nothing is reconstructed here: the
  // CLI below is handed the very argument value Conductor generated for this session.
  const argv = await powershell("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--mcp-config*' } | Select-Object -ExpandProperty CommandLine")
  record('token present in that command line: ' + /Bearer [a-f0-9]{64}/.test(argv))
  const configFile = /--mcp-config "?([A-Za-z]:[^"\s]+\.json)"?/.exec(argv)?.[1]
  record('--mcp-config value: ' + (configFile ?? '(no path found)'))
  if (!configFile) throw new Error('the app did not pass a --mcp-config path')
  record('that file parses and carries the bearer: ' + /^Bearer [a-f0-9]{64}$/.test(JSON.parse(await readFile(configFile, 'utf8')).mcpServers['conductor-browser'].headers.Authorization))
  record('permission flags on that command line: ' + (/--permission-prompt-tool stdio/.test(argv) && /--permission-prompts host/.test(argv) ? 'prompt-tool stdio + prompts host, mode ' + (/--permission-mode (\S+)/.exec(argv)?.[1] ?? '?') : 'MISSING'))
  record('tool allowlisting on that command line: ' + (/--allowedTools|--dangerously-skip-permissions/.test(argv) ? 'PRESENT — the app pre-approves tools' : 'none — nothing is pre-approved'))

  const base = ['--mcp-config', configFile, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json']
  const ask = `Call the browser_navigate tool with url "${origin}/second". Then reply with just the word DONE.`

  // (1) No allowlist, the CLI's own permission machinery in charge: the tool is present, and using
  // it has to be refused rather than silently permitted.
  const denied = JSON.parse(await claude(['-p', ask, ...base]))
  record('unallowed run: is_error=' + denied.is_error + ' denials=' + JSON.stringify(denied.permission_denials?.map(entry => entry.tool_name ?? entry) ?? []))
  record('unallowed run left the view at: ' + JSON.stringify(await guestUrls()))

  // (2) The same call with the tool explicitly allowed: it runs, and it drives the real view — so
  // the refusal above was the permission system, not a broken configuration.
  const allowed = JSON.parse(await claude(['-p', ask, ...base, '--allowedTools', 'mcp__conductor-browser__browser_navigate']))
  record('allowed run: is_error=' + allowed.is_error + ' result=' + JSON.stringify(String(allowed.result ?? '').slice(0, 80)))
  record('allowed run left the view at: ' + JSON.stringify(await guestUrls()))
} catch (error) {
  record('probe threw: ' + (error?.stack ?? String(error)))
} finally {
  await writeFile(join(output, 'approval.json'), JSON.stringify({ log }, null, 2))
  await app.close().catch(() => {})
  site.close()
  console.log('\n=== SUMMARY ===\n' + log.join('\n'))
}
