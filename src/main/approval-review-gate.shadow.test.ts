import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../shared/models'
import type { Decider, DeciderOutcome } from '../shared/model-routing'
import type { AdapterEvent, InteractionResponse, Json } from '../shared/structured-agent'
import { ApprovalReviewGate, type ApprovalReviewShadow } from './approval-review-gate'
import type { ReviewAction, ReviewResult } from './approval-review'
import { sessionRules } from './approval-review-rules'
import { createApprovalShadow } from './model-intelligence/approval-shadow'
import { DecisionService } from './model-intelligence/decision-service'
import { ModelIntelligenceStore } from './model-intelligence/store'

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); sessionRules.clear() })

type Decision = ReviewResult['decision']
/** The gate as approval-review-gate.test.ts builds it, with a routing that may carry a shadow. */
function fixture(decision: Decision, shadow?: ApprovalReviewShadow) {
  const cwd = mkdtempSync(join(tmpdir(), 'approval-shadow-')); roots.push(cwd)
  const spec: AgentSpec = { id: 'worker', projectId: 'project', sessionId: 'workspace', provider: 'claude', cwd, title: 'Worker' }
  const persisted = new Map<string, string>(), publications: AdapterEvent[] = [], responses: InteractionResponse[] = []
  const persistence = { getSetting: (key: string) => persisted.get(key) ?? null, setSetting: (key: string, value: string) => { persisted.set(key, value) } }
  const gate: ApprovalReviewGate = new ApprovalReviewGate(persistence, () => ({ permission: 'auto', plan: false, model: 'haiku' }), (_id, _runtime, event) => { publications.push(event) }, async response => {
    const record = await gate.reserve(response, true)
    responses.push(response)
    if (record) gate.finish(record, true)
  })
  const run = vi.fn(async (_spec: AgentSpec, _action: ReviewAction, digest: string): Promise<ReviewResult> => ({ digest, decision, rationale: `Reviewer says ${decision}`, reviewerId: 'reviewer', model: 'claude-opus-test', turnId: 'turn', elapsedMs: 1200 }))
  gate.routing = { enabled: () => true, authorization: () => ({ id: 'owner-task', text: 'Owner: write panel.txt in this project.' }), run, ...(shadow ? { shadow } : {}) }
  const request = (args: Json = { file_path: 'panel.txt', content: 'hello' }): AdapterEvent => ({ itemId: 'tool-request', requestId: 'request',
    data: { type: 'interaction', interaction: { id: 'request', kind: 'approval', status: 'pending', title: 'Allow Write?', input: args, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] } },
    native: { method: 'can_use_tool', payload: { subtype: 'can_use_tool', tool_name: 'Write', input: args } } })
  const phase = () => { const data = publications.at(-1)?.data; return data?.type === 'interaction' ? data.interaction.review?.phase : undefined }
  /** What the owner and the worker observe, without ids and timestamps. */
  const observed = () => ({
    responses: responses.map(response => ({ requestId: response.requestId, decision: response.decision })),
    journal: gate.journal.forWorker('project', 'worker').map(record => ({ phase: record.phase, ownerAnswer: record.ownerAnswer ?? null, denied: record.denied ?? false, history: record.history.map(entry => entry.phase) })),
    reviews: run.mock.calls.length
  })
  return { spec, gate, run, request, phase, observed }
}

function shadowStack(local: Decider['decide']) {
  const store = new ModelIntelligenceStore(':memory:')
  const settings = new Map<string, string>()
  const decider: Decider = { id: 'local-llm', tier: 'system-one', supports: kind => kind === 'approval', decide: local }
  const decisions = new DecisionService({ deciders: [decider], journal: { record: record => store.recordDecision(record) }, settings: { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) } } })
  const log = vi.fn()
  const shadow = createApprovalShadow({ decisions, store, log, now: () => new Date(), recordOutcome: outcome => outcome && store.recordOutcome(outcome).outcome })
  return { store, shadow, log }
}
const localAllows = async (): Promise<DeciderOutcome> => ({ ok: true, verdict: { decider: 'local-llm:fake', probabilities: { allow: 0.8, deny: 0.1, escalate: 0.1 }, rationale: 'A routine workspace write', elapsedMs: 3 } })

