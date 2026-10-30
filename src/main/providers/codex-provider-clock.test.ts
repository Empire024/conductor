import { afterEach, describe, expect, it } from 'vitest'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE, unionMs } from './codex'
import type { TransportOptions } from './transport'
import type { Json, SessionSettings } from '../../shared/structured-agent'
import { maskSecrets } from '../structured-store'
import { ToolTimingRecorder } from '../tool-timings'

/**
 * Codex provider-clock timing (docs/perf-evidence/t3code-provider-clock-timings.md): the real
 * CodexAdapter on an in-memory App Server wire, its events fed to the recorder exactly as
 * StructuredSessions' observer does. The host clock is the recorder's; provider stamps are only
 * what the frames carry.
 */
const cleanup: Array<() => void> = []
afterEach(() => { for (const step of cleanup.splice(0)) step() })

const THREAD = 'wired-thread', TURN = 'wired-turn'
const settings: SessionSettings = { permission: 'default', plan: false }

function wired() {
  const clock = { mono: 1_000 }
  const recorder = new ToolTimingRecorder({ now: () => clock.mono, mask: maskSecrets })
  let wire!: TransportOptions, connected = false, n = 0
  const inject = (message: unknown) => wire.onMessage(JSON.parse(JSON.stringify(message)) as Json)
  const adapter = new CodexAdapter({
    executable: 'never-launched', cwd: process.cwd(), runtimeId: 'wired-runtime', settings,
    emit: event => recorder.observe({ ...event, id: `e${++n}`, sessionId: 'wired-session', runtimeId: 'wired-runtime', provider: 'codex', projectId: 'p1', timestamp: new Date().toISOString() }, 'codex-synthetic')
  }, {
    version: async () => `codex-cli ${CODEX_PROTOCOL_BASELINE}`,
    transport: options => {
      wire = options
      return {
        start: () => { connected = true }, close: () => { connected = false }, get connected() { return connected },
        send: message => {
          const packet = message as { id?: number; method?: string }
          if (!packet.method) return
          const result = packet.method === 'initialize' ? { userAgent: 'synthetic' }
            : packet.method === 'thread/start' ? { thread: { id: THREAD, status: { type: 'idle' }, turns: [] }, model: 'synthetic-model', reasoningEffort: 'low', modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, cwd: process.cwd() }
              : packet.method === 'model/list' ? { data: [] }
                : packet.method === 'turn/start' ? { turn: { id: TURN, status: 'inProgress', items: [] } } : undefined
          if (result) queueMicrotask(() => inject({ id: packet.id, result }))
        }
      }
    }
  })
  cleanup.push(() => adapter.dispose())
  const command = (id: string, status: 'inProgress' | 'completed' | 'failed', extra: Record<string, unknown> = {}) => ({
    type: 'commandExecution', id, command: 'npm test', cwd: process.cwd(), processId: status === 'inProgress' ? 'pid-1' : null, status, commandActions: [],
    aggregatedOutput: status === 'inProgress' ? null : 'ok', exitCode: status === 'inProgress' ? null : status === 'failed' ? 1 : 0, durationMs: status === 'inProgress' ? null : 2_900, ...extra
  })
  const started = (item: unknown, stamp?: unknown) => inject({ method: 'item/started', params: { item, threadId: THREAD, turnId: TURN, ...(stamp !== undefined ? { startedAtMs: stamp } : {}) } })
  const completed = (item: unknown, stamp?: unknown) => inject({ method: 'item/completed', params: { item, threadId: THREAD, turnId: TURN, ...(stamp !== undefined ? { completedAtMs: stamp } : {}) } })
  const review = (reviewId: string, targetItemId: string | null, startedAtMs: unknown, completedAtMs?: unknown) => inject({
    method: completedAtMs === undefined ? 'item/autoApprovalReview/started' : 'item/autoApprovalReview/completed',
    params: { threadId: THREAD, turnId: TURN, reviewId, targetItemId, startedAtMs, ...(completedAtMs !== undefined ? { completedAtMs, decisionSource: 'agent' } : {}),
      review: { status: 'approved', riskLevel: 'low', userAuthorization: null, rationale: 'synthetic' }, action: { type: 'command', command: 'npm test', cwd: process.cwd() } }
  })
  const records = () => recorder.report({ recent: 100, includeDetached: true }).recent.slice().reverse()
  const reviewsHeld = () => (adapter as unknown as { reviews: Map<string, Map<string, unknown>> }).reviews
  return { adapter, recorder, clock, inject, command, started, completed, review, records, reviewsHeld, start: () => adapter.submit('go', settings) }
}

