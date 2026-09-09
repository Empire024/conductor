import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSpec, PaneTab, SessionRecord, WorkspaceLayout } from '../shared/models'
import { ConductorDatabase } from './database'
import { aggregateProjectActivity, type AgentActivityRow } from './project-activity'

const layoutWith = (...resourceIds: string[]): WorkspaceLayout => ({
  version: 1,
  root: {
    type: 'group',
    id: 'group-1',
    activeTabId: 'tab-0',
    tabs: resourceIds.map((resourceId, index): PaneTab => ({
      id: `tab-${index}`, kind: 'agent', title: 'Agent', resourceId
    }))
  }
})

const workspace = (id: string, projectId: string, ...resourceIds: string[]): SessionRecord => ({
  id, projectId, name: id, layout: layoutWith(...resourceIds),
  maximizedGroupId: null, closedTabs: [], continueOnLimit: false,
  createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z'
})

const agent = (id: string, projectId: string, sessionId: string, activityPhase: AgentActivityRow['activityPhase']): AgentActivityRow =>
  ({ id, projectId, sessionId, activityPhase })

describe('aggregateProjectActivity', () => {
  it('resolves a project whose panes were never mounted this launch', () => {
    const statuses = aggregateProjectActivity(
      ['project-a', 'project-b'],
      [workspace('workspace-a', 'project-a', 'agent-a'), workspace('workspace-b', 'project-b', 'agent-b')],
      [agent('agent-a', 'project-a', 'workspace-a', 'idle'), agent('agent-b', 'project-b', 'workspace-b', 'working')]
    )
    expect(statuses).toEqual({ 'project-a': 'idle', 'project-b': 'working' })
  })

  it('reports the most urgent state across a project with several workspaces', () => {
    const workspaces = [
      workspace('workspace-1', 'project-a', 'agent-done'),
      workspace('workspace-2', 'project-a', 'agent-working'),
      workspace('workspace-3', 'project-a', 'agent-waiting')
    ]
    const agents = [
      agent('agent-done', 'project-a', 'workspace-1', 'complete'),
      agent('agent-working', 'project-a', 'workspace-2', 'working'),
      agent('agent-waiting', 'project-a', 'workspace-3', 'waiting_input')
    ]
    expect(aggregateProjectActivity(['project-a'], workspaces, agents)['project-a']).toBe('attention')
    expect(aggregateProjectActivity(['project-a'], workspaces, agents.slice(0, 2))['project-a']).toBe('working')
    expect(aggregateProjectActivity(['project-a'], workspaces, agents.slice(0, 1))['project-a']).toBe('done')
  })

  it('treats a failed agent as needing attention, a limited one as working, and an interrupted disconnect as needing a look', () => {
    const workspaces = [workspace('workspace-1', 'project-a', 'agent-1')]
    expect(aggregateProjectActivity(['project-a'], workspaces, [agent('agent-1', 'project-a', 'workspace-1', 'failed')])['project-a']).toBe('waiting')
    expect(aggregateProjectActivity(['project-a'], workspaces, [agent('agent-1', 'project-a', 'workspace-1', 'disconnected')])['project-a']).toBe('waiting')
    expect(aggregateProjectActivity(['project-a'], workspaces, [agent('agent-1', 'project-a', 'workspace-1', 'limited')])['project-a']).toBe('working')
  })

  it('does not let a settled tab that lost its connection paint over a project that already finished', () => {
    const doneAndDisconnected = [
      workspace('workspace-1', 'project-a', 'agent-done'),
      workspace('workspace-2', 'project-a', 'agent-disconnected')
    ]
    expect(aggregateProjectActivity(['project-a'], doneAndDisconnected, [
      agent('agent-done', 'project-a', 'workspace-1', 'complete'),
      agent('agent-disconnected', 'project-a', 'workspace-2', 'idle')
    ])['project-a']).toBe('done')

    const workingAndSettled = [
      workspace('workspace-1', 'project-a', 'agent-working'),
      workspace('workspace-2', 'project-a', 'agent-settled')
    ]
    expect(aggregateProjectActivity(['project-a'], workingAndSettled, [
      agent('agent-working', 'project-a', 'workspace-1', 'working'),
      agent('agent-settled', 'project-a', 'workspace-2', 'complete')
    ])['project-a']).toBe('working')
  })

  it('surfaces a tab cut off mid-output over one still working, the same way a failure is surfaced', () => {
    const workspaces = [
      workspace('workspace-1', 'project-a', 'agent-working'),
      workspace('workspace-2', 'project-a', 'agent-disconnected')
    ]
    expect(aggregateProjectActivity(['project-a'], workspaces, [
      agent('agent-working', 'project-a', 'workspace-1', 'working'),
      agent('agent-disconnected', 'project-a', 'workspace-2', 'disconnected')
    ])['project-a']).toBe('waiting')
  })

  it('ignores agents whose tab or workspace is no longer open, and projects with none at all', () => {
    const statuses = aggregateProjectActivity(
      ['project-a', 'project-b', 'project-c'],
      [workspace('workspace-a', 'project-a'), workspace('workspace-b', 'project-b', 'agent-b')],
      [
        agent('agent-a', 'project-a', 'workspace-a', 'working'),
        agent('agent-closed', 'project-b', 'workspace-closed', 'working'),
        agent('agent-b', 'project-b', 'workspace-b', 'complete')
      ]
    )
    expect(statuses).toEqual({ 'project-a': 'idle', 'project-b': 'done', 'project-c': 'idle' })
  })

  it('never lets one project speak for another', () => {
    const statuses = aggregateProjectActivity(
      ['project-a', 'project-b'],
      [workspace('workspace-a', 'project-a', 'agent-b'), workspace('workspace-b', 'project-b', 'agent-b')],
      [agent('agent-b', 'project-b', 'workspace-b', 'working')]
    )
    expect(statuses).toEqual({ 'project-a': 'idle', 'project-b': 'working' })
  })
})

