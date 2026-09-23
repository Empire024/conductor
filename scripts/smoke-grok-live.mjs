import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// Live Grok check: the real `grok agent stdio` (signed in) -> GrokAdapter -> SQLite -> the real,
// parked Electron window. Run `npx electron-vite build` first. Costs a few cents of Grok usage.
// Covers: launcher tile, runtime catalog, Ask approval card, an applied edit, a command, the reply,
// interrupt, resume on a new runtime with the same native session, and an Auto turn with no card.
const root = await mkdtemp(join(tmpdir(), 'conductor-grok-live-'))
const output = resolve('artifacts/grok-live')
await mkdir(output, { recursive: true })
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_OFFLINE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
const results = { root, checks: [], failures: [] }
const snapshot = (page, id) => page.evaluate(id => window.conductor.structured.snapshot(id), id)
const chooseMode = async (page, label) => {
  await page.getByRole('button', { name: 'Conversation mode', exact: true }).click()
  await page.getByRole('menuitemradio', { name: new RegExp('^' + label) }).click()
  await expect(page.getByRole('button', { name: 'Conversation mode', exact: true })).toContainText(label)
}
const assistantText = state => state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join('\n')
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const providers = await page.evaluate(() => window.conductor.agents.listProviders())
  const grok = providers.find(provider => provider.id === 'grok')
  assert.ok(grok?.available, 'Grok is listed and its CLI resolved')
  results.checks.push(`Provider list resolves Grok at ${grok.executable ?? 'its install location'}`)
  const project = await page.evaluate(() => window.conductor.projects.create('Grok live'))
  await writeFile(join(project.path, 'notes.txt'), 'one\n')
  await page.reload()
  await page.getByText('Grok live', { exact: true }).first().click()
  if (!await page.locator('.launcher-grid').count()) await page.locator('.session-add').click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Grok' }).first().click()
  await page.locator('.structured-agent-pane').waitFor()
  const sessionId = await page.locator('.structured-agent-pane').getAttribute('data-structured-session')
  results.checks.push('Launcher tile opens a structured Grok conversation')

  const composer = page.getByRole('textbox', { name: /message|prompt/i }).last()
  await expect(composer).toHaveAttribute('placeholder', /Grok/)
  // Ask mode: the edit must wait for the owner.
  await chooseMode(page, 'Ask')
  await composer.fill('Use your edit tool to append a new line "two" to notes.txt. Then run this shell command: node -e "console.log(6*7)". Finally reply with just the number it printed.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot(page, sessionId))?.phase, { timeout: 120_000 }).toBe('waiting_approval')
  assert.equal(await readFile(join(project.path, 'notes.txt'), 'utf8'), 'one\n', 'nothing is written before the owner allows it')
  await page.screenshot({ path: join(output, '1-approval.png') })
  // Allow each request Grok makes this turn (the edit, and the command if Grok asks for it).
  const deadline = Date.now() + 180_000
  let state
  while (Date.now() < deadline) {
    state = await snapshot(page, sessionId)
    if (['completed', 'failed', 'interrupted', 'disconnected'].includes(state.phase)) break
    const allow = page.getByRole('button', { name: /^Yes(, proceed)?$|^Allow once$/ }).first()
    if (state.phase === 'waiting_approval' && await allow.count()) await allow.click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  assert.equal(state.phase, 'completed', `turn completed (was ${state.phase})`)
  assert.match((await readFile(join(project.path, 'notes.txt'), 'utf8')).replace(/\r\n/g, '\n'), /one\ntwo/)
  assert.ok(state.items.some(item => item.data.type === 'changes' && item.data.changes.some(change => change.status === 'applied')), 'the edit is recorded as an applied change')
  assert.ok(state.items.some(item => item.data.type === 'tool' && /42/.test(item.data.output ?? '')), 'the command output is recorded')
  assert.match(assistantText(state), /42/)
  assert.ok(state.items.some(item => item.data.type === 'usage' && item.data.scope === 'turn' && item.data.inputTokens > 0), 'turn usage is recorded')
  assert.ok(state.capabilities.models.some(model => model.id === 'grok-4.7'), 'the signed-in catalog replaced the static one')
  await page.screenshot({ path: join(output, '2-completed.png') })
  results.checks.push('Ask: the edit waited for the owner, then the edit applied, the command ran and Grok replied 42, with usage')

  // Interrupt a running turn.
  await composer.fill('Count slowly from 1 to 400, one number per line, thinking carefully about each one.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot(page, sessionId))?.phase, { timeout: 60_000 }).toBe('running')
  await page.waitForTimeout(2500)
  await page.evaluate(id => window.conductor.structured.interrupt(id), sessionId)
  await expect.poll(async () => (await snapshot(page, sessionId))?.phase, { timeout: 60_000 }).toMatch(/interrupted|completed/)
  results.checks.push(`Interrupt settled the turn as ${(await snapshot(page, sessionId)).phase}`)

  // Resume on a new runtime keeps the native conversation.
  const before = await snapshot(page, sessionId)
  await page.evaluate(({ id, settings }) => window.conductor.structured.resume(id, settings), { id: sessionId, settings: before.settings })
  await expect.poll(async () => { const now = await snapshot(page, sessionId); return now.runtimeId !== before.runtimeId && now.phase === 'idle' }, { timeout: 60_000 }).toBe(true)
  const resumed = await snapshot(page, sessionId)
  assert.equal(resumed.nativeSessionId, before.nativeSessionId, 'resume keeps the same Grok session')
  // Auto: the same kind of edit needs no card, and Grok remembers the earlier turn.
  await chooseMode(page, 'Auto')
  await composer.fill('Append a new line "three" to notes.txt with your edit tool, then tell me which number you printed earlier in this conversation.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect.poll(async () => (await snapshot(page, sessionId))?.phase, { timeout: 180_000 }).toBe('completed')
  const auto = await snapshot(page, sessionId)
  assert.match((await readFile(join(project.path, 'notes.txt'), 'utf8')).replace(/\r\n/g, '\n'), /two\nthree/)
  const turnStart = auto.items.findLastIndex(item => item.data.type === 'text' && item.data.role === 'user')
  assert.ok(!auto.items.slice(turnStart).some(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending'), 'Auto raised no owner card')
  assert.match(assistantText({ items: auto.items.slice(turnStart) }), /42/)
  await page.screenshot({ path: join(output, '3-auto.png') })
  results.checks.push('Resume kept the native session; Auto edited without a card and Grok remembered the earlier answer')
  if (errors.length) results.failures.push(...errors)
} catch (error) {
  results.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  try { await (await app.firstWindow()).screenshot({ path: join(output, 'failure.png') }) } catch { /* window gone */ }
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify(results, null, 2))
if (results.failures.length) process.exit(1)
