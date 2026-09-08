import assert from 'node:assert/strict'
import { resolve } from 'node:path'

export const NATIVE_SESSION_MODE_FLAG = '--verify-native-session-mode'
export function nativeSessionModeSelection(args) {
  assert.ok(args.length === 0 || args.length === 1 && args[0] === NATIVE_SESSION_MODE_FLAG, 'Only the exact explicit --verify-native-session-mode selection is supported')
  return args.length === 1
}
export function observedUsageCost(state, events = [], reported) {
  const projection = state?.items?.filter(item => item.data.type === 'usage' && Number.isFinite(item.data.costUsd)).map(item => Math.max(0, item.data.costUsd)) ?? []
  const journal = new Map()
  for (const event of events) if (event.data.type === 'usage' && Number.isFinite(event.data.costUsd)) journal.set(event.itemId ?? event.id, Math.max(0, event.data.costUsd))
  const values = [...journal.values()]
  return { knownCostUsd: Math.max(projection.reduce((a, b) => a + b, 0), values.reduce((a, b) => a + b, 0), Number.isFinite(reported) ? reported : 0), costUnknown: projection.length === 0 && values.length === 0 }
}
export function validateNativeSessionModeVerification(allowance, original, originalSha256, prompt) {
  assert.equal(allowance?.submissions, 1, 'Native session-mode verification requires exactly one original submission; a third prompt is prohibited')
  assert.ok(!allowance.nativeSessionModeVerification?.reservedAt, 'The one native session-mode verification prompt was already reserved')
  assert.equal(allowance.model, 'sonnet'); assert.equal(allowance.effort, 'low')
  if (allowance.nativeSessionModeVerification) assert.equal(allowance.nativeSessionModeVerification.originalSha256, originalSha256, 'Original native evidence changed after verification selection')
  assert.equal(original.status, 'observed-limitation')
  assert.equal(original.aggregateSubmissions, 1)
  assert.equal(original.root, allowance.root)
  assert.equal(original.provider, 'claude'); assert.equal(original.model, 'sonnet'); assert.equal(original.effort, 'low')
  assert.equal(original.prompt, prompt, 'Verification cannot substitute a different scenario')
  assert.deepEqual(original.approvals, [], 'The original attempt must have sent no approval decision')
  assert.equal(original.finalState?.phase, 'interrupted', 'The original provider turn must have stopped')
  assert.equal(original.observations?.at(-1)?.phase, 'waiting_approval', 'The original failure must have occurred while waiting for its first permission')
  const tools = original.finalState.items.filter(item => item.data.type === 'tool')
  assert.equal(tools.length, 1, 'Original evidence must contain only the first Write')
  const tool = tools[0]
  assert.equal(tool.data.name, 'Write')
  assert.equal(tool.data.input?.content, 'first\n')
  assert.equal(resolve(tool.data.input.file_path).toLowerCase(), resolve(original.project.path, 'session-proof.txt').toLowerCase())
  assert.ok(['failed', 'interrupted', 'rejected'].includes(tool.data.status), 'The first Write must not have completed')
  assert.ok(Array.isArray(original.events) && original.events.length, 'The original native event journal must be retained')
  const toolEvents = original.events.filter(event => event.data.type === 'tool')
  assert.ok(toolEvents.length && toolEvents.every(event => event.itemId === tool.nativeItemId && event.data.name === 'Write' && ['preparing', 'awaiting_approval', 'failed', 'rejected', 'interrupted'].includes(event.data.status)), 'No original operation may have run or completed')
  assert.ok(toolEvents.some(event => event.data.status === 'awaiting_approval'))
  assert.ok(!original.events.some(event => event.data.type === 'changes' && event.data.changes.some(change => change.status === 'applied')), 'No original file change may have been applied')
  const requests = original.events.filter(event => event.native?.method === 'can_use_tool')
  assert.equal(requests.length, 1, 'Original evidence must contain exactly the first native permission request')
  const request = requests[0].native.payload
  assert.equal(request.tool_name, 'Write'); assert.equal(request.tool_use_id, tool.nativeItemId)
  assert.ok(request.permission_suggestions?.some(suggestion => suggestion.type === 'setMode' && suggestion.mode === 'acceptEdits' && suggestion.destination === 'session'), 'The original runtime must have offered the previously unsupported native session edit mode')
  const choice = requests[0].data.interaction?.choices.find(candidate => candidate.id === 'allow-session')
  assert.equal(choice?.disabled, true, 'The original compatibility gap must be present in the recorded action')
  const cost = observedUsageCost(original.finalState, original.events, original.observedCostUsd)
  let eventActiveMs = 0, eventApprovalMs = 0, phase = 'running', previous = Date.parse(allowance.reservedAt)
  assert.ok(Number.isFinite(previous), 'Original reservation time must be retained')
  for (const event of original.events) {
    const time = Date.parse(event.timestamp)
    if (!Number.isFinite(time) || time < previous) continue
    if (event.data.type !== 'session') continue
    if (['waiting_approval', 'waiting_input'].includes(phase)) eventApprovalMs += time - previous
    else eventActiveMs += time - previous
    previous = time; phase = event.data.phase
    if (['interrupted', 'completed', 'failed', 'disconnected'].includes(phase)) break
  }
  const activeMs = Math.max(Number.isFinite(original.activeMs) ? original.activeMs : 0, eventActiveMs)
  const approvalWaitMs = Math.max(Number.isFinite(original.approvalWaitMs) ? original.approvalWaitMs : 0, eventApprovalMs)
  assert.ok(activeMs < 90_000 && approvalWaitMs < 30_000, 'The aggregate time allowance is exhausted')
  assert.ok(cost.knownCostUsd < 0.5, 'The explicitly selected aggregate telemetry allowance is exhausted')
  return { ...cost, activeMs, approvalWaitMs, originalAgentSessionId: original.agentSessionId }
}
