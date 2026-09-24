import { describe, expect, it } from 'vitest'
import { DEFAULT_DURABLE_JOB_BUDGETS } from '../../shared/durable-jobs.ts'
import type { TimelineItem } from '../../shared/structured-agent.ts'
import { ContextRolloverWatch, Watchdog, boundedExcerpt, latestContextTokens, redactData, redactHandoff, redactSensitive, type DurableJobEventDraft, type HealthProbe } from './watchdog.ts'

const MIN = 60_000
const budgets = { ...DEFAULT_DURABLE_JOB_BUDGETS, modelCallTimeoutMs: 10 * MIN, toolCallTimeoutMs: 5 * MIN, stageTimeoutMs: 60 * MIN, maxStageAttempts: 2 }

function harness(health: HealthProbe = { healthy: true }) {
  const state = { clock: 0, health, events: [] as DurableJobEventDraft[], probes: 0 }
  const dog = new Watchdog(budgets, { now: () => state.clock, probeHealth: async () => { state.probes++; return state.health }, emit: event => { state.events.push(event) } }, { tickMs: 15_000, clockJumpMs: 90_000, stallAfterMs: 3 * MIN })
  /** Advance the clock in tick-sized steps, feeding tokens on each step when asked. */
  const run = async (ms: number, onStep?: () => void) => {
    const decisions = []
    for (let t = 0; t < ms; t += 15_000) { state.clock += 15_000; onStep?.(); decisions.push(...await dog.tick()) }
    return decisions
  }
  return { state, dog, run }
}

describe('watchdog', () => {
  it('lets slow inference that keeps streaming run past its budget once, then interrupts', async () => {
    const { dog, run } = harness()
    const id = dog.begin('model-call', 'stage 1 round 4')
    const within = await run(10 * MIN - 15_000, () => dog.signal(id, { kind: 'tokens', count: 3 }))
    expect(within).toEqual([])
    const extended = await run(30_000, () => dog.signal(id, { kind: 'tokens', count: 3 }))
    expect(extended).toMatchObject([{ action: 'extend', reason: 'streaming-past-deadline' }])
    const later = await run(5 * MIN, () => dog.signal(id, { kind: 'tokens', count: 3 }))
    expect(later).toMatchObject([{ action: 'interrupt', reason: 'deadline' }])
  })

  it('interrupts a call that stopped streaming on a healthy server as stalled', async () => {
    const { dog, run } = harness()
    const id = dog.begin('model-call', 'round')
    dog.signal(id, { kind: 'tokens', count: 10 })
    const decisions = await run(4 * MIN)
    expect(decisions).toMatchObject([{ action: 'interrupt', reason: 'stalled' }])
  })

  it('treats a silent call whose slot is evaluating the prompt as slow, not stalled', async () => {
    const { dog, run } = harness({ healthy: true, processing: true })
    dog.begin('model-call', 'long prompt')
    expect(await run(9 * MIN)).toEqual([])
  })

  it('interrupts at once with a server event when the server is unhealthy', async () => {
    const { dog, run, state } = harness({ healthy: false, detail: 'ECONNREFUSED' })
    dog.begin('model-call', 'round')
    const decisions = await run(4 * MIN)
    expect(decisions).toMatchObject([{ action: 'interrupt', reason: 'server-unhealthy' }])
    expect(state.events.at(-1)!.kind).toBe('server')
  })

  it('does not treat a quiet tool call as stalled before its deadline', async () => {
    const { dog, run } = harness()
    dog.begin('tool-call', 'npm test')
    expect(await run(4 * MIN)).toEqual([])
    expect(await run(90_000)).toMatchObject([{ action: 'interrupt', reason: 'deadline', scope: 'tool-call' }])
  })

  it('reconciles a sleep/wake clock jump instead of counting it as a stall', async () => {
    const { dog, run, state } = harness()
    const id = dog.begin('model-call', 'round')
    await run(MIN, () => dog.signal(id, { kind: 'tokens', count: 1 }))
    state.clock += 2 * 60 * MIN
    const woke = await dog.tick()
    expect(woke).toMatchObject([{ action: 'reconcile', reason: 'clock-jump' }])
    expect(state.events.at(-1)!.kind).toBe('recovery')
    const [watch] = dog.active()
    expect(watch!.elapsedMs).toBeLessThan(2 * MIN)
    expect(await run(MIN, () => dog.signal(id, { kind: 'tokens', count: 1 }))).toEqual([])
  })

  it('excludes owner pauses from the budget', async () => {
    const { dog, run, state } = harness()
    dog.begin('tool-call', 'build')
    dog.pause()
    state.clock += 30 * MIN
    expect(await dog.tick()).toEqual([])
    dog.resume()
    expect(await run(4 * MIN)).toEqual([])
  })

  it('retries within the budget and then blocks with diagnostics', () => {
    const { dog } = harness()
    const first = dog.begin('model-call', 'round', 'stage-1:round-4')
    expect(dog.afterInterrupt(first)).toMatchObject({ action: 'retry', attempt: 2 })
    const second = dog.begin('model-call', 'round', 'stage-1:round-4')
    expect(dog.afterInterrupt(second)).toMatchObject({ action: 'retry', attempt: 3 })
    const third = dog.begin('model-call', 'round', 'stage-1:round-4')
    const blocked = dog.afterInterrupt(third)
    expect(blocked).toMatchObject({ action: 'block', attempt: 3 })
    if (blocked.action === 'block') expect(blocked.nextAction).toMatch(/local model server/)
    expect(dog.afterInterrupt('stage-1', 'stage')).toMatchObject({ action: 'retry' })
    expect(dog.afterInterrupt('stage-1', 'stage')).toMatchObject({ action: 'block' })
  })
})

