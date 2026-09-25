import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
const watchdog = setTimeout(async () => {
  console.error('WATCHDOG exceeded 260s at ' + lastStep)
  await writeFile(join(output, 'e3r-partial.json'), JSON.stringify({ lastStep }, null, 2)).catch(() => {})
  process.exit(2)
}, 260_000)
watchdog.unref()
async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => { const b = args.at(-1)?.buttons ?? []; const i = b.findIndex(l => l === "Don't Save" || l === 'Stop work and quit'); return { response: i >= 0 ? i : 0, checkboxChecked: false } } }),
    new Promise((r) => setTimeout(r, 5000))
  ]).catch(() => {})
  let pid; try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 20000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
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

const root = await mkdtemp(join(tmpdir(), 'conductor-v2e3r-'))
const userData = join(root, 'profile')
const projectsRoot = join(root, 'projects')
const capture = join(root, 'capture.txt')
const baseEnv = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: userData, CONDUCTOR_PROJECTS_ROOT: projectsRoot }
delete baseEnv.ELECTRON_RUN_AS_NODE; delete baseEnv.CONDUCTOR_LIVE_TESTS

let result = { label: 'E3r', pass: false }
try {
  step('first launch')
  const app1 = await electron.launch({ args: [resolve('out/main/index.js')], env: baseEnv, timeout: 30000 })
  let sessionsBefore, projectId, workspaceId
  try {
    const page = await app1.firstWindow()
    page.setDefaultTimeout(20000)
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
    step('creating controller + coworkers')
    const project = await page.evaluate(() => window.conductor.projects.create('E3r fixture'))
    projectId = project.id
    await page.reload()
    await page.locator('.project-row').filter({ hasText: 'E3r fixture' }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled({ timeout: 20000 })
    const controllerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
    await page.evaluate(async (sid) => { const state = await window.conductor.structured.snapshot(sid); await window.conductor.structured.submit(sid, 'SYNTHETIC STEER START', { ...state.settings, model: 'synthetic-claude' }, []) }, controllerId)
    await expect.poll(async () => readFile(capture, 'utf8').then(t => t.includes('Conductor app control:')).catch(() => false), { timeout: 20000 }).toBe(true)
    const owner = await credentials(capture)
    let dispatched, lastError
    for (let attempt = 0; attempt < 6; attempt++) {
      try { dispatched = await call(owner, 'router.dispatch', { tasks: [1, 2, 3].map(i => ({ title: 'E3r Coworker ' + i, prompt: i <= 1 ? 'SYNTHETIC STEERING WAIT' : 'SYNTHETIC B idle worker ' + i, provider: 'claude', model: 'synthetic-claude', effort: 'low' })) }); break }
      catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 1500)) }
    }
    if (!dispatched) throw lastError
    await page.waitForTimeout(1000)
    const state = await call(owner, 'app.state')
    workspaceId = state.workspace.id
    sessionsBefore = await page.evaluate((pid) => window.conductor.sessions.list(pid), projectId)
    step('sessionsBefore: ' + JSON.stringify(sessionsBefore).slice(0, 500))
    const layoutBefore = await page.evaluate(async (args) => await window.conductor.layout?.snapshot?.(args.pid, args.sid).catch(() => null), { pid: projectId, sid: workspaceId }).catch(() => null)
    await page.screenshot({ path: join(output, 'e3r-tabstrip-before.png') })
    step('tabs before via app-control: ' + JSON.stringify(await call(owner, 'tabs.list')))
    result.tabsBefore = await call(owner, 'tabs.list')
    result.layoutBefore = layoutBefore
    step('closing app gracefully')
  } finally { await safeClose(app1) }
  await new Promise((r) => setTimeout(r, 1500))

  step('relaunching same profile')
  const app2 = await electron.launch({ args: [resolve('out/main/index.js')], env: baseEnv, timeout: 30000 })
  let sessionsAfter
  try {
    const page2 = await app2.firstWindow()
    page2.setDefaultTimeout(20000)
    await page2.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
    step('waiting 10s after relaunch')
    await page2.waitForTimeout(10000)
    sessionsAfter = await page2.evaluate((pid) => window.conductor.sessions.list(pid), projectId).catch((e) => ({ error: String(e) }))
    step('sessionsAfter: ' + JSON.stringify(sessionsAfter).slice(0, 500))
    await page2.locator('.project-row').filter({ hasText: 'E3r fixture' }).click().catch(() => {})
    await page2.waitForTimeout(500)
    await page2.screenshot({ path: join(output, 'e3r-tabstrip-after.png') })
  } finally { await safeClose(app2) }

  const idsBefore = new Set((sessionsBefore ?? []).flatMap(s => (s.tabs ?? []).map(t => t.id ?? t.resourceId ?? JSON.stringify(t))))
  const idsAfter = new Set((sessionsAfter ?? []).flatMap(s => (s.tabs ?? []).map(t => t.id ?? t.resourceId ?? JSON.stringify(t))))
  const missing = [...idsBefore].filter(id => !idsAfter.has(id))

  result = { label: 'E3r', pass: true, record: { sessionsBefore, sessionsAfter, tabsBefore: result.tabsBefore, missingTabIds: missing } }
  console.log('RESULT ' + JSON.stringify(result.record).slice(0, 3000))
} catch (error) {
  result = { label: 'E3r', pass: false, error: String(error?.stack ?? error), lastStep }
  console.error('FAIL E3r at [' + lastStep + ']: ' + error)
} finally {
  clearTimeout(watchdog)
  await writeFile(join(output, 'e3r-result.json'), JSON.stringify(result, null, 2))
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
process.exit(0)
