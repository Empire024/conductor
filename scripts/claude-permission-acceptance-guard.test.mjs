import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { nativeSessionModeSelection, observedUsageCost, validateNativeSessionModeVerification } from './claude-permission-acceptance-guard.mjs'

const prompt = 'fixed fixture prompt'
function fixture() {
  const root = resolve('retained-fixture'), path = resolve(root, 'project'), toolId = 'native-first-write'
  const tool = { nativeItemId: toolId, data: { type: 'tool', name: 'Write', status: 'failed', input: { file_path: resolve(path, 'session-proof.txt'), content: 'first\n' } } }
  const allowance = { root, model: 'sonnet', effort: 'low', submissions: 1, reservedAt: '2026-09-08T10:00:00.000Z' }
  const original = {
    root, provider: 'claude', model: 'sonnet', effort: 'low', prompt, project: { path }, agentSessionId: 'original-agent',
    status: 'observed-limitation', aggregateSubmissions: 1, approvals: [], activeMs: 3500, approvalWaitMs: 0, observedCostUsd: 0,
    observations: [{ phase: 'waiting_approval' }], finalState: { phase: 'interrupted', items: [tool, { data: { type: 'usage', costUsd: 0.148105 } }] },
    events: [
      { timestamp: '2026-09-08T10:00:00.000Z', data: { type: 'session', phase: 'running' } },
      { timestamp: '2026-09-08T10:00:01.000Z', itemId: toolId, data: { ...tool.data, status: 'awaiting_approval' } },
      { timestamp: '2026-09-08T10:00:01.000Z', data: { type: 'interaction', interaction: { choices: [{ id: 'allow-session', disabled: true }] } }, native: { method: 'can_use_tool', payload: { tool_name: 'Write', tool_use_id: toolId, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } } },
      { timestamp: '2026-09-08T10:00:03.000Z', data: { type: 'session', phase: 'waiting_approval' } },
      { timestamp: '2026-09-08T10:00:04.000Z', data: { type: 'session', phase: 'interrupted' } },
      { timestamp: '2026-09-08T10:00:04.000Z', itemId: 'cost', data: { type: 'usage', costUsd: 0.148105 } }
    ]
  }
  return { allowance, original }
}
const validate = ({ allowance, original }) => validateNativeSessionModeVerification(allowance, original, 'evidence-hash', prompt)
test('requires the exact explicit selection without helper arguments', () => {
  assert.equal(nativeSessionModeSelection([]), false)
  assert.equal(nativeSessionModeSelection(['--verify-native-session-mode']), true)
  for (const args of [['--retry'], ['--verify-native-session-mode=true'], ['--verify-native-session-mode', '--again']]) assert.throws(() => nativeSessionModeSelection(args))
})
test('charges final native telemetry and conservative time against the selected aggregate allowance', () => {
  assert.deepEqual(validate(fixture()), { knownCostUsd: 0.148105, costUnknown: false, activeMs: 3500, approvalWaitMs: 1000, originalAgentSessionId: 'original-agent' })
})
test('rejects missing, consumed, reserved or evidence-changed replacement allowances', () => {
  for (const submissions of [0, 2, 3]) { const f = fixture(); f.allowance.submissions = submissions; assert.throws(() => validate(f)) }
  const reserved = fixture(); reserved.allowance.nativeSessionModeVerification = { reservedAt: 'already-reserved' }; assert.throws(() => validate(reserved))
  const altered = fixture(); altered.allowance.nativeSessionModeVerification = { originalSha256: 'different-hash' }; assert.throws(() => validate(altered))
})
test('rejects a completed, executed, approved or additional original operation', () => {
  for (const mutate of [
    f => { f.original.finalState.items[0].data.status = 'completed' },
    f => { f.original.events[1].data.status = 'running' },
    f => { f.original.events[1].itemId = 'another-operation' },
    f => { f.original.approvals.push({ decision: 'allow' }) },
    f => { f.original.finalState.items.push({ nativeItemId: 'extra', data: { type: 'tool', name: 'Bash' } }) },
    f => { f.original.events.push({ data: { type: 'changes', changes: [{ status: 'applied' }] } }) }
  ]) { const f = fixture(); mutate(f); assert.throws(() => validate(f)) }
})
test('requires the exact retained native gap and unchanged prompt scope', () => {
  for (const mutate of [
    f => { f.original.events[2].native.payload.permission_suggestions[0].mode = 'bypassPermissions' },
    f => { f.original.events[2].native.payload.permission_suggestions[0].destination = 'userSettings' },
    f => { f.original.events[2].data.interaction.choices[0].disabled = false },
    f => { f.original.finalState.items[0].data.input.file_path = resolve('outside.txt') },
    f => { f.original.prompt = 'another prompt' },
    f => { f.original.observations[0].phase = 'running' }
  ]) { const f = fixture(); mutate(f); assert.throws(() => validate(f)) }
})
test('retains unknown cost as unknown and refuses exhausted aggregate cost or time', () => {
  const unknown = fixture(); unknown.original.finalState.items.pop(); unknown.original.events.pop()
  assert.equal(validate(unknown).costUnknown, true)
  assert.deepEqual(observedUsageCost({ items: [{ data: { type: 'usage', costUsd: 0 } }] }), { knownCostUsd: 0, costUnknown: false })
  for (const mutate of [
    f => { f.original.finalState.items[1].data.costUsd = 0.50 },
    f => { f.original.activeMs = 90_000 },
    f => { f.original.approvalWaitMs = 30_000 }
  ]) { const f = fixture(); mutate(f); assert.throws(() => validate(f)) }
})