describe('redaction', () => {
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef'
  it('removes keys, tokens and credentials but keeps commit hashes and ordinary text', () => {
    const raw = [
      `llama-server --api-key ${key} --port 8081`,
      'Authorization: Bearer abcdefghijklmnop.qrstuv',
      'curl https://user:hunter2@example.com/x',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
      'password: "correct horse"',
      'sk-ant-api03-abcdefghijklmnopqrstuv',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
      'commit 7381862a1b2c3d4e5f60718293a4b5c6d7e8f901 passed 12 tests'
    ].join('\n')
    const clean = redactSensitive(raw, ['my-owner-secret'])
    for (const secret of [key, 'abcdefghijklmnop.qrstuv', 'hunter2', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'correct horse', 'sk-ant-api03', 'MIIE']) expect(clean).not.toContain(secret)
    expect(clean).toContain('7381862a1b2c3d4e5f60718293a4b5c6d7e8f901')
    expect(clean).toContain('passed 12 tests')
    expect(redactSensitive('value my-owner-secret here', ['my-owner-secret'])).toBe('value [redacted] here')
  })

  it('redacts nested data and credential-named keys, and bounds excerpts', () => {
    const data = redactData({ apiKey: 'plain', nested: [{ note: `--api-key ${key}` }], count: 3 })
    expect(data).toEqual({ apiKey: '[redacted]', nested: [{ note: '--api-key [redacted]' }], count: 3 })
    const excerpt = boundedExcerpt('x'.repeat(5000) + ' error at the end', 300)
    expect(excerpt.length).toBeLessThan(400)
    expect(excerpt).toContain('error at the end')
  })

  it('redacts the free text of a handoff and keeps its paths', () => {
    const handoff = redactHandoff({
      objective: 'Fix the parser', constraints: ['never print api_key=plainsecretvalue'], decisions: ['Authorization: Bearer Zq8vT3kLm9Wx2Rb7Np4Hs6Jd'], workDone: [`ran with --api-key ${key}`],
      filesChanged: ['src/parser.ts'], testResults: ['fail: curl -H "Authorization: Bearer Zq8vT3kLm9Wx2Rb7Np4Hs6Jd"'], unresolvedIssues: ['sk-proj-4f9QzX2mL8kV7nB3cR6tY1wP rejected'],
      nextAction: `retry with token=${key}`, artifacts: [{ path: 'C:/logs/out-1a2b3c4d5e6f.log', kind: 'log', note: 'Bearer Zq8vT3kLm9Wx2Rb7Np4Hs6Jd' }], updatedAt: ''
    })
    const text = JSON.stringify(handoff)
    for (const secret of ['plainsecretvalue', 'Zq8vT3kLm9Wx2Rb7Np4Hs6Jd', key, '4f9QzX2mL8kV7nB3cR6tY1wP']) expect(text).not.toContain(secret)
    expect(handoff.filesChanged).toEqual(['src/parser.ts'])
    expect(handoff.artifacts[0]!.path).toBe('C:/logs/out-1a2b3c4d5e6f.log')
  })
})

describe('in-stage context rollover', () => {
  it('crosses contextRolloverFraction once, waits for a running tool, and ignores later growth', () => {
    const watch = new ContextRolloverWatch(32_768, 0.7)
    expect(watch.thresholdTokens).toBe(22_937)
    expect(watch.observe(undefined)).toBeNull()
    expect(watch.observe(12_000)).toBeNull()
    expect(watch.observe(22_936)).toBeNull()
    expect(watch.observe(23_500, true)).toBeNull()
    expect(watch.observe(undefined, true)).toBeNull()
    expect(watch.observe(undefined, false)).toEqual({ promptTokens: 23_500, thresholdTokens: 22_937, contextTokens: 32_768, fraction: 0.7 })
    expect(watch.observe(30_000)).toBeNull()
    expect(() => new ContextRolloverWatch(32_768, 0)).toThrow(/fraction/)
  })

  it('reads the context of the newest request from the usage items', () => {
    const usage = (sequence: number, inputTokens: number, outputTokens?: number): TimelineItem => ({ id: `u${sequence}`, runtimeId: 'r', sequence, timestamp: '', data: { type: 'usage', inputTokens, ...(outputTokens === undefined ? {} : { outputTokens }), scope: 'message', source: 'provider' } })
    expect(latestContextTokens([])).toBeUndefined()
    expect(latestContextTokens([usage(3, 9_000, 500), usage(1, 20_000, 10), { id: 't', runtimeId: 'r', sequence: 4, timestamp: '', data: { type: 'text', role: 'assistant', text: 'x', mode: 'snapshot' } }])).toBe(9_500)
  })
})
