import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSpec } from '../shared/models'
import { ConductorDatabase } from './database'

const withDatabasePath = (run: (path: string, root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-database-test-'))
  try {
    run(join(root, 'conductor.db'), root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
}

describe('ConductorDatabase persistence', () => {
  it('persists pending continuations and hides completed reset times from the process list', () => {
    withDatabasePath((path, root) => {
      let database: ConductorDatabase | null = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const session = database.listSessions(project.id)[0]!
        const spec: AgentSpec = {
          id: 'agent-1', projectId: project.id, sessionId: session.id,
          provider: 'claude', title: 'Claude', cwd: project.path, continueOnLimit: true
        }
        database.upsertAgent(spec, 'limited')
        database.saveContinuation(spec.id, project.id, session.id, '2026-09-07T06:00:00.000Z')
        database.close()

        database = new ConductorDatabase(path)
        expect(database.getContinuation(spec.id)).toEqual({
          resumeAt: '2026-09-07T06:00:00.000Z', status: 'pending'
        })
        expect(database.listProcesses(project.id).find((process) => process.id === spec.id)?.resumeAt)
          .toBe('2026-09-07T06:00:00.000Z')
        database.completeContinuation(spec.id)
        expect(database.listProcesses(project.id).find((process) => process.id === spec.id)?.resumeAt)
          .toBeUndefined()
        database.saveContinuation(spec.id, project.id, session.id, '2026-09-07T07:00:00.000Z')
        database.clearPendingContinuations()
        expect(database.getContinuation(spec.id)).toBeNull()
        database.setAgentStatus(spec.id, 'running', 'working')
        expect(database.listProcesses(project.id).find((process) => process.id === spec.id)?.activityPhase)
          .toBe('working')
      } finally {
        database?.close()
      }
    })
  })

  it('keeps shared and agent-specific memories separate while consolidating within one scope', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const shared = database.remember({
          projectId: project.id, kind: 'semantic', gist: 'Checkout tax totals are recalculated',
          cues: ['checkout', 'tax', 'totals']
        })
        const personal = database.remember({
          projectId: project.id, agentKey: 'claude', kind: 'semantic',
          gist: 'Claude found checkout tax totals', cues: ['checkout', 'tax', 'totals']
        })
        const reinforced = database.remember({
          projectId: project.id, agentKey: 'claude', kind: 'semantic',
          gist: 'Checkout tax totals need final validation', cues: ['checkout', 'tax', 'validation'],
          salience: 5, confidence: 5
        })

        expect(personal.id).not.toBe(shared.id)
        expect(reinforced.id).toBe(personal.id)
        expect(reinforced.strength).toBe(2)
        expect(reinforced.salience).toBe(1)
        expect(reinforced.confidence).toBe(1)
        expect(database.recall(project.id, 'unrelated deployment ssh')).toEqual([])
        expect(database.recall(project.id, 'checkout tax').map((item) => item.id))
          .toEqual(expect.arrayContaining([shared.id, personal.id]))
      } finally {
        database.close()
      }
    })
  })

  it('forgets only faded, unrehearsed agent episodes and keeps everything the project should retain', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const episode = database.remember({ projectId: project.id, kind: 'episodic', source: 'agent', gist: 'Retried the flaky deploy once', cues: ['deploy', 'retry'] })
        const knowledge = database.remember({ projectId: project.id, kind: 'semantic', source: 'agent', gist: 'Deploys run through the release workflow', cues: ['deploy', 'release'] })
        const owner = database.remember({ projectId: project.id, kind: 'episodic', source: 'human', gist: 'Owner watched the deploy fail live', cues: ['deploy', 'owner'] })
        const important = database.remember({ projectId: project.id, kind: 'episodic', source: 'agent', gist: 'Deploy wiped the staging database', cues: ['deploy', 'staging'], salience: 0.9 })

        // Nothing has faded yet, so a prune today must be a no-op rather than a cleanup.
        expect(database.forgetStaleMemories(project.id)).toBe(0)

        const distantFuture = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000
        expect(database.forgetStaleMemories(project.id, distantFuture)).toBe(1)
        const remaining = database.listMemories(project.id).map((item) => item.id)
        expect(remaining).not.toContain(episode.id)
        expect(remaining).toEqual(expect.arrayContaining([knowledge.id, owner.id, important.id]))
      } finally {
        database.close()
      }
    })
  })

  it('records which conversation wrote a memory and re-attributes it when another reinforces it', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const written = database.remember({
          projectId: project.id, agentKey: 'claude', kind: 'semantic', source: 'agent',
          gist: 'Checkout tax totals are recalculated', cues: ['checkout', 'tax', 'totals'],
          origin: { agentSessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Tax audit', provider: 'claude' }
        })
        expect(written.source).toBe('agent')
        expect(written.origin).toEqual({ agentSessionId: 'agent-1', workspaceId: 'workspace-1', title: 'Tax audit', provider: 'claude' })
        expect(written.correctedAt).toBeNull()

        // The conversation worth opening is the one that last stood behind the claim.
        const reinforced = database.remember({
          projectId: project.id, agentKey: 'claude', kind: 'semantic', source: 'agent',
          gist: 'Checkout tax totals are recalculated on save', cues: ['checkout', 'tax', 'totals'],
          origin: { agentSessionId: 'agent-2', workspaceId: 'workspace-1', title: 'Second look', provider: 'codex' }
        })
        expect(reinforced.id).toBe(written.id)
        expect(reinforced.origin?.agentSessionId).toBe('agent-2')

        // A memory written without provenance reads as unknown rather than borrowing someone else's.
        const anonymous = database.remember({ projectId: project.id, kind: 'procedural', gist: 'Run npm.cmd on Windows', cues: ['windows', 'npm'] })
        expect(anonymous.origin).toBeNull()
        expect(anonymous.source).toBe('human')
      } finally {
        database.close()
      }
    })
  })

  it('lets a person correct and re-weight an agent memory, which then survives automatic forgetting', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const written = database.remember({
          projectId: project.id, kind: 'episodic', source: 'agent', gist: 'Deploy failed becuse of stale totals',
          cues: ['deploy', 'totals'], origin: { agentSessionId: 'agent-1', workspaceId: 'workspace-1' }
        })
        const corrected = database.updateMemory({
          id: written.id, kind: 'semantic', gist: '  Deploy   failed because of stale totals  ',
          cues: ['Deploy', 'totals', 'staleness'], salience: 5, confidence: -1, strength: 3
        })
        expect(corrected.gist).toBe('Deploy failed because of stale totals')
        expect(corrected.kind).toBe('semantic')
        expect(corrected.cues).toEqual(['deploy', 'totals', 'staleness'])
        expect(corrected.salience).toBe(1)
        expect(corrected.confidence).toBe(0)
        expect(corrected.strength).toBe(3)
        // Who first claimed it stays visible; the correction is recorded beside it, not over it.
        expect(corrected.source).toBe('agent')
        expect(corrected.origin?.agentSessionId).toBe('agent-1')
        expect(corrected.correctedAt).toBeTruthy()

        // Re-weighting alone must not force a rewrite of the sentence.
        expect(database.updateMemory({ id: written.id, salience: 0.1 }).gist).toBe('Deploy failed because of stale totals')

        const stale = database.remember({
          projectId: project.id, kind: 'episodic', source: 'agent', gist: 'Retried the flaky deploy once', cues: ['flaky', 'retry']
        })
        expect(database.updateMemory({ id: stale.id, salience: 0.1 }).correctedAt).toBeTruthy()
        const distantFuture = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000
        expect(database.forgetStaleMemories(project.id, distantFuture)).toBe(0)

        expect(() => database.updateMemory({ id: 'missing', gist: 'nothing' })).toThrow(/no longer exists/)
        expect(() => database.updateMemory({ id: written.id, gist: '   ' })).toThrow(/concise gist/)
      } finally {
        database.close()
      }
    })
  })

  it('ranks the visible prune weakest-first without removing anything', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const faded = database.remember({ projectId: project.id, kind: 'episodic', source: 'agent', gist: 'Retried the flaky deploy once', cues: ['flaky', 'retry'], salience: 0.15, confidence: 0.2 })
        const held = database.remember({ projectId: project.id, kind: 'procedural', gist: 'Run npm.cmd on Windows', cues: ['windows', 'npm'], salience: 0.95, confidence: 0.95 })

        const distantFuture = Date.now() + 5 * 365 * 24 * 60 * 60 * 1000
        const ranked = database.memoryPruneCandidates(project.id, 10, distantFuture)
        expect(ranked.map((candidate) => candidate.memory.id)).toEqual([faded.id, held.id])
        expect(ranked[0]!.standing).toBeLessThan(ranked[1]!.standing)
        expect(ranked[0]!.reason).toMatch(/Faded/)
        // The prune is a suggestion; only the owner's action removes anything.
        expect(database.listMemories(project.id)).toHaveLength(2)
      } finally {
        database.close()
      }
    })
  })

  it('keeps a per-turn ledger of recalled memories and stays honest about ones forgotten since', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const kept = database.remember({ projectId: project.id, kind: 'semantic', gist: 'Checkout tax totals are recalculated', cues: ['checkout', 'tax'] })
        const dropped = database.remember({ projectId: project.id, kind: 'semantic', gist: 'Deploys run through the release workflow', cues: ['deploy', 'release'] })

        database.recordMemoryRecall({ projectId: project.id, agentSessionId: 'agent-1', itemId: 'item-1', prompt: '  Fix   the checkout tax  ', memoryIds: [kept.id, dropped.id] })
        // Nothing to explain, so nothing is written: an empty recall is not a turn fact.
        database.recordMemoryRecall({ projectId: project.id, agentSessionId: 'agent-1', itemId: 'item-2', prompt: 'Anything', memoryIds: [] })
        expect(database.listMemoryRecalls('agent-2')).toEqual([])

        expect(database.listMemoryRecalls('agent-1')).toHaveLength(1)
        const recall = database.listMemoryRecalls('agent-1')[0]!
        expect(recall.itemId).toBe('item-1')
        expect(recall.prompt).toBe('Fix the checkout tax')
        expect(recall.memories.map((memory) => memory.id)).toEqual([kept.id, dropped.id])
        expect(recall.forgotten).toBe(0)

        // A memory corrected after the fact shows its corrected text, and a deleted one is
        // counted rather than quietly vanishing from what the turn was told.
        database.updateMemory({ id: kept.id, gist: 'Checkout tax totals are recalculated on save' })
        database.removeMemory(dropped.id)
        const after = database.listMemoryRecalls('agent-1')[0]!
        expect(after.memories.map((memory) => memory.gist)).toEqual(['Checkout tax totals are recalculated on save'])
        expect(after.forgotten).toBe(1)
      } finally {
        database.close()
      }
    })
  })

  it('atomically restores the active desk, focused pane, layout, and unsaved editor draft', () => {
    withDatabasePath((path, root) => {
      let database: ConductorDatabase | null = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const session = database.listSessions(project.id)[0]!
        if (session.layout.root.type !== 'group') throw new Error('Expected the default pane group')
        const focusedGroupId = session.layout.root.id
        session.layout.root.tabs[0] = {
          id: 'editor-tab',
          kind: 'code',
          title: 'checkout.ts',
          state: { path: 'src/checkout.ts' }
        }
        session.layout.root.activeTabId = 'editor-tab'
        database.saveRecoveryCheckpoint({
          activeProjectId: project.id,
          activeSessionId: session.id,
          focusedGroupIds: { [session.id]: focusedGroupId },
          sessionIdsByProject: { [project.id]: session.id },
          sessions: [{
            id: session.id,
            layout: session.layout,
            maximizedGroupId: focusedGroupId,
            closedTabs: [{ id: 'closed-browser', kind: 'browser', title: 'Browser', state: { url: 'http://localhost:3000' } }]
          }]
        })
        database.saveEditorDraft(
          'editor-tab', project.id, 'src/checkout.ts', 'const recovered = true\n', { cursorState: [] }
        )
        database.close()

        database = new ConductorDatabase(path)
        expect(database.getWorkspaceRecoveryState()).toEqual({
          activeProjectId: project.id,
          activeSessionId: session.id,
          focusedGroupIds: { [session.id]: focusedGroupId },
          sessionIdsByProject: { [project.id]: session.id }
        })
        const restored = database.getSession(session.id)!
        expect(restored.maximizedGroupId).toBe(focusedGroupId)
        expect(restored.layout.root.type === 'group' && restored.layout.root.activeTabId).toBe('editor-tab')
        expect(restored.closedTabs[0]?.state?.url).toBe('http://localhost:3000')
        expect(database.getEditorDraft('editor-tab', project.id, 'src/checkout.ts')?.content)
          .toBe('const recovered = true\n')
      } finally {
        database?.close()
      }
    })
  })

  it('marks runtimes left active by a machine crash as exited on the next boot', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const project = database.upsertProject(join(root, 'project'), 'Project')
        const session = database.listSessions(project.id)[0]!
        database.upsertTerminal({
          id: 'terminal-crashed', projectId: project.id, sessionId: session.id,
          title: 'PowerShell', cwd: project.path
        }, 'running')
        database.upsertAgent({
          id: 'agent-crashed', projectId: project.id, sessionId: session.id,
          provider: 'codex', title: 'Codex', cwd: project.path
        }, 'waiting_input')
        database.reconcileInterruptedRuntimes()
        const processes = database.listProcesses(project.id)
        expect(processes.find((item) => item.id === 'terminal-crashed')?.status).toBe('exited')
        expect(processes.find((item) => item.id === 'agent-crashed')?.status).toBe('exited')
      } finally {
        database.close()
      }
    })
  })

  it('removes a project from Conductor without deleting its folder or files', () => {
    withDatabasePath((path, root) => {
      const database = new ConductorDatabase(path)
      try {
        const projectPath = join(root, 'project')
        const project = database.upsertProject(projectPath, 'Project')
        const session = database.listSessions(project.id)[0]!
        database.upsertAgent({
          id: 'agent-to-remove', projectId: project.id, sessionId: session.id,
          provider: 'codex', title: 'Codex', cwd: project.path
        }, 'idle')

        database.removeProject(project.id)

        expect(database.getProject(project.id)).toBeNull()
        expect(database.listSessions(project.id)).toEqual([])
        expect(database.listProcesses(project.id)).toEqual([])
      } finally {
        database.close()
      }
    })
  })
})

