import { chromium } from '@playwright/test'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync, openSync, closeSync, readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'

// provider-capacity-retry, end to end: a parked Conductor opens a Codex tab on the offline
// fixture, which refuses the first turn with "Selected model is at capacity" exactly as OpenAI did
// on 2026-10-19 (CONDUCTOR_TEST_CODEX_AT_CAPACITY=1). The tab must show one readable notice and
// no raw error, keep reporting work in progress, send the same turn again after 20 s by itself,
// and finish it. Run after a build, one smoke at a time:
//   node scripts/smoke-lock.mjs -- node scripts/smoke-provider-capacity-retry.mjs
// Uses out/main/index.js from the current directory (CONDUCTOR_SMOKE_MAIN overrides it).
const main = resolve(process.env.CONDUCTOR_SMOKE_MAIN || 'out/main/index.js')
const root = await mkdtemp(join(tmpdir(), 'conductor-capacity-retry-'))
const profile = join(root, 'profile'), projectPath = join(root, 'projects', 'capacity')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# capacity retry smoke\n')
const output = resolve('.conductor-scratch/capacity-retry')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_CODEX_AT_CAPACITY: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS; delete env.CONDUCTOR_TEST_FIXTURE_DIR

const observations = []
const observe = (label, data) => { observations.push({ at: new Date().toISOString(), label, ...(data ? { data } : {}) }); console.log(label, data ? JSON.stringify(data) : '') }
const until = async (read, label, timeout) => {
  const started = Date.now()
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value) return value
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for ' + label)
    await new Promise(done => setTimeout(done, 250))
  }
}
let owner, projectId
const call = async (method, args = {}) => {
  const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await response.json()
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(body)}`)
  return body.result
}
const items = id => {
  const db = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT projection_json FROM structured_sessions WHERE id = ?').get(id).projection_json).items ?? [] } finally { db.close() }
}
const summary = { main, root }
let pid = null, failed = null, browser
const appLog = join(root, 'app.log')
try {
  /* The workspace UI acknowledges tabs.open, so the project is selected in the (parked) window
     over the DevTools protocol, as smoke-v3-s1-s2 does. */
  const port = await new Promise(done => { const probe = createNetServer().listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => done(free)) }) })
  const log = openSync(appLog, 'a')
  const child = spawn(createRequire(import.meta.url)('electron'), [`--remote-debugging-port=${port}`, main], { env, stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  pid = child.pid
  observe('app launched (parked)', { pid })
  owner = await until(async () => { if (!existsSync(join(profile, 'control-owner.json'))) return null; const next = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')); return next.pid === pid ? next : null }, 'the owner credential', 60_000)
  projectId = (await call('projects.open', { path: projectPath, name: 'Capacity' })).id
  browser = await until(async () => { try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`) } catch { return null } }, 'the DevTools endpoint', 30_000)
  const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html')) ?? browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(20_000)
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor))
  await page.locator('.project-row').filter({ hasText: 'Capacity' }).first().click()
  await page.waitForTimeout(500)
  const codexModel = (await call('models.list')).find(entry => entry.provider === 'codex')?.models[0]?.id
  const tab = await call('tabs.open', { kind: 'agent', provider: 'codex', model: codexModel, title: 'Capacity worker' })
  const id = tab.resourceId
  const started = Date.now()
  await call('agents.submit', { agentSessionId: id, prompt: 'Report the build status' })
  observe('submitted', { id, codexModel })

  const notice = await until(async () => items(id).find(item => item.data?.type === 'notice' && /at capacity/.test(item.data.message)), 'the capacity notice', 20_000)
  observe('notice', { message: notice.data.message, afterMs: Date.now() - started })
  assert.match(notice.data.message, /^OpenAI says .+ is at capacity; retrying in 20 s \(1\/3\)\.$/)
  await new Promise(done => setTimeout(done, 1500))
  const refusedItems = items(id)
  assert.equal(refusedItems.filter(item => item.data?.type === 'error').length, 0, 'no raw error item while a retry remains')
  const waiting = (await call('agents.list')).find(row => row.agentSessionId === id)
  observe('while waiting', { phase: waiting?.phase, activity: waiting?.activityPhase ?? waiting?.activity ?? null })
  /* A turn refused before it did anything is sent again as the same turn: no second user bubble,
     so the retry shows as the fixture's answer arriving. */
  const answered = () => items(id).some(item => item.data?.type === 'text' && item.data.role === 'assistant')
  assert.equal(answered(), false, 'nothing ran before the 20 s wait')

  await until(async () => answered(), 'the automatic retry', 40_000)
  const retriedAfter = Date.now() - started
  observe('retried', { afterMs: retriedAfter })
  assert.ok(retriedAfter >= 19_000, 'the retry waited about 20 s: ' + retriedAfter)
  assert.equal(items(id).filter(item => item.data?.type === 'text' && item.data.role === 'user').length, 1, 'the untouched turn is sent again as it was, not as a new message')
  const status = await until(async () => { const value = await call('agents.status', { agentSessionId: id }); return value.phase === 'completed' ? value : null }, 'the retried turn to complete', 30_000)
  observe('completed', { phase: status.phase })
  const final = items(id)
  assert.equal(final.filter(item => item.data?.type === 'error').length, 0, 'no error item after a successful retry')
  assert.equal(final.filter(item => item.data?.type === 'notice' && /at capacity/.test(item.data.message)).length, 1, 'one capacity notice in all')
  summary.retriedAfterMs = retriedAfter
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
} finally {
  if (browser) await browser.close().catch(() => {})
  if (pid) { try { execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { summary.appLog = readFileSync(appLog, 'utf8').split('\n').filter(line => /Error|error/.test(line)).slice(-20) } catch { /* no log */ }
}
const result = { result: failed ? 'FAIL' : 'PASS', ...summary, observations }
await writeFile(join(output, 'summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ result: result.result, retriedAfterMs: summary.retriedAfterMs ?? null }, null, 2))
if (!failed) { await new Promise(done => setTimeout(done, 2000)); await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}) }
process.exit(failed ? 1 : 0)
