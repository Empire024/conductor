import { describe, expect, it, vi } from 'vitest'
import type { RuntimeProcessSummary } from '../../../shared/models'
import { aggregateProjectProcessUsage, createProcessSummaryPoller, processSummaryFreshness, projectTrackerLabel } from './ProcessStatusSummary'

const process = (overrides: Partial<RuntimeProcessSummary> & Pick<RuntimeProcessSummary, 'id' | 'projectId'>): RuntimeProcessSummary => ({
  sessionId: 'workspace-1',
  kind: 'agent',
  title: 'Agent',
  status: 'running',
  needsInput: false,
  progress: null,
  updatedAt: '2026-09-10T00:00:00.000Z',
  ...overrides
})

const projects = [{ id: 'project-a', name: 'Project A' }, { id: 'project-b', name: 'Project B' }]

describe('aggregateProjectProcessUsage', () => {
  it('groups running counts and usage totals by project', () => {
    const processes = [
      process({ id: 'agent-1', projectId: 'project-a', activityPhase: 'working' }),
      process({ id: 'agent-2', projectId: 'project-a', activityPhase: 'complete' }),
      process({ id: 'agent-3', projectId: 'project-b', activityPhase: 'idle' })
    ]
    const usage = new Map([
      ['agent-1', { costUsd: 0.5, totalTokens: 1200 }],
      ['agent-2', { costUsd: 0.25, totalTokens: 800 }]
    ])
    const totals = aggregateProjectProcessUsage(processes, projects, usage)
    expect(totals).toEqual([
      { projectId: 'project-a', projectName: 'Project A', processes: 2, running: 1, attention: 0, paused: 0, disconnected: 0, costUsd: 0.75, totalTokens: 2000, expensiveTitles: [] },
      { projectId: 'project-b', projectName: 'Project B', processes: 1, running: 0, attention: 0, paused: 0, disconnected: 0, costUsd: 0, totalTokens: 0, expensiveTitles: [] }
    ])
  })

  it('does not count a process awaiting input as running', () => {
    const processes = [process({ id: 'agent-1', projectId: 'project-a', activityPhase: 'working', needsInput: true })]
    expect(aggregateProjectProcessUsage(processes, projects, new Map())[0]).toMatchObject({ running: 0, attention: 1 })
  })

  it('does not describe a usage-limit pause as work in progress', () => {
    const processes = [process({ id: 'agent-1', projectId: 'project-a', status: 'limited', activityPhase: 'limited' })]
    expect(aggregateProjectProcessUsage(processes, projects, new Map())[0]).toMatchObject({ running: 0, paused: 1 })
  })

  it('tracks disconnected retained conversations separately from idle adapters', () => {
    const processes = [process({ id: 'agent-1', projectId: 'project-a', activityPhase: 'disconnected' })]
    expect(aggregateProjectProcessUsage(processes, projects, new Map())[0]).toMatchObject({ running: 0, disconnected: 1 })
  })

  it('counts a completed runtime with a disconnected native snapshot as offline', () => {
    const processes = [process({ id: 'agent-1', projectId: 'project-a', status: 'complete', activityPhase: 'complete' })]
    const usage = new Map([['agent-1', { snapshotPhase: 'disconnected' as const }]])
    expect(aggregateProjectProcessUsage(processes, projects, usage)[0]).toMatchObject({ running: 0, disconnected: 1 })
  })

  it('keeps real usage visible alongside a paused or idle state', () => {
    expect(projectTrackerLabel({ running: 0, attention: 0, paused: 1, disconnected: 0, totalTokens: 12_400 })).toBe('1 paused · 12k tok')
    expect(projectTrackerLabel({ running: 0, attention: 0, paused: 0, disconnected: 0, totalTokens: 800 })).toBe('idle · 800 tok')
  })

  it('marks a failed refresh as stale with its last observation and clears on recovery', () => {
    const failed = processSummaryFreshness(true, Date.parse('2026-09-12T12:00:00.000Z'))
    expect(failed).toMatchObject({ label: 'Stale' })
    expect(failed?.title).toContain('showing the last complete observation')
    expect(processSummaryFreshness(false, Date.parse('2026-09-12T12:00:04.000Z'))).toBeUndefined()
    expect(processSummaryFreshness(true, undefined)?.title).toContain('no complete observation')
  })

  it('keeps the last complete snapshot on failure and clears stale state after a successful retry', async () => {
    const read = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('fresh data')
    const commit = vi.fn()
    const setFailed = vi.fn()
    const poller = createProcessSummaryPoller(read, commit, setFailed, () => 42)
    await poller.run()
    expect(commit).not.toHaveBeenCalled()
    expect(setFailed).toHaveBeenLastCalledWith(true)
    await poller.run()
    expect(commit).toHaveBeenCalledWith('fresh data', 42)
    expect(setFailed).toHaveBeenLastCalledWith(false)
  })

  it('falls back to a placeholder name for a project no longer in the roster', () => {
    const processes = [process({ id: 'agent-1', projectId: 'project-missing' })]
    expect(aggregateProjectProcessUsage(processes, projects, new Map())[0]!.projectName).toBe('Unknown project')
  })

  it('orders the busiest and most expensive projects first', () => {
    const processes = [
      process({ id: 'agent-1', projectId: 'project-b' }),
      process({ id: 'agent-2', projectId: 'project-a', activityPhase: 'working' })
    ]
    const usage = new Map([['agent-1', { costUsd: 5, totalTokens: 0 }]])
    const totals = aggregateProjectProcessUsage(processes, projects, usage)
    expect(totals[0]!.projectId).toBe('project-a')
  })

  it('surfaces the highest warning level among a project\'s processes and names which tab(s)', () => {
    const processes = [
      process({ id: 'agent-1', projectId: 'project-a', title: 'Refactor pass' }),
      process({ id: 'agent-2', projectId: 'project-a', title: 'Docs pass' })
    ]
    const usage = new Map([
      ['agent-1', { costUsd: 1, totalTokens: 100, warning: 'approaching' as const }],
      ['agent-2', { costUsd: 6, totalTokens: 200, warning: 'high' as const }]
    ])
    const [entry] = aggregateProjectProcessUsage(processes, projects, usage)
    expect(entry).toMatchObject({ projectId: 'project-a', warning: 'high' })
    expect(entry!.expensiveTitles).toEqual(['Refactor pass', 'Docs pass'])
  })

  it('leaves a project without any expensive process unflagged', () => {
    const processes = [process({ id: 'agent-1', projectId: 'project-a' })]
    const usage = new Map([['agent-1', { costUsd: 0.1, totalTokens: 10 }]])
    const [entry] = aggregateProjectProcessUsage(processes, projects, usage)
    expect(entry!.warning).toBeUndefined()
    expect(entry!.expensiveTitles).toEqual([])
  })

  it('puts a flagged project first even when another project has a bigger raw spend', () => {
    const processes = [
      process({ id: 'agent-1', projectId: 'project-b' }),
      process({ id: 'agent-2', projectId: 'project-a' })
    ]
    const usage = new Map([
      ['agent-1', { costUsd: 50, totalTokens: 100_000 }],
      ['agent-2', { costUsd: 1, totalTokens: 100, warning: 'approaching' as const }]
    ])
    const totals = aggregateProjectProcessUsage(processes, projects, usage)
    expect(totals[0]!.projectId).toBe('project-a')
  })

  it('ranks a high warning ahead of a merely approaching one across projects', () => {
    const processes = [
      process({ id: 'agent-1', projectId: 'project-a' }),
      process({ id: 'agent-2', projectId: 'project-b' })
    ]
    const usage = new Map([
      ['agent-1', { costUsd: 1, totalTokens: 100, warning: 'approaching' as const }],
      ['agent-2', { costUsd: 1, totalTokens: 100, warning: 'high' as const }]
    ])
    const totals = aggregateProjectProcessUsage(processes, projects, usage)
    expect(totals[0]!.projectId).toBe('project-b')
  })
})
