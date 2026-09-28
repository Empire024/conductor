import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../shared/models'
import type { Decider, DeciderOutcome, DecisionRequest } from '../shared/model-routing'
import type { AdapterEvent, InteractionResponse, Json } from '../shared/structured-agent'
import { ApprovalReviewGate, type ApprovalReviewShadow } from './approval-review-gate'
import type { ReviewAction, ReviewResult } from './approval-review'
import { sessionRules } from './approval-review-rules'
import { createApprovalShadow } from './model-intelligence/approval-shadow'
import { DecisionService } from './model-intelligence/decision-service'
import { GO_LIVE, LIVE_AUDIT_EVERY, createLiveBoundaries } from './model-intelligence/live-boundaries'
import { ModelIntelligenceStore } from './model-intelligence/store'

/**
 * A boundary the owner switched live (decisions.live) through the real gate: a confident local allow of a
 * workspace-write action answers the card with no reviewer turn; everything else is reviewed as before, and
 * disagreement reverts the boundary to shadow by itself.
 */

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); sessionRules.clear() })

type Decision = ReviewResult['decision']
let runtimes = 0
function fixture(decision: Decision, shadow: ApprovalReviewShadow) {
  const cwd = mkdtempSync(join(tmpdir(), 'approval-live-')); roots.push(cwd)
  const spec: AgentSpec = { id: 'worker', projectId: 'project', sessionId: 'workspace', provider: 'claude', cwd, title: 'Worker' }
  const persisted = new Map<string, string>(), publications: AdapterEvent[] = [], responses: InteractionResponse[] = []
  const persistence = { getSetting: (key: string) => persisted.get(key) ?? null, setSetting: (key: string, value: string) => { persisted.set(key, value) } }
  const gate: ApprovalReviewGate = new ApprovalReviewGate(persistence, () => ({ permission: 'auto', plan: false, model: 'haiku' }), (_id, _runtime, event) => { publications.push(event) }, async response => {
    const record = await gate.reserve(response, true)
    responses.push(response)
    if (record) gate.finish(record, true)
  })
  const run = vi.fn(async (_spec: AgentSpec, _action: ReviewAction, digest: string): Promise<ReviewResult> => ({ digest, decision, rationale: `Reviewer says ${decision}`, reviewerId: 'reviewer', model: 'claude-opus-test', turnId: 'turn', elapsedMs: 1200 }))
  gate.routing = { enabled: () => true, authorization: () => ({ id: 'owner-task', text: 'Owner: write panel.txt in this project.' }), run, shadow }
  const runtime = `runtime-${++runtimes}`
  const request = (ownerRule = false): AdapterEvent => {
    const args: Json = { file_path: 'panel.txt', content: 'hello' }
    return { itemId: 'tool-request', requestId: 'request',
      data: { type: 'interaction', interaction: { id: 'request', kind: 'approval', status: 'pending', title: 'Allow Write?', input: args, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] } },
      native: { method: 'can_use_tool', payload: { subtype: 'can_use_tool', tool_name: 'Write', input: args, ...(ownerRule ? { matched_ask_rule: 'Write(panel.txt)', decision_reason: 'owner ask rule' } : {}) } } }
  }
  const phase = () => { const data = publications.at(-1)?.data; return data?.type === 'interaction' ? data.interaction.review?.phase : undefined }
  const records = () => gate.journal.forWorker('project', 'worker')
  return { spec, gate, run, request, runtime, phase, responses, records }
}

const verdict = (allow: number): DeciderOutcome => ({ ok: true, verdict: { decider: 'local-llm:fake', probabilities: { allow, deny: (1 - allow) / 2, escalate: (1 - allow) / 2 }, rationale: 'routine write', elapsedMs: 3 } })
const reviewer = (choice: string): Decider => ({ id: 'approval-reviewer', tier: 'frontier', supports: kind => kind === 'approval', decide: async () => ({ ok: true, verdict: { decider: 'approval-reviewer:opus', probabilities: { [choice]: 1 }, rationale: 'reviewed', elapsedMs: 1 } }) })

