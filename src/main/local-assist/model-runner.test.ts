import { describe, expect, it } from 'vitest'
import type { CompletionRequest, CompletionResult } from '../local-models/client.ts'
import { DOLPHIN_X1_8B, ORNITH_9B, QWEN_9B, type LocalModelConfig } from '../local-models/config.ts'
import type { LocalServerEntry } from '../local-models/servers.ts'
import type { LocalModelRunnerPorts } from './contract.ts'
import { createLocalModelRunner } from './model-runner.ts'

const KEY = 'a'.repeat(48)
const model = (id: string, port: number): LocalModelConfig => ({ id, port } as LocalModelConfig)
const entry = (id: string, port: number | null): LocalServerEntry => ({ model: id, label: id, pid: 1234, port, startedAt: null, startedByConductor: true })
const result = (content: string, usage?: CompletionResult['usage']): CompletionResult => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop', usage, stream: { events: 1, malformed: 0 } })
const request = { system: 'You summarise.', user: 'x'.repeat(400), maxTokens: 300 }

/** A virtual clock: sleep advances it, fires what is due, and yields a macrotask. */
function harness(overrides: Partial<LocalModelRunnerPorts> = {}) {
  let clock = 0
  const timers: Array<{ at: number; fire: () => void }> = []
  const at = (time: number, fire: () => void): void => { timers.push({ at: time, fire }) }
  const log = { starts: [] as string[], completes: [] as CompletionRequest[] }
  const ports: LocalModelRunnerPorts = {
    now: () => clock,
    sleep: async ms => {
      clock += ms
      for (const timer of timers.filter(t => t.at <= clock)) { timers.splice(timers.indexOf(timer), 1); timer.fire() }
      await new Promise(resolve => setImmediate(resolve))
    },
    servers: () => [],
    models: () => [model(ORNITH_9B, 51435), model(QWEN_9B, 51437), model(DOLPHIN_X1_8B, 51438)],
    apiKey: () => KEY,
    endpointOverride: () => null,
    healthy: async () => true,
    slotBusy: async () => false,
    interactiveBusy: () => false,
    start: async m => { log.starts.push(m.id); return { port: m.port } },
    complete: async req => { log.completes.push(req); return result('The build passed.') },
    ...overrides
  }
  return { ports, log, at, advance: (ms: number) => { clock += ms }, now: () => clock }
}

