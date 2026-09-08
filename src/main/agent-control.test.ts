import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from './agent-control'
import { AgentControlServer } from './agent-control-server'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { OrchestrationStore } from './orchestration-store'
import { AgentCollaborationStore } from './agent-collaboration-store'
import { ProjectBacklogs } from './project-backlog'
import type { AgentControlScope, AgentControlTab, AgentControlUiRequest } from '../shared/agent-control'
import type { AgentProviderInfo, AgentSpec, PaneTab } from '../shared/models'
import type { ProviderCapabilities, StructuredProvider } from '../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs() })
function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-control-')), projectPath = join(root, 'project')
  mkdirSync(projectPath)
  dispose.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(root, 'conductor.db'), database = new ConductorDatabase(path)
  dispose.push(() => database.close())
  const project = database.upsertProject(projectPath, 'Control project'), workspace = database.listSessions(project.id)[0]!
  const orchestration = new OrchestrationStore(path), collaboration = new AgentCollaborationStore(path)
  dispose.push(() => orchestration.close(), () => collaboration.close())
  const submissions: Array<{ provider: StructuredProvider; prompt: string; options: AdapterOptions }> = []
  const broadcast = vi.fn()
  const sessions = new StructuredSessions(database, () => 'synthetic-provider', broadcast, (provider, options): ProviderAdapter => {
    const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: ['default', 'read-only', 'accept-edits'], sandboxModes: ['inherit', 'read-only', 'workspace-write'], effort: ['low'], models: [{ id: provider + '-synthetic', label: provider + ' Synthetic', effort: ['low'], defaultEffort: 'low' }], limitations: ['Zero inference fixture'] }
    return { provider, capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-' + options.runtimeId } }) },
      submit: async prompt => { submissions.push({ provider, prompt, options }); options.emit({ itemId: 'result', data: { type: 'text', role: 'assistant', text: 'Native fixture result', mode: 'snapshot' } }); options.emit({ data: { type: 'session', phase: 'completed' } }) }, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  })
  dispose.push(() => sessions.dispose())
  const scope = { projectId: project.id, sessionId: workspace.id, agentSessionId: 'controller' }
  const spec: AgentSpec = { id: scope.agentSessionId, projectId: project.id, sessionId: workspace.id, cwd: project.path, provider: 'codex', title: 'Controller', model: 'codex-synthetic' }
  sessions.ensure(spec)
  const rootTab: PaneTab = { id: 'controller-tab', kind: 'agent', resourceId: spec.id, title: spec.title, state: { provider: spec.provider, model: spec.model } }
  database.saveSession(workspace.id, { version: 1, root: { type: 'group', id: 'group', activeTabId: rootTab.id, tabs: [rootTab] } }, null, [])
  const requests: AgentControlUiRequest[] = []
  const ui = vi.fn(async (request: AgentControlUiRequest) => {
    requests.push(request)
    if (request.action === 'tabs.open') {
      const current = database.getSession(request.sessionId)!, tab = request.params.tab as PaneTab
      if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
      current.layout.root.tabs.push(tab); current.layout.root.activeTabId = tab.id
      database.saveSession(request.sessionId, current.layout, null, [])
      return { tabId: tab.id }
    }
    return { applied: true }
  })
  const confirm = vi.fn(async () => false), fileChanged = vi.fn()
  const providers: AgentProviderInfo[] = (['codex', 'claude'] as const).map(id => ({ id, displayName: id, available: true, installUrl: '', models: [{ id: id + '-synthetic', label: id + ' Synthetic' }], efforts: [{ id: 'low', label: 'Low' }] }))
  const backlogs = new ProjectBacklogs(database)
  const deps = { database, sessions, orchestration, collaboration, backlogs, ui, confirm, fileChanged, providers: () => providers }
  const control = new AgentControl(deps)
  return { root, project, workspace, database, sessions, orchestration, collaboration, submissions, scope, spec, rootTab, requests, ui, confirm, fileChanged, control, deps }
}

