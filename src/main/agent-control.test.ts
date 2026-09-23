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
import { LOCAL_CONNECTION, type MachineProjectLink } from '../shared/remote-control'
import type { ProjectIdentity } from '../shared/project-identity'
import type { AgentEventData, ProviderCapabilities, SessionProjection, StructuredProvider } from '../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs(); vi.useRealTimers() })
function fixture(aliasedRoot = false, permissionsByProvider?: Partial<Record<StructuredProvider, ProviderCapabilities['permissions']>>) {
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
  const submissions: Array<{ provider: StructuredProvider; prompt: string; settings: import('../shared/structured-agent').SessionSettings; options: AdapterOptions }> = []
  const broadcast = vi.fn()
  const sessions = new StructuredSessions(database, () => 'synthetic-provider', broadcast, (provider, options): ProviderAdapter => {
    const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: permissionsByProvider?.[provider] ?? ['default', 'read-only', 'accept-edits'], sandboxModes: ['inherit', 'read-only', 'workspace-write'], effort: ['low', 'high'], models: [{ id: provider + '-synthetic', label: provider + ' Synthetic', effort: ['low'], defaultEffort: 'low' }, { id: provider + '-advanced', label: provider + ' Advanced', effort: ['high'], defaultEffort: 'high' }], limitations: ['Zero inference fixture'] }
    return { provider, capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-' + options.runtimeId } }) },
      submit: async (prompt, settings) => { submissions.push({ provider, prompt, settings: structuredClone(settings), options }); options.emit({ itemId: 'result', data: { type: 'text', role: 'assistant', text: 'Native fixture result', mode: 'snapshot' } }); options.emit({ data: { type: 'session', phase: 'completed' } }) }, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
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
    if (request.action === 'agents.configure') {
      const current = database.getSession(request.sessionId)!
      if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
      const tab = current.layout.root.tabs.find(candidate => candidate.id === request.params.tabId)
      if (!tab || tab.kind !== 'agent' || tab.resourceId !== request.params.agentSessionId || tab.state?.provider !== request.params.provider) throw new Error('Synthetic configured tab changed')
      tab.state = { ...tab.state, model: request.params.model, effort: request.params.effort ?? 'auto' }
      database.saveSession(request.sessionId, current.layout, current.maximizedGroupId, current.closedTabs)
      return tab
    }
    return { applied: true }
  })
  const confirm = vi.fn(async () => false), fileChanged = vi.fn()
  const providers: AgentProviderInfo[] = (['codex', 'claude'] as const).map(id => ({ id, displayName: id, available: true, installUrl: '', models: [{ id: id + '-synthetic', label: id + ' Synthetic' }], efforts: [{ id: 'low', label: 'Low' }] }))
  const backlogs = new ProjectBacklogs(database)
  const idleUpdate = { state: 'idle' as const, workspace: null, startedAt: null, finishedAt: null, version: null, feedDirectory: null, exitCode: null, message: 'No local update has been built.', log: [] as string[] }
  const localUpdates = {
    unsupported: vi.fn((): string | null => null),
    status: vi.fn(() => idleUpdate),
    start: vi.fn((target: string) => ({ ...idleUpdate, state: 'running' as const, workspace: target }))
  }
  const shipped = { id: 'run-1', projectId: project.id, state: 'running' as const, requestedBy: { kind: 'owner' as const }, message: '', paths: null, startedAt: '', finishedAt: null, commit: null, releaseTag: null, releaseUrl: null, workflowRunUrl: null, stages: [], error: null }
  const delivery = {
    status: vi.fn(async (projectId: string) => ({ projectId, available: true, reason: null, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, head: null, headSubject: null, files: [], github: null, releaseWorkflow: false, checkedAt: '' })),
    current: vi.fn((): typeof shipped | null => null),
    ship: vi.fn((projectId: string, _cwd: string, request: { message: string; paths?: string[] }) => ({ ...shipped, projectId, message: request.message, paths: request.paths ?? null })),
    wait: vi.fn(async () => ({ ...shipped, state: 'delivered' as const, releaseTag: 'v1.0.1' }))
  }
  const deps = { database, sessions, orchestration, collaboration, backlogs, ui, confirm, fileChanged, localUpdates, delivery, providers: () => providers }
  const control = new AgentControl(deps)
  return { root, project, workspace, database, sessions, orchestration, collaboration, submissions, scope, spec, rootTab, requests, ui, confirm, fileChanged, localUpdates, delivery, control, deps }
}

/** Give an agent session a visible tab, so its checklist claims count as live. */
const openAgentTab = (f: ReturnType<typeof fixture>, resourceId: string, tabId: string): void => {
  const current = f.database.getSession(f.workspace.id)!
  if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
  current.layout.root.tabs.push({ id: tabId, kind: 'agent', resourceId, title: resourceId, state: { provider: 'codex', model: 'codex-synthetic' } })
  f.database.saveSession(f.workspace.id, current.layout, null, [])
}

