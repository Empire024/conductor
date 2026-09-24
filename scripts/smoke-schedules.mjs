import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// Scheduled tasks end to end in the built app (docs/schedules.md), parked off-screen under
// CONDUCTOR_TEST_USER_DATA. The panel creates a task, the owner's app-control credential gives it
// a script (as an agent would with schedules.scripts.save), Run now executes it twice: the first
// run's output is new evidence, the second is unchanged and asks no model anything. The local
// model root points at an empty folder, so no llama.cpp server can start, and the task has no
// assigned agent, so no frontier turn can start either.
//
//   npm run build && node scripts/smoke-lock.mjs -- node scripts/smoke-schedules.mjs
const root = await mkdtemp(join(tmpdir(), 'conductor-schedules-smoke-'))
const output = resolve('artifacts/schedules-smoke')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
  // A root on a non-system drive that holds no configuration: the churn step reports "no local
  // model is set up" instead of starting the owner's real server.
  CONDUCTOR_LOCAL_ROOT: 'D:\\conductor-schedules-smoke-no-local-models'
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_UPDATE_DEV
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
const result = { actualElectron: true, checks: [], errors: [] }
const check = label => { result.checks.push(label); console.log('PASS ' + label) }
const snapshot = projectId => page.evaluate(id => window.conductor.orchestration.schedules.snapshot(id), projectId)
const control = async (method, args, projectId) => {
  const credential = JSON.parse(await readFile(join(profile, 'control-owner.json'), 'utf8'))
  const response = await fetch(credential.endpoint, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args, scope: { projectId } }) })
  const body = await response.json()
  if (body.error) throw new Error(`${method}: ${body.error}`)
  return body.result
}
/** The newest manual run once `count` manual runs have finished. Counting manual runs keeps the
 *  smoke exact even if the scheduler itself started a run in the second before the task was paused. */