describe('authorized native app control', () => {
  it('refuses foreign projects/workspaces, hidden sessions and closed callers', async () => {
    const f = fixture()
    const otherPath = join(f.root, 'other'); mkdirSync(otherPath)
    const other = f.database.upsertProject(otherPath, 'Other'), otherWorkspace = f.database.listSessions(other.id)[0]!
    await expect(f.control.call(f.scope, 'tabs.list', { projectId: other.id })).rejects.toThrow('scope')
    await expect(f.control.call({ ...f.scope, sessionId: otherWorkspace.id }, 'app.state')).rejects.toThrow('scope')
    const hidden = { ...f.spec, id: 'hidden' }; f.sessions.ensure(hidden)
    await expect(f.control.call(f.scope, 'agents.submit', { agentSessionId: hidden.id, prompt: 'Do work' })).rejects.toThrow('visible tab')
    await expect(f.control.call(f.scope, 'agents.submit', { agentSessionId: f.spec.id, prompt: 'Loop' })).rejects.toThrow('itself')
    f.database.closeSession(f.workspace.id)
    await expect(f.control.call(f.scope, 'models.list')).rejects.toThrow('scope')
    expect(f.submissions).toHaveLength(0)
  })

  it('runs the router through persisted definitions, visible tabs and native turn events', async () => {
    const f = fixture()
    const started = await f.control.call(f.scope, 'router.start', { prompt: 'Coordinate this bounded fixture', provider: 'codex', model: 'codex-synthetic' }) as { tab: AgentControlTab; taskId: string }
    expect(f.orchestration.listAgents(f.project.id).some(agent => agent.role === 'conductor-router')).toBe(true)
    expect(f.orchestration.listRoutines(f.project.id)).toHaveLength(1)
    expect(f.orchestration.listRuns(f.project.id)).toHaveLength(1)
    const routerScope: AgentControlScope = { ...f.scope, agentSessionId: started.tab.resourceId! }
    const result = await f.control.call(routerScope, 'router.dispatch', { tasks: [{ title: 'Claude review', prompt: 'Review this bounded fixture', provider: 'claude', model: 'claude-synthetic', effort: 'low' }] }) as Array<{ tabId: string; agentSessionId: string; taskId: string }>
    const child = result[0]!
    expect(f.control.tabs(f.scope).some(tab => tab.id === child.tabId && tab.resourceId === child.agentSessionId)).toBe(true)
    expect(f.submissions.map(submission => submission.provider)).toEqual(['codex', 'claude'])
    expect(f.submissions[1]?.prompt).toContain(child.taskId)
    expect(f.database.structured.snapshot(child.agentSessionId)?.items).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ type: 'text', role: 'user' }) }), expect.objectContaining({ data: expect.objectContaining({ type: 'text', role: 'assistant', text: 'Native fixture result' }) })]))
    expect(f.control.listLinks(f.project.id, f.workspace.id)).toHaveLength(2)
    await expect(f.control.call({ ...f.scope, agentSessionId: child.agentSessionId }, 'agents.submit', { agentSessionId: f.scope.agentSessionId, prompt: 'Cycle' })).rejects.toThrow('ancestor')
    for (let index = 0; index < 220; index++) f.collaboration.postMessage({ ...f.scope, kind: 'activity', body: 'Additional activity ' + index })
    const recovered = new AgentControl(f.deps)
    expect(recovered.listLinks(f.project.id, f.workspace.id)).toHaveLength(2)
    await expect(recovered.call(f.scope, 'agents.submit', { agentSessionId: child.agentSessionId, prompt: 'Competing owner' })).rejects.toThrow('Another agent')
    recovered.releaseByOwner(child.agentSessionId)
    expect(recovered.listLinks(f.project.id, f.workspace.id)).toHaveLength(1)
  })

  it('requires owner confirmation before closing another tab and never closes the caller', async () => {
    const f = fixture(), target = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    await expect(f.control.call(f.scope, 'tabs.close', { tabId: f.rootTab.id })).rejects.toThrow('itself')
    await expect(f.control.call(f.scope, 'tabs.close', { tabId: target.id })).rejects.toThrow('declined')
    expect(f.requests.filter(request => request.action === 'tabs.close')).toHaveLength(0)
    f.confirm.mockResolvedValue(true)
    await f.control.call(f.scope, 'tabs.close', { tabId: target.id })
    expect(f.requests.filter(request => request.action === 'tabs.close')).toHaveLength(1)
  })

  it('compares file versions, announces live changes and rejects escapes and competing leases', async () => {
    const f = fixture(), file = join(f.project.path, 'notes.md')
    writeFileSync(file, 'original')
    const read = await f.control.call(f.scope, 'files.read', { path: 'notes.md' }) as { content: string; uri: string }
    expect(read.content).toBe('original')
    await f.control.call(f.scope, 'files.open', { path: file })
    expect(f.requests.at(-1)?.params.path).toBe('notes.md')
    await f.control.openUri(read.uri)
    expect(f.requests.at(-1)?.params.path).toBe('notes.md')
    expect(await f.control.call(f.scope, 'files.write', { path: 'notes.md', content: 'new', expectedContent: 'stale' })).toMatchObject({ status: 'conflict' })
    expect(readFileSync(file, 'utf8')).toBe('original')
    expect(await f.control.call(f.scope, 'files.write', { path: 'notes.md', content: 'new', expectedContent: read.content })).toMatchObject({ status: 'saved' })
    expect(f.fileChanged).toHaveBeenCalledWith(expect.objectContaining({ projectId: f.project.id, path: 'notes.md' }))
    await expect(f.control.call(f.scope, 'files.read', { path: '../conductor.db' })).rejects.toThrow('outside')
    const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret'), 'outside')
    symlinkSync(outside, join(f.project.path, 'escape'), 'junction')
    await expect(f.control.call(f.scope, 'files.read', { path: 'escape/secret' })).rejects.toThrow('leaves')
    const child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    await expect(f.control.call({ ...f.scope, agentSessionId: child.resourceId! }, 'files.write', { path: 'notes.md', content: 'competing', expectedContent: 'new' })).rejects.toThrow('lease')
    f.database.structured.update(f.spec.id, { settings: { permission: 'read-only', plan: false } })
    await expect(f.control.call(f.scope, 'files.write', { path: 'notes.md', content: 'forbidden', expectedContent: 'new' })).rejects.toThrow('read-only')
  })

  it.each([{ permission: 'default' as const, sandbox: 'read-only' as const, plan: false }, { permission: 'default' as const, plan: true }])('propagates restrictive runtime settings and prevents filesystem or delegation bypass: %j', async settings => {
    const f = fixture()
    const existing = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    f.database.structured.update(f.spec.id, { settings })
    await expect(f.control.call(f.scope, 'files.write', { path: 'new.md', content: 'forbidden', expectedContent: null })).rejects.toThrow('read-only')
    await expect(f.control.call(f.scope, 'agents.submit', { agentSessionId: existing.resourceId, prompt: 'Writable delegate' })).rejects.toThrow('read-only')
    const child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    expect(f.database.structured.snapshot(child.resourceId!)?.settings).toMatchObject({ permission: 'read-only', sandbox: 'read-only' })
  })

  it('preserves human memories and checklist ownership during agent writes', async () => {
    const f = fixture()
    const human = f.database.remember({ projectId: f.project.id, kind: 'semantic', gist: 'Keep project conventions', cues: ['project', 'conventions'] })
    const memory = await f.control.call(f.scope, 'memory.remember', { gist: 'Keep project conventions', cues: ['project', 'conventions'] }) as { id: string; source: string }
    expect(memory.source).toBe('agent'); expect(memory.id).not.toBe(human.id)
    await expect(f.control.call(f.scope, 'memory.forget', { id: human.id })).rejects.toThrow('agent-authored')
    writeFileSync(join(f.project.path, 'feature-list.md'), '## Features\n1. [ ] One <!-- conductor-task:one -->\n2. [~] Two <!-- conductor-task:two agent=another -->\n')
    const board = await f.deps.backlogs.get(f.project.id)
    await f.control.call(f.scope, 'tasks.update', { revision: board.revision, id: 'one', status: 'doing' })
    expect(readFileSync(join(f.project.path, 'feature-list.md'), 'utf8')).toContain('conductor-task:one agent=controller')
    await expect(f.control.call(f.scope, 'tasks.update', { revision: board.revision, id: 'two', status: 'done' })).rejects.toThrow('owns')
  })

  it('moves resumed hidden history to its visible workspace without losing native identity, settings or protocol authority', async () => {
    const f = fixture()
    const settings = { permission: 'read-only' as const, sandbox: 'read-only' as const, plan: false, model: 'codex-synthetic', effort: 'low' }
    await f.sessions.submit(f.spec.id, 'Saved native history', settings)
    const nativeId = f.database.structured.snapshot(f.spec.id)!.nativeSessionId
    const destination = f.database.createSession(f.project.id, 'Resume here')
    expect(() => f.sessions.bindWorkspace(f.spec.id, destination.id)).toThrow('already open')
    f.database.saveSession(f.workspace.id, { version: 1, root: { type: 'group', id: 'old-group', activeTabId: '', tabs: [] } }, null, [])
    const server = new AgentControlServer(f.control, false); dispose.push(() => server.close()); await server.start()
    const oldBriefing = server.briefing(f.spec)
    f.sessions.bindWorkspace(f.spec.id, destination.id)
    f.database.saveSession(destination.id, { version: 1, root: { type: 'group', id: 'new-group', activeTabId: f.rootTab.id, tabs: [f.rootTab] } }, null, [])
    const movedSpec = f.database.structured.spec<AgentSpec>(f.spec.id)!
    expect(movedSpec.sessionId).toBe(destination.id)
    expect(f.database.listProcesses(f.project.id).find(process => process.id === f.spec.id)?.sessionId).toBe(destination.id)
    expect(f.database.structured.snapshot(f.spec.id)).toMatchObject({ nativeSessionId: nativeId, settings })
    await expect(f.control.call(f.scope, 'tabs.list')).rejects.toThrow('scope')
    const movedScope = { ...f.scope, sessionId: destination.id }
    expect(await f.control.call(movedScope, 'tabs.list')).toEqual(expect.arrayContaining([expect.objectContaining({ resourceId: f.spec.id })]))
    const newBriefing = server.briefing(movedSpec)
    expect(newBriefing.match(/Bearer ([a-f0-9]+)/)?.[1]).not.toBe(oldBriefing.match(/Bearer ([a-f0-9]+)/)?.[1])
    const otherPath = join(f.root, 'foreign'); mkdirSync(otherPath)
    const foreign = f.database.upsertProject(otherPath, 'Foreign')
    expect(() => f.sessions.bindWorkspace(f.spec.id, f.database.listSessions(foreign.id)[0]!.id)).toThrow('project')
  })

  it('resolves exact tab/file/workspace URIs and rejects foreign filesystem paths', async () => {
    const f = fixture()
    await f.control.openUri(`conductor://${f.project.id}/tab/${f.rootTab.id}`)
    expect(f.requests.at(-1)?.params.tabId).toBe(f.rootTab.id)
    await f.control.openUri(`conductor://${f.project.id}/workspace/${f.workspace.id}`)
    expect(f.requests.at(-1)?.action).toBe('workspace.focus')
    await expect(f.control.openUri(`conductor://${f.project.id}/file/${encodeURIComponent('../conductor.db')}`)).rejects.toThrow('outside')
  })
})

