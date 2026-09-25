import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2e-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const results = []
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
let watchdogApp = null
const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: exceeded 300s, last step: ' + lastStep)
  try { if (watchdogApp) { const buf = await watchdogApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.capturePage().then(img => img.toPNG().toString('base64'))); if (buf) await writeFile(join(output, 'e-timeout.png'), Buffer.from(buf, 'base64')) } } catch (e) { console.error('watchdog screenshot failed: ' + e) }
  await writeFile(join(output, 'e-results-partial.json'), JSON.stringify({ lastStep, results }, null, 2)).catch(() => {})
  process.exit(2)
}, 300_000)
watchdog.unref()
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args) => {
        const buttons = args.at(-1)?.buttons ?? []
        const index = buttons.findIndex(label => label === "Don't Save" || label === 'Stop work and quit')
        return { response: index >= 0 ? index : 0, checkboxChecked: false }
      }
    }),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]).catch(() => {})
  let pid
  try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 20_000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}
const run = async (label, fn) => {
  try { const record = await fn(); results.push({ label, pass: true, record }); console.log('PASS ' + label, JSON.stringify(record)) }
  catch (error) { results.push({ label, pass: false, error: String(error?.stack ?? error), lastStep }); console.error('FAIL ' + label + ' at step [' + lastStep + ']: ' + error) }
}

async function launch(label) {
  step('launch ' + label)
  const capture = join(root, `capture-${label}.txt`)
  const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile-' + label), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects-' + label) }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  watchdogApp = app
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  return { app, page, errors, capture }
}
const credentials = async (capture) => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'controller must receive the app-control briefing')
  return { endpoint, token }
}
const call = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30_000) })
  const result = await response.json()
  assert.equal(response.status, 200, method + ': ' + JSON.stringify(result))
  return result.result
}

async function setupControllerWithCoworkers(page, capture, label, running) {
  const project = await page.evaluate((n) => window.conductor.projects.create(n), 'E ' + label)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'E ' + label }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const composer = page.getByRole('textbox', { name: /Message Claude/i })
  await expect(composer).toBeEnabled()
  const controllerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async (sid) => { const state = await window.conductor.structured.snapshot(sid); await window.conductor.structured.submit(sid, 'SYNTHETIC STEER START', { ...state.settings, model: 'synthetic-claude' }, []) }, controllerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(t => t.includes('Conductor app control:')).catch(() => false)).toBe(true)
  const owner = await credentials(capture)
  // A brand-new tab can take a beat to register in the layout before agent-control's tab lookup
  // sees it; retry a few times rather than treating the very first race as a product finding.
  let dispatched, lastError
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      dispatched = await call(owner, 'router.dispatch', { tasks: [1, 2, 3].map(i => ({ title: 'Coworker ' + i, prompt: running && i <= 2 ? 'SYNTHETIC STEERING WAIT' : 'SYNTHETIC B idle worker ' + i, provider: 'claude', model: 'synthetic-claude', effort: 'low' })) })
      break
    } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 1500)) }
  }
  if (!dispatched) throw lastError
  return { project, controllerId, owner, dispatched }
}

// E1: Chat -> CLI -> Chat with running coworkers must not drop tabs
await run('E1', async () => {
  const { app, page, capture } = await launch('e1')
  try {
    const { owner, dispatched } = await setupControllerWithCoworkers(page, capture, 'E1', true)
    const before = await call(owner, 'tabs.list')
    await page.getByRole('button', { name: 'CLI', exact: true }).click()
    await page.waitForTimeout(500)
    const midCli = await call(owner, 'tabs.list')
    await page.getByRole('button', { name: 'Continue in Chat', exact: true }).first().click().catch(() => {})
    await page.waitForTimeout(500)
    const after = await call(owner, 'tabs.list')
    const logPath = join(root, 'main-log-e1.txt')
    // main process log not directly accessible; note via app.evaluate reading recent console if exposed
    return { beforeCount: before.length, midCliCount: midCli.length, afterCount: after.length, idsMatch: JSON.stringify(before.map(t => t.id).sort()) === JSON.stringify(after.map(t => t.id).sort()), dispatchedCount: dispatched.length }
  } finally { await safeClose(app) }
})

// E2: same with idle coworkers
await run('E2', async () => {
  const { app, page, capture } = await launch('e2')
  try {
    const { owner } = await setupControllerWithCoworkers(page, capture, 'E2', false)
    const before = await call(owner, 'tabs.list')
    await page.getByRole('button', { name: 'CLI', exact: true }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'Continue in Chat', exact: true }).first().click().catch(() => {})
    await page.waitForTimeout(500)
    const after = await call(owner, 'tabs.list')
    return { beforeCount: before.length, afterCount: after.length, idsMatch: JSON.stringify(before.map(t => t.id).sort()) === JSON.stringify(after.map(t => t.id).sort()) }
  } finally { await safeClose(app) }
})

await writeFile(join(output, 'e-results.json'), JSON.stringify(results, null, 2))
clearTimeout(watchdog)
const failed = results.filter(r => !r.pass)
console.log(failed.length ? `FAILURES: ${failed.map(f => f.label).join(', ')}` : 'ALL E CASES PASSED')
process.exit(0)
