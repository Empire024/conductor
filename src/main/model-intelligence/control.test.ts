import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Decider, DecisionRequest } from '../../shared/model-routing'
import type { LocalModelRunner } from '../local-assist/contract'
import { GO_LIVE, callModelMethod, type ModelControlCaller } from './control'
import { createModelIntelligence, type ModelIntelligence } from './index'

const services: ModelIntelligence[] = []
afterEach(() => { for (const service of services.splice(0)) service.dispose() })

/** The local decider always says allow; the reviewer says whatever the case needs. */
const localRunner: LocalModelRunner = { ask: async () => ({ ok: true, answer: { text: '{"probabilities":{"allow":0.95,"deny":0.02,"escalate":0.03},"rationale":"routine"}', model: 'qwen-test', inputTokens: 10, outputTokens: 10, durationMs: 5 } }) }
const reviewer = (choice: string): Decider => ({ id: 'approval-reviewer', tier: 'frontier', supports: kind => kind === 'approval', decide: async () => ({ ok: true, verdict: { decider: 'approval-reviewer:opus', probabilities: { [choice]: 1 }, rationale: 'reviewed', elapsedMs: 1 } }) })
const request = (boundary: string): DecisionRequest => ({ kind: 'approval', question: 'Allow npm test?', options: ['allow', 'deny', 'escalate'].map(id => ({ id, label: id })), state: { boundary }, impact: 'routine', requester: 'approval-gate', projectId: 'p1' })

function fixture() {
  const values = new Map<string, string>()
  const service = createModelIntelligence({ dbPath: new DatabaseSync(':memory:'), settings: { getSetting: key => values.get(key) ?? null, setSetting: (key, value) => { values.set(key, value) } }, localRunner, log: () => {} })
  services.push(service)
  const caller = (sovereign: boolean): ModelControlCaller => ({ projectId: 'p1', agentSessionId: 'wizard-1', sovereign, readOnly: false, controls: () => false,
    live: { offered: [], providerEnabled: () => true, usagePercent: () => null, loadedLocalModels: () => [] } })
  /** Shadow decisions of one boundary, as the approval shadow journals them: the reviewer is the frontier. */
  const journal = async (agreeing: number, disagreeing: number, boundary = 'workspace-write') => {
    for (let index = 0; index < agreeing; index++) await service.decisions.decide(request(boundary), { frontier: reviewer('allow'), mode: 'shadow' })
    for (let index = 0; index < disagreeing; index++) await service.decisions.decide(request(boundary), { frontier: reviewer('deny'), mode: 'shadow' })
  }
  const call = (method: string, args: Record<string, unknown>, sovereign = true) => callModelMethod(service, caller(sovereign), method, args)
  return { service, values, journal, call }
}
type Listed = { decisions: Array<{ choice: string; boundary?: string; systemOne: { decider: string; choice: string } }>; boundaries: Array<Record<string, unknown>>; rule: unknown; switches: Array<Record<string, unknown>> }

