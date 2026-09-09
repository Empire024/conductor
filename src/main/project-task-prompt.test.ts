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

  // Each of these is a rule the owner paid for once already: coworker windows appearing over
  // their screen, a git checkout that would have wiped concurrent uncommitted work, and agents
  // reporting a task done that nobody had actually looked at.
  it('forbids the coworker behaviours that have hurt the owner before', () => {
    expect(fixer).toMatch(/do not open a visible app window/i)
    expect(fixer).toMatch(/steal the mouse and keyboard/i)
    expect(fixer).toMatch(/do not run git commit, git push, or git checkout/i)
    expect(fixer).toMatch(/destroy other agents' uncommitted work/i)
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
})
