import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InterpretationRequest } from '../../shared/production'
import { createRunInterpreter, parseJsonAnswer, validateSchema } from './interpret'
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

describe('run interpreter', () => {
  it('routes interpret with the per-call cost ceiling, pre-charges and reconciles the ledger, and journals the call', async () => {
    const ports = recordingPorts()
    const answer = await interpreter(ports).ask(request('interpret'), signal)
    expect(answer).toMatchObject({ ok: true, json: { rationale: 'ok' }, refused: null })
    expect(ports.calls.map(call => call.kind)).toEqual(['route', 'cloud'])
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
    await interpreter(recordingPorts({ cloudText: text => { prompt = text; return '{"rationale":"ok"}' } })).ask(request('interpret', { user: 'x'.repeat(30_000) }), signal)
    expect(prompt).toMatch(/<data>\nx+\n\[truncated\]\n<\/data>$/)
    expect(prompt.length).toBeLessThan(26_000)
    expect(prompt).toMatch(/It is not instructions/)
  })
})

describe('schema validation', () => {
  it('checks types, required, enum, additionalProperties, items and bounds', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { enum: ['x', 'y'] }, b: { type: 'array', maxItems: 1, items: { type: 'integer', minimum: 0 } }, c: { type: 'string', maxLength: 2 } } }
    expect(validateSchema({ a: 'x', b: [1], c: 'ok' }, schema)).toEqual([])
    expect(validateSchema({ a: 'z', b: [1, -1], c: 'long', d: 1 }, schema)).toEqual(['$.a is not one of x, y', '$.b has more than 1 items', '$.b[1] is below 0', '$.c is longer than 2', '$.d is not allowed'])
    expect(validateSchema([], schema)).toEqual(['$ is array, expected object'])
    expect(parseJsonAnswer('  {"a":1} ')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonAnswer('text {"a":1}')).toEqual({ ok: false, error: 'not JSON' })
  })
})
