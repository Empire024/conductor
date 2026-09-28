import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Decider, DecisionRequest } from '../../shared/model-routing'
import type { LocalModelRunner } from '../local-assist/contract'
import { GO_LIVE, callModelMethod, type ModelControlCaller } from './control'
import { createModelIntelligence, type ModelIntelligence } from './index'

const services: ModelIntelligence[] = []
afterEach(() => { for (const service of services.splice(0)) service.dispose() })

/** The local decider always says allow; the reviewer says whatever the case needs. */
const localRunner: LocalModelRunner = { ask: async () => ({ ok: true, answer: { text: '{"probabilities":{"allow":0.95,"deny":0.02,"escalate":0.03},"rationale":"routine"}', model: 'qwen-test', inputTokens: 10, outputTokens: 10, durationMs: 5 } }) }
const reviewer = (choice: string): Decider => ({ id: 'approval-reviewer', tier: 'frontier', supports: kind => kind === 'approval', decide: async () => ({ ok: true, verdict: { decider: 'approval-reviewer:opus', probabilities: { [choice]: 1 }, rationale: 'reviewed', elapsedMs: 1 } }) })
const request: DecisionRequest = { kind: 'approval', question: 'Allow npm test?', options: ['allow', 'deny', 'escalate'].map(id => ({ id, label: id })), state: {}, impact: 'routine', requester: 'approval-gate', projectId: 'p1' }

function fixture() {
  const values = new Map<string, string>()
  const service = createModelIntelligence({ dbPath: new DatabaseSync(':memory:'), settings: { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => { values.set(key, value) } }, localRunner, log: () => {} })
  services.push(service)
  const caller = (sovereign: boolean): ModelControlCaller => ({ projectId: 'p1', agentSessionId: 'a1', sovereign, readOnly: false, controls: () => false,
    live: { offered: [], providerEnabled: () => true, usagePercent: () => null, loadedLocalModels: () => [] } })
  const journal = async (agreeing: number, disagreeing: number) => {
    for (let index = 0; index < agreeing; index++) await service.decisions.decide(request, { frontier: reviewer('allow') })
    for (let index = 0; index < disagreeing; index++) await service.decisions.decide(request, { frontier: reviewer('deny') })
  }
  const call = (method: string, args: Record<string, unknown>, sovereign = true) => callModelMethod(service, caller(sovereign), method, args)
  return { service, journal, call }
}

describe('decision go-live control', () => {
  it('decisions.list puts the local verdict next to the final choice and reports each boundary', async () => {
    const f = fixture()
    await f.journal(2, 1)
    const listed = await f.call('decisions.list', { kind: 'approval' }) as { decisions: Array<{ choice: string; systemOne: { decider: string; choice: string } }>; boundaries: Array<{ kind: string; cases: number; agreement: number; live: boolean }> }
    expect(listed.decisions.map(entry => [entry.systemOne.choice, entry.choice])).toEqual([['allow', 'deny'], ['allow', 'allow'], ['allow', 'allow']])
    expect(listed.decisions[0]!.systemOne.decider).toBe('local-llm:qwen-test')
    expect(listed.boundaries).toEqual([{ kind: 'approval', cases: 3, agreement: 2 / 3, live: false }])
    const all = await f.call('decisions.list', {}) as { boundaries: Array<{ kind: string }> }
    expect(all.boundaries.map(entry => entry.kind)).toEqual(['route', 'approval', 'retry', 'escalate', 'completion', 'fallback', 'classify'])
  })
  it('refuses to go live below 30 cases or below 95% agreement, and only for the owner or a wizard', async () => {
    const f = fixture()
    await f.journal(GO_LIVE.cases - 1, 0)
    await expect(f.call('decisions.live', { kind: 'approval', live: true })).rejects.toThrow('approval stays in shadow: its local verdict agreed on 100% of 29 cases in 90 days; going live needs at least 95% over 30 or more')
    await f.journal(0, 2)
    await expect(f.call('decisions.live', { kind: 'approval', live: true })).rejects.toThrow(/agreed on 93\.5% of 31 cases/)
    await expect(f.call('decisions.live', { kind: 'approval', live: true }, false)).rejects.toThrow(/Only the owner or a wizard tab/)
    expect(f.service.decisions.thresholds('approval').mode).toBe('shadow')
  })
  it('goes live at 95% over 30 cases, and back to shadow at any time', async () => {
    const f = fixture()
    await f.journal(29, 1)
    expect(await f.call('decisions.live', { kind: 'approval', live: true })).toEqual({ kind: 'approval', cases: 30, agreement: 29 / 30, live: true, previous: false })
    expect(f.service.decisions.thresholds('approval')).toMatchObject({ mode: 'live', frontierOnly: ['deny'] })
    expect(await f.call('decisions.live', { kind: 'approval', live: false })).toMatchObject({ live: false, previous: true })
    await expect(f.call('decisions.live', { kind: 'nope', live: true })).rejects.toThrow(/kind must be one of/)
    await expect(f.call('decisions.live', { kind: 'approval', live: 'yes' })).rejects.toThrow(/live must be true or false/)
  })
})
