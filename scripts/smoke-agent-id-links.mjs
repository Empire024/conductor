import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// feature-list.md agent-id-links-and-messages: find a tab by agent id, auto-link ids in
// conversations, and show agent-to-agent messages as cards. A fixture controller in project A opens
// a coworker in project B and messages it over app control; then:
//   1. Ctrl+K finds the coworker (another project) by a fragment of its agent id and jumps to it;
//   2. the coworker's id in the controller's conversation renders as a link that focuses it;
//   3. the controller shows a "sent to" card and the coworker a "from" card, both collapsed;
//   4. once the coworker is detached into its own window, Ctrl+K in either window finds the tab in
//      the other one and raises that window.
// Real Electron and control broker; only the provider CLI is the synthetic fixture, so no inference
// happens. CONDUCTOR_TEST_USER_DATA parks the window off every display.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-agent-id-links.mjs
// CONDUCTOR_SMOKE_MAIN points at another build's main entry (default out/main/index.js).
const root = await mkdtemp(join(tmpdir(), 'conductor-agent-links-smoke-'))
const output = resolve('.conductor-scratch/agent-id-links')
await mkdir(output, { recursive: true })
const capture = join(root, 'provider-input.txt')
const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_CONTROL_CAPTURE: capture, CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath,
  CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_TEST_FIXTURE_DIR: resolve('scripts/fixtures')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS

