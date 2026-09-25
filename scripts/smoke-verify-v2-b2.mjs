import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2b2-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const results = []
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }

let watchdogApp = null
const watchdog = setTimeout(async () => {
  console.error('WATCHDOG: exceeded 550s, last step: ' + lastStep)
  try {
    if (watchdogApp) {
      const buf = await watchdogApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.capturePage().then(img => img.toPNG().toString('base64')))
      if (buf) await writeFile(join(output, 'b-timeout.png'), Buffer.from(buf, 'base64'))
    }
  } catch (e) { console.error('watchdog screenshot failed: ' + e) }
  await writeFile(join(output, 'b2-results-partial.json'), JSON.stringify({ lastStep, results }, null, 2)).catch(() => {})
  process.exit(2)
}, 550_000)
watchdog.unref()

// Safe teardown (scripts/smoke-agent-control.mjs pattern): stub the "Work is still running" quit
// dialog so app.close() never hangs on it, bound the close, and taskkill only this run's Electron
// if close() never resolves.
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
  const capture = join(root, `capture-${label}.txt`)
  await rm(capture, { force: true })
  const env = {
    ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_CONTROL_CAPTURE: capture,
    CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile-' + label), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects-' + label),
    ...extraEnv
  }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  watchdogApp = app
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  step('launched ' + label)
  return { app, page, errors, capture }
}

async function openClaude(page, name = 'V2B') {
  step('open claude project')
  await page.evaluate((n) => window.conductor.projects.create(n + ' ' + Math.random().toString(36).slice(2)), name)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const composer = page.getByRole('textbox', { name: /Message Claude/i })
  await expect(composer).toBeEnabled({ timeout: 15000 })
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  step('claude tab opened, session=' + id)
  return { composer, id }
}

async function openCodex(page, name = 'V2B') {
  step('open codex project')
  await page.evaluate((n) => window.conductor.projects.create(n + ' ' + Math.random().toString(36).slice(2)), name)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true })
  await expect(composer).toBeEnabled({ timeout: 15000 })
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  step('codex tab opened, session=' + id)
  return { composer, id }
}

const run = async (label, fn) => {
  try { const record = await fn(); results.push({ label, pass: true, record }); console.log('PASS ' + label, JSON.stringify(record)) }
  catch (error) { results.push({ label, pass: false, error: String(error?.stack ?? error), lastStep }); console.error('FAIL ' + label + ' at step [' + lastStep + ']: ' + error) }
}

// The composer shows "Steer" (not "Queue message") until the first attempt is declined as
// unsteerable (CONDUCTOR_TEST_STEER=review), at which point the software re-routes it into the
// queue and subsequent follow-ups show "Queue message" directly (see scripts/smoke-backlog.mjs).
async function queueOrSteer(page, composer, text) {
  await composer.fill(text)
  const queueBtn = page.getByRole('button', { name: 'Queue message', exact: true })
  const steerBtn = page.getByRole('button', { name: 'Steer', exact: true })
  await Promise.race([
    queueBtn.waitFor({ state: 'visible', timeout: 15000 }),
    steerBtn.waitFor({ state: 'visible', timeout: 15000 })
  ])
  if (await queueBtn.isVisible().catch(() => false)) await queueBtn.click()
  else await steerBtn.click()
}

// B1: 5 messages queued within 1s while a Codex turn is not steerable (review). Merged into one turn, one bubble.
await run('B1', async () => {
  const { app, page, capture } = await launch('b1', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page)
    step('B1: sending synthetic:backlog')
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
    step('B1: turn running, queueing 5 messages')
    for (let i = 1; i <= 5; i++) {
      await queueOrSteer(page, composer, `Queued message ${i} of five`)
      step('B1: queued message ' + i)
    }
    await expect(page.locator('.sa-queue')).toHaveCount(5, { timeout: 10000 })
    step('B1: all 5 queued, pressing Escape')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 60000 }).not.toBe('running')
    step('B1: turn ended, waiting for drain')
    await page.waitForTimeout(2000)
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user')
    const captureText = await readFile(capture, 'utf8').catch(() => '')
    const shotPath = join(output, 'b1-timeline.png')
    await page.screenshot({ path: shotPath })
    const allFivePresentInOrder = [1, 2, 3, 4, 5].every((n, idx, arr) => {
      const pos = captureText.indexOf(`Queued message ${n} of five`)
      return pos >= 0 && (idx === 0 || pos > captureText.indexOf(`Queued message ${arr[idx - 1]} of five`))
    })
    step('B1: done')
    return { userBubbleCount: userBubbles.length, allFivePresentInOrder, captureTail: captureText.slice(-1200), screenshot: shotPath, phase: snapshot.phase }
  } finally { await safeClose(app) }
})

