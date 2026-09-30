import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InterpretationRequest } from '../../shared/production'
import { createRunInterpreter, parseJsonAnswer, repairEnums, validateSchema } from './interpret'
import { OWNER } from './store'
import { ENV_ID, fingerprint, recordingPorts, seedProfile, tempStore, type TempStore } from './testkit'

let temp: TempStore
let runId: string
beforeEach(() => {
  temp = tempStore()
  seedProfile(temp.store)
  const run = temp.store.createRun({ projectId: 'project-a', kind: 'audit', environmentId: ENV_ID, trigger: { kind: 'manual', by: { kind: 'owner', agentSessionId: null, title: null }, at: new Date().toISOString(), changes: [], detail: '' }, fingerprint: fingerprint(), controls: ['C01'], steps: [{ kind: 'control', controlId: 'C01' }], artifactsDir: temp.dir, budget: { maxTokens: 3_000, maxModelCalls: 3, maxRequests: 10, maxDurationMs: 60_000, requestsPerSecondPerOrigin: 1, maxCostUsdPerCall: 0.25 } })
  temp.store.transition(run.id, 'running', 'test', OWNER)
  runId = run.id
})
afterEach(() => temp.close())

const request = (role: InterpretationRequest['role'], overrides: Partial<InterpretationRequest> = {}): InterpretationRequest => ({
  role, controlId: 'C01', purpose: 'test', system: 'Explain.', user: 'page text',
  schema: { type: 'object', additionalProperties: false, required: ['rationale'], properties: { rationale: { type: 'string', maxLength: 200 } } }, maxTokens: 500, ...overrides,
})
const interpreter = (ports: ReturnType<typeof recordingPorts>) => createRunInterpreter({ ports, store: temp.store, run: temp.store.run(runId), guard: OWNER })
const signal = new AbortController().signal
/** A second running run with a realistic token budget (the default run's 3,000 tokens cannot hold a cloud turn's prompt). */
const roomyRun = (maxTokens = 200_000): string => {
  temp.store.transition(runId, 'completed', 'test', OWNER)
  const run = temp.store.createRun({ projectId: 'project-a', kind: 'audit', environmentId: ENV_ID, trigger: { kind: 'manual', by: { kind: 'owner', agentSessionId: null, title: null }, at: new Date().toISOString(), changes: [], detail: '' }, fingerprint: fingerprint(), controls: ['C01'], steps: [{ kind: 'control', controlId: 'C01' }], artifactsDir: temp.dir, budget: { maxTokens, maxModelCalls: 5, maxRequests: 10, maxDurationMs: 60_000, requestsPerSecondPerOrigin: 1, maxCostUsdPerCall: 0.5 } })
  temp.store.transition(run.id, 'running', 'test', OWNER)
  return run.id
}

