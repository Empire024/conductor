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
          focusedGroupIds: { [session.id]: focusedGroupId }
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
