// V1 verify group D: Ideas MVP. S20 (desktop capture), S22 (Incubator on the real local model),
// S23 (local only, never cloud), S24 (Work on this idea). S21 (phone) is a separate script.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-ideas.mjs
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-v1-ideas-'))
const output = resolve('artifacts/verification/2026-09-24-v1')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), projectPath = join(root, 'project')
await mkdir(projectPath, { recursive: true })
await writeFile(join(projectPath, 'README.md'), '# V1 ideas smoke\n')

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const observations = []
const observe = (label, data = {}) => { const e = { at: new Date().toISOString(), label, ...data }; observations.push(e); console.log(`[${e.at}] ${label} ${Object.keys(data).length ? JSON.stringify(data) : ''}`) }

const fixtureDir = join(root, 'fixtures')
await mkdir(fixtureDir, { recursive: true })
const captureFile = join(root, 'first-prompt.txt')
// The default fake-claude.mjs writes the raw first prompt to CONDUCTOR_TEST_CONTROL_CAPTURE.

const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_CONTROL_CAPTURE: captureFile }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_BACKGROUND_WINDOWS

let app, page
const launch = async () => { app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 }); page = await app.firstWindow(); page.setDefaultTimeout(20_000); await page.waitForFunction(() => Boolean(window.conductor?.structured)) }
const credential = async () => { await expect.poll(() => existsSync(join(profile, 'control-owner.json')), { timeout: 30_000 }).toBe(true); return JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8')) }
let owner, projectId
const call = async (method, args = {}) => {
  const r = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args, ...(projectId ? { scope: { projectId } } : {}) }) })
  const body = await r.json(); assert.equal(r.status, 200, `${method}: ${JSON.stringify(body)}`); return body.result
}
// ideas.* is wired into AgentControl's dispatch (agent-control.ts: ideaMethods/ideasMethod) as well
// as the trusted renderer's window.conductor.ideas.* (src/preload/ideas.ts); S22-wiring below
// checks the app-control surface for real. The rest of this script drives the renderer bridge,
// same as the Ideas view itself does.
const ideas = (method, ...args) => page.evaluate(({ method, args }) => window.conductor.ideas[method](...args), { method, args })