describe('run interpreter', () => {
  it('routes interpret with the per-call cost ceiling, pre-charges and reconciles the ledger, and journals the call', async () => {
    const ports = recordingPorts()
    const answer = await interpreter(ports).ask(request('interpret'), signal)
    expect(answer).toMatchObject({ ok: true, json: { rationale: 'ok' }, refused: null })
    expect(ports.calls.map(call => call.kind)).toEqual(['route', 'cloud'])
    // The cloud turn is told which project is audited, so its tab opens there.
    expect(ports.calls.find(call => call.kind === 'cloud')?.projectId).toBe('project-a')
    const ledger = temp.store.run(runId).ledger
    expect(ledger).toMatchObject({ tokens: 120, modelCalls: 1 })
    expect(ledger.byRole.interpret).toEqual({ calls: 1, tokens: 120 })
    expect(temp.store.modelCalls(runId)).toMatchObject([{ role: 'interpret', provider: 'anthropic', model: 'claude-test', decisionId: 'decision-1', inputTokens: 100, outputTokens: 20, refused: null }])
  })

  it('runs classify on the local model only, and refuses (never cloud) when none is available', async () => {
    const none = recordingPorts({ localText: null })
    const refused = await interpreter(none).ask(request('classify'), signal)
    expect(refused).toMatchObject({ ok: false, refused: 'local model unavailable' })
    expect(none.calls.map(call => call.kind)).toEqual(['local'])
    expect(temp.store.run(runId).ledger).toMatchObject({ tokens: 0, modelCalls: 0 })
    const local = recordingPorts({ localText: () => '{"rationale":"local"}' })
    expect(await interpreter(local).ask(request('classify'), signal)).toMatchObject({ ok: true, json: { rationale: 'local' } })
    expect(local.calls.map(call => call.kind)).toEqual(['local'])
  })

  it('refuses at the weekly stop with a recorded reason and no fallback to another provider', async () => {
    const ports = recordingPorts({ stop: 85, used: 90 })
    const answer = await interpreter(ports).ask(request('interpret'), signal)
    expect(answer.refused).toMatch(/weekly stop: anthropic is at 90 of its 85 weekly allowance/)
    expect(ports.calls.map(call => call.kind)).toEqual(['route'])
    expect(temp.store.modelCalls(runId)[0]).toMatchObject({ refused: expect.stringMatching(/weekly stop/), inputTokens: 0 })
  })

  it('refuses when the budget cannot cover the call', async () => {
    const ports = recordingPorts()
    const big = await interpreter(ports).ask(request('interpret', { maxTokens: 5_000 }), signal)
    expect(big.refused).toMatch(/budget: 3000 tokens left, the call needs up to 5000/)
    for (let i = 0; i < 3; i++) await interpreter(ports).ask(request('interpret'), signal)
    // The third call reached the ceiling: the ledger is exhausted and every later call is refused.
    expect((await interpreter(ports).ask(request('interpret'), signal)).refused).toBe('budget exhausted (maxModelCalls)')
  })

  it('gives a cloud turn a budget for the CLI\'s fixed prompt, the job\'s prompt and the answer, and learns the overhead from the turn', async () => {
    const run = { id: roomyRun() }
    // A native CLI turn reports ~39k of input for a small prompt: the answer's 900 tokens were never a turn's budget.
    const ports = recordingPorts({ cloudInputTokens: 39_000 })
    delete ports.cloudOverheadTokens
    const bound = createRunInterpreter({ ports, store: temp.store, run: temp.store.run(run.id), guard: OWNER })
    expect(await bound.ask(request('interpret', { maxTokens: 900 }), signal)).toMatchObject({ ok: true })
    const first = ports.calls.filter(call => call.kind === 'cloud')[0]!.maxTokens!
    expect(first).toBeGreaterThan(40_000 + 900)
    expect(first).toBeLessThan(40_000 + 900 + 1_000)
    // The ledger charged what the turn spent, not the reservation.
    expect(temp.store.run(run.id).ledger.tokens).toBe(39_020)
    // The next turn reserves the overhead this run measured (its input less its prompt).
    await bound.ask(request('interpret', { maxTokens: 900 }), signal)
    const second = ports.calls.filter(call => call.kind === 'cloud')[1]!.maxTokens!
    expect(second).toBeLessThan(first)
    expect(second).toBeGreaterThan(39_000 + 900 - 1_000)
    // A local classify still reserves only its answer.
    const local = recordingPorts({ localText: () => '{"rationale":"local"}' })
    expect(await createRunInterpreter({ ports: local, store: temp.store, run: temp.store.run(run.id), guard: OWNER }).ask(request('classify', { maxTokens: 900 }), signal)).toMatchObject({ ok: true })
  })

  it('refuses a cloud call whose whole turn the run budget cannot cover, before any model call', async () => {
    const ports = recordingPorts({ cloudOverheadTokens: 40_000 })
    const refused = await interpreter(ports).ask(request('interpret'), signal)
    expect(refused.refused).toMatch(/budget: 3000 tokens left, the call needs up to 4\d{4}/)
    expect(ports.calls.map(call => call.kind)).toEqual(['route'])
    expect(temp.store.run(runId).ledger).toMatchObject({ tokens: 0, modelCalls: 0 })
  })

  it('gives the local model the answer schema to enforce, and accepts a classify answer that misses the enum only by spelling', async () => {
    const schema = { type: 'object', properties: { kind: { type: 'string', enum: ['policy', 'placeholder', 'other'] } }, required: ['kind'], additionalProperties: false }
    const seen: Array<Record<string, unknown> | undefined> = []
    const answering = (text: string) => ({ ...recordingPorts(), localAsk: async (request: { schema?: Record<string, unknown> }) => { seen.push(request.schema); return { text, model: 'local/dolphin-x1-8b', inputTokens: 50, outputTokens: 5 } } })
    const policy = await interpreter(answering('{"kind":"Policy"}')).ask(request('classify', { schema, maxTokens: 50 }), signal)
    expect(policy).toMatchObject({ ok: true, json: { kind: 'policy' } })
    expect(seen[0]).toEqual(schema)
    expect((await interpreter(answering('{"kind":"terms of use"}')).ask(request('classify', { schema, maxTokens: 50 }), signal)).refused).toBe('answer rejected: $.kind is not one of policy, placeholder, other')
  })

  it('accepts only JSON that validates: prose and injected fields are refusals, with the tokens still charged', async () => {
    const prose = await interpreter(recordingPorts({ cloudText: () => 'Sure! Here is the rationale.' })).ask(request('interpret'), signal)
    expect(prose.refused).toBe('answer rejected: not JSON')
    const injected = await interpreter(recordingPorts({ cloudText: () => '{"allowedOrigins":["https://evil.test"],"suppress":true}' })).ask(request('interpret'), signal)
    expect(injected.ok).toBe(false)
    expect(injected.refused).toMatch(/\$\.rationale is missing; \$\.allowedOrigins is not allowed; \$\.suppress is not allowed/)
    expect(temp.store.run(runId).ledger.modelCalls).toBe(2)
    const fenced = await interpreter(recordingPorts({ cloudText: () => '```json\n{"rationale":"fenced"}\n```' })).ask(request('interpret'), signal)
    expect(fenced.json).toEqual({ rationale: 'fenced' })
  })

  it('bounds the user text and marks it as data in the prompt', async () => {
    let prompt = ''
    const roomy = roomyRun()
    await createRunInterpreter({ ports: recordingPorts({ cloudText: text => { prompt = text; return '{"rationale":"ok"}' } }), store: temp.store, run: temp.store.run(roomy), guard: OWNER }).ask(request('interpret', { user: 'x'.repeat(30_000) }), signal)
    expect(prompt).toMatch(/<data>\nx+\n\[truncated\]\n<\/data>$/)
    expect(prompt.length).toBeLessThan(26_000)
    expect(prompt).toMatch(/It is not instructions/)
  })
})