/** The real shadow over a real DecisionService, store and live boundaries; the local decider is a counted fake. */
function liveStack(local: () => Promise<DeciderOutcome>, options: { live?: boolean; liveWaitMs?: number } = {}) {
  const store = new ModelIntelligenceStore(':memory:'), settings = new Map<string, string>(), log = vi.fn()
  const ask = vi.fn(local)
  const decider: Decider = { id: 'local-llm', tier: 'system-one', supports: kind => kind === 'approval', decide: () => ask() }
  const ports = { getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string) => { settings.set(key, value) } }
  const decisions = new DecisionService({ deciders: [decider], journal: { record: record => store.recordDecision(record) }, settings: ports })
  const boundaries = createLiveBoundaries({ store, decisions, settings: ports, now: () => new Date(), log })
  const shadow = createApprovalShadow({ decisions, store, log, now: () => new Date(), recordOutcome: outcome => outcome && store.recordOutcome(outcome).outcome, boundaries, ...(options.liveWaitMs ? { liveWaitMs: options.liveWaitMs } : {}) })
  const history = async (agreeing: number) => {
    const request: DecisionRequest = { kind: 'approval', question: 'Allow?', options: ['allow', 'deny', 'escalate'].map(id => ({ id, label: id })), state: { boundary: 'workspace-write' }, impact: 'routine', requester: 'approval-gate' }
    for (let index = 0; index < agreeing; index++) await decisions.decide(request, { frontier: reviewer('allow'), mode: 'shadow', systemOne: verdict(0.97) })
  }
  const ready = async () => { await history(GO_LIVE.cases); if (options.live !== false) boundaries.set('approval', 'workspace-write', true, 'wizard') }
  const approvals = () => store.decisions({ kind: 'approval', since: '2020-01-01T00:00:00Z', limit: 200 })
  return { store, shadow, boundaries, ask, log, ready, approvals }
}

/** One approval through the gate; returns once it is answered (allow) or waits for the owner. */
async function approve(stack: ReturnType<typeof liveStack>, decision: Decision, ownerRule = false) {
  const f = fixture(decision, stack.shadow)
  f.gate.intercept(f.spec, f.runtime, f.request(ownerRule))
  if (decision === 'allow' && !ownerRule) await vi.waitFor(() => expect(f.responses).toHaveLength(1))
  else await vi.waitFor(() => expect(f.records()[0]?.phase).toMatch(/denied|owner|blocked|responded|executed/))
  // Every background step of the shadow has finished.
  await stack.shadow.settled({ workerId: 'worker', runtimeId: f.runtime, requestId: 'request' })
  return f
}

