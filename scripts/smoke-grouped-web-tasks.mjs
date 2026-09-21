import { _electron as electron, chromium, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp } from './smoke-fixture-cleanup.mjs'

// Build-dependent serial smoke. It launches real Electron and installed Chrome, so run it only
// after the shared Electron smoke slot grants this exact script.
const root = await mkdtemp(join(tmpdir(), 'conductor-grouped-web-'))
const profile = join(root, 'profile')
const projectsRoot = join(root, 'projects')
const output = resolve('artifacts/grouped-web-tasks')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: projectsRoot }
env.CONDUCTOR_TEST_CLAUDE_USAGE = '1'
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const desktop = await app.firstWindow()
desktop.setDefaultTimeout(25000)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
const phone = await context.newPage()
phone.setDefaultTimeout(25000)
const checks = []
const check = label => { checks.push(label); console.log('PASS ' + label) }
const until = async (read, predicate, label, timeout = 30000) => {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value).slice(0, 500)}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
const call = (origin, path, { token, body } = {}) => new Promise((resolve, reject) => {
  const url = new URL(path, origin)
  const req = httpsRequest({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text) } catch {} resolve({ status: response.statusCode, text, json }) })
  })
  req.once('error', reject)
  req.setTimeout(15000, () => req.destroy(new Error(`Fixture request timed out: ${path}`)))
  if (body !== undefined) req.write(JSON.stringify(body))
  req.end()
})
const api = async (origin, path, options = {}) => {
  const reply = await call(origin, path, options)
  assert.equal(reply.status, 200, `${path}: ${reply.text}`)
  return reply.json
}