// B2: queue 3, remove #2, delivered turn should contain #1 and #3 only.
await run('B2', async () => {
  const { app, page } = await launch('b2', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
    step('B2: queueing 3')
    for (const text of ['Queued one', 'Queued two', 'Queued three']) await queueOrSteer(page, composer, text)
    await expect(page.locator('.sa-queue')).toHaveCount(3, { timeout: 10000 })
    step('B2: removing #2')
    await page.getByRole('button', { name: 'Remove queued message 2', exact: true }).click({ timeout: 10000 })
    const draftAfterRemove = await composer.inputValue()
    await expect(page.locator('.sa-queue')).toHaveCount(2, { timeout: 10000 })
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 60000 }).not.toBe('running')
    step('B2: done')
    return { draftAfterRemove }
  } finally { await safeClose(app) }
})

// B3: Alt+Backspace removes last queued message without corrupting composer draft
await run('B3', async () => {
  const { app, page } = await launch('b3', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
    step('B3: queueing 2')
    for (const text of ['Alpha queued', 'Beta queued']) await queueOrSteer(page, composer, text)
    await expect(page.locator('.sa-queue')).toHaveCount(2, { timeout: 10000 })
    await composer.fill('some draft text here')
    await composer.focus()
    step('B3: Alt+Backspace')
    await page.keyboard.press('Alt+Backspace')
    const draftAfter = await composer.inputValue()
    const queueCountAfter = await page.locator('.sa-queue').count()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 60000 }).not.toBe('running')
    step('B3: done')
    return { draftAfter, queueCountAfter }
  } finally { await safeClose(app) }
})

// B4: queue 2 while waiting on an approval card (SYNTHETIC PERMISSION ONCE), then Allow.
await run('B4', async () => {
  const { app, page } = await launch('b4')
  try {
    const { composer, id } = await openClaude(page)
    step('B4: sending SYNTHETIC PERMISSION ONCE')
    await composer.fill('SYNTHETIC PERMISSION ONCE')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const pending = page.locator('form.sa-interaction')
    await expect(pending.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled({ timeout: 15000 })
    step('B4: approval card visible, queueing 2')
    for (const text of ['B4 queued one', 'B4 queued two']) await queueOrSteer(page, composer, text)
    await expect(page.locator('.sa-queue')).toHaveCount(2, { timeout: 10000 })
    step('B4: clicking Allow once')
    await pending.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).toBe('completed')
    step('B4: turn completed, waiting for queue drain')
    await page.waitForTimeout(2000)
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 60000 }).not.toBe('running')
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
    step('B4: done')
    return { userBubbles, phase: snapshot.phase, queuedRemaining: snapshot.queuedPrompts?.length ?? 0 }
  } finally { await safeClose(app) }
})

// B6: race — queue 1, then remove it right around when the turn completes.
await run('B6', async () => {
  const { app, page } = await launch('b6', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
    step('B6: queueing 1')
    await queueOrSteer(page, composer, 'B6 racing message')
    await expect(page.locator('.sa-queue')).toHaveCount(1, { timeout: 10000 })
    step('B6: racing Escape (ends turn) against Remove click')
    const escapePromise = page.keyboard.press('Escape')
    const removePromise = page.getByRole('button', { name: 'Remove queued message 1', exact: true }).click().catch((e) => ({ raceError: String(e) }))
    await Promise.all([escapePromise, removePromise])
    await page.waitForTimeout(1500)
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
    const draftValue = await composer.inputValue()
    step('B6: done')
    return { userBubbles, draftValue, phase: snapshot.phase, queuedRemaining: snapshot.queuedPrompts?.length ?? 0, pageErrors: [] }
  } finally { await safeClose(app) }
})

