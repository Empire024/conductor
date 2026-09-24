import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Logic loops v2 (docs/logic-loops.md): the Logic loops section inside Project tasks and
// Scheduled tasks, backed by the loops.* app-control methods a real agent would call.
//
//   npm run build && node scripts/smoke-lock.mjs -- node scripts/smoke-logic-loops.mjs
const root = await mkdtemp(join(tmpdir(), 'conductor-logic-loops-smoke-'))
const output = resolve('artifacts/logic-loops-smoke')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_UPDATE_DEV
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
const result = { actualElectron: true, checks: [], errors: [] }
const check = label => { result.checks.push(label); console.log('PASS ' + label) }
const control = async (method, args, projectId) => {
  const credential = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const response = await fetch(credential.endpoint, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args, scope: { projectId } }) })
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${body.error}`)
  return body.result
}
const loopSource = `---
id: smoke
version: 1
title: Smoke loop
trigger: [manual]
inputs: []
steps:
  - id: implement
    role: implementer
    model: claude:sonnet
    effort: high
---

# Smoke loop

## Run log

- seed
`

try {
  await page.waitForFunction(() => Boolean(window.conductor?.logicLoops))
  const project = await page.evaluate(() => window.conductor.projects.create('Loop panel smoke'))
  await mkdir(join(project.path, '.conductor', 'loops'), { recursive: true })
  await writeFile(join(project.path, '.conductor', 'loops', 'smoke.md'), loopSource)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()

  await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  const loopsToggle = page.locator('.logic-loops-toggle')
  await expect(loopsToggle).toBeVisible()
  await expect(loopsToggle).toContainText('1')
  await loopsToggle.click()
  await expect(page.getByText('Smoke loop')).toBeVisible()
  await expect(page.getByText('v1', { exact: true })).toBeVisible()
  await expect(page.getByText('No recorded runs yet.')).toBeVisible()
  check('Project tasks shows the Logic loops section with the seeded loop, collapsed by default')

  const planned = await control('loops.run', { id: 'smoke', inputs: {} }, project.id)
  await control('loops.record', { runId: planned.runId, stepId: 'implement', model: 'claude:sonnet', startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(), outcome: 'success', tokens: { total: 512 } }, project.id)
  const change = loopSource.replace('model: claude:sonnet', 'model: claude:opus[1m]')
  const proposal = await control('loops.propose', { id: 'smoke', change, evidence: 'Opus passed review in recent runs', metric: 'tokens' }, project.id)

  await page.getByRole('button', { name: 'Close workspace view', exact: true }).click()
  await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  await page.locator('.logic-loops-toggle').click()
  await expect(page.getByText('implement · claude:sonnet', { exact: false })).toBeVisible()
  await expect(page.getByText('success', { exact: false })).toBeVisible()
  await expect(page.getByText('Opus passed review in recent runs')).toBeVisible()
  check('A recorded run and a pending proposal from app control appear after reopening the panel')

  await page.getByRole('button', { name: 'Close workspace view', exact: true }).click()
  await page.locator('.activity-rail').getByRole('button', { name: 'Scheduled tasks', exact: true }).click()
  await page.locator('.logic-loops-toggle').click()
  await expect(page.getByText('Opus passed review in recent runs')).toBeVisible()
  check('The same Logic loops data appears in Scheduled tasks')

  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByText('Opus passed review in recent runs')).toHaveCount(0)
  await expect(page.getByText('v2', { exact: true })).toBeVisible()
  const written = await readFile(join(project.path, '.conductor', 'loops', 'smoke.md'), 'utf8')
  assert.match(written, /version: 2/)
  assert.match(written, /model: claude:opus\[1m\]/)
  assert.match(written, /loops\.apply/)
  check('Apply in the panel bumps the loop file version and writes the proposed change')

  const rejectable = await control('loops.propose', { id: 'smoke', change: written.replace('model: claude:opus[1m]', 'model: claude:haiku'), evidence: 'try haiku instead' }, project.id)
  await page.getByRole('button', { name: 'Close workspace view', exact: true }).click()
  await page.locator('.activity-rail').getByRole('button', { name: 'Scheduled tasks', exact: true }).click()
  await page.locator('.logic-loops-toggle').click()
  await expect(page.getByText('try haiku instead')).toBeVisible()
  await page.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(page.getByText('try haiku instead')).toHaveCount(0)
  const proposals = await control('loops.proposals', { id: 'smoke' }, project.id)
  assert.equal(proposals.find(entry => entry.id === rejectable.id)?.status, 'rejected')
  assert.equal(proposals.find(entry => entry.id === proposal.id)?.status, 'applied')
  check('Reject in the panel marks the proposal rejected without touching the loop file')

  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, 'logic-loops.png'), Buffer.from(image, 'base64'))
} catch (error) {
  result.errors.push(error.stack ?? String(error)); process.exitCode = 1
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