describe('decision go-live control (owner rule: switched by the owner or a wizard, per kind and boundary)', () => {
  it('decisions.list puts the local verdict next to the final choice and reports agreement per kind and approval boundary', async () => {
    const f = fixture()
    await f.journal(2, 1)
    await f.journal(1, 0, 'native-owner')
    const listed = await f.call('decisions.list', { kind: 'approval' }) as Listed
    expect(listed.decisions.map(entry => [entry.boundary, entry.systemOne.choice, entry.choice])).toEqual([['native-owner', 'allow', 'allow'], ['workspace-write', 'allow', 'deny'], ['workspace-write', 'allow', 'allow'], ['workspace-write', 'allow', 'allow']])
    expect(listed.decisions[0]!.systemOne.decider).toBe('local-llm:qwen-test')
    expect(listed.boundaries).toEqual([
      { kind: 'approval', boundary: 'workspace-write', cases: 3, agreed: 2, agreement: 2 / 3, live: false, liveable: true, meetsRule: false },
      { kind: 'approval', boundary: 'native-owner', cases: 1, agreed: 1, agreement: 1, live: false, liveable: false, meetsRule: false },
    ])
    expect(listed.rule).toEqual(GO_LIVE)
    expect(listed.switches).toEqual([])
    const all = await f.call('decisions.list', {}) as Listed
    expect(all.boundaries.map(entry => `${entry.kind}/${entry.boundary}`)).toEqual(['route/all', 'approval/workspace-write', 'approval/native-owner', 'retry/all', 'escalate/all', 'completion/all', 'fallback/all', 'classify/all'])
    expect(all.boundaries.find(entry => entry.kind === 'route')).toMatchObject({ live: true, cases: 0 })
  })
  it('refuses to go live below 30 cases or below 95% agreement for that kind and boundary, naming the numbers, and only for the owner or a wizard', async () => {
    const f = fixture()
    await f.journal(GO_LIVE.cases - 1, 0)
    await f.journal(40, 0, 'native-owner')
    await expect(f.call('decisions.live', { kind: 'approval', live: true })).rejects.toThrow('approval/workspace-write stays in shadow: its local verdict agreed on 100% of 29 cases in 90 days (29 agreed); going live needs at least 95% over 30 or more')
    await f.journal(0, 2)
    await expect(f.call('decisions.live', { kind: 'approval', boundary: 'workspace-write', live: true })).rejects.toThrow(/agreed on 93\.5% of 31 cases in 90 days \(29 agreed\)/)
    await expect(f.call('decisions.live', { kind: 'approval', boundary: 'workspace-write', live: true }, false)).rejects.toThrow(/Only the owner or a wizard tab/)
    // native-owner meets the numbers but is never answered by a local verdict.
    await expect(f.call('decisions.live', { kind: 'approval', boundary: 'native-owner', live: true })).rejects.toThrow(/approval\/native-owner cannot go live/)
    await expect(f.call('decisions.live', { kind: 'approval', boundary: 'shell', live: true })).rejects.toThrow(/approval boundary must be one of workspace-write, native-owner/)
    await expect(f.call('decisions.live', { kind: 'retry', boundary: 'workspace-write', live: false })).rejects.toThrow(/retry has one boundary, "all"/)
    expect(f.service.liveBoundaries.isLive('approval', 'workspace-write')).toBe(false)
    expect(f.values.get('model-intelligence:live-flips')).toBeUndefined()
  })
  it('goes live at 95% over 30 cases and back to shadow at any time, journaling each switch; the approval kind keeps measuring in shadow', async () => {
    const f = fixture()
    await f.journal(29, 1)
    expect(await f.call('decisions.live', { kind: 'approval', live: true })).toMatchObject({ kind: 'approval', boundary: 'workspace-write', cases: 30, agreement: 29 / 30, live: true, meetsRule: true, previous: false, switched: { live: true, by: 'wizard-1' } })
    expect(f.service.decisions.thresholds('approval').mode).toBe('shadow')
    expect(f.service.liveBoundaries.isLive('approval', 'workspace-write')).toBe(true)
    expect(await f.call('decisions.live', { kind: 'approval', live: false })).toMatchObject({ live: false, previous: true })
    const listed = await f.call('decisions.list', { kind: 'approval' }) as Listed
    expect(listed.switches.map(entry => [entry.boundary, entry.live, entry.by, entry.reason])).toEqual([['workspace-write', false, 'wizard-1', 'switched back to shadow'], ['workspace-write', true, 'wizard-1', '96.7% over 30 cases']])
    await expect(f.call('decisions.live', { kind: 'nope', live: true })).rejects.toThrow(/kind must be one of/)
    await expect(f.call('decisions.live', { kind: 'approval', live: 'yes' })).rejects.toThrow(/live must be true or false/)
    // Another kind is one boundary, switched through its DecisionService mode.
    expect(await f.call('decisions.live', { kind: 'retry', live: false })).toMatchObject({ boundary: 'all', live: false, previous: true })
    expect(f.service.decisions.thresholds('retry').mode).toBe('shadow')
  })
  it('reverts a live boundary to shadow by itself, journaled, once its agreement falls below the rule; never flips one live, and leaves default-live kinds alone', async () => {
    const f = fixture()
    await f.journal(30, 0)
    await f.call('decisions.live', { kind: 'approval', live: true })
    await f.journal(0, 1)
    expect(f.service.liveBoundaries.check('approval', 'workspace-write')).toEqual([])
    expect(f.service.liveBoundaries.isLive('approval', 'workspace-write')).toBe(true)
    await f.journal(0, 1)
    const [reverted] = f.service.liveBoundaries.check('approval', 'workspace-write')
    expect(reverted).toMatchObject({ kind: 'approval', boundary: 'workspace-write', live: false, by: 'auto-revert', cases: 32, agreement: 30 / 32, reason: 'agreement fell to 93.8% of 32 cases, below the 95% rule' })
    expect(f.service.liveBoundaries.isLive('approval', 'workspace-write')).toBe(false)
    // Agreement back above the rule does not switch it live again.
    await f.journal(40, 0)
    expect(f.service.liveBoundaries.check('approval', 'workspace-write')).toEqual([])
    expect(f.service.liveBoundaries.isLive('approval', 'workspace-write')).toBe(false)
    // Route is live by default and was never switched: a low agreement on close calls never reverts it.
    await f.service.decisions.decide({ ...request('x'), kind: 'route' }, { frontier: { ...reviewer('deny'), supports: () => true }, mode: 'shadow' })
    expect(f.service.liveBoundaries.check('route')).toEqual([])
    expect(f.service.decisions.thresholds('route').mode).toBe('live')
    expect((await f.call('decisions.list', { kind: 'approval' }) as Listed).switches[0]).toMatchObject({ by: 'auto-revert' })
  })
})