describe('authorized native app control', () => {
  it('builds a local app update only for the owner’s confirmation or a non-sandboxed coworker’s standing grant', async () => {
    const f = fixture()
    const local: AgentSpec = { ...f.spec, id: 'local-worker', provider: 'local', title: 'Local worker' }
    f.sessions.ensure(local)
    openAgentTab(f, local.id, 'local-tab')
    const localScope = { ...f.scope, agentSessionId: local.id }
    // Asked, and a refusal builds nothing.
    await expect(f.control.call(localScope, 'app.update')).rejects.toThrow('declined')
    expect(f.localUpdates.start).not.toHaveBeenCalled()
    // A sandboxed conversation cannot clear itself, and nobody clears itself.
    await expect(f.control.call(localScope, 'app.update.authorize', { agentSessionId: f.spec.id })).rejects.toThrow('sandboxed')
    await expect(f.control.call(f.scope, 'app.update.authorize', { agentSessionId: f.spec.id })).rejects.toThrow('itself')
    expect(await f.control.call(f.scope, 'app.update.authorize', { agentSessionId: local.id })).toMatchObject({ authorized: true })
    expect(await f.control.call(localScope, 'app.update')).toMatchObject({ state: 'running', workspace: f.project.path, authorizedBy: f.spec.id })
    expect(f.localUpdates.start).toHaveBeenCalledWith(f.project.path)
    expect(f.confirm).toHaveBeenCalledTimes(1)
    // A project that cannot build Conductor says so instead of spawning anything.
    f.localUpdates.unsupported.mockReturnValueOnce('This project is not the Conductor desktop app, so it cannot build a Conductor update.')
    await expect(f.control.call(localScope, 'app.update')).rejects.toThrow('not the Conductor desktop app')
    // The clearance lapses with the tab that issued it.
    f.database.saveSession(f.workspace.id, { version: 1, root: { type: 'group', id: 'group', activeTabId: 'local-tab', tabs: [{ id: 'local-tab', kind: 'agent', resourceId: local.id, title: 'Local', state: { provider: 'local', model: 'local-synthetic' } }] } }, null, [])
    await expect(f.control.call(localScope, 'app.update')).rejects.toThrow('declined')
    // Status stays readable in a read-only turn; starting a build does not.
    const state = f.database.structured.snapshot(local.id)!
    f.database.structured.update(local.id, { settings: { ...state.settings, permission: 'read-only' } })
    expect(await f.control.call(localScope, 'app.update.status')).toMatchObject({ state: 'idle' })
    await expect(f.control.call(localScope, 'app.update')).rejects.toThrow('read-only')
    expect(f.localUpdates.start).toHaveBeenCalledTimes(1)
  })
  it('ships a cloud coworker’s work on the host in one call, asks the owner for a local model, and refuses read-only turns', async () => {
    const f = fixture()
    expect(await f.control.call(f.scope, 'git.status')).toMatchObject({ branch: 'main', available: true })
    expect(await f.control.call(f.scope, 'git.ship', { message: 'Fix it', paths: ['src/a.ts'] })).toMatchObject({ state: 'running', paths: ['src/a.ts'] })
    expect(f.delivery.ship).toHaveBeenCalledWith(f.project.id, f.project.path, { message: 'Fix it', paths: ['src/a.ts'] }, { kind: 'agent', agentSessionId: f.spec.id, title: f.spec.title })
    expect(f.confirm).not.toHaveBeenCalled()
    // Waiting long-polls the run, capped below the control server's request timeout.
    expect(await f.control.call(f.scope, 'git.ship', { message: 'Again', waitSeconds: 500 })).toMatchObject({ state: 'delivered', releaseTag: 'v1.0.1' })
    expect(f.delivery.wait).toHaveBeenCalledWith(f.project.id, 'run-1', 100_000)
    expect(await f.control.call(f.scope, 'git.ship.status')).toMatchObject({ state: 'idle' })
    await expect(f.control.call(f.scope, 'git.ship', { message: 'x', paths: [] })).rejects.toThrow('paths')
    await expect(f.control.call(f.scope, 'git.ship', { message: 'x', force: true })).rejects.toThrow('accepts only')
    const local: AgentSpec = { ...f.spec, id: 'local-worker', provider: 'local', title: 'Local worker' }
    f.sessions.ensure(local)
    openAgentTab(f, local.id, 'local-tab')
    await expect(f.control.call({ ...f.scope, agentSessionId: local.id }, 'git.ship', { message: 'Local' })).rejects.toThrow('declined')
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, permission: 'read-only' } })
    await expect(f.control.call(f.scope, 'git.ship', { message: 'Read only' })).rejects.toThrow('read-only')
    expect(f.delivery.ship).toHaveBeenCalledTimes(2)
  })
  it('advertises configured local models and dispatches native local coworkers within inherited read-only permissions', async () => {
    const f = fixture(false, { local: ['accept-edits', 'read-only'] })
    f.deps.providers().push({ id: 'local', displayName: 'Local', available: true, installUrl: '', models: [{ id: 'local-synthetic', label: 'Local synthetic' }], efforts: [] })
    const catalog = await f.control.call(f.scope, 'models.list') as Array<{ provider: string; models: Array<{ id: string }> }>
    expect(catalog.find(entry => entry.provider === 'local')?.models[0]?.id).toBe('local-synthetic')
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, permission: 'read-only', sandbox: 'read-only' } })
    const result = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Bounded local read', prompt: 'Read one fixture file.', provider: 'local', model: 'local-synthetic' }] }) as Array<{ agentSessionId: string; accepted: boolean }>
    expect(result[0]?.accepted).toBe(true)
    expect(f.database.structured.snapshot(result[0]!.agentSessionId)?.settings.permission).toBe('read-only')
    expect(f.submissions.at(-1)?.provider).toBe('local')
    expect(f.submissions.at(-1)?.prompt).toContain('Your controller updates the orchestration task.')
    expect(f.submissions.at(-1)?.prompt).not.toContain('orchestration.tasks.update')
  })
  it('refuses foreign projects/workspaces, hidden sessions and closed callers', async () => {
    const f = fixture()
    const otherPath = join(f.root, 'other'); mkdirSync(otherPath)
    const other = f.database.upsertProject(otherPath, 'Other'), otherWorkspace = f.database.listSessions(other.id)[0]!
    await expect(f.control.call(f.scope, 'tabs.list', { projectId: 'project_not_open' })).rejects.toThrow('projects.list')
    await expect(f.control.call(f.scope, 'tasks.update', { projectId: other.id, revision: '1', id: 'anything' })).rejects.toThrow('only runs in the authorized project')
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
    expect(f.submissions[1]?.prompt).toContain('Mark it done with orchestration.tasks.update only after finishing.')
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

  it('focuses durable coordinated-message origins in either direction, after release, and from retained history', async () => {
    const f = fixture()
    const worker = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Worker' }) as AgentControlTab
    const peer = agentIn(f, f.project.id, f.workspace.id, 'peer')

    // A worker message can point back to its controller, and a controller message can point to its
    // worker; the owner UI resolves both from their concrete resource IDs, not relationship roles.
    await f.control.focusOrigin(f.scope.agentSessionId)
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.focus', projectId: f.project.id, sessionId: f.workspace.id, params: { tabId: f.rootTab.id } })
    await f.control.focusOrigin(worker.resourceId!)
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.focus', params: { tabId: worker.id } })
    await f.control.focusOrigin(peer.agentSessionId)
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.focus', params: { tabId: 'tab-peer' } })

    // Releasing control removes authority, not a sender's retained transcript identity.
    f.control.releaseByOwner(worker.resourceId!)
    await f.control.focusOrigin(worker.resourceId!)
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.focus', params: { tabId: worker.id } })

    const retainedId = 'retained-origin'
    f.sessions.ensure({ ...f.spec, id: retainedId, title: 'Retained source' })
    const current = f.database.getSession(f.workspace.id)!
    f.database.saveSession(f.workspace.id, current.layout, current.maximizedGroupId, [...current.closedTabs, { id: 'retained-tab', kind: 'agent', resourceId: retainedId, title: 'Retained source', state: { provider: 'codex', model: 'codex-synthetic' } }])
    await f.control.focusOrigin(retainedId)
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.focus-origin', params: { agentSessionId: retainedId } })
    await expect(f.control.focusOrigin('guessed-origin')).rejects.toThrow('no longer available')
  })

  it('requires owner confirmation before closing an active tab and never closes the caller', async () => {
    const f = fixture(), target = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    f.database.structured.append({ schemaVersion: 1, id: 'close-running', sequence: f.database.structured.snapshot(target.resourceId!)!.sequence + 1, sessionId: target.resourceId!, runtimeId: 'close-runtime', provider: 'codex', projectId: f.project.id, workspaceId: f.workspace.id, cwd: f.project.path, timestamp: new Date().toISOString(), data: { type: 'session', phase: 'running' } })
    await expect(f.control.call(f.scope, 'tabs.close', { tabId: f.rootTab.id })).rejects.toThrow('itself')
    await expect(f.control.call(f.scope, 'tabs.close', { tabId: target.id })).rejects.toThrow('declined')
    expect(f.requests.filter(request => request.action === 'tabs.close')).toHaveLength(0)
    f.confirm.mockResolvedValue(true)
    await f.control.call(f.scope, 'tabs.close', { tabId: target.id })
    expect(f.requests.filter(request => request.action === 'tabs.close')).toHaveLength(1)
  })

  it('closes a settled agent tab without a prompt and retains its conversation', async () => {
    const f = fixture(), target = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    f.database.structured.append({ schemaVersion: 1, id: 'close-interrupted', sequence: f.database.structured.snapshot(target.resourceId!)!.sequence + 1, sessionId: target.resourceId!, runtimeId: 'close-runtime', provider: 'codex', projectId: f.project.id, workspaceId: f.workspace.id, cwd: f.project.path, timestamp: new Date().toISOString(), data: { type: 'session', phase: 'interrupted' } })
    await f.control.call(f.scope, 'tabs.close', { tabId: target.id })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.requests.at(-1)?.action).toBe('tabs.close')
    expect(f.database.structured.snapshot(target.resourceId!)).toBeTruthy()
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
    const guarded = await f.control.call(f.scope, 'tabs.open', { exactPermission: true }) as AgentControlTab
    expect(f.database.structured.snapshot(guarded.resourceId!)?.settings).toMatchObject({ permission: 'default' })
  })

  it('opens a native coworker on Auto, the highest mode its provider offers, whatever the owner remembered or the caller asked', async () => {
    // The owner does not want to babysit a dispatched coworker: a worker on ask or edit mode is
    // the owner clicking Allow for every command the controller should have been trusted with.
    const f = fixture(false, { claude: ['default', 'read-only', 'accept-edits', 'auto'] })
    f.database.setSetting('rememberedPermission:claude', 'read-only')
    const remembered = await f.control.call(f.scope, 'tabs.open', { provider: 'claude' }) as AgentControlTab
    expect(f.database.structured.snapshot(remembered.resourceId!)?.settings).toMatchObject({ permission: 'auto' })
    const asked = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', permission: 'accept-edits' }) as AgentControlTab
    expect(f.database.structured.snapshot(asked.resourceId!)?.settings).toMatchObject({ permission: 'auto' })
    // A provider without Auto gets its highest mode.
    const capped = await f.control.call(f.scope, 'tabs.open', { provider: 'codex' }) as AgentControlTab
    expect(f.database.structured.snapshot(capped.resourceId!)?.settings).toMatchObject({ permission: 'accept-edits' })
    const dispatched = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Auto worker', prompt: 'Do the thing', provider: 'claude', permission: 'default' }] }) as Array<{ agentSessionId: string }>
    expect(f.database.structured.snapshot(dispatched[0]!.agentSessionId)?.settings).toMatchObject({ permission: 'auto' })
  })

  it('keeps a lower mode only for an agent the caller marks as not to be trusted, from its explicit ask or the owner\'s remembered mode', async () => {
    const f = fixture(false, { claude: ['default', 'read-only', 'accept-edits', 'auto'] })
    f.database.setSetting('rememberedPermission:claude', 'read-only')
    const remembered = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', exactPermission: true }) as AgentControlTab
    expect(f.database.structured.snapshot(remembered.resourceId!)?.settings).toMatchObject({ permission: 'read-only' })
    const explicit = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', permission: 'default', exactPermission: true }) as AgentControlTab
    expect(f.database.structured.snapshot(explicit.resourceId!)?.settings).toMatchObject({ permission: 'default' })
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'claude', exactPermission: 'yes' })).rejects.toThrow('exactPermission must be true or false')
  })

  it('rejects an explicit tabs.open permission that is not a real mode, or one this provider does not offer', async () => {
    const f = fixture()
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'claude', permission: 'plan' })).rejects.toThrow('Invalid permission mode')
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'claude', permission: 'auto' })).rejects.toThrow('supported by this provider')
  })

  it('never lets a Claude-only remembered mode leak into a new Codex tab', async () => {
    const f = fixture(false, { claude: ['default', 'read-only', 'accept-edits', 'auto'], codex: ['default', 'read-only', 'accept-edits'] })
    f.database.setSetting('rememberedPermission:claude', 'auto')
    const child = await f.control.call(f.scope, 'tabs.open', { provider: 'codex', exactPermission: true }) as AgentControlTab
    expect(f.database.structured.snapshot(child.resourceId!)?.settings).toMatchObject({ permission: 'default' })
  })

  it('still clamps a remembered mode to the controller\'s own autonomy', async () => {
    const f = fixture()
    f.database.structured.update(f.spec.id, { settings: { permission: 'read-only', plan: false } })
    f.database.setSetting('rememberedPermission:claude', 'accept-edits')
    const child = await f.control.call(f.scope, 'tabs.open', { provider: 'claude' }) as AgentControlTab
    expect(f.database.structured.snapshot(child.resourceId!)?.settings).toMatchObject({ permission: 'read-only' })
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

describe('controlled coworker model configuration', () => {
  const append = (f: ReturnType<typeof fixture>, id: string, data: AgentEventData): void => {
    const state = f.database.structured.snapshot(id)!, spec = f.database.structured.spec<AgentSpec>(id)!
    f.database.structured.append({ schemaVersion: 1, id: 'settings-event-' + (state.sequence + 1), sequence: state.sequence + 1, sessionId: id, runtimeId: state.runtimeId || 'settings-runtime', provider: spec.provider as StructuredProvider, projectId: spec.projectId, workspaceId: spec.sessionId, cwd: spec.cwd, timestamp: new Date().toISOString(), data })
  }

  it('repairs stale tab metadata, preserves authority settings, persists, and drives the next native request', async () => {
    const f = fixture()
    const child = await f.control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic', effort: 'low' }) as AgentControlTab
    const before = f.database.structured.snapshot(child.resourceId!)!
    const preserved = { ...before.settings, model: 'codex-advanced', effort: 'high', permission: 'read-only' as const, sandbox: 'read-only' as const, browserMcp: false }
    f.database.structured.update(child.resourceId!, { settings: preserved })

    const changed = await f.control.call(f.scope, 'agents.configure', { agentSessionId: child.resourceId, model: 'codex-advanced', effort: 'high' }) as Record<string, unknown>
    expect(changed).toMatchObject({ provider: 'codex', model: 'codex-advanced', effort: 'high', effective: 'next-turn' })
    expect(f.database.structured.snapshot(child.resourceId!)?.settings).toEqual(preserved)
    expect(f.control.tabs(f.scope).find(tab => tab.id === child.id)?.state).toMatchObject({ provider: 'codex', model: 'codex-advanced', effort: 'high', machineId: 'local' })
    expect(f.requests.slice(-2).map(request => request.action)).toEqual(['agents.configure', 'agents.configure-confirmed'])
    const snapshot = await f.control.call(f.scope, 'agents.snapshot', { agentSessionId: child.resourceId }) as SessionProjection
    expect(snapshot.settings).toEqual(preserved)

    const reopened = new ConductorDatabase(join(f.root, 'conductor.db'))
    expect(reopened.structured.snapshot(child.resourceId!)?.settings).toEqual(preserved)
    reopened.close()
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: child.resourceId, prompt: 'Use the configured model' })
    expect(f.submissions.at(-1)?.settings).toMatchObject({ model: 'codex-advanced', effort: 'high', permission: 'read-only', sandbox: 'read-only', browserMcp: false })
  })

  it('rejects invalid or arbitrary settings and refuses active, queued, or pending work', async () => {
    const f = fixture(), child = await f.control.call(f.scope, 'tabs.open', { provider: 'codex' }) as AgentControlTab
    const original = structuredClone(f.database.structured.snapshot(child.resourceId!)!.settings)
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: child.resourceId, model: 'missing-model', effort: 'high' })).rejects.toThrow(/exact model/)
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: child.resourceId, model: 'codex-advanced', effort: 'low' })).rejects.toThrow(/effort supported/)
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: child.resourceId, model: 'codex-advanced', effort: 'high', permission: 'auto' })).rejects.toThrow(/accepts only/)
    append(f, child.resourceId!, { type: 'session', phase: 'running' })
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: child.resourceId, model: 'codex-advanced', effort: 'high' })).rejects.toThrow(/idle/)
    append(f, child.resourceId!, { type: 'session', phase: 'completed' })
    append(f, child.resourceId!, { type: 'queue', prompt: { id: 'queued', text: 'Already queued', settings: original, attachments: [] } })
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: child.resourceId, model: 'codex-advanced', effort: 'high' })).rejects.toThrow(/queued or pending/)
    expect(f.database.structured.snapshot(child.resourceId!)?.settings).toEqual(original)
    expect(f.requests.filter(request => request.action === 'agents.configure')).toHaveLength(0)
  })

  it('requires an existing direct control claim and refuses self, ancestors, released tabs, and foreign projects', async () => {
    const f = fixture(), child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    const args = { model: 'codex-advanced', effort: 'high' }
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: f.scope.agentSessionId, ...args })).rejects.toThrow(/itself|ancestor/)
    await expect(f.control.call({ ...f.scope, agentSessionId: child.resourceId! }, 'agents.configure', { agentSessionId: f.scope.agentSessionId, ...args })).rejects.toThrow(/ancestor/)
    const unclaimed = agentIn(f, f.project.id, f.workspace.id, 'unclaimed')
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: unclaimed.agentSessionId, ...args })).rejects.toThrow(/already controls|already controls|already controls|Configure only/)
    const other = sibling(f, 'Foreign settings'), foreign = agentIn(f, other.project.id, other.workspace.id, 'foreign-agent')
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: foreign.agentSessionId, ...args })).rejects.toThrow(/outside this workspace/)
    await f.control.call(f.scope, 'agents.release', { agentSessionId: child.resourceId })
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: child.resourceId, ...args })).rejects.toThrow(/Configure only/)
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
    { id: 'local', name: 'This Laptop', kind: 'local' as const, status: 'online' as const, accountLogin: null, projects: [], connection: LOCAL_CONNECTION },
    { id: 'render-desktop', name: 'Render Desktop', kind: 'peer' as const, status: 'online' as const, accountLogin: 'Empire024', projects: [], connection: LOCAL_CONNECTION },
    { id: 'studio', name: 'Studio', kind: 'peer' as const, status: 'revoked' as const, accountLogin: 'Empire024', projects: [], connection: LOCAL_CONNECTION }
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
      { id: 'local', name: 'This Laptop', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION },
      { id: 'render-desktop', name: 'Render Desktop', kind: 'peer', status: 'online', accountLogin: 'Empire024', projects: [link('some-other-project')], connection: LOCAL_CONNECTION }
    ] })
    await expect(control.call(f.scope, 'tabs.open', { machineId: 'render-desktop' })).rejects.toThrow(/is not one of .Render Desktop/)
    expect(openRemote).not.toHaveBeenCalled()
  })

  it('refuses when the paired machine is now sharing a different project under that mapping', async () => {
    const f = fixture()
    const openRemote = vi.fn()
    const mapped = link(f.project.id)
    const control = new AgentControl({ ...f.deps, openRemote, machines: () => [
      { id: 'local', name: 'This Laptop', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION },
      { id: 'render-desktop', name: 'Render Desktop', kind: 'peer', status: 'online', accountLogin: 'Empire024', projects: [{ ...mapped, observed: { ...mapped.grant.remote, key: 'c'.repeat(32) } }], connection: LOCAL_CONNECTION }
    ] })
    await expect(control.call(f.scope, 'tabs.open', { machineId: 'render-desktop' })).rejects.toThrow(/now has a different project where this one was/)
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
      { id: 'local', name: 'This Laptop', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION },
      { id: 'render-desktop', name: 'Render Desktop', kind: 'peer', status: 'online', accountLogin: null, projects: [link(f.project.id)], connection: LOCAL_CONNECTION }
    ] })
    await expect(control.call(f.scope, 'tabs.open', {})).rejects.toThrow(/Remote machine placement is unavailable/)
  })
})

