import { describe, expect, it, vi } from 'vitest'
import type { RuntimeProcessSummary } from '../../../shared/models'
import type { Json, SessionProjection, TimelineItem } from '../../../shared/structured-agent'
import { createSerialPoller, currentTurnStartedAt, durationLabel, isProcessWorking, processTrackerState, reportedPlanProgress, selectProcessBoardProcesses, stuckBackgroundTask } from './ProcessDashboardPane.helpers'

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

describe('bounded cross-project process board', () => {
  it('keeps live and owner-attention work across projects, but does not hydrate old settled sessions on open', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z')
    const processes = [
      process({ id: 'old-live', projectId: 'project-a', activityPhase: 'working', updatedAt: '2026-09-01T00:00:00.000Z' }),
      process({ id: 'attention', projectId: 'project-b', status: 'waiting_input', needsInput: true, updatedAt: '2026-09-01T00:00:00.000Z' }),
      process({ id: 'recent-done', projectId: 'project-b', status: 'complete', activityPhase: 'complete', updatedAt: '2026-09-24T01:00:00.000Z' }),
      process({ id: 'old-done', projectId: 'project-a', status: 'complete', activityPhase: 'complete', updatedAt: '2026-08-20T00:00:00.000Z' })
    ]
    const initial = selectProcessBoardProcesses(processes, now)
    expect(initial.processes.map(row => row.id)).toEqual(['recent-done', 'old-live', 'attention'])
    expect(initial.hiddenOlder).toBe(1)
    expect(selectProcessBoardProcesses(processes, now, 25).processes.map(row => row.id)).toContain('old-done')
  })

  it('reveals older settled rows in bounded pages', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z')
    const processes = Array.from({ length: 60 }, (_, index) => process({
      id: `old-${index}`, status: 'complete', activityPhase: 'complete',
      updatedAt: new Date(Date.parse('2026-08-01T00:00:00.000Z') - index * 1000).toISOString()
    }))
    expect(selectProcessBoardProcesses(processes, now, 25)).toMatchObject({ hiddenOlder: 35 })
    expect(selectProcessBoardProcesses(processes, now, 25).processes).toHaveLength(25)
  })
})

describe('viewing on the Processes board', () => {
  it('shows a settled turn with running background tasks as viewing, not working or finished', () => {
    const base = { id: 'p', kind: 'agent', title: 'W13', projectId: 'project', sessionId: 'workspace', status: 'running', updatedAt: '2026-09-24T20:00:00.000Z' } as unknown as Parameters<typeof processTrackerState>[0]
    expect(processTrackerState({ ...base, activityPhase: 'waiting_background' })).toBe('viewing')
    // The snapshot knows before the persisted row does.
    expect(processTrackerState({ ...base, status: 'complete', activityPhase: 'complete' }, { phase: 'completed', backgroundTasks: 1 })).toBe('viewing')
    expect(processTrackerState({ ...base, status: 'complete', activityPhase: 'complete' }, { phase: 'completed', backgroundTasks: 0 })).toBe('finished')
    expect(isProcessWorking({ ...base, activityPhase: 'waiting_background' })).toBe(true)
  })
})

