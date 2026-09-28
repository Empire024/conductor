import { describe, expect, it } from 'vitest'
import { modelKeyId, type Decider, type DecisionRecord, type ModelKey, type RegistryRecord, type ReputationScore, type TaskCategory, type TaskFeatures } from '../../shared/model-routing'
import { DecisionService } from './decision-service'
import { createScorerDecider } from './deciders/scorer'
import { explainRoute } from './explain'
import { RouteUnavailableError, pickEffort, route, type RouteLiveFacts, type RouterPorts } from './router'

const record = (provider: string, model: string, extra: Partial<RegistryRecord> = {}): RegistryRecord => ({
  key: { provider, model }, status: 'proven', displayName: model, family: null, releasedAt: null, deprecatedAt: null, contextTokens: 200_000, maxOutputTokens: null,
  modalities: ['text'], toolUse: true, efforts: [], pricing: null, latencyMs: null, tokensPerSecond: null, availability: 'available', capabilities: [], local: null,
  provenance: {}, firstSeenAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z', stale: false, ...extra,
})
const price = (inputPerMTok: number, outputPerMTok: number) => ({ inputPerMTok, outputPerMTok, cachedInputPerMTok: null, currency: 'USD' as const })
const LOCAL = record('local', 'qwen3.6-35b-a3b', { contextTokens: 64_000, local: { sizeGb: 20, quant: 'Q4_K_M', vramGb: 11, gpuLayers: 99, loaded: false } })
const CHEAP = record('codex', 'gpt-5.6-sol', { family: 'gpt-5.6', contextTokens: 400_000, pricing: price(0.25, 2), efforts: ['low', 'medium', 'high'] })
const STRONG = record('claude', 'opus[1m]', { family: 'claude-opus-5.5', contextTokens: 1_000_000, pricing: price(5, 25), efforts: ['low', 'medium', 'high', 'max'] })

type Table = Partial<Record<string, Partial<Record<TaskCategory, [number, number, number]>>>>
const REPUTATION: Table = {
  [modelKeyId(LOCAL.key)]: { 'simple-coding': [0.8, 0.72, 20], 'difficult-coding': [0.55, 0.45, 3] },
  [modelKeyId(CHEAP.key)]: { 'simple-coding': [0.85, 0.78, 30], 'difficult-coding': [0.7, 0.6, 20] },
  [modelKeyId(STRONG.key)]: { 'simple-coding': [0.92, 0.86, 25], 'difficult-coding': [0.93, 0.88, 41] },
}
const lookup = (table: Table) => (key: ModelKey, dimension: string): ReputationScore | null => {
  const entry = table[modelKeyId(key)]?.[dimension as TaskCategory]
  return entry ? { key, dimension: dimension as TaskCategory, mean: entry[0], lower: entry[1], evidence: entry[2], priorMean: 0.6, priorSource: 'benchmark', lastOutcomeAt: '2026-09-27T00:00:00Z' } : null
}
const live = (extra: Partial<RouteLiveFacts> = {}): RouteLiveFacts => ({ providerEnabled: provider => provider !== 'openrouter', usagePercent: () => 20, loadedLocalModels: () => ['qwen3.6-35b-a3b'], ...extra })
const setup = (options: { records?: RegistryRecord[]; table?: Table; live?: Partial<RouteLiveFacts>; frontier?: Decider } = {}) => {
  const journal: DecisionRecord[] = []
  const decisions = new DecisionService({ deciders: [createScorerDecider(), ...(options.frontier ? [options.frontier] : [])], journal: { record: entry => { journal.push(entry) } }, settings: { getSetting: () => null, setSetting: () => {} } })
  const ports: RouterPorts = { records: () => options.records ?? [LOCAL, CHEAP, STRONG], reputation: lookup(options.table ?? REPUTATION), live: live(options.live), decisions }
  return { ports, journal }
}
const simple: TaskFeatures = { category: 'simple-coding', complexity: 2, risk: 'low', toolsRequired: ['Bash', 'Edit'], contextTokens: 20_000 }
const hard: TaskFeatures = { category: 'difficult-coding', complexity: 5, risk: 'high', toolsRequired: ['Bash', 'Edit'], contextTokens: 32_000 }
const chosen = (decision: { selected: { key: ModelKey } }) => modelKeyId(decision.selected.key)

