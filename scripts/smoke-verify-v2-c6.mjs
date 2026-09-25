import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2c6-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const fixtureDir = resolve('.conductor-scratch/v2/fixtures')
const refusalLog = join(root, 'refusal-c6.log')
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s) }
const watchdog = setTimeout(() => { console.error('WATCHDOG c6 exceeded 180s at step: ' + lastStep); process.exit(2) }, 180_000)
watchdog.unref()

const env = {
  ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1',
  CONDUCTOR_TEST_FIXTURE_DIR: fixtureDir, CONDUCTOR_TEST_REFUSAL_LOG: refusalLog,
  CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects')
}
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
step('launching')
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
let result = { label: 'C6', pass: false }
try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
  step('creating project')
  await page.evaluate(() => window.conductor.projects.create('V2C6'))
  await page.reload()
  await page.locator('.project-row').filter({ hasText: 'V2C6' }).click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const composer = page.getByRole('textbox', { name: /Message Claude/i })
  await expect(composer).toBeEnabled({ timeout: 15000 })
  const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  step('submitting SYNTHETIC REFUSE ONCE on fable')
  await page.evaluate(async (sid) => {
    const state = await window.conductor.structured.snapshot(sid)
    await window.conductor.structured.submit(sid, 'SYNTHETIC REFUSE ONCE', { ...state.settings, model: 'claude-fable-5-1' }, [])
  }, id)
  step('queueing 2 messages while turn is in flight')
  await page.waitForTimeout(300)
  await page.evaluate(async (sid) => {
    const state = await window.conductor.structured.snapshot(sid)
    await window.conductor.structured.queue(sid, 'C6 queued message one', state.settings, [])
    await window.conductor.structured.queue(sid, 'C6 queued message two', state.settings, [])
  }, id)
  step('waiting for fallback + queue drain to settle')
  await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).not.toBe('running')
  await page.waitForTimeout(2000)
  await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 30000 }).not.toBe('running')
  const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
  const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
  const noticeTexts = snapshot.items.filter(i => i.data.type === 'notice').map(i => i.data.message)
  const shotPath = join(output, 'c6-timeline.png')
  await page.screenshot({ path: shotPath })
  step('done, phase=' + snapshot.phase)
  result = { label: 'C6', pass: true, record: { phase: snapshot.phase, userBubbles, noticeTexts, queuedRemaining: snapshot.queuedPrompts?.length, screenshot: shotPath, errors } }
  console.log('RESULT ' + JSON.stringify(result.record))
} catch (error) {
  result = { label: 'C6', pass: false, error: String(error?.stack ?? error), lastStep }
  console.error('FAIL C6 at step [' + lastStep + ']: ' + error)
} finally {
  clearTimeout(watchdog)
  await writeFile(join(output, 'c6-result.json'), JSON.stringify(result, null, 2))
  await app.close().catch(() => {})
  process.exit(0)
}
