import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const results = []
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
let watchdogApp = null
const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: exceeded 550s, last step: ' + lastStep)
  try { if (watchdogApp) { const buf = await watchdogApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.capturePage().then(img => img.toPNG().toString('base64'))); if (buf) await writeFile(join(output, 'b3-timeout.png'), Buffer.from(buf, 'base64')) } } catch (e) { console.error('watchdog screenshot failed: ' + e) }
  await writeFile(join(output, 'b3-results-partial.json'), JSON.stringify({ lastStep, results }, null, 2)).catch(() => {})
  process.exit(2)
}, 550_000)
watchdog.unref()

async function safeClose(app) {
  await Promise.race([
    app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (...args) => {
        const buttons = args.at(-1)?.buttons ?? []
        const index = buttons.findIndex(label => label === "Don't Save" || label === 'Stop work and quit')
        return { response: index >= 0 ? index : 0, checkboxChecked: false }
      }
    }),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]).catch(() => {})
  let pid
  try { pid = app.process().pid } catch {}
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 20_000))])
  if (!closed && pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
}

async function launch(label, extraEnv = {}) {
  step('launch ' + label)
  const root = await mkdtemp(join(tmpdir(), 'conductor-v2b3-' + label + '-'))
  const capture = join(root, 'capture.txt')
  const env = {
    ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_CONTROL_CAPTURE: capture,
    CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'),
    ...extraEnv
  }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  watchdogApp = app
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  step('launched ' + label)
  return { app, page, errors, capture, root }
}

async function openCodex(page, name) {
  step('open codex project')
  const project = await page.evaluate((n) => window.conductor.projects.create(n), name)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true })
  await expect(composer).toBeEnabled({ timeout: 20000 })
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  step('codex tab opened, session=' + id)
  return { composer, id, project }
}

async function openClaude(page, name) {
  step('open claude project')
  const project = await page.evaluate((n) => window.conductor.projects.create(n), name)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const composer = page.getByRole('textbox', { name: /Message Claude/i })
  await expect(composer).toBeEnabled({ timeout: 20000 })
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  step('claude tab opened, session=' + id)
  return { composer, id, project }
}

async function queueOrSteer(page, composer, text) {
  await composer.fill(text)
  const queueBtn = page.getByRole('button', { name: 'Queue message', exact: true })
  const steerBtn = page.getByRole('button', { name: 'Steer', exact: true })
  await Promise.race([
    queueBtn.waitFor({ state: 'visible', timeout: 20000 }),
    steerBtn.waitFor({ state: 'visible', timeout: 20000 })
  ])
  if (await queueBtn.isVisible().catch(() => false)) await queueBtn.click()
  else await steerBtn.click()
}

const run = async (label, fn) => {
  try { const record = await fn(); results.push({ label, pass: true, record }); console.log('PASS ' + label, JSON.stringify(record)) }
  catch (error) { results.push({ label, pass: false, error: String(error?.stack ?? error), lastStep }); console.error('FAIL ' + label + ' at step [' + lastStep + ']: ' + error) }
}

async function startTelemetry(page, composer, id) {
  await composer.fill('synthetic:telemetry')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
}

// B1n: natural turn end (create .synthetic-telemetry-next then -finish files, no Escape)
await run('B1n', async () => {
  const { app, page, capture, root } = await launch('b1n', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id, project } = await openCodex(page, 'B1n fixture')
    step('B1n: starting synthetic:telemetry')
    await startTelemetry(page, composer, id)
    step('B1n: queueing 5 messages within 1s')
    const noticesBefore = (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).items.filter(i => i.data.type === 'notice').map(i => i.data.message)
    for (let i = 1; i <= 5; i++) await queueOrSteer(page, composer, `B1n queued ${i} of 5`)
    await expect(page.locator('.sa-queue')).toHaveCount(5, { timeout: 10000 })
    const noticesAfter = (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).items.filter(i => i.data.type === 'notice').map(i => i.data.message)
    step('B1n: ending turn naturally via barrier files')
    await writeFile(join(project.path, '.synthetic-telemetry-next'), '')
    await page.waitForTimeout(300)
    await writeFile(join(project.path, '.synthetic-telemetry-finish'), '')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('completed')
    await page.waitForTimeout(1500)
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
    const captureTail = await readFile(capture, 'utf8').catch(() => '')
    const shotPath = join(output, 'b1n-timeline.png')
    await page.screenshot({ path: shotPath })
    step('B1n: done')
    return { userBubbleCount: userBubbles.length, secondBubble: userBubbles[1], captureTail, notices: { before: noticesBefore, after: noticesAfter }, queuedRemaining: snapshot.queuedPrompts?.length ?? 0, phase: snapshot.phase, screenshot: shotPath }
  } finally { await safeClose(app); await rm(root, { recursive: true, force: true }).catch(() => {}) }
})

// B7n: same setup, but Escape instead of the finish file
await run('B7n', async () => {
  const { app, page, capture, root } = await launch('b7n', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page, 'B7n fixture')
    step('B7n: starting synthetic:telemetry')
    await startTelemetry(page, composer, id)
    step('B7n: queueing 5 messages')
    for (let i = 1; i <= 5; i++) await queueOrSteer(page, composer, `B7n queued ${i} of 5`)
    await expect(page.locator('.sa-queue')).toHaveCount(5, { timeout: 10000 })
    step('B7n: pressing Escape')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(30000)
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
    const captureTail = await readFile(capture, 'utf8').catch(() => '')
    const shotPath = join(output, 'b7n-timeline.png')
    await page.screenshot({ path: shotPath })
    step('B7n: done, phase=' + snapshot.phase)
    return { phaseAfter30s: snapshot.phase, userBubbleCount: userBubbles.length, secondBubble: userBubbles[1], captureTail, queuedRemaining: snapshot.queuedPrompts?.length ?? 0, screenshot: shotPath }
  } finally { await safeClose(app); await rm(root, { recursive: true, force: true }).catch(() => {}) }
})

