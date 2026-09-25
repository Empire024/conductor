import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2c6b-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const fixtureDir = resolve('scripts/fixtures/verify-v2') // fake-claude copy with SYNTHETIC REFUSE ONCE|ALWAYS|ONCE SLOW and SYNTHETIC ERROR500
const results = []
let lastStep = 'start'
const step = (s) => { lastStep = s; console.log('[step] ' + s + ' @' + Date.now()) }

async function runCase(label, { queueAt }) {
  const watchdog = setTimeout(() => { console.error('WATCHDOG ' + label + ' exceeded 200s at step: ' + lastStep); process.exit(2) }, 200_000)
  watchdog.unref()
  const refusalLog = join(root, `refusal-${label}.log`)
  await rm(refusalLog, { force: true })
  const env = {
    ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1',
    CONDUCTOR_TEST_FIXTURE_DIR: fixtureDir, CONDUCTOR_TEST_REFUSAL_LOG: refusalLog,
    CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile-' + label), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects-' + label)
  }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
  step(label + ': launching')
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.waitForFunction(() => Boolean(window.conductor?.structured), { timeout: 15000 })
    step(label + ': creating project')
    await page.evaluate((l) => window.conductor.projects.create('V2' + l), label)
    await page.reload()
    await page.locator('.project-row').filter({ hasText: 'V2' + label }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled({ timeout: 15000 })
    const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
    step(label + ': submitting SYNTHETIC REFUSE ONCE SLOW on fable')
    await page.evaluate(async (sid) => {
      const state = await window.conductor.structured.snapshot(sid)
      await window.conductor.structured.submit(sid, 'SYNTHETIC REFUSE ONCE SLOW', { ...state.settings, model: 'claude-fable-5-1' }, [])
    }, id)
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 15000 }).toBe('running')
    step(label + ': turn is running')
    const queueMessages = async () => {
      step(label + ': queueing SYNTHETIC B: C6 one/two, phase=' +
        (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase)
      await page.evaluate(async (sid) => {
        const state = await window.conductor.structured.snapshot(sid)
        await window.conductor.structured.queue(sid, 'SYNTHETIC B: C6 one', state.settings, [])
        await window.conductor.structured.queue(sid, 'SYNTHETIC B: C6 two', state.settings, [])
      }, id)
    }
    if (queueAt === 'running') {
      await queueMessages()
    } else {
      // queueAt === 'failed-gap': wait for the refusal error item to land (phase failed/transitional) before queueing
      await expect.poll(async () => {
        const snap = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
        return snap.items.some(i => i.data.type === 'error') || snap.phase !== 'running'
      }, { timeout: 10000 }).toBe(true)
      step(label + ': refusal/error observed, queueing in the gap')
      await queueMessages()
    }
    step(label + ': waiting for fallback + drain to settle (up to 20s)')
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).toBe('running').catch(() => {})
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).not.toBe('running')
    await page.waitForTimeout(1500)
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').map(i => i.data.text)
    const noticeTexts = snapshot.items.filter(i => i.data.type === 'notice').map(i => i.data.message)
    const log = await readFile(refusalLog, 'utf8').catch(() => '')
    const logLines = log.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const shotPath = join(output, `${label}-timeline.png`)
    await page.screenshot({ path: shotPath })
    step(label + ': done, phase=' + snapshot.phase)
    const record = { phase: snapshot.phase, userBubbles, noticeTexts, queuedRemaining: snapshot.queuedPrompts?.length ?? 0, logLines, screenshot: shotPath, errors }
    results.push({ label, pass: true, record })
    console.log('RESULT ' + label + ' ' + JSON.stringify(record))
  } catch (error) {
    results.push({ label, pass: false, error: String(error?.stack ?? error), lastStep })
    console.error('FAIL ' + label + ' at step [' + lastStep + ']: ' + error)
  } finally {
    clearTimeout(watchdog)
    await app.close().catch(() => {})
  }
}

await runCase('C6b', { queueAt: 'running' })
await runCase('C6c', { queueAt: 'failed-gap' })

await writeFile(join(output, 'c6b-results.json'), JSON.stringify(results, null, 2))
console.log('C6b/C6c DONE')
process.exit(0)