describe('local model runner', () => {
  it('uses the running server, whatever its model, and waits while it loads', async () => {
    let probes = 0
    const h = harness({ servers: () => [entry('local/other-model', 6001)], healthy: async () => ++probes > 2 })
    const outcome = await createLocalModelRunner(h.ports).ask(request)
    expect(outcome).toMatchObject({ ok: true, answer: { text: 'The build passed.', model: 'local/other-model' } })
    expect(h.log.starts).toEqual([])
    expect(h.log.completes[0]).toMatchObject({ endpoint: 'http://127.0.0.1:6001', apiKey: KEY, model: 'local/other-model', maxTokens: 300, temperature: 0.2, reasoningEffort: 'none' })
    expect(h.log.completes[0]!.messages).toEqual([{ role: 'system', content: request.system }, { role: 'user', content: request.user }])
    expect(h.now()).toBe(1000)
  })

  it('falls back when a running server is still loading at the end of the budget', async () => {
    const h = harness({ servers: () => [entry(QWEN_9B, 6001)], healthy: async () => false })
    const outcome = await createLocalModelRunner(h.ports).ask({ ...request, waitBudgetMs: 5000 })
    expect(outcome).toEqual({ ok: false, reason: `${QWEN_9B} was still loading after 5 s` })
  })

  it('starts the preferred model when none is running', async () => {
    const h = harness()
    const outcome = await createLocalModelRunner(h.ports).ask(request)
    expect(h.log.starts).toEqual([QWEN_9B])
    expect(outcome).toMatchObject({ ok: true, answer: { model: QWEN_9B } })
    expect(h.log.completes[0]!.endpoint).toBe('http://127.0.0.1:51437')
  })

  it('honours an explicit preference and falls back to any configured model', async () => {
    const h = harness({ models: () => [model('local/custom', 7000)] })
    await createLocalModelRunner(h.ports, { preferred: [DOLPHIN_X1_8B] }).ask(request)
    expect(h.log.starts).toEqual(['local/custom'])
  })

  it('does not start a server while an interactive local turn is running', async () => {
    const h = harness({ interactiveBusy: () => true })
    expect(await createLocalModelRunner(h.ports).ask(request)).toEqual({ ok: false, reason: 'another local turn needs the GPU' })
    expect(h.log.starts).toEqual([])
  })

  it('reports a missing configuration', async () => {
    const h = harness({ models: () => [] })
    expect(await createLocalModelRunner(h.ports).ask(request)).toEqual({ ok: false, reason: 'no local model is configured' })
  })

  it('falls back when the slot stays busy beyond the wait budget', async () => {
    const h = harness({ servers: () => [entry(QWEN_9B, 6001)], slotBusy: async () => true })
    expect(await createLocalModelRunner(h.ports).ask(request)).toEqual({ ok: false, reason: 'the local model was busy for 20 s' })
    expect(h.log.completes).toEqual([])
  })

  it('waits for a busy slot that frees within the budget', async () => {
    let polls = 0
    const h = harness({ servers: () => [entry(QWEN_9B, 6001)], slotBusy: async () => ++polls < 4 })
    expect((await createLocalModelRunner(h.ports).ask(request)).ok).toBe(true)
    expect(h.now()).toBe(1500)
  })

  it('keeps a start going past the budget and lets the next call join it', async () => {
    const h = harness()
    let running = false
    h.ports.servers = () => running ? [entry(QWEN_9B, 51437)] : []
    h.ports.start = m => { h.log.starts.push(m.id); return new Promise(resolve => h.at(3000, () => resolve({ port: m.port }))) }
    const runner = createLocalModelRunner(h.ports)
    expect(await runner.ask({ ...request, waitBudgetMs: 1000 })).toEqual({ ok: false, reason: `${QWEN_9B} is still starting (it keeps loading in the background)` })
    const second = await runner.ask(request)
    expect(second.ok).toBe(true)
    expect(h.log.starts).toEqual([QWEN_9B])
    running = true
    expect((await runner.ask(request)).ok).toBe(true)
    expect(h.log.starts).toEqual([QWEN_9B])
  })

  it('serialises concurrent calls: one start, one generation at a time', async () => {
    const h = harness()
    let running = false, active = 0, peak = 0
    h.ports.servers = () => running ? [entry(QWEN_9B, 51437)] : []
    h.ports.start = async m => { h.log.starts.push(m.id); await h.ports.sleep(2000); running = true; return { port: m.port } }
    h.ports.complete = async req => {
      active++; peak = Math.max(peak, active)
      await h.ports.sleep(1000)
      active--
      h.log.completes.push(req)
      return result(`answer ${h.log.completes.length}`)
    }
    const runner = createLocalModelRunner(h.ports)
    const outcomes = await Promise.all([runner.ask(request), runner.ask(request), runner.ask(request)])
    expect(outcomes.map(o => o.ok && o.answer.text)).toEqual(['answer 1', 'answer 2', 'answer 3'])
    expect(h.log.starts).toEqual([QWEN_9B])
    expect(peak).toBe(1)
  })

  it('a call queued behind a long one falls back when the queue outlasts its budget', async () => {
    const h = harness({ servers: () => [entry(QWEN_9B, 6001)] })
    h.ports.complete = async () => { await h.ports.sleep(30_000); return result('slow') }
    const runner = createLocalModelRunner(h.ports)
    const [first, second] = await Promise.all([runner.ask(request), runner.ask({ ...request, waitBudgetMs: 2000 })])
    expect(first.ok).toBe(true)
    expect(second).toEqual({ ok: false, reason: 'the local model was busy for 2 s' })
    // The abandoned waiter left the queue: the lock is free again.
    h.ports.complete = async () => result('quick')
    expect(await runner.ask(request)).toMatchObject({ ok: true, answer: { text: 'quick' } })
  })

  it('remembers a failed start for five minutes, never quoting the key', async () => {
    const h = harness({ start: async m => { h.log.starts.push(m.id); throw new Error(`llama-server exited (--api-key ${KEY})`) } })
    const runner = createLocalModelRunner(h.ports)
    const first = await runner.ask(request)
    expect(first.ok).toBe(false)
    const reason = (first as { reason: string }).reason
    expect(reason).toMatch(new RegExp(`^could not start ${QWEN_9B.replace('.', '\\.')}: llama-server exited`))
    expect(reason).not.toContain(KEY)
    expect(await runner.ask(request)).toEqual(first)
    expect(h.log.starts).toHaveLength(1)
    h.advance(5 * 60_000 + 1)
    await runner.ask(request)
    expect(h.log.starts).toHaveLength(2)
  })

  it('turns a generation error into a fallback without the key', async () => {
    const h = harness({ servers: () => [entry(QWEN_9B, 6001)], complete: async () => { throw new Error(`fetch failed Authorization: Bearer ${KEY}`) } })
    const outcome = await createLocalModelRunner(h.ports).ask(request)
    expect(outcome.ok).toBe(false)
    expect((outcome as { reason: string }).reason).toMatch(/^the local model failed: fetch failed/)
    expect(JSON.stringify(outcome)).not.toContain(KEY)
  })

  it('abandons a generation that outlives the timeout', async () => {
    const h = harness({
      servers: () => [entry(QWEN_9B, 6001)],
      complete: req => new Promise((_, reject) => req.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    expect(await createLocalModelRunner(h.ports, { generationTimeoutMs: 20 }).ask(request)).toEqual({ ok: false, reason: 'the local model did not answer within 1 s' })
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    const h = harness({
      servers: () => [entry(QWEN_9B, 6001)],
      complete: req => new Promise((_, reject) => { req.signal!.addEventListener('abort', () => reject(new Error('aborted'))); controller.abort() })
    })
    expect(await createLocalModelRunner(h.ports).ask({ ...request, signal: controller.signal })).toEqual({ ok: false, reason: 'the call was cancelled' })
  })

  it('strips a thinking block and falls back on an answer that is only thinking', async () => {
    const h = harness({ servers: () => [entry(QWEN_9B, 6001)], complete: async () => result('<think>\nlet me see\n</think>\n\n  3 tests failed.  ') })
    expect(await createLocalModelRunner(h.ports).ask(request)).toMatchObject({ ok: true, answer: { text: '3 tests failed.' } })
    h.ports.complete = async () => result('<think>still thinking when the budget ran out')
    expect(await createLocalModelRunner(h.ports).ask(request)).toEqual({ ok: false, reason: 'the local model returned an empty answer' })
    h.ports.complete = async () => result('   ')
    expect(await createLocalModelRunner(h.ports).ask(request)).toEqual({ ok: false, reason: 'the local model returned an empty answer' })
  })

  it('reports the server usage, or chars/4 estimates when it has none', async () => {
    const h = harness({ servers: () => [entry(QWEN_9B, 6001)], complete: async () => result('ok', { inputTokens: 812, outputTokens: 40 }) })
    expect(await createLocalModelRunner(h.ports).ask(request)).toMatchObject({ ok: true, answer: { inputTokens: 812, outputTokens: 40 } })
    h.ports.complete = async () => result('<think>abcd</think>' + 'y'.repeat(81))
    const estimated = await createLocalModelRunner(h.ports).ask(request)
    expect(estimated).toMatchObject({ ok: true, answer: { inputTokens: Math.ceil((request.system.length + request.user.length) / 4), outputTokens: Math.ceil(100 / 4) } })
  })

  it('uses an endpoint override directly, with no server logic', async () => {
    const h = harness({ endpointOverride: () => 'http://127.0.0.1:9999', servers: () => { throw new Error('not consulted') }, slotBusy: async () => true })
    expect(await createLocalModelRunner(h.ports).ask(request)).toMatchObject({ ok: true, answer: { model: QWEN_9B } })
    expect(h.log.completes[0]).toMatchObject({ endpoint: 'http://127.0.0.1:9999', model: QWEN_9B })
    expect(h.log.starts).toEqual([])
    h.ports.models = () => []
    await createLocalModelRunner(h.ports).ask(request)
    expect(h.log.completes[1]!.model).toBe('local')
  })
})
