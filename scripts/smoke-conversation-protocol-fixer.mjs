import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanupFixtureApp, combinedSmokeFailure } from './smoke-fixture-cleanup.mjs'

// Offline provider fixtures only: exercises the real renderer, IPC, session persistence and raw
// transport protocol without provider inference or native tool execution.
const provider = process.argv.includes('--provider=codex') ? 'codex' : 'claude'
const providerName = provider === 'codex' ? 'Codex' : 'Claude'
const root = await mkdtemp(join(tmpdir(), `conductor-protocol-${provider}-`))
const output = resolve('artifacts/conversation-protocol-fixer')
await mkdir(output, { recursive: true })
const slot = JSON.parse(await readFile(resolve('artifacts/fixer-coordination/electron-slot.json'), 'utf8'))
const evidenceId = `build${slot.buildNumber ?? 'next'}-generation${slot.generation}-${provider}`
const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_EMPTY_HISTORY: '1', CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_BACKGROUND_WINDOWS: '1' }
delete env.ELECTRON_RUN_AS_NODE; delete env.CONDUCTOR_LIVE_TESTS
const launch = () => electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
let app = await launch(), page = await app.firstWindow()
const report = { syntheticProvider: true, provider, checks: [], failures: [], root }
const check = label => { report.checks.push(label); console.log('PASS ' + label) }
const rendererErrors = []
const watch = () => page.on('pageerror', error => { if (error.message !== 'Canceled') rendererErrors.push(error.stack ?? error.message) })
watch()

let id
const pane = () => page.locator('.structured-agent-pane:visible')
const input = () => pane().getByRole('textbox', { name: new RegExp(`^Message ${providerName}`) })
const snapshot = () => page.evaluate(agentId => window.conductor.structured.snapshot(agentId), id)
const send = async (text, label = 'Send message') => {
  await input().fill(text)
  await expect(pane().getByRole('button', { name: label, exact: true })).toBeEnabled()
  await input().press('Enter')
}
const userTexts = async () => (await snapshot()).items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => item.data.text)
let originalFailure, cleanupFailure

