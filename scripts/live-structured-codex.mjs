import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { isFixtureApproval, isFixtureTestCommand } from './live-acceptance-guard.mjs'

if (process.env.CONDUCTOR_LIVE_TESTS !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'CONDUCTOR_LIVE_TESTS is off; no provider connection or inference occurred.' }))
  process.exit(0)
}
const model = process.env.CONDUCTOR_LIVE_MODEL_CODEX
const auth = process.env.CONDUCTOR_LIVE_AUTH_CODEX
assert.ok(model && auth === 'cli', 'Explicit allowed model and existing CLI auth are required; this harness does not enable API billing')
const evidence = resolve('artifacts/live-codex')
await mkdir(evidence, { recursive: true })
const allowancePath = join(evidence, 'allowance.json')
let prior
try { prior = JSON.parse(await readFile(allowancePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (prior?.submissions > 0) throw new Error('This capped suite already submitted a prompt. Automatic retries are prohibited; inspect the retained evidence.')
const root = prior?.root ?? await mkdtemp(join(tmpdir(), 'conductor-live-codex-'))
const suiteId = prior?.suiteId ?? `conductor-codex-${Date.now()}`
const allowance = { suiteId, root, model, auth, submissions: 0, preflightAttempts: (prior?.preflightAttempts ?? 1) + (prior ? 1 : 0) }
await writeFile(allowancePath, JSON.stringify(allowance, null, 2))
const promptA = 'In panel.mjs, remove only the two unused declarations wasOpen and wasPinned. Change nothing else. Run node --test panel.test.mjs once. Do not browse, inspect unrelated files, install packages, or delegate. Report the test result and changed file in no more than 35 words.'
const promptB = 'Without using tools, name the two identifiers you removed and say whether the test passed. One sentence.'
const results = { status: 'running', suiteId, model, effort: 'low', authentication: 'existing CLI ChatGPT authentication', prompts: [], checks: [], limitations: ['Native Codex internal model-step limits are not exposed; host time and submission allowance are enforced.', 'Subscription cost telemetry is not an authoritative USD charge.'], screenshots: [], failures: [] }
const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_LIVE_FIXTURE_ROOT: root, CONDUCTOR_LIVE_SUITE_ID: suiteId, CONDUCTOR_LIVE_MODEL_CODEX: model, CONDUCTOR_LIVE_AUTH_CODEX: auth, CONDUCTOR_LIVE_OPTIONAL_MCP: JSON.stringify(['chrome-devtools', 'node_repl']) }
delete env.ELECTRON_RUN_AS_NODE
delete env.CONDUCTOR_OFFLINE_TESTS
const app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30000 })
let page, sessionId
try {
  page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.conductor?.structured))
  const projectName = allowance.preflightAttempts === 1 ? 'Codex live acceptance' : `Codex live acceptance preflight ${allowance.preflightAttempts}`
  const project = await page.evaluate(name => window.conductor.projects.create(name), projectName)
  await copyFile(resolve('scripts/fixtures/panel.mjs'), join(project.path, 'panel.mjs'))
  await copyFile(resolve('scripts/fixtures/panel.test.mjs'), join(project.path, 'panel.test.mjs'))
  await writeFile(join(project.path, '.conductor-live-fixture.json'), JSON.stringify({ suiteId, provider: 'codex' }))
  execFileSync('git', ['init', '--quiet'], { cwd: project.path, windowsHide: true })
  const baseline = await readFile(join(project.path, 'panel.mjs'), 'utf8')
  const expected = baseline.split('\n').filter(line => !line.includes('var wasOpen') && !line.includes('var wasPinned')).join('\n')
  const runTest = () => { try { return { code: 0, output: execFileSync(process.execPath, ['--test', 'panel.test.mjs'], { cwd: project.path, encoding: 'utf8', windowsHide: true }) } } catch (error) { return { code: error.status, output: String(error.stdout) } } }
  assert.notEqual(runTest().code, 0)
  await writeFile(join(project.path, 'panel.mjs'), expected)
  assert.equal(runTest().code, 0)
  await writeFile(join(project.path, 'panel.mjs'), baseline)
  assert.match(runTest().output, /contains must not be called/)
  results.checks.push('Local fixture baseline fails, exact two-line removal passes, restored baseline fails again')
  const baselineFiles = (await readdir(project.path)).sort()
  const originalMarker = await readFile(join(project.path, '.conductor-live-fixture.json'), 'utf8')
  const originalTest = await readFile(join(project.path, 'panel.test.mjs'), 'utf8')
  await page.reload()
  await page.getByText(projectName, { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Codex' }).click()
  const pane = page.locator('.structured-agent-pane')
  await pane.waitFor()
  sessionId = await pane.getAttribute('data-structured-session')
  await page.getByRole('button', { name: /Connect provider/ }).click()
  const visibleError = async () => await page.locator('.sa-error-bar').count() ? await page.locator('.sa-error-bar').first().textContent() : ''
  await expect.poll(async () => { const state = await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId); const error = await visibleError(); if (error) throw new Error(error); return Boolean(state?.nativeSessionId && state.phase === 'idle') }, { timeout: 45000 }).toBe(true)
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model)
  await page.getByLabel('Reasoning effort', { exact: true }).selectOption('low')
  await page.getByLabel('Execution sandbox', { exact: true }).selectOption('workspace-write')
  await page.getByLabel('Approval policy', { exact: true }).selectOption('untrusted')
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  const submit = async (prompt, label) => {
    allowance.submissions++
    await writeFile(allowancePath, JSON.stringify(allowance, null, 2)) // reserve outside a session before UI dispatch
    results.prompts.push({ label, submittedAt: new Date().toISOString(), text: prompt })
    await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const until = Date.now() + 120000
    let observedActive = false, approvals = 0
    while (Date.now() < until) {
      const state = await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
      const submitted = state.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length
      if (submitted >= allowance.submissions) observedActive = true
      if (observedActive && ['completed', 'failed', 'disconnected', 'interrupted'].includes(state.phase)) return { state, approvals }
      if (state.phase === 'waiting_approval') {
        const requests = state.items.filter(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending')
        const allowed = requests.length > 0 && requests.every(item => isFixtureApproval(item.data.interaction, state, project.path))
        assert.ok(allowed, 'Approval exceeded the harmless fixture operation scope')
        const button = page.getByRole('button', { name: 'Allow once', exact: true }).first()
        await button.click(); approvals++
      }
      const error = await visibleError()
      if (error) throw new Error(error)
      await page.waitForTimeout(150)
    }
    throw new Error('Live acceptance stopped at the host time boundary')
  }
  const a = await submit(promptA, 'A')
  assert.equal(a.state.phase, 'completed')
  assert.equal(await readFile(join(project.path, 'panel.mjs'), 'utf8'), expected)
  assert.equal(await readFile(join(project.path, 'panel.test.mjs'), 'utf8'), originalTest)
  assert.equal(await readFile(join(project.path, '.conductor-live-fixture.json'), 'utf8'), originalMarker)
  assert.deepEqual((await readdir(project.path)).sort(), baselineFiles)
  const applied = a.state.items.flatMap(item => item.data.type === 'changes' ? item.data.changes.filter(change => change.status === 'applied') : [])
  assert.ok(applied.some(change => change.path.endsWith('panel.mjs') && change.additions === 0 && change.deletions === 2))
  const commands = a.state.items.filter(item => item.data.type === 'tool' && isFixtureTestCommand(item.data.input?.command))
  assert.equal(commands.length, 1, 'The fixture test must execute exactly once')
  const command = commands[0]
  assert.equal(command.data.exitCode, 0)
  assert.ok(command && /pass/i.test(command.data.output ?? ''), 'A real command activity with passing output and exit status is required')
  results.checks.push('Live A changed only two declarations; native edit event and successful test command verified')
  results.liveApproval = a.approvals ? 'live-verified through UI' : 'unverified: runtime emitted no approval'
  results.nativeSessionId = a.state.nativeSessionId
  await page.screenshot({ path: join(evidence, 'live-a.png'), fullPage: true }); results.screenshots.push('artifacts/live-codex/live-a.png')
  await page.getByRole('button', { name: /Click to expand diff/ }).last().click()
  await page.getByRole('dialog').waitFor()
  await page.screenshot({ path: join(evidence, 'live-diff.png'), fullPage: true }); results.screenshots.push('artifacts/live-codex/live-diff.png')
  await page.keyboard.press('Escape')
  await page.locator('.pane-close-button').first().click()
  await expect(page.locator('.structured-agent-pane')).toHaveCount(0)
  await page.getByRole('button', { name: 'Reopen', exact: true }).click()
  await pane.waitFor()
  assert.equal((await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)).nativeSessionId, results.nativeSessionId)
  results.checks.push('Closed and reopened the real pane without resending prompt A')
  await page.reload()
  await pane.waitFor()
  const saved = await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
  assert.equal(saved.nativeSessionId, results.nativeSessionId)
  assert.equal(saved.items.filter(item => item.data.type === 'text' && item.data.role === 'user').length, 1)
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  await page.getByRole('button', { name: /Resume connection/ }).click()
  await expect.poll(async () => (await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId))?.phase, { timeout: 30000 }).toBe('idle')
  await page.getByRole('button', { name: 'Session settings', exact: true }).click()
  const beforeB = await page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
  const b = await submit(promptB, 'B')
  assert.equal(b.state.phase, 'completed')
  assert.equal(b.state.nativeSessionId, results.nativeSessionId)
  const bItems = b.state.items.filter(item => item.sequence > beforeB.sequence)
  assert.equal(bItems.filter(item => item.data.type === 'tool').length, 0)
  const answer = bItems.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => item.data.text).join(' ')
  assert.match(answer, /wasOpen/); assert.match(answer, /wasPinned/); assert.match(answer, /pass/i)
  results.checks.push('Native resume retained identity and context; live B named both identifiers and passed test without tools')
  results.usage = b.state.items.filter(item => item.data.type === 'usage').map(item => item.data)
  const change = applied.find(change => change.artifactId)
  if (change) {
    const artifact = await page.evaluate(({ sessionId, artifactId }) => window.conductor.structured.artifact(sessionId, artifactId), { sessionId, artifactId: change.artifactId })
    await writeFile(join(project.path, 'panel.mjs'), expected + '// Later local work\n')
    assert.deepEqual(await page.evaluate(({ sessionId, artifactId }) => window.conductor.structured.artifact(sessionId, artifactId), { sessionId, artifactId: change.artifactId }), artifact)
    const outcome = await page.evaluate(({ sessionId, artifactId }) => window.conductor.structured.review(sessionId, artifactId, 'undo'), { sessionId, artifactId: change.artifactId })
    assert.equal(outcome.outcome, 'conflict')
    assert.match(await readFile(join(project.path, 'panel.mjs'), 'utf8'), /Later local work/)
    results.checks.push('Immutable historical diff survived subsequent local edit; Undo preserved conflicting later work')
  }
  results.status = 'live-verified'
} catch (error) {
  results.status = 'failed'; results.failures.push(error.stack ?? String(error)); process.exitCode = 1
  if (page) {
    await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {})
    results.failureUi = await page.evaluate(() => ({ text: document.body.innerText.slice(-16000), settingsExpanded: document.querySelector('[aria-label="Session settings"]')?.getAttribute('aria-expanded'), selects: [...document.querySelectorAll('.structured-agent-pane select')].map(select => ({ label: select.getAttribute('aria-label'), parentText: select.parentElement?.textContent?.slice(0, 500), value: select.value })) })).catch(() => null)
  }
}
finally {
  if (page && sessionId) {
    try { results.events = await page.evaluate(id => window.conductor.structured.events(id), sessionId) } catch {}
  }
  await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2))
  if (results.prompts.length === 0) await writeFile(join(evidence, `preflight-${allowance.preflightAttempts}.json`), JSON.stringify(results, null, 2))
  await app.close()
}
console.log(JSON.stringify({ status: results.status, prompts: results.prompts.map(prompt => prompt.label), checks: results.checks, failures: results.failures, evidence }, null, 2))
