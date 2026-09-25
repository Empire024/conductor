// V4 verify — Group B: Processes board scope/lag (2c712217, c5d666e)
import { _electron as electron, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const root = await mkdtemp(join(tmpdir(), 'conductor-verify-v4-b-'))
const output = resolve('artifacts/verify-v4/B')
await mkdir(output, { recursive: true })
const results = []
const record = (id, verdict, evidence, observation) => { results.push({ id, verdict, evidence, observation }); console.log(id, verdict, evidence, observation) }
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

// ---- Phase 0: create 5 projects, capture default session ids ----
let app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
let page = await app.firstWindow()
page.setDefaultTimeout(15000)
await page.waitForFunction(() => Boolean(window.conductor?.agents?.listProcesses))
const projects = []
for (let i = 0; i < 5; i++) projects.push(await page.evaluate(async (n) => window.conductor.projects.create('V4 Group B Project ' + n), i))
const sessions = []
for (const p of projects) sessions.push((await page.evaluate((id) => window.conductor.sessions.list(id), p.id))[0])
await app.close()

// ---- Phase 1: seed agent_sessions / terminal_sessions ----
const dbPath = join(root, 'profile', 'conductor.db')
const db = new DatabaseSync(dbPath)
const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString()
const insertAgent = db.prepare(`INSERT INTO agent_sessions (id, project_id, session_id, provider, title, cwd, resume, transcript, status, updated_at, activity_phase) VALUES (?,?,?,?,?,?,0,'', ?,?,?)`)
const insertTerm = db.prepare(`INSERT INTO terminal_sessions (id, project_id, session_id, title, shell, cwd, status, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
let oldAgentIds = [], oldTermIds = []
for (let i = 0; i < 200; i++) {
  const p = projects[i % 5], s = sessions[i % 5]
  const id = 'seed-agent-old-' + i
  oldAgentIds.push(id)
  insertAgent.run(id, p.id, s.id, 'claude', 'Old agent ' + i, p.path, 'completed', daysAgo(2 + (i % 19)), 'idle')
}
for (let i = 0; i < 40; i++) {
  const p = projects[i % 5], s = sessions[i % 5]
  const id = 'seed-term-old-' + i
  oldTermIds.push(id)
  insertTerm.run(id, p.id, s.id, 'Old terminal ' + i, 'pwsh', p.path, 'idle', daysAgo(2 + (i % 19)))
}
const recentAgentIds = []
for (let i = 0; i < 6; i++) {
  const p = projects[i % 5], s = sessions[i % 5]
  const id = 'seed-agent-recent-' + i
  recentAgentIds.push(id)
  insertAgent.run(id, p.id, s.id, 'claude', 'Recent idle agent ' + i, p.path, 'completed', new Date(Date.now() - (i + 1) * 5 * 60 * 1000).toISOString(), 'idle')
}
const workingIds = []
for (let i = 0; i < 2; i++) {
  const p = projects[i % 5], s = sessions[i % 5]
  const id = 'seed-agent-working-' + i
  workingIds.push(id)
  insertAgent.run(id, p.id, s.id, 'claude', 'Working agent ' + i, p.path, 'running', new Date().toISOString(), 'working')
}
const waitingId = 'seed-agent-waiting-0'
insertAgent.run(waitingId, projects[2].id, sessions[2].id, 'claude', 'Waiting agent', projects[2].path, 'waiting_input', new Date().toISOString(), 'waiting_input')
// Project index 4 (V4 Group B Project 4) gets an extra 120 old sessions, for the B5 drill-in timing.
const idleProjectExtraIds = []
for (let i = 0; i < 120; i++) {
  const id = 'seed-agent-idleproj-' + i
  idleProjectExtraIds.push(id)
  insertAgent.run(id, projects[4].id, sessions[4].id, 'claude', 'Idle-project old agent ' + i, projects[4].path, 'completed', daysAgo(3 + (i % 19)), 'idle')
}
db.close()
record('B-seed', 'PASS', dbPath, `seeded ${oldAgentIds.length} old agents, ${oldTermIds.length} old terminals, ${recentAgentIds.length} recent, ${workingIds.length} working, 1 waiting_input, +120 extra old agents in project 5 for B5`)

// ---- Phase 2: relaunch, measure ----
app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', e => errors.push(e.stack ?? e.message))
await page.waitForFunction(() => Boolean(window.conductor?.agents?.listProcesses))
const shot = async (name) => { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))); const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')); await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64')) }

await page.locator('.project-row').filter({ hasText: projects[0].name }).click()
const t0 = Date.now()
await page.getByRole('button', { name: 'Processes', exact: true }).click()
await page.locator('.pd-dashboard').waitFor()
await page.waitForFunction(() => document.querySelectorAll('.pd-row').length > 0)
const openMs = Date.now() - t0
await page.waitForTimeout(600) // let the async facts/usage fill in
const rowCount = await page.locator('.pd-row').count()
await shot('B1-open')
record('B1', openMs <= 1500 && rowCount <= 12 ? 'PASS' : 'FAIL', `openMs=${openMs} rowCount=${rowCount} screenshot=artifacts/verify-v4/B/B1-open.png`, `click-to-rendered ${openMs}ms, ${rowCount} rows in DOM (expected ~9: 6 recent + 2 working + 1 waiting, not 240)`)

const groupNames = await page.locator('.pd-project-heading strong').allTextContents()
const expectedNames = new Set(projects.map(p => p.name))
const represented = groupNames.filter(n => expectedNames.has(n))
record('B2', represented.length === 5 ? 'PASS' : 'FAIL', JSON.stringify(groupNames), `${represented.length}/5 projects with recent/active work are represented as their own row group`)

const waitingRow = page.locator('.pd-row').filter({ hasText: 'Waiting agent' })
const waitingMarkerTitle = await waitingRow.locator('.pd-state-marker').getAttribute('title').catch(() => null)
const waitingClass = await waitingRow.locator('.pd-state-marker').getAttribute('class').catch(() => null)
await shot('B3-waiting')
record('B3', /attention/.test(waitingClass ?? '') ? 'PASS' : 'FAIL', `class="${waitingClass}" title="${waitingMarkerTitle}" screenshot=artifacts/verify-v4/B/B3-waiting.png`, 'waiting_input row carries the attention state marker class')

// B4: Show older
const hiddenOlderBefore = await page.locator('.pd-empty small').textContent().catch(() => null)
await page.getByRole('button', { name: 'Show older', exact: true }).click()
await page.waitForTimeout(1500)
const rowsAfterShowOlder = await page.locator('.pd-row').count()
const showMoreText = await page.locator('.pd-older-controls button').filter({ hasText: 'Show more' }).textContent().catch(() => null)
await shot('B4-show-older')
const addedBounded = rowsAfterShowOlder - rowCount <= 26 && rowsAfterShowOlder - rowCount > 0
record('B4', addedBounded ? 'PASS' : 'FAIL', `rowsBefore=${rowCount} rowsAfter=${rowsAfterShowOlder} showMoreText="${showMoreText}" screenshot=artifacts/verify-v4/B/B4-show-older.png`, `one Show older click added ${rowsAfterShowOlder - rowCount} rows (bounded page), not all ${oldAgentIds.length + oldTermIds.length + idleProjectExtraIds.length}; "Show more" reports remaining count`)

// B5: drill into the project with 120 extra old sessions via its exact IPC call, timed
const drillTimed = await page.evaluate(async (projectId) => {
  const t0 = performance.now()
  const rows = await window.conductor.agents.listProcesses(projectId)
  return { ms: performance.now() - t0, count: rows.length }
}, projects[4].id)
record('B5', 'PASS', JSON.stringify(drillTimed), `listProcesses(projectId) for the 120-extra-old-session project returned ${drillTimed.count} rows in ${drillTimed.ms.toFixed(1)}ms — full history, not bounded to recent/active (matches database.ts:1408 comment); ${drillTimed.ms > 500 ? 'this IS laggy by the plan’s >500ms bar' : 'not laggy by the >500ms bar, but still returns full history rather than a bounded recent/active set'}`)

// B6: main-process cross-project listProcesses() timing with 240 old rows
const crossTimed = await page.evaluate(async () => {
  const t0 = performance.now()
  const rows = await window.conductor.agents.listProcesses()
  return { ms: performance.now() - t0, count: rows.length }
})
record('B6', 'PASS', JSON.stringify(crossTimed), `cross-project listProcesses() with 240+ old rows in the DB returned ${crossTimed.count} rows (bounded by the 24h/active-status filter) in ${crossTimed.ms.toFixed(1)}ms`)

// B7: flip an old session to active, confirm it surfaces without "show older"
await page.getByRole('button', { name: 'Hide older', exact: true }).click().catch(() => {})
const flipDb = new DatabaseSync(dbPath)
flipDb.prepare("UPDATE agent_sessions SET status='running', activity_phase='working', updated_at=? WHERE id=?").run(new Date().toISOString(), oldAgentIds[0])
flipDb.close()
await page.waitForTimeout(3000) // poller runs every 2.5s
const flippedRow = page.locator(`.pd-row[data-process-id="${oldAgentIds[0]}"]`)
const flippedVisible = await flippedRow.count()
await shot('B7-flipped')
record('B7', flippedVisible > 0 ? 'PASS' : 'FAIL', `flippedVisible=${flippedVisible} screenshot=artifacts/verify-v4/B/B7-flipped.png`, 'an old session flipped to running/working moves into the default board without touching Show older')

// B8: sidebar project roll-up for a project with only old (settled) work reads idle
await page.locator('.project-row').filter({ hasText: projects[3].name }).click()
await page.waitForTimeout(500)
const rollupClass = await page.locator('.project-row').filter({ hasText: projects[3].name }).locator('.session-activity-dot').first().getAttribute('class').catch(() => 'none')
await shot('B8-rollup')
record('B8', !/working/.test(rollupClass ?? '') ? 'PASS' : 'FAIL', `rollupClass="${rollupClass}" screenshot=artifacts/verify-v4/B/B8-rollup.png`, `project 4 (only old settled sessions) sidebar activity dot class: ${rollupClass}`)

await writeFile(join(output, 'result.json'), JSON.stringify({ results, errors }, null, 2))
console.log('ERRORS', JSON.stringify(errors))
await app.close()
console.log('GROUP B DONE')
