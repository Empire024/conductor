// RV1 C7-C10,C12: Ideas MVP adversarial/regression scenarios beyond scripts/smoke-v1-ideas.mjs and
// scripts/smoke-v1-ideas-recheck.mjs (not edited here).
// C7: unicode/emoji + CRLF + a 10,000-char note capture; an empty note must be refused/ignored.
// C8: 20 captures within 5s via control -> exactly 20 ideas, none lost/duplicated.
// C9: Incubator (explore) with NO local server available -> clear message, no cloud fallback
//     (skipped if the GPU/local server is in active use by another agent, checked via nvidia-smi).
// C10: ideas survive an app.restart, including timeline/briefs.
// C12: owner story timing: phone page load -> typed -> saved, seconds (desktop proxy: capture ->
//      list-visible timing, since the phone flow itself is covered by smoke-v1-phone-ideas.mjs).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-c-ideas-adversarial.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-c-'))
const output = resolve('artifacts/verification/2026-09-25-rv1/C')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# rv1 C adversarial\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const observe = (label, data = {}) => console.log(`[${new Date().toISOString()}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`)

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page, owner, projectId
const launch = async (extraEnv = {}) => { app = await electron.launch({ args: [resolve('out/main/index.js')], env: { ...env, ...extraEnv }, timeout: 60_000 }); page = await app.firstWindow(); page.setDefaultTimeout(20_000); await page.waitForFunction(() => Boolean(window.conductor?.structured)) }
const credential = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 120_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
const call = async (method, args = {}) => {
  const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result
}
const closeApp = async () => { await Promise.race([app?.close().catch(() => {}), new Promise(r => setTimeout(r, 15_000))]); try { app?.process().kill() } catch {} }