try {
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  await page.evaluate(async () => { await window.conductor.settings.setZoom(1); await window.conductor.settings.setThemeAuto(false); await window.conductor.settings.setThemeVariant('night'); await window.conductor.projects.create('Protocol fixture') })
  await page.reload()
  await page.getByText('Protocol fixture', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: providerName }).click()
  await expect(input()).toBeEnabled()
  id = await pane().getAttribute('data-structured-session')
  await input().focus()
  const initial = await snapshot()
  report.initialSnapshot = { phase: initial.phase, sequence: initial.sequence, itemCount: initial.items.length, modelCount: initial.capabilities?.models?.length ?? 0, hasNativeSession: Boolean(initial.nativeSessionId) }
  if (!initial.nativeSessionId) await page.evaluate(agentId => window.conductor.structured.connect(agentId), id)
  if (provider === 'codex') await expect.poll(async () => Boolean((await snapshot()).nativeSessionId)).toBe(true)
  else await expect.poll(async () => { const state = await snapshot(); return state.phase === 'idle' && Boolean(state.capabilities) }).toBe(true)

  if (provider === 'claude') {
    await send('SYNTHETIC STEERING WAIT')
    await expect.poll(async () => (await snapshot()).phase).toBe('running')
    await expect.poll(async () => Boolean((await snapshot()).nativeSessionId)).toBe(true)
    const queued = ['SYNTHETIC B: queued one', 'SYNTHETIC B: queued two', 'SYNTHETIC B: queued three']
    await page.evaluate(async ({ agentId, messages }) => {
      const state = await window.conductor.structured.snapshot(agentId)
      for (const text of messages) await window.conductor.structured.queue(agentId, text, state.settings, [])
    }, { agentId: id, messages: queued })
    await expect.poll(async () => (await snapshot()).queuedPrompts?.length ?? 0).toBe(3)
    await input().focus(); await input().press('Escape')
    await expect.poll(async () => {
      const texts = await userTexts()
      return queued.every(text => texts.filter(value => value === text).length === 1)
    }, { timeout: 20_000 }).toBe(true)
    const ordered = (await userTexts()).filter(text => queued.includes(text))
    assert.deepEqual(ordered, queued)
    await expect.poll(async () => (await snapshot()).queuedPrompts?.length ?? 0).toBe(0)
    await expect.poll(async () => (await snapshot()).phase, { timeout: 20_000 }).toBe('completed')
    check('Escape flushes all queued messages in original order exactly once')

    await send('SYNTHETIC STEERING WAIT')
    await expect.poll(async () => (await snapshot()).phase).toBe('running')
    await send('SYNTHETIC STEERING HOLD', 'Steer')
    const pending = pane().getByLabel('Pending steering messages')
    await expect(pending).toContainText('Received')
    await pane().getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(async () => (await snapshot()).phase).toBe('interrupted')
    await expect(pending).toContainText('Not sent')
    await pane().getByRole('button', { name: 'Resume conversation', exact: true }).click()
    await expect.poll(async () => (await snapshot()).phase).toBe('idle')
    await send('SYNTHETIC STEERING WAIT')
    await expect.poll(async () => (await snapshot()).phase).toBe('running')
    await send('SYNTHETIC STEERING HOLD NEXT', 'Steer')
    await expect(pending).toContainText('Received')
    const statuses = await pending.locator('.sa-steering-prompt > strong').allTextContents()
    assert.deepEqual(statuses, ['Not sent', 'Received'])
    await page.screenshot({ path: join(output, `receipt-${evidenceId}.png`), fullPage: true })
    await input().focus(); await input().press('Escape')
    await expect.poll(async () => (await snapshot()).phase).toBe('completed')
    assert.deepEqual(await pending.locator('.sa-steering-prompt > strong').allTextContents(), ['Not sent'])
    check('A definite cancelled input stays Not sent while a later distinct native input becomes Received and is consumed')
  } else {
    await send('SYNTHETIC B: establish resumable conversation')
    await expect.poll(async () => (await snapshot()).phase).toBe('completed')
  }

  const nativeBefore = (await snapshot()).nativeSessionId
  await cleanupFixtureApp(app, report, 'protocol pre-restart cleanup')
  app = await launch(); page = await app.firstWindow(); watch()
  await expect(pane()).toBeVisible()
  await expect.poll(async () => ['disconnected', 'interrupted'].includes((await snapshot()).phase)).toBe(true)
  const resume = pane().getByRole('button', { name: 'Resume conversation', exact: true })
  await expect(resume).toBeVisible()
  const resumeStyle = await resume.evaluate(element => ({ color: getComputedStyle(element).color, svgColor: getComputedStyle(element.querySelector('svg')).color, visible: element.getBoundingClientRect().width > 0 }))
  assert.equal(resumeStyle.visible, true)
  assert.equal(resumeStyle.svgColor, resumeStyle.color)
  const message = provider === 'codex' ? 'SYNTHETIC B: resume same Codex conversation once' : 'SYNTHETIC B: resume same Claude conversation once'
  await input().fill(message)
  await expect(pane().getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await pane().getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot()).phase, { timeout: 20_000 }).toBe('completed')
  const restored = await snapshot()
  assert.equal(restored.nativeSessionId, nativeBefore)
  assert.equal((await userTexts()).filter(text => text === message).length, 1)
  check(`A new ${providerName} message resumes the same native conversation and submits exactly once; night Play remains visible`)

  assert.deepEqual(rendererErrors, [])
  await page.screenshot({ path: join(output, `protocol-${evidenceId}.png`), fullPage: true })
} catch (error) {
  originalFailure = error
  report.failures.push(error.stack ?? String(error))
  await page.screenshot({ path: join(output, `failure-${evidenceId}.png`), fullPage: true }).catch(() => {})
} finally {
  try { await cleanupFixtureApp(app, report, 'protocol final cleanup') }
  catch (error) { cleanupFailure = error; report.failures.push(error.stack ?? String(error)) }
  await writeFile(join(output, `report-${evidenceId}.json`), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
}
const failure = combinedSmokeFailure(originalFailure, cleanupFailure)
if (failure) throw failure
console.log(JSON.stringify(report, null, 2))