describe('models.evaluate admission (B5-G)', () => {
  const start = () => {
    const startEvaluation = vi.fn(async (key: { provider: string; model: string }) => ({ runId: 'evaluation_x', key, suite: 'default', state: 'running', startedAt: '', notGradable: [] }))
    const service = { store: { now: () => new Date('2026-09-28T20:00:00Z') }, startEvaluation } as unknown as ModelIntelligence
    const call = (offered: Array<{ provider: string; model: string }>, args: Record<string, unknown>) => callModelMethod(service, {
      projectId: 'p1', workspaceId: 'w2', agentSessionId: 'wizard', sovereign: true, readOnly: false, controls: () => false,
      live: { offered, providerEnabled: () => true, usagePercent: () => null, loadedLocalModels: () => [] }
    }, 'models.evaluate', args)
    return { startEvaluation, call }
  }
  const OFFERED = [{ provider: 'claude', model: 'opus' }, { provider: 'claude', model: 'opus[1m]' }, { provider: 'claude', model: 'claude-fable-5-1' }, { provider: 'codex', model: 'gpt-6-astra' }]

  it('evaluates the model models.list offers this caller, in the caller\'s workspace', async () => {
    const f = start()
    await f.call(OFFERED, { provider: 'claude', model: 'opus[1m]' })
    expect(f.startEvaluation).toHaveBeenCalledWith({ provider: 'claude', model: 'opus[1m]' }, undefined, { scope: { projectId: 'p1', workspaceId: 'w2' } })
  })
  it('resolves a name as tabs.open does (H09) and says what it resolved from', async () => {
    const f = start()
    expect(await f.call(OFFERED, { provider: 'claude', model: 'fable' })).toMatchObject({ modelResolvedFrom: 'fable' })
    expect(f.startEvaluation.mock.calls[0]![0]).toEqual({ provider: 'claude', model: 'claude-fable-5-1' })
  })
  it('refuses before any run starts or counts when the model or the provider\'s catalog is not offered', async () => {
    const f = start()
    await expect(f.call(OFFERED, { provider: 'claude', model: 'claude-opus-4-1' })).rejects.toThrow('claude/claude-opus-4-1 is not offered to this conversation; claude offers opus, opus[1m], claude-fable-5-1 (models.list). No evaluation was started or counted')
    await expect(f.call(OFFERED.filter(key => key.provider !== 'claude'), { provider: 'claude', model: 'opus[1m]' })).rejects.toThrow(/claude offers no model to this conversation right now \(its catalog is not ready yet/)
    expect(f.startEvaluation).not.toHaveBeenCalled()
  })
  it('leaves local keys to the local admission', async () => {
    const f = start()
    await f.call([], { provider: 'local', model: 'qwen' })
    expect(f.startEvaluation).toHaveBeenCalledWith({ provider: 'local', model: 'local/qwen' }, undefined, {})
  })
})
