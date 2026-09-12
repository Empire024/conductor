import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyProjection } from '../shared/structured-agent-reducer'
import type { SessionArchive } from '../shared/session-archive'
import { parseSessionArchive, readSessionArchive, writeSessionArchive } from './session-archive'

const at = '2026-09-12T12:00:00.000Z'
const remoteMachine = '0f70e41a-811c-4bc7-a0f1-0123456789ab'
function fixture(): SessionArchive {
  const projection = {
    ...emptyProjection('agent-one'),
    nativeSessionId: 'native-one',
    phase: 'running' as const,
    queuedPrompts: [{ id: 'queue-one', text: 'do this', settings: { permission: 'default' as const, plan: false }, attachments: [] }],
    title: 'Retained conversation',
    items: [
      { id: 'message-one', runtimeId: 'runtime-one', sequence: 1, timestamp: at, data: { type: 'text' as const, role: 'user' as const, text: 'token=secret-value', mode: 'snapshot' as const, attachments: [{ id: 'remote-attachment', kind: 'file', name: 'file.ts', remoteFile: { machineId: remoteMachine, projectId: 'project-one', path: 'src/file.ts' } }] as never } },
      { id: 'tool-one', runtimeId: 'runtime-one', sequence: 2, timestamp: at, data: { type: 'tool' as const, name: 'shell', status: 'running' as const, outputArtifactId: 'artifact-one' } }
    ],
    sequence: 2
  }
  return {
    format: 'conductor-session', version: 1, name: 'Remote desk', savedAt: at,
    projects: [{ id: 'project-one', name: 'Project', path: 'C:\\local\\reference', createdAt: at, updatedAt: at }],
    workspaces: [{
      id: 'workspace-one', projectId: 'project-one', name: 'Workspace', maximizedGroupId: 'group-one',
      layout: { version: 1, root: { type: 'group', id: 'group-one', activeTabId: 'agent-tab', tabs: [
        { id: 'agent-tab', kind: 'agent', title: 'Remote agent', resourceId: 'agent-one', state: { machineId: remoteMachine, provider: 'codex', viewMode: 'cli' } },
        { id: 'code-tab', kind: 'code', title: 'File', resourceId: 'src/file.ts', state: { path: 'src/file.ts', machineId: remoteMachine } }
      ] } },
      closedTabs: [{ id: 'closed-tab', kind: 'code', title: 'Closed', resourceId: 'closed.ts', state: { path: 'closed.ts', machineId: remoteMachine } }],
      continueOnLimit: true, createdAt: at, updatedAt: at
    }],
    detached: [],
    agents: [{ spec: { id: 'agent-one', projectId: 'project-one', sessionId: 'workspace-one', provider: 'codex', title: 'Remote', cwd: 'D:\\host\\repo', machineId: remoteMachine, continueOnLimit: true }, projection, transcript: 'Bearer very-secret' }],
    terminals: [],
    documents: [{ workspaceId: 'workspace-one', files: [{ id: 'document:workspace-one:doc-one', machineId: remoteMachine, projectId: 'project-one', path: 'src/document.ts', mode: 'editor' }], activeId: 'document:workspace-one:doc-one' }],
    drafts: [
      { tabId: 'code-tab', machineId: remoteMachine, projectId: 'project-one', path: 'src/file.ts', content: 'client_secret=top-secret', baseContent: '', viewState: { unsafe: true }, updatedAt: at },
      { tabId: 'document:workspace-one:doc-one', machineId: remoteMachine, projectId: 'project-one', path: 'src/document.ts', content: 'Bearer source literal', baseContent: 'const before = true', viewState: null, updatedAt: at }
    ],
    selection: { activeProjectId: 'project-one', activeSessionId: 'workspace-one', focusedGroupIds: { 'workspace-one': 'group-one' }, sessionIdsByProject: { 'project-one': 'workspace-one' } }
  }
}