describe('router: local vs cheap cloud vs strong cloud', () => {
  it('does not spend the strong model on simple work', async () => {
    const decision = await route(simple, {}, setup().ports)
    expect(chosen(decision)).not.toBe('claude/opus[1m]')
    expect(decision.candidates.every(candidate => candidate.eligible)).toBe(true)
  })
  it('the cost weight flips simple work between the strong model and the free local one', async () => {
    expect(chosen(await route(simple, { costWeight: 0 }, setup().ports))).toBe('claude/opus[1m]')
    const decision = await route(simple, { costWeight: 1 }, setup().ports)
    expect(chosen(decision)).toBe('local/qwen3.6-35b-a3b')
    expect(decision.reasons).toContain('local model: no per-token cost, already loaded')
  })
  it('high-risk difficult coding goes to the strong model, with fallback and escalation', async () => {
    const { ports, journal } = setup({ records: [LOCAL, CHEAP, STRONG, record('claude', 'claude-fable-5-1', { family: 'claude-fable-5', pricing: price(25, 125) })],
      table: { ...REPUTATION, 'claude/claude-fable-5-1': { 'difficult-coding': [0.95, 0.885, 12] } } })
    const decision = await route(hard, {}, ports)
    expect(chosen(decision)).toBe('claude/opus[1m]')
    expect(decision.selected.effort).toBe('high')
    expect(decision.fallback?.key).toEqual(CHEAP.key)
    expect(decision.escalation?.key).toEqual({ provider: 'claude', model: 'claude-fable-5-1' })
    expect(decision).toMatchObject({ decidedBy: 'scorer', escalated: false, decisionId: journal[0]!.id })
    expect(decision.confidence).toBeGreaterThan(0.55)
  })
  it('constraints flip the selection: a cost cap, an excluded provider, a spent quota, local only', async () => {
    const { ports } = setup()
    const capped = await route(hard, { maxCostUsd: 2 }, ports)
    expect(chosen(capped)).toBe('codex/gpt-5.6-sol')
    expect(capped.reasons.find(reason => reason.startsWith('claude/opus[1m] excluded'))).toMatch(/\$2\.49 over the \$2\.00 cap/)
    expect(chosen(await route(hard, { excludeProviders: ['claude'] }, ports))).toBe('codex/gpt-5.6-sol')
    expect(chosen(await route(hard, {}, setup({ live: { usagePercent: provider => provider === 'claude' ? 91 : 20 } }).ports))).toBe('codex/gpt-5.6-sol')
    expect(chosen(await route(simple, { localOnly: true }, ports))).toBe('local/qwen3.6-35b-a3b')
    // Three difficult-coding outcomes are no proven record for complexity 5, high-risk work.
    await expect(route(hard, { localOnly: true }, ports)).rejects.toThrow(/no proven record on difficult-coding/)
  })
  it('a local model that keeps failing is excluded however cheap it is', async () => {
    const failing: Table = { ...REPUTATION, [modelKeyId(LOCAL.key)]: { 'simple-coding': [0.42, 0.38, 9] } }
    const decision = await route(simple, { costWeight: 1 }, setup({ table: failing }).ports)
    expect(chosen(decision)).toBe('codex/gpt-5.6-sol')
    expect(decision.reasons.find(reason => reason.startsWith('local/qwen3.6-35b-a3b excluded'))).toMatch(/^local\/qwen3\.6-35b-a3b excluded: at most \d+% likely success on simple-coding \(2 of 9 outcomes\)$/)
    await expect(route(simple, { localOnly: true }, setup({ table: failing }).ports)).rejects.toBeInstanceOf(RouteUnavailableError)
  })
  it('a routed failure lowering the reputation moves the next route', async () => {
    const before = await route(simple, {}, setup().ports)
    const after = await route(simple, {}, setup({ table: { ...REPUTATION, [modelKeyId(LOCAL.key)]: { 'simple-coding': [0.6, 0.52, 22] } } }).ports)
    expect([chosen(before), chosen(after)]).toEqual(['local/qwen3.6-35b-a3b', 'codex/gpt-5.6-sol'])
  })
  it('a local model that does not fit or cannot be admitted is not a candidate', async () => {
    const decision = await route(simple, { costWeight: 1 }, setup({ live: { localAdmission: () => ({ fitsVram: true, admissible: false, reason: 'an interactive local turn holds the GPU' }) } }).ports)
    expect(chosen(decision)).toBe('codex/gpt-5.6-sol')
    expect(decision.candidates.find(candidate => candidate.key.provider === 'local')).toMatchObject({ eligible: false, excluded: 'an interactive local turn holds the GPU' })
  })
  it('only enabled providers are candidates, and none gives a RouteUnavailableError', async () => {
    const decision = await route(simple, {}, setup({ records: [LOCAL, CHEAP, STRONG, record('openrouter', 'x/y')] }).ports)
    expect(decision.candidates.map(candidate => candidate.key.provider)).not.toContain('openrouter')
    await expect(route(simple, {}, setup({ live: { providerEnabled: () => false } }).ports)).rejects.toThrow('No enabled provider offers a registered model')
  })
})

