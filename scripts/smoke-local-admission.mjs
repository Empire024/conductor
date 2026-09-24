import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { loadConfig, QWEN_9B, QWEN_35B, readApiKey } from '../src/main/local-models/config.ts'
import { health, readRunRecord, startServer } from '../src/main/local-models/llama.ts'

// No generation, model startup or server stop is needed: a live 9B must refuse 35B.
const output = resolve('artifacts/swarm-2026-09-21/local')
await mkdir(output, { recursive: true })
const config = loadConfig()
const small = config.models[QWEN_9B]
const large = config.models[QWEN_35B]
const key = readApiKey()
const before = readRunRecord(small)
assert.ok(before && (await health(before.port, key)).models?.includes(QWEN_9B), 'Existing 9B required; smoke never starts it')
await assert.rejects(startServer('must-never-start', large, key), error => error.message.includes(`${QWEN_9B} is already running`))

const root = await mkdtemp(join(tmpdir(), 'conductor-admission-'))
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_OFFLINE_TESTS
delete env.CONDUCTOR_LIVE_TESTS
// Validate immediately before launch. The controller owns the grant and the build.
const slotPath = resolve('artifacts/fixer-coordination/electron-slot.json')
const slot = JSON.parse(await readFile(slotPath, 'utf8'))
assert.equal(slot.status, 'granted')
assert.equal(slot.agentSessionId, 'agent_mublk3kd_71cymvo')
assert.equal(slot.script, 'scripts/smoke-local-admission.mjs')
assert.equal(slot.generation, Number(process.env.CONDUCTOR_SMOKE_GENERATION), 'Explicit generation must match fresh controller grant')
assert.ok(Date.now() - (await stat(slotPath)).mtimeMs < 120_000, 'Smoke grant must be fresh')
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 60_000 })
const results = { generation: slot.generation, root, checks: [], error: null }
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const project = await page.evaluate(() => window.conductor.projects.create('Local admission'))
  await page.reload()
  await page.getByText('Local admission', { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Qwen 3.6 35B-A3B' }).first().click()
  // Since 9139839 connecting a local tab validates setup only and never loads weights (the first
  // turn does), so connect can no longer raise the admission refusal. And since 9c1b5da a first
  // turn would stop an idle 9B *this Conductor started* to make room, i.e. actually load the 35B,
  // so this smoke must never send one. What connect must guarantee instead: the 35B tab comes up
  // idle, announces no model start, and neither touches the 9B nor leaves a 35B run record.
  const sessionId = await page.locator('.structured-agent-pane').first().getAttribute('data-structured-session')
  await page.evaluate(id => window.conductor.structured.connect(id), sessionId)
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId))?.phase, { timeout: 30_000 }).toBe('idle')
  const connected = await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
  assert.equal(connected.settings.model, QWEN_35B)
  assert.ok(!connected.items.some(item => item.data.type === 'notice' && /^Starting /.test(item.data.message)), 'Connecting must not start a model server')
  await expect(page.getByText(/Cannot start local\//)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Qwen 3\.6 35B-A3B: Idle/ }).first()).toBeVisible()
  assert.equal(readRunRecord(large), null, 'No 35B run record may exist')
  const windowState = await app.evaluate(({ BrowserWindow, screen }) => BrowserWindow.getAllWindows().map(w => ({ focused: w.isFocused(), bounds: w.getBounds(), displays: screen.getAllDisplays().map(d => d.bounds) })))
  for (const w of windowState) {
    assert.equal(w.focused, false)
    for (const d of w.displays) assert.ok(w.bounds.x + w.bounds.width <= d.x || w.bounds.x >= d.x + d.width || w.bounds.y + w.bounds.height <= d.y || w.bounds.y >= d.y + d.height)
  }
  results.windowState = windowState
  results.project = project.path
  results.connectedPhase = connected.phase
  await page.screenshot({ path: join(output, 'admission-connect-idle.png'), fullPage: true })
  assert.deepEqual(readRunRecord(small), before, 'Owner record must remain unchanged')
  assert.ok((await health(before.port, key)).models?.includes(QWEN_9B), 'Owner server must remain healthy')
  assert.equal(readRunRecord(large), null, 'No 35B run record may exist')
  results.checks.push('Host startServer refuses the 35B naming the 9B; connecting an in-app 35B tab loads nothing (idle, no start notice, no refusal, no 35B run record) and leaves the 9B untouched; window parked off all displays and unfocused')
} catch (error) { results.error = String(error); throw error }
finally { await writeFile(join(output, 'smoke-admission.json'), JSON.stringify(results, null, 2)); await app.close() }
console.log(JSON.stringify(results, null, 2))
