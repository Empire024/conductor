import { describe, expect, it } from 'vitest'
import { CloseConfirmation, hasRunningWork } from './close-confirmation'
import { emptyProjection } from '../shared/structured-agent-reducer'
import type { RuntimeProcessSummary } from '../shared/models'

const process: RuntimeProcessSummary = { id: 'agent', projectId: 'other-project', sessionId: 'other-workspace', kind: 'agent', title: 'Worker', status: 'running', activityPhase: 'idle', needsInput: false, progress: null, updatedAt: '' }
describe('close confirmation', () => {
  it('ignores idle process instances and metadata connections', () => {
    expect(hasRunningWork(process)).toBe(false)
    expect(hasRunningWork(process, { ...emptyProjection('agent'), phase: 'starting' })).toBe(false)
    expect(hasRunningWork(process, { ...emptyProjection('agent'), phase: 'starting', items: [{ id: 'old', runtimeId: 'old', sequence: 1, timestamp: '2026-09-01T00:00:00Z', data: { type: 'text', role: 'user', text: 'historical prompt', mode: 'snapshot' } }] })).toBe(false)
    expect(hasRunningWork({ ...process, kind: 'terminal' })).toBe(false)
  })
  it.each(['running', 'waiting_approval', 'waiting_input', 'interrupting'] as const)('protects %s in any project/workspace', phase => {
    expect(hasRunningWork(process, { ...emptyProjection('agent'), phase })).toBe(true)
  })
  it('protects queued prompts and scheduled continuation without treating stale task labels as execution', () => {
    expect(hasRunningWork(process, { ...emptyProjection('agent'), queued: { id: 'q', text: 'next', settings: { permission: 'default', plan: false }, attachments: [] } })).toBe(true)
    expect(hasRunningWork({ ...process, resumeAt: '2026-09-12T15:00:00Z' })).toBe(true)
  })
  it('protects provider-confirmed detached shell work after its parent turn completes', () => {
    const item = { id: 'shell', runtimeId: 'runtime', sequence: 1, timestamp: '2026-09-12T15:00:00Z', data: { type: 'tool' as const, name: 'Bash', detached: true, status: 'running' as const } }
    expect(hasRunningWork(process, { ...emptyProjection('agent'), phase: 'completed', items: [item] })).toBe(true)
    expect(hasRunningWork(process, { ...emptyProjection('agent'), phase: 'completed', items: [{ ...item, data: { ...item.data, status: 'completed' as const } }] })).toBe(false)
    expect(hasRunningWork(process, { ...emptyProjection('agent'), phase: 'completed', items: [{ ...item, data: { ...item.data, detached: false } }] })).toBe(false)
  })
  it('shares one pending decision and cancellation allows a fresh request', async () => {
    const guard = new CloseConfirmation()
    let answer!: (value: boolean) => void
    let calls = 0
    const decide = () => { calls++; return new Promise<boolean>(resolve => { answer = resolve }) }
    const one = guard.request(decide), two = guard.request(decide)
    await Promise.resolve()
    expect(calls).toBe(1)
    answer(false)
    expect(await one).toBe(false); expect(await two).toBe(false)
    expect(await guard.request(async () => true)).toBe(true)
  })
})