/** A second project the owner has open in the same window, with its own workspace. */
const sibling = (f: ReturnType<typeof fixture>, name = 'Theme') => {
  const path = join(f.root, name.toLowerCase()); mkdirSync(path)
  const project = f.database.upsertProject(path, name), workspace = f.database.listSessions(project.id)[0]!
  return { project, workspace, path }
}

/** An unrelated agent with a visible tab in the given workspace, able to call control itself. */
const agentIn = (f: ReturnType<typeof fixture>, projectId: string, sessionId: string, id: string): AgentControlScope => {
  f.sessions.ensure({ id, projectId, sessionId, cwd: f.database.getProject(projectId)!.path, provider: 'codex', title: id, model: 'codex-synthetic' })
  const current = f.database.getSession(sessionId)!
  if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
  current.layout.root.tabs.push({ id: 'tab-' + id, kind: 'agent', resourceId: id, title: id, state: { provider: 'codex', model: 'codex-synthetic' } })
  f.database.saveSession(sessionId, current.layout, null, [])
  return { projectId, sessionId, agentSessionId: id }
}

describe('projects open side by side in one window', () => {
  it('names every open project and reads a sibling without being able to write to it', async () => {
    const f = fixture(), other = sibling(f)
    writeFileSync(join(other.path, 'style.css'), 'body { color: teal }')
    const listed = await f.control.call(f.scope, 'projects.list') as Array<{ id: string; name: string; current: boolean; workspaces: Array<{ id: string }> }>
    expect(listed.map(project => project.name).sort()).toEqual(['Control project', 'Theme'])
    expect(listed.find(project => project.id === f.project.id)?.current).toBe(true)
    expect(listed.find(project => project.id === other.project.id)?.workspaces.map(workspace => workspace.id)).toEqual([other.workspace.id])
    const state = await f.control.call(f.scope, 'app.state') as { projects: Array<{ id: string }> }
    expect(state.projects.map(project => project.id)).toContain(other.project.id)
    const read = await f.control.call(f.scope, 'files.read', { projectId: other.project.id, path: 'style.css' }) as { content: string; uri: string }
    expect(read.content).toBe('body { color: teal }')
    expect(read.uri).toBe('conductor://' + other.project.id + '/file/style.css')
    await expect(f.control.call(f.scope, 'files.write', { projectId: other.project.id, path: 'style.css', content: 'x', expectedContent: 'body { color: teal }' }))
      .rejects.toThrow(/only runs in the authorized project/)
    expect(readFileSync(join(other.path, 'style.css'), 'utf8')).toBe('body { color: teal }')
  })

  it('hands work to a tab opened in the sibling project and keeps steering only that tab', async () => {
    const f = fixture(), other = sibling(f)
    const handed = await f.control.call(f.scope, 'tabs.open', { projectId: other.project.id, provider: 'claude', title: 'Theme worker' }) as AgentControlTab & { projectId: string; workspaceId: string }
    expect(handed.projectId).toBe(other.project.id)
    expect(handed.workspaceId).toBe(other.workspace.id)
    // The tab belongs to the project that received it, and works in that project's folder.
    const spec = f.database.structured.spec<AgentSpec>(handed.resourceId!)!
    expect(spec).toMatchObject({ projectId: other.project.id, sessionId: other.workspace.id, cwd: other.path })
    expect(f.database.getSession(other.workspace.id)!.layout.root).toMatchObject({ activeTabId: handed.id })
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: handed.resourceId, prompt: 'Integrate the exported model' })
    expect(f.submissions.at(-1)?.prompt).toContain('Integrate the exported model')
    const listed = await f.control.call(f.scope, 'agents.list') as Array<{ agentSessionId?: string; projectId: string; crossProject?: boolean }>
    expect(listed.find(agent => agent.agentSessionId === handed.resourceId)).toMatchObject({ projectId: other.project.id, crossProject: true })
    // Ownership binds in the receiving project too, so nobody there can take the tab over.
    const local = agentIn(f, other.project.id, other.workspace.id, 'theme-agent')
    await expect(f.control.call(local, 'agents.steer', { agentSessionId: handed.resourceId, prompt: 'Mine now' })).rejects.toThrow(/already controls this tab/)
    // And an unrelated agent cannot reach across into a conversation another controller holds.
    const stranger = agentIn(f, f.project.id, f.workspace.id, 'stranger')
    await expect(f.control.call(stranger, 'agents.snapshot', { agentSessionId: handed.resourceId })).rejects.toThrow(/Another agent controls that tab in Theme/)
    expect((await f.control.call(stranger, 'agents.list') as Array<{ agentSessionId?: string }>).map(agent => agent.agentSessionId)).not.toContain(handed.resourceId)
    // Released, it is an uncontrolled tab in a co-opened project like any other, and steering it takes it back.
    await f.control.call(f.scope, 'agents.release', { agentSessionId: handed.resourceId })
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: handed.resourceId, prompt: 'Once more' })
    expect(f.submissions.at(-1)?.prompt).toContain('Once more')
    await expect(f.control.call(stranger, 'agents.snapshot', { agentSessionId: handed.resourceId })).rejects.toThrow(/Another agent controls/)
    // The owner's own release button reaches a cross-project link as well.
    const second = await f.control.call(f.scope, 'tabs.open', { projectId: other.project.id, provider: 'claude', title: 'Second worker' }) as AgentControlTab
    await expect(f.control.call(stranger, 'agents.snapshot', { agentSessionId: second.resourceId })).rejects.toThrow(/Another agent controls/)
    f.control.releaseByOwner(second.resourceId!)
    await expect(f.control.call(stranger, 'agents.snapshot', { agentSessionId: second.resourceId })).resolves.toMatchObject({ agentSessionId: second.resourceId })
  })

  it('dispatches a coworker into the sibling project but never hands it this project’s task claims', async () => {
    const f = fixture(), other = sibling(f)
    await expect(f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Integrate', prompt: 'Wire the asset in', projectId: other.project.id, projectTaskIds: ['bug-1'] }] }))
      .rejects.toThrow(/cannot take this project’s task claims/)
    const dispatched = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Integrate', prompt: 'Wire the asset in', projectId: other.project.id }] }) as Array<{ accepted: boolean; projectId: string; agentSessionId: string }>
    expect(dispatched[0]).toMatchObject({ accepted: true, projectId: other.project.id })
    expect(f.database.structured.spec<AgentSpec>(dispatched[0]!.agentSessionId)!.projectId).toBe(other.project.id)
    // The orchestration row stays with the dispatcher, so the worker is not told to close a task it cannot see.
    expect(f.orchestration.listTasks(other.project.id)).toHaveLength(0)
    expect(f.submissions.at(-1)?.prompt).toContain('handed to the Theme project')
    expect(f.submissions.at(-1)?.prompt).not.toContain('orchestration.tasks.update')
  })
})