describe('workspace navigation and file draft persistence', () => {
  it('preserves project and workspace drag order across restart and metadata updates', () => {
    withDatabasePath((path, root) => {
      let db = new ConductorDatabase(path)
      try {
        const a = db.upsertProject(join(root, 'a'), 'A'), b = db.upsertProject(join(root, 'b'), 'B')
        db.reorderProjects([a.id, b.id])
        const first = db.listSessions(a.id)[0]!, second = db.createSession(a.id, 'Second')
        db.reorderSessions(a.id, [second.id, first.id])
        db.close(); db = new ConductorDatabase(path)
        expect(db.listProjects().map((item) => item.id)).toEqual([a.id, b.id])
        expect(db.listSessions(a.id).map((item) => item.id)).toEqual([second.id, first.id])
        expect(() => db.reorderProjects([a.id, a.id])).toThrow('list changed')
        const c = db.upsertProject(join(root, 'c'), 'C')
        expect(db.listProjects().map((item) => item.id)).toEqual([a.id, b.id, c.id])
      } finally { db.close() }
    })
  })
  it('moves every hidden draft in a renamed directory without affecting another project or sibling', () => {
    withDatabasePath((path, root) => {
      const db = new ConductorDatabase(path)
      try {
        const a = db.upsertProject(join(root, 'a'), 'A'), b = db.upsertProject(join(root, 'b'), 'B')
        db.saveEditorDraft('hidden-a', a.id, 'src/file.ts', 'unsaved a', null)
        db.saveEditorDraft('hidden-b', a.id, 'src/nested/file.ts', 'unsaved b', null)
        db.saveEditorDraft('other', b.id, 'src/file.ts', 'other project', null)
        db.saveEditorDraft('sibling', a.id, 'src-more/file.ts', 'sibling', null)
        db.remapEditorDrafts(a.id, 'src', 'renamed', true)
        expect(db.getEditorDraft('hidden-a', a.id, 'renamed/file.ts')?.content).toBe('unsaved a')
        expect(db.getEditorDraft('hidden-b', a.id, 'renamed/nested/file.ts')?.content).toBe('unsaved b')
        expect(db.getEditorDraft('other', b.id, 'src/file.ts')?.content).toBe('other project')
        expect(db.getEditorDraft('sibling', a.id, 'src-more/file.ts')?.content).toBe('sibling')
      } finally { db.close() }
    })
  })
})
