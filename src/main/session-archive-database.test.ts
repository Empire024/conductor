import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSpec, PaneTab, WorkspaceLayout } from '../shared/models'
import { ConductorDatabase } from './database'

const remoteMachine = '0f70e41a-811c-4bc7-a0f1-0123456789ab'
const withDatabase = (run: (database: ConductorDatabase, root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-archive-database-'))
  try { run(new ConductorDatabase(join(root, 'conductor.db')), root) }
  finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) }
}

function prepare(database: ConductorDatabase, root: string): { projectId: string; workspaceId: string; documentId: string; detachedId: string; detachedDocumentId: string; layout: WorkspaceLayout } {
  const projectPath = join(root, 'project'); mkdirSync(projectPath)
  const project = database.upsertProject(projectPath, 'Project')
  const workspace = database.listSessions(project.id)[0]!
  const tabs: PaneTab[] = [
    { id: 'agent-tab', kind: 'agent', title: 'Agent', resourceId: 'agent-one', state: { provider: 'codex', machineId: 'local' } },
    { id: 'file-tab', kind: 'code', title: 'File', resourceId: 'src/file.ts', state: { path: 'src/file.ts', machineId: 'local' } },
    { id: 'terminal-tab', kind: 'terminal', title: 'Terminal', resourceId: 'terminal-one', state: { startupCommand: 'must-not-survive' } }
  ]
  const layout: WorkspaceLayout = { version: 1, root: { type: 'group', id: 'group-one', activeTabId: 'agent-tab', tabs } }
  const closedTabs: PaneTab[] = [{ id: 'closed-file', kind: 'code', title: 'Closed', resourceId: 'closed.ts', state: { path: 'closed.ts', machineId: 'local' } }]
  database.saveSession(workspace.id, layout, 'group-one', closedTabs)
  const detached = database.createDetachedWindow(project.id, workspace.id, {
    id: 'detached-file-tab', kind: 'code', title: 'Detached file', resourceId: 'remote/detached.ts', state: { path: 'remote/detached.ts', machineId: remoteMachine }
  }, layout)
  const documentId = `document:${workspace.id}:doc-one`
  const detachedDocumentId = `document:detached:${detached.id}:doc-two`
  database.saveRecoveryCheckpoint({ sessions: [{ id: workspace.id, layout, maximizedGroupId: 'group-one', closedTabs }], activeProjectId: project.id, activeSessionId: workspace.id, focusedGroupIds: { [workspace.id]: 'group-one' }, sessionIdsByProject: { [project.id]: workspace.id }, documents: [
    { workspaceId: workspace.id, files: [{ id: documentId, machineId: remoteMachine, projectId: project.id, path: 'remote/file.ts', mode: 'editor' }], activeId: documentId },
    { workspaceId: `detached:${detached.id}`, files: [{ id: detachedDocumentId, machineId: remoteMachine, projectId: project.id, path: 'remote/detached.ts', mode: 'editor' }], activeId: detachedDocumentId }
  ] })
  const spec: AgentSpec = { id: 'agent-one', projectId: project.id, sessionId: workspace.id, provider: 'codex', title: 'Agent', cwd: project.path, machineId: 'local' }
  database.upsertAgent(spec, 'exited', 'complete')
  const projection = database.structured.register(spec.id, project.id, 'codex', spec)
  projection.title = 'Retained history'; projection.nativeSessionId = 'native-one'
  database.structured.checkpoint(spec.id)
  database.upsertTerminal({ id: 'terminal-one', projectId: project.id, sessionId: workspace.id, title: 'Terminal', cwd: project.path, startupCommand: 'must-not-survive' }, 'exited')
  database.appendTerminalTranscript('terminal-one', 'retained terminal output')
  database.saveEditorDraft('file-tab', project.id, 'src/file.ts', 'client_secret=keep-current', null, '', 'local')
  database.saveEditorDraft(documentId, project.id, 'remote/file.ts', 'remote unsaved', null, '', remoteMachine)
  database.saveEditorDraft(detachedDocumentId, project.id, 'remote/detached.ts', 'detached unsaved', null, '', remoteMachine)
  return { projectId: project.id, workspaceId: workspace.id, documentId, detachedId: detached.id, detachedDocumentId, layout }
}