describe('steering an uncontrolled tab in a co-opened project', () => {
  type Listed = { agentSessionId?: string; projectId: string; crossProject?: boolean; controlled?: boolean }
  /** Astra, a coworker in a sibling project, reaching back to the owner's own tab here. */
  const withAstra = (provider: StructuredProvider = 'codex') => {
    const f = fixture(false, { local: ['default', 'accept-edits', 'read-only'] }), other = sibling(f, 'Faktury')
    f.sessions.ensure({ id: 'astra', projectId: other.project.id, sessionId: other.workspace.id, cwd: other.path, provider, title: 'astra', model: provider + '-synthetic' })
    const current = f.database.getSession(other.workspace.id)!
    if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    current.layout.root.tabs.push({ id: 'tab-astra', kind: 'agent', resourceId: 'astra', title: 'Astra', state: { provider, model: provider + '-synthetic' } })
    f.database.saveSession(other.workspace.id, current.layout, null, [])
    const astra: AgentControlScope = { projectId: other.project.id, sessionId: other.workspace.id, agentSessionId: 'astra' }
    return { f, other, astra }
  }
  const stamp = (f: ReturnType<typeof fixture>, sessionId: string, tabId: string, remotePeerId: string) => {
    const current = f.database.getSession(sessionId)!
    if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    const tab = current.layout.root.tabs.find(candidate => candidate.id === tabId)!
    tab.state = { ...tab.state, remotePeerId, remoteMachineName: 'Render Desktop' }
    f.database.saveSession(sessionId, current.layout, null, [])
  }

  it('lists the owner’s uncontrolled tab to an agent of a sibling project and lets it read and steer it', async () => {
    const { f, astra } = withAstra()
    const listed = await f.control.call(astra, 'agents.list') as Listed[]
    expect(listed.find(agent => agent.agentSessionId === f.spec.id)).toMatchObject({ projectId: f.project.id, crossProject: true, controlled: false })
    await expect(f.control.call(astra, 'agents.snapshot', { agentSessionId: f.spec.id })).resolves.toMatchObject({ agentSessionId: f.spec.id })
    await expect(f.control.call(astra, 'agents.status', { agentSessionId: f.spec.id })).resolves.toBeTruthy()
    await expect(f.control.call(astra, 'agents.history', { agentSessionId: f.spec.id })).resolves.toBeInstanceOf(Array)
    // Settings outlive a prompt, so an uncontrolled tab is not configurable from next door.
    await expect(f.control.call(astra, 'agents.configure', { agentSessionId: f.spec.id, model: 'codex-advanced', effort: 'high' })).rejects.toThrow(/outside this workspace/)
    await f.control.call(astra, 'agents.submit', { agentSessionId: f.spec.id, prompt: 'Rebuild the invoice export' })
    expect(f.submissions.at(-1)?.prompt).toContain('Rebuild the invoice export')
    // Steering takes control, exactly as it does inside one workspace.
    expect((await f.control.call(astra, 'agents.list') as Listed[]).find(agent => agent.agentSessionId === f.spec.id)).toMatchObject({ controlled: true })
    await expect(f.control.call(astra, 'agents.interrupt', { agentSessionId: f.spec.id })).resolves.toMatchObject({ interrupted: true })
  })

  it('hides a sibling-project tab another agent controls and refuses to read or steer it', async () => {
    const { f, astra } = withAstra()
    const child = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Owned worker' }) as AgentControlTab
    const listed = await f.control.call(astra, 'agents.list') as Listed[]
    expect(listed.map(agent => agent.agentSessionId)).not.toContain(child.resourceId)
    expect(listed.map(agent => agent.agentSessionId)).toContain(f.spec.id)
    const before = f.submissions.length
    for (const method of ['agents.snapshot', 'agents.steer', 'agents.submit', 'agents.interrupt']) {
      await expect(f.control.call(astra, method, { agentSessionId: child.resourceId, prompt: 'Mine now' })).rejects.toThrow(/Another agent controls that tab in Control project/)
    }
    expect(f.submissions).toHaveLength(before)
  })

  it('reads but never steers a tab a paired machine drives, and keeps a paired caller inside its project', async () => {
    const { f, astra } = withAstra()
    stamp(f, f.workspace.id, f.rootTab.id, 'peer-1')
    await expect(f.control.call(astra, 'agents.snapshot', { agentSessionId: f.spec.id })).resolves.toMatchObject({ agentSessionId: f.spec.id })
    const before = f.submissions.length
    for (const method of ['agents.submit', 'agents.steer', 'agents.interrupt']) {
      await expect(f.control.call(astra, method, { agentSessionId: f.spec.id, prompt: 'Take over' })).rejects.toThrow(/paired machine/)
    }
    expect(f.submissions).toHaveLength(before)
    // The other way round: a caller a paired machine drives sees and reaches nothing next door.
    const { f: g, other: next, astra: driven } = withAstra()
    stamp(g, next.workspace.id, 'tab-astra', 'peer-2')
    expect((await g.control.call(driven, 'agents.list') as Listed[]).map(agent => agent.agentSessionId)).not.toContain(g.spec.id)
    await expect(g.control.call(driven, 'agents.snapshot', { agentSessionId: g.spec.id })).rejects.toThrow(/driven by a paired machine/)
  })

  it('lets a sandboxed local caller read the tab but not steer it', async () => {
    const { f, astra } = withAstra('local')
    await expect(f.control.call(astra, 'agents.snapshot', { agentSessionId: f.spec.id })).resolves.toMatchObject({ agentSessionId: f.spec.id })
    const before = f.submissions.length
    for (const method of ['agents.submit', 'agents.steer', 'agents.interrupt']) {
      await expect(f.control.call(astra, method, { agentSessionId: f.spec.id, prompt: 'Push it' })).rejects.toThrow(/sandboxed local conversation/)
    }
    expect(f.submissions).toHaveLength(before)
    expect(f.database.getSetting('agentControlParent:' + f.spec.id)).toBeFalsy()
  })

  /** Astra takes over a worker in the Control project by steering it, with a linksChanged spy. */
  const controlling = async () => {
    const { f, other, astra } = withAstra(), linksChanged = vi.fn()
    const control = new AgentControl({ ...f.deps, linksChanged })
    const worker = agentIn(f, f.project.id, f.workspace.id, 'worker')
    await control.call(astra, 'agents.submit', { agentSessionId: worker.agentSessionId, prompt: 'Fix the invoice totals' })
    const phase = (value: string) => f.database.structured.append({ schemaVersion: 1, id: 'phase-' + value + '-' + Math.random(), sequence: f.database.structured.snapshot('worker')!.sequence + 1, sessionId: 'worker', runtimeId: 'fixture', provider: 'codex', projectId: f.project.id, workspaceId: f.workspace.id, cwd: f.project.path, timestamp: new Date().toISOString(), data: { type: 'session', phase: value as 'running' } })
    return { f, other, astra, control, linksChanged, worker, phase }
  }
  const beside = (f: ReturnType<typeof fixture>) => ({ projectId: f.project.id, sessionId: f.workspace.id })

  it('renames, focuses and splits a coworker it controls in a sibling project, in the workspace that holds it', async () => {
    const { f, astra, control } = await controlling()
    await control.call(astra, 'tabs.rename', { tabId: 'tab-worker', title: 'Invoices' })
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.rename', ...beside(f), agentSessionId: 'astra', params: { tabId: 'tab-worker', title: 'Invoices' } })
    await control.call(astra, 'tabs.focus', { tabId: 'tab-worker', projectId: f.project.id, workspaceId: f.workspace.id })
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.focus', ...beside(f) })
    await control.call(astra, 'tabs.split', { tabId: 'tab-worker', direction: 'vertical' })
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.split', ...beside(f) })
    await expect(control.call(astra, 'tabs.focus', { tabId: 'tab-worker', projectId: astra.projectId })).rejects.toThrow(/not open in the requested project/)
    // Nothing else in that project: not the owner's own tab, which nobody gave Astra.
    await expect(control.call(astra, 'tabs.rename', { tabId: f.rootTab.id, title: 'Mine' })).rejects.toThrow(/outside this workspace or closed/)
    await expect(control.call(astra, 'tabs.close', { tabId: f.rootTab.id })).rejects.toThrow(/outside this workspace or closed/)
  })

  it('stops a running or approval-waiting coworker in a sibling project, and interrupting alone takes no control', async () => {
    const { f, astra, control, phase } = await controlling()
    const interrupt = vi.spyOn(f.sessions, 'interrupt')
    for (const value of ['running', 'waiting_approval']) {
      phase(value)
      await expect(control.call(astra, 'agents.interrupt', { agentSessionId: 'worker' })).resolves.toMatchObject({ interrupted: true })
      expect(f.database.structured.snapshot('worker')!.phase).toBe('interrupting')
    }
    expect(interrupt).toHaveBeenCalledTimes(2)
    // An uncontrolled tab next door can be stopped, and stays uncontrolled, as inside one workspace.
    const idle = agentIn(f, f.project.id, f.workspace.id, 'bystander')
    await control.call(astra, 'agents.interrupt', { agentSessionId: idle.agentSessionId })
    expect(f.database.getSetting('agentControlParent:bystander')).toBeFalsy()
  })

  it('closes a controlled sibling-project coworker, asking the owner first while it has work, and releases the link on both sides', async () => {
    const { f, astra, control, linksChanged, phase } = await controlling()
    phase('running')
    await expect(control.call(astra, 'tabs.close', { tabId: 'tab-worker' })).rejects.toThrow('declined')
    expect(f.confirm).toHaveBeenLastCalledWith(astra, expect.stringContaining('“worker” in Control project'))
    expect(f.requests.filter(request => request.action === 'tabs.close')).toHaveLength(0)
    f.confirm.mockResolvedValue(true)
    linksChanged.mockClear()
    await control.call(astra, 'tabs.close', { tabId: 'tab-worker', projectId: f.project.id })
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.close', ...beside(f), params: { tabId: 'tab-worker' } })
    expect(f.database.getSetting('agentControlParent:worker')).toBeFalsy()
    expect(linksChanged).toHaveBeenCalledWith(expect.objectContaining(beside(f)))
    expect(linksChanged).toHaveBeenCalledWith(expect.objectContaining({ projectId: astra.projectId, sessionId: astra.sessionId }))
  })

  it('closes a settled sibling-project coworker without asking', async () => {
    const { f, astra, control } = await controlling()
    await control.call(astra, 'tabs.close', { tabId: 'tab-worker' })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.close', ...beside(f) })
  })

  it('configures, resumes and releases a controlled sibling-project coworker', async () => {
    const { f, astra, control, linksChanged } = await controlling()
    const configured = await control.call(astra, 'agents.configure', { agentSessionId: 'worker', model: 'codex-advanced', effort: 'high' })
    expect(configured).toMatchObject({ projectId: f.project.id, workspaceId: f.workspace.id, model: 'codex-advanced', effort: 'high' })
    expect(f.requests.filter(request => request.action.startsWith('agents.configure')).every(request => request.projectId === f.project.id && request.sessionId === f.workspace.id)).toBe(true)
    await expect(control.call(astra, 'agents.resume', { agentSessionId: 'worker' })).resolves.toMatchObject({ agentSessionId: 'worker' })
    linksChanged.mockClear()
    await expect(control.call(astra, 'agents.release', { agentSessionId: 'worker' })).resolves.toMatchObject({ released: true })
    expect(linksChanged).toHaveBeenCalledWith(expect.objectContaining(beside(f)))
    expect(linksChanged).toHaveBeenCalledWith(expect.objectContaining({ projectId: astra.projectId, sessionId: astra.sessionId }))
    expect((await control.call(astra, 'agents.list') as Listed[]).find(agent => agent.agentSessionId === 'worker')).toMatchObject({ controlled: false })
    // Released, it is anyone's again, and durable changes need control first.
    await expect(control.call(astra, 'agents.resume', { agentSessionId: 'worker' })).rejects.toThrow(/does not control it/)
    await expect(control.call(astra, 'tabs.rename', { tabId: 'tab-worker', title: 'x' })).rejects.toThrow(/outside this workspace or closed/)
  })

  it('keeps every boundary around a controlled sibling-project coworker', async () => {
    const { f, other, astra, control } = await controlling()
    // Another agent in Astra's project cannot close or rename what Astra controls next door.
    const neighbour = agentIn(f, other.project.id, other.workspace.id, 'neighbour')
    await expect(control.call(neighbour, 'tabs.close', { tabId: 'tab-worker' })).rejects.toThrow(/outside this workspace or closed/)
    await expect(control.call(neighbour, 'agents.interrupt', { agentSessionId: 'worker' })).rejects.toThrow(/Another agent controls that tab/)
    // The coworker cannot turn round and control or close its controller.
    const worker = { projectId: f.project.id, sessionId: f.workspace.id, agentSessionId: 'worker' }
    await expect(control.call(worker, 'agents.submit', { agentSessionId: 'astra', prompt: 'Stop me' })).rejects.toThrow(/itself or an ancestor/)
    await expect(control.call(worker, 'tabs.close', { tabId: 'tab-astra' })).rejects.toThrow(/outside this workspace or closed/)
    // Writing into the sibling project still goes through the tab that lives there.
    await expect(control.call(astra, 'files.write', { projectId: f.project.id, path: 'x.md', content: 'x', expectedContent: null })).rejects.toThrow(/only runs in the authorized project/)
    // Once a paired machine drives Astra, even the coworker it controls is out of reach.
    stamp(f, other.workspace.id, 'tab-astra', 'peer-3')
    expect((await control.call(astra, 'agents.list') as Listed[]).map(agent => agent.agentSessionId)).not.toContain('worker')
    for (const [method, args] of [['agents.interrupt', { agentSessionId: 'worker' }], ['agents.release', { agentSessionId: 'worker' }], ['tabs.close', { tabId: 'tab-worker' }]] as const) {
      await expect(control.call(astra, method, args)).rejects.toThrow(/paired machine|outside this workspace or closed/)
    }
    expect(f.requests.filter(request => request.action === 'tabs.close')).toHaveLength(0)
  })
})

