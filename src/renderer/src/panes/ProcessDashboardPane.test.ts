import { describe, expect, it, vi } from 'vitest'
import type { RuntimeProcessSummary } from '../../../shared/models'
import type { SessionProjection, TimelineItem } from '../../../shared/structured-agent'
import { createSerialPoller, currentTurnStartedAt, durationLabel, processTrackerState, reportedPlanProgress } from './ProcessDashboardPane.helpers'

const process = (overrides: Partial<RuntimeProcessSummary> = {}): RuntimeProcessSummary => ({
  id: 'agent-1', projectId: 'project-1', sessionId: 'workspace-1', kind: 'agent', title: 'Agent',
  status: 'running', activityPhase: 'idle', needsInput: false, progress: null,
  updatedAt: '2026-09-12T12:00:00.000Z', ...overrides
})
const item = (sequence: number, data: TimelineItem['data'], overrides: Partial<TimelineItem> = {}): TimelineItem => ({
  id: String(sequence), runtimeId: 'runtime-1', sequence, timestamp: `2026-09-12T12:00:0${sequence}.000Z`, data, ...overrides
})
const snapshot = (items: TimelineItem[], phase: SessionProjection['phase'] = 'running'): SessionProjection => ({
  sessionId: 'agent-1', runtimeId: 'runtime-1', phase, sequence: 1, items, settings: { permission: 'default', plan: false }, title: 'Agent', archived: false, truncated: false
})

describe('process tracker facts', () => {
  it('does not equate a connected idle adapter or a usage-limit pause with working', () => {
    expect(processTrackerState(process())).toBe('ready')
    expect(processTrackerState(process({ status: 'limited', activityPhase: 'limited' }))).toBe('paused')
    expect(processTrackerState(process({ status: 'limited', activityPhase: 'working' }))).toBe('paused')
    expect(processTrackerState(process({ activityPhase: 'working' }))).toBe('working')
  })

  it('keeps user input and disconnected histories distinct from finished work', () => {
    expect(processTrackerState(process({ needsInput: true, activityPhase: 'working' }))).toBe('attention')
    expect(processTrackerState(process({ status: 'starting', activityPhase: 'disconnected' }))).toBe('disconnected')
    expect(processTrackerState(process({ status: 'complete', activityPhase: 'working' }))).toBe('finished')
  })

  it('uses a disconnected native snapshot as connection truth while retaining completed execution history', () => {
    const completed = process({ status: 'complete', activityPhase: 'complete' })
    const retained = { ...snapshot([], 'disconnected'), nativeSessionId: 'native-conversation-1' }
    expect(processTrackerState(completed)).toBe('finished')
    expect(processTrackerState(completed, retained)).toBe('disconnected')
  })

  it('reports only a provider plan count and the real current-turn timestamp', () => {
    const state = snapshot([
      item(1, { type: 'text', role: 'user', text: 'Go', mode: 'snapshot' }),
      item(2, { type: 'plan', steps: [{ text: 'One', status: 'completed' }, { text: 'Two', status: 'in_progress' }, { text: 'Three', status: 'pending' }] })
    ])
    expect(reportedPlanProgress(state)).toEqual({ completed: 1, total: 3, label: '1/3 steps' })
    expect(currentTurnStartedAt(state)).toBe('2026-09-12T12:00:01.000Z')
    expect(durationLabel('2026-09-12T12:00:01.000Z', Date.parse('2026-09-12T12:02:06.000Z'))).toBe('2m 5s')
    expect(reportedPlanProgress(snapshot([], 'idle'))).toBeUndefined()
  })
})

describe('serial process polling', () => {
  it('does not overlap reads or commit after disposal', async () => {
    let resolve!: (value: number) => void
    const read = vi.fn(() => new Promise<number>(done => { resolve = done }))
    const commit = vi.fn()
    const poller = createSerialPoller(read, commit)
    const first = poller.run()
    const overlapping = poller.run()
    expect(read).toHaveBeenCalledTimes(1)
    expect(overlapping).toBe(first)
    resolve(1); await first
    expect(commit).toHaveBeenCalledWith(1)
    const second = poller.run()
    poller.dispose(); resolve(2); await second
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
