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
  // Opening the tab registers the session; the runtime only starts when the session connects,
  // which is what the composer does before a first message. Connect explicitly so the
  // admission refusal is what the owner would see, and let the rejection surface as the event.
  const sessionId = await page.locator('.structured-agent-pane').first().getAttribute('data-structured-session')
  await page.evaluate(id => window.conductor.structured.connect(id).catch(() => undefined), sessionId)
  await expect(page.getByText(/Cannot start local\/qwen3\.6-35b-a3b: local\/qwen3\.5-9b is already running/).first()).toBeVisible({ timeout: 30_000 })
  const windowState = await app.evaluate(({ BrowserWindow, screen }) => BrowserWindow.getAllWindows().map(w => ({ focused: w.isFocused(), bounds: w.getBounds(), displays: screen.getAllDisplays().map(d => d.bounds) })))
  for (const w of windowState) {
    assert.equal(w.focused, false)
    for (const d of w.displays) assert.ok(w.bounds.x + w.bounds.width <= d.x || w.bounds.x >= d.x + d.width || w.bounds.y + w.bounds.height <= d.y || w.bounds.y >= d.y + d.height)
  }
  results.windowState = windowState
  results.project = project.path
  results.refusal = await page.getByText(/Cannot start local\/qwen3\.6-35b-a3b/).first().textContent()
  await page.screenshot({ path: join(output, 'admission-refusal.png'), fullPage: true })
  assert.deepEqual(readRunRecord(small), before, 'Owner record must remain unchanged')
  assert.ok((await health(before.port, key)).models?.includes(QWEN_9B), 'Owner server must remain healthy')
  results.checks.push('35B refusal shown in app; 9B named and preserved; window parked off all displays and unfocused')
} catch (error) { results.error = String(error); throw error }
finally { await writeFile(join(output, 'smoke-admission.json'), JSON.stringify(results, null, 2)); await app.close() }
console.log(JSON.stringify(results, null, 2))