// B7: queue 3, then Escape (interrupt) — must never silently drop them.
await run('B7', async () => {
  const { app, page } = await launch('b7', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
    step('B7: queueing 3')
    for (const text of ['B7 one', 'B7 two', 'B7 three']) await queueOrSteer(page, composer, text)
    await expect(page.locator('.sa-queue')).toHaveCount(3, { timeout: 10000 })
    step('B7: pressing Escape')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(2000)
    const queueCountAfter = await page.locator('.sa-queue').count()
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
    const shotPath = join(output, 'b7-timeline.png')
    await page.screenshot({ path: shotPath })
    step('B7: done')
    return { queueCountAfter, userBubbles, phase: snapshot.phase, screenshot: shotPath }
  } finally { await safeClose(app) }
})

// B8: queue a 50KB message + whitespace-only + emoji; no crash, single delivered turn.
await run('B8', async () => {
  const { app, page, errors, capture } = await launch('b8', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
    const big = 'B8-big-' + 'x'.repeat(50 * 1024)
    step('B8: queueing 50KB message')
    await page.evaluate(async (arg) => { await window.conductor.structured.queue(arg.id, arg.text, (await window.conductor.structured.snapshot(arg.id)).settings, []) }, { id, text: big })
    step('B8: queueing whitespace-only message')
    await page.evaluate(async (arg) => { await window.conductor.structured.queue(arg.id, arg.text, (await window.conductor.structured.snapshot(arg.id)).settings, []) }, { id, text: '   \n\t  ' }).catch((e) => console.log('[step] B8: whitespace queue rejected: ' + e))
    step('B8: queueing emoji message')
    await page.evaluate(async (arg) => { await window.conductor.structured.queue(arg.id, arg.text, (await window.conductor.structured.snapshot(arg.id)).settings, []) }, { id, text: 'B8 emoji 🎉🚀✅' })
    await page.waitForTimeout(500)
    const queueCountBefore = await page.locator('.sa-queue').count()
    step('B8: pressing Escape')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 60000 }).not.toBe('running')
    await page.waitForTimeout(2000)
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text.length)
    step('B8: done')
    return { queueCountBefore, userBubbleLengths: userBubbles, phase: snapshot.phase, pageErrors: errors }
  } finally { await safeClose(app) }
})

// B5: steering delivered into a running Claude turn is not also re-sent as a new turn afterward.
await run('B5', async () => {
  const { app, page } = await launch('b5')
  try {
    const { composer, id } = await openClaude(page)
    step('B5: sending SYNTHETIC STEERING WAIT')
    await composer.fill('SYNTHETIC STEERING WAIT')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).toBe('running')
    step('B5: turn running, sending steer')
    await composer.fill('SYNTHETIC STEERING NEXT')
    const steerBtn = page.getByRole('button', { name: 'Steer', exact: true })
    await expect(steerBtn).toBeVisible({ timeout: 30000 })
    await steerBtn.click({ timeout: 15000 })
    step('B5: steered, waiting 2.5s')
    await page.waitForTimeout(2500)
    const midSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const midUserBubbles = midSnapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').length
    step('B5: pressing Escape to end turn')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 60000 }).not.toBe('running')
    await page.waitForTimeout(1000)
    const finalSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const finalUserBubbles = finalSnapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').length
    step('B5: done')
    return { midUserBubbles, finalUserBubbles, phase: finalSnapshot.phase }
  } finally { await safeClose(app) }
})

await writeFile(join(output, 'b-results.json'), JSON.stringify(results, null, 2))
clearTimeout(watchdog)
const failed = results.filter(r => !r.pass)
console.log(failed.length ? `FAILURES: ${failed.map(f => f.label).join(', ')}` : 'ALL B CASES PASSED')
process.exit(0)