describe('session archive database replacement', () => {
  it('round-trips history, closed tabs, local and remote drafts with fresh identities', () => withDatabase((database, root) => {
    try {
      const original = prepare(database, root)
      const archive = database.sessionArchive('Saved desk')
      expect(archive.drafts.find(draft => draft.tabId === original.documentId)?.machineId).toBe(remoteMachine)
      expect(archive.documents?.[0]?.files[0]).toMatchObject({ id: original.documentId, machineId: remoteMachine, path: 'remote/file.ts' })
      expect(archive.documents?.find(state => state.workspaceId === `detached:${original.detachedId}`)?.files[0]?.id).toBe(original.detachedDocumentId)
      expect(archive.drafts.find(draft => draft.tabId === 'file-tab')?.content).toBe('client_secret=keep-current')

      const imported = database.importSessionArchive(archive)
      expect(imported.name).toBe('Saved desk')
      expect(imported.selection.activeSessionId).not.toBe(original.workspaceId)
      expect(database.listClosedSessions().some(workspace => workspace.id === original.workspaceId)).toBe(true)
      const current = database.listSessions(original.projectId)
      expect(current).toHaveLength(1)
      expect(current[0]?.closedTabs).toHaveLength(1)
      const importedAgentId = current[0]?.layout.root.type === 'group' ? current[0].layout.root.tabs.find(tab => tab.kind === 'agent')?.resourceId : undefined
      expect(importedAgentId).toBeTruthy()
      expect(database.structured.snapshot(importedAgentId!)?.nativeSessionId).toBe('native-one')
      expect(database.importedSessionMachine(importedAgentId!)).toBe('local')
      const importedTerminalId = current[0]?.layout.root.type === 'group' ? current[0].layout.root.tabs.find(tab => tab.kind === 'terminal')?.resourceId : undefined
      expect(importedTerminalId).toBeTruthy()
      expect(database.getTerminalTranscript(importedTerminalId!)).toBe('retained terminal output')
      expect(database.getSetting('sessionArchiveImportedTerminal:' + importedTerminalId)).toBe('dormant')
      expect(current[0]?.layout.root.type === 'group' ? current[0].layout.root.tabs.find(tab => tab.kind === 'terminal')?.state : null).toEqual({ archiveDormant: true })
      const restoredDocuments = database.getWorkspaceRecoveryState().documents ?? []
      const restoredDocument = restoredDocuments.flatMap(state => state.files).find(file => file.path === 'remote/file.ts')
      expect(restoredDocument).toMatchObject({ machineId: remoteMachine, projectId: original.projectId })
      expect(restoredDocument?.id).not.toBe(original.documentId)
      expect(database.listEditorDrafts().find(draft => draft.tabId === restoredDocument?.id)).toMatchObject({ machineId: remoteMachine, content: 'remote unsaved' })
      const importedDetached = database.listDeskDetachedWindows()[0]!
      expect(importedDetached.id).not.toBe(original.detachedId)
      const restoredDetachedState = restoredDocuments.find(state => state.workspaceId === `detached:${importedDetached.id}`)!
      expect(restoredDetachedState.files[0]?.id).toMatch(new RegExp(`^document:detached:${importedDetached.id}:`))
      expect(restoredDetachedState.files[0]?.id).not.toBe(original.detachedDocumentId)
      expect(database.listEditorDrafts().find(draft => draft.tabId === restoredDetachedState.files[0]?.id)).toMatchObject({ machineId: remoteMachine, content: 'detached unsaved' })

      const second = database.importSessionArchive(archive)
      expect(second.selection.activeSessionId).not.toBe(imported.selection.activeSessionId)
      expect(database.listSessions(original.projectId)).toHaveLength(1)
      expect(database.listClosedSessions().map(workspace => workspace.id)).toEqual(expect.arrayContaining([original.workspaceId, imported.selection.activeSessionId]))
    } finally { database.close() }
  }))

  it('requires explicit activation and never converts remote imported work to local', () => withDatabase((database, root) => {
    try {
      const original = prepare(database, root), archive = database.sessionArchive('Saved desk')
      archive.agents[0]!.spec.machineId = remoteMachine
      archive.agents[0]!.spec.cwd = 'D:\\remote\\repo'
      if (archive.workspaces[0]!.layout.root.type === 'group') archive.workspaces[0]!.layout.root.tabs.find(tab => tab.kind === 'agent')!.state!.machineId = remoteMachine
      const imported = database.importSessionArchive(archive)
      const workspace = database.getSession(imported.selection.activeSessionId!)!
      const agentId = workspace.layout.root.type === 'group' ? workspace.layout.root.tabs.find(tab => tab.kind === 'agent')!.resourceId! : ''
      expect(() => database.activateImportedResource('agent', agentId)).toThrow('cannot run locally')
      expect(database.importedSessionMachine(agentId)).toBe(remoteMachine)
      const terminalId = workspace.layout.root.type === 'group' ? workspace.layout.root.tabs.find(tab => tab.kind === 'terminal')!.resourceId! : ''
      database.activateImportedResource('terminal', terminalId)
      expect(database.getSetting('sessionArchiveImportedTerminal:' + terminalId)).toBeNull()
      expect(database.getProject(original.projectId)).not.toBeNull()
    } finally { database.close() }
  }))

  it('validates before its transaction so malformed import leaves the current desk and drafts intact', () => withDatabase((database, root) => {
    try {
      const original = prepare(database, root), before = database.getWorkspaceRecoveryState()
      const archive = database.sessionArchive('Saved desk') as any
      archive.selection.activeSessionId = 'missing-workspace'
      expect(() => database.importSessionArchive(archive)).toThrow('selected workspace missing')
      expect(database.getWorkspaceRecoveryState()).toEqual(before)
      expect(database.listSessions(original.projectId).map(workspace => workspace.id)).toEqual([original.workspaceId])
      expect(database.getEditorDraft('file-tab', original.projectId, 'src/file.ts')?.content).toBe('client_secret=keep-current')
    } finally { database.close() }
  }))
})
