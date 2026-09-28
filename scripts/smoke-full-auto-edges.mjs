// Real Conductor-native Manual request and project-local bypass-limit acceptance.
// A trusted UI click here belongs only to this disposable test profile.
// Run only under an exact granted Electron slot and smoke-lock, on the host:
//   CONDUCTOR_FULL_AUTO_EDGES=1 node scripts/smoke-lock.mjs --timeout-min 20 -- node scripts/smoke-full-auto-edges.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { call, callRaw, configure, failed, finish, launchParked, listProcesses, openProject, openTab, page, poll, record, shot, step, watchdog } from './verify-kit.mjs'

if (process.env.CONDUCTOR_FULL_AUTO_EDGES !== '1') {
  console.error('REFUSED: set CONDUCTOR_FULL_AUTO_EDGES=1 for native edge acceptance; absence is not a passing smoke')
  process.exit(2)
}

configure({ name: 'full-auto-edges', output: 'artifacts/full-auto-edges' })
watchdog(1200)
let inst, view, project
const snapshot = id => view.evaluate(value => window.conductor.structured.snapshot(value), id)
const grantsState = () => view.evaluate(() => window.conductor.permissionGrants.state())
const pane = id => view.locator(`.structured-agent-pane[data-structured-session="${id}"]`)
const effective = state => state?.capabilities?.effectiveSettings ?? {}
const diagnostic = state => ({
  phase: state?.phase,
  permission: state?.settings?.permission,
  nativeSessionIdPresent: Boolean(state?.nativeSessionId),
  effective: Object.fromEntries(['requestedPermissionMode', 'permissionMode', 'permissionModeStatus', 'permissionModeError', 'claudeFullAutoAuthorized'].map(key => [key, effective(state)[key] ?? null])),
  tools: (state?.items ?? []).filter(item => item.data?.type === 'tool').map(item => ({ name: item.data.name, status: item.data.status }))
})
const settled = (id, afterSequence) => poll(async () => {
  const state = await snapshot(id)
  const terminal = ['completed', 'idle', 'failed', 'disconnected', 'interrupted'].includes(state?.phase)
  const answered = state?.items?.some(item => item.sequence > afterSequence && item.data?.type === 'text' && item.data.role === 'assistant')
  return terminal && (answered || ['failed', 'disconnected', 'interrupted'].includes(state?.phase)) ? state : null
}, { timeoutMs: 180_000, label: `${id} native turn settled` })
const nativePending = id => poll(async () => {
  const state = await grantsState()
  return state.requests.find(request => request.agentSessionId === id && request.source === 'native' && request.status === 'pending' && request.execution?.status === 'pending') ?? null
}, { timeoutMs: 90_000, label: `${id} native pending grant` })
const ownerButton = async (id, label) => {
  const detail = pane(id).locator('.sa-full-auto-details')
  if (!await detail.evaluate(element => element.open)) await detail.locator('summary').click()
  await detail.getByRole('button', { name: label, exact: true }).click()
}

