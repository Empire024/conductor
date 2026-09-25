// Fast recheck of the two S20-S24 gaps found in the first real Ideas smoke run after the wiring
// fix (docs/verification/2026-09-24-v1-local-models.md REOPEN, agent=agent_mugcwk42_1ovc51f):
//   1. S22-wiring: ideas.* must be reachable through app-control (agent-control.ts), not just the
//      renderer-only window.conductor.ideas.* bridge.
//   2. S24: ideas.work needs a projectId, exactly like the real Ideas view sends it
//      (src/renderer/src/components/ideas/IdeasView.tsx workOn -> bridge.work({..., projectId})).
// No local model involved, so this runs in well under a minute (unlike scripts/smoke-v1-ideas.mjs's
// S22, which drives a real local-model exploration and can take 20+ minutes).
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-ideas-recheck.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-v1-ideas-recheck-'))
const projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# V1 ideas recheck\n')
const profile = join(root, 'profile')
const captureFile = join(root, 'first-prompt.txt')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_CONTROL_CAPTURE: captureFile }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page, failed = null
const watchdog = setTimeout(() => { console.log('watchdog: giving up'); process.exit(1) }, 5 * 60_000)
try {
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true)
  const owner = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const call = async (method, args = {}, scope) => {
    const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }) })
    const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result
  }
  const projectId = (await call('projects.open', { path: projectPath, name: 'V1 ideas recheck' })).id
  const scope = { projectId }
  const ideas = (method, ...args) => page.evaluate(({ method, args }) => window.conductor.ideas[method](...args), { method, args })

  // ---- S22-wiring: ideas.* reachable through app-control, not just the renderer bridge ----
  const wiringList = await call('ideas.list', {}, scope)
  record('S22-wiring', Array.isArray(wiringList) ? 'PASS' : 'FAIL', `ideas.list through app-control returned ${Array.isArray(wiringList) ? wiringList.length + ' ideas' : JSON.stringify(wiringList)}`)
  const wiringCaptured = await call('ideas.capture', { text: 'App-control captured this idea' }, scope)
  record('S22-wiring-capture', wiringCaptured?.id ? 'PASS' : 'FAIL', `ideas.capture through app-control: ${JSON.stringify(wiringCaptured)}`)
  const wiringDenied = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'ideas.nope', args: {}, scope }) }).then(r => r.json())
  record('S22-wiring-unknown-method', /unknown/i.test(wiringDenied?.error ?? '') ? 'PASS' : 'FAIL', `an unrecognized ideas.* method still reads as unknown, not a crash: ${JSON.stringify(wiringDenied)}`)

  // ---- S24: "Work on this idea" with a projectId, as the real Ideas view sends it ----
  const workIdea = await ideas('capture', { text: 'Clothing company with drops based on European cities' })
  const worked = await ideas('work', { ideaId: workIdea.id, projectId, provider: 'claude' })
  await expect.poll(() => existsSync(captureFile), { timeout: 30_000 }).toBe(true)
  const firstPrompt = await readFile(captureFile, 'utf8')
  const detailAfter = await ideas('get', workIdea.id)
  const hasNote = firstPrompt.includes('Clothing company')
  record('S24', detailAfter.workedOn && hasNote ? 'PASS' : 'FAIL', `workedOn=${detailAfter.workedOn}, tabId=${worked?.tabId}, original note in first prompt=${hasNote}`)
} catch (error) {
  failed = error
  record('ideas-recheck-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))])
  try { app?.process().kill() } catch {}
  console.log('\n=== IDEAS RECHECK SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed || results.some(r => r.verdict !== 'PASS')) process.exit(1)
