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
import type { MachineProjectLink } from '../shared/remote-control'
import type { ProjectIdentity } from '../shared/project-identity'
import type { AgentEventData, ProviderCapabilities, SessionProjection, StructuredProvider } from '../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs(); vi.useRealTimers() })
function fixture(aliasedRoot = false) {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-control-')), canonicalProjectPath = join(root, 'project')
  mkdirSync(canonicalProjectPath)
  const projectPath = aliasedRoot ? join(root, 'project-alias') : canonicalProjectPath
  if (aliasedRoot) symlinkSync(canonicalProjectPath, projectPath, 'junction')
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

/** Give an agent session a visible tab, so its checklist claims count as live. */
const openAgentTab = (f: ReturnType<typeof fixture>, resourceId: string, tabId: string): void => {
  const current = f.database.getSession(f.workspace.id)!
  if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
  current.layout.root.tabs.push({ id: tabId, kind: 'agent', resourceId, title: resourceId, state: { provider: 'codex', model: 'codex-synthetic' } })
  f.database.saveSession(f.workspace.id, current.layout, null, [])
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

  it('observes coworker identity and fresh native execution results, including detached and older updated tools', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'))
    const f = fixture(), child = await f.control.call(f.scope, 'tabs.open', { provider: 'claude' }) as AgentControlTab
    const detached = f.database.createDetachedWindow(f.project.id, f.workspace.id, child)
    const append = (data: AgentEventData, itemId?: string): void => {
      const sequence = f.database.structured.snapshot(child.resourceId!)!.sequence + 1
      f.database.structured.append({ schemaVersion: 1, id: 'event-' + sequence, sequence, sessionId: child.resourceId!, runtimeId: 'runtime-coworker', provider: 'claude', projectId: f.project.id, workspaceId: f.workspace.id, cwd: f.project.path, timestamp: new Date().toISOString(), itemId, data })
    }
    append({ type: 'session', phase: 'running' })
    append({ type: 'tool', name: 'Bash', status: 'running', input: { command: 'test fixture' } }, 'long-tool')
    const startedAt = new Date().toISOString()
    for (let index = 0; index < 65; index++) append({ type: 'text', role: 'status', text: 'Concurrent activity ' + index, mode: 'snapshot' })
    const active = await f.control.call(f.scope, 'agents.snapshot', { agentSessionId: child.resourceId }) as SessionProjection & { activeTools: SessionProjection['items'] }
    expect(active.activeTools).toEqual([expect.objectContaining({ nativeItemId: 'long-tool', data: expect.objectContaining({ status: 'running' }) })])
    vi.setSystemTime(new Date('2026-09-08T10:01:00.000Z'))
    append({ type: 'tool', name: 'Bash', status: 'failed', output: 'Fixture failed', exitCode: 7 }, 'long-tool')
    const lastActivityAt = new Date().toISOString()
    vi.setSystemTime(new Date('2026-09-08T10:02:00.000Z'))
    const observedAt = new Date().toISOString()
    expect(await f.control.call(f.scope, 'app.state')).toMatchObject({ observedAt, projectId: f.project.id, workspaceId: f.workspace.id })
    expect(await f.control.call(f.scope, 'agents.list')).toEqual(expect.arrayContaining([expect.objectContaining({ observedAt, source: 'native-session', projectId: f.project.id, workspaceId: f.workspace.id, tabId: child.id, detachedId: detached.id, agentSessionId: child.resourceId, provider: 'claude', phase: 'running', lastActivityAt, lastEvent: expect.objectContaining({ type: 'tool', status: 'failed', exitCode: 7 }) })]))
    const snapshot = await f.control.call(f.scope, 'agents.snapshot', { agentSessionId: child.resourceId }) as SessionProjection & { observedAt: string; lastActivityAt: string; activeTools: SessionProjection['items'] }
    expect(snapshot).toMatchObject({ observedAt, lastActivityAt, phase: 'running', truncated: true, activeTools: [] })
    expect(snapshot.items).toHaveLength(60)
    expect(snapshot.items.find(item => item.nativeItemId === 'long-tool')).toMatchObject({ timestamp: startedAt, data: { type: 'tool', status: 'failed', output: 'Fixture failed', exitCode: 7 } })
    append({ type: 'session', phase: 'idle' })
    expect(await f.control.call(f.scope, 'agents.list')).toEqual(expect.arrayContaining([expect.objectContaining({ agentSessionId: child.resourceId, phase: 'idle', lastActivityAt: observedAt })]))
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

  it.each([false, true])('compares file versions, announces live changes and rejects escapes and competing leases (aliased root: %s)', async aliasedRoot => {
    const f = fixture(aliasedRoot), file = join(f.project.path, 'notes.md')
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

  it('opens controlled tabs with the controller autonomy rather than leaving every one of them on ask', async () => {
    const f = fixture()
    f.database.structured.update(f.spec.id, { settings: { permission: 'auto', plan: false } })
    const inherited = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    const settings = f.database.structured.snapshot(inherited.resourceId!)!.settings
    // The fixture provider stops at accept-edits, so a controller on auto is clamped there, not dropped to ask.
    expect(settings).toMatchObject({ permission: 'accept-edits', plan: false })
    expect(settings.sandbox).toBeUndefined()
    f.database.structured.update(f.spec.id, { settings: { permission: 'accept-edits', plan: false, temporaryPermission: { runtimeId: 'earlier-runtime', restore: 'default' } } })
    const guarded = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    expect(f.database.structured.snapshot(guarded.resourceId!)?.settings).toMatchObject({ permission: 'default' })
  })

  it('preserves human memories and checklist ownership during agent writes', async () => {
    const f = fixture()
    const human = f.database.remember({ projectId: f.project.id, kind: 'semantic', gist: 'Keep project conventions', cues: ['project', 'conventions'] })
    const memory = await f.control.call(f.scope, 'memory.remember', { gist: 'Keep project conventions', cues: ['project', 'conventions'] }) as { id: string; source: string }
    expect(memory.source).toBe('agent'); expect(memory.id).not.toBe(human.id)
    await expect(f.control.call(f.scope, 'memory.forget', { id: human.id })).rejects.toThrow('agent-authored')
    writeFileSync(join(f.project.path, 'feature-list.md'), '## Features\n1. [ ] One <!-- conductor-task:one -->\n2. [~] Two <!-- conductor-task:two agent=another -->\n')
    openAgentTab(f, 'another', 'another-tab')
    const board = await f.deps.backlogs.get(f.project.id)
    await f.control.call(f.scope, 'tasks.update', { revision: board.revision, id: 'one', status: 'doing' })
    expect(readFileSync(join(f.project.path, 'feature-list.md'), 'utf8')).toContain('conductor-task:one agent=controller')
    await expect(f.control.call(f.scope, 'tasks.update', { revision: board.revision, id: 'two', status: 'done' })).rejects.toThrow('owns')
  })

  it('releases a claim whose owning conversation is no longer open anywhere in the project', async () => {
    const f = fixture()
    writeFileSync(join(f.project.path, 'feature-list.md'), '## Features\n1. [~] Stalled <!-- conductor-task:stalled agent=departed -->\n')
    const board = await f.deps.backlogs.get(f.project.id)
    const updated = await f.control.call(f.scope, 'tasks.update', { revision: board.revision, id: 'stalled', status: 'done' }) as { tasks: Array<{ id: string; status: string }> }
    expect(updated.tasks.find(task => task.id === 'stalled')?.status).toBe('done')
    expect(readFileSync(join(f.project.path, 'feature-list.md'), 'utf8')).toContain('conductor-task:stalled agent=controller')
  })

  it('lets an agent set task priority, and refuses a value the backlog would silently discard', async () => {
    const f = fixture()
    writeFileSync(join(f.project.path, 'feature-list.md'), '## Bugs\n1. [ ] Sortable <!-- conductor-task:sortable -->\n')
    const board = await f.deps.backlogs.get(f.project.id)
    await expect(f.control.call(f.scope, 'tasks.update', { revision: board.revision, id: 'sortable', priority: 'urgent' })).rejects.toThrow('priority')
    expect(readFileSync(join(f.project.path, 'feature-list.md'), 'utf8')).not.toContain('priority=')
    const updated = await f.control.call(f.scope, 'tasks.update', { revision: board.revision, id: 'sortable', priority: 'high' }) as { tasks: Array<{ id: string; priority: string }> }
    expect(updated.tasks.find(task => task.id === 'sortable')?.priority).toBe('high')
    expect(readFileSync(join(f.project.path, 'feature-list.md'), 'utf8')).toContain('priority=high')
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

describe('Project task handoff through native router dispatch', () => {
  it('transfers only accepted exact task claims to a visible worker with the selected effort', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'project', 'feature-list.md'), '- [~] Selected task <!-- conductor-task:selected agent=controller -->\n- [~] Coworker task <!-- conductor-task:other agent=coworker -->\n')
    const result = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Selected work', prompt: 'Complete the selected task', provider: 'claude', model: 'claude-synthetic', effort: 'low', projectTaskIds: ['selected'] }] }) as Array<{ accepted: boolean; agentSessionId: string; projectTaskIds: string[]; effort: string }>
    expect(result[0]).toMatchObject({ accepted: true, projectTaskIds: ['selected'], effort: 'low' })
    expect(f.requests.find(request => request.action === 'tabs.open')?.params.focus).toBe(false)
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0]?.prompt).toContain('Exact Project tasks assigned to this worker: selected')
    const board = await f.deps.backlogs.get(f.project.id)
    expect(board.tasks.find(task => task.id === 'selected')).toMatchObject({ status: 'doing', agentId: result[0]!.agentSessionId })
    expect(board.tasks.find(task => task.id === 'selected')!.activity[0]).toMatchObject({ actor: 'agent', agentId: 'controller', agentTitle: 'Controller', assignedAgentId: result[0]!.agentSessionId })
    expect((await f.deps.backlogs.get(f.project.id)).tasks.find(task => task.id === 'selected')!.activity).toEqual(board.tasks.find(task => task.id === 'selected')!.activity)
    expect(board.tasks.find(task => task.id === 'other')).toMatchObject({ status: 'doing', agentId: 'coworker' })
    const finished = await f.control.call({ ...f.scope, agentSessionId: result[0]!.agentSessionId }, 'tasks.update', { revision: board.revision, id: 'selected', status: 'done' }) as { tasks: Array<{ id: string; status: string }> }
    expect(finished.tasks.find(task => task.id === 'selected')?.status).toBe('done')
  })
  it('rejects missing, finished, competing active, and duplicate task IDs before any new tab or prompt', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'project', 'feature-list.md'), '- [~] Mine <!-- conductor-task:mine agent=controller -->\n- [~] Other <!-- conductor-task:other agent=coworker -->\n- [x] Done <!-- conductor-task:done -->\n')
    const worker = { title: 'Worker', prompt: 'Selected work', provider: 'claude', model: 'claude-synthetic', effort: 'low' }
    for (const id of ['absent', 'other', 'done']) await expect(f.control.call(f.scope, 'router.dispatch', { tasks: [{ ...worker, projectTaskIds: [id] }] })).rejects.toThrow('missing, finished, or owned')
    await expect(f.control.call(f.scope, 'router.dispatch', { tasks: [{ ...worker, projectTaskIds: ['mine'] }, { ...worker, projectTaskIds: ['mine'] }] })).rejects.toThrow('distinct')
    expect(f.control.tabs(f.scope)).toHaveLength(1)
    expect(f.submissions).toHaveLength(0)
  })
  it('retains the original task claim and visible worker after a native dispatch refusal without retrying', async () => {
    const f = fixture()
    writeFileSync(join(f.root, 'project', 'feature-list.md'), '- [~] Mine <!-- conductor-task:mine agent=controller -->\n')
    const submit = vi.spyOn(f.sessions, 'submit').mockRejectedValueOnce(new Error('Synthetic dispatch refusal'))
    const result = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Worker', prompt: 'Selected work', provider: 'claude', model: 'claude-synthetic', effort: 'low', projectTaskIds: ['mine'] }] }) as Array<{ accepted: boolean; error: string }>
    expect(result[0]).toMatchObject({ accepted: false, error: 'Synthetic dispatch refusal' })
    expect(submit).toHaveBeenCalledOnce()
    expect((await f.deps.backlogs.get(f.project.id)).tasks[0]).toMatchObject({ agentId: 'controller', status: 'doing' })
    expect(f.control.tabs(f.scope)).toHaveLength(2)
  })
})


