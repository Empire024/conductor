import { describe, expect, it, vi } from 'vitest'
import type { SessionProjection, SessionSettings, TimelineItem } from '../shared/structured-agent'
import { boundedSettings, runScheduledAgentTurn, type AgentTurnDeps } from './schedule-agent-turn'

type Step = (state: SessionProjection) => void
const item = (sequence: number, data: TimelineItem['data']): TimelineItem => ({ id: `item-${sequence}`, sequence, timestamp: '2026-09-24T01:00:00.000Z', data } as TimelineItem)

/** A structured store with one conversation whose phase and timeline the test scripts poll by poll. */
const harness = (script: Step[]) => {
  let state: SessionProjection | null = null
  let clock = 0
  const polls: Step[] = [...script]
  const sessions = {
    ensure: vi.fn((spec: { id: string }) => {
      state = { sessionId: spec.id, runtimeId: 'runtime-1', phase: 'idle', sequence: 3, items: [], settings: { permission: 'auto', plan: false, browserMcp: true }, title: 'x', archived: false, truncated: false }
      return { available: true }
    }),
    submit: vi.fn(async () => { state!.phase = 'running'; state!.sequence += 1 }),
    respond: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => { state!.phase = 'interrupted' }),
    archive: vi.fn(async () => undefined)
  }
  const deps: AgentTurnDeps = {
    sessions,
    database: {
      structured: {
        snapshot: () => state,
        update: (_id: string, values: { settings?: SessionSettings }) => { if (values.settings) state!.settings = values.settings }
      },
      getProject: id => ({ id, name: 'Project', path: 'C:/project' } as never),
      listSessions: () => [{ id: 'workspace-1' } as never],
      createSession: () => { throw new Error('not expected') }
    },
    sleep: async ms => { clock += ms; polls.shift()?.(state!) },
    now: () => clock,
    pollMs: 1_000
  }
  return { deps, sessions, state: () => state! }
}
const request = (patch = {}) => ({ projectId: 'project-1', agent: { provider: 'claude' as const, model: 'opus' }, title: 'Scheduled: Watch', prompt: 'What changed?', timeoutMs: 10_000, signal: new AbortController().signal, ...patch })

describe('scheduled agent turn', () => {
  it('opens a bounded conversation, waits for the turn, keeps the answer, and archives it', async () => {
    const h = harness([state => { state.items.push(item(5, { type: 'text', role: 'assistant', text: 'Bump the pin.' } as never)); state.phase = 'completed'; state.sequence = 6 }])
    const result = await runScheduledAgentTurn(h.deps, request())
    expect(result).toMatchObject({ ok: true, answer: 'Bump the pin.' })
    expect(h.state().settings).toMatchObject({ permission: 'default', browserMcp: false, plan: false, model: 'opus' })
    expect(h.sessions.submit).toHaveBeenCalledWith(result.agentSessionId, 'What changed?', expect.objectContaining({ permission: 'default' }), [], expect.objectContaining({ label: 'Scheduled task' }))
    expect(h.sessions.archive).toHaveBeenCalledWith(result.agentSessionId, true)
  })

  it('denies tool approvals and stops a turn that keeps asking', async () => {
    const pending = (sequence: number) => item(sequence, { type: 'interaction', interaction: { id: `request-${sequence}`, kind: 'approval', title: 'WebFetch', input: {}, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }], status: 'pending' } } as never)
    const h = harness([
      state => { state.items.push(pending(5)) },
      state => { (state.items[0]!.data as { interaction: { status: string } }).interaction.status = 'resolved'; state.items.push(item(6, { type: 'text', role: 'assistant', text: 'From the evidence: nothing to do.' } as never)); state.phase = 'completed'; state.sequence = 7 }
    ])
    const result = await runScheduledAgentTurn(h.deps, request())
    expect(h.sessions.respond).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request-5', decision: 'deny', runtimeId: 'runtime-1' }))
    expect(result).toMatchObject({ ok: true, answer: 'From the evidence: nothing to do.' })

    const stubborn = harness(Array.from({ length: 6 }, (_, index) => (state: SessionProjection) => { state.items.push(pending(10 + index)) }))
    const stopped = await runScheduledAgentTurn(stubborn.deps, request())
    expect(stubborn.sessions.interrupt).toHaveBeenCalled()
    expect(stopped).toMatchObject({ ok: false, note: expect.stringContaining('cannot give') })
  })

  it('interrupts a turn that outlives its time', async () => {
    const h = harness([])
    const result = await runScheduledAgentTurn(h.deps, request({ timeoutMs: 3_000 }))
    expect(h.sessions.interrupt).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: false, note: expect.stringContaining('did not answer within') })
  })

  it('maps each provider to its least-writing mode', () => {
    const base: SessionSettings = { permission: 'auto', plan: false, browserMcp: true, temporaryPermission: { runtimeId: 'r', restore: 'auto' } }
    expect(boundedSettings(base, { provider: 'codex', model: 'gpt-6-astra', effort: 'low' }, false)).toMatchObject({ permission: 'read-only', sandbox: 'read-only', browserMcp: false, effort: 'low' })
    expect(boundedSettings(base, { provider: 'local', model: 'local/qwen' }, true)).toMatchObject({ permission: 'read-only', localGit: false, localResearch: true })
    expect(boundedSettings(base, { provider: 'claude', model: 'opus' }, false)).not.toHaveProperty('temporaryPermission')
  })
})