describe('a conversation a paired machine is driving', () => {
  it('stays inside the project that machine was granted, even with another project open here', async () => {
    const f = fixture(), other = sibling(f, 'Private')
    writeFileSync(join(other.path, 'secrets.md'), 'not shared')
    const current = f.database.getSession(f.workspace.id)!
    if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    // The stamp RemoteControlHost puts on a tab it opens for a peer.
    current.layout.root.tabs[0]!.state = { ...current.layout.root.tabs[0]!.state, remotePeerId: 'peer-1', remoteMachineName: 'Render Desktop' }
    f.database.saveSession(f.workspace.id, current.layout, null, [])
    for (const [method, args] of [['files.read', { path: 'secrets.md' }], ['files.list', {}], ['tabs.list', {}], ['tabs.open', {}]] as const) {
      await expect(f.control.call(f.scope, method, { ...args, projectId: other.project.id })).rejects.toThrow(/driven by a paired machine/)
    }
    // Its own project is unaffected.
    await expect(f.control.call(f.scope, 'tabs.list', { projectId: f.project.id })).resolves.toBeTruthy()
  })
})

/** A handoff in the shape docs/token-thrift-policy.md asks for. `omit` drops one section and
 *  `swap` exchanges two, so a test can name exactly which rule it is exercising. */
