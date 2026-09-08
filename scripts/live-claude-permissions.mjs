import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { nativeSessionModeSelection, observedUsageCost, validateNativeSessionModeVerification } from './claude-permission-acceptance-guard.mjs'
import { mkdir, mkdtemp, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// This is a distinct owner-requested permission scenario. It never reads, changes,
// resets, or substitutes prompts in the retained live-Codex suite.
if (process.env.CONDUCTOR_PERMISSION_ACCEPTANCE !== '1') {
  console.log(JSON.stringify({ status: 'skipped', reason: 'CONDUCTOR_PERMISSION_ACCEPTANCE is off; no provider was started.' }))
  process.exit(0)
}
assert.notEqual(process.env.CONDUCTOR_LIVE_TESTS, '1', 'Run this separate scenario without enabling the capped A/B suite')
assert.notEqual(process.env.CONDUCTOR_OFFLINE_TESTS, '1', 'This scenario requires the real Claude provider')
const verification = nativeSessionModeSelection(process.argv.slice(2))
const model = 'sonnet', effort = 'low'
const prompt = 'Perform exactly these five tool calls sequentially, waiting for each result before the next. First use Write to create session-proof.txt containing exactly first followed by a newline. Second use a separate Write call to overwrite that same file with exactly second followed by a newline. Then use Bash to run exactly node --version three separate times, one Bash call per command. Continue to the next listed call if a permission is denied; never retry a call. Use no other tools, commands, reads, browsing, delegation, configuration changes, or files. Do not combine calls. Finish with one short sentence.'
const evidenceRoot = resolve('artifacts/live-claude-permissions')
await mkdir(evidenceRoot, { recursive: true })
let evidenceDirectory = evidenceRoot
let priorAccounting = { knownCostUsd: 0, costUnknown: false, activeMs: 0, approvalWaitMs: 0 }
const allowancePath = join(evidenceRoot, 'allowance.json')
const lockPath = join(evidenceRoot, 'running.lock')
const lock = await open(lockPath, 'wx') // A concurrent invocation cannot reserve the same allowance.
await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
let allowance, app, page, sessionId, project, watchdog, forcedClose
let state, submittedAt, previousTick, activeMs = 0, approvalMs = 0, boundaryError, autoReissued = false
const decisions = new Map()
const results = {
  status: 'preflight', provider: 'claude', model, effort, authentication: 'existing CLI configuration',
  prompt, checks: [], approvals: [], observations: [], screenshots: [], failures: [],
  limits: { submissions: verification ? 2 : 1, activeMs: 90_000, approvalWaitMs: 30_000, observedCostUsd: verification ? 0.50 : 0.25 },
  limitations: [
    'Cost telemetry is observed, not an authoritative charge; Claude may report cost only when the turn finishes.',
    'Native provider policy and permission suggestions are preserved. Unsupported session grants or auto-mode refusals stop this scenario without another prompt.',
    'The live scenario has one turn; session grant expiry across runtime restart remains covered by the adapter regression tests.'
  ]
}
class ObservedLimitation extends Error {}
const bounded = async (promise, timeout, fallback) => {
  let timer
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), timeout) })]) }
  finally { clearTimeout(timer) }
}
const snapshot = () => page.evaluate(id => window.conductor.structured.snapshot(id), sessionId)
const record = async (name, value = state) => {
  await writeFile(join(evidenceDirectory, name + '.json'), JSON.stringify(value, null, 2))
}
const screenshot = async name => {
  const path = join(evidenceDirectory, name + '.png')
  await page.screenshot({ path, fullPage: true, timeout: 5000 })
  results.screenshots.push(path)
}
const inventory = async (root, prefix = '') => {
  const entries = []
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (item.name === '.git') continue
    const path = prefix ? prefix + '/' + item.name : item.name
    if (item.isDirectory()) entries.push(...await inventory(root, path))
    else { assert.ok(item.isFile(), 'Fixture unexpectedly contains a non-file: ' + path); entries.push([path, (await readFile(join(root, path))).toString('base64')]) }
  }
  return entries.sort(([a], [b]) => a.localeCompare(b))
}
const accountCost = (value, events = []) => {
  const current = observedUsageCost(value, events)
  results.runObservedCostUsd = current.costUnknown ? null : current.knownCostUsd
  results.costUnknown = priorAccounting.costUnknown || current.costUnknown
  results.observedCostUsd = priorAccounting.knownCostUsd + current.knownCostUsd
}
const stopAtBoundary = message => {
  if (boundaryError) return
  boundaryError = new Error(message)
  // Stop only the native conversation created by this harness. Closing the isolated
  // Electron instance also disposes its owned provider process if interrupt stalls.
  if (page && sessionId) void page.evaluate(id => window.conductor.structured.interrupt(id), sessionId).catch(() => {})
  forcedClose = setTimeout(() => { if (app) void app.close().catch(() => {}) }, 1500)
}
const clock = () => {
  if (!submittedAt || boundaryError) return
  const time = Date.now(), elapsed = time - previousTick
  previousTick = time
  if (['waiting_approval', 'waiting_input'].includes(state?.phase)) approvalMs += elapsed
  else activeMs += elapsed
  if (activeMs >= 90_000) stopAtBoundary('The 90 second active runtime boundary was reached')
  else if (approvalMs >= 30_000) stopAtBoundary('The 30 second cumulative approval-wait boundary was reached')
  else if (priorAccounting.activeMs + priorAccounting.approvalWaitMs + time - submittedAt >= 120_000) stopAtBoundary('The 120 second total runtime boundary was reached')
}
const verifyToolScope = value => {
  const tools = value.items.filter(item => item.data.type === 'tool')
  assert.ok(tools.length <= 5, 'Claude attempted more than the five fixed fixture operations')
  for (const [index, item] of tools.entries()) {
    const expectedName = index < 2 ? 'Write' : 'Bash'
    assert.equal(item.data.name, expectedName, 'Tool order or scope differs from the fixed fixture')
    const input = item.data.input
    if (!input || item.data.status === 'preparing' && !input.file_path && !input.command) continue
    if (index < 2) {
      assert.equal(typeof input.file_path, 'string', 'Write must report its target path')
      assert.equal(resolve(project.path, input.file_path).toLowerCase(), resolve(project.path, 'session-proof.txt').toLowerCase(), 'Write escaped the fixture file')
      assert.equal(input.content, index === 0 ? 'first\n' : 'second\n', 'Write content differs from the fixed fixture')
    } else assert.equal(input.command, 'node --version', 'Bash must execute the exact harmless command')
  }
  return tools
}
try {
  try { allowance = JSON.parse(await readFile(allowancePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (verification) {
    // Select once by an exact CLI flag; preserve every original artifact in place.
    evidenceDirectory = join(evidenceRoot, 'native-session-mode-preflight-' + ((allowance?.nativeSessionModeVerification?.preflightAttempts ?? 0) + 1) + '-' + Date.now())
    await mkdir(evidenceDirectory, { recursive: true })
    const originalBytes = await readFile(join(evidenceRoot, 'results.json'))
    const originalSha256 = createHash('sha256').update(originalBytes).digest('hex')
    const original = JSON.parse(originalBytes.toString('utf8'))
    priorAccounting = validateNativeSessionModeVerification(allowance, original, originalSha256, prompt)
    await assert.rejects(readFile(join(original.project.path, 'session-proof.txt')), error => error.code === 'ENOENT', 'The original first Write must not have produced a file')
    activeMs = priorAccounting.activeMs; approvalMs = priorAccounting.approvalWaitMs
    allowance.nativeSessionModeVerification = {
      ...allowance.nativeSessionModeVerification,
      kind: 'one-native-session-mode-verification', selectedBy: '--verify-native-session-mode',
      selectedAt: allowance.nativeSessionModeVerification?.selectedAt ?? new Date().toISOString(),
      reason: 'Verify the implementation fix for the native first-Write setMode acceptEdits/session suggestion; original operation never executed',
      originalSha256, originalResults: join(evidenceRoot, 'results.json'), priorAccounting,
      aggregateSubmissionLimit: 2, aggregateObservedCostCapUsd: 0.50,
      remainingObservedCostUsd: 0.50 - priorAccounting.knownCostUsd,
      preflightAttempts: (allowance.nativeSessionModeVerification?.preflightAttempts ?? 0) + 1,
      evidenceDirectory
    }
    results.amendment = allowance.nativeSessionModeVerification
    results.priorAccounting = priorAccounting
  } else assert.ok(!allowance?.submissions, 'This permission scenario already reserved its one prompt. Inspect retained evidence; automatic retries are prohibited')
  const root = allowance?.root ?? await mkdtemp(join(tmpdir(), 'conductor-claude-permissions-'))
  allowance = { ...allowance, root, model, effort, submissions: allowance?.submissions ?? 0, preflightAttempts: (allowance?.preflightAttempts ?? 0) + (verification ? 0 : 1) }
  await writeFile(allowancePath, JSON.stringify(allowance, null, 2))
  results.root = root
  const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: join(root, 'profile'), CONDUCTOR_PROJECTS_ROOT: join(root, 'projects') }
  delete env.ELECTRON_RUN_AS_NODE
  // No auth variables or Claude settings sources are changed. CLI authentication,
  // project settings, hooks and mandatory native approval boundaries remain intact.
  app = await electron.launch({ args: [resolve('out/main/index.js')], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(5000)
  await page.waitForFunction(() => Boolean(window.conductor?.structured), undefined, { timeout: 15_000 })
  const name = verification ? 'Claude native session mode verification ' + allowance.nativeSessionModeVerification.preflightAttempts : 'Claude permission acceptance ' + allowance.preflightAttempts
  project = await page.evaluate(title => window.conductor.projects.create(title), name)
  results.project = { id: project.id, path: project.path }
  await mkdir(join(project.path, '.claude'), { recursive: true })
  const nativeSettings = JSON.stringify({ permissions: { ask: ['Bash(node --version)'] } }, null, 2) + '\n'
  await writeFile(join(project.path, '.claude', 'settings.local.json'), nativeSettings)
  await page.reload()
  await page.getByText(name, { exact: true }).first().click()
  await page.locator('.launcher-grid button').filter({ hasText: 'Claude' }).click()
  const pane = page.locator('.structured-agent-pane[data-provider="claude"]')
  await pane.waitFor()
  sessionId = await pane.getAttribute('data-structured-session')
  assert.ok(sessionId, 'The visible Claude tab must identify its native session')
  results.agentSessionId = sessionId
  await pane.getByRole('combobox', { name: 'Model', exact: true }).click()
  await expect.poll(async () => {
    state = await snapshot()
    if (['failed', 'disconnected'].includes(state?.phase)) throw new Error('Claude failed during model discovery')
    return Boolean(state?.phase === 'idle' && state.capabilities?.models?.length)
  }, { timeout: 30_000 }).toBe(true)
  const capabilities = state.capabilities
  results.capabilities = capabilities
  assert.equal(capabilities.provider, 'claude')
  assert.equal(capabilities.authentication, 'cli', 'The existing CLI authentication route must be retained')
  assert.ok(capabilities.approvals && capabilities.permissions.includes('auto'), 'Native approval and auto-mode capabilities are required')
  const selected = capabilities.models.find(choice => choice.id === model)
  assert.ok(selected, 'The discovered runtime must offer the actual sonnet model; substitutions are prohibited')
  assert.ok(selected.effort?.includes(effort), 'The discovered sonnet model must support low effort')
  const modelSearch = pane.getByRole('textbox', { name: 'Search models', exact: true })
  await modelSearch.fill(model)
  await expect(pane.getByRole('option')).toHaveCount(1)
  await modelSearch.press('Enter')
  await expect(pane.getByRole('combobox', { name: 'Model', exact: true })).toContainText(selected.label)
  const slider = pane.getByRole('slider', { name: 'Reasoning effort', exact: true })
  await slider.press('Home')
  for (let index = 0; index < selected.effort.filter(choice => choice && choice !== 'auto').indexOf('low'); index++) await slider.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuetext', 'Low')
  const mode = pane.getByRole('button', { name: 'Conversation mode', exact: true })
  await expect(mode).toContainText('Ask')
  const composer = pane.getByRole('textbox', { name: 'Message Claude Code', exact: true })
  const send = pane.getByRole('button', { name: 'Send message', exact: true })
  await composer.fill(prompt)
  await expect(send).toBeEnabled() // Validate all composer selectors before consuming the retained allowance.
  const baseline = await inventory(project.path)
  await screenshot('preflight')
  await record('preflight-state', state)
  results.checks.push('Visible native Claude tab discovered sonnet/low, existing CLI authentication and native auto capability')
  assert.equal(allowance.submissions, verification ? 1 : 0, 'Only the selected original or single verification prompt may be reserved')
  allowance.submissions++
  if (verification) allowance.nativeSessionModeVerification.reservedAt = new Date().toISOString()
  else allowance.reservedAt = new Date().toISOString()
  await writeFile(allowancePath, JSON.stringify(allowance, null, 2)) // Retained before any possible UI dispatch.
  results.status = 'running'
  submittedAt = previousTick = Date.now()
  watchdog = setInterval(clock, 100)
  await send.click()
  let observedUser = false, lastSequence = -1
  for (;;) {
    clock()
    if (boundaryError) throw boundaryError
    state = await snapshot()
    assert.ok(state, 'The native conversation disappeared')
    const userItems = state.items.filter(item => item.data.type === 'text' && item.data.role === 'user')
    assert.ok(userItems.length <= 1, 'A helper, retry or second user prompt was observed')
    observedUser ||= userItems.length === 1
    if (observedUser) {
      assert.equal(state.settings.model, model, 'The native turn must use the approved discovered model')
      assert.equal(state.settings.effort, effort, 'The native turn must use low effort')
    }
    accountCost(state)
    if (results.observedCostUsd >= results.limits.observedCostUsd) { stopAtBoundary('Aggregate observed Claude cost telemetry reached the cap of USD ' + results.limits.observedCostUsd.toFixed(2)); throw boundaryError }
    if (state.sequence !== lastSequence) {
      lastSequence = state.sequence
      results.observations.push({ at: new Date().toISOString(), sequence: state.sequence, phase: state.phase, permission: state.settings.permission, activeMs, approvalMs, observedCostUsd: results.observedCostUsd })
    }
    const tools = verifyToolScope(state)
    const pending = state.items.filter(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending')
    assert.ok(pending.length <= 1, 'The fixture requires sequential calls and one pending approval')
    for (const item of pending) {
      const request = item.data.interaction
      assert.equal(request.kind, 'approval', 'The fixed scenario requires no extra user question')
      if (decisions.has(request.id)) continue // Never resend a decision after an uncertain result.
      const toolIndex = tools.findIndex(tool => tool.nativeItemId === item.nativeItemId)
      assert.ok(toolIndex >= 0, 'Approval must identify a native fixture tool')
      if (toolIndex === 1) throw new ObservedLimitation('Claude requested the second Write despite the native session grant; no host approval cache is used')
      let expected = toolIndex === 0 ? { id: 'allow-session', label: 'Allow for this session' }
        : toolIndex === 2 ? { id: 'auto-mode', label: 'Switch to auto-mode' }
          : toolIndex === 3 ? { id: 'deny', label: 'Deny' } : { id: 'allow', label: 'Allow once' }
      const previousAuto = results.approvals.find(approval => approval.toolId === item.nativeItemId && approval.decision === 'auto-mode')
      let nativeReissue = false
      if (toolIndex === 2 && previousAuto) {
        const previousRequest = state.items.find(entry => entry.data.type === 'interaction' && entry.data.interaction.id === previousAuto.requestId)?.data.interaction
        assert.ok(!autoReissued && request.id !== previousAuto.requestId && previousRequest?.status === 'expired' && state.settings.permission === 'auto', 'Only one exact native replacement for the expired auto-mode request may be approved')
        nativeReissue = autoReissued = true
        expected = { id: 'allow', label: 'Allow once' }
        await expect(mode).toContainText('Auto')
        results.checks.push('Claude cancelled the original auto-mode request and reissued the same mandatory tool approval; allowed that new request once without resending a tool or stale decision')
      }
      const choice = request.choices.find(candidate => candidate.id === expected.id)
      if (!choice || choice.disabled) throw new ObservedLimitation('Native Claude did not offer ' + expected.label + ': ' + (choice?.description ?? 'choice unavailable'))
      const card = pane.getByRole('form', { name: 'approval: ' + request.title, exact: true })
      await expect(card.getByRole('button', { name: 'Allow for this session', exact: true })).toBeVisible()
      await expect(card.getByRole('button', { name: 'Switch to auto-mode', exact: true })).toBeVisible()
      if (toolIndex === 0) assert.match(choice.description ?? '', /Only this running Claude session/)
      else {
        assert.equal(await readFile(join(project.path, 'session-proof.txt'), 'utf8'), 'second\n', 'Both sequential writes must complete before commands')
        assert.ok(decisions.size >= 1, 'The first Write never produced a reusable approval')
      }
      if (toolIndex === 2 && !previousAuto) {
        if (state.settings.permission === 'accept-edits') {
          assert.deepEqual(state.settings.temporaryPermission, { runtimeId: state.runtimeId, restore: 'default' }, 'Session Edit must restore the original Ask setting outside this native runtime')
          await expect(mode).toContainText('Edit')
          results.checks.push('Native session Edit is explicitly temporary and bound to this runtime; its saved restore setting is Ask')
        } else assert.equal(state.settings.permission, 'default', 'A tool-scoped session grant must retain Ask mode')
      }
      if (toolIndex >= 3) {
        assert.equal(state.settings.temporaryPermission, undefined, 'Explicit auto-mode must replace the temporary session Edit setting')
        assert.equal(state.settings.permission, 'auto', 'Native auto-mode must remain active across mandatory approvals')
        await expect(mode).toContainText('Auto')
      }
      const approvalEvidence = 'approval-' + toolIndex + (nativeReissue ? '-reissued' : '')
      await screenshot(approvalEvidence)
      await record(approvalEvidence, state)
      decisions.set(request.id, expected.id)
      results.approvals.push({ requestId: request.id, toolId: item.nativeItemId, toolIndex, decision: expected.id, nativeReissue, at: new Date().toISOString(), choices: request.choices, input: request.input })
      await card.getByRole('button', { name: expected.label, exact: true }).click()
    }
    const uiError = await pane.locator('.sa-error-bar, .sa-interaction [role="alert"]').allTextContents()
    if (uiError.some(Boolean)) throw new ObservedLimitation('Native permission action reported: ' + uiError.join(' '))
    if (observedUser && ['completed', 'failed', 'disconnected', 'interrupted'].includes(state.phase)) break
    if (tools.length >= 2 && decisions.size === 0) throw new ObservedLimitation('Native Claude permitted the initial Write without a reusable approval; session-grant acceptance could not be exercised')
    await page.waitForTimeout(150)
  }
  clearInterval(watchdog)
  assert.equal(state.phase, 'completed', 'The fixed native permission turn must complete')
  assert.equal(decisions.size, autoReissued ? 5 : 4, 'Expected session grant, auto-mode, deny and allow-once; native policy did not expose every required action')
  assert.deepEqual(results.approvals.map(item => item.decision), autoReissued ? ['allow-session', 'auto-mode', 'allow', 'deny', 'allow'] : ['allow-session', 'auto-mode', 'deny', 'allow'])
  const tools = verifyToolScope(state)
  assert.equal(tools.length, 5)
  assert.deepEqual(tools.slice(0, 2).map(item => item.data.status), ['completed', 'completed'])
  assert.equal(tools[2].data.status, 'completed')
  assert.equal(tools[3].data.status, 'rejected')
  assert.equal(tools[4].data.status, 'completed')
  for (const index of [2, 4]) assert.match(tools[index].data.output ?? '', /\bv\d+\.\d+\.\d+\b/, 'Allowed commands must return a native Node version result')
  assert.doesNotMatch(tools[3].data.output ?? '', /\bv\d+\.\d+\.\d+\b/, 'The denied command must not return an executed Node version')
  assert.equal(state.settings.permission, 'auto')
  await expect(mode).toContainText('Auto')
  assert.equal(await readFile(join(project.path, 'session-proof.txt'), 'utf8'), 'second\n')
  assert.equal(await readFile(join(project.path, '.claude', 'settings.local.json'), 'utf8'), nativeSettings)
  assert.deepEqual((await inventory(project.path)).filter(([path]) => path !== 'session-proof.txt'), baseline, 'The scenario changed unrelated fixture files or persisted permission configuration')
  assert.ok(state.items.filter(item => item.data.type === 'interaction').every(item => item.data.interaction.status !== 'pending'), 'No native approval may remain pending')
  results.nativeSessionId = state.nativeSessionId
  results.checks.push('First Write used an explicit native session scope; second Write completed without asking again', 'Auto-mode changed native and visible state while later mandatory Bash approvals still appeared', 'Deny prevented command execution; Allow once returned the real Node version; every pending request resolved', 'Only session-proof.txt changed; project permission settings were not persisted or widened')
  await screenshot('completed')
  results.status = 'live-verified'
} catch (error) {
  results.status = error instanceof ObservedLimitation ? 'observed-limitation' : 'failed'
  results.failures.push(error.stack ?? String(error))
  process.exitCode = 1
  if (submittedAt) stopAtBoundary(error.message ?? String(error))
  if (page) await bounded(screenshot('failure').catch(() => {}), 1200)
} finally {
  clearInterval(watchdog)
  results.activeMs = activeMs
  results.approvalWaitMs = approvalMs
  results.aggregateSubmissions = allowance?.submissions ?? 0
  results.runActiveMs = activeMs - priorAccounting.activeMs
  results.runApprovalWaitMs = approvalMs - priorAccounting.approvalWaitMs
  if (page && sessionId) {
    if (results.status !== 'live-verified') await bounded(page.evaluate(id => window.conductor.structured.interrupt(id), sessionId).catch(() => {}), 1500)
    results.finalState = await bounded(snapshot().catch(() => state), 1500, state)
    results.events = await bounded(page.evaluate(id => window.conductor.structured.events(id), sessionId).catch(() => []), 1500, [])
  }
  if (submittedAt) {
    accountCost(results.finalState ?? state, results.events ?? [])
    if (results.observedCostUsd >= results.limits.observedCostUsd) {
      results.status = 'failed'; process.exitCode = 1
      results.failures.push('Final aggregate cost telemetry reached the cap of USD ' + results.limits.observedCostUsd.toFixed(2))
    }
    const accounting = { activeMs, approvalWaitMs: approvalMs, knownCostUsd: results.observedCostUsd, costUnknown: results.costUnknown }
    if (verification) allowance.nativeSessionModeVerification.accounting = accounting
    else allowance.accounting = accounting
    await writeFile(allowancePath, JSON.stringify(allowance, null, 2))
  }
  const refusedConsumedAllowance = allowance?.submissions && !submittedAt && !verification
  await record(refusedConsumedAllowance ? 'refused-' + Date.now() : 'results', results)
  if (!submittedAt && !refusedConsumedAllowance) await record('preflight-' + (allowance?.preflightAttempts ?? 0), results)
  if (app) await bounded(app.close().catch(() => {}), 5000)
  clearTimeout(forcedClose)
  await lock.close()
  await unlink(lockPath)
}
console.log(JSON.stringify({ status: results.status, checks: results.checks, failures: results.failures, submissions: results.aggregateSubmissions, evidenceRoot, evidenceDirectory, observedCostUsd: results.observedCostUsd, costUnknown: results.costUnknown }, null, 2))
