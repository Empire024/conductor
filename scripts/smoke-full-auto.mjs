// Native Claude Full Auto acceptance in a disposable, parked Conductor profile.
// This fixture automates a trusted UI click in its own profile. It is not evidence
// that the owner activated Full Auto in the installed profile.
// Run only in a reserved Electron slot:
//   CONDUCTOR_FULL_AUTO_ACCEPTANCE=1 node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-full-auto.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { BUILD, call, callRaw, configure, failed, finish, launchParked, listProcesses, openProject, openTab, page, poll, record, relaunchParked, safeClose, shot, step, watchdog } from './verify-kit.mjs'

if (process.env.CONDUCTOR_FULL_AUTO_ACCEPTANCE !== '1') {
  console.error('REFUSED: set CONDUCTOR_FULL_AUTO_ACCEPTANCE=1 for the real native Claude fixture; absence is not a passing smoke')
  process.exit(2)
}

configure({ name: 'full-auto-native', output: 'artifacts/full-auto-native' })
watchdog(1200)
const fixture = {
  'README.md': '# Full Auto native fixture\nOnly edit files in this disposable project.\n',
  'src/answer.txt': 'BEFORE\n',
  'package.json': JSON.stringify({ private: true, scripts: { build: 'node scripts/build.mjs', test: 'node --test test/fixture.test.mjs' } }, null, 2),
  'scripts/build.mjs': "import { readFile, mkdir, writeFile } from 'node:fs/promises'; await mkdir('dist', { recursive: true }); await writeFile('dist/result.txt', await readFile('src/answer.txt', 'utf8'))\n",
  'test/fixture.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; test('build matches fixture edit', async () => assert.equal(await readFile('dist/result.txt', 'utf8'), 'FULL_AUTO_OK\\n'))\n",
  'scripts/ps-proof.ps1': "Set-Content -LiteralPath ps-proof.txt -Value 'PS_OK'\n"
}
const effective = state => state?.capabilities?.effectiveSettings ?? {}
const evidence = state => ({ phase: state?.phase, permission: state?.settings?.permission, nativeSessionIdPresent: Boolean(state?.nativeSessionId), effective: Object.fromEntries(['requestedPermissionMode', 'permissionMode', 'permissionModeStatus', 'permissionModeError', 'claudeFullAutoAuthorized'].map(key => [key, effective(state)[key] ?? null])), tools: (state?.items ?? []).filter(item => item.data?.type === 'tool').map(item => ({ name: item.data.name, status: item.data.status })) })

