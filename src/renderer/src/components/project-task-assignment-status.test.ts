import { describe, expect, it } from 'vitest'
import { assignmentStatus } from './project-task-assignment-status'

describe('project task assignment status', () => {
  it('explains what a queued assignment is waiting for instead of just saying Queued', () => {
    expect(assignmentStatus({ status: 'queued' }, false)).toContain('Queued in agent tab')
    expect(assignmentStatus({ status: 'queued' }, false)).toContain('turn already running there finishes')
  })
  it('reports the prompt as sent once the busy tab takes it', () => {
    expect(assignmentStatus({ status: 'queued' }, true)).toBe('Sent to agent tab')
    expect(assignmentStatus({ status: 'submitted' }, false)).toBe('Sent to agent tab')
  })
  it('keeps a failure and its reason visible, delivered or not', () => {
    expect(assignmentStatus({ status: 'failed', error: 'Provider unavailable' }, true)).toBe('Assignment failed: Provider unavailable')
    expect(assignmentStatus({ status: 'failed' }, false)).toBe('Assignment failed')
  })
})
