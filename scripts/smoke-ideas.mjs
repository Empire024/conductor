// Ideas smoke (docs/ideas.md): capture from the title bar with no form, autosave, durability across
// a restart, the Idea Incubator seed, Create task provenance, and the local-only exploration refusal.
// Parked off-screen (CONDUCTOR_TEST_USER_DATA); build first, run through scripts/smoke-lock.mjs.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-ideas-'))
const output = resolve('artifacts/ideas')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_LOCAL_ROOT: join(root, 'no-local-models') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const results = { synthetic: true, checks: [], failures: [] }
const launch = async () => {
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.conductor?.ideas))
  await page.evaluate(() => window.conductor.settings.setZoom(1))
  return { app, page }
}

let { app, page } = await launch()
const errors = []
try {
  page.on('pageerror', error => errors.push(error.message))
  const project = await page.evaluate(() => window.conductor.projects.create('Ideas smoke'))
  await page.reload()
  await page.waitForFunction(() => Boolean(window.conductor?.ideas))

  await page.getByRole('button', { name: 'Ideas', exact: true }).first().click()
  await expect(page.locator('.ideas-view')).toBeVisible()
  await page.locator('.ideas-new').click()
  const editor = page.getByRole('textbox', { name: 'Idea', exact: true })
  await expect(editor).toBeFocused()
  await page.keyboard.type('Clothing drops by city\nEach European city gets one exclusive design')
  await expect.poll(async () => (await page.evaluate(() => window.conductor.ideas.list())).map(idea => idea.title), { timeout: 10000 }).toEqual(['Clothing drops by city'])
  const [idea] = await page.evaluate(() => window.conductor.ideas.list())
  assert.equal(idea.status, 'inbox')
  assert.equal(idea.workedOn, false)
  assert.equal(idea.capturedFrom, 'desktop')
  await expect(page.locator('.ideas-row-title').first()).toHaveText('Clothing drops by city')
  results.checks.push('The title-bar lightbulb opens Ideas; New idea puts the cursor in an empty note; typing autosaves and the title is inferred from the first line')
  await page.screenshot({ path: join(output, 'ideas-captured.png') })
  await page.keyboard.press('Escape')
  await expect(page.locator('.ideas-view')).toHaveCount(0)
  results.checks.push('Esc returns to the workspace')

  const link = await page.evaluate(({ ideaId, projectId }) => window.conductor.ideas.createTask({ ideaId, projectId }), { ideaId: idea.id, projectId: project.id })
  assert.equal(link.kind, 'task')
  assert.equal(link.createdFromIdeaId, idea.id)
  const backlog = await readFile(join(project.path, 'feature-list.md'), 'utf8')
  assert.match(backlog, /Clothing drops by city/)
  const detail = await page.evaluate(ideaId => window.conductor.ideas.get(ideaId), idea.id)
  assert.equal(detail.workedOn, true)
  assert.equal(detail.status, 'active')
  assert.ok(detail.events.some(event => event.kind === 'worked-on'))
  results.checks.push('Create task adds a Project task, links it with createdFromIdeaId and marks the idea worked on')

  const refusal = await page.evaluate(ideaId => window.conductor.ideas.explore({ ideaId }).then(() => 'started', error => String(error.message ?? error)), idea.id)
  assert.match(refusal, /local model/i)
  results.checks.push(`Exploration without a configured local model is refused, never sent to a cloud model: ${refusal.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)

  await app.close()
  ;({ app, page } = await launch())
  page.on('pageerror', error => errors.push(error.message))
  const after = await page.evaluate(ideaId => window.conductor.ideas.get(ideaId), idea.id)
  assert.equal(after.text, 'Clothing drops by city\nEach European city gets one exclusive design')
  assert.equal(after.links.filter(item => item.kind === 'task').length, 1)
  const schedules = await page.evaluate(projectId => window.conductor.orchestration.schedules.snapshot(projectId), project.id)
  const incubator = schedules.schedules.find(task => task.kind === 'idea-incubator')
  assert.ok(incubator, 'the Idea Incubator is seeded on the home project')
  assert.equal(incubator.timing, 'night')
  results.checks.push('After a restart the idea, its link and its timeline are intact, and the Idea Incubator is a night-time scheduled task on the home project')

  await page.getByRole('button', { name: 'Ideas', exact: true }).first().click()
  await page.locator('.ideas-row-title').first().click()
  await expect(page.getByRole('textbox', { name: 'Idea', exact: true })).toHaveValue(/Clothing drops by city/)
  await expect(page.locator('.ideas-panel')).toContainText('Worked on')
  await page.screenshot({ path: join(output, 'ideas-detail.png') })
  results.checks.push('Reopening shows the note, the worked-on state and the timeline')
  assert.deepEqual(errors, [])
} catch (error) {
  results.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, 'ideas-failed.png') }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'ideas-results.json'), JSON.stringify(results, null, 2))
  await app.close().catch(() => {})
}
console.log(JSON.stringify(results, null, 2))