const app = await electron.launch({ args: [resolve(process.env.CONDUCTOR_SMOKE_MAIN ?? 'out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = [], checks = [], shots = []
page.on('pageerror', error => { if (error.message !== 'Canceled') errors.push(error.message) })
const check = label => { checks.push(label); console.log('PASS ' + label) }
const shot = async name => { const path = join(output, name); await page.screenshot({ path }); shots.push(path) }
const credentials = async () => {
  const briefing = await readFile(capture, 'utf8')
  const endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1]
  const token = briefing.match(/Bearer ([a-f0-9]{64})/)?.[1]
  assert.ok(endpoint && token, 'Native provider must receive the protocol briefing')
  return { endpoint, token }
}
const raw = async (auth, method, args = {}) => {
  const response = await fetch(auth.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return { status: response.status, payload: await response.json() }
}
const call = async (auth, method, args = {}) => {
  const { status, payload } = await raw(auth, method, args)
  assert.equal(status, 200, method + ': ' + JSON.stringify(payload))
  return payload.result
}
const snapshot = id => page.evaluate(value => window.conductor.structured.snapshot(value), id)
const pane = id => page.locator(`.structured-agent-pane[data-structured-session="${id}"]`)

try {
  await page.waitForFunction(() => Boolean(window.conductor?.agentControl))
  const projectA = await page.evaluate(() => window.conductor.projects.create('Links smoke A'))
  const projectB = await page.evaluate(() => window.conductor.projects.create('Links smoke B'))
  await page.reload()
  // Visiting B once gives it a workspace for the coworker to open in.
  await page.locator('.project-row').filter({ hasText: 'Links smoke B' }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.sessions.list(id), projectB.id)).length).toBeGreaterThan(0)
  await page.locator('.project-row').filter({ hasText: 'Links smoke A' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).filter({ hasNotText: 'Cloud' }).first().click()
  await expect(page.getByRole('textbox', { name: 'Message Claude Code', exact: true })).toBeEnabled()
  const controllerId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  await page.evaluate(async id => {
    await window.conductor.structured.connect(id)
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, 'SYNTHETIC B the controller that messages another project', { ...state.settings, model: 'synthetic-claude', effort: 'low' }, [])
  }, controllerId)
  await expect.poll(async () => readFile(capture, 'utf8').then(text => text.includes('Conductor app control:')).catch(() => false)).toBe(true)
  await expect.poll(async () => (await snapshot(controllerId))?.phase).toBe('completed')
  const controller = await credentials()
  await expect.poll(async () => (await raw(controller, 'tools.list')).status, { timeout: 15000 }).toBe(200)
  const controllerTitle = (await call(controller, 'tabs.list')).find(tab => tab.resourceId === controllerId).title

  // The controller opens a coworker in project B and sends it one message over app control.
  const opened = await call(controller, 'tabs.open', { provider: 'claude', title: 'Links coworker', projectId: projectB.id })
  const coworkerId = opened.resourceId
  assert.match(coworkerId, /^agent_[a-z0-9]+_[a-z0-9]+$/)
  const message = 'SYNTHETIC B links coworker, please check the build and report back'
  const steered = await call(controller, 'agents.steer', { agentSessionId: coworkerId, prompt: message })
  assert.equal(steered.projectId, projectB.id)
  await expect.poll(async () => (await snapshot(coworkerId))?.phase, { timeout: 20000 }).toBe('completed')
  // The sender's record is Conductor-side only: a controller polling itself never reads it back.
  const own = await snapshot(controllerId)
  const sentNotice = own.items.find(item => item.data.type === 'notice' && item.data.payload?.agentMessage)
  assert.ok(sentNotice, 'the controller timeline records the sent message')
  assert.equal(sentNotice.data.payload.agentMessage.to.agentSessionId, coworkerId)
  assert.equal(sentNotice.data.payload.agentMessage.text, message)
  check('agents.steer records a "sent" notice in the sender, naming the receiver and the text')

  // 3a. Sender card (controller is on screen in project A).
  await expect(pane(controllerId)).toBeVisible()
  const sentCard = pane(controllerId).locator('.sa-agent-message-sent').first()
  await expect(sentCard).toBeVisible()
  await expect(sentCard).not.toHaveAttribute('open', '')
  await expect(sentCard.locator('summary')).toContainText('sent to')
  await expect(sentCard.locator('summary .sa-conversation-link')).toContainText('Links coworker (Links smoke B)')
  await expect(sentCard.locator('.sa-agent-message-body')).toBeHidden()
  await sentCard.scrollIntoViewIfNeeded()
  await shot('sender-card-collapsed.png')
  await sentCard.locator('summary').click({ position: { x: 4, y: 6 } })
  await expect(sentCard).toHaveAttribute('open', '')
  await expect(sentCard.locator('.sa-agent-message-body')).toContainText('please check the build')
  await shot('sender-card-expanded.png')
  check('The sender shows a collapsed "sent to Links coworker (Links smoke B)" card that expands to the text')

  // 2. An id in conversation text becomes a link to the tab it names, in another project.
  await page.evaluate(async ({ id, coworker }) => {
    const state = await window.conductor.structured.snapshot(id)
    await window.conductor.structured.submit(id, `SYNTHETIC B the agent notified ${coworker}, which tab is that?`, state.settings, [])
  }, { id: controllerId, coworker: coworkerId })
  await expect.poll(async () => (await snapshot(controllerId))?.phase, { timeout: 20000 }).toBe('completed')
  const idLink = pane(controllerId).locator('a.sa-conversation-ref', { hasText: coworkerId }).first()
  await expect(idLink).toBeVisible()
  await expect(idLink).toHaveAttribute('title', 'Show Links coworker (Links smoke B)')
  await idLink.scrollIntoViewIfNeeded()
  await idLink.hover()
  await shot('id-link-in-text.png')
  check('The coworker id in the controller conversation renders as a link titled with its tab and project')
  await idLink.click()
  await expect(pane(coworkerId)).toBeVisible()
  check('Clicking the id link switches to project B and focuses the coworker tab')

  // 3b. Receiver card.
  const receivedCard = pane(coworkerId).locator('.sa-agent-message-received').first()
  await expect(receivedCard).toBeVisible()
  await expect(receivedCard).not.toHaveAttribute('open', '')
  await expect(receivedCard.locator('summary')).toContainText('from')
  await expect(receivedCard.locator('summary .sa-conversation-link')).toContainText(controllerTitle + ' (Links smoke A)')
  await expect(receivedCard.locator('.sa-agent-message-preview')).toContainText('please check the build')
  await receivedCard.scrollIntoViewIfNeeded()
  await shot('receiver-card.png')
  check('The receiver shows a collapsed "from <controller> (Links smoke A)" card')
  // Its sender link leads back across projects.
  await receivedCard.locator('summary .sa-conversation-link').click()
  await expect(pane(controllerId)).toBeVisible()
  check('The receiver card names the sender as a link back to it')

  // 1. Ctrl+K finds the coworker by a fragment of its agent id and jumps there.
  const fragment = coworkerId.split('_')[1]
  await page.keyboard.press('Control+K')
  const palette = page.locator('.command-palette')
  await expect(palette).toBeVisible()
  await palette.locator('input').fill(fragment)
  const hit = palette.locator('.palette-list button', { hasText: 'Links coworker (Links smoke B)' })
  await expect(hit).toHaveCount(1)
  await expect(hit).toContainText(coworkerId)
  await shot('palette-agent-id.png')
  check(`Ctrl+K finds the other project's tab by the id fragment "${fragment}" and names its project`)
  await palette.locator('input').press('Enter')
  await expect(palette).toBeHidden()
  await expect(pane(coworkerId)).toBeVisible()
  await shot('palette-jumped.png')
  check('Choosing the palette hit jumps to the coworker tab in project B')

  // And by its tab id, from project B back to the controller.
  await page.keyboard.press('Control+Shift+P')
  await expect(palette).toBeVisible()
  const controllerTab = (await call(controller, 'tabs.list')).find(tab => tab.resourceId === controllerId)
  await palette.locator('input').fill(controllerTab.id)
  await expect(palette.locator('.palette-list button', { hasText: controllerTitle + ' (Links smoke A)' })).toHaveCount(1)
  await palette.locator('input').press('Enter')
  await expect(pane(controllerId)).toBeVisible()
  check('Ctrl+Shift+P finds a tab by its tab id and jumps back to project A')

  // 4. b5-palette-detached: a tab popped out into its own window is in no workspace layout, yet
  // Ctrl+K in the main window finds it and raises that window; and the detached window's own
  // Ctrl+K finds tabs of the main window.
  const focusedIsDetached = () => app.evaluate(({ BrowserWindow }) => new URL(BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? 'file:///').searchParams.has('detached'))
  await call(controller, 'tabs.detach', { tabId: opened.id, projectId: projectB.id })
  await expect.poll(() => app.windows().length).toBe(2)
  const detached = app.windows().find(candidate => candidate !== page)
  detached.on('pageerror', error => { if (error.message !== 'Canceled') errors.push('detached: ' + error.message) })
  const detachedPane = detached.locator(`.structured-agent-pane[data-structured-session="${coworkerId}"]`)
  await expect(detachedPane).toBeVisible()
  await expect(pane(controllerId)).toBeVisible()
  await page.keyboard.press('Control+K')
  await expect(palette).toBeVisible()
  await palette.locator('input').fill(fragment)
  const detachedHit = palette.locator('.palette-list button', { hasText: 'Links coworker (Links smoke B)' })
  await expect(detachedHit).toHaveCount(1)
  await expect(detachedHit).toContainText('separate window')
  await expect(detachedHit).toContainText(coworkerId)
  await palette.locator('input').fill('links cow')
  await expect(detachedHit).toHaveCount(1)
  await shot('palette-detached-hit.png')
  check('Ctrl+K in the main window finds a tab in a detached window by id fragment and by title, marked "separate window"')
  await palette.locator('input').press('Enter')
  await expect(palette).toBeHidden()
  await expect(detachedPane).toBeVisible()
  await expect.poll(focusedIsDetached).toBe(true)
  check('Choosing it raises the detached window with that tab')

  await detached.keyboard.press('Control+K')
  const detachedPalette = detached.locator('.command-palette')
  await expect(detachedPalette).toBeVisible()
  await detachedPalette.locator('input').fill(controllerTab.id)
  const mainHit = detachedPalette.locator('.palette-list button', { hasText: controllerTitle + ' (Links smoke A)' })
  await expect(mainHit).toHaveCount(1)
  await expect(mainHit).toContainText('main window')
  await detached.screenshot({ path: join(output, 'detached-palette-main-hit.png') }); shots.push(join(output, 'detached-palette-main-hit.png'))
  check('Ctrl+K in the detached window finds a main-window tab of another project, marked "main window"')
  await detachedPalette.locator('input').press('Enter')
  await expect(detachedPalette).toBeHidden()
  await expect(pane(controllerId)).toBeVisible()
  await expect.poll(focusedIsDetached).toBe(false)
  check('Choosing it raises the main window on that tab')

  assert.deepEqual(errors, [])
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, shots, inference: 'none', controllerId, coworkerId, projectA: projectA.id, projectB: projectB.id }, null, 2))
  console.log('\nsmoke-agent-id-links: ' + checks.length + ' checks passed')
  console.log('screenshots:\n' + shots.join('\n'))
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined)
  throw error
} finally {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }).catch(() => {})
  await app.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}