/** Puts the controlling tab on a named machine, the way a remotely placed tab would be. */
const placeControllerOn = (f: ReturnType<typeof fixture>, machineId: string): void => {
  const current = f.database.getSession(f.workspace.id)!
  if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
  const tab = current.layout.root.tabs.find(candidate => candidate.resourceId === f.scope.agentSessionId)!
  tab.state = { ...tab.state, machineId }
  f.database.saveSession(f.workspace.id, current.layout, null, [])
}

describe('which machine a controlled tab runs on', () => {
  const MACHINES = [
    { id: 'local', name: 'This Laptop', kind: 'local' as const, status: 'online' as const, accountLogin: null, projects: [] },
    { id: 'render-desktop', name: 'Render Desktop', kind: 'peer' as const, status: 'online' as const, accountLogin: 'Empire024', projects: [] },
    { id: 'studio', name: 'Studio', kind: 'peer' as const, status: 'revoked' as const, accountLogin: 'Empire024', projects: [] }
  ]
  /** The owner-confirmed pair of projects, plus what the other machine currently advertises. */
  const link = (localProjectId: string): MachineProjectLink => {
    const remote: ProjectIdentity = { key: 'b'.repeat(32), keyCreatedAt: '2026-02-02T00:00:00.000Z', path: '/renders/conductor', name: 'Conductor' }
    return {
      grant: {
        localProjectId,
        local: { key: 'a'.repeat(32), keyCreatedAt: '2026-01-01T00:00:00.000Z', path: '/laptop/conductor', name: 'Conductor' },
        remoteProjectId: 'remote-project',
        remote,
        confirmedAt: '2026-02-03T00:00:00.000Z'
      },
      observed: remote
    }
  }
  const withMachines = (f: ReturnType<typeof fixture>) => {
    const openRemote = vi.fn(async (machineId: string) => ({ tabId: 'remote-tab', agentSessionId: 'remote-agent', machineName: machineId === 'render-desktop' ? 'Render Desktop' : machineId }))
    const machines = MACHINES.map(machine => ({ ...machine, projects: machine.kind === 'peer' ? [link(f.project.id)] : [] }))
    return { openRemote, control: new AgentControl({ ...f.deps, machines: () => machines, openRemote }) }
  }

  it('records this machine on a tab a local controller opens', async () => {
    const f = fixture()
    const { control, openRemote } = withMachines(f)
    const tab = await control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic' }) as AgentControlTab
    expect(tab.state?.machineId).toBe('local')
    expect(openRemote).not.toHaveBeenCalled()
  })

  it('keeps a child tab on the same machine as the controller that opened it', async () => {
    const f = fixture()
    placeControllerOn(f, 'render-desktop')
    const { control, openRemote } = withMachines(f)
    const result = await control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic' }) as { machineId: string; remote: boolean }
    expect(result).toMatchObject({ machineId: 'render-desktop', remote: true, machineName: 'Render Desktop' })
    expect(openRemote).toHaveBeenCalledWith('render-desktop', expect.objectContaining({ projectId: f.project.id, sessionId: f.workspace.id }))
    // The inherited placement never creates a second local agent tab.
    expect(control.tabs(f.scope)).toHaveLength(1)
  })

  it('moves a child tab only when the caller names a machine explicitly', async () => {
    const f = fixture()
    placeControllerOn(f, 'render-desktop')
    const { control, openRemote } = withMachines(f)
    const tab = await control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic', machineId: 'local' }) as AgentControlTab
    expect(tab.state?.machineId).toBe('local')
    expect(openRemote).not.toHaveBeenCalled()
  })

  it('refuses an unknown or revoked machine instead of quietly running the work here', async () => {
    const f = fixture()
    const { control, openRemote } = withMachines(f)
    await expect(control.call(f.scope, 'tabs.open', { machineId: 'nowhere' })).rejects.toThrow(/machines.list/)
    await expect(control.call(f.scope, 'tabs.open', { machineId: 'studio' })).rejects.toThrow(/revoked|not paired/)
    expect(openRemote).not.toHaveBeenCalled()
    expect(control.tabs(f.scope)).toHaveLength(1)
  })

  it('falls back to this machine when the controller machine is no longer paired', async () => {
    const f = fixture()
    placeControllerOn(f, 'a-machine-that-vanished')
    const { control } = withMachines(f)
    const tab = await control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic' }) as AgentControlTab
    expect(tab.state?.machineId).toBe('local')
  })

  it('refuses to place a tab on a machine this project was never paired with', async () => {
    const f = fixture()
    const openRemote = vi.fn()
    const control = new AgentControl({ ...f.deps, openRemote, machines: () => [
      { id: 'local', name: 'This Laptop', kind: 'local', status: 'online', accountLogin: null, projects: [] },
      { id: 'render-desktop', name: 'Render Desktop', kind: 'peer', status: 'online', accountLogin: 'Empire024', projects: [link('some-other-project')] }
    ] })
    await expect(control.call(f.scope, 'tabs.open', { machineId: 'render-desktop' })).rejects.toThrow(/has not been told which of its projects this one is/)
    expect(openRemote).not.toHaveBeenCalled()
  })

  it('refuses when the paired machine is now sharing a different project under that mapping', async () => {
    const f = fixture()
    const openRemote = vi.fn()
    const mapped = link(f.project.id)
    const control = new AgentControl({ ...f.deps, openRemote, machines: () => [
      { id: 'local', name: 'This Laptop', kind: 'local', status: 'online', accountLogin: null, projects: [] },
      { id: 'render-desktop', name: 'Render Desktop', kind: 'peer', status: 'online', accountLogin: 'Empire024', projects: [{ ...mapped, observed: { ...mapped.grant.remote, key: 'c'.repeat(32) } }] }
    ] })
    await expect(control.call(f.scope, 'tabs.open', { machineId: 'render-desktop' })).rejects.toThrow(/sharing a different project/)
    expect(openRemote).not.toHaveBeenCalled()
  })

  it('tells the caller which machine it is on and which others can run this project', async () => {
    const f = fixture()
    placeControllerOn(f, 'render-desktop')
    const { control } = withMachines(f)
    const machines = await control.call(f.scope, 'machines.list') as Array<{ id: string; current: boolean; runsThisProject: boolean }>
    expect(machines.find(machine => machine.current)?.id).toBe('render-desktop')
    expect(machines.find(machine => machine.id === 'local')?.runsThisProject).toBe(true)
    const state = await control.call(f.scope, 'app.state') as { machineId: string }
    expect(state.machineId).toBe('render-desktop')
  })

  it('reports plainly when this window cannot place tabs on other machines', async () => {
    const f = fixture()
    placeControllerOn(f, 'render-desktop')
    const control = new AgentControl({ ...f.deps, machines: () => [
      { id: 'local', name: 'This Laptop', kind: 'local', status: 'online', accountLogin: null, projects: [] },
      { id: 'render-desktop', name: 'Render Desktop', kind: 'peer', status: 'online', accountLogin: null, projects: [link(f.project.id)] }
    ] })
    await expect(control.call(f.scope, 'tabs.open', {})).rejects.toThrow(/Remote machine placement is unavailable/)
  })
})
