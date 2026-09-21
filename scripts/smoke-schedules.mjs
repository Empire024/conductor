import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

// Must only be launched after the controller grants this exact script an Electron slot.
const root = await mkdtemp(join(tmpdir(), 'conductor-schedules-smoke-'))
const output = resolve('artifacts/schedules-smoke')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS; delete env.CONDUCTOR_UPDATE_DEV
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
const result = { actualElectron: true, checks: [], errors: [] }
const check = label => { result.checks.push(label); console.log('PASS ' + label) }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.orchestration?.schedules))
  const project = await page.evaluate(() => window.conductor.projects.create('Schedules smoke'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: project.name }).click()
  await page.locator('.activity-rail').getByRole('button', { name: 'Schedules', exact: true }).click()
  await expect(page.getByText('Checks official model and runtime updates')).toBeVisible()
  await page.getByRole('button', { name: 'Add latest models check', exact: true }).click()
  await expect(page.getByText('Latest models and methods', { exact: true })).toBeVisible()
  check('Schedules opens as a real utility view and creates only the fixed latest-models job')

  const interval = page.getByRole('spinbutton', { name: 'Interval for Latest models and methods' })
  await interval.fill('30')
  assert.equal((await page.evaluate(id => window.conductor.orchestration.schedules.snapshot(id), project.id)).schedules[0].everyMinutes, 1_440)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(interval).toHaveValue('30')
  assert.equal((await page.evaluate(id => window.conductor.orchestration.schedules.snapshot(id), project.id)).schedules[0].everyMinutes, 30)
  check('A multi-digit interval remains editable and persists only on Save or blur')

  await page.getByRole('checkbox', { name: 'Enabled', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Enabled', exact: true })).not.toBeChecked()
  await expect(page.getByText('Never', { exact: true }).first()).toBeVisible()
  assert.equal((await page.evaluate(id => window.conductor.orchestration.schedules.snapshot(id), project.id)).schedules[0].enabled, false)
  check('Enabled control persists and disabled schedules have no next run')

  await page.getByRole('button', { name: 'Run now', exact: true }).click()
  const terminal = await page.evaluate(async projectId => {
    const deadline = Date.now() + 70_000
    while (Date.now() < deadline) {
      const snapshot = await window.conductor.orchestration.schedules.snapshot(projectId)
      const schedule = snapshot.schedules[0], run = schedule && snapshot.runs[schedule.id]?.[0]
      if (run && run.outcome !== 'running') return run
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('Run now did not produce terminal history within 70 seconds')
  }, project.id)
  assert.ok(['changed', 'unchanged', 'stale'].includes(terminal.outcome), `Run now ended with ${terminal.outcome}: ${terminal.detail}`)
  assert.notEqual(terminal.outcome, 'failed')
  assert.ok(terminal.finishedAt, 'terminal history has no finish time')
  assert.ok(terminal.detail.trim(), 'terminal history has no readable summary')
  await expect(page.getByText(terminal.outcome, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(terminal.detail, { exact: true })).toBeVisible()
  check(`Run now executes a disabled schedule through IPC and records readable ${terminal.outcome} history`)

  assert.ok(terminal.artifactPath, `${terminal.outcome} run did not save an evidence artifact`)
  const artifactPath = resolve(terminal.artifactPath)
  assert.ok(artifactPath.startsWith(resolve(env.CONDUCTOR_TEST_USER_DATA) + '\\'), 'evidence path escaped the isolated profile')
  assert.ok((await stat(artifactPath)).isFile(), 'saved evidence path is not a file')
  const evidence = JSON.parse(await readFile(artifactPath, 'utf8'))
  assert.equal(evidence.digest, terminal.digest)
  assert.ok(Array.isArray(evidence.evidence) && evidence.evidence.length > 0, 'saved evidence has no source records')
  assert.ok(evidence.evidence.every(item => typeof item.source === 'string' && typeof item.summary === 'string' && typeof item.status === 'string'), 'saved source evidence is not readable')
  check('The run saves valid JSON evidence at its real isolated artifact path')

  const sqlite = new DatabaseSync(join(env.CONDUCTOR_TEST_USER_DATA, 'conductor.db'), { readOnly: true })
  try {
    const turns = sqlite.prepare('SELECT COUNT(*) AS count FROM structured_events').get().count
    assert.equal(turns, 0, 'schedule unexpectedly created structured model-turn events')
  } finally { sqlite.close() }
  check('The scheduler run creates no model turn')

  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  await writeFile(join(output, 'schedules.png'), Buffer.from(image, 'base64'))
} catch (error) {
  result.errors.push(error.stack ?? String(error)); process.exitCode = 1
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
