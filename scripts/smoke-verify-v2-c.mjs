import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'conductor-v2c-'))
const output = resolve('artifacts/verify-v2')
await mkdir(output, { recursive: true })
const fixtureDir = resolve('scripts/fixtures/verify-v2') // fake-claude copy with SYNTHETIC REFUSE ONCE|ALWAYS|ONCE SLOW and SYNTHETIC ERROR500
const results = []

async function runCase(label, { model, prompt, expect: expectFn }) {
  const refusalLog = join(root, `refusal-${label}.log`)
  await rm(refusalLog, { force: true })
  const env = {
    ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_MODEL_CATALOG: '1',
    CONDUCTOR_TEST_FIXTURE_DIR: fixtureDir, CONDUCTOR_TEST_REFUSAL_LOG: refusalLog,
    CONDUCTOR_TEST_NODE_EXECUTABLE: process.execPath, CONDUCTOR_TEST_USER_DATA: join(root, 'profile-' + label), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects-' + label)
  }
  delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
  const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.waitForFunction(() => Boolean(window.conductor?.structured))
    const project = await page.evaluate(() => window.conductor.projects.create('V2C ' + Math.random().toString(36).slice(2)))
    await page.reload()
    await page.locator('.project-row').filter({ hasText: 'V2C' }).click()
    await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
    const composer = page.getByRole('textbox', { name: /Message Claude/i })
    await expect(composer).toBeEnabled()
    const id = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
    const state0 = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    await page.evaluate(async ({ sid, model, prompt }) => {
      const state = await window.conductor.structured.snapshot(sid)
      await window.conductor.structured.submit(sid, prompt, { ...state.settings, model }, [])
    }, { sid: id, model, prompt })
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).not.toBe('running')
    // allow any async fallback submission to also settle
    await page.waitForTimeout(1500)
    await expect.poll(async () => (await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)).phase, { timeout: 20000 }).not.toBe('running')
    const snapshot = await page.evaluate((sid) => window.conductor.structured.snapshot(sid), id)
    const userBubbles = snapshot.items.filter(i => i.data.type === 'text' && i.data.role === 'user').length
    const noticeTexts = snapshot.items.filter(i => i.data.type === 'notice').map(i => i.data.message)
    const errorTexts = snapshot.items.filter(i => i.data.type === 'error').map(i => i.data.message)
    const log = await readFile(refusalLog, 'utf8').catch(() => '')
    const logLines = log.trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    const shotPath = join(output, `c-${label}.png`)
    await page.screenshot({ path: shotPath })
    const pickerModel = await page.getByRole('combobox', { name: 'Model', exact: true }).innerText().catch(() => '<not found>')
    const record = { label, phase: snapshot.phase, userBubbles, noticeTexts, errorTexts, logLines, screenshot: shotPath, errors, pickerModel }
    expectFn(record)
    results.push({ label, pass: true, record })
    console.log('PASS ' + label, JSON.stringify({ phase: record.phase, userBubbles, noticeTexts, logModels: logLines.map(l => l.model) }))
  } catch (error) {
    results.push({ label, pass: false, error: String(error?.stack ?? error) })
    console.error('FAIL ' + label + ': ' + error)
  } finally {
    await app.close().catch(() => {})
  }
}

await runCase('C1a', { model: 'claude-fable-5-1', prompt: 'SYNTHETIC REFUSE ONCE', expect: (r) => {
  assert.equal(r.userBubbles, 1, 'exactly one user bubble')
  assert.equal(r.phase, 'completed')
  assert.ok(r.noticeTexts.some(t => t === 'Fable refused this turn; continuing on Opus 5.5'), 'fallback notice: ' + JSON.stringify(r.noticeTexts))
  assert.ok(r.logLines.some(l => l.model === 'opus[1m]'), 'fixture saw opus[1m]: ' + JSON.stringify(r.logLines))
} })

await runCase('C1b', { model: 'claude-fable-5-1', prompt: 'SYNTHETIC REFUSE ONCE SUBTYPE_EDE', expect: (r) => {
  assert.equal(r.userBubbles, 1)
  assert.equal(r.phase, 'completed')
  assert.ok(r.noticeTexts.some(t => t === 'Fable refused this turn; continuing on Opus 5.5'))
} })

await runCase('C2', { model: 'claude-fable-5-1', prompt: 'SYNTHETIC REFUSE ALWAYS', expect: (r) => {
  const setModelCount = r.logLines.filter(l => l.event === 'prompt').length
  assert.equal(setModelCount, 2, 'exactly two refuse-prompt attempts (fable, opus): ' + JSON.stringify(r.logLines))
  assert.equal(r.phase, 'failed')
  assert.ok(r.errorTexts.some(t => /safeguards flagged/.test(t)))
} })

await runCase('C3-sonnet', { model: 'sonnet', prompt: 'SYNTHETIC REFUSE ALWAYS', expect: (r) => {
  const attempts = r.logLines.filter(l => l.event === 'prompt').length
  assert.equal(attempts, 1, 'no retry from sonnet: ' + JSON.stringify(r.logLines))
  assert.equal(r.phase, 'failed')
} })

await runCase('C3-opus1m', { model: 'opus[1m]', prompt: 'SYNTHETIC REFUSE ONCE', expect: (r) => {
  assert.ok(r.noticeTexts.some(t => t === 'Opus 5.5 refused this turn; continuing on Sonnet 5'), JSON.stringify(r.noticeTexts))
  assert.equal(r.userBubbles, 1)
} })

await runCase('C4', { model: 'claude-fable-5-1', prompt: 'SYNTHETIC ERROR500', expect: (r) => {
  assert.ok(!r.noticeTexts.some(t => /refused|continuing on/i.test(t)), 'no fallback notice for a non-safeguard 500: ' + JSON.stringify(r.noticeTexts))
  assert.equal(r.phase, 'failed')
} })

await writeFile(join(output, 'c-results.json'), JSON.stringify(results, null, 2))
const failed = results.filter(r => !r.pass)
console.log(failed.length ? `FAILURES: ${failed.map(f => f.label).join(', ')}` : 'ALL C CASES PASSED')
process.exit(failed.length ? 1 : 0)