function handoff(options: { omit?: string; swap?: [string, string]; pad?: number } = {}): string {
  const sections: Array<[string, string]> = [
    ['Objective', '- Land the agents.handoff control method with tests and a parked smoke.'],
    ['Constraints', '- Additive edits only; the controller commits and publishes the batch.'],
    ['Owned files', '- src/main/agent-control.ts, its test file, docs/agent-control.md.'],
    ['Verified findings', '- npx tsc --noEmit is clean on this working tree (run 2026-09-21).'],
    ['Remaining work', '- Append the smoke script, run it once parked, record the report.'],
    ['Artifact references', '- artifacts/swarm-2026-09-21/handoff/report.json']
  ]
  const kept = sections.filter(([heading]) => heading !== options.omit)
  if (options.swap) {
    const [left, right] = options.swap.map(heading => kept.findIndex(([name]) => name === heading))
    const held = kept[left!]!; kept[left!] = kept[right!]!; kept[right!] = held
  }
  const body = kept.map(([heading, line]) => heading + '\n' + line).join('\n\n')
  return options.pad ? body + '\n' + 'x'.repeat(options.pad) : body
}

describe('context handoff to a fresh tab', () => {
  it('refuses a handoff that is not the bounded six-section format, naming what is wrong', async () => {
    const f = fixture()
    await expect(f.control.call(f.scope, 'agents.handoff', {})).rejects.toThrow('requires handoff')
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: 42 })).rejects.toThrow('requires handoff')
    // Too small to carry a task, and too large to be the cheap thing it exists to be.
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: 'Objective\nConstraints\nOwned files\nVerified findings\nRemaining work\nArtifact references' })).rejects.toThrow('between 200 and 12000 characters')
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff({ pad: 12000 }) })).rejects.toThrow('between 200 and 12000 characters')
    // A missing section is named, because the receiver cannot ask for it later.
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff({ omit: 'Owned files' }) })).rejects.toThrow('no “Owned files” section')
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff({ omit: 'Objective' }) })).rejects.toThrow('no “Objective” section')
    // Order is part of the format: findings that arrive after the work they justify read as a
    // different document, so this is refused the same way a missing section is.
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff({ swap: ['Verified findings', 'Remaining work'] }) })).rejects.toThrow('no “Remaining work” section on its own line after “Verified findings”')
    // A heading mentioned inside a sentence is prose, not a section.
    const prose = handoff({ omit: 'Artifact references' }) + '\n\nThe Artifact references are listed in the report.'
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: prose })).rejects.toThrow('no “Artifact references” section')
    // Nothing was opened by any of those refusals.
    expect(f.control.tabs(f.scope).filter(tab => tab.kind === 'agent')).toHaveLength(1)
    expect(f.submissions).toHaveLength(0)
  })

  it('accepts the headings however the model marked them up, as long as each stands on its own line', async () => {
    const f = fixture()
    const marked = handoff()
      .replace(/^(Objective|Owned files)$/gm, '## $1')
      .replace(/^(Constraints|Remaining work)$/gm, '**$1**')
      .replace(/^(Verified findings)$/gm, '$1:')
    expect(await f.control.call(f.scope, 'agents.handoff', { handoff: marked })).toMatchObject({ handedOff: true })
  })

  it('opens a fresh tab on the caller’s own provider, model, effort and mode and gives it the handoff as its first prompt', async () => {
    const f = fixture()
    f.database.structured.update(f.spec.id, { settings: { model: 'codex-advanced', effort: 'high', permission: 'accept-edits', plan: false } })
    const body = handoff()
    const result = await f.control.call(f.scope, 'agents.handoff', { handoff: body }) as { handedOff: boolean; agentSessionId: string; tabId: string; uri: string; title: string; note: string }
    expect(result).toMatchObject({ handedOff: true, provider: 'codex', model: 'codex-advanced', effort: 'high', permission: 'accept-edits', projectId: f.project.id, workspaceId: f.workspace.id })
    expect(result.uri).toContain(encodeURIComponent(result.tabId))
    // The receiver continues this conversation, so it is named after it rather than after the model.
    expect(result.title).toBe('Controller (continued)')
    // The visible tab exists and holds the new native session.
    const opened = f.control.tabs(f.scope).find(tab => tab.id === result.tabId)
    expect(opened).toMatchObject({ kind: 'agent', resourceId: result.agentSessionId, title: 'Controller (continued)' })
    expect(opened?.state).toMatchObject({ provider: 'codex', model: 'codex-advanced', effort: 'high' })
    expect(f.database.structured.snapshot(result.agentSessionId)?.settings).toMatchObject({ model: 'codex-advanced', effort: 'high', permission: 'accept-edits' })
    // The handoff itself is the first prompt, unaltered, through the ordinary submit path.
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0]!.prompt).toBe(body)
    const items = f.database.structured.snapshot(result.agentSessionId)!.items
    expect(items.find(item => item.data.type === 'text' && item.data.role === 'user')?.data).toMatchObject({ text: body })
    // Recorded as a handoff from the caller, naming the tab that took the work over.
    const recorded = f.collaboration.listMessages({ projectId: f.project.id, sessionId: f.workspace.id }).filter(message => message.metadata?.handoff === 'context')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ kind: 'handoff', agentSessionId: f.spec.id, toAgentSessionId: result.agentSessionId })
    expect(recorded[0]!.body).toContain('Controller (continued)')
    expect(recorded[0]!.metadata).toMatchObject({ fromTabId: f.rootTab.id, toTabId: result.tabId, characters: body.length })
    // The caller keeps its own tab and is told to stop rather than run the work in parallel.
    expect(f.control.tabs(f.scope).some(tab => tab.resourceId === f.spec.id)).toBe(true)
    expect(f.database.structured.snapshot(f.spec.id)?.phase).not.toBe('interrupted')
    expect(result.note).toMatch(/stop/)
    // And it may still steer what it opened, exactly as with tabs.open.
    await expect(f.control.call(f.scope, 'agents.submit', { agentSessionId: result.agentSessionId, prompt: 'A follow-up from the caller' })).resolves.toBeTruthy()
  })

  it('hands off only the calling conversation, never another tab', async () => {
    const f = fixture()
    const other = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff(), agentSessionId: other.resourceId })).rejects.toThrow('takes no agentSessionId')
    // Refused before anything is opened: the tab it made with tabs.open is still the only extra one.
    expect(f.control.tabs(f.scope).filter(tab => tab.kind === 'agent')).toHaveLength(2)
    expect(f.submissions).toHaveLength(0)
    // The caller may of course hand off itself, and the tab it opened may hand off its own work.
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff(), title: 'Named by the caller' })).resolves.toMatchObject({ title: 'Named by the caller' })
    await expect(f.control.call({ ...f.scope, agentSessionId: other.resourceId! }, 'agents.handoff', { handoff: handoff() })).resolves.toMatchObject({ handedOff: true })
  })

  it('lets a read-only or planning conversation hand off, because the receiver inherits the same mode', async () => {
    const f = fixture()
    f.database.structured.update(f.spec.id, { settings: { permission: 'default', plan: true } })
    const planned = await f.control.call(f.scope, 'agents.handoff', { handoff: handoff() }) as { agentSessionId: string }
    // Clamped by the same rule tabs.open uses, so the receiver cannot outrank the conversation
    // that handed to it - which is exactly why handing off at all is allowed here.
    expect(f.database.structured.snapshot(planned.agentSessionId)?.settings).toMatchObject({ permission: 'read-only', sandbox: 'read-only' })
    expect(f.submissions).toHaveLength(1)
    // The same clamp applies to a caller that is merely read-only rather than planning.
    const readOnly = fixture()
    readOnly.database.structured.update(readOnly.spec.id, { settings: { permission: 'read-only', plan: false } })
    const handed = await readOnly.control.call(readOnly.scope, 'agents.handoff', { handoff: handoff() }) as { agentSessionId: string }
    expect(readOnly.database.structured.snapshot(handed.agentSessionId)?.settings).toMatchObject({ permission: 'read-only', sandbox: 'read-only' })
    expect(readOnly.submissions).toHaveLength(1)
    // Planning mode on Claude specifically is not exercised here: this fixture adapter advertises
    // plans: false, so a synthetic Claude tab opened from a restricted caller is a state the
    // fixture itself rejects. handoff adds nothing to that path beyond what tabs.open already
    // does, and the tabs.open cases above cover it.
  })

  it('advertises itself in tools.list with the six sections a caller has to write', async () => {
    const f = fixture()
    const tools = await f.control.call(f.scope, 'tools.list') as Record<string, string>
    expect(tools['agents.handoff']).toContain('Objective, Constraints, Owned files, Verified findings, Remaining work, Artifact references')
    expect(tools['agents.handoff']).toContain('no agentSessionId')
  })
})