try {
  step('host process inventory and parked real Claude launch')
  const inventory = await listProcesses()
  record('host-process-preflight', 'PASS', { processes: inventory.list.length }, 'Win32 process identities are available before Electron launch')
  inst = await launchParked({ mode: 'spawn', env: { CONDUCTOR_OFFLINE_TESTS: undefined, CONDUCTOR_TEST_NODE_EXECUTABLE: undefined } })
  project = await openProject({ name: 'Full Auto scoped native', git: true, files: {
    'README.md': '# Native scoped request fixture\nOnly write the two named proof files.\n',
    '.claude/settings.local.json': JSON.stringify({ permissions: { ask: ['Bash'] } }, null, 2)
  } })
  view = await page(inst)
  const worker = await openTab({ provider: 'claude', model: 'sonnet', effort: 'low', permission: 'default', exactPermission: true, title: 'Full Auto scoped native fixture' })
  await call('tabs.focus', { tabId: worker.id })
  const start = await snapshot(worker.resourceId)
  await call('agents.submit', { agentSessionId: worker.resourceId, prompt: 'Reply exactly MANUAL_BASELINE. Do not use tools.' })
  const baseline = await settled(worker.resourceId, start.sequence)
  assert.equal(baseline.phase, 'completed')
  assert.equal(baseline.settings.permission, 'default')
  assert.equal(effective(baseline).requestedPermissionMode, 'manual')
  assert.equal(effective(baseline).permissionModeStatus, 'confirmed')
  assert.equal((await view.evaluate(() => window.conductor.claudeFullAuto.state())).enabled, false)
  record('FG-manual', 'PASS', diagnostic(baseline), 'Disposable native Claude conversation started in confirmed Manual mode')

  step('literal wildcard native request diagnoses unsafe reusable rule')
  const proofCommand = `node -e "require('fs').writeFileSync('proof.txt','*')"`
  const beforeRequest = await snapshot(worker.resourceId)
  await call('agents.submit', { agentSessionId: worker.resourceId, prompt: `Use Bash exactly once to run this command inside the disposable project: ${proofCommand}. Do not use any other tool or rewrite the command. Wait for the provider permission decision, then finish with a short sentence.` })
  const request = await nativePending(worker.resourceId)
  assert.match(request.id, /^native-grant:/)
  assert.equal(request.tool, 'Bash')
  assert.equal(request.rule, undefined)
  assert.match(request.refusal ?? '', /\*|wildcard/i)
  assert.equal(request.execution.status, 'pending')
  assert.equal(request.call.tool, 'Bash')
  assert.match(request.call.argsDigest, /^[0-9a-f]{64}$/)
  assert.ok(request.call.runtimeId && request.call.nativeSessionId && request.call.requestId && request.call.toolUseId)
  const listedPending = await call('permissions.list', { agentSessionId: worker.resourceId })
  assert.equal(listedPending.requests.find(entry => entry.id === request.id)?.execution?.status, 'pending')
  assert.equal(listedPending.requests.find(entry => entry.id === request.id)?.call?.argsDigest, request.call.argsDigest)
  const card = pane(worker.resourceId).locator('.sa-grant-card').filter({ has: view.getByRole('button', { name: 'Allow this provider request once', exact: true }) })
  await card.waitFor({ state: 'visible' })
  assert.equal(await pane(worker.resourceId).getByRole('button', { name: 'Allow this provider request once', exact: true }).count(), 1)
  assert.match(await card.textContent(), /No rule/)
  await shot('native-literal-wildcard')
  record('G-diagnosis', 'PASS', { id: request.id, source: request.source, status: request.status, execution: request.execution.status, argsDigest: request.call.argsDigest, refusal: request.refusal }, 'One exact native Bash request correctly refused a reusable wildcard rule')

  step('malformed/nonmatching and wrong-scope decisions leave native request pending')
  const fake = await callRaw('permissions.decide', { agentSessionId: worker.resourceId, requestId: 'native-grant:missing:missing', decision: 'approve-once' })
  assert.equal(fake.status, 400)
  const wrongScope = await callRaw('permissions.decide', { agentSessionId: worker.resourceId, requestId: request.id, decision: 'approve-session' })
  assert.equal(wrongScope.status, 400)
  assert.equal((await grantsState()).requests.find(entry => entry.id === request.id)?.execution?.status, 'pending')
  record('G-nonmatch', 'PASS', { fakeStatus: fake.status, wrongScopeStatus: wrongScope.status }, 'Malformed ID and reusable-scope decision were refused without consuming the exact native request')

  step('valid scoped one-time UI approval executes exact pending provider request')
  await card.getByRole('button', { name: 'Allow this provider request once', exact: true }).click()
  const executed = await poll(async () => {
    const entry = (await grantsState()).requests.find(value => value.id === request.id)
    return entry?.execution?.status === 'succeeded' ? entry : null
  }, { timeoutMs: 90_000, label: 'native exact request execution succeeded' })
  assert.equal((await readFile(join(project.path, 'proof.txt'), 'utf8')), '*')
  const finished = await settled(worker.resourceId, beforeRequest.sequence)
  assert.equal(finished.phase, 'completed')
  const listedFinished = await call('permissions.list', { agentSessionId: worker.resourceId })
  assert.equal(listedFinished.requests.find(entry => entry.id === request.id)?.execution?.status, 'succeeded')
  assert.equal(listedFinished.grants.filter(grant => grant.scope === 'session').length, 0)
  const completedBash = finished.items.filter(item => item.data?.type === 'tool' && item.data.name === 'Bash' && item.data.status === 'completed').length
  assert.equal(completedBash, 1)
  const duplicate = await callRaw('permissions.decide', { agentSessionId: worker.resourceId, requestId: request.id, decision: 'approve-once' })
  assert.equal(duplicate.status, 400)
  assert.equal((await readFile(join(project.path, 'proof.txt'), 'utf8')), '*')
  assert.equal((await snapshot(worker.resourceId)).items.filter(item => item.data?.type === 'tool' && item.data.name === 'Bash' && item.data.status === 'completed').length, 1)
  record('G-execution', 'PASS', { id: request.id, execution: executed.execution.status, completedBash, duplicateStatus: duplicate.status }, 'Fixture UI allowed one exact native request, proof file exists, no session rule or duplicate tool execution')

  step('denied native request does not retry, execute, or advertise Full Auto')
  const denyStart = await snapshot(worker.resourceId)
  const denyCommand = `node -e "require('fs').writeFileSync('denied.txt','*')"`
  await call('agents.submit', { agentSessionId: worker.resourceId, prompt: `Use Bash exactly once to run this command inside the disposable project: ${denyCommand}. Do not use another tool or rewrite the command. If denied, stop and do not retry.` })
  const denied = await nativePending(worker.resourceId)
  assert.notEqual(denied.id, request.id)
  await pane(worker.resourceId).getByRole('button', { name: 'Deny', exact: true }).click()
  const denialTurn = await settled(worker.resourceId, denyStart.sequence)
  assert.equal(denialTurn.phase, 'completed')
  assert.equal((await grantsState()).requests.find(entry => entry.id === denied.id)?.status, 'denied')
  assert.equal(await readFile(join(project.path, 'denied.txt'), 'utf8').then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false)
  const pendingCount = (await grantsState()).requests.filter(entry => entry.agentSessionId === worker.resourceId && entry.status === 'pending').length
  await new Promise(resolve => setTimeout(resolve, 2000))
  assert.equal((await grantsState()).requests.filter(entry => entry.agentSessionId === worker.resourceId && entry.status === 'pending').length, pendingCount)
  assert.ok(['default', 'manual'].includes(effective(await snapshot(worker.resourceId)).permissionMode), 'native Manual is reported as default or manual')
  assert.equal((await view.evaluate(() => window.conductor.claudeFullAuto.state())).enabled, false)
  assert.equal(await pane(worker.resourceId).getByText('Full Auto active', { exact: false }).count(), 0)
  record('F-denial', 'PASS', { deniedId: denied.id, pendingCount, ...diagnostic(denialTurn) }, 'Native denial left its file absent, did not auto-retry and showed no Full Auto authorization or badge')

  step('project-local provider restriction blocks one Full Auto activation')
  project = await openProject({ name: 'Full Auto provider limit', git: true, files: {
    'README.md': '# Project-local bypass limit fixture\nNo owner or global Claude settings are changed.\n',
    '.claude/settings.local.json': JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }, null, 2)
  } })
  const limited = await openTab({ provider: 'claude', model: 'sonnet', effort: 'low', permission: 'auto', exactPermission: true, title: 'Full Auto project limit fixture' })
  await call('tabs.focus', { tabId: limited.id })
  const limitStart = await snapshot(limited.resourceId)
  await call('agents.submit', { agentSessionId: limited.resourceId, prompt: 'Reply exactly LIMIT_BASELINE. Do not use tools.' })
  const guarded = await settled(limited.resourceId, limitStart.sequence)
  assert.equal(guarded.phase, 'completed')
  assert.equal(effective(guarded).permissionMode, 'auto')
  assert.equal(effective(guarded).permissionModeStatus, 'confirmed')
  await ownerButton(limited.resourceId, "Enable Full Auto for Conductor's Claude workers")
  const blocked = await poll(async () => {
    const state = await snapshot(limited.resourceId)
    return effective(state).permissionModeStatus === 'blocked' ? state : null
  }, { timeoutMs: 90_000, label: 'project-local native bypass restriction blocks transition' })
  const reason = effective(blocked).permissionModeError
  assert.equal(effective(blocked).requestedPermissionMode, 'bypassPermissions')
  assert.equal(effective(blocked).claudeFullAutoAuthorized, true)
  assert.ok(typeof reason === 'string' && reason.length > 0)
  const blockedSummary = await pane(limited.resourceId).locator('.sa-request-summary').textContent()
  assert.match(blockedSummary, /Permission transition blocked/)
  assert.ok(blockedSummary.includes(reason), 'UI must show the same exact native reason')
  assert.equal(await pane(limited.resourceId).getByText('Full Auto active', { exact: false }).count(), 0)
  const savedReason = reason
  await new Promise(resolve => setTimeout(resolve, 2000))
  const after = await snapshot(limited.resourceId)
  assert.equal(effective(after).permissionModeStatus, 'blocked')
  assert.equal(effective(after).permissionModeError, savedReason)
  record('K', 'PASS', { ...diagnostic(blocked), reason }, 'Documented project-local Claude setting caused one exact native blocked reason; UI showed blocked instead of a false Full Auto badge')
} catch (error) {
  await failed(error, 'full-auto-edges')
} finally {
  await finish()
}