describe('local protocol boundary', () => {
  it('authenticates the native briefing and rejects browser origins, malformed bodies and stale authority', async () => {
    const f = fixture(), server = new AgentControlServer(f.control, false)
    dispose.push(() => server.close()); await server.start()
    expect(server.briefing({ ...f.spec, provider: 'gemini' })).toBe('')
    const briefing = server.briefing(f.spec), endpoint = briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)![1]!, token = briefing.match(/Bearer ([a-f0-9]{64})/)![1]!
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
    expect((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403)
    expect((await fetch(endpoint, { method: 'POST', headers, body: '{bad' })).status).toBe(400)
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ method: 'tools.list', args: {} }) })
    expect(response.status).toBe(200); expect(await response.json()).toHaveProperty(['result', 'router.dispatch'])
    const oversized = await fetch(endpoint, { method: 'POST', headers, body: 'x'.repeat(3 * 1024 * 1024 + 1) })
    expect(oversized.status).toBe(413)
    f.database.closeSession(f.workspace.id)
    const stale = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ method: 'tabs.list' }) })
    expect(stale.status).toBe(400)
  })
  it('makes no first-party MCP exception and supplies no protocol authority during isolated live tests', async () => {
    const f = fixture(); vi.stubEnv('CONDUCTOR_LIVE_TESTS', '1')
    const server = new AgentControlServer(f.control)
    await server.start(); expect(server.briefing(f.spec)).toBe('')
    await expect(f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Forbidden', prompt: 'Outside live fixture' }] })).rejects.toThrow('disabled')
    server.close()
  })
})