describe('local-model grants through app control', () => {
  const withLocal = () => {
    const f = fixture(false, { local: ['default', 'accept-edits', 'read-only'] })
    f.deps.providers().push({ id: 'local', displayName: 'Local', available: true, installUrl: '', models: [{ id: 'local-synthetic', label: 'Local synthetic' }], efforts: [] })
    return f
  }
  const grantsOf = (f: ReturnType<typeof fixture>, id: string) => {
    const settings = f.database.structured.snapshot(id)!.settings
    return { repository: Boolean(settings.localGit), research: Boolean(settings.localResearch) }
  }
  /** A local conversation the owner opened by hand: visible, provider local, controlled by nobody. */
  const openOwnersLocalTab = (f: ReturnType<typeof fixture>, id: string): AgentControlScope => {
    f.sessions.ensure({ ...f.spec, id, provider: 'local', title: id, model: 'local-synthetic' })
    const current = f.database.getSession(f.workspace.id)!
    if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    current.layout.root.tabs.push({ id: id + '-tab', kind: 'agent', resourceId: id, title: id, state: { provider: 'local', model: 'local-synthetic' } })
    f.database.saveSession(f.workspace.id, current.layout, null, [])
    return { ...f.scope, agentSessionId: id }
  }

  it('lets a non-local controller grant and revoke repository writes and research on a local tab it opened, durably and visibly', async () => {
    const f = withLocal()
    const tab = await f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic' }) as AgentControlTab
    const id = tab.resourceId!
    expect(grantsOf(f, id)).toEqual({ repository: false, research: false })
    expect(await f.control.call(f.scope, 'agents.grant', { agentSessionId: id, repository: true })).toMatchObject({ agentSessionId: id, tabId: tab.id, provider: 'local', grants: { repository: true, research: false }, effective: 'next-turn', paneNotified: true, grantedBy: f.spec.id })
    // The same durable settings the composer writes, so the tab's toggles and dispatch read it.
    expect(grantsOf(f, id)).toEqual({ repository: true, research: false })
    expect((await f.control.call(f.scope, 'agents.snapshot', { agentSessionId: id }) as SessionProjection).settings).toMatchObject({ localGit: true })
    // The mounted pane is told, so its composer buttons show the change without a remount.
    expect(f.requests.at(-1)).toMatchObject({ action: 'agents.grant-confirmed', sessionId: f.workspace.id, params: { tabId: tab.id, agentSessionId: id, repository: true, research: false } })
    // An omitted field is left alone; false revokes.
    expect(await f.control.call(f.scope, 'agents.grant', { agentSessionId: id, research: true })).toMatchObject({ grants: { repository: true, research: true } })
    expect(await f.control.call(f.scope, 'agents.grant', { agentSessionId: id, repository: false })).toMatchObject({ grants: { repository: false, research: true } })
    expect(grantsOf(f, id)).toEqual({ repository: false, research: true })
    // Naming nothing changes nothing and reports the current state without telling the pane.
    const before = f.requests.length
    expect(await f.control.call(f.scope, 'agents.grant', { agentSessionId: id })).toMatchObject({ grants: { repository: false, research: true }, paneNotified: false })
    expect(f.requests).toHaveLength(before)
    // A dispatched turn carries the conversation's current grants, not a copy from earlier.
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: id, prompt: 'Push the finished commit.' })
    expect(f.submissions.at(-1)?.settings).toMatchObject({ localGit: false, localResearch: true })
    // Unknown keys and non-boolean values are refused before anything changes.
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: id, repository: true, network: true })).rejects.toThrow('accepts only agentSessionId, repository and research')
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: id, repository: 'yes' })).rejects.toThrow('repository must be true or false')
    expect(grantsOf(f, id)).toEqual({ repository: false, research: true })
    expect((await f.control.call(f.scope, 'tools.list') as Record<string, string>)['agents.grant']).toContain('({agentSessionId,repository?,research?})')
  })

  it('refuses a non-local target, a local caller, itself, a tab the caller does not control, and a conversation a paired machine drives', async () => {
    const f = withLocal()
    const claude = await f.control.call(f.scope, 'tabs.open', { provider: 'claude' }) as AgentControlTab
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: claude.resourceId, repository: true })).rejects.toThrow('local models only')
    expect(f.database.structured.snapshot(claude.resourceId!)?.settings.localGit).toBeUndefined()
    // A sandboxed local conversation never widens another one, and nobody widens itself.
    const unclaimed = openOwnersLocalTab(f, 'owners-local')
    const localCaller = openOwnersLocalTab(f, 'local-caller')
    await expect(f.control.call(localCaller, 'agents.grant', { agentSessionId: unclaimed.agentSessionId, repository: true })).rejects.toThrow('sandboxed')
    await expect(f.control.call(localCaller, 'agents.grant', { agentSessionId: localCaller.agentSessionId, repository: true })).rejects.toThrow('itself')
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: f.spec.id, repository: true })).rejects.toThrow('itself')
    // Authority outlives a prompt, so a tab this caller merely could steer is not enough: it has
    // to control it already, and a tab another controller holds is off limits as everywhere.
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: unclaimed.agentSessionId, repository: true })).rejects.toThrow('already controls')
    openAgentTab(f, 'other-controller', 'other-controller-tab')
    f.database.setSetting('agentControlParent:' + unclaimed.agentSessionId, JSON.stringify({ projectId: f.project.id, sessionId: f.workspace.id, controllerAgentSessionId: 'other-controller', targetAgentSessionId: unclaimed.agentSessionId, controllerTabId: 'other-controller-tab', controlledTabId: 'owners-local-tab' }))
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: unclaimed.agentSessionId, repository: true })).rejects.toThrow('already controls')
    expect(grantsOf(f, unclaimed.agentSessionId)).toEqual({ repository: false, research: false })
    // A conversation a paired machine is driving keeps the authority that pairing gave it.
    const driven = await f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic' }) as AgentControlTab
    const current = f.database.getSession(f.workspace.id)!
    if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    const drivenTab = current.layout.root.tabs.find(candidate => candidate.id === driven.id)!
    drivenTab.state = { ...drivenTab.state, remotePeerId: 'peer' }
    f.database.saveSession(f.workspace.id, current.layout, null, [])
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: driven.resourceId, repository: true })).rejects.toThrow('paired machine')
    // A read-only or planning caller cannot widen a coworker it could not dispatch into.
    f.database.structured.update(f.spec.id, { settings: { ...f.database.structured.snapshot(f.spec.id)!.settings, permission: 'read-only' } })
    await expect(f.control.call(f.scope, 'agents.grant', { agentSessionId: claude.resourceId, repository: true })).rejects.toThrow('read-only')
  })

  it('accepts the grants when the tab is created, through tabs.open and router.dispatch, under the same rules', async () => {
    const f = withLocal()
    const tab = await f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic', repository: true }) as AgentControlTab & { grants?: unknown }
    expect(tab.grants).toEqual({ repository: true, research: false })
    expect(grantsOf(f, tab.resourceId!)).toEqual({ repository: true, research: false })
    const plain = await f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic' }) as AgentControlTab & { grants?: unknown }
    expect(plain.grants).toBeUndefined()
    const dispatched = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Research', prompt: 'Look it up.', provider: 'local', model: 'local-synthetic', research: true }] }) as Array<{ agentSessionId: string; accepted: boolean }>
    expect(dispatched[0]?.accepted).toBe(true)
    expect(grantsOf(f, dispatched[0]!.agentSessionId)).toEqual({ repository: false, research: true })
    expect(f.submissions.at(-1)?.settings).toMatchObject({ localResearch: true })
    // Never on another provider, never a non-boolean, never from a sandboxed or read-only caller —
    // and a refused ask registers no conversation at all.
    const registered = () => f.database.structured.history(f.project.id).length
    const count = registered()
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'claude', repository: true })).rejects.toThrow('local models only')
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic', research: 'please' })).rejects.toThrow('research must be true or false')
    await expect(f.control.call({ ...f.scope, agentSessionId: tab.resourceId! }, 'tabs.open', { provider: 'local', model: 'local-synthetic', repository: true })).rejects.toThrow('sandboxed')
    f.database.structured.update(f.spec.id, { settings: { ...f.database.structured.snapshot(f.spec.id)!.settings, permission: 'read-only' } })
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic', repository: true })).rejects.toThrow('read-only')
    expect(registered()).toBe(count)
  })
})

