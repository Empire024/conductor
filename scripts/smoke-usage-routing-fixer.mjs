import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Real Electron/main/preload/React and the production Codex adapter over a raw synthetic
// App Server. The fixture reports account limits but never contacts a provider or infers.
const root = await mkdtemp(join(tmpdir(), 'conductor-usage-routing-fixer-'))
const output = resolve('artifacts/usage-routing-fixer')
await mkdir(output, { recursive: true })
const env = {
  ...process.env,
  CONDUCTOR_OFFLINE_TESTS: '1',
  CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_USAGE_ROUTING: '1',
  CONDUCTOR_TEST_CLAUDE_QUOTA: 'fable',
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'),
  CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS
delete env.CONDUCTOR_UPDATE_DEV

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15_000)
const results = { actualElectron: true, syntheticProvider: true, checks: [], errors: [], screenshots: [] }
page.on('pageerror', error => results.errors.push(error.stack ?? error.message))
const pass = message => { results.checks.push(message); console.log('PASS ' + message) }
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const events = id => page.evaluate(value => window.conductor.structured.events(value), id)
const board = projectId => page.evaluate(value => window.conductor.projectTasks.get(value), projectId)

try {
  await page.waitForFunction(() => Boolean(window.conductor?.projectTasks?.dispatch && window.conductor?.structured?.events))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
  await page.evaluate(async () => {
    await window.conductor.settings.setZoom(1)
    await window.conductor.settings.setThemeAuto(false)
    await window.conductor.settings.setThemeVariant('night')
  })
  const project = await page.evaluate(() => window.conductor.projects.create('Usage routing fixture'))
  await page.reload()
  await page.getByText(project.name, { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const codexPane = page.locator('.structured-agent-pane').first()
  const codexId = await codexPane.getAttribute('data-structured-session')
  assert.ok(codexId)
  await page.evaluate(id => window.conductor.structured.connect(id), codexId)
  await expect.poll(async () => (await snapshot(codexId)).capabilities?.models.map(model => model.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
  assert.equal((await snapshot(codexId)).settings.model, 'gpt-6-astra')

  await page.locator('.activity-rail').getByRole('button', { name: 'Project tasks', exact: true }).click()
  const title = 'Choose a provider and model with real remaining allowance'
  const input = page.getByRole('textbox', { name: 'New project task' })
  await input.fill(title)
  // Exercise the form's production submit path directly. The task-dispatch smoke owns
  // keyboard-shortcut coverage; this smoke is about the subsequent allowance decision.
  await page.getByRole('button', { name: 'Add task', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect.poll(async () => (await board(project.id)).tasks.some(item => item.title === title)).toBe(true)
  const task = (await board(project.id)).tasks.find(item => item.title === title)
  assert.ok(task)
  const row = page.locator(`.project-task[data-task-id="${task.id}"]`)
  await row.getByRole('checkbox').click()
  await page.getByRole('button', { name: 'Auto Fixer', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Auto Fixer', exact: true })
  await dialog.getByRole('button', { name: 'Start Auto Fixer', exact: true }).click()
  await expect(dialog).toContainText('Sent to agent tab')

  const assigned = (await board(project.id)).tasks.find(item => item.id === task.id)
  assert.ok(assigned?.agentId)
  const fixer = await snapshot(assigned.agentId)
  assert.equal(fixer.settings.model, 'gpt-5.6-sol')
  assert.equal(fixer.settings.effort, 'high')
  const refreshEvents = await events(codexId)
  assert.ok(refreshEvents.some(event => event.native?.method === 'account/rateLimits/read'))
  assert.ok(refreshEvents.some(event => event.data.type === 'usage' && event.data.limits?.rateLimitsByLimitId?.['gpt-6-astra']))
  assert.equal(refreshEvents.some(event => event.native?.method === 'turn/start'), false)
  pass('Auto Fixer performs a zero-turn account/rateLimits/read and selects GPT-5.6 Sol high instead of the 99%-used default Astra bucket')

  await dialog.getByRole('button', { name: 'Open tab', exact: true }).click()
  await expect(page.locator(`[data-structured-session="${assigned.agentId}"]`)).toBeVisible()
  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  const screenshot = join(output, 'auto-fixer-sol.png')
  await writeFile(screenshot, Buffer.from(image, 'base64'))
  results.screenshots.push('artifacts/usage-routing-fixer/auto-fixer-sol.png')

  await page.locator('.pane-add-tab').first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const claudePane = page.locator('.structured-agent-pane[data-provider="claude"]')
  await expect(claudePane).toBeVisible()
  const claudeId = await claudePane.getAttribute('data-structured-session')
  assert.ok(claudeId)
  await page.evaluate(id => window.conductor.structured.connect(id), claudeId)
  await expect.poll(async () => (await snapshot(claudeId)).capabilities?.models[0]?.id).toBe('claude-fable-5-1')
  const modelPicker = claudePane.getByRole('combobox', { name: 'Model', exact: true })
  const beforeModel = { label: await modelPicker.innerText(), settings: (await snapshot(claudeId)).settings }
  await modelPicker.click()
  const modelSearch = page.getByRole('textbox', { name: 'Search models', exact: true })
  await modelSearch.fill('Fable')
  await modelSearch.press('Enter')
  await expect(modelPicker).toContainText('Fable')
  await expect.poll(async () => (await snapshot(claudeId)).settings.model).toBe('claude-fable-5-1')
  const claudeEvents = await events(claudeId)
  assert.ok(claudeEvents.some(event => event.native?.method === 'rate_limit_event'))
  assert.equal(claudeEvents.some(event => event.data.type === 'text' && event.data.role === 'user'), false)
  results.claudeModelTransition = {
    before: beforeModel,
    after: { label: await modelPicker.innerText(), settings: (await snapshot(claudeId)).settings },
    nativeIdentity: claudeEvents.some(event => event.native?.method === 'system/init'),
    userTurns: claudeEvents.filter(event => event.data.type === 'text' && event.data.role === 'user').length
  }
  await claudePane.getByRole('button', { name: 'View usage', exact: true }).click()
  const usage = page.getByRole('dialog', { name: 'Usage', exact: true })
  await expect(usage).toContainText('Fable weekly')
  await expect(usage).toContainText('99% used')
  const fableScreenshot = join(output, 'fable-weekly-limit.png')
  await page.screenshot({ path: fableScreenshot, fullPage: true })
  results.screenshots.push('artifacts/usage-routing-fixer/fable-weekly-limit.png')
  pass('Claude raw rate_limit_event renders seven_day_overage_included as the Fable weekly limit, without a paid or synthetic model turn')
  assert.deepEqual(results.errors, [])
} catch (error) {
  results.errors.push(error.stack ?? String(error))
  process.exitCode = 1
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {})
  results.failureDom = await page.locator('body').innerText().catch(() => null)
} finally {
  await app.close()
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
}
