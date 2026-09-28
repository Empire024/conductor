import { describe, expect, it } from 'vitest'
import type { DecisionRecord, RouteDecision } from '../../shared/model-routing'
import { explainDecision, explainRoute, marginOf } from './explain'

describe('explain', () => {
  it('renders a route decision as the documented block', () => {
    const decision: RouteDecision = {
      decisionId: 'decision_1', selected: { key: { provider: 'claude', model: 'opus[1m]' }, effort: 'high' }, contextStrategy: 'fresh',
      fallback: { key: { provider: 'codex', model: 'gpt-5.6-sol' }, effort: null }, escalation: { key: { provider: 'claude', model: 'claude-fable-5-1' }, effort: null },
      maxCostUsd: 1, confidence: 0.91, probabilities: { 'claude/opus[1m]': 0.91, 'codex/gpt-5.6-sol': 0.27, x: 0 }, candidates: [], decidedBy: 'scorer', escalated: false,
      reasons: ['93% success on difficult-coding (41 weighted outcomes, 30-day half-life)', 'expected cost $0.42 within the $1.00 cap'],
    }
    expect(explainRoute(decision)).toBe([
      'Selected: opus[1m] via claude (effort high)', 'Reasons:', '- 93% success on difficult-coding (41 weighted outcomes, 30-day half-life)', '- expected cost $0.42 within the $1.00 cap',
      'Fallback: gpt-5.6-sol via codex', 'Escalation: claude-fable-5-1 via claude', 'Confidence 0.91 (margin 0.64), decided by scorer',
    ].join('\n'))
    expect(explainRoute({ ...decision, fallback: null, escalation: null, escalated: true, decidedBy: 'frontier:opus' })).toMatch(/Fallback: none\nEscalation: none\n.*decided by frontier:opus after escalation$/)
    expect(marginOf({ only: 1 })).toBe(1)
  })
  it('renders a decision record with every verdict, the failures and the outcome', () => {
    const record: DecisionRecord = {
      id: 'decision_2', kind: 'approval', requester: 'approval-gate', question: 'Allow `git push`?', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }, { id: 'escalate', label: 'Ask the owner' }],
      state: {}, at: '2026-09-28T12:00:00.000Z', choice: 'escalate', confidence: 1, margin: 1, probabilities: { allow: 0, deny: 0, escalate: 1 }, decidedBy: 'approval-reviewer:opus', escalated: true, escalationReason: 'mode shadow',
      verdicts: [{ decider: 'local-llm:qwen3.5-9b', probabilities: { allow: 0.7, deny: 0.1, escalate: 0.2 }, rationale: 'Pushing is routine here', tokens: 340, elapsedMs: 850 }, { decider: 'approval-reviewer:opus', probabilities: { allow: 0, deny: 0, escalate: 1 }, rationale: 'Publishing needs the owner', elapsedMs: 12_000 }],
      rationale: 'Publishing needs the owner', outcome: { result: 'success', at: '2026-09-28T12:05:00.000Z' }, projectId: 'p', agentSessionId: null,
    }
    const text = explainDecision(record)
    expect(text).toContain('Decision (approval, asked by approval-gate at 2026-09-28T12:00:00.000Z): Allow `git push`?')
    expect(text).toContain('Choice: Ask the owner (escalate)')
    expect(text).toContain('Confidence 1.00 (margin 1.00), decided by approval-reviewer:opus')
    expect(text).toContain('Escalated: mode shadow')
    expect(text).toContain('- local-llm:qwen3.5-9b: allow 0.70, escalate 0.20, deny 0.10; 850 ms, 340 tokens — Pushing is routine here')
    expect(text).toContain('Outcome: success at 2026-09-28T12:05:00.000Z')
    const routed = explainDecision({ ...record, kind: 'route', systemOne: { decider: 'scorer', choice: 'claude/opus[1m]', confidence: 0.52 }, outcome: { result: 'success', at: '2026-09-28T12:05:00.000Z', answer: 'allow' },
      route: { selected: { key: { provider: 'claude', model: 'opus[1m]' }, effort: 'high' }, fallback: { key: { provider: 'codex', model: 'gpt-6-astra' }, effort: 'high', reason: 'strongest eligible model on another provider' }, escalation: null,
        reasons: ['78% success on difficult-coding'], closeCandidates: [{ id: 'claude/opus[1m]', probability: 0.52, capabilityRank: 3 }], attempts: [{ key: { provider: 'claude', model: 'opus[1m]' }, ok: false, error: 'limit reached', at: '2026-09-28T12:01:00.000Z' }] } })
    expect(routed).toContain('System-one: scorer chose claude/opus[1m] at 0.52')
    expect(routed).toContain('Selected: opus[1m] via claude (effort high)\nFallback: gpt-6-astra via codex (effort high) — strongest eligible model on another provider\nEscalation: none\nReasons:\n- 78% success on difficult-coding')
    expect(routed).toContain('Close call between: claude/opus[1m] 0.52 (rank 3)')
    expect(routed).toContain('Attempt: opus[1m] via claude failed (limit reached) at 2026-09-28T12:01:00.000Z')
    expect(routed).toContain('Outcome: success, the owner answered allow at')
    const failed = explainDecision({ ...record, choice: null, verdicts: [{ decider: 'local-llm', failed: 'timed out' }], outcome: null })
    expect(failed).toContain('Choice: none; the caller kept its previous behaviour')
    expect(failed).toContain('- local-llm: failed (timed out)')
    expect(failed).toContain('Outcome: not recorded yet')
  })
})
