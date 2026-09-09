import { describe, expect, it } from 'vitest'
import { projectTaskPrompt } from './project-task-dispatch'
import type { ProjectTask } from '../shared/project-backlog'

const task = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: 'task-1', title: 'Dragging tabs is fully broken', kind: 'bug', status: 'todo', priority: 'high', line: 1, activity: [], ...over
} as ProjectTask)

describe('the Auto Fixer brief', () => {
  const fixer = projectTaskPrompt([task()], true)

  it('names the selected tasks and their exact ids for both modes', () => {
    expect(fixer).toContain('task-1')
    expect(fixer).toContain('Dragging tabs is fully broken')
    expect(projectTaskPrompt([task()], false)).toContain('task-1')
  })

  // Each of these is a rule the owner paid for once already: a git checkout that would have
  // wiped concurrent uncommitted work, and agents reporting a task done that nobody had
  // actually looked at.
  it('forbids the coworker behaviours that have hurt the owner before', () => {
    expect(fixer).toMatch(/steals the mouse and keyboard/i)
    expect(fixer).toMatch(/do not run git commit, git push, or git checkout/i)
    expect(fixer).toMatch(/destroy other agents' uncommitted work/i)
  })

  // The owner paid for the opposite mistake too: a blanket "do not open a window" read as "the
  // UI is off limits", so a coworker shipped a fix it had never once seen run.
  it('tells coworkers the real app is available to them rather than forbidden', () => {
    expect(fixer).toMatch(/can and should drive the real app/i)
    expect(fixer).toMatch(/CONDUCTOR_TEST_USER_DATA/)
    expect(fixer).toMatch(/parks its window off every display/i)
    expect(fixer).toMatch(/not an acceptable sign-off/i)
    expect(fixer).not.toMatch(/do not open a visible app window/i)
  })

  it('requires the tree to be partitioned before work is handed out', () => {
    expect(fixer).toMatch(/same checkout at the same time/i)
    expect(fixer).toMatch(/give both to one coworker instead of racing them/i)
  })

  it('treats a completion report as a claim rather than evidence', () => {
    expect(fixer).toMatch(/a claim, not evidence/i)
    expect(fixer).toMatch(/intermittently is a bug until proven otherwise/i)
    expect(fixer).toMatch(/not sufficient evidence for security-relevant work/i)
  })

  it('keeps delivery meaning committed, pushed and published', () => {
    expect(fixer).toMatch(/only exists in the working tree is not delivered/i)
    expect(fixer).toMatch(/confirm the release actually published/i)
  })

  it('keeps the plain assignment brief free of orchestration instructions', () => {
    const plain = projectTaskPrompt([task()], false)
    expect(plain).not.toMatch(/router\.dispatch/)
    expect(plain).toMatch(/Mark tasks done only after finishing and verifying them/i)
  })

  it('leaves the brief byte-for-byte unchanged when no extra instruction is given', () => {
    expect(projectTaskPrompt([task()], false, undefined)).toBe(projectTaskPrompt([task()], false))
    expect(projectTaskPrompt([task()], false, '')).toBe(projectTaskPrompt([task()], false))
    expect(projectTaskPrompt([task()], false, '   ')).toBe(projectTaskPrompt([task()], false))
  })

  it('appends an optional owner instruction after the standard brief', () => {
    const withExtra = projectTaskPrompt([task()], false, 'Also update the changelog')
    expect(withExtra.startsWith(projectTaskPrompt([task()], false))).toBe(true)
    expect(withExtra).toContain('Additional instructions from the owner')
    expect(withExtra).toContain('Also update the changelog')
  })
})