describe('router: a fresh install (no outcomes, no benchmarks)', () => {
  const LOCAL_REG = record('local', 'local/qwen3.6-35b-a3b', { contextTokens: 64_000, local: { sizeGb: 20, quant: 'Q4_K_M', vramGb: 11, gpuLayers: 99, loaded: true } })
  const SONNET = record('claude', 'sonnet', { family: 'claude-sonnet-5', contextTokens: 1_000_000, efforts: ['low', 'medium', 'high'] })
  const ASTRA = record('codex', 'gpt-6-astra', { family: 'gpt-6', contextTokens: 400_000, efforts: ['low', 'medium', 'high'] })
  const MINI = record('codex', 'gpt-5.6-mini', { contextTokens: 400_000 })
  const fresh = (live: Partial<RouteLiveFacts> = {}) => setup({ records: [LOCAL_REG, record('claude', 'opus[1m]', { contextTokens: 1_000_000, efforts: ['low', 'medium', 'high'] }), SONNET, ASTRA, MINI, CHEAP], table: {}, live: { loadedLocalModels: () => ['qwen3.6-35b-a3b'], ...live } }).ports
  it('sends hard high-risk work to a strong cloud model, with a strong fallback, never the local model', async () => {
    const decision = await route(hard, {}, fresh())
    expect(['claude/opus[1m]', 'codex/gpt-6-astra']).toContain(chosen(decision))
    expect(decision.fallback?.key.provider).not.toBe(decision.selected.key.provider)
    expect(['claude/opus[1m]', 'codex/gpt-6-astra']).toContain(modelKeyId(decision.fallback!.key))
    expect(decision.fallback?.reason).toMatch(/^strongest eligible model on another provider \(capability rank 3/)
    expect(decision.candidates.find(candidate => candidate.key.provider === 'local')).toMatchObject({ eligible: false, excluded: expect.stringMatching(/^no proven record on difficult-coding for complexity 5, high-risk work/) })
    expect(decision.reasons[0]).toMatch(/success on difficult-coding \(10th percentile\) from the capability rank 3 prior 78%; no Conductor outcomes yet/)
  })
  it('keeps simple cheap work on the free local model, and uses the local registry id once', async () => {
    const decision = await route({ ...simple, risk: 'low', complexity: 1 }, { costWeight: 0.6 }, fresh())
    expect(chosen(decision)).toBe('local/qwen3.6-35b-a3b')
    expect(decision.reasons).toContain('local model: no per-token cost, already loaded')
  })
  it('a usage port decides blocking per key, and a reset window no longer blocks', async () => {
    const blocked = await route(hard, {}, fresh({ usage: key => key.model === 'opus[1m]' ? { percent: 99, blocked: 'weekly Opus window at 99% (stop 85%)' } : { percent: 97, blocked: null } }))
    expect(blocked.candidates.find(candidate => candidate.key.model === 'opus[1m]')).toMatchObject({ eligible: false, excluded: 'usage: weekly Opus window at 99% (stop 85%)' })
    // 97% on a window that does not block is informational only: the weekly-stop comparison is the port's job.
    expect(blocked.candidates.find(candidate => candidate.key.model === 'gpt-6-astra')).toMatchObject({ eligible: true })
  })
  // The live shape: Codex past its weekly stop, an unproven local model barred from hard work.
  const codexBlocked = (key: ModelKey) => key.provider === 'codex' ? { percent: 60, blocked: 'weekly window at 60% (stop 55%)' } : { percent: 10, blocked: null }
  it('falls back within the same provider, to its strongest other model, when no other provider is eligible', async () => {
    const decision = await route(hard, {}, fresh({ usage: codexBlocked }))
    expect(chosen(decision)).toBe('claude/opus[1m]')
    expect(decision.fallback?.key).toEqual({ provider: 'claude', model: 'sonnet' })
    expect(decision.fallback?.reason).toMatch(/^no other provider eligible \(.*codex: usage: weekly window at 60% \(stop 55%\).*local: no proven record on difficult-coding.*\); same-provider fallback \(capability rank 2, /)
  })
  it('keeps preferring another provider whenever one is eligible', async () => {
    const records = [LOCAL_REG, record('claude', 'opus[1m]', { contextTokens: 1_000_000, efforts: ['low', 'medium', 'high'] }), SONNET, ASTRA, MINI, CHEAP, record('grok', 'grok-4.7', { contextTokens: 256_000 })]
    const decision = await route(hard, {}, setup({ records, table: {}, live: { loadedLocalModels: () => [], usage: codexBlocked } }).ports)
    expect(chosen(decision)).toBe('claude/opus[1m]')
    expect(decision.fallback?.key).toEqual({ provider: 'grok', model: 'grok-4.7' })
    expect(decision.fallback?.reason).toMatch(/^strongest eligible model on another provider/)
  })
  it('names why the escalation target was picked', async () => {
    const decision = await route(hard, {}, setup({ records: [LOCAL, CHEAP, STRONG, record('claude', 'claude-fable-5-1', { family: 'claude-fable-5', pricing: price(25, 125) })],
      table: { ...REPUTATION, 'claude/claude-fable-5-1': { 'difficult-coding': [0.95, 0.885, 12] } } }).ports)
    expect(decision.escalation).toMatchObject({ key: { provider: 'claude', model: 'claude-fable-5-1' }, reason: 'higher expected success on difficult-coding: 89% against 88%' })
  })
})

describe('router: provider choice and escalation', () => {
  it('explains the provider choice when one family has several providers', async () => {
    const viaRouter = record('cloud', 'claude-opus-5.5', { family: 'claude-opus-5.5', contextTokens: 1_000_000, pricing: price(6, 30) })
    const table = { ...REPUTATION, 'cloud/claude-opus-5.5': REPUTATION[modelKeyId(STRONG.key)] }
    const decision = await route(hard, {}, setup({ records: [LOCAL, CHEAP, STRONG, viaRouter], table, live: { usagePercent: provider => provider === 'cloud' ? 60 : 20 } }).ports)
    expect(chosen(decision)).toBe('claude/opus[1m]')
    expect(decision.reasons).toContain('provider claude over cloud for claude-opus-5.5: cheaper ($2.49 vs $2.99), more quota left (20% vs 60% used)')
    expect(decision.fallback?.key.provider).not.toBe('claude')
  })
  it('a close call makes the scorer unsure and the frontier decides', async () => {
    const twin = record('codex', 'gpt-5.6-sol-b', { family: 'gpt-5.6', contextTokens: 400_000, pricing: price(0.25, 2) })
    const table = { ...REPUTATION, [modelKeyId(twin.key)]: REPUTATION[modelKeyId(CHEAP.key)] }
    const asked: string[][] = []
    const frontier: Decider = { id: 'frontier', tier: 'frontier', supports: () => true,
      decide: async request => { asked.push(request.options.map(option => option.id)); return { ok: true, verdict: { decider: 'frontier:opus', probabilities: { 'codex/gpt-5.6-sol-b': 1 }, rationale: 'The b deployment is less loaded', elapsedMs: 900 } } } }
    const { ports, journal } = setup({ records: [CHEAP, twin], table, frontier })
    const decision = await route(simple, {}, ports)
    expect(chosen(decision)).toBe('codex/gpt-5.6-sol-b')
    expect(decision).toMatchObject({ decidedBy: 'frontier:opus', escalated: true, confidence: 1 })
    expect(asked[0]).toEqual(['codex/gpt-5.6-sol', 'codex/gpt-5.6-sol-b'])
    expect(journal[0]!.verdicts.map(verdict => verdict.decider)).toEqual(['scorer', 'frontier:opus'])
    expect(journal[0]!.escalationReason).toMatch(/confidence 0\.50 < 0\.55/)
    expect(decision.reasons.at(-1)).toMatch(/^close call escalated \(confidence 0\.50 < 0\.55; margin 0\.00 < 0\.15\); frontier:opus chose$/)
  })
  it('keeps the scorer top when a close call finds no frontier', async () => {
    const twin = record('codex', 'gpt-5.6-sol-b', { contextTokens: 400_000, pricing: price(0.25, 2) })
    const decision = await route(simple, {}, setup({ records: [CHEAP, twin], table: { ...REPUTATION, [modelKeyId(twin.key)]: REPUTATION[modelKeyId(CHEAP.key)] } }).ports)
    expect(chosen(decision)).toBe('codex/gpt-5.6-sol')
    expect(decision).toMatchObject({ decidedBy: 'scorer', escalated: false })
    expect(decision.reasons.at(-1)).toBe("close call, no frontier configured: the scorer's top candidate stands")
    expect(decision.confidence).toBeCloseTo(0.5, 9)
  })
  it('picks effort by complexity from what the model offers', () => {
    expect(pickEffort(['low', 'medium', 'high'], hard)).toBe('high')
    expect(pickEffort(['low', 'medium', 'high'], simple)).toBe('low')
    expect(pickEffort(['minimal', 'standard', 'deep'], hard)).toBe('deep')
    expect(pickEffort([], hard)).toBeNull()
  })
})

describe('router explanation', () => {
  it('renders selection, provider, reasons, fallback, escalation, confidence and evidence', async () => {
    const { ports } = setup({ records: [LOCAL, CHEAP, STRONG, record('claude', 'claude-fable-5-1', { pricing: price(15, 75) })],
      table: { ...REPUTATION, [modelKeyId(LOCAL.key)]: { 'difficult-coding': [0.42, 0.38, 9] }, 'claude/claude-fable-5-1': { 'difficult-coding': [0.96, 0.92, 12] } } })
    const text = explainRoute(await route(hard, { maxCostUsd: 3 }, ports))
    const lines = text.split('\n')
    expect(lines[0]).toBe('Selected: opus[1m] via claude (effort high)')
    expect(lines[1]).toBe('Reasons:')
    expect(text).toContain('- 88% success on difficult-coding (10th percentile) (41 weighted outcomes, 30-day half-life)')
    expect(text).toContain('- expected cost $2.49 within the $3.00 cap')
    expect(text).toContain('- local/qwen3.6-35b-a3b excluded: at most 42% likely success on difficult-coding (2 of 9 outcomes)')
    expect(text).toContain('Fallback: gpt-5.6-sol via codex (effort high) — strongest eligible model on another provider (capability rank 1, 60% expected)')
    expect(text).toContain('- claude/claude-fable-5-1 excluded: expected cost $7.47 over the $3.00 cap')
    expect(text).toContain('- tool use required: supported; 32k context needed, 1M available')
    expect(text).toContain('Fallback: gpt-5.6-sol via codex (effort high)')
    expect(text).toContain('Escalation: none')
    expect(lines.at(-1)).toMatch(/^Confidence [01]\.\d\d \(margin [01]\.\d\d\), decided by scorer$/)
  })
})