const withDatabasePath = (run: (path: string, root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-activity-test-'))
  try {
    run(join(root, 'conductor.db'), root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
}

const snapshot = (database: ConductorDatabase): Record<string, string> => {
  const projects = database.listProjects()
  return aggregateProjectActivity(
    projects.map((project) => project.id),
    projects.flatMap((project) => database.listSessions(project.id)),
    database.listAgentActivity()
  )
}

describe('cross-project activity from the database', () => {
  it('reports agents in projects the renderer never opened, and forgets stale phases after a restart', () => {
    withDatabasePath((path, root) => {
      let database: ConductorDatabase | null = new ConductorDatabase(path)
      try {
        const first = database.upsertProject(join(root, 'first'), 'First')
        const second = database.upsertProject(join(root, 'second'), 'Second')
        const firstWorkspace = database.listSessions(first.id)[0]!
        const secondWorkspace = database.listSessions(second.id)[0]!
        const spec = (id: string, projectId: string, sessionId: string, cwd: string): AgentSpec => ({
          id, projectId, sessionId, provider: 'claude', title: 'Claude', cwd, continueOnLimit: false
        })
        database.upsertAgent(spec('agent-first', first.id, firstWorkspace.id, first.path), 'running')
        database.upsertAgent(spec('agent-second', second.id, secondWorkspace.id, second.path), 'running')
        database.saveSession(firstWorkspace.id, layoutWith('agent-first'), null, [])
        database.saveSession(secondWorkspace.id, layoutWith('agent-second'), null, [])

        database.setAgentStatus('agent-second', 'running', 'working')
        expect(snapshot(database)).toEqual({ [first.id]: 'idle', [second.id]: 'working' })

        database.setAgentStatus('agent-second', 'waiting_input', 'waiting_input')
        database.setAgentStatus('agent-first', 'complete', 'complete')
        expect(snapshot(database)).toEqual({ [first.id]: 'done', [second.id]: 'attention' })

        database.close()
        database = new ConductorDatabase(path)
        // A relaunch has no live runtimes: the interrupted agent must not keep claiming
        // attention, while the conversation that genuinely finished still reads as done.
        database.reconcileInterruptedRuntimes()
        expect(snapshot(database)).toEqual({ [first.id]: 'done', [second.id]: 'idle' })
      } finally {
        database?.close()
      }
    })
  })
})