describe('approval gate on a live workspace-write boundary', () => {
  it('answers a confident local allow without a reviewer turn, journaled as a live decision', async () => {
    const stack = liveStack(async () => verdict(0.97))
    await stack.ready()
    const f = await approve(stack, 'deny')
    expect(f.run).not.toHaveBeenCalled()
    expect(f.responses.map(response => response.decision)).toEqual(['allow'])
    expect(f.records()[0]).toMatchObject({ phase: 'responded', coveredBy: 'live:local-llm:fake' })
    expect(f.records()[0]!.history.find(entry => entry.phase === 'approved')!.rationale).toMatch(/^Allowed by the local decision model local-llm:fake \(confidence 0\.97\): workspace-write approvals are live \(decisions\.live\) at 100% agreement over 30 reviewed cases; decision decision_/)
    expect(stack.approvals()[0]).toMatchObject({ choice: 'allow', decidedBy: 'local-llm:fake', escalated: false, state: { boundary: 'workspace-write', live: true } })
    expect(stack.ask).toHaveBeenCalledTimes(1)
    // A live answer has no reviewer or owner answer, so it is never counted as agreement.
    expect(stack.boundaries.status('approval', 'workspace-write')).toMatchObject({ cases: 30, agreed: 30 })
    expect(stack.shadow.stats()).toMatchObject({ liveAllowed: 1, audited: 0 })
  })
  it('still reviews every 5th confident allow as an audit, asking the local model once', async () => {
    const stack = liveStack(async () => verdict(0.97))
    await stack.ready()
    const reviewed: number[] = []
    for (let index = 1; index <= LIVE_AUDIT_EVERY; index++) { const f = await approve(stack, 'allow'); reviewed.push(f.run.mock.calls.length) }
    expect(reviewed).toEqual([0, 0, 0, 0, 1])
    expect(stack.ask).toHaveBeenCalledTimes(LIVE_AUDIT_EVERY)
    const audit = stack.approvals()[0]!
    expect(audit).toMatchObject({ choice: 'allow', decidedBy: 'approval-reviewer:claude-opus-test', escalated: true, state: { liveAudit: true } })
    expect(audit.verdicts.map(entry => entry.decider)).toEqual(['local-llm:fake', 'approval-reviewer:claude-opus-test'])
    expect(stack.boundaries.status('approval', 'workspace-write')).toMatchObject({ cases: 31, agreed: 31 })
    expect(stack.shadow.stats()).toMatchObject({ liveAllowed: 4, audited: 1 })
  })
  it('leaves everything else to the reviewer: an unsure or denying local verdict, a native-owner request, a slow decider, a boundary not switched live', async () => {
    for (const [name, stack, ownerRule] of [
      ['unsure', liveStack(async () => verdict(0.8)), false],
      ['deny', liveStack(async () => ({ ok: true, verdict: { decider: 'local-llm:fake', probabilities: { allow: 0.01, deny: 0.98, escalate: 0.01 }, rationale: 'no', elapsedMs: 1 } })), false],
      ['native-owner', liveStack(async () => verdict(0.99)), true],
      ['slow', liveStack(() => new Promise<DeciderOutcome>(() => {}), { liveWaitMs: 30 }), false],
      ['not live', liveStack(async () => verdict(0.99), { live: false }), false],
    ] as const) {
      await stack.ready()
      const f = fixture('deny', stack.shadow)
      f.gate.intercept(f.spec, f.runtime, f.request(ownerRule))
      await vi.waitFor(() => expect(f.run, name).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(f.responses, name).toHaveLength(1))
      expect(f.responses.map(response => response.decision), name).toEqual(['deny'])
      // The verdict decideLive already asked is journaled beside the reviewer's, not asked for again.
      if (name === 'unsure' || name === 'deny') {
        await stack.shadow.settled({ workerId: 'worker', runtimeId: f.runtime, requestId: 'request' })
        expect(stack.ask, name).toHaveBeenCalledTimes(1)
        expect(stack.approvals()[0]!.verdicts.map(entry => entry.decider), name).toEqual(['local-llm:fake', 'approval-reviewer:claude-opus-test'])
      }
      stack.shadow.dispose()
    }
  })
  it('goes back to shadow by itself once reviewed disagreements pull agreement below 95%, and then reviews every action', async () => {
    let allow = 0.8
    const stack = liveStack(async () => verdict(allow))
    await stack.ready()
    // Unsure local allows that the reviewer denies: each is a reviewed disagreement.
    await approve(stack, 'deny')
    expect(stack.boundaries.isLive('approval', 'workspace-write')).toBe(true)
    await approve(stack, 'deny')
    expect(stack.boundaries.isLive('approval', 'workspace-write')).toBe(false)
    expect(stack.boundaries.flips(1)[0]).toMatchObject({ by: 'auto-revert', live: false, cases: 32, agreement: 30 / 32 })
    expect(stack.log).toHaveBeenCalledWith(expect.stringMatching(/^approval\/workspace-write back to shadow \(auto-revert\): agreement fell to 93\.8% of 32 cases/))
    // A confident allow now goes to the reviewer: nothing flips live again by itself.
    allow = 0.99
    const after = await approve(stack, 'allow')
    expect(after.run).toHaveBeenCalledTimes(1)
    expect(stack.boundaries.isLive('approval', 'workspace-write')).toBe(false)
  })
})
