import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import { OrchestrationStore } from './orchestration-store'

const withStore = (run: (
  store: OrchestrationStore,
  context: { path: string; projectId: string; secondProjectId: string }
) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-orchestration-test-'))
  const path = join(root, 'conductor.db')
  const database = new ConductorDatabase(path)
  const project = database.upsertProject(join(root, 'project'), 'Project')
  const secondProject = database.upsertProject(join(root, 'second-project'), 'Second project')
  let store: OrchestrationStore | null = new OrchestrationStore(path)
  try {
    run(store, { path, projectId: project.id, secondProjectId: secondProject.id })
  } finally {
    store?.close()
    store = null
    database.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
}

describe('OrchestrationStore', () => {
  it('persists first-class agents and standalone tasks', () => {
    withStore((store, { path, projectId }) => {
      const agent = store.saveAgent({
        projectId,
        name: 'Release reviewer',
        provider: 'codex',
        role: 'Guard release quality',
        instructions: 'Inspect regressions and report actionable findings.'
      })
      const task = store.createTask({
        projectId,
        title: 'Review release candidate',
        priority: 'high',
        assignedAgentId: agent.id
      })
      expect(store.updateTask(task.id, { status: 'in_progress' }).status).toBe('in_progress')
      expect(store.snapshot(projectId).agents.find(entry => entry.id === agent.id)).toMatchObject({
        name: 'Release reviewer', provider: 'codex', status: 'active'
      })

      const reopened = new OrchestrationStore(path)
      try {
        expect(reopened.snapshot(projectId).tasks[0]).toMatchObject({
          title: 'Review release candidate',
          priority: 'high',
          status: 'in_progress',
          assignedAgentId: agent.id
        })
        reopened.removeAgent(agent.id)
        expect(reopened.snapshot(projectId).tasks[0]?.assignedAgentId).toBeNull()
      } finally {
        reopened.close()
      }
    })
  })

  it('starts a routine as a linear chain and unlocks exactly the next task', () => {
    withStore((store, { projectId }) => {
      const implementer = store.saveAgent({ projectId, name: 'Builder', provider: 'claude' })
      const reviewer = store.saveAgent({ projectId, name: 'Reviewer', provider: 'codex' })
      const routine = store.saveRoutine({
        projectId,
        name: 'Ship change',
        description: 'Build, review, and publish in order',
        steps: [
          { title: 'Implement', assignedAgentId: implementer.id },
          { title: 'Review', assignedAgentId: reviewer.id },
          { title: 'Publish' }
        ]
      })

      const started = store.startRoutine(routine.id)
      expect(started.run.status).toBe('running')
      expect(started.tasks.map((task) => task.status)).toEqual(['ready', 'blocked', 'blocked'])
      expect(started.tasks[1]?.blockedByTaskId).toBe(started.tasks[0]?.id)
      expect(started.tasks[2]?.blockedByTaskId).toBe(started.tasks[1]?.id)

      store.updateTask(started.tasks[0]!.id, { status: 'done' })
      let tasks = store.snapshot(projectId).tasks
        .filter((task) => task.routineRunId === started.run.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
      expect(tasks.map((task) => task.status)).toEqual(['done', 'ready', 'blocked'])

      store.updateTask(started.tasks[1]!.id, { status: 'done' })
      tasks = store.snapshot(projectId).tasks
        .filter((task) => task.routineRunId === started.run.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
      expect(tasks.map((task) => task.status)).toEqual(['done', 'done', 'ready'])

      store.updateTask(started.tasks[2]!.id, { status: 'done' })
      expect(store.snapshot(projectId).runs.find((run) => run.id === started.run.id)).toMatchObject({
        status: 'complete'
      })
    })
  })

  it('keeps assignments inside a project and saves ordered routine edits', () => {
    withStore((store, { projectId, secondProjectId }) => {
      const foreignAgent = store.saveAgent({
        projectId: secondProjectId, name: 'Other project agent', provider: 'qwen'
      })
      expect(() => store.createTask({
        projectId, title: 'Invalid assignment', assignedAgentId: foreignAgent.id
      })).toThrow('does not belong to this project')

      const routine = store.saveRoutine({
        projectId,
        name: 'Triage',
        steps: [{ title: 'Observe' }, { title: 'Resolve' }]
      })
      const edited = store.saveRoutine({
        id: routine.id,
        projectId,
        name: 'Triage incidents',
        enabled: false,
        steps: [
          { id: routine.steps[1]!.id, title: 'Resolve safely' },
          { id: routine.steps[0]!.id, title: 'Observe signals' }
        ]
      })
      expect(edited.enabled).toBe(false)
      expect(edited.steps.map((step) => [step.position, step.title])).toEqual([
        [0, 'Resolve safely'],
        [1, 'Observe signals']
      ])
      expect(() => store.startRoutine(edited.id)).toThrow('disabled')
    })
  })
})