describe('bounded local tasks and compact supervision through app control', () => {
  const withLocal = () => {
    const f = fixture(false, { local: ['default', 'accept-edits', 'read-only'] })
    f.deps.providers().push({ id: 'local', displayName: 'Local', available: true, installUrl: '', models: [{ id: 'local-synthetic', label: 'Local synthetic' }], efforts: [] })
    return f
  }

  it('stores a task contract on a local tab it opens, refuses one elsewhere, and exposes a compact status', async () => {
    const f = withLocal()
    const contract = { allowedPaths: ['public/text-diff.js'], acceptance: { command: 'node --test tests/text-diff.test.mjs' } }
    const tab = await f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic', contract }) as AgentControlTab
    expect(f.database.structured.snapshot(tab.resourceId!)!.settings.localContract).toEqual(contract)
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic', contract: { allowedPaths: ['../escape'] } })).rejects.toThrow(/workspace-relative/)
    await expect(f.control.call(f.scope, 'tabs.open', { contract })).rejects.toThrow(/local models only/)
    const status = await f.control.call(f.scope, 'agents.status', { agentSessionId: tab.resourceId }) as Record<string, unknown>
    expect(status).toMatchObject({ agentSessionId: tab.resourceId, provider: 'local', model: 'local-synthetic', contract, stop: null, lastTool: null, filesChanged: [] })
    expect(JSON.stringify(status).length).toBeLessThan(2000)
    expect(JSON.stringify(await f.control.call(f.scope, 'tools.list', {}))).toContain('compact supervision view')
    await expect(f.control.call(f.scope, 'agents.compact', { agentSessionId: f.spec.id })).rejects.toThrow()
  })
})
