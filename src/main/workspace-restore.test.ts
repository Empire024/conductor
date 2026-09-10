import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConductorDatabase } from './database'
import type { AgentSpec, PaneTab } from '../shared/models'

const fixtures: Array<{ root: string; database: ConductorDatabase }> = []
afterEach(() => { for (const fixture of fixtures.splice(0)) { fixture.database.close(); rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5 }) } })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-workspace-restore-'))
  const path = join(root, 'state.sqlite')
  const database = new ConductorDatabase(path)
  const fixture = { root, path, database }; fixtures.push(fixture)
  const project = database.upsertProject(join(root, 'project'), 'Project')
  return { fixture, database, project, session: database.listSessions(project.id)[0]! }
}

describe('reversible workspace closure', () => {
  it('restores the same pane and conversation identities, file drafts, and closed tabs after restart', () => {
    const { fixture, database, project, session } = setup()
    const agent: AgentSpec = { id: 'preserved-agent', projectId: project.id, sessionId: session.id, provider: 'codex', cwd: project.path, title: 'Codex' }
    const tab: PaneTab = { id: 'same-pane', resourceId: agent.id, kind: 'agent', title: 'Codex', state: { provider: 'codex' } }
    if (session.layout.root.type !== 'group') throw new Error('Expected a group')
    session.layout.root.tabs = [tab]; session.layout.root.activeTabId = tab.id
    database.saveSession(session.id, session.layout, session.layout.root.id, [tab])
    database.setSessionContinuation(session.id, true)
    database.upsertAgent(agent, 'exited')
    database.appendAgentTranscript(agent.id, 'Preserved transcript')
    database.structured.register(agent.id, project.id, 'codex', agent)
    database.structured.append({ schemaVersion: 1, id: 'event-1', sequence: 1, sessionId: agent.id, workspaceId: session.id, runtimeId: 'runtime', provider: 'codex', projectId: project.id, cwd: project.path, timestamp: '2026-09-07T00:00:00Z', data: { type: 'session', phase: 'disconnected', nativeSessionId: 'same-native-session' } })
    database.saveEditorDraft('file-tab', project.id, 'notes.md', 'unsaved draft', null, 'original')
    database.closeSession(session.id)
    expect(database.listSessions(project.id)).toEqual([])
    database.close()
    fixture.database = new ConductorDatabase(fixture.path)
    const restored = fixture.database.restoreSession()
    expect(restored).toMatchObject({ id: session.id, name: session.name, layout: session.layout, maximizedGroupId: session.layout.root.id, closedTabs: [tab], continueOnLimit: true })
    expect(fixture.database.getAgentTranscript(agent.id)).toBe('Preserved transcript')
    expect(fixture.database.structured.snapshot(agent.id)?.nativeSessionId).toBe('same-native-session')
    expect(fixture.database.getEditorDraft('file-tab', project.id, 'notes.md')?.content).toBe('unsaved draft')
    expect(fixture.database.listClosedSessions()).toEqual([])
  })

  it('restores most recently closed workspaces first across projects and ignores duplicate close requests', () => {
    const { fixture, database, session } = setup()
    const other = database.upsertProject(join(fixture.root, 'other'), 'Other')
    const second = database.listSessions(other.id)[0]!
    database.closeSession(second.id); database.closeSession(session.id); database.closeSession(second.id)
    expect(database.listClosedSessions().map(item => item.id)).toEqual([session.id, second.id])
    expect(database.restoreSession()?.id).toBe(session.id)
    expect(database.restoreSession()?.id).toBe(second.id)
    expect(database.restoreSession()).toBeNull()
  })

  it('keeps a closed snapshot safe from delayed ordinary saves and recovery checkpoints', () => {
    const { database, project, session } = setup()
    database.saveSession(session.id, session.layout, null, [])
    database.closeSession(session.id)
    const stale = structuredClone(session.layout)
    if (stale.root.type !== 'group') throw new Error('Expected a group')
    stale.root.tabs = []
    database.saveSession(session.id, stale, null, [])
    database.saveRecoveryCheckpoint({ activeProjectId: project.id, activeSessionId: session.id, focusedGroupIds: {}, sessionIdsByProject: {}, sessions: [{ id: session.id, layout: stale, maximizedGroupId: null, closedTabs: [] }] })
    expect(database.getWorkspaceRecoveryState().activeSessionId).toBeNull()
    expect(database.restoreSession()?.layout).toEqual(session.layout)
  })

  it('retains detached panes while excluding closed workspaces from startup windows', () => {
    const { database, project, session } = setup()
    const tab: PaneTab = { id: 'detached-pane', kind: 'agent', title: 'Detached', resourceId: 'detached-agent' }
    const detached = database.createDetachedWindow(project.id, session.id, tab)
    database.closeSession(session.id)
    expect(database.listDetachedWindows()).toEqual([])
    expect(database.getDetachedWindow(detached.id)?.layout).toEqual(detached.layout)
    database.restoreSession(session.id)
    expect(database.listDetachedWindows().map(item => item.id)).toEqual([detached.id])
  })

  it('returns a floating tab to the visible layout while ordinary detached tabs stay retrievable', () => {
    const { database, project, session } = setup()
    const floating: PaneTab = { id: 'floating', kind: 'agent', title: 'Floating', resourceId: 'same-runtime' }
    const detached = database.createDetachedWindow(project.id, session.id, floating)
    database.closeDetachedWindow(detached.id, true)
    const restored = database.getSession(session.id)!
    expect(restored.layout.root.type === 'group' && restored.layout.root.tabs).toContainEqual(floating)
    expect(restored.layout.root.type === 'group' && restored.layout.root.activeTabId).toBe(floating.id)
    expect(restored.closedTabs).not.toContainEqual(floating)
    const normal: PaneTab = { id: 'normal-window', kind: 'launcher', title: 'Normal' }
    const window = database.createDetachedWindow(project.id, session.id, normal)
    database.closeDetachedWindow(window.id)
    expect(database.getSession(session.id)!.closedTabs).toContainEqual(normal)
  })

  it('preserves workspace order and never duplicates an already open or unknown workspace', () => {
    const { database, project, session } = setup()
    const second = database.createSession(project.id, 'Second')
    database.reorderSessions(project.id, [second.id, session.id])
    database.closeSession(second.id)
    expect(database.restoreSession(session.id)).toBeNull()
    expect(database.restoreSession('unknown')).toBeNull()
    expect(database.restoreSession(second.id)?.id).toBe(second.id)
    expect(database.listSessions(project.id).map(item => item.id)).toEqual([second.id, session.id])
    expect(database.restoreSession(second.id)).toBeNull()
  })
})