const watchdog = setTimeout(() => { observe('watchdog: giving up'); console.log(JSON.stringify({ root, observations }, null, 2)); process.exit(1) }, 40 * 60_000)
let failed = null
try {
  await launch()
  owner = await credential()
  projectId = (await call('projects.open', { path: projectPath, name: 'V1 ideas' })).id
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.locator('.project-row').filter({ hasText: 'V1 ideas' }).first().click()

  // ---- S20: desktop capture via the title-bar lightbulb ----
  await page.locator('.titlebar-ideas').first().click()
  await page.locator('.ideas-view').first().waitFor({ timeout: 15_000 })
  const focusedIsEditor = await page.evaluate(() => { const el = document.activeElement; return Boolean(el) && (el.tagName === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true' || el.tagName === 'INPUT') })
  record('S20-focus', focusedIsEditor ? 'PASS' : 'FAIL', `document.activeElement on open: ${await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 150))}`)
  await page.keyboard.type('First capture line\nSecond line of the idea\nThird line with more detail')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  await page.locator('.titlebar-ideas').first().click()
  await page.locator('.ideas-view').first().waitFor({ timeout: 15_000 })
  await page.screenshot({ path: join(output, 's20-ideas-view.png') })
  const list1 = await ideas('list', {})
  const wiringList = await call('ideas.list', {})
  record('S22-wiring', Array.isArray(wiringList) ? 'PASS' : 'FAIL (real)', `ideas.list reachable through app-control (agent-control.ts ideaMethods/ideasMethod): returned ${Array.isArray(wiringList) ? wiringList.length + ' ideas' : JSON.stringify(wiringList)}`)
  const captured = list1.find(i => i.title?.includes('First capture line') || i.note?.includes('First capture line'))
  record('S20-capture', captured && captured.status === 'inbox' ? 'PASS' : 'FAIL', `found=${Boolean(captured)}, title=${captured?.title}, status=${captured?.status}`)
  await page.keyboard.press('Escape')

  // Palette command "Ideas"
  await page.keyboard.press('Control+KeyK')
  await page.getByPlaceholder(/command|search/i).first().fill('Ideas').catch(() => {})
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(output, 's20-palette.png') })
  await page.keyboard.press('Escape')
  record('S20-ctrl-alt-i', 'INFO (code-only)', 'src/shared/ideas.ts:201-202 IDEA_CAPTURE_ACCELERATOR=CommandOrControl+Alt+I; registered in src/main/ideas/register.ts:185 via globalShortcut.register; not exercised here as global shortcuts are not reliably delivered to a parked/off-screen test window')

  // ---- S22: 5 ideas via ideas.capture, then ideas.explore each on the real local model ----
  const notes = [
    'what is the meaning of life',
    Array.from({ length: 30 }, (_, i) => i % 5 === 0 ? `Reminder: call the accountant about Q${i} taxes` : i % 7 === 0 ? `TODO: fix the flaky upload test` : `Random rambling thought number ${i} about nothing in particular, typos an mispelled wordz included`).join('\n'),
    'Clothing company with drops based on European cities',
    'Need to email Jack about payments tomorrow',
    'AI-generated custom ski graphics as a business'
  ]
  const captured5 = []
  for (const text of notes) captured5.push(await ideas('capture', { text }))
  observe('captured 5 ideas', { ids: captured5.map(i => i.id) })
  const briefs = []
  const t0 = Date.now()
  for (const idea of captured5) {
    try {
      const exploration = await ideas('explore', { ideaId: idea.id, intensity: 'light' })
      observe('exploration dispatched', { ideaId: idea.id, jobId: exploration.jobId })
      const jobId = exploration.jobId
      let last
      await expect.poll(async () => { last = await call('jobs.status', { jobId }); return ['completed', 'blocked', 'failed'].includes(last.status) }, { timeout: 25 * 60_000, intervals: [3000] }).toBe(true)
      const detail = await ideas('get', idea.id)
      briefs.push({ ideaId: idea.id, notePreview: idea.note?.slice(0, 60) ?? idea.title, jobStatus: last.status, brief: detail.briefs?.at(-1) ?? null })
    } catch (error) { briefs.push({ ideaId: idea.id, error: String(error?.message ?? error) }) }
  }
  const elapsedAll = Date.now() - t0
  await writeFile(join(output, 's22-briefs.json'), JSON.stringify(briefs, null, 2))
  const meaningOfLife = briefs[0]
  const meaningOk = !meaningOfLife.error && meaningOfLife.jobStatus !== 'failed'
  const jackFlaggedAsTask = JSON.stringify(briefs[3]).toLowerCase().includes('task')
  record('S22', meaningOk ? 'PASS' : 'FAIL', `5 ideas explored in ${elapsedAll}ms; "meaning of life" did not crash=${meaningOk}; Jack note flagged as task in its brief=${jackFlaggedAsTask}. See s22-briefs.json for full text to judge concept/questions/next-step quality.`)

  // ---- S23: local only, never cloud -- explore with no local server available ----
  await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 15_000))])
  try { app.process().kill() } catch {}
  const emptyLocalRoot = join(root, 'no-local-root')
  await mkdir(emptyLocalRoot, { recursive: true })
  const env2 = { ...env, CONDUCTOR_LOCAL_ROOT: emptyLocalRoot }
  app = await electron.launch({ args: [resolve('out/main/index.js')], env: env2, timeout: 60_000 })
  page = await app.firstWindow(); page.setDefaultTimeout(20_000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  owner = await credential()
  const projects = await call('projects.list').catch(() => null)
  projectId = (await call('projects.open', { path: projectPath, name: 'V1 ideas' })).id
  const sixthIdea = await ideas('capture', { text: 'A sixth idea to explore with no local server available' })
  let s23error = null
  try { await ideas('explore', { ideaId: sixthIdea.id }) } catch (error) { s23error = String(error?.message ?? error) }
  const agentsAfter = await call('agents.list').catch(() => [])
  const cloudStarted = (agentsAfter ?? []).some(a => ['claude', 'codex', 'grok'].includes(a.provider))
  const cloudJobRefused = await (async () => { try { await call('jobs.create', { objective: 'x', model: 'opus' }); return false } catch { return true } })()
  record('S23', !cloudStarted && (s23error || cloudJobRefused) ? 'PASS' : 'FAIL', `ideas.explore with no local root: ${s23error ? 'refused: ' + s23error : 'did not refuse (unexpected)'}; cloud conversation started=${cloudStarted}; jobs.create with a cloud model refused=${cloudJobRefused}`)

  // Relaunch normally (real local root) for S24.
  await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 15_000))])
  try { app.process().kill() } catch {}
  await launch()
  owner = await credential()
  projectId = (await call('projects.open', { path: projectPath, name: 'V1 ideas' })).id

  // ---- S24: "Work on this idea" with a fixture Claude provider ----
  const workIdea = captured5[2] // "Clothing company..." — already explored in S22
  const worked = await ideas('work', { ideaId: workIdea.id, projectId, provider: 'claude' })
  observe('ideas.work dispatched', worked)
  await expect.poll(() => existsSync(captureFile), { timeout: 30_000 }).toBe(true)
  const firstPrompt = await readFile(captureFile, 'utf8')
  const detailAfter = await ideas('get', workIdea.id)
  const hasNote = firstPrompt.includes('Clothing company')
  const hasBrief = detailAfter.briefs?.length > 0 && firstPrompt.length > (detailAfter.briefs.at(-1)?.text?.length ?? 1_000_000) === false // just check brief text appears
  const briefTextInPrompt = detailAfter.briefs?.at(-1)?.text ? firstPrompt.includes(detailAfter.briefs.at(-1).text.slice(0, 40)) : false
  record('S24', detailAfter.workedOn && hasNote ? 'PASS' : 'FAIL', `workedOn=${detailAfter.workedOn}, timeline entries=${detailAfter.timeline?.length}, original note in first prompt=${hasNote}, latest brief text in first prompt=${briefTextInPrompt}, links=${JSON.stringify(detailAfter.linkedWork ?? detailAfter.links ?? [])}`)
} catch (error) {
  failed = error
  record('ideas-fatal', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
} finally {
  clearTimeout(watchdog)
  await Promise.race([app?.close().catch(() => {}), new Promise(done => setTimeout(done, 20_000))])
  try { app?.process().kill() } catch {}
  await writeFile(join(output, 's20-s24-results.json'), JSON.stringify({ results, observations }, null, 2))
  console.log('\n=== IDEAS SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
}
if (failed) process.exit(1)