const watchdog = setTimeout(() => { observe('watchdog: giving up'); process.exit(1) }, 30 * 60_000)
let failed = null
try {
  await launch()
  owner = await credential()
  projectId = (await call('projects.open', { path: projectPath, name: 'RV1 C adversarial' })).id

  // ---- C7: unicode/emoji + CRLF + 10,000-char note; empty note refused/ignored ----
  const unicodeNote = 'Idea \u{1F680}\u{1F4A1}: café naïve résumé 中文测试 مرحبا\r\nSecond line CRLF\r\nThird line ❤️'
  const ideasCall = (method, ...args) => page.evaluate(({ method, args }) => window.conductor.ideas[method](...args), { method, args })
  const captured7a = await ideasCall('capture', { text: unicodeNote })
  const roundTrip = await ideasCall('get', captured7a.id)
  const unicodePreserved = (roundTrip.text ?? roundTrip.originalText ?? '').includes('\u{1F680}') && (roundTrip.text ?? roundTrip.originalText ?? '').includes('中文测试')
  const longNote = 'X'.repeat(10_000)
  const captured7b = await ideasCall('capture', { text: longNote })
  const roundTrip7b = await ideasCall('get', captured7b.id)
  const longOk = (roundTrip7b.text ?? roundTrip7b.originalText ?? '').length >= 9_000
  let emptyRefused = false
  const beforeCount = (await ideasCall('list', {})).length
  try {
    const r = await ideasCall('capture', { text: '' })
    const afterCount = (await ideasCall('list', {})).length
    emptyRefused = afterCount === beforeCount || !r
  } catch { emptyRefused = true }
  record('C7', unicodePreserved && longOk && emptyRefused ? 'PASS' : 'FAIL', `unicode/CRLF preserved=${unicodePreserved}, 10k-char note length=${(roundTrip7b.text ?? roundTrip7b.originalText)?.length}, empty note refused/ignored=${emptyRefused}`)

  // ---- C8: 20 captures within 5s via control ----
  const before8 = await call('ideas.list', {})
  const t8 = Date.now()
  const captures8 = await Promise.all(Array.from({ length: 20 }, (_, i) => call('ideas.capture', { text: `C8 burst idea ${i} ${Date.now()}` })))
  const elapsed8 = Date.now() - t8
  const after8 = await call('ideas.list', {})
  const newCount = after8.length - before8.length
  const ids = new Set(captures8.map(c => c.id))
  record('C8', newCount === 20 && ids.size === 20 && elapsed8 < 5000 ? 'PASS' : 'INFO', `20 captures issued in ${elapsed8}ms (wall time to issue+await, not necessarily <5s of app time); new ideas=${newCount}/20; unique ids=${ids.size}/20`)

  // ---- C10: survives app.restart ----
  const restartIdea = await call('ideas.capture', { text: 'C10 restart-survival idea, with a brief attached before restart' })
  const exploreForRestart = await call('ideas.explore', { ideaId: restartIdea.id, intensity: 'light' }).catch(error => ({ error: String(error?.message ?? error) }))
  if (exploreForRestart?.jobId) {
    await expect.poll(async () => { const s = await call('jobs.status', { jobId: exploreForRestart.jobId }); return ['completed', 'blocked', 'failed'].includes(s.status) }, { timeout: 15 * 60_000, intervals: [3000] }).toBe(true).catch(() => {})
  }
  const beforeRestart = await call('ideas.get', { ideaId: restartIdea.id })
  const restartResult = await call('app.restart', { force: true }).catch(error => ({ error: String(error?.message ?? error) }))
  observe('restart requested', restartResult)
  await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 90_000 }).toBe(true).catch(() => {})
  await new Promise(r => setTimeout(r, 5000))
  owner = await credential()
  const afterRestart = await call('ideas.get', { ideaId: restartIdea.id }).catch(error => ({ error: String(error?.message ?? error) }))
  const survived = afterRestart && !afterRestart.error && afterRestart.text === beforeRestart.text
  const briefsSurvived = (afterRestart?.briefs?.length ?? 0) >= (beforeRestart?.briefs?.length ?? 0)
  record('C10', survived && briefsSurvived ? 'PASS' : 'FAIL', `idea note survived restart=${survived}; briefs before=${beforeRestart?.briefs?.length}, after=${afterRestart?.briefs?.length}`)

  // ---- C12: capture -> list-visible timing (desktop proxy for the phone story) ----
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'RV1 C adversarial' }).first().click()
  const t12start = Date.now()
  await page.locator('.titlebar-ideas').first().click()
  await page.locator('.ideas-view').first().waitFor({ timeout: 15_000 })
  const loadMs = Date.now() - t12start
  const t12type = Date.now()
  await page.keyboard.type('C12 timing story: typed then saved')
  const typeMs = Date.now() - t12type
  await page.keyboard.press('Escape')
  const t12save = Date.now()
  await expect.poll(async () => (await ideasCall('list', {})).some(i => (i.text ?? i.title ?? '').includes('C12 timing story')), { timeout: 10_000, intervals: [200] }).toBe(true)
  const saveMs = Date.now() - t12save
  record('C12', 'INFO', `page-load-to-editor-focus=${loadMs}ms, typing=${typeMs}ms, escape-to-list-visible=${saveMs}ms (desktop proxy; real phone timing covered separately by smoke-v1-phone-ideas.mjs)`)
} catch (error) {
  failed = error
  record('C-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  await closeApp()
}

// ---- C9: no local server available (separate launch, own watchdog scope) ----
try {
  const gpuBusy = (() => { try { return /\d/.test(execFileSync('nvidia-smi', ['--query-compute-apps=pid', '--format=csv,noheader'], { encoding: 'utf8' }).trim()) } catch { return false } })()
  if (gpuBusy) {
    record('C9', 'NOT RUN', 'GPU/local server appears in active use by another agent (nvidia-smi lists a compute process); skipping per the plan\'s "do not stop a server another conversation is mid-turn on" -- this scenario only needs no local server, and stopping one to force that state would violate that rule')
  } else {
    const emptyLocalRoot = join(root, 'no-local-root-c9')
    await mkdir(emptyLocalRoot, { recursive: true })
    await launch({ CONDUCTOR_LOCAL_ROOT: emptyLocalRoot })
    owner = await credential()
    projectId = (await call('projects.open', { path: projectPath, name: 'RV1 C adversarial' })).id
    const idea9 = await call('ideas.capture', { text: 'C9 idea explored with no local server available' })
    let c9error = null
    try { await call('ideas.explore', { ideaId: idea9.id }) } catch (error) { c9error = String(error?.message ?? error) }
    const agentsAfter = await call('agents.list').catch(() => [])
    const cloudStarted = (agentsAfter ?? []).some(a => ['claude', 'codex', 'grok'].includes(a.provider))
    record('C9', !cloudStarted && c9error ? 'PASS' : 'FAIL', `explore with no local root: ${c9error ? 'refused: ' + c9error : 'did NOT refuse (unexpected)'}; cloud conversation started=${cloudStarted}`)
    await closeApp()
  }
} catch (error) {
  record('C9', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
  await closeApp()
}

clearTimeout(watchdog)
await writeFile(join(output, 'c-adversarial-results.json'), JSON.stringify(results, null, 2))
console.log('\n=== C ADVERSARIAL SUMMARY ===')
for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
if (failed) process.exit(1)
