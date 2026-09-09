import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import { OrchestrationStore } from './orchestration-store'
import { AUTO_FIXER_INSTRUCTIONS, DISPATCHED_COWORKER_ROLE } from '../shared/orchestration'

const withStore = (run: (store: OrchestrationStore, projectId: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-roster-test-'))
  const path = join(root, 'conductor.db')
  const database = new ConductorDatabase(path)
  const project = database.upsertProject(join(root, 'project'), 'Project')
  let store: OrchestrationStore | null = new OrchestrationStore(path)
  try {
    run(store, project.id)
  } finally {
    store?.close()
    store = null
    database.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
}

describe('the Agent roster holds identities, not runs', () => {
  it('ships Auto Fixer as a real roster entry carrying the brief it actually runs', () => {
    withStore((store, projectId) => {
      const fixer = store.snapshot(projectId).agents.find(agent => agent.role === 'auto-fixer')
      expect(fixer).toBeDefined()
      expect(fixer!.name).toBe('Auto Fixer')
      expect(fixer!.instructions).toBe(AUTO_FIXER_INSTRUCTIONS)
    })
  })

  it('stays one row per identity no matter how often the roster is read', () => {
    withStore((store, projectId) => {
      const ids = [1, 2, 3].map(() => store.snapshot(projectId).agents.filter(agent => agent.role === 'auto-fixer').map(agent => agent.id))
      expect(ids[0]).toHaveLength(1)
      expect(new Set(ids.flat()).size).toBe(1)
    })
  })

  it('keeps the owner\'s renamed or paused built-in rather than resetting it', () => {
    withStore((store, projectId) => {
      const seeded = store.snapshot(projectId).agents.find(agent => agent.role === 'auto-fixer')!
      store.saveAgent({ id: seeded.id, projectId, name: 'My Fixer', provider: 'codex', model: 'gpt-6-astra', role: 'auto-fixer', instructions: 'stale', status: 'paused' })
      const after = store.snapshot(projectId).agents.find(agent => agent.role === 'auto-fixer')!
      expect(after.id).toBe(seeded.id)
      expect(after.name).toBe('My Fixer')
      expect(after.provider).toBe('codex')
      expect(after.status).toBe('paused')
      // The brief is ours to keep current, so an improved one still reaches an existing project.
      expect(after.instructions).toBe(AUTO_FIXER_INSTRUCTIONS)
    })
  })

  it('retires the per-dispatch entries that turned the roster into a task log', () => {
    withStore((store, projectId) => {
      const marketer = store.saveAgent({ projectId, name: 'Marketer', provider: 'claude', model: null, role: 'Marketing copy', instructions: 'Write launch copy.', status: 'active' })
      const run = store.saveAgent({ projectId, name: 'Fix broken tab dragging', provider: 'claude', model: 'opus', role: DISPATCHED_COWORKER_ROLE, instructions: 'a whole task prompt', status: 'active' })
      const task = store.createTask({ projectId, title: 'Fix broken tab dragging', description: 'x', status: 'in_progress', assignedAgentId: run.id })

      const snapshot = store.snapshot(projectId)
      const names = snapshot.agents.map(agent => agent.name)
      expect(names).toContain('Marketer')
      expect(names).toContain('Auto Fixer')
      expect(names).not.toContain('Fix broken tab dragging')
      expect(snapshot.agents.some(agent => agent.role === DISPATCHED_COWORKER_ROLE)).toBe(false)

      // The run itself is preserved; only the identity it wrongly created is gone.
      const kept = snapshot.tasks.find(entry => entry.id === task.id)
      expect(kept).toBeDefined()
      expect(kept!.title).toBe('Fix broken tab dragging')
      expect(kept!.assignedAgentId).toBeNull()
    })
  })

  it('leaves an owner-written identity alone even when it is the only one', () => {
    withStore((store, projectId) => {
      store.saveAgent({ projectId, name: '3D Modeling expert', provider: 'claude', model: null, role: 'Modelling', instructions: 'Advise on topology.', status: 'active' })
      const agents = store.snapshot(projectId).agents
      expect(agents.find(agent => agent.name === '3D Modeling expert')).toBeDefined()
      expect(agents).toHaveLength(2)
    })
  })
})