/** One approval through the gate: the reviewer decides, and on escalation the owner answers deny. */
async function scenario(decision: Decision, shadow?: ApprovalReviewShadow) {
  sessionRules.clear()
  const f = fixture(decision, shadow)
  f.gate.intercept(f.spec, 'runtime', f.request())
  if (decision === 'allow') await vi.waitFor(() => expect(f.observed().responses).toHaveLength(1))
  else {
    await vi.waitFor(() => expect(f.phase()).toBe('owner'))
    await f.gate.reserve({ sessionId: 'worker', runtimeId: 'runtime', requestId: 'request', decision: 'deny' }, false)
  }
  return f
}

describe('approval gate shadow (model intelligence, zero inference)', () => {
  it('leaves the review exactly as it is without the shadow, and journals the local verdict beside the reviewer', async () => {
    for (const decision of ['allow', 'escalate'] as const) {
      const plain = await scenario(decision)
      const stack = shadowStack(localAllows)
      const shadowed = await scenario(decision, stack.shadow)
      expect(shadowed.observed()).toEqual(plain.observed())
      await vi.waitFor(() => expect(stack.store.decisions({ kind: 'approval', since: '2020-01-01T00:00:00Z', limit: 5 })).toHaveLength(1))
      const record = stack.store.decisions({ kind: 'approval', since: '2020-01-01T00:00:00Z', limit: 5 })[0]!
      expect(record).toMatchObject({ requester: 'approval-gate', choice: decision, decidedBy: 'approval-reviewer:claude-opus-test', escalated: true, escalationReason: expect.stringContaining('mode shadow'), agentSessionId: 'worker' })
      expect(record.verdicts.map(verdict => verdict.decider)).toEqual(['local-llm:fake', 'approval-reviewer:claude-opus-test'])
      expect(record.state).toMatchObject({ tool: 'Write', boundary: 'workspace-write' })
      // The reviewer's work is an outcome of its own model, category decision, linked to the decision.
      await vi.waitFor(() => expect(stack.store.outcomesForDecision(record.id)).toHaveLength(1))
      expect(stack.store.outcomesForDecision(record.id)[0]).toMatchObject({ key: { provider: 'claude', model: 'claude-opus-test' }, source: 'approval-review', category: 'decision', result: 'success' })
      if (decision === 'escalate') await vi.waitFor(() => expect(stack.store.decision(record.id)!.outcome).toMatchObject({ result: 'success', detail: 'owner answered deny' }))
      expect(stack.log).not.toHaveBeenCalled()
    }
  })

  it('never lets a failing or hanging shadow delay or change the review', async () => {
    const plain = await scenario('allow')
    const throwing: ApprovalReviewShadow = { reviewing: () => { throw new Error('shadow broke') }, reviewed: () => { throw new Error('shadow broke') }, answered: () => { throw new Error('shadow broke') } }
    expect((await scenario('allow', throwing)).observed()).toEqual(plain.observed())
    const escalated = await scenario('escalate')
    expect((await scenario('escalate', throwing)).observed()).toEqual(escalated.observed())
    // A local decider that never answers: the reviewer's answer still goes out at once.
    const hanging = shadowStack(() => new Promise<DeciderOutcome>(() => {}))
    expect((await scenario('allow', hanging.shadow)).observed()).toEqual(plain.observed())
    expect(hanging.store.decisions({ since: '2020-01-01T00:00:00Z', limit: 5 })).toEqual([])
    hanging.shadow.dispose()
    // A local decider that throws is journaled as a failed verdict; the reviewer still decides.
    const failing = shadowStack(async () => { throw new Error('llama down') })
    expect((await scenario('allow', failing.shadow)).observed()).toEqual(plain.observed())
    await vi.waitFor(() => expect(failing.store.decisions({ since: '2020-01-01T00:00:00Z', limit: 5 })).toHaveLength(1))
    expect(failing.store.decisions({ since: '2020-01-01T00:00:00Z', limit: 5 })[0]!.verdicts[0]).toEqual({ decider: 'local-llm', failed: 'llama down' })
  })

  it('stays silent when approval decisions are switched off, and for session-rule answers', async () => {
    const stack = shadowStack(localAllows)
    const off = new DecisionService({ deciders: [], journal: { record: record => stack.store.recordDecision(record) }, settings: { getSetting: () => JSON.stringify({ approval: { mode: 'off' } }), setSetting: () => {} } })
    const silent = createApprovalShadow({ decisions: off, store: stack.store, log: vi.fn(), now: () => new Date(), recordOutcome: () => null })
    await scenario('allow', silent)
    await new Promise(resolve => setImmediate(resolve))
    expect(stack.store.decisions({ since: '2020-01-01T00:00:00Z', limit: 5 })).toEqual([])
  })
})
