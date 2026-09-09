import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Offline check for two composer regressions, against the real app and the synthetic Claude
// runtime: the chosen model/effort must survive leaving the project and coming back, and
// previewing or resuming a saved conversation must not leave a second ask/model/effort row
// behind (React keeps only the last of same-keyed siblings and orphans the rest of the DOM).
const root = await mkdtemp(join(tmpdir(), 'conductor-composer-'))
const output = resolve('artifacts/composer-settings')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { synthetic: true, root, checks: [], screenshots: [] }
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night') })
  const project = await page.evaluate(() => window.conductor.projects.create('Composer alpha'))
  await page.evaluate(() => window.conductor.projects.create('Composer beta'))
  // Two saved conversation tabs: one to configure and leave, one to preview from its history.
  await page.evaluate(async projectId => {
    const [session] = await window.conductor.sessions.list(projectId)
    const layout = JSON.parse(JSON.stringify(session.layout))
    const find = node => Array.isArray(node?.tabs) ? node : (node?.children ?? []).map(find).find(Boolean)
    const group = find(layout.root)
    const tab = (id, title) => ({ id: 'pane-' + id, kind: 'agent', title, resourceId: 'agent-' + id, state: { provider: 'claude', resume: false, model: 'default', effort: 'auto' } })
    group.tabs = [tab('one', 'Claude one'), tab('two', 'Claude two')]
    group.activeTabId = 'pane-one'
    await window.conductor.sessions.save(session.id, layout, session.maximizedGroupId, session.closedTabs)
  }, project.id)
  await page.reload()
  await page.getByText('Composer alpha', { exact: true }).first().click()
  await page.locator('.structured-agent-pane').first().waitFor()
  const visible = page.locator('.pane-tab-content:visible')
  const sessionId = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
  const snapshot = id => page.evaluate(agent => window.conductor.structured.snapshot(agent), id)
  const counts = async () => ({
    mode: await visible.getByRole('button', { name: 'Conversation mode', exact: true }).count(),
    model: await visible.getByRole('combobox', { name: 'Model', exact: true }).count(),
    effort: await visible.getByRole('slider', { name: 'Reasoning effort', exact: true }).count(),
    panes: await visible.locator('.structured-agent-pane').count(),
    uploads: await visible.locator('.sa-image-upload').count()
  })
  const turn = async text => {
    await visible.getByRole('combobox', { name: 'Model', exact: true }).click()
    await page.getByRole('option').first().click()
    await visible.getByRole('textbox', { name: /message/i }).fill(text)
    await visible.getByRole('button', { name: 'Send message', exact: true }).click()
  }

  await page.locator('.pane-tab').filter({ hasText: 'Claude two' }).click()
  const otherId = await visible.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await turn('SYNTHETIC B: second conversation.')
  await expect.poll(async () => (await snapshot(otherId))?.phase, { timeout: 20_000 }).toBe('completed')
  await page.locator('.pane-tab').filter({ hasText: 'Claude one' }).click()

  // Choose a model and effort from the runtime's own catalog, with no message sent.
  await visible.getByRole('combobox', { name: 'Model', exact: true }).click()
  await expect.poll(async () => Boolean((await snapshot(sessionId))?.capabilities?.models?.length), { timeout: 20_000 }).toBe(true)
  await page.getByRole('option').first().click()
  const slider = () => visible.getByRole('slider', { name: 'Reasoning effort', exact: true })
  await slider().press('Home')
  await slider().press('ArrowRight')
  const chosenEffort = await slider().getAttribute('aria-valuetext')
  const chosenModel = await visible.getByRole('combobox', { name: 'Model', exact: true }).textContent()
  assert.equal((await snapshot(sessionId)).settings.effort, chosenEffort.toLowerCase())

  await page.getByText('Composer beta', { exact: true }).first().click()
  await expect.poll(async () => await page.locator('.structured-agent-pane').count()).toBe(0)
  await page.getByText('Composer alpha', { exact: true }).first().click()
  await page.locator('.structured-agent-pane').first().waitFor()
  await expect(slider()).toHaveAttribute('aria-valuetext', chosenEffort)
  await expect(visible.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(chosenModel)
  results.checks.push('Model and effort chosen without sending a message survive leaving the project and returning')

  await turn('SYNTHETIC B: first conversation.')
  await expect.poll(async () => (await snapshot(sessionId))?.phase, { timeout: 20_000 }).toBe('completed')
  const before = await counts()
  assert.deepEqual(before, { mode: 1, model: 1, effort: 1, panes: 1, uploads: 1 })
  await visible.getByRole('button', { name: 'Conversation history', exact: true }).click()
  await page.locator('.sa-history-list button').filter({ hasText: 'second conversation' }).first().click()
  await expect(visible.getByRole('button', { name: /Resume this conversation/ })).toBeVisible()
  assert.deepEqual(await counts(), before, 'previewing a saved conversation duplicated the composer controls')
  await visible.getByRole('button', { name: /Resume this conversation/ }).click()
  await expect.poll(async () => (await visible.locator('.structured-agent-pane').getAttribute('data-structured-session'))).toBe(otherId)
  await expect.poll(counts).toEqual(before)
  await page.screenshot({ path: join(output, 'after-resume.png'), fullPage: true })
  results.screenshots.push('artifacts/composer-settings/after-resume.png')
  results.checks.push('Previewing and resuming a saved conversation keeps one ask, model and effort control')
  assert.deepEqual(errors, [])
} finally {
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