// B8n: 50KB + emoji + normal, natural end
await run('B8n', async () => {
  const { app, page, capture, root } = await launch('b8n', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id, project } = await openCodex(page, 'B8n fixture')
    step('B8n: starting synthetic:telemetry')
    await startTelemetry(page, composer, id)
    step('B8n: queueing 50KB + emoji + normal')
    const big = 'B8n-big-' + 'x'.repeat(50 * 1024)
    await queueOrSteer(page, composer, big)
    await queueOrSteer(page, composer, 'B8n emoji 🎉🚀✅')
    await queueOrSteer(page, composer, 'B8n normal message')
    await expect(page.locator('.sa-queue')).toHaveCount(3, { timeout: 10000 })
    step('B8n: ending turn naturally')
    await writeFile(join(project.path, '.synthetic-telemetry-next'), '')
    await page.waitForTimeout(300)
    await writeFile(join(project.path, '.synthetic-telemetry-finish'), '')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('completed')
    await page.waitForTimeout(1500)
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text.length)
    const captureText = await readFile(capture, 'utf8').catch(() => '')
    step('B8n: done')
    return { userBubbleLengths: userBubbles, capturedLength: captureText.length, mergedContainsAll: captureText.includes('B8n-big-') && captureText.includes('🎉🚀✅') && captureText.includes('B8n normal message'), phase: snapshot.phase, queuedRemaining: snapshot.queuedPrompts?.length ?? 0 }
  } finally { await safeClose(app); await rm(root, { recursive: true, force: true }).catch(() => {}) }
})

// B4n: Claude, pending approval card, send while pending, then Allow
await run('B4n', async () => {
  const { app, page, root } = await launch('b4n')
  try {
    const { composer, id } = await openClaude(page, 'B4n fixture')
    step('B4n: sending SYNTHETIC PERMISSION ONCE')
    await composer.fill('SYNTHETIC PERMISSION ONCE')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const pending = page.locator('form.sa-interaction')
    await expect(pending.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled({ timeout: 20000 })
    const shotPath1 = join(output, 'b4n-approval-pending.png')
    await page.screenshot({ path: shotPath1 })
    const sendBtn = page.getByRole('button', { name: 'Send message', exact: true })
    const sendVisible = await sendBtn.isVisible().catch(() => false)
    const sendDisabledAttr = sendVisible ? await sendBtn.getAttribute('disabled') : '<not visible>'
    const sendEnabled = sendVisible ? await sendBtn.isEnabled() : false
    step('B4n: composer state while pending: sendVisible=' + sendVisible + ' enabled=' + sendEnabled)
    await composer.fill('SYNTHETIC B follow-up while pending')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    const midSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    step('B4n: clicking Allow once')
    await pending.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).not.toBe('running')
    await page.waitForTimeout(1500)
    const finalSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = finalSnapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
    step('B4n: done')
    return { sendVisible, sendDisabledAttr, sendEnabled, screenshot: shotPath1, midQueuedPrompts: midSnapshot.queuedPrompts?.length ?? 0, midPendingSteering: midSnapshot.pendingSteering?.length ?? 0, finalUserBubbles: userBubbles, finalPhase: finalSnapshot.phase }
  } finally { await safeClose(app); await rm(root, { recursive: true, force: true }).catch(() => {}) }
})

// B5n: Claude steering, no escape first, then escape at the end
await run('B5n', async () => {
  const { app, page, capture, root } = await launch('b5n')
  try {
    const { composer, id } = await openClaude(page, 'B5n fixture')
    step('B5n: sending SYNTHETIC STEERING WAIT')
    await composer.fill('SYNTHETIC STEERING WAIT')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).toBe('running')
    step('B5n: steering SYNTHETIC STEERING NEXT')
    await composer.fill('SYNTHETIC STEERING NEXT')
    const steerBtn = page.getByRole('button', { name: 'Steer', exact: true })
    await expect(steerBtn).toBeVisible({ timeout: 20000 })
    await steerBtn.click()
    step('B5n: waiting 5s, checking capture')
    await page.waitForTimeout(5000)
    const captureAt5s = await readFile(capture, 'utf8').catch(() => '')
    const midSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const midUserBubbles = midSnapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').length
    step('B5n: waiting 25 more seconds (30s total) to check for a resend')
    await page.waitForTimeout(25000)
    const captureAt30s = await readFile(capture, 'utf8').catch(() => '')
    const snapshot30 = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles30 = snapshot30.items.filter(i => i.data.type === 'text' && i.data.role === 'user').length
    step('B5n: pressing Escape')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(30000)
    const finalSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    step('B5n: done, phase=' + finalSnapshot.phase)
    return {
      steerReachedRunningTurn: captureAt5s.includes('SYNTHETIC STEERING NEXT') || captureAt5s.includes('Synthetic steering consumed'),
      captureAt5sTail: captureAt5s.slice(-300),
      midUserBubbles,
      userBubbles30sLater: userBubbles30,
      resentAsNewTurn: userBubbles30 > midUserBubbles,
      phaseAfterEscapeWait30s: finalSnapshot.phase
    }
  } finally { await safeClose(app); await rm(root, { recursive: true, force: true }).catch(() => {}) }
})

await writeFile(join(output, 'b3-results.json'), JSON.stringify(results, null, 2))
clearTimeout(watchdog)
const failed = results.filter(r => !r.pass)
console.log(failed.length ? `FAILURES: ${failed.map(f => f.label).join(', ')}` : 'ALL B3 CASES PASSED')
process.exit(0)
