import { describe, expect, it } from 'vitest'
import { displayActivityStatus, displaySessionPhase, foldActivityStatuses, isViewing, VIEWING_LABEL, viewingDescription } from './project-activity'

describe('viewing: a settled turn whose background tasks still run', () => {
  it('is derived only for a settled phase with background tasks outstanding', () => {
    for (const phase of ['completed', 'idle', 'complete', 'waiting_background']) expect(isViewing(phase, 1)).toBe(true)
    for (const phase of ['running', 'waiting_approval', 'failed', 'interrupted', 'disconnected']) expect(isViewing(phase, 2)).toBe(false)
    expect(isViewing('completed', 0)).toBe(false)
    expect(isViewing('completed', undefined)).toBe(false)
    expect(displaySessionPhase('completed', 1)).toBe('viewing')
    expect(displaySessionPhase('completed', 0)).toBe('completed')
    expect(displaySessionPhase('running', 3)).toBe('running')
  })

  it('is worded with the task count when it is known', () => {
    expect(VIEWING_LABEL).toBe('Viewing')
    expect(viewingDescription(1)).toBe('Turn ended; 1 background task still running; the agent continues when they finish')
    expect(viewingDescription(2)).toContain('2 background tasks still running')
    expect(viewingDescription()).toBe('Turn ended; background tasks still running; the agent continues when they finish')
  })

  it('rolls up like working: above a lost connection and above done', () => {
    // The main and renderer roll-ups map the viewing activity phase to 'working'.
    expect(displayActivityStatus(foldActivityStatuses(['done', 'working']))).toBe('working')
    expect(displayActivityStatus(foldActivityStatuses(['stalled', 'working']))).toBe('working')
  })
})