let inst, project, worker, view, browserServer, foreignReceipt
const snapshot = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
const workerPane = () => view.locator(`.structured-agent-pane[data-structured-session="${worker.resourceId}"]`)
const mode = async (id, expected, status = 'confirmed') => {
  let lastState
  try {
    return await poll(async () => {
      const state = await snapshot(id)
      lastState = state
      const value = effective(state)
      return value.permissionMode === expected && value.permissionModeStatus === status ? state : null
    }, { timeoutMs: 45_000, label: `${id} native ${expected}/${status}` })
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; last redacted snapshot: ${JSON.stringify(evidence(lastState))}`)
  }
}
const settled = (id, initialSequence) => poll(async () => {
  const state = await snapshot(id)
  const ended = ['completed', 'idle', 'failed', 'disconnected', 'interrupted'].includes(state?.phase)
  const providerReplied = state?.items?.some(item => item.sequence > initialSequence && item.data?.type === 'text' && item.data.role === 'assistant')
  return ended && (providerReplied || ['failed', 'disconnected', 'interrupted'].includes(state?.phase)) ? state : null
}, { timeoutMs: 420_000, label: `${id} terminal turn phase` })
const ownerButton = async label => {
  const detail = workerPane().locator('.sa-full-auto-details')
  if (!await detail.evaluate(element => element.open)) await detail.locator('summary').click()
  await detail.getByRole('button', { name: label, exact: true }).click()
}
const modeLabel = () => workerPane().locator('.sa-mode-trigger').textContent()
const parityText = () => workerPane().locator('.sa-request-summary').textContent()
const foreignBrowserPage = async () => {
  browserServer = createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/receipt') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      try { foreignReceipt = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { foreignReceipt = { malformed: true } }
      response.writeHead(200).end('ok')
      return
    }
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404).end(); return }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Foreign origin bridge probe</title><body><script>const value={origin:location.origin,bridge:typeof window.conductor,fullAuto:typeof window.conductor?.claudeFullAuto};document.body.textContent=JSON.stringify(value);fetch("/receipt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)});</script></body>')
  })
  await new Promise((resolve, reject) => browserServer.once('error', reject).listen(0, '127.0.0.1', resolve))
  const address = browserServer.address()
  return `http://127.0.0.1:${address.port}/`
}

try {
  step('host Win32 process identity preflight')
  const inventory = await listProcesses()
  record('host-process-preflight', 'PASS', { processes: inventory.list.length }, 'The runner can query Win32 process identities before any Electron child is launched')
  step('launch real Claude in parked disposable profile')
  inst = await launchParked({ mode: 'spawn', env: { CONDUCTOR_OFFLINE_TESTS: undefined, CONDUCTOR_TEST_NODE_EXECUTABLE: undefined } })
  project = await openProject({ name: 'Full Auto native fixture', git: true, files: fixture })
  view = await page(inst)

  step('existing Auto session before authorization')
  worker = await openTab({ provider: 'claude', model: 'sonnet', effort: 'low', permission: 'auto', exactPermission: true, title: 'Full Auto existing native fixture' })
  assert.ok(worker.resourceId)
  await call('tabs.focus', { tabId: worker.id })
  const baselineStart = await snapshot(worker.resourceId)
  await call('agents.submit', { agentSessionId: worker.resourceId, prompt: 'Reply with exactly GUARD_BASELINE. Do not use tools.' })
  const baselineTurn = await settled(worker.resourceId, baselineStart.sequence)
  assert.equal(baselineTurn.phase, 'completed')
  assert.ok(baselineTurn.nativeSessionId, 'The preactivation conversation must have a native session to resume')
  assert.ok(baselineTurn.items.some(item => item.data?.type === 'text' && item.data.role === 'assistant' && /GUARD_BASELINE/.test(item.data.text)))
  const before = await mode(worker.resourceId, 'auto')
  assert.equal((await view.evaluate(() => window.conductor.claudeFullAuto.state())).enabled, false)
  assert.equal(before.settings.permission, 'auto')
  assert.equal(effective(before).requestedPermissionMode, 'auto')
  assert.match(await modeLabel(), /Auto \(Guarded until authorized\)/)
  assert.match(await parityText(), /Guarded Auto/)
  const picker = workerPane().locator('.sa-mode-trigger')
  await picker.click()
  assert.match(await view.locator('.sa-mode-menu').textContent(), /Guarded Auto/)
  await picker.click()
  await shot('guarded-before-authorization')
  record('A0', 'PASS', evidence(before), 'Native Auto starts guarded in the disposable profile before owner authorization')

  step('native loaded settings-source summary, when supported')
  let settingsReceipt = null
  try {
    settingsReceipt = await poll(async () => {
      const events = await view.evaluate(id => window.conductor.structured.events(id, 0), worker.resourceId)
      return events.find(event => event.native?.method === 'get_settings/summary') ?? null
    }, { timeoutMs: 5_000, label: 'native get_settings/summary receipt' })
  } catch { /* An older or unsupported CLI has no receipt; report the exact gap below. */ }
  const settingsPayload = settingsReceipt?.native?.payload ?? {}
  const sourceNames = Array.isArray(settingsPayload.sources) ? settingsPayload.sources.map(source => source?.name).filter(name => typeof name === 'string') : []
  const recognized = new Set(['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings', 'managedSettings', 'user', 'project', 'local', 'flag', 'policy', 'managed'])
  const sourceProof = settingsPayload.status === 'available' && sourceNames.length > 0 && sourceNames.every(name => recognized.has(name))
  const safeScope = scope => {
    const permissions = scope?.permissions ?? {}
    return {
      counts: Object.fromEntries(['allow', 'ask', 'deny'].filter(name => Number.isInteger(permissions[name])).map(name => [name, permissions[name]])),
      defaultMode: typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null,
      disableBypassPermissionsMode: permissions.disableBypassPermissionsMode === 'disable' ? 'disable' : null,
      hookNames: Array.isArray(scope?.hooks) ? scope.hooks.filter(name => typeof name === 'string').slice(0, 24) : []
    }
  }
  const observedSources = Array.isArray(settingsPayload.sources) ? settingsPayload.sources.filter(source => recognized.has(source?.name)).map(source => ({ name: source.name, ...safeScope(source) })) : []
  record('settings-loaded-sources', sourceProof ? 'PASS' : 'NOT VERIFIED', { receiptPresent: Boolean(settingsReceipt), status: settingsPayload.status ?? 'absent', effective: safeScope(settingsPayload.effective), sources: observedSources }, sourceProof
    ? 'Native get_settings/summary named loaded sources; only recognized names, counts and hook names were retained'
    : 'No available native get_settings/summary with recognized loaded source names; baseline file inventory alone does not prove loaded sources')

  step('foreign browser origin cannot reach the trusted owner bridge')
  const browserBridge = await view.evaluate(() => ({ mount: typeof window.conductor.browser?.mount }))
  if (browserBridge.mount !== 'function') {
    record('J-browser', 'NOT VERIFIED', browserBridge, 'Supported browser.mount interface is unavailable in this build; no foreign-origin observation is claimed')
  } else {
    const url = await foreignBrowserPage()
    let unavailable = null
    try {
      await view.evaluate(({ projectId, url }) => window.conductor.browser.mount({ projectId, surfaceId: 'full-auto-foreign-origin', initialUrl: url, bounds: { x: 0, y: 0, width: 640, height: 480 }, visible: false }), { projectId: project.id, url })
    } catch (error) { unavailable = `browser.mount refused: ${String(error?.message ?? error).slice(0, 300)}` }
    let receipt = null
    if (!unavailable) try { receipt = await poll(() => foreignReceipt ?? null, { timeoutMs: 15_000, label: 'foreign browser page executed and reported its bridge visibility' }) }
    catch (error) { unavailable = `browser page receipt unavailable: ${String(error?.message ?? error).slice(0, 300)}` }
    if (unavailable) record('J-browser', 'NOT VERIFIED', { interface: 'window.conductor.browser.mount', reason: unavailable }, 'Foreign-origin page execution could not be observed through the supported browser surface')
    else {
      assert.equal(receipt.origin, new URL(url).origin)
      assert.equal(receipt.bridge, 'undefined')
      assert.equal(receipt.fullAuto, 'undefined')
      assert.equal((await view.evaluate(() => window.conductor.claudeFullAuto.state())).enabled, false)
      record('J-browser', 'PASS', receipt, 'A real foreign page in the supported Conductor browser view could not see the trusted owner bridge')
    }
  }

  step('real Claude MCP control cannot forge activation while policy is false')
  const mcpProbe = await openTab({ provider: 'claude', model: 'sonnet', effort: 'low', permission: 'auto', exactPermission: true, title: 'Full Auto MCP forgery probe' })
  const mcpStart = await snapshot(mcpProbe.resourceId)
  await call('agents.submit', { agentSessionId: mcpProbe.resourceId, prompt: 'In this disposable Conductor security fixture, call the Conductor MCP control tool exactly once with method claudeFullAuto.setEnabled and args {"enabled":true}. Do not use the UI, browse, retry or call other tools. Report its refusal in one sentence.' })
  let mcpTurn, mcpTimedOut = false
  try {
    mcpTurn = await poll(async () => {
      const state = await snapshot(mcpProbe.resourceId)
      return ['completed', 'failed', 'disconnected', 'interrupted', 'waiting_approval', 'waiting_input'].includes(state?.phase) ? state : null
    }, { timeoutMs: 60_000, label: 'bounded native MCP forgery probe' })
  } catch { mcpTimedOut = true; mcpTurn = await snapshot(mcpProbe.resourceId) }
  if (!['completed', 'failed', 'disconnected', 'interrupted'].includes(mcpTurn.phase)) await call('agents.interrupt', { agentSessionId: mcpProbe.resourceId })
  assert.equal((await view.evaluate(() => window.conductor.claudeFullAuto.state())).enabled, false)
  const mcpCalls = mcpTurn.items.filter(item => item.sequence > mcpStart.sequence && item.data?.type === 'tool' && /conductor.*control/i.test(item.data.name))
  const activationTarget = item => item.data.input && typeof item.data.input === 'object' && item.data.input.method === 'claudeFullAuto.setEnabled'
  const refusalOutput = item => /(?:unknown|unsupported|unavailable|not available|not found|HTTP 400|not.*method)/i.test(item.data.output ?? '')
  const mcpRefused = mcpCalls.some(item => activationTarget(item) && ['completed', 'failed'].includes(item.data.status) && refusalOutput(item))
  record('J-mcp', mcpRefused ? 'PASS' : 'NOT PROVEN', { phase: mcpTurn.phase, timedOut: mcpTimedOut, calls: mcpCalls.map(item => ({ name: item.data.name, status: item.data.status, activationTarget: Boolean(activationTarget(item)), refusalObserved: refusalOutput(item) })), policyEnabled: false }, mcpRefused
    ? 'Native Claude MCP control reached a refused activation method while owner policy stayed false'
    : 'The provider did not expose a completed MCP control refusal; policy stayed false, but native MCP boundary proof is unavailable')

  step('synthetic DOM replay cannot activate the owner control')
  await view.evaluate(() => {
    const detail = document.querySelector('.structured-agent-pane .sa-full-auto-details')
    if (detail) detail.open = true
    const button = detail?.querySelector('button')
    if (!button) throw new Error('Full Auto owner control is absent')
    button.click() // isTrusted=false; no policy write should follow.
  })
  assert.equal((await view.evaluate(() => window.conductor.claudeFullAuto.state())).enabled, false)
  record('J-replay', 'PASS', {}, 'Synthetic DOM click did not authorize Full Auto')

  step('trusted UI activation in test profile and native existing-session transition')
  await ownerButton("Enable Full Auto for Conductor's Claude workers")
  const authorization = await poll(async () => {
    const state = await view.evaluate(() => window.conductor.claudeFullAuto.state())
    return state.enabled && !state.applying ? state : null
  }, { timeoutMs: 60_000, label: 'test-profile policy persisted and reconciled' })
  assert.ok(authorization.authorizedAt)
  const transitioned = await mode(worker.resourceId, 'bypassPermissions')
  assert.equal(transitioned.nativeSessionId, baselineTurn.nativeSessionId, 'The existing native conversation must survive the transition')
  assert.equal(effective(transitioned).requestedPermissionMode, 'bypassPermissions')
  assert.equal(effective(transitioned).claudeFullAutoAuthorized, true)
  await poll(async () => /Auto \/ Full access/.test(await modeLabel()) && /Full Auto active/.test(await parityText()), { timeoutMs: 15_000, label: 'Full Auto picker and confirmed parity badge' })
  await picker.click()
  const authorizedModes = await view.locator('.sa-mode-menu').textContent()
  assert.match(authorizedModes, /Auto \/ Full access/)
  assert.match(authorizedModes, /Guarded Auto/)
  await picker.click()
  record('A-B', 'PASS', { authorizedAt: authorization.authorizedAt, ...evidence(transitioned) }, 'Fixture UI click persisted policy and an existing Auto session received native confirmation')
  await shot('confirmed-fixture')

  step('unattended real file, PowerShell, Bash, build and test turn')
  const workPrompt = [
    'This is a disposable acceptance project. Do these seven steps in order and only inside this project:',
    '1. Read README.md.',
    '2. Use Write to put exactly FULL_AUTO_OK followed by one newline in src/answer.txt.',
    '3. Use Bash to run: powershell.exe -NoProfile -File scripts/ps-proof.ps1',
    "4. Use Bash to run: printf 'BASH_OK' > bash-proof.txt",
    '5. Use Bash to run: npm.cmd run build',
    '6. Use Bash to run: npm.cmd test',
    '7. Call the Conductor MCP control tool with method tabs.list and empty args, then finish with one short sentence.',
    'Do not ask for permission, delegate, browse, change configuration or run any other command.'
  ].join('\n')
  await call('agents.submit', { agentSessionId: worker.resourceId, prompt: workPrompt })
  const worked = await settled(worker.resourceId, transitioned.sequence)
  assert.equal(worked.phase, 'completed')
  assert.equal(effective(worked).permissionMode, 'bypassPermissions')
  assert.equal(effective(worked).permissionModeStatus, 'confirmed')
  assert.equal(await readFile(join(project.path, 'src/answer.txt'), 'utf8'), 'FULL_AUTO_OK\n')
  assert.equal((await readFile(join(project.path, 'ps-proof.txt'), 'utf8')).trim(), 'PS_OK')
  assert.equal(await readFile(join(project.path, 'bash-proof.txt'), 'utf8'), 'BASH_OK')
  assert.equal(await readFile(join(project.path, 'dist/result.txt'), 'utf8'), 'FULL_AUTO_OK\n')
  const calls = worked.items.filter(item => item.data?.type === 'tool')
  assert.ok(calls.some(item => item.data.name === 'Read' && item.data.status === 'completed'))
  assert.ok(calls.some(item => item.data.name === 'Write' && item.data.status === 'completed'))
  assert.ok(calls.filter(item => item.data.name === 'Bash' && item.data.status === 'completed').length >= 4)
  assert.ok(calls.some(item => /conductor.*control/i.test(item.data.name) && item.data.status === 'completed'))
  record('E', 'PASS', evidence(worked), 'Real Claude edited the fixture and completed PowerShell, Bash, npm build/test and tab-list tool calls')

  step('new native coworker inherits authorized mode')
  const next = await openTab({ provider: 'claude', model: 'sonnet', effort: 'low', permission: 'auto', exactPermission: true, title: 'Full Auto new coworker fixture' })
  const nextStart = await snapshot(next.resourceId)
  await call('agents.submit', { agentSessionId: next.resourceId, prompt: 'Reply with exactly NEW_COWORKER_BASELINE. Do not use tools.' })
  const nextTurn = await settled(next.resourceId, nextStart.sequence)
  assert.equal(nextTurn.phase, 'completed')
  assert.ok(nextTurn.nativeSessionId, 'The new coworker must start a real native conversation')
  const created = await mode(next.resourceId, 'bypassPermissions')
  assert.equal(created.nativeSessionId, nextTurn.nativeSessionId)
  assert.equal(effective(created).requestedPermissionMode, 'bypassPermissions')
  assert.equal(effective(created).claudeFullAutoAuthorized, true)
  record('C-new', 'PASS', evidence(created), 'New Claude Auto coworker launched with native Full Auto')
  step('nested native subagent inherits the working permission mode')
  try {
    await call('agents.submit', { agentSessionId: next.resourceId, prompt: "In this disposable project, use the Agent tool once. Ask that nested subagent to use Bash to run exactly: printf 'NESTED_OK' > nested-proof.txt. Wait for its result, then stop. Do not run the command yourself or use another tool." })
    const nested = await settled(next.resourceId, created.sequence)
    assert.equal(nested.phase, 'completed')
    assert.equal(await readFile(join(project.path, 'nested-proof.txt'), 'utf8'), 'NESTED_OK')
    assert.ok(nested.items.some(item => item.data?.type === 'tool' && /^(Agent|Task)$/.test(item.data.name) && item.data.status === 'completed'))
    const nativeEvents = await view.evaluate(id => window.conductor.structured.events(id, 0), next.resourceId)
    const childReceipts = nativeEvents.filter(event => event.native?.method === 'hook/PreToolUse' && event.native.payload?.agent_id).map(event => ({
      runtimeId: event.runtimeId,
      sessionId: event.native.payload.session_id,
      agentId: event.native.payload.agent_id,
      toolUseId: event.native.payload.tool_use_id,
      mode: event.native.payload.permission_mode
    }))
    const childModeConfirmed = childReceipts.some(receipt => receipt.runtimeId === nested.runtimeId && receipt.mode === 'bypassPermissions')
    record('C-nested-action', 'PASS', evidence(nested), 'Native Agent tool completed and its child wrote exact fixture proof')
    record('C-nested-inheritance', childModeConfirmed ? 'PASS' : 'NOT RUN (child mode receipt absent)', { childReceipts }, childModeConfirmed
      ? 'Native child PreToolUse hook reported bypassPermissions; separate Agent completion and file proof establish execution'
      : 'The provider did not report a child PreToolUse permission-mode receipt; a child file edit alone does not prove inherited bypass')
  } catch (error) {
    record('C-nested', 'FAIL', {}, `Native nested-subagent acceptance failed: ${String(error?.message ?? error).slice(0, 500)}`)
  }

  step('app restart retains policy and a resumable native conversation')
  const originalNative = worked.nativeSessionId
  const close = await safeClose(inst)
  assert.equal(close.leftovers.length, 0)
  assert.equal((close.unresolved ?? []).length, 0)
  await relaunchParked(inst)
  view = await page(inst)
  const afterRestart = await view.evaluate(() => window.conductor.claudeFullAuto.state())
  assert.equal(afterRestart.enabled, true)
  assert.equal(afterRestart.authorizedAt, authorization.authorizedAt)
  await call('agents.resume', { agentSessionId: worker.resourceId })
  await call('tabs.focus', { tabId: worker.id })
  const resumed = await mode(worker.resourceId, 'bypassPermissions')
  assert.equal(resumed.nativeSessionId, originalNative)
  record('D-restart', 'PASS', { ...evidence(resumed), authorizedAt: afterRestart.authorizedAt }, 'Policy survived app restart; existing native session resumed in confirmed bypass mode')

  step('agent control cannot forge the owner activation API')
  const forgery = await callRaw('claudeFullAuto.setEnabled', { enabled: false })
  assert.notEqual(forgery.status, 200)
  assert.equal((await view.evaluate(() => window.conductor.claudeFullAuto.state())).enabled, true)
  record('J-control', 'PASS', { status: forgery.status }, 'App-control method is absent and a refused agent call did not alter owner policy')

  step('disable through test-profile UI and verify native downgrade')
  await ownerButton('Disable Full Auto for Claude workers')
  const disabled = await poll(async () => {
    const state = await view.evaluate(() => window.conductor.claudeFullAuto.state())
    return !state.enabled && !state.applying ? state : null
  }, { timeoutMs: 60_000, label: 'test-profile Full Auto disabled' })
  const guarded = await mode(worker.resourceId, 'auto')
  assert.equal(effective(guarded).requestedPermissionMode, 'auto')
  assert.equal(effective(guarded).claudeFullAutoAuthorized, false)
  await poll(async () => /Auto \(Guarded until authorized\)/.test(await modeLabel()) && /Guarded Auto/.test(await parityText()), { timeoutMs: 15_000, label: 'Guarded picker and badge after disabling' })
  const afterDisableStart = await snapshot(worker.resourceId)
  await call('agents.submit', { agentSessionId: worker.resourceId, prompt: 'Read README.md in this disposable project, then reply exactly GUARDED_AFTER_DISABLE. Do not edit or run a command.' })
  const afterDisableWork = await settled(worker.resourceId, afterDisableStart.sequence)
  assert.equal(afterDisableWork.phase, 'completed')
  assert.equal(effective(afterDisableWork).requestedPermissionMode, 'auto')
  assert.equal(effective(afterDisableWork).permissionMode, 'auto')
  assert.equal(effective(afterDisableWork).permissionModeStatus, 'confirmed')
  assert.ok(afterDisableWork.items.some(item => item.sequence > afterDisableStart.sequence && item.data?.type === 'tool' && item.data.name === 'Read' && item.data.status === 'completed'))
  assert.match(await parityText(), /Guarded Auto/)
  record('I', 'PASS', { changedAt: disabled.changedAt, ...evidence(afterDisableWork) }, 'Disabling policy returned the existing session to confirmed native Guarded Auto and subsequent real Read work stayed guarded')
} catch (error) {
  await failed(error, 'full-auto-native')
} finally {
  if (browserServer?.listening) {
    browserServer.closeAllConnections()
    await new Promise(resolve => browserServer.close(resolve))
  }
  await finish()
}