describe('session archive validation', () => {
  it('retains remote placement/history while disabling execution and removing credentials', () => {
    const source = fixture()
    const originalDraft = structuredClone(source.drafts[0])
    const parsed = parseSessionArchive(JSON.stringify(source))
    expect(parsed.agents[0]?.spec).toMatchObject({ machineId: remoteMachine, cwd: 'D:\\host\\repo', continueOnLimit: false })
    expect(parsed.workspaces[0]?.layout.root).toMatchObject({ type: 'group', tabs: expect.arrayContaining([expect.objectContaining({ state: expect.objectContaining({ machineId: remoteMachine, viewMode: 'visual' }) })]) })
    expect(parsed.workspaces[0]?.closedTabs[0]?.state?.machineId).toBe(remoteMachine)
    expect(parsed.drafts[0]).toMatchObject({ machineId: remoteMachine, viewState: null })
    expect(parsed.drafts[0]?.content).toBe('client_secret=top-secret')
    expect(parsed.documents?.[0]).toEqual(source.documents?.[0])
    expect(parsed.drafts[1]?.content).toBe('Bearer source literal')
    expect(parsed.agents[0]?.transcript).toBe('Bearer [REDACTED]')
    expect(parsed.agents[0]?.projection).toMatchObject({ phase: 'disconnected', queuedPrompts: [], pendingSteering: [], view: 'visual' })
    expect(parsed.agents[0]?.projection?.items[0]?.data).toMatchObject({ attachments: [{ remoteFile: { machineId: remoteMachine, projectId: 'project-one', path: 'src/file.ts' } }] })
    const tool = parsed.agents[0]?.projection?.items.find(item => item.id === 'tool-one')
    expect(tool?.data).toMatchObject({ type: 'tool', status: 'interrupted' })
    expect(JSON.stringify(tool)).not.toContain('artifact-one')
    expect(source.drafts[0]).toEqual(originalDraft)
    expect(parsed.agents[0]?.projection?.settings).toMatchObject({ permission: 'default', sandbox: 'read-only', approvalPolicy: 'on-request' })
  })

  it('defaults legacy draft and agent placement to local', () => {
    const archive = fixture()
    delete archive.drafts[0]!.machineId
    delete archive.agents[0]!.spec.machineId
    archive.agents[0]!.spec.cwd = archive.projects[0]!.path
    const firstItem = archive.agents[0]!.projection!.items[0]
    if (firstItem?.data.type === 'text') delete firstItem.data.attachments
    const group = archive.workspaces[0]!.layout.root
    if (group.type === 'group') group.tabs.forEach(tab => { if (tab.state) delete tab.state.machineId })
    const parsed = parseSessionArchive(JSON.stringify(archive))
    expect(parsed.drafts[0]?.machineId).toBe('local')
    expect(parsed.agents[0]?.spec.machineId).toBe('local')
  })

  it('rejects invalid machine identities, local cwd changes, and cross-workspace pointers', () => {
    const badMachine = fixture(); badMachine.drafts[0]!.machineId = '../peer'
    expect(() => parseSessionArchive(JSON.stringify(badMachine))).toThrow('invalid identity')
    const badCwd = fixture(); badCwd.agents[0]!.spec.machineId = 'local'
    expect(() => parseSessionArchive(JSON.stringify(badCwd))).toThrow('local agent cwd differs')
    const badFocus = fixture(); badFocus.selection.focusedGroupIds['workspace-one'] = 'missing-group'
    expect(() => parseSessionArchive(JSON.stringify(badFocus))).toThrow('focused group')
  })

  it('keeps composite reducer identities on timeline items', () => {
    const archive = fixture()
    const composite = JSON.stringify(['runtime-one', 'native-one', '', 'item-one', 'text'])
    archive.agents[0]!.projection!.items[0]!.id = composite
    const parsed = parseSessionArchive(JSON.stringify(archive))
    expect(parsed.agents[0]?.projection?.items[0]?.id).toBe(composite)
  })

  it('validates timeline payload shape before history can render', () => {
    const archive = fixture()
    archive.agents[0]!.projection!.sequence = 3
    archive.agents[0]!.projection!.items.push({ id: 'plan-one', runtimeId: 'runtime-one', sequence: 3, timestamp: at, data: { type: 'plan', steps: 'not-a-list' } } as never)
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('invalid list')
  })

  it('validates closed tabs and known draft tabs against their owning project', () => {
    const archive = fixture()
    archive.projects.push({ id: 'project-two', name: 'Other', path: 'C:\\other\\reference', createdAt: at, updatedAt: at })
    archive.workspaces.push({ id: 'workspace-two', projectId: 'project-two', name: 'Other workspace', layout: { version: 1, root: { type: 'group', id: 'group-two', activeTabId: 'other-code', tabs: [{ id: 'other-code', kind: 'code', title: 'Other file', resourceId: 'other.ts', state: { path: 'other.ts', machineId: 'local' } }] } }, maximizedGroupId: null, closedTabs: [{ id: 'borrowed-agent', kind: 'agent', title: 'Borrowed', resourceId: 'agent-one', state: { machineId: remoteMachine } }], continueOnLimit: false, createdAt: at, updatedAt: at })
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('agent tab crosses project/workspace')

    archive.workspaces[1]!.closedTabs = []
    archive.drafts[0]!.tabId = 'other-code'
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('draft differs from its tab')
  })

  it('rejects a workspace document draft with a different path or machine', () => {
    const archive = fixture()
    archive.drafts[1]!.path = 'src/borrowed.ts'
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('draft differs from its tab')
    archive.drafts[1]!.path = 'src/document.ts'
    archive.drafts[1]!.machineId = 'local'
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('draft differs from its tab')
  })

  it('requires detached document owners to exist and match their project', () => {
    const archive = fixture()
    archive.detached.push({
      id: 'detached-one', projectId: 'project-one', sessionId: 'workspace-one',
      layout: { version: 1, root: { type: 'group', id: 'detached-group', activeTabId: 'detached-tab', tabs: [{ id: 'detached-tab', kind: 'code', title: 'Detached', state: { path: 'src/detached.ts', machineId: remoteMachine } }] } },
      maximizedGroupId: null, createdAt: at, updatedAt: at
    })
    archive.documents!.push({
      workspaceId: 'detached:detached-one',
      files: [{ id: 'document:detached:detached-one:doc-two', machineId: remoteMachine, projectId: 'project-one', path: 'src/detached.ts', mode: 'editor' }],
      activeId: 'document:detached:detached-one:doc-two'
    })
    expect(parseSessionArchive(JSON.stringify(archive)).documents?.[1]?.workspaceId).toBe('detached:detached-one')

    const missing = structuredClone(archive)
    missing.documents![1]!.workspaceId = 'detached:missing-window'
    expect(() => parseSessionArchive(JSON.stringify(missing))).toThrow('document state points outside the desk')

    const crossed = structuredClone(archive)
    crossed.projects.push({ id: 'project-two', name: 'Other', path: 'C:\\other', createdAt: at, updatedAt: at })
    crossed.documents![1]!.files[0]!.projectId = 'project-two'
    expect(() => parseSessionArchive(JSON.stringify(crossed))).toThrow('document differs from its owner project')
  })

  it('rejects controller paths/content and mismatched identity on remote history attachments', () => {
    const archive = fixture() as any
    archive.agents[0].projection.items[0].data.attachments[0].content = 'controller bytes'
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('invalid remote history attachment')
    delete archive.agents[0].projection.items[0].data.attachments[0].content
    archive.agents[0].projection.items[0].data.attachments[0].remoteFile.machineId = 'other-machine'
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('crosses project/machine')
  })

  it('accepts a machine-aware WorkspaceFiles document draft without requiring a pane tab', () => {
    const archive = fixture()
    archive.drafts[0]!.tabId = 'workspace-document-one'
    expect(parseSessionArchive(JSON.stringify(archive)).drafts[0]).toMatchObject({ tabId: 'workspace-document-one', machineId: remoteMachine })
  })

  it('rejects identities reused across owned archive object kinds', () => {
    const archive = fixture()
    archive.agents[0]!.spec.id = archive.projects[0]!.id
    if (archive.workspaces[0]!.layout.root.type === 'group') archive.workspaces[0]!.layout.root.tabs[0]!.resourceId = archive.projects[0]!.id
    archive.agents[0]!.projection!.sessionId = archive.projects[0]!.id
    expect(() => parseSessionArchive(JSON.stringify(archive))).toThrow('duplicate object identity')
  })

  it('marks imported terminals and browsers dormant and strips command-bearing state', () => {
    const archive = fixture(), workspace = archive.workspaces[0]!
    if (workspace.layout.root.type !== 'group') throw new Error('fixture layout')
    workspace.layout.root.tabs.push(
      { id: 'terminal-tab', kind: 'terminal', title: 'Terminal', resourceId: 'terminal-one', state: { startupCommand: 'remove everything', shell: 'evil.exe' } },
      { id: 'browser-tab', kind: 'browser', title: 'Browser', state: { url: 'https://owner:password@example.test/private?view=wide&access_token=secret#bearer' } }
    )
    const parsed = parseSessionArchive(JSON.stringify(archive)), root = parsed.workspaces[0]!.layout.root
    if (root.type !== 'group') throw new Error('parsed layout')
    expect(root.tabs.find(tab => tab.id === 'terminal-tab')?.state).toEqual({ archiveDormant: true })
    expect(root.tabs.find(tab => tab.id === 'browser-tab')?.state).toEqual({ url: 'https://example.test/private?view=wide&access_token=%5BREDACTED%5D', archiveDormant: true })
  })

  it('writes selected fields atomically and preserves credential-like source literals byte-for-byte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-session-archive-'))
    try {
      const path = join(root, 'desk.conductor-session')
      const source = fixture() as SessionArchive & { credentials?: unknown }
      source.credentials = { controlToken: 'must-not-export' }
      source.name = 'client_secret=desk-name'
      source.projects[0]!.name = 'client_secret=project-name'
      source.projects[0]!.path = 'C:\\client_secret=project-path'
      source.drafts[0]!.content = 'const client_secret = "top-secret";\r\nconst bearer = `Bearer abc`;\n'
      source.drafts[0]!.baseContent = 'const client_secret = "old-secret";\r\n'
      await writeSessionArchive(path, source)
      const imported = await readSessionArchive(path)
      expect(imported.name).toBe(source.name)
      expect(imported.projects[0]).toMatchObject({ name: source.projects[0]!.name, path: source.projects[0]!.path })
      expect(imported.drafts[0]?.content).toBe(source.drafts[0]!.content)
      expect(imported.drafts[0]?.baseContent).toBe(source.drafts[0]!.baseContent)
      const serialized = readFileSync(path, 'utf8')
      expect(serialized).not.toContain('very-secret')
      expect(serialized).not.toContain('must-not-export')
      expect(serialized).toContain('top-secret')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