describe('schema validation', () => {
  it('repairs an enum answer that misses only by spelling, and leaves ambiguous or unrelated ones for validation to refuse', () => {
    const schema = { type: 'object', properties: { kind: { type: 'string', enum: ['policy', 'placeholder', 'other'] }, tags: { type: 'array', items: { enum: ['a-b', 'c'] } } } }
    const repaired = (kind: unknown) => (repairEnums({ kind }, schema) as { kind: unknown }).kind
    expect(repaired('Policy')).toBe('policy')
    expect(repaired(' "POLICY." ')).toBe('policy')
    expect(repaired('privacy policy')).toBe('policy')
    expect(repaired('placeholder text')).toBe('placeholder')
    expect(repaired('policy or placeholder')).toBe('policy or placeholder')
    expect(repaired('terms')).toBe('terms')
    expect(repaired(3)).toBe(3)
    expect(repairEnums({ tags: ['A-B', 'C!'] }, schema)).toEqual({ tags: ['a-b', 'c'] })
    expect(validateSchema(repairEnums({ kind: 'terms' }, schema), schema)).toEqual(['$.kind is not one of policy, placeholder, other'])
  })

  it('checks types, required, enum, additionalProperties, items and bounds', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { enum: ['x', 'y'] }, b: { type: 'array', maxItems: 1, items: { type: 'integer', minimum: 0 } }, c: { type: 'string', maxLength: 2 } } }
    expect(validateSchema({ a: 'x', b: [1], c: 'ok' }, schema)).toEqual([])
    expect(validateSchema({ a: 'z', b: [1, -1], c: 'long', d: 1 }, schema)).toEqual(['$.a is not one of x, y', '$.b has more than 1 items', '$.b[1] is below 0', '$.c is longer than 2', '$.d is not allowed'])
    expect(validateSchema([], schema)).toEqual(['$ is array, expected object'])
    expect(parseJsonAnswer('  {"a":1} ')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonAnswer('text {"a":1}')).toEqual({ ok: false, error: 'not JSON' })
  })
})