try {
  await desktop.waitForFunction(() => Boolean(window.conductor?.phone && window.conductor?.projectTasks))
  const project = await desktop.evaluate(() => window.conductor.projects.create('Grouped web smoke'))
  await desktop.reload()
  await desktop.locator('.project-row').filter({ hasText: 'Grouped web smoke' }).click()
  const listener = await desktop.evaluate(() => window.conductor.phone.setSettings({ enabled: true, port: 0 }))
  assert.ok(listener.listening && listener.primaryEndpoint)
  const origin = `https://127.0.0.1:${new URL(listener.primaryEndpoint).port}`
  const pairing = await desktop.evaluate(() => window.conductor.phone.pair())

  // Pair in the shipped web app, using installed Chrome rather than a request-only client.
  await phone.goto(`${origin}/#pair=${encodeURIComponent(pairing.pairing.code)}`)
  await phone.getByLabel('Name this phone').fill('Grouped web smoke phone')
  await phone.getByRole('button', { name: 'Pair', exact: true }).click()
  await expect(phone.locator('.tabbar')).toBeVisible()
  const token = await phone.evaluate(() => localStorage.getItem('conductor.phone.token'))
  assert.ok(token)
  check('Installed headless Chrome pairs through the real HTTPS phone UI and authenticated listener')

  const state = await api(origin, '/api/state', { token })
  const phoneProject = state.projects.find(entry => entry.id === project.id)
  const claude = state.providers.find(entry => entry.id === 'claude')
  assert.ok(phoneProject?.workspaces[0] && claude?.models[0])
  const open = async title => {
    const current = await api(origin, '/api/state', { token })
    const model = current.providers.find(entry => entry.id === 'claude').models[0].id
    return api(origin, '/api/tabs/open', { token, body: { projectId: project.id, workspaceId: phoneProject.workspaces[0].id, machineId: phoneProject.machineId, provider: 'claude', model, title, prompt: `SYNTHETIC B ${title} weekly usage` } })
  }
  const main = await open('Stable main')
  await until(() => api(origin, `/api/sessions/${main.sessionId}`, { token }), value => value.summary.state === 'done', 'main conversation')
  const child = await open('Stable child')
  await until(() => api(origin, `/api/sessions/${child.sessionId}`, { token }), value => value.summary.state === 'done', 'child conversation')

  await phone.reload()
  await expect(phone.locator('.session-title')).toHaveCount(2)
  const before = await phone.locator('.session-title').allTextContents()
  await api(origin, `/api/sessions/${child.sessionId}/message`, { token, body: { text: 'SYNTHETIC B activity must not reorder me', mode: 'auto' } })
  await expect(phone.locator('.session-title').filter({ hasText: 'Stable child' }).first()).toBeVisible()
  const during = await phone.locator('.session-title').allTextContents()
  assert.deepEqual(during, before)
  check('Phone conversation order remains stable while a later conversation becomes active')
  await until(() => api(origin, `/api/sessions/${child.sessionId}`, { token }), value => value.summary.state === 'done', 'child follow-up completion')

  // Install the same durable control link the production grant path writes. Reloading exercises
  // both main-process link reads and the phone's controllerId projection without test-only IPC.
  const db = new DatabaseSync(join(profile, 'conductor.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  const link = { projectId: project.id, sessionId: phoneProject.workspaces[0].id, controllerAgentSessionId: main.sessionId, targetAgentSessionId: child.sessionId, controllerTabId: main.tabId, controlledTabId: child.tabId, controllerTitle: 'Stable main', controlledTitle: 'Stable child' }
  db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`agentControlParent:${child.sessionId}`, JSON.stringify(link), new Date().toISOString())
  db.close()
  await desktop.reload()
  await phone.reload()
  const toggle = phone.locator('.coworker-toggle').filter({ hasText: '1 coworker' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(phone.locator('.coworker-session')).toHaveCount(0)
  await toggle.click()
  await expect(phone.locator('.coworker-session').filter({ hasText: 'Stable child' })).toBeVisible()
  check('Phone coworkers are compact under their main conversation and expand on demand')

  // Create through the phone form, then verify both durable disk scope and the desktop bridge.
  await phone.locator('[data-tab="new"]').click()
  await phone.getByRole('button', { name: 'Project task', exact: true }).click()
  const taskTitle = 'Phone-created scoped production task'
  await phone.getByRole('textbox', { name: /^Task/ }).fill(taskTitle)
  await phone.getByLabel('Type').selectOption('feature')
  await phone.getByLabel('Priority').selectOption('high')
  await phone.getByLabel('Weight').selectOption('light')
  await phone.getByRole('button', { name: 'Add project task', exact: true }).click()
  await expect(phone.locator('[data-tab="sessions"].active')).toBeVisible()
  const disk = await readFile(join(project.path, 'feature-list.md'), 'utf8')
  assert.match(disk, /## Features[\s\S]*- \[ \] Phone-created scoped production task <!-- conductor-task:/)
  const board = await desktop.evaluate(id => window.conductor.projectTasks.get(id), project.id)
  assert.ok(board.tasks.some(task => task.title === taskTitle && task.kind === 'feature' && task.priority === 'high' && task.weight === 'light'))
  check('Phone project task creation is authenticated, project scoped, durable on disk, and visible through the desktop backlog bridge')

  // The service deliberately caches for 30 seconds; a fresh page after that boundary proves the
  // shared weekly report is made from durable completed usage rather than allowance labels.
  await new Promise(resolve => setTimeout(resolve, 31000))
  await phone.reload()
  await phone.locator('[data-tab="system"]').click()
  const weekly = phone.getByText('Last 7 days by model', { exact: true })
  await expect(weekly).toBeVisible()
  const weeklyCard = weekly.locator('..')
  await expect(weeklyCard).toContainText('tokens')
  await expect(weeklyCard).toContainText('conversation')
  check('Phone System renders actual seven-day by-model token totals from the shared cached service')

  // Desktop rendering reads the same durable link. It should compact without layout mutations,
  // keep the active child visible, and leave the existing role marker portal intact.
  await expect(desktop.locator('.coworker-tab-group')).toBeVisible({ timeout: 10000 })
  const desktopToggle = desktop.locator('.coworker-tab-toggle').first()
  await expect(desktopToggle).toHaveAttribute('aria-expanded', 'false')
  await desktopToggle.click()
  await expect(desktop.locator(`[data-control-tab-id="${child.tabId}"]`)).toBeVisible()
  await desktop.locator(`[data-control-tab-id="${main.tabId}"]`).click()
  await desktop.getByRole('button', { name: 'Conversation history' }).click()
  await expect(desktop.locator('.sa-history-list')).toContainText('Stable main')
  await expect(desktop.locator('.sa-history-list .sa-history-copy em').first()).toContainText('Synthetic fixture continuation')
  await expect(desktop.locator('.sa-history-list time').first()).not.toHaveText('No activity recorded')
  check('Desktop tabs compact coworkers and conversation history shows durable activity, model/status metadata, and snippets')

  await phone.screenshot({ path: join(output, 'phone-system.png'), fullPage: true })
  await desktop.screenshot({ path: join(output, 'desktop-groups.png') })
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, inference: 'synthetic provider process; real Electron, HTTPS listener, Chrome UI, database, and project file' }, null, 2))
} catch (error) {
  console.error(error)
  await phone.screenshot({ path: join(output, 'failure-phone.png'), fullPage: true }).catch(() => {})
  await desktop.screenshot({ path: join(output, 'failure-desktop.png') }).catch(() => {})
  await writeFile(join(output, 'failure.json'), JSON.stringify({ checks, error: String(error) }, null, 2))
  throw error
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  await desktop.evaluate(() => window.conductor.phone.setSettings({ enabled: false })).catch(() => {})
  await cleanupFixtureApp(app, {}, 'grouped web smoke cleanup')
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
