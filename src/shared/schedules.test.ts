import { describe, expect, it } from 'vitest'
import { dueNow, nextDue, type ScheduleDefinition } from './schedules'

const schedule = (patch: Partial<ScheduleDefinition> = {}): ScheduleDefinition => ({
  id: 'schedule-one', projectId: 'project-one', name: 'Latest models and methods', jobId: 'latest-models-methods',
  enabled: true, everyMinutes: 60, catchUp: 'collapse', timeoutMs: 120_000, lastRunAt: null,
  nextDueAt: '2026-09-21T10:00:00.000Z', createdAt: '2026-09-21T09:00:00.000Z', updatedAt: '2026-09-21T09:00:00.000Z', ...patch
})

describe('schedule timing', () => {
  it('collapses a three-hour outage into one future window', () => {
    const item = schedule()
    const now = new Date('2026-09-21T13:12:00.000Z')
    expect(dueNow([item], now)).toEqual([item])
    expect(nextDue(item, now)).toBe('2026-09-21T14:00:00.000Z')
  })

  it('does not make disabled schedules due', () => {
    const item = schedule({ enabled: false })
    expect(dueNow([item], new Date('2026-09-21T13:00:00.000Z'))).toEqual([])
    expect(nextDue(item, new Date())).toBeNull()
  })
})