describe('settled conversations on the Processes board', () => {
  // The rows the owner saw as "Working" hours after they finished: the persisted runtime row still
  // said working (a detached subagent never reported its end), while the conversation's own
  // snapshot had long settled with no background task left.
  const stale = process({ status: 'running', activityPhase: 'working', updatedAt: '2026-09-24T21:10:59.177Z' })

  it('trusts a settled snapshot over a persisted working phase', () => {
    expect(processTrackerState(stale, { phase: 'completed', backgroundTasks: 0 })).toBe('finished')
    expect(processTrackerState(stale, { phase: 'failed', backgroundTasks: 0 })).toBe('finished')
    expect(processTrackerState(stale, { phase: 'interrupted' })).toBe('finished')
    expect(processTrackerState(stale, { phase: 'completed', backgroundTasks: 2 })).toBe('viewing')
    expect(isProcessWorking(stale, { phase: 'completed' })).toBe(false)
  })

  it('still reports a running snapshot as working and an unknown count from the persisted phase', () => {
    expect(processTrackerState(process({ status: 'complete', activityPhase: 'complete' }), { phase: 'running' })).toBe('working')
    expect(processTrackerState(process({ activityPhase: 'waiting_background' }), { phase: 'completed' })).toBe('viewing')
    expect(processTrackerState(process({ activityPhase: 'waiting_background' }), { phase: 'completed', backgroundTasks: 0 })).toBe('finished')
    expect(processTrackerState(process(), { phase: 'idle', backgroundTasks: 0 })).toBe('ready')
  })

  it('flags a background task that outlived its expected runtime', () => {
    const now = Date.parse('2026-09-25T10:00:00.000Z')
    const shell = (timestamp: string, input?: Json) =>
      item(1, { type: 'tool', name: 'Bash', status: 'running', detached: true, ...(input ? { input } : {}) }, { timestamp })
    const settled = (items: TimelineItem[]) => ({ ...snapshot(items, 'completed'), backgroundTasks: 1 })
    expect(stuckBackgroundTask(settled([shell('2026-09-25T09:45:00.000Z')]), now)).toBeUndefined()
    expect(stuckBackgroundTask(settled([shell('2026-09-25T05:00:00.000Z')]), now)).toBe('background task stuck 5h 0m')
    // Its own declared timeout replaces the 30-minute default.
    expect(stuckBackgroundTask(settled([shell('2026-09-25T09:45:00.000Z', { command: 'node smoke.mjs', timeout: 600_000 })]), now)).toBe('background task stuck 15m 0s')
    // A count without a started row falls back to when the conversation last changed.
    expect(stuckBackgroundTask(settled([]), now, '2026-09-25T08:00:00.000Z')).toBe('background task stuck 2h 0m')
    expect(stuckBackgroundTask({ ...settled([shell('2026-09-25T05:00:00.000Z')]), backgroundTasks: 0 }, now)).toBeUndefined()
  })

  it('ages a Claude background Bash whose row already reads completed against its declared timeout (VR1 B1-declared)', () => {
    const now = Date.parse('2026-09-25T10:00:00.000Z')
    const lifecycle = (sequence: number, payload: Json) => item(sequence, { type: 'notice', message: 'Claude task lifecycle', payload })
    // The "running in background" tool_result marks the row completed; the shell runs on.
    const bash = item(1, { type: 'tool', name: 'Bash', status: 'completed', detached: true, input: { command: 'node render.mjs', run_in_background: true, timeout: 5000 } }, { nativeItemId: 'bash-1', timestamp: '2026-09-25T09:59:50.000Z' })
    const started = lifecycle(2, { type: 'system', subtype: 'task_started', task_id: 'task-bash-1', tool_use_id: 'bash-1', is_backgrounded: true, task_type: 'local_bash', status: 'running' })
    const settled = (items: TimelineItem[]) => ({ ...snapshot(items, 'completed'), backgroundTasks: 1 })
    expect(stuckBackgroundTask(settled([bash, started]), now)).toBe('background task stuck 10s')
    expect(stuckBackgroundTask(settled([bash, started]), Date.parse('2026-09-25T09:59:54.000Z'))).toBeUndefined()
    // Once the task reports, the row is finished work, not a stuck one.
    const reported = lifecycle(3, { type: 'system', subtype: 'task_notification', task_id: 'task-bash-1', tool_use_id: 'bash-1', status: 'completed' })
    expect(stuckBackgroundTask(settled([bash, started, reported]), now)).toBeUndefined()
    // A foreground Bash that merely completed is never counted.
    const foreground = lifecycle(2, { type: 'system', subtype: 'task_started', task_id: 'check', tool_use_id: 'bash-1', is_backgrounded: false, task_type: 'local_bash' })
    expect(stuckBackgroundTask(settled([bash, foreground]), now)).toBeUndefined()
  })
})
