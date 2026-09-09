import type { ProjectTaskDispatchAssignment } from '../../../shared/project-backlog'

/** "Queued" on its own reads as broken: it never says what the assignment is waiting for, and it
 *  never changes once the busy tab actually takes the prompt. */
export function assignmentStatus(assignment: Pick<ProjectTaskDispatchAssignment, 'status' | 'error'>, delivered: boolean): string {
  if (assignment.status === 'failed') return 'Assignment failed' + (assignment.error ? ': ' + assignment.error : '')
  if (assignment.status === 'submitted' || delivered) return 'Sent to agent tab' + (assignment.error ? ': ' + assignment.error : '')
  return 'Queued in agent tab. It is sent as soon as the turn already running there finishes.' + (assignment.error ? ' ' + assignment.error : '')
}
