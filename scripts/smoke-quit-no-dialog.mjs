/** Regression guard for feature-list.md's smoke-instances-never-leak dialog rule: in test mode, no
 *  native dialog.showMessageBox may ever land on the owner's screen, including the "Work is still
 *  running" quit/restart confirmation - a parked overnight verifier once sat on that exact modal
 *  with nobody able to answer it. Style follows scripts/smoke-background-windows.mjs.
 *    node scripts/smoke-lock.mjs -- node scripts/smoke-quit-no-dialog.mjs
 */
import { chromium } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-quit-no-dialog-'))
const profile = join(root, 'profile'), fixtures = join(root, 'fixtures'), projectPath = join(root, 'project')
await mkdir(fixtures, { recursive: true })
await mkdir(projectPath, { recursive: true })

// Streams for a long time once asked to, so there is genuinely running work when app.restart is
// called - the exact condition that shows the "Work is still running" dialog.
await writeFile(join(fixtures, 'fake-claude.mjs'), `
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
const send = m => process.stdout.write(JSON.stringify(m) + '\\n')
const emit = m => send({ uuid: randomUUID(), session_id: 'quit-no-dialog', parent_tool_use_id: null, ...m })
const wait = ms => new Promise(r => setTimeout(r, ms))
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const id = randomUUID()
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (let i = 0; i < 400; i++) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } }); await wait(250) }
})
`)

const git = (...args) => execFileSync('git', args, { cwd: projectPath, stdio: 'pipe' }).toString().trim()
await writeFile(join(projectPath, 'README.md'), '# quit-no-dialog smoke\n')
git('init', '-q', '-b', 'main')
git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'add', '.')
git('-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', 'commit', '-q', '-m', 'Initial')

const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_FIXTURE_DIR: fixtures }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const poll = async (check, { timeoutMs, intervalMs = 250 }) => {
  const deadline = Date.now() + timeoutMs
  for (;;) { if (await check()) return true; if (Date.now() > deadline) return false; await new Promise(r => setTimeout(r, intervalMs)) }
}

const cdpPort = await new Promise(done => { const server = createNetServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)) }) })
const child = spawn(process.execPath, [resolve('node_modules/electron/cli.js'), `--remote-debugging-port=${cdpPort}`, resolve('out/main/index.js')], { env, stdio: 'ignore', windowsHide: true })
const pid = child.pid
let exitCode = null
child.on('exit', code => { exitCode = code })

let browser
try {
  await poll(() => existsSync(join(profile, 'control-owner.json')), { timeoutMs: 30_000 })
  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  let projectId
  const call = async (method, args = {}) => {
    const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
    const body = await response.json()
    assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
    return body.result
  }

  // tabs.open needs the workspace itself to acknowledge it, which needs a real page connected and
  // showing the project - a pure control-API call with no page open 400s ("Inspect the UI before
  // retrying"), so the window is driven over CDP exactly like scripts/smoke-rv1-orig-quit-dialog-hang.mjs.
  await poll(async () => { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); return true } catch { return false } }, { timeoutMs: 30_000 })
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))

  projectId = (await call('projects.open', { path: projectPath, name: 'quit-no-dialog' })).id
  await page.waitForTimeout(500)

  const tab = await call('tabs.open', { kind: 'agent', provider: 'claude', title: 'Long turn' })
  const agentSessionId = tab.resourceId ?? tab.agentSessionId
  await call('agents.submit', { agentSessionId, prompt: 'stream forever' })
  // Give the fixture a moment to start streaming so the turn genuinely counts as running work.
  await new Promise(r => setTimeout(r, 1500))

  await call('app.restart', { force: false })

  // The dialog guard answers "stop and restart" headlessly; a live owner's default would keep the
  // 100s turn running in the background, and an unguarded, undisplayable modal would hang forever.
  // Either wrong outcome shows up the same way here: the process is still alive well past the time
  // a guarded restart takes.
  const exited = await poll(() => !alive(pid), { timeoutMs: 20_000 })
  const mainErrorsPath = join(profile, 'main-errors.log')
  const mainErrors = existsSync(mainErrorsPath) ? await readFile(mainErrorsPath, 'utf8') : ''

  assert.ok(exited, `app.restart with running work must not hang on an undisplayable dialog: pid ${pid} was still alive after 20s`)
  assert.match(mainErrors, /\[dialog\] guarded:.*Work is still running/, 'the guarded quit dialog must be logged to main-errors.log')
  console.log('quit-no-dialog: app.restart with a running turn exited cleanly, dialog guarded and logged')
} finally {
  if (browser) await browser.close().catch(() => {})
  if (alive(pid)) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ } }
}

if (exitCode !== null && exitCode !== 0) console.log(`(app exit code was ${exitCode}, restart still counts as clean since it left no process behind)`)