const waitForRun = (projectId, count) => page.evaluate(async ({ projectId, count }) => {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const current = await window.conductor.orchestration.schedules.snapshot(projectId)
    const runs = (current.runs[current.schedules[0].id] ?? []).filter(run => run.trigger === 'manual' && run.outcome !== 'skipped')
    if (runs.length >= count && runs[0].outcome !== 'running' && !current.running) return runs[0]
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Run ${count} did not finish within 90 seconds`)
}, { projectId, count })

try {
  await page.waitForFunction(() => Boolean(window.conductor?.orchestration?.schedules))
  const project = await page.evaluate(() => window.conductor.projects.create('Schedules smoke'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()
  await page.locator('.activity-rail').getByRole('button', { name: 'Scheduled tasks', exact: true }).click()
  await expect(page.getByText('No scheduled tasks yet.')).toBeVisible()
  check('Scheduled tasks opens as a utility view with an empty state that names asking an agent')

  await page.getByRole('button', { name: 'New task', exact: true }).click()
  const form = page.locator('form.schedule-form').first()
  await form.getByLabel('Name').fill('Smoke version watch')
  await form.getByLabel(/^Goal/).fill('Tell me when the version file changes.')
  await form.getByLabel('Cadence amount').fill('6')
  await form.getByLabel('Cadence unit').selectOption('hours')
  await form.getByLabel('Provider').selectOption('')
  await form.getByRole('button', { name: 'Create task', exact: true }).click()
  const card = page.getByRole('region', { name: 'Scheduled task Smoke version watch' })
  await expect(card).toBeVisible()
  let current = await snapshot(project.id)
  const task = current.schedules[0]
  assert.equal(current.schedules.length, 1)
  assert.equal(task.everyMinutes, 360)
  assert.equal(task.agent, null)
  assert.equal(task.createdBy.kind, 'owner')
  assert.ok(task.nextDueAt && Date.parse(task.nextDueAt) <= Date.now(), 'a new task should be due at once')
  check('The panel creates a task that is due at once, with the owner as creator and no agent')

  // Paused, so the scheduler's own tick cannot start runs beside the ones this smoke asks for.
  await card.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(card.locator('.schedule-chip', { hasText: 'Paused' })).toBeVisible()
  current = await snapshot(project.id)
  assert.equal(current.schedules[0].enabled, false)
  assert.equal(current.schedules[0].nextDueAt, null)
  check('Pause persists and a paused task has no next run')

  const listed = await control('schedules.list', {}, project.id)
  assert.equal(listed[0].id, task.id)
  const versionFile = join(root, 'version.txt')
  await writeFile(versionFile, 'version: 1.0.0\n')
  const script = `import { readFileSync } from 'node:fs'\nprocess.stdout.write(readFileSync(${JSON.stringify(versionFile)}, 'utf8'))\n`
  await control('schedules.scripts.save', { taskId: task.id, name: 'version', content: script, description: 'The version file' }, project.id)
  await expect(card.locator('.schedule-scripts > summary .schedule-count')).toHaveText('1')
  await card.locator('.schedule-scripts > summary').click()
  await expect(card.locator('.schedule-scripts').getByText('version', { exact: true }).first()).toBeVisible()
  assert.deepEqual((await snapshot(project.id)).scripts[task.id].map(script => script.name), ['version'])
  check('The owner credential lists tasks and saves a script through schedules.*, and the panel shows it')

  await card.getByRole('button', { name: 'Run now', exact: true }).click()
  const first = await waitForRun(project.id, 1)
  assert.equal(first.outcome, 'changed', `first run: ${first.outcome}: ${first.detail}`)
  assert.equal(first.trigger, 'manual')
  assert.equal(first.scripts[0].status, 'ok')
  assert.equal(first.churn?.ok, false, 'no local model should have run')
  assert.equal(first.brain, null)
  assert.ok(first.detail.includes('version: 1.0.0'), 'the deterministic diff should carry the output')
  const artifactPath = resolve(first.artifactPath)
  assert.ok(artifactPath.startsWith(resolve(profile) + '\\'), 'evidence path escaped the isolated profile')
  assert.ok((await stat(artifactPath)).isFile(), 'saved evidence path is not a file')
  assert.ok((await readFile(artifactPath, 'utf8')).includes('## Scripts'), 'the report has no scripts table')
  await expect(card.getByText('changed', { exact: true }).first()).toBeVisible()
  check('Run now executes the script, reports the new output as a plain diff without a local model, and saves a report')

  await card.getByRole('button', { name: 'Run now', exact: true }).click()
  const second = await waitForRun(project.id, 2)
  assert.equal(second.outcome, 'unchanged', `second run: ${second.outcome}: ${second.detail}`)
  assert.ok(second.detail.includes('No model was asked anything'))
  assert.equal(second.artifactPath, null)
  check('An unchanged second run ends without asking any model and saves no report')

  await writeFile(versionFile, 'version: 1.1.0\n')
  await card.getByRole('button', { name: 'Run now', exact: true }).click()
  const third = await waitForRun(project.id, 3)
  assert.equal(third.outcome, 'changed')
  assert.ok(third.detail.includes('- version: 1.0.0') && third.detail.includes('+ version: 1.1.0'), third.detail)
  check('A changed output is reported as the lines that moved')

  const sqlite = new DatabaseSync(join(profile, 'conductor.db'), { readOnly: true })
  try {
    const turns = sqlite.prepare('SELECT COUNT(*) AS count FROM structured_events').get().count
    assert.equal(turns, 0, 'the scheduled runs unexpectedly created model-turn events')
  } finally { sqlite.close() }
  check('No scheduled run started a model turn')

  await card.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(card.locator('.schedule-chip', { hasText: 'Paused' })).toHaveCount(0)
  assert.ok((await snapshot(project.id)).schedules[0].nextDueAt, 'a resumed task has a next run')
  check('Resume schedules the task again')

  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, 'schedules.png'), Buffer.from(image, 'base64'))

  page.once('dialog', dialog => void dialog.accept())
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('No scheduled tasks yet.')).toBeVisible()
  assert.equal((await snapshot(project.id)).schedules.length, 0)
  check('Delete asks, then removes the task')
} catch (error) {
  result.errors.push(error.stack ?? String(error)); process.exitCode = 1
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