describe('Codex provider-clock tool timings, CodexAdapter → recorder', () => {
  it('times elapsed on the provider clock (1000 → 4000) however fast the frames reached the host', async () => {
    const f = wired(); await f.start()
    f.started(f.command('c1', 'inProgress'), 1_000)
    f.clock.mono += 10
    f.completed(f.command('c1', 'completed'), 4_000)
    const [record] = f.records()
    expect(record).toMatchObject({ itemId: 'c1', elapsedMs: 3_000, elapsedSource: 'provider', execMs: 2_900, execSource: 'provider', waitMs: null, waitSource: 'unavailable', outcome: 'completed' })
    expect(record!.reviewMs).toBeUndefined()
    expect(f.recorder.report({}).coverage.providers[0]).toMatchObject({ provider: 'codex', elapsedFromProvider: 1, review: 0 })
  })

  it('keeps the host-observed elapsed when an older server sends no stamps, or only one of them', async () => {
    const f = wired(); await f.start()
    f.started(f.command('old', 'inProgress'))
    f.clock.mono += 25
    f.completed(f.command('old', 'completed'))
    f.started(f.command('half', 'inProgress'))
    f.clock.mono += 40
    f.completed(f.command('half', 'completed'), 9_000)
    const [old, half] = f.records()
    expect(old).toMatchObject({ elapsedMs: 25, elapsedSource: 'host-monotonic', execMs: 2_900 })
    expect(half).toMatchObject({ elapsedMs: 40, elapsedSource: 'host-monotonic' })
    expect(old!.notes).toBeUndefined()
    expect(half!.notes).toBeUndefined()
  })

  it('never infers a start from a completion-only frame', async () => {
    const f = wired(); await f.start()
    f.completed(f.command('late', 'completed'), 4_000)
    expect(f.records()[0]).toMatchObject({ startedAt: null, elapsedMs: null, elapsedSource: 'unavailable', execMs: 2_900, execSource: 'provider' })
  })

  it('counts a call once however often its start and end are restated, and the first start stamp stands', async () => {
    const f = wired(); await f.start()
    f.started(f.command('dup', 'inProgress'), 1_000)
    f.started(f.command('dup', 'inProgress'), 1_500)
    f.completed(f.command('dup', 'completed'), 4_000)
    f.completed(f.command('dup', 'completed'), 9_999)
    // turn/completed restates its items as authoritative snapshots.
    f.inject({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: TURN, status: 'completed', items: [f.command('dup', 'completed')], error: null } } })
    const report = f.recorder.report({ recent: 10 })
    expect(report.totals.calls).toBe(1)
    expect(report.recent[0]).toMatchObject({ elapsedMs: 3_000, elapsedSource: 'provider', restated: 2 })
    expect(report.tools[0]!.elapsed).toMatchObject({ measured: 1, totalMs: 3_000 })
  })

  it('does not trust reversed, negative or non-numeric stamps: noted, and the host time stays', async () => {
    const f = wired(); await f.start()
    f.started(f.command('reversed', 'inProgress'), 5_000)
    f.clock.mono += 30
    f.completed(f.command('reversed', 'completed'), 4_000)
    f.started(f.command('negative', 'inProgress'), -1_000)
    f.clock.mono += 31
    f.completed(f.command('negative', 'completed'), 4_000)
    f.started(f.command('text', 'inProgress'), '1000')
    f.clock.mono += 32
    f.completed(f.command('text', 'completed'), '4000')
    f.started(f.command('far', 'inProgress'), 0)
    f.clock.mono += 33
    f.completed(f.command('far', 'completed'), 30 * 24 * 3_600_000)
    const [reversed, negative, text, far] = f.records()
    expect(reversed).toMatchObject({ elapsedMs: 30, elapsedSource: 'host-monotonic', notes: ['invalid-provider-interval'] })
    expect(negative).toMatchObject({ elapsedMs: 31, elapsedSource: 'host-monotonic', notes: ['invalid-provider-interval'] })
    // A stamp that is not a number is not a stamp: nothing to note, nothing used.
    expect(text).toMatchObject({ elapsedMs: 32, elapsedSource: 'host-monotonic' })
    expect(text!.notes).toBeUndefined()
    expect(far).toMatchObject({ elapsedMs: 33, elapsedSource: 'host-monotonic', notes: ['invalid-provider-interval'] })
  })

  it('keeps human approval wait host-observed and the provider auto-review apart from it', async () => {
    const f = wired(); await f.start()
    f.inject({ id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'ask', startedAtMs: 500, reason: 'synthetic', command: 'npm test', cwd: process.cwd(), availableDecisions: ['accept', 'decline'] } })
    f.review('r1', 'ask', 100, 600)
    f.clock.mono += 8_000
    f.started(f.command('ask', 'inProgress'), 9_000)
    f.clock.mono += 5
    f.completed(f.command('ask', 'completed'), 12_000)
    const [record] = f.records()
    expect(record).toMatchObject({ waitMs: 8_000, waitSource: 'observed-approval', reviewMs: 500, reviewSource: 'provider-review', elapsedMs: 3_000, elapsedSource: 'provider' })
    const report = f.recorder.report({})
    expect(report.tools[0]!.wait).toMatchObject({ measured: 1, totalMs: 8_000 })
    expect(report.tools[0]!.review).toMatchObject({ measured: 1, totalMs: 500 })
    expect(report.coverage.review).toBe(1)
  })

  it('counts each review once: repeated, reordered and overlapping reviews of one item', async () => {
    const f = wired(); await f.start()
    f.started(f.command('rev', 'inProgress'), 0)
    // Completion before its own start notification, a duplicate, and an overlap of 1000.
    f.review('a', 'rev', 1_000, 3_000)
    f.review('a', 'rev', 1_000)
    f.review('a', 'rev', 1_000, 3_000)
    f.review('b', 'rev', 2_000, 4_000)
    f.review('c', 'rev', 10_000, 10_500)
    f.completed(f.command('rev', 'completed'), 20_000)
    expect(f.records()[0]).toMatchObject({ reviewMs: 3_500, reviewSource: 'provider-review' })
    expect(f.reviewsHeld().size).toBe(0)
  })

  it('attributes no review to any tool without a well-formed target, and none after its item ended', async () => {
    const f = wired(); await f.start()
    f.started(f.command('t', 'inProgress'), 0)
    f.review('network', null, 0, 5_000)
    f.review('bad-interval', 't', 5_000, 4_000)
    f.review('negative', 't', -10, 50)
    f.review('', 't', 0, 50)
    f.review('other', 'another-item', 0, 50)
    f.completed(f.command('t', 'completed'), 1_000)
    f.review('late', 't', 0, 50)
    const [record] = f.records()
    expect(record!.reviewMs).toBeUndefined()
    expect(record!.reviewSource).toBeUndefined()
    // Only the review of an item that has not completed is held, and only until that item ends.
    expect([...f.reviewsHeld().keys()].map(key => JSON.parse(key)[2])).toEqual(['another-item'])
  })

  it('bounds what it holds: 16 reviews per item, 512 reviewed items', async () => {
    const f = wired(); await f.start()
    f.started(f.command('many', 'inProgress'), 0)
    for (let i = 0; i < 20; i++) f.review(`r${i}`, 'many', i * 100, i * 100 + 10)
    f.completed(f.command('many', 'completed'), 5_000)
    expect(f.records()[0]).toMatchObject({ reviewMs: 160 })
    for (let i = 0; i < 600; i++) f.review(`x${i}`, `pending-${i}`, 0, 1)
    expect(f.reviewsHeld().size).toBe(512)
    expect(unionMs([[0, 10], [5, 20], [30, 40], [35, 36]])).toBe(30)
  })

  it('still masks secrets in the summary and stores no output', async () => {
    const f = wired(); await f.start()
    const secret = 'ghp_' + 'a'.repeat(36)
    f.started(f.command('s', 'inProgress', { command: `git push https://user:${secret}@example.com --token ${secret}` }), 1_000)
    f.completed(f.command('s', 'failed', { command: `git push https://user:${secret}@example.com --token ${secret}`, aggregatedOutput: 'y'.repeat(5_000) + `\nfatal: denied ${secret}\n` }), 2_000)
    f.started(f.command('ok', 'inProgress'), 1_000)
    f.completed(f.command('ok', 'completed', { aggregatedOutput: 'SUCCESSFUL-OUTPUT-BODY' }), 1_200)
    const [failed, ok] = f.records()
    expect(failed).toMatchObject({ outcome: 'failed', elapsedMs: 1_000, elapsedSource: 'provider' })
    expect(failed!.error).toContain('[REDACTED]')
    expect(failed!.error!.length).toBeLessThanOrEqual(161)
    expect(ok).toMatchObject({ outcome: 'completed', elapsedMs: 200, elapsedSource: 'provider' })
    expect(ok!.error).toBeUndefined()
    // Only a failure's first line, masked and bounded, is kept: never the output itself.
    const serialized = JSON.stringify(f.recorder.report({ recent: 10 }))
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('y'.repeat(200))
    expect(serialized).not.toContain('SUCCESSFUL-OUTPUT-BODY')
  })
})
