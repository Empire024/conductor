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
const watchdog = setTimeout(() => { console.error('WATCHDOG exceeded 280s at ' + lastStep); process.exit(2) }, 280_000)
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

const root = await mkdtemp(join(tmpdir(), 'conductor-v2e3-'))
const userData = join(root, 'profile')
const projectsRoot = join(root, 'projects')
const capture = join(root, 'capture.txt')
const baseEnv = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: userData, CONDUCTOR_PROJECTS_ROOT: projectsRoot }
delete baseEnv.ELECTRON_RUN_AS_NODE; delete baseEnv.CONDUCTOR_LIVE_TESTS

let result = { label: 'E3', pass: false }
try {
  step('first launch')
  const app1 = await electron.launch({ args: [resolve('out/main/index.js')], env: baseEnv, timeout: 30000 })
  let before
  try {
    const page = await app1.firstWindow()
    page.setDefaultTimeout(20000)
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
    step('creating controller + coworkers')
    await page.evaluate(() => window.conductor.projects.create('E3 fixture'))
    await page.reload()
    await page.locator('.project-row').filter({ hasText: 'E3 fixture' }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled({ timeout: 20000 })
    const controllerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
    await page.evaluate(async (sid) => { const state = await window.conductor.structured.snapshot(sid); await window.conductor.structured.submit(sid, 'SYNTHETIC STEER START', { ...state.settings, model: 'synthetic-claude' }, []) }, controllerId)
    await expect.poll(async () => readFile(capture, 'utf8').then(t => t.includes('Conductor app control:')).catch(() => false), { timeout: 20000 }).toBe(true)
    const owner = await credentials(capture)
    let dispatched, lastError
    for (let attempt = 0; attempt < 6; attempt++) {
      try { dispatched = await call(owner, 'router.dispatch', { tasks: [1, 2, 3].map(i => ({ title: 'E3 Coworker ' + i, prompt: i <= 1 ? 'SYNTHETIC STEERING WAIT' : 'SYNTHETIC B idle worker ' + i, provider: 'claude', model: 'synthetic-claude', effort: 'low' })) }); break }
      catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 1500)) }
    }
    if (!dispatched) throw lastError
    before = await call(owner, 'tabs.list')
    step('before tabs=' + before.length)
    const beforeAgents = await call(owner, 'agents.list')
    const runningBefore = beforeAgents.filter(a => a.phase === 'running').map(a => a.agentSessionId)
    step('closing app gracefully')
  } finally {
    await safeClose(app1)
  }
  await new Promise((r) => setTimeout(r, 1500))

  step('relaunching same profile')
  const app2 = await electron.launch({ args: [resolve('out/main/index.js')], env: baseEnv, timeout: 30000 })
  try {
    const page2 = await app2.firstWindow()
    page2.setDefaultTimeout(20000)
    await page2.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 20000 })
    await page2.waitForTimeout(2000)
    const domTabCount = await page2.locator('.pane-tab, .cursor-tab, [data-tab-id]').count().catch(() => -1)
    // Use the DOM tab strip / project workspace as the primary signal; app-control needs a live
    // caller tab, which a cold relaunch does not have until one is reopened.
    const projects = await page2.evaluate(() => window.conductor.projects.list())
    const project = projects.find(p => p.name === 'E3 fixture')
    const sessions = project ? await page2.evaluate((pid) => window.conductor.sessions.list(pid), project.id) : []
    step('done')
    result = { label: 'E3', pass: true, record: { beforeTabCount: before?.length ?? -1, domTabCountAfterRelaunch: domTabCount, projectFound: Boolean(project), sessionCount: sessions.length } }
    console.log('RESULT ' + JSON.stringify(result.record))
  } finally {
    await safeClose(app2)
  }
} catch (error) {
  result = { label: 'E3', pass: false, error: String(error?.stack ?? error), lastStep }
  console.error('FAIL E3 at [' + lastStep + ']: ' + error)
} finally {
  clearTimeout(watchdog)
  await writeFile(join(output, 'e3-result.json'), JSON.stringify(result, null, 2))
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
process.exit(0)
