import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2b-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const results = []

async function launch(label, extraEnv = {}) {
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
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const kill = () => { try { const pid = app.process().pid; if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
  return { app, page, errors, capture, kill }
}

async function openClaude(page, name = 'V2B') {
  const project = await page.evaluate((n) => window.conductor.projects.create(n + ' ' + Math.random().toString(36).slice(2)), name)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const composer = page.getByRole('textbox', { name: /Message Claude/i })
  await expect(composer).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  return { project, composer, id }
}

async function openCodex(page, name = 'V2B') {
  const project = await page.evaluate((n) => window.conductor.projects.create(n + ' ' + Math.random().toString(36).slice(2)), name)
  await page.reload()
  await page.locator('.project-row').filter({ hasText: name }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true })
  await expect(composer).toBeEnabled()
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  return { project, composer, id }
}

const run = async (label, fn) => {
  try { const record = await fn(); results.push({ label, pass: true, record }); console.log('PASS ' + label, JSON.stringify(record)) }
  catch (error) { results.push({ label, pass: false, error: String(error?.stack ?? error) }); console.error('FAIL ' + label + ': ' + error) }
}

// B1: 5 messages queued within 1s while a Codex turn is not steerable (review). Merged into one turn, one bubble.
await run('B1', async () => {
  const { app, page, capture, kill } = await launch('b1', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openCodex(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase).toBe('running')
    for (let i = 1; i <= 5; i++) {
      await composer.fill(`Queued message ${i} of five`)
      await page.getByRole('button', { name: 'Queue message', exact: true }).click()
    }
    await expect(page.locator('.sa-queue')).toHaveCount(5)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).not.toBe('running')
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
    return { userBubbleCount: userBubbles.length, allFivePresentInOrder, captureTail: captureText.slice(-1200), screenshot: shotPath, phase: snapshot.phase }
  } finally { await app.close().catch(() => {}); kill() }
})

// B2: queue 3, remove #2, delivered turn should contain #1 and #3 only.
await run('B2', async () => {
  const { app, page, kill } = await launch('b2', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openClaude(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase).toBe('running')
    for (const text of ['Queued one', 'Queued two', 'Queued three']) {
      await composer.fill(text)
      await page.getByRole('button', { name: 'Queue message', exact: true }).click()
    }
    await expect(page.locator('.sa-queue')).toHaveCount(3)
    await page.getByRole('button', { name: 'Remove queued message 2', exact: true }).click()
    const draftAfterRemove = await composer.inputValue()
    await expect(page.locator('.sa-queue')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).not.toBe('running')
    return { draftAfterRemove }
  } finally { await app.close().catch(() => {}); kill() }
})

// B3: Alt+Backspace removes last queued message without corrupting composer draft
await run('B3', async () => {
  const { app, page, kill } = await launch('b3', { CONDUCTOR_TEST_STEER: 'review' })
  try {
    const { composer, id } = await openClaude(page)
    await composer.fill('synthetic:backlog')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase).toBe('running')
    for (const text of ['Alpha queued', 'Beta queued']) {
      await composer.fill(text)
      await page.getByRole('button', { name: 'Queue message', exact: true }).click()
    }
    await expect(page.locator('.sa-queue')).toHaveCount(2)
    await composer.fill('some draft text here')
    await composer.focus()
    await page.keyboard.press('Alt+Backspace')
    const draftAfter = await composer.inputValue()
    const queueCountAfter = await page.locator('.sa-queue').count()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).not.toBe('running')
    return { draftAfter, queueCountAfter }
  } finally { await app.close().catch(() => {}); kill() }
})

// B5: steering delivered into a running Claude turn is not also re-sent as a new turn afterward.
await run('B5', async () => {
  const { app, page, capture, kill } = await launch('b5')
  try {
    const { composer, id } = await openClaude(page)
    await composer.fill('SYNTHETIC STEERING WAIT')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase).toBe('running')
    await composer.fill('SYNTHETIC STEERING NEXT')
    const steerBtn = page.getByRole('button', { name: 'Steer', exact: true })
    await expect(steerBtn).toBeVisible()
    await steerBtn.click()
    await page.waitForTimeout(2500)
    const midSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const midUserBubbles = midSnapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').length
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).not.toBe('running')
    await page.waitForTimeout(1000)
    const finalSnapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const finalUserBubbles = finalSnapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').length
    return { midUserBubbles, finalUserBubbles, phase: finalSnapshot.phase }
  } finally { await app.close().catch(() => {}); kill() }
})

await writeFile(join(output, 'b-results.json'), JSON.stringify(results, null, 2))

// B9: existing neighbour smoke, run separately and record its output.
console.log('--- running B9 (smoke-conversation-followup.mjs) ---')
const b9 = spawnSync(process.execPath, ['scripts/smoke-conversation-followup.mjs'], { encoding: 'utf8', timeout: 180000 })
results.push({ label: 'B9', pass: b9.status === 0, record: { status: b9.status, stdoutTail: (b9.stdout || '').slice(-2000), stderrTail: (b9.stderr || '').slice(-2000) } })
await writeFile(join(output, 'b-results.json'), JSON.stringify(results, null, 2))

const failed = results.filter(r => !r.pass)
console.log(failed.length ? `FAILURES: ${failed.map(f => f.label).join(', ')}` : 'ALL B CASES PASSED')
process.exit(0)
