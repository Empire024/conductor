import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { FakeDurableJobsService } from '../shared/durable-jobs-fake'
import type { DurableJobEvent, DurableJobSummary } from '../shared/durable-jobs'
import { assertLocalControlAllowed, assertToolAllowed, toolSpecs } from './local-models/tools'
import { SUCCESSION_NUDGE, SUCCESSION_TURNS, TurnBriefings } from './turn-briefing'
import { COWORKER_OPENED_PREFIX, CoworkerAutoClose } from './coworker-autoclose'
import { encodeRestartInitiator, encodeRestartRequest, parseRestartRequest, RESTART_INITIATOR_KEY, RESTART_REQUEST_KEY, takeRestartInitiator } from './restart-initiator'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs(); vi.useRealTimers() })
function fixture(aliasedRoot = false, permissionsByProvider?: Partial<Record<StructuredProvider, ProviderCapabilities['permissions']>>, sandboxByProvider?: Partial<Record<StructuredProvider, ProviderCapabilities['sandboxModes']>>, extraModels: ProviderCapabilities['models'] = [], briefing?: ConstructorParameters<typeof StructuredSessions>[4]) {
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
    const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: permissionsByProvider?.[provider] ?? ['default', 'read-only', 'accept-edits'], sandboxModes: sandboxByProvider && provider in sandboxByProvider ? sandboxByProvider[provider] : ['inherit', 'read-only', 'workspace-write'], effort: ['low', 'high'], models: [{ id: provider + '-synthetic', label: provider + ' Synthetic', effort: ['low'], defaultEffort: 'low' }, { id: provider + '-advanced', label: provider + ' Advanced', effort: ['high'], defaultEffort: 'high' }, ...extraModels], limitations: ['Zero inference fixture'] }
    return { provider, capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-' + options.runtimeId } }) },
      submit: async (prompt, settings) => { submissions.push({ provider, prompt, settings: structuredClone(settings), options }); options.emit({ itemId: 'result', data: { type: 'text', role: 'assistant', text: 'Native fixture result', mode: 'snapshot' } }); options.emit({ data: { type: 'session', phase: 'completed' } }) }, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  }, briefing)
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
  // conductor-task:local-server-stop-control
  it('lists the running local model servers with the conversations using them and stops one in one call', async () => {
    const f = fixture()
    const { LocalServerBusy } = await import('./local-models/servers')
    const server = { model: 'local/dolphin-x1-8b', label: 'Dolphin X1 8B', pid: 62380, port: 51438, startedAt: '2026-09-24T17:00:00.000Z', startedByConductor: true }
    let busy = true
    const stop = vi.fn(async (request: { model?: string; pid?: number; force?: boolean }) => {
      if (busy && !request.force) throw new LocalServerBusy(server.label, '1 conversation is mid-turn on it in this Conductor')
      return { stopped: true, model: server.model, pid: server.pid, forced: busy }
    })
    const control = new AgentControl({ ...f.deps, localModels: { availability: async () => ({ available: true }), servers: () => [server], stop } })
    const local: AgentSpec = { ...f.spec, id: 'local-worker', provider: 'local', title: 'Local worker', model: 'local/dolphin-x1-8b' }
    f.sessions.ensure(local)
    openAgentTab(f, local.id, 'local-tab')
    const localState = f.database.structured.snapshot(local.id)!
    f.database.structured.update(local.id, { settings: { ...localState.settings, model: 'local/dolphin-x1-8b' } })
    expect(Object.keys(await control.call(f.scope, 'tools.list', {}) as object)).toEqual(expect.arrayContaining(['local.servers', 'local.stop']))
    expect(await control.call(f.scope, 'local.servers', {})).toEqual([{ ...server, conversations: [{ agentSessionId: local.id, title: 'Local worker', phase: expect.any(String), inTurn: false }] }])
    await expect(control.call(f.scope, 'local.stop', {})).rejects.toThrow(/model or pid/)
    await expect(control.call({ ...f.scope, agentSessionId: local.id }, 'local.stop', { model: 'dolphin-x1-8b' })).rejects.toThrow(/sandboxed local conversation/)
    // Busy: refused without force; force asks the owner, and a refusal stops nothing.
    await expect(control.call(f.scope, 'local.stop', { model: 'dolphin-x1-8b' })).rejects.toThrow(/busy.*force:true/)
    expect(f.confirm).not.toHaveBeenCalled()
    await expect(control.call(f.scope, 'local.stop', { pid: 62380, force: true })).rejects.toThrow('declined')
    expect(f.confirm).toHaveBeenCalledTimes(1)
    f.confirm.mockResolvedValueOnce(true as never)
    expect(await control.call(f.scope, 'local.stop', { pid: 62380, force: true })).toMatchObject({ stopped: true, forced: true })
    expect(stop).toHaveBeenLastCalledWith({ pid: 62380, force: true })
    // Idle: one call, no dialog.
    busy = false
    expect(await control.call(f.scope, 'local.stop', { model: 'local/dolphin-x1-8b' })).toMatchObject({ stopped: true, forced: false })
    expect(f.confirm).toHaveBeenCalledTimes(2)
  })

  // conductor-task:app-update-no-dialog-in-auto
  it('builds a local update for a native coworker in Auto without the owner dialog, and still asks below Auto and for a local model', async () => {
    const f = fixture()
    const setPermission = (id: string, permission: 'default' | 'accept-edits' | 'auto') => { const state = f.database.structured.snapshot(id)!; f.database.structured.update(id, { settings: { ...state.settings, permission } }) }
    setPermission(f.spec.id, 'accept-edits')
    await expect(f.control.call(f.scope, 'app.update')).rejects.toThrow('declined')
    expect(f.confirm).toHaveBeenCalledTimes(1)
    setPermission(f.spec.id, 'auto')
    expect(await f.control.call(f.scope, 'app.update')).toMatchObject({ state: 'running', authorizedBy: 'auto' })
    expect(f.confirm).toHaveBeenCalledTimes(1)
    const local: AgentSpec = { ...f.spec, id: 'local-worker', provider: 'local', title: 'Local worker' }
    f.sessions.ensure(local)
    openAgentTab(f, local.id, 'local-tab')
    setPermission(local.id, 'auto')
    await expect(f.control.call({ ...f.scope, agentSessionId: local.id }, 'app.update')).rejects.toThrow('declined')
    expect(f.confirm).toHaveBeenCalledTimes(2)
    expect(f.localUpdates.start).toHaveBeenCalledTimes(1)
  })
  it('tells the agent whether the owner declined app.update or was never reached, and builds nothing either way', async () => {
    const f = fixture()
    f.confirm.mockResolvedValueOnce('timeout' as never)
    await expect(f.control.call(f.scope, 'app.update')).rejects.toThrow(/did not answer the request to build a local update.*did not decline/)
    f.confirm.mockResolvedValueOnce('undelivered' as never)
    await expect(f.control.call(f.scope, 'app.update')).rejects.toThrow(/could not show the owner the request to build a local update/)
    f.confirm.mockResolvedValueOnce('declined' as never)
    await expect(f.control.call(f.scope, 'app.update')).rejects.toThrow('The owner declined to build a local update')
    expect(f.localUpdates.start).not.toHaveBeenCalled()
    f.confirm.mockResolvedValueOnce('allowed' as never)
    expect(await f.control.call(f.scope, 'app.update')).toMatchObject({ state: 'running', authorizedBy: 'owner' })
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
  it('registers the v1 logic-loop methods and persists caller-recorded step results', async () => {
    const f = fixture()
    mkdirSync(join(f.project.path, '.conductor', 'loops'), { recursive: true })
    writeFileSync(join(f.project.path, '.conductor', 'loops', 'sample.md'), `---
id: sample
version: 1
title: Sample
trigger: [manual]
inputs: [taskId]
steps:
  - id: inspect
    role: reviewer
    model: codex:gpt-6-astra
    effort: high
---
Run it.
`)
    const tools = await f.control.call(f.scope, 'tools.list') as Record<string, string>
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['loops.list', 'loops.get', 'loops.history', 'loops.run', 'loops.record']))
    expect(await f.control.call(f.scope, 'loops.list')).toEqual([expect.objectContaining({ id: 'sample', version: 1 })])
    const planned = await f.control.call(f.scope, 'loops.run', { id: 'sample', inputs: { taskId: 't1' } }) as { runId: string; steps: Array<{ model: string; effort: string }> }
    expect(planned.steps).toEqual([expect.objectContaining({ model: 'codex:gpt-6-astra', effort: 'high' })])
    expect(await f.control.call(f.scope, 'loops.record', { runId: planned.runId, stepId: 'inspect', model: 'codex:gpt-6-astra', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z', outcome: 'success', tokens: { total: 12 } })).toMatchObject({ outcome: 'success', tokens: { total: 12 } })
    await expect(f.control.call(f.scope, 'loops.run', { id: 'sample', inputs: {} })).rejects.toThrow(/taskId/)
    await expect(f.control.call(f.scope, 'loops.record', { runId: 'outside', stepId: 'inspect', model: 'x', startedAt: '2026-09-24T10:00:00.000Z', finishedAt: '2026-09-24T10:01:00.000Z', outcome: 'success' })).rejects.toThrow(/run/i)
  })
  it('proposes and applies an unlocked change directly, but a locked/budget change only for the owner or a wizard tab', async () => {
    const f = fixture()
    mkdirSync(join(f.project.path, '.conductor', 'loops'), { recursive: true })
    const loopPath = join(f.project.path, '.conductor', 'loops', 'proposed.md')
    const source = `---
id: proposed
version: 1
title: Proposed
trigger: [manual]
inputs: []
budget:
  claudeWeeklyMax: 75
steps:
  - id: implement
    role: implementer
    model: claude:sonnet
locked: [budget]
---

# Proposed

## Run log

- seed
`
    writeFileSync(loopPath, source)
    const tools = await f.control.call(f.scope, 'tools.list') as Record<string, string>
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['loops.propose', 'loops.apply', 'loops.reject', 'loops.proposals']))
    const unlocked = await f.control.call(f.scope, 'loops.propose', { id: 'proposed', change: source.replace('model: claude:sonnet', 'model: claude:opus[1m]'), evidence: 'Opus did better' }) as { id: string }
    const applied = await f.control.call(f.scope, 'loops.apply', { proposalId: unlocked.id }) as { status: string; appliedVersion: number }
    expect(applied).toMatchObject({ status: 'applied', appliedVersion: 2 })
    expect(readFileSync(loopPath, 'utf8')).toContain('model: claude:opus[1m]')

    const budgetChange = await f.control.call(f.scope, 'loops.propose', { id: 'proposed', change: source.replace('claudeWeeklyMax: 75', 'claudeWeeklyMax: 90').replace('version: 1', 'version: 2'), evidence: 'Raise the cap' }) as { id: string }
    await expect(f.control.call(f.scope, 'loops.apply', { proposalId: budgetChange.id })).rejects.toThrow(/owner or a wizard tab/)
    const owner = f.control.ownerScope({ projectId: f.project.id })
    expect(await f.control.call(owner, 'loops.apply', { proposalId: budgetChange.id })).toMatchObject({ status: 'applied', appliedBy: 'owner' })

    const rejectable = await f.control.call(f.scope, 'loops.propose', { id: 'proposed', change: readFileSync(loopPath, 'utf8').replace('model: claude:opus[1m]', 'model: claude:haiku'), evidence: 'try haiku' }) as { id: string }
    expect(await f.control.call(f.scope, 'loops.reject', { proposalId: rejectable.id })).toMatchObject({ status: 'rejected' })
    await expect(f.control.call(f.scope, 'loops.apply', { proposalId: rejectable.id })).rejects.toThrow(/already rejected/)
    expect(await f.control.call(f.scope, 'loops.proposals', { id: 'proposed' })).toHaveLength(3)
  })
  it('agents.report delivers text only to the tab that opened this one, never anywhere else', async () => {
    const f = fixture()
    const child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    const childScope = { ...f.scope, agentSessionId: child.resourceId! }
    await expect(f.control.call(f.scope, 'agents.report', { text: 'not controlled by anyone' })).rejects.toThrow(/No controlling conversation/)
    await expect(f.control.call(childScope, 'agents.report', { text: 'x', extra: 1 })).rejects.toThrow(/accepts only text/)
    await expect(f.control.call(childScope, 'agents.report', { text: 'x'.repeat(2001) })).rejects.toThrow()
    const result = await f.control.call(childScope, 'agents.report', { text: 'UPDATE OK 1.2.3' }) as { agentSessionId: string; delivery: string }
    expect(result).toEqual({ agentSessionId: f.scope.agentSessionId, delivery: 'started' })
    expect(f.submissions.at(-1)).toMatchObject({ prompt: 'UPDATE OK 1.2.3' })
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

// conductor-task:main-brain-succession
describe('main-brain succession: agents.handoff successor:true', () => {
  const astra = [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', effort: ['high'], defaultEffort: 'high' }]
  const asWizard = (f: ReturnType<typeof fixture>) => {
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, wizard: true, model: 'gpt-6-astra', effort: 'high', permission: 'accept-edits' } })
  }
  type Succession = { handedOff: boolean; successor: boolean; agentSessionId: string; tabId: string; title: string; wizard: boolean; continueOnLimit: boolean; coworkers: string[]; controller: string | null; restart: { initiator: boolean; request: boolean }; note: string }

  it('opens the successor as a root wizard, moves every coworker to it and leaves one wizard in the workspace', async () => {
    const f = fixture(false, undefined, undefined, astra)
    asWizard(f)
    const first = await f.control.call(f.scope, 'tabs.open', { title: 'W1' }) as AgentControlTab
    const second = await f.control.call(f.scope, 'tabs.open', { title: 'W2' }) as AgentControlTab
    // A restart this wizard asked the owner for, and one it started, both name it.
    f.database.setSetting(RESTART_REQUEST_KEY, encodeRestartRequest({ agentSessionId: f.spec.id, title: 'Controller', reason: 'Install the batch', at: new Date().toISOString() }))
    f.database.setSetting(RESTART_INITIATOR_KEY, encodeRestartInitiator({ agentSessionId: f.spec.id, method: 'app.restart', at: new Date().toISOString() }))
    const body = handoff()
    const result = await f.control.call(f.scope, 'agents.handoff', { handoff: body, successor: true }) as Succession
    expect(result).toMatchObject({ handedOff: true, successor: true, title: 'Controller (continued)', wizard: true, continueOnLimit: true, controller: null, restart: { initiator: true, request: true } })
    expect(result.coworkers.sort()).toEqual([first.resourceId, second.resourceId].sort())
    const successor = result.agentSessionId, successorScope = { ...f.scope, agentSessionId: successor }
    // A root: nobody controls it, least of all the conversation it continues.
    const links = f.control.listLinks(f.project.id, f.workspace.id)
    expect(links.find(link => link.targetAgentSessionId === successor)).toBeUndefined()
    // Every link moved, to the successor's own tab.
    expect(links.filter(link => [first.resourceId, second.resourceId].includes(link.targetAgentSessionId)).map(link => [link.controllerAgentSessionId, link.controllerTabId])).toEqual([[successor, result.tabId], [successor, result.tabId]])
    // Same brain: wizard, model, effort, mode and limit continuation.
    expect(f.database.structured.snapshot(successor)?.settings).toMatchObject({ wizard: true, model: 'gpt-6-astra', effort: 'high', permission: 'accept-edits' })
    expect(f.database.structured.spec<AgentSpec>(successor)?.continueOnLimit).toBe(true)
    // One owner-authority main: the caller lost the wand, the successor holds it.
    expect(f.database.structured.snapshot(f.spec.id)?.settings.wizard).toBe(false)
    const listed = await f.control.call(successorScope, 'agents.list', {}) as Array<{ agentSessionId: string; wizard: boolean; superseded?: { by: string } }>
    expect(listed.filter(entry => entry.wizard).map(entry => entry.agentSessionId)).toEqual([successor])
    await expect(f.control.call(f.scope, 'app.state', {})).resolves.not.toHaveProperty('wizard')
    expect(await f.control.call(successorScope, 'app.state', {})).toMatchObject({ wizard: true })
    // The caller is superseded by its successor and says so in its own tab.
    expect(listed.find(entry => entry.agentSessionId === f.spec.id)?.superseded).toMatchObject({ by: successor })
    const notice = f.database.structured.snapshot(f.spec.id)!.items.map(item => item.data).find(data => data.type === 'notice' && typeof data.payload === 'object' && data.payload !== null && 'succession' in data.payload)
    expect(notice).toMatchObject({ message: expect.stringContaining('Continued in “Controller (continued)”'), payload: { succession: { agentSessionId: successor, tabId: result.tabId, title: 'Controller (continued)' } } })
    // The handoff is the successor's first prompt, followed by who it now is.
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0]!.prompt.startsWith(body)).toBe(true)
    expect(f.submissions[0]!.prompt).toContain(`successor of “Controller” (${f.spec.id})`)
    // The restart that would have brought the caller back brings the successor back.
    expect(parseRestartRequest(f.database.getSetting(RESTART_REQUEST_KEY), new Date())).toMatchObject({ agentSessionId: successor, title: 'Controller (continued)', reason: 'Install the batch' })
    expect(takeRestartInitiator(f.database.getSetting(RESTART_INITIATOR_KEY), new Date())).toMatchObject({ agentSessionId: successor, method: 'app.restart' })
    // Recorded for the audit trail.
    const recorded = f.collaboration.listMessages({ projectId: f.project.id, sessionId: f.workspace.id }).filter(message => message.metadata?.handoff === 'successor')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ agentSessionId: f.spec.id, toAgentSessionId: successor })
    expect(result.note).toMatch(/no longer control/)
  })

  it('sends coworker reports, steering and configuration to the successor, and no longer to the caller', async () => {
    const f = fixture(false, undefined, undefined, astra)
    asWizard(f)
    const worker = await f.control.call(f.scope, 'tabs.open', { title: 'W1' }) as AgentControlTab
    const workerScope = { ...f.scope, agentSessionId: worker.resourceId! }
    expect(await f.control.call(workerScope, 'agents.report', { text: 'before' })).toMatchObject({ agentSessionId: f.spec.id })
    const result = await f.control.call(f.scope, 'agents.handoff', { handoff: handoff(), successor: true }) as Succession
    const successorScope = { ...f.scope, agentSessionId: result.agentSessionId }
    expect(await f.control.call(workerScope, 'agents.report', { text: 'W1 DONE abc123' })).toEqual({ agentSessionId: result.agentSessionId, delivery: expect.any(String) })
    expect(f.submissions.at(-1)).toMatchObject({ prompt: 'W1 DONE abc123' })
    // The superseded caller, no longer a wizard, cannot steer or configure what it handed over.
    await expect(f.control.call(f.scope, 'agents.submit', { agentSessionId: worker.resourceId, prompt: 'from the old main' })).rejects.toThrow('Another agent already controls this tab')
    await expect(f.control.call(f.scope, 'agents.configure', { agentSessionId: worker.resourceId, model: 'codex-advanced', effort: 'high' })).rejects.toThrow()
    await expect(f.control.call(successorScope, 'agents.submit', { agentSessionId: worker.resourceId, prompt: 'from the successor' })).resolves.toBeTruthy()
    expect((await f.control.call(successorScope, 'agents.list', {}) as Array<{ agentSessionId: string; controlledBy?: string | null }>).some(entry => entry.agentSessionId === worker.resourceId)).toBe(true)
  })

  it('is for a main brain only, and says what to use instead', async () => {
    const f = fixture()
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff(), successor: 'yes' })).rejects.toThrow('successor must be true or false')
    // Neither a wizard nor a controller: nothing is opened.
    await expect(f.control.call(f.scope, 'agents.handoff', { handoff: handoff(), successor: true })).rejects.toThrow(/main brain.*without successor/)
    expect(f.control.tabs(f.scope).filter(tab => tab.kind === 'agent')).toHaveLength(1)
    // A controller with a live coworker is one, wand or not; it keeps its limit continuation.
    const state = f.database.structured.snapshot(f.spec.id)!
    f.sessions.setContinueOnLimit(f.spec.id, true)
    const worker = await f.control.call(f.scope, 'tabs.open', { title: 'W1' }) as AgentControlTab
    const result = await f.control.call(f.scope, 'agents.handoff', { handoff: handoff(), successor: true }) as Succession
    expect(result).toMatchObject({ successor: true, wizard: false, continueOnLimit: true, coworkers: [worker.resourceId] })
    expect(f.database.structured.snapshot(result.agentSessionId)?.settings.wizard).toBeFalsy()
    expect(f.database.structured.spec<AgentSpec>(result.agentSessionId)?.continueOnLimit).toBe(true)
    expect(state.settings.wizard).toBeFalsy()
  })

  it('keeps a sub-controller’s successor under the same controller, so its reports still go up', async () => {
    const f = fixture()
    const middle = await f.control.call(f.scope, 'tabs.open', { title: 'Lead' }) as AgentControlTab
    const middleScope = { ...f.scope, agentSessionId: middle.resourceId! }
    const worker = await f.control.call(middleScope, 'tabs.open', { title: 'W1' }) as AgentControlTab
    const result = await f.control.call(middleScope, 'agents.handoff', { handoff: handoff(), successor: true }) as Succession
    expect(result).toMatchObject({ controller: f.spec.id, coworkers: [worker.resourceId] })
    const links = f.control.listLinks(f.project.id, f.workspace.id)
    expect(links.find(link => link.targetAgentSessionId === result.agentSessionId)?.controllerAgentSessionId).toBe(f.spec.id)
    expect(links.find(link => link.targetAgentSessionId === worker.resourceId)?.controllerAgentSessionId).toBe(result.agentSessionId)
    expect(await f.control.call({ ...f.scope, agentSessionId: result.agentSessionId }, 'agents.report', { text: 'Lead handed on' })).toMatchObject({ agentSessionId: f.spec.id })
  })
  it('nudges a wizard once, as a Conductor notice in its tab, when it passes the succession threshold', async () => {
    let briefings: TurnBriefings | undefined
    const f = fixture(false, undefined, undefined, astra, (spec, prompt, itemId, runtimeId, context) => briefings!.compose(spec, prompt, itemId, runtimeId, context))
    briefings = new TurnBriefings({ database: f.database })
    asWizard(f)
    const nudges = () => f.database.structured.snapshot(f.spec.id)!.items.filter(item => item.data.type === 'notice' && typeof item.data.payload === 'object' && item.data.payload !== null && !Array.isArray(item.data.payload) && item.data.payload[SUCCESSION_NUDGE] === true)
    for (let turn = 1; turn <= SUCCESSION_TURNS + 5; turn++) {
      await f.sessions.submit(f.spec.id, 'Coworker report ' + turn, f.database.structured.snapshot(f.spec.id)!.settings)
      expect(nudges()).toHaveLength(turn < SUCCESSION_TURNS ? 0 : 1)
    }
    // The prompt that crossed carried the nudge, and it told the wizard how to hand off from its first message.
    const prompts = f.submissions.map(entry => entry.prompt)
    expect(prompts.filter(prompt => prompt.includes('Conductor: this main conversation'))).toHaveLength(1)
    expect(prompts[SUCCESSION_TURNS - 1]).toContain('Conductor: this main conversation has run ' + SUCCESSION_TURNS + ' turns')
    expect(prompts[0]).toContain('agents.handoff({handoff, successor:true})')
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

describe('the owner control credential', () => {
  it('resolves an owner scope to a named or default project and workspace, and never to a conversation', () => {
    const f = fixture()
    const owner = f.control.ownerScope({ projectId: f.project.id })
    expect(owner).toEqual({ projectId: f.project.id, sessionId: f.workspace.id, agentSessionId: 'owner', owner: true })
    expect(f.control.ownerScope(undefined)).toMatchObject({ projectId: f.project.id, owner: true })
    expect(() => f.control.ownerScope({ projectId: 'nope' })).toThrow(/projects.open/)
    expect(() => f.control.ownerScope({ projectId: f.project.id, workspaceId: 'nope' })).toThrow(/workspace/)
    expect(() => f.control.ownerScope({ agentSessionId: f.spec.id })).toThrow(/only projectId and workspaceId/)
    expect(f.control.authorize(owner)).toMatchObject({ id: 'owner', provider: 'claude', cwd: f.project.path })
  })

  it('bootstraps a profile with no project: discovery and projects.open answer, everything else names the gap', async () => {
    const f = fixture()
    const folder = join(f.root, 'fresh'); mkdirSync(folder)
    const host = { version: '1.0.0', pid: 1, openProject: vi.fn(async (path: string) => f.database.upsertProject(path, 'Fresh')), relaunch: vi.fn(async () => {}) }
    const control = new AgentControl({ ...f.deps, host })
    f.database.removeProject(f.project.id)
    const empty = control.ownerScope(undefined)
    expect(empty).toEqual({ projectId: '', sessionId: '', agentSessionId: 'owner', owner: true })
    expect(control.authorize(empty)).toMatchObject({ id: 'owner', cwd: '' })
    expect(Object.keys(await control.call(empty, 'tools.list', {}) as object)).toContain('projects.open')
    expect(await control.call(empty, 'projects.list', {})).toEqual([])
    await expect(control.call(empty, 'tabs.list', {})).rejects.toThrow(/needs a project: none is open/)
    await expect(control.call(empty, 'app.state', {})).rejects.toThrow(/projects.open/)
    const registered = await control.call(empty, 'projects.open', { path: folder }) as { id: string }
    expect(control.ownerScope(undefined)).toMatchObject({ projectId: registered.id, owner: true })
    // A registered project opens with its launcher tab and is now the default owner scope.
    expect(await control.call(control.ownerScope({ projectId: registered.id }), 'tabs.list', {})).toEqual([expect.objectContaining({ kind: 'launcher' })])
  })

  it('opens coworkers on Auto without a tab of its own, drives them, and needs no confirmation dialog', async () => {
    const f = fixture(false, { claude: ['default', 'read-only', 'accept-edits', 'auto'] })
    const owner = f.control.ownerScope({ projectId: f.project.id })
    const opened = await f.control.call(owner, 'tabs.open', { provider: 'claude', title: 'Overseer fixer', focus: false }) as { id: string; resourceId: string }
    expect(f.database.structured.snapshot(opened.resourceId)!.settings.permission).toBe('auto')
    // No cable: the owner has no tab to draw one from, and reaches the coworker all the same.
    expect(f.database.getSetting('agentControlParent:' + opened.resourceId)).toBeFalsy()
    await f.control.call(owner, 'agents.submit', { agentSessionId: opened.resourceId, prompt: 'Fix the failing goal' })
    expect(f.submissions.at(-1)).toMatchObject({ provider: 'claude', prompt: 'Fix the failing goal' })
    expect(await f.control.call(owner, 'agents.status', { agentSessionId: opened.resourceId })).toMatchObject({ agentSessionId: opened.resourceId, phase: 'completed' })
    expect(await f.control.call(owner, 'app.state', {})).toMatchObject({ owner: true, appVersion: null })
    // A coworker another agent controls is still the owner's to steer, exactly as from the window.
    const controlled = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Controlled worker' }) as { resourceId: string }
    await f.control.call(owner, 'agents.submit', { agentSessionId: controlled.resourceId, prompt: 'Owner steering' })
    expect(f.submissions.at(-1)).toMatchObject({ prompt: 'Owner steering' })
    // Owner writes ask nobody: forgetting an agent memory happens without the confirm dialog.
    await f.control.call(owner, 'memory.remember', { gist: 'The overseer keeps its runs under artifacts/overseer.' })
    const memory = f.database.listMemories(f.project.id).find(entry => entry.source === 'agent')!
    expect(await f.control.call(owner, 'memory.forget', { id: memory.id })).toEqual({ removed: true })
    expect(f.confirm).not.toHaveBeenCalled()
    await expect(f.control.call(owner, 'agents.handoff', { handoff: 'x' })).rejects.toThrow(/no conversation to hand off/)
  })

  it('answers the owner-only app methods through the host hooks, and refuses them to conversations', async () => {
    const f = fixture()
    let phase: 'idle' | 'ready' = 'idle'
    const state = () => ({ phase, currentVersion: '1.0.0', availableVersion: phase === 'ready' ? '1.0.1' : undefined, configured: true })
    const host = {
      version: '1.0.0', pid: 4242,
      openProject: vi.fn(async (path: string, name?: string) => f.database.upsertProject(path, name ?? 'Registered')),
      updates: { state: vi.fn(state), check: vi.fn(async () => state()), download: vi.fn(async () => state()), install: vi.fn(async () => {}) },
      relaunch: vi.fn(async () => {})
    }
    const control = new AgentControl({ ...f.deps, host })
    const owner = control.ownerScope({ projectId: f.project.id })
    expect(await control.call(owner, 'app.state', {})).toMatchObject({ owner: true, appVersion: '1.0.0', pid: 4242, updates: { phase: 'idle' } })
    expect(Object.keys(await control.call(owner, 'tools.list', {}) as object)).toEqual(expect.arrayContaining(['projects.open', 'app.restart', 'app.update.install']))
    expect(Object.keys(await control.call(f.scope, 'tools.list', {}) as object)).not.toContain('app.restart')
    const folder = join(f.root, 'registered'); mkdirSync(folder)
    const registered = await control.call(owner, 'projects.open', { path: folder }) as { id: string; path: string; workspaces: Array<{ id: string }> }
    expect(host.openProject).toHaveBeenCalledWith(folder, undefined)
    expect(registered.workspaces.length).toBe(1)
    expect(control.ownerScope({ projectId: registered.id })).toMatchObject({ projectId: registered.id, sessionId: registered.workspaces[0]!.id })
    expect(await control.call(owner, 'app.update.check', {})).toMatchObject({ phase: 'idle' })
    await expect(control.call(owner, 'app.update.install', {})).rejects.toThrow(/phase idle/)
    phase = 'ready'
    vi.useFakeTimers()
    expect(await control.call(owner, 'app.update.install', { force: true })).toMatchObject({ installing: true, version: '1.0.1', force: true })
    expect(await control.call(owner, 'app.restart', {})).toMatchObject({ restarting: true, force: true })
    expect(await control.call(owner, 'app.restart', { force: false })).toMatchObject({ restarting: true, force: false })
    expect(host.updates.install).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(host.updates.install).toHaveBeenCalledWith(true)
    expect(host.relaunch.mock.calls).toEqual([[true], [false]])
    // 19c298e4 (V3 S12): a restart that has to ask the owner first says so instead of restarting:true.
    const asking = new AgentControl({ ...f.deps, host: { ...host, stopConfirmation: { pending: () => null, answer: () => null, wouldAsk: () => [{ id: 'agent-a', title: 'Worker' }] } } })
    const askingOwner = asking.ownerScope({ projectId: f.project.id })
    expect(await asking.call(askingOwner, 'app.restart', { force: false })).toMatchObject({ restarting: false, confirmationPending: true, running: [{ id: 'agent-a', title: 'Worker' }] })
    expect(await asking.call(askingOwner, 'app.restart', { force: true })).toMatchObject({ restarting: true, force: true })
    await vi.runAllTimersAsync()
    expect(host.relaunch.mock.calls).toEqual([[true], [false], [false], [true]])
    vi.useRealTimers()
    await expect(control.call(owner, 'app.update.install', { force: 'yes' })).rejects.toThrow(/force must be/)
    await expect(control.call(f.scope, 'app.restart', {})).rejects.toThrow(/owner's own control credential/)
    await expect(control.call(f.scope, 'projects.open', { path: folder })).rejects.toThrow(/owner's own control credential/)
    await expect(f.control.call(f.control.ownerScope({ projectId: f.project.id }), 'app.restart', {})).rejects.toThrow(/unavailable in this Conductor/)
  })

  it('serves the owner credential over the loopback server from a file it writes at start and removes at close', async () => {
    const f = fixture()
    const path = join(f.root, 'profile', 'control-owner.json')
    const server = new AgentControlServer(f.control, false, undefined, { path, appVersion: '1.2.3', packaged: false })
    dispose.push(() => server.close())
    await server.start()
    expect(server.ownerCredentialPath).toBe(path)
    const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number; endpoint: string; token: string; pid: number; appVersion: string; packaged: boolean }
    expect(file).toMatchObject({ version: 1, pid: process.pid, appVersion: '1.2.3', packaged: false })
    expect(file.token).toMatch(/^[a-f0-9]{64}$/)
    const post = async (token: string, body: unknown) => {
      const response = await fetch(file.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() as { result?: unknown; error?: string } }
    }
    const listed = await post(file.token, { method: 'tools.list', args: {}, scope: { projectId: f.project.id } })
    expect(listed.status).toBe(200)
    expect(Object.keys(listed.body.result as object)).toContain('projects.open')
    const defaulted = await post(file.token, { method: 'app.state', args: {} })
    expect(defaulted.body.result).toMatchObject({ owner: true, projectId: f.project.id })
    expect((await post(file.token, { method: 'tools.list', args: {}, scope: { projectId: 'nope' } })).body.error).toMatch(/projects.open/)
    expect((await post('0'.repeat(64), { method: 'tools.list', args: {} })).status).toBe(401)
    // A conversation's credential is unchanged: no owner methods, no scope of its choosing.
    const agentToken = server.briefing(f.spec).match(/Bearer ([a-f0-9]+)/)![1]!
    const agentListed = await post(agentToken, { method: 'tools.list', args: {}, scope: { projectId: 'ignored' } })
    expect(agentListed.status).toBe(200)
    expect(Object.keys(agentListed.body.result as object)).not.toContain('app.restart')
    server.close()
    expect(existsSync(path)).toBe(false)
  })
})

describe('wizard tabs', () => {
  const asWizard = (f: ReturnType<typeof fixture>, model: string) => {
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, wizard: true, model } })
  }

  it('a wizard tab holds the owner’s authority in its own conversation, on a frontier model only', async () => {
    const f = fixture(false, { claude: ['default', 'read-only', 'accept-edits', 'auto'] })
    const host = { version: '2.0.0', pid: 77, relaunch: vi.fn(async () => {}), updates: { state: vi.fn(() => ({ phase: 'idle' as const, currentVersion: '2.0.0', configured: true })), check: vi.fn(async () => ({ phase: 'idle' as const, currentVersion: '2.0.0', configured: true })), download: vi.fn(async () => ({ phase: 'idle' as const, currentVersion: '2.0.0', configured: true })), install: vi.fn(async () => {}) } }
    const control = new AgentControl({ ...f.deps, host })
    // The controller is a Codex tab on the synthetic model: no wand, no owner authority.
    await expect(control.call(f.scope, 'app.restart', {})).rejects.toThrow(/wizard tab/)
    expect(await control.call(f.scope, 'app.state', {})).not.toHaveProperty('wizard')
    // The wand on a lesser model changes nothing.
    asWizard(f, 'codex-synthetic')
    await expect(control.call(f.scope, 'app.restart', {})).rejects.toThrow(/wizard tab/)
    expect((await control.call(f.scope, 'agents.list', {}) as Array<{ agentSessionId: string; wizard: boolean }>).find(entry => entry.agentSessionId === f.spec.id)?.wizard).toBe(false)
    // The wand on a frontier model: owner-only methods, no dialogs, coworkers on Auto that continue after limits.
    asWizard(f, 'gpt-6-astra')
    expect(await control.call(f.scope, 'app.state', {})).toMatchObject({ wizard: true, owner: false, appVersion: '2.0.0' })
    expect(Object.keys(await control.call(f.scope, 'tools.list', {}) as object)).toContain('app.restart')
    expect((await control.call(f.scope, 'agents.list', {}) as Array<{ agentSessionId: string; wizard: boolean }>).find(entry => entry.agentSessionId === f.spec.id)?.wizard).toBe(true)
    vi.useFakeTimers()
    expect(await control.call(f.scope, 'app.restart', { force: true })).toMatchObject({ restarting: true, force: true })
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    expect(host.relaunch).toHaveBeenCalledWith(true, { agentSessionId: f.spec.id, method: 'app.restart' })
    const opened = await control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Wizard’s worker', focus: false }) as { id: string; resourceId: string }
    expect(f.database.structured.snapshot(opened.resourceId)!.settings.permission).toBe('auto')
    expect(f.database.structured.spec<AgentSpec>(opened.resourceId)?.continueOnLimit).toBe(true)
    // The cable still exists: a wizard is a conversation with a tab, not the credential file.
    expect(f.database.getSetting('agentControlParent:' + opened.resourceId)).toBeTruthy()
    await control.call(f.scope, 'memory.remember', { gist: 'Wizard memory' })
    const memory = f.database.listMemories(f.project.id).find(entry => entry.source === 'agent')!
    expect(await control.call(f.scope, 'memory.forget', { id: memory.id })).toEqual({ removed: true })
    expect(f.confirm).not.toHaveBeenCalled()
    // Read-only or planning switches the wand off without touching the setting.
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, plan: true } })
    await expect(control.call(f.scope, 'app.restart', {})).rejects.toThrow(/wizard tab/)
  })

  it('reads the full text of a tool output the history only carries a tail of', async () => {
    const f = fixture()
    const worker = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Worker' }) as { resourceId: string }
    const artifactId = f.database.structured.putOutput(worker.resourceId, 'x'.repeat(50_000) + '{"result":{"outcomes":[]}}')
    const read = await f.control.call(f.scope, 'agents.artifact', { agentSessionId: worker.resourceId, artifactId }) as { content: string; bytes: number; truncated: boolean }
    expect(read.bytes).toBe(50_026)
    expect(read.truncated).toBe(false)
    expect(read.content.endsWith('{"result":{"outcomes":[]}}')).toBe(true)
    await expect(f.control.call(f.scope, 'agents.artifact', { agentSessionId: worker.resourceId, artifactId: 'missing' })).rejects.toThrow(/No such tool output artifact/)
    expect(JSON.stringify(await f.control.call(f.scope, 'tools.list', {}))).toContain('agents.artifact')
  })
})
describe('durable jobs over app control', () => {
  const localProvider: AgentProviderInfo = { id: 'local', displayName: 'Local', available: true, installUrl: '', models: [{ id: 'local/qwen3.6-35b-a3b', label: 'Qwen 3.6 35B A3B' }], efforts: [{ id: 'low', label: 'Low' }] }
  const jobsFixture = () => {
    const f = fixture()
    const service = new FakeDurableJobsService()
    const control = new AgentControl({ ...f.deps, providers: () => [...f.deps.providers(), localProvider] })
    control.setDurableJobs(service)
    const local: AgentSpec = { ...f.spec, id: 'local-worker', provider: 'local', title: 'Local worker' }
    f.sessions.ensure(local)
    openAgentTab(f, local.id, 'local-tab')
    const peer: AgentSpec = { ...f.spec, id: 'peer', title: 'Peer' }
    f.sessions.ensure(peer)
    openAgentTab(f, peer.id, 'peer-tab')
    return { ...f, service, control, localScope: { ...f.scope, agentSessionId: local.id }, peerScope: { ...f.scope, agentSessionId: peer.id }, owner: control.ownerScope({ projectId: f.project.id }) }
  }
  const create = { objective: 'Make the invoice parser accept Fio exports', model: 'local/qwen3.6-35b-a3b', constraints: ['Do not touch src/main/index.ts'] }

  it('lists jobs.* only once the job controller is plugged in, through the setDurableJobs hook', async () => {
    const f = fixture()
    const control = new AgentControl({ ...f.deps, providers: () => [...f.deps.providers(), localProvider] })
    expect(Object.keys(await control.call(f.scope, 'tools.list') as object)).not.toContain('jobs.create')
    await expect(control.call(f.scope, 'jobs.list')).rejects.toThrow(/unavailable/)
    control.setDurableJobs(new FakeDurableJobsService())
    expect(Object.keys(await control.call(f.scope, 'tools.list') as object)).toEqual(expect.arrayContaining(['jobs.create', 'jobs.list', 'jobs.status', 'jobs.events', 'jobs.pause', 'jobs.resume', 'jobs.cancel', 'jobs.report']))
    expect(await control.call(f.scope, 'jobs.list')).toEqual([])
  })

  it('lets the owner, a wizard tab or a writable non-local conversation create a job on a local model only', async () => {
    const f = jobsFixture()
    const byOwner = await f.control.call(f.owner, 'jobs.create', create) as DurableJobSummary
    expect(byOwner).toMatchObject({ projectId: f.project.id, status: 'queued', model: 'local/qwen3.6-35b-a3b', title: 'Make the invoice parser accept Fio exports' })
    expect(f.service.created[0]).toMatchObject({ projectId: f.project.id, workspaceId: f.workspace.id, constraints: ['Do not touch src/main/index.ts'], createdBy: { kind: 'owner', agentSessionId: 'owner' } })
    const byController = await f.control.call(f.scope, 'jobs.create', { ...create, title: 'Parser', stages: [{ title: 'Reproduce', objective: 'Reproduce it', completionCriteria: ['failing test'] }], budgets: { maxStageAttempts: 2 }, isolateWorktree: true }) as DurableJobSummary
    expect(f.service.created[1]).toMatchObject({ title: 'Parser', stages: [{ title: 'Reproduce' }], budgets: { maxStageAttempts: 2 }, isolateWorktree: true, createdBy: { kind: 'agent', agentSessionId: f.spec.id } })
    expect(byController.stagesTotal).toBe(1)
    // Never a cloud model, and no argument through which one could be asked for.
    await expect(f.control.call(f.scope, 'jobs.create', { ...create, model: 'claude-synthetic' })).rejects.toThrow(/local model only/)
    await expect(f.control.call(f.scope, 'jobs.create', { ...create, escalation: 'report-and-block' })).rejects.toThrow(/escalation is not an argument/)
    await expect(f.control.call(f.scope, 'jobs.create', { ...create, provider: 'claude' })).rejects.toThrow(/provider is not an argument/)
    await expect(f.control.call(f.scope, 'jobs.create', { ...create, budgets: { cloudFallback: 1 } })).rejects.toThrow(/budgets accepts only/)
    // A sandboxed local model starts nothing; neither does a read-only turn.
    await expect(f.control.call(f.localScope, 'jobs.create', create)).rejects.toThrow(/sandboxed local conversation cannot start/)
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, permission: 'read-only' } })
    await expect(f.control.call(f.scope, 'jobs.create', create)).rejects.toThrow(/read-only/)
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, wizard: true, model: 'gpt-6-astra' } })
    await f.control.call(f.scope, 'jobs.create', create)
    expect(f.service.created[2]).toMatchObject({ createdBy: { kind: 'wizard' } })
    expect(f.service.created).toHaveLength(3)
  })

  it('lets the creator, the owner and a wizard tab pause, resume and cancel; others and local models only read', async () => {
    const f = jobsFixture()
    const job = await f.control.call(f.scope, 'jobs.create', create) as DurableJobSummary
    f.service.setStatus(job.id, 'running')
    // Anyone in the project reads it, a local model included.
    for (const scope of [f.localScope, f.peerScope]) {
      expect(await f.control.call(scope, 'jobs.status', { jobId: job.id })).toMatchObject({ id: job.id, status: 'running' })
      expect((await f.control.call(scope, 'jobs.list') as DurableJobSummary[]).map(entry => entry.id)).toEqual([job.id])
      expect((await f.control.call(scope, 'jobs.events', { jobId: job.id, limit: 1 }) as DurableJobEvent[])).toHaveLength(1)
      expect(await f.control.call(scope, 'jobs.report', { jobId: job.id })).toMatchObject({ jobId: job.id, cloudEscalation: { occurred: false }, reportPath: expect.stringContaining('report.md') })
    }
    await expect(f.control.call(f.localScope, 'jobs.pause', { jobId: job.id })).rejects.toThrow(/sandboxed local conversation cannot change/)
    await expect(f.control.call(f.localScope, 'jobs.cancel', { jobId: job.id })).rejects.toThrow(/sandboxed local conversation cannot change/)
    await expect(f.control.call(f.peerScope, 'jobs.pause', { jobId: job.id })).rejects.toThrow(/conversation that created this job/)
    expect(f.service.status(job.id).status).toBe('running')
    expect(await f.control.call(f.scope, 'jobs.pause', { jobId: job.id, reason: 'Owner wants the GPU' })).toMatchObject({ status: 'paused', statusReason: 'Owner wants the GPU' })
    expect(await f.control.call(f.scope, 'jobs.resume', { jobId: job.id })).toMatchObject({ status: 'running' })
    expect(await f.control.call(f.owner, 'jobs.pause', { jobId: job.id })).toMatchObject({ status: 'paused' })
    // An illegal transition is the service's to refuse, and it reaches the caller as is.
    await expect(f.control.call(f.owner, 'jobs.pause', { jobId: job.id })).rejects.toThrow(/cannot become paused/)
    const state = f.database.structured.snapshot(f.peerScope.agentSessionId)!
    f.database.structured.update(f.peerScope.agentSessionId, { settings: { ...state.settings, wizard: true, model: 'gpt-6-astra' } })
    expect(await f.control.call(f.peerScope, 'jobs.cancel', { jobId: job.id, reason: 'Superseded' })).toMatchObject({ status: 'cancelled' })
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it('treats another project’s job as missing and bounds the event page', async () => {
    const f = jobsFixture()
    const foreign = await f.service.create({ projectId: 'another-project', title: 'Theirs', objective: 'O', model: 'local/qwen3.6-35b-a3b' })
    await expect(f.control.call(f.owner, 'jobs.status', { jobId: foreign.id })).rejects.toThrow(/No durable job with that id in this project/)
    await expect(f.control.call(f.owner, 'jobs.cancel', { jobId: foreign.id })).rejects.toThrow(/No durable job with that id in this project/)
    await expect(f.control.call(f.owner, 'jobs.status', { jobId: 'job_missing' })).rejects.toThrow(/No durable job with that id in this project/)
    expect(await f.control.call(f.owner, 'jobs.list')).toEqual([])
    await expect(f.control.call(f.owner, 'jobs.list', { status: ['sleeping'] })).rejects.toThrow(/job statuses/)
    const job = await f.control.call(f.owner, 'jobs.create', create) as DurableJobSummary
    for (let index = 0; index < 250; index += 1) f.service.record(job.id, 'note', `note ${index}`)
    expect(await f.control.call(f.owner, 'jobs.events', { jobId: job.id, limit: 1000 })).toHaveLength(200)
    const first = await f.control.call(f.owner, 'jobs.events', { jobId: job.id, limit: 2 }) as DurableJobEvent[]
    expect((await f.control.call(f.owner, 'jobs.events', { jobId: job.id, afterId: first[1]!.id, limit: 1 }) as DurableJobEvent[])[0]!.message).toBe('note 1')
    await expect(f.control.call(f.owner, 'jobs.events', { jobId: job.id, limit: 0 })).rejects.toThrow(/positive whole number/)
  })

  it('opens a job tab whose identity is the job id, returns it when asked again and reopens it after a close', async () => {
    const f = jobsFixture()
    const job = await f.control.call(f.scope, 'jobs.create', create) as DurableJobSummary
    const opened = await f.control.call(f.scope, 'tabs.open', { kind: 'job', jobId: job.id }) as AgentControlTab
    expect(opened).toMatchObject({ kind: 'job', resourceId: job.id, title: job.title })
    const again = await f.control.call(f.scope, 'tabs.open', { kind: 'job', jobId: job.id }) as AgentControlTab
    expect(again.id).toBe(opened.id)
    // An agent asking again gets the open tab back without moving the owner there (FX21);
    // focus:true brings it into view once the owner pauses typing.
    expect(f.requests.at(-1)?.action).toBe('tabs.open')
    await f.control.call(f.scope, 'tabs.open', { kind: 'job', jobId: job.id, focus: true })
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.focus', params: { tabId: opened.id, whenIdle: true } })
    // Closing the tab is a layout change; the job and its id are untouched.
    const layout = f.database.getSession(f.workspace.id)!.layout
    if (layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    layout.root.tabs = layout.root.tabs.filter(tab => tab.id !== opened.id)
    f.database.saveSession(f.workspace.id, layout, null, [])
    const reopened = await f.control.call(f.scope, 'tabs.open', { kind: 'job', jobId: job.id }) as AgentControlTab
    expect(reopened.id).not.toBe(opened.id)
    expect(reopened.resourceId).toBe(job.id)
    expect(f.service.list()).toHaveLength(1)
    await expect(f.control.call(f.scope, 'tabs.open', { kind: 'job', jobId: 'job_missing' })).rejects.toThrow(/No durable job/)
  })
})
describe('control catalog and dispatch repairs', () => {
  const phase = (f: ReturnType<typeof fixture>, id: string, value: SessionProjection['phase']): void => {
    const state = f.database.structured.snapshot(id)!, spec = f.database.structured.spec<AgentSpec>(id)!
    f.database.structured.append({ schemaVersion: 1, id: 'phase-' + id + '-' + (state.sequence + 1), sequence: state.sequence + 1, sessionId: id, runtimeId: state.runtimeId || 'phase-runtime', provider: spec.provider as StructuredProvider, projectId: spec.projectId, workspaceId: spec.sessionId, cwd: spec.cwd, timestamp: new Date().toISOString(), data: { type: 'session', phase: value } })
  }
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

  it('lists Grok beside Codex and Claude, opens it in planning under a planning controller and configures it', async () => {
    const f = fixture(false, { grok: ['default', 'accept-edits', 'auto'] })
    f.deps.providers().push({ id: 'grok', displayName: 'Grok', available: true, installUrl: '', models: [{ id: 'grok-synthetic', label: 'Grok Synthetic' }], efforts: [{ id: 'low', label: 'Low' }] })
    const catalog = await f.control.call(f.scope, 'models.list') as Array<{ provider: string; models: Array<{ id: string }> }>
    expect(catalog.map(entry => entry.provider)).toEqual(['codex', 'claude', 'grok'])
    expect(catalog.find(entry => entry.provider === 'grok')?.models[0]?.id).toBe('grok-synthetic')
    expect((await f.control.call(f.scope, 'tools.list') as Record<string, string>)['tabs.open']).toContain('a Claude, Codex or Grok coworker opens on Auto')
    const auto = await f.control.call(f.scope, 'tabs.open', { provider: 'grok', model: 'grok-synthetic' }) as AgentControlTab
    expect(f.database.structured.snapshot(auto.resourceId!)?.settings).toMatchObject({ permission: 'auto', plan: false })
    expect(await f.control.call(f.scope, 'agents.configure', { agentSessionId: auto.resourceId, model: 'grok-advanced', effort: 'high' })).toMatchObject({ provider: 'grok', model: 'grok-advanced', effort: 'high' })
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, plan: true } })
    const planning = await f.control.call(f.scope, 'tabs.open', { provider: 'grok', model: 'grok-synthetic' }) as AgentControlTab
    expect(f.database.structured.snapshot(planning.resourceId!)?.settings.plan).toBe(true)
  })

  it('describes git.ship as a local commit unless publish is asked for, and passes publish through', async () => {
    const f = fixture()
    const catalog = await f.control.call(f.scope, 'tools.list') as Record<string, string>
    expect(catalog['git.ship']).toContain('a local commit')
    expect(catalog['git.ship']).toContain('publish: true')
    expect(catalog['git.ship']).not.toContain('then it waits for the release the push triggers')
    await f.control.call(f.scope, 'git.ship', { message: 'Local' })
    expect(f.delivery.ship).toHaveBeenLastCalledWith(f.project.id, f.project.path, { message: 'Local' }, expect.anything())
    await f.control.call(f.scope, 'git.ship', { message: 'Release', publish: true })
    expect(f.delivery.ship).toHaveBeenLastCalledWith(f.project.id, f.project.path, { message: 'Release', publish: true }, expect.anything())
    await f.control.call(f.scope, 'git.ship', { message: 'Still local', publish: false })
    expect(f.delivery.ship).toHaveBeenLastCalledWith(f.project.id, f.project.path, { message: 'Still local' }, expect.anything())
    const local: AgentSpec = { ...f.spec, id: 'local-worker', provider: 'local', title: 'Local worker' }
    f.sessions.ensure(local)
    openAgentTab(f, local.id, 'local-tab')
    await expect(f.control.call({ ...f.scope, agentSessionId: local.id }, 'git.ship', { message: 'Local' })).rejects.toThrow('declined')
    expect(f.confirm).toHaveBeenLastCalledWith(expect.anything(), 'Local worker wants to test, build and commit this project on this machine (no push, no release).')
    await expect(f.control.call({ ...f.scope, agentSessionId: local.id }, 'git.ship', { message: 'Release', publish: true })).rejects.toThrow('declined')
    expect(f.confirm).toHaveBeenLastCalledWith(expect.anything(), 'Local worker wants to test, build and commit this project, push it and publish its release.')
    expect(f.delivery.ship).toHaveBeenCalledTimes(3)
  })

  it('says jobs.pause interrupts the running stage at once', async () => {
    const f = fixture()
    f.control.setDurableJobs(new FakeDurableJobsService())
    const pause = (await f.control.call(f.scope, 'tools.list') as Record<string, string>)['jobs.pause']
    expect(pause).toContain('interrupts the running stage at once (there is no safe point to wait for)')
    expect(pause).toContain('records a tool call it cut off as an unknown side effect that is never replayed')
    expect(pause).not.toContain('finishes at a safe point')
  })

  it('agents.steer starts one turn on an idle conversation, exactly as agents.submit does', async () => {
    const f = fixture()
    const child = await f.control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic', effort: 'low' }) as AgentControlTab
    const settings = structuredClone(f.database.structured.snapshot(child.resourceId!)!.settings)
    expect(f.database.structured.snapshot(child.resourceId!)?.phase).toBe('idle')
    const result = await f.control.call(f.scope, 'agents.steer', { agentSessionId: child.resourceId, prompt: 'Start from idle' }) as Record<string, unknown>
    await settle()
    expect(result).toMatchObject({ agentSessionId: child.resourceId, delivery: 'started' })
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0]!.prompt).toContain('Start from idle')
    expect(f.database.structured.snapshot(child.resourceId!)?.settings).toEqual(settings)
    expect(f.control.listLinks(f.project.id, f.workspace.id).filter(link => link.targetAgentSessionId === child.resourceId)).toHaveLength(1)
    expect((await f.control.call(f.scope, 'tools.list') as Record<string, string>)['agents.steer']).toMatch(/running.*queues it behind the turn.*idle.*starts a turn/s)
  })

  it('agents.steer steers into a running turn, or queues behind it, and starts nothing new', async () => {
    const f = fixture()
    const live = (id: string) => (f.sessions as unknown as { live: Map<string, { adapter: ProviderAdapter }> }).live.get(id)!.adapter
    const running = async (): Promise<AgentControlTab> => {
      const child = await f.control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic', effort: 'low' }) as AgentControlTab
      await f.control.call(f.scope, 'agents.submit', { agentSessionId: child.resourceId, prompt: 'First turn' })
      await settle()
      phase(f, child.resourceId!, 'running')
      return child
    }
    // A provider that steers takes the message into the running turn.
    const steering = await running()
    const steered: string[] = []
    live(steering.resourceId!).steer = async text => { steered.push(text) }
    expect(await f.control.call(f.scope, 'agents.steer', { agentSessionId: steering.resourceId, prompt: 'Into the running turn' })).toMatchObject({ delivery: 'queued' })
    await settle()
    expect(steered).toEqual(['Into the running turn'])
    // One that cannot steer holds it behind the turn.
    const queueing = await running()
    live(queueing.resourceId!).capabilities.steering = false
    expect(await f.control.call(f.scope, 'agents.steer', { agentSessionId: queueing.resourceId, prompt: 'Behind the running turn' })).toMatchObject({ delivery: 'queued' })
    await settle()
    expect(f.database.structured.snapshot(queueing.resourceId!)?.queuedPrompts?.map(prompt => prompt.text)).toEqual(['Behind the running turn'])
    expect(f.submissions).toHaveLength(2)
    // A turn that is still stopping is refused, not raced.
    phase(f, queueing.resourceId!, 'interrupting')
    await expect(f.control.call(f.scope, 'agents.steer', { agentSessionId: queueing.resourceId, prompt: 'Too soon' })).rejects.toThrow(/still stopping/)
    expect(f.submissions).toHaveLength(2)
  })

  it('agents.steer starts one new turn after an interrupt, with no duplicate and no authority change', async () => {
    const f = fixture()
    const child = await f.control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic', effort: 'low' }) as AgentControlTab
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: child.resourceId, prompt: 'First turn' })
    await settle()
    phase(f, child.resourceId!, 'interrupted')
    const settings = structuredClone(f.database.structured.snapshot(child.resourceId!)!.settings)
    const links = f.control.listLinks(f.project.id, f.workspace.id)
    const result = await f.control.call(f.scope, 'agents.steer', { agentSessionId: child.resourceId, prompt: 'Resume the bounded work' }) as Record<string, unknown>
    await settle()
    expect(result).toMatchObject({ delivery: 'started' })
    expect(f.submissions.map(submission => submission.prompt.includes('Resume the bounded work'))).toEqual([false, true])
    expect(f.database.structured.snapshot(child.resourceId!)?.queuedPrompts ?? []).toEqual([])
    expect(f.database.structured.snapshot(child.resourceId!)?.settings).toEqual(settings)
    expect(f.control.listLinks(f.project.id, f.workspace.id)).toEqual(links)
  })

  it('reports the latest provider allowance per bucket from usage events, zero-turn, with explicit unknowns, and keeps it over a restart', async () => {
    const f = fixture()
    const now = Date.now(), inFiveHours = Math.floor(now / 1000) + 5 * 3600, inAWeek = Math.floor(now / 1000) + 6 * 86400, anHourAgo = Math.floor(now / 1000) - 3600
    const empty = await f.control.call(f.scope, 'usage.limits') as { providers: Array<{ provider: string; status: string; windows: unknown[]; unknown: string[] }> }
    expect(empty.providers.map(entry => [entry.provider, entry.status])).toEqual([['claude', 'unknown'], ['codex', 'unknown'], ['grok', 'unknown']])
    const claude = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', model: 'claude-synthetic', effort: 'low' }) as AgentControlTab
    const codex = await f.control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic', effort: 'low' }) as AgentControlTab
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: claude.resourceId, prompt: 'One turn' })
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: codex.resourceId, prompt: 'One turn' })
    const emit = (provider: StructuredProvider) => f.submissions.find(submission => submission.provider === provider)!.options.emit
    emit('claude')({ itemId: 'usage:account-rate-limits', data: { type: 'usage', source: 'provider', limits: { rateLimits: { five_hour: { usedPercent: 42, windowDurationMins: 300, resetsAt: inFiveHours }, seven_day: { usedPercent: 61.5, windowDurationMins: 10080, resetsAt: inAWeek }, seven_day_overage_included: { usedPercent: 12, windowDurationMins: 10080, resetsAt: anHourAgo } } } } })
    emit('codex')({ itemId: 'account-rate-limits', data: { type: 'usage', source: 'provider', limits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: inFiveHours } }, rateLimitsByLimitId: { codex: { limitId: 'codex', limitName: null, primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: inFiveHours }, secondary: { usedPercent: 96, windowDurationMins: 10080, resetsAt: inAWeek }, credits: { hasCredits: true, unlimited: false, balance: '12.50' }, planType: 'pro' } } } } })
    // A sparse update changes one window of the bucket and leaves the other as last reported.
    emit('codex')({ itemId: 'account-rate-limits', data: { type: 'usage', source: 'provider', limits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: inFiveHours }, secondary: null, credits: null } } } })
    // Token spend is not an allowance and is never mistaken for one.
    emit('claude')({ itemId: 'usage:turn', data: { type: 'usage', scope: 'turn', source: 'provider', inputTokens: 10, outputTokens: 5, limits: { contextUsedTokens: 15 } } })
    const submitted = f.submissions.length
    const report = await f.control.call(f.scope, 'usage.limits') as { observedNow: string; providers: Array<{ provider: string; status: string; windows: Array<Record<string, unknown>>; credits?: Array<Record<string, unknown>>; unknown: string[] }> }
    expect(f.submissions).toHaveLength(submitted)
    const byProvider = Object.fromEntries(report.providers.map(entry => [entry.provider, entry]))
    expect(byProvider.claude!.status).toBe('reported')
    expect(byProvider.claude!.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'five_hour', usedPercent: 42, windowMinutes: 300, resetsAt: new Date(inFiveHours * 1000).toISOString(), state: 'current', scope: 'provider', source: { agentSessionId: claude.resourceId } }),
      expect.objectContaining({ key: 'seven_day', usedPercent: 61.5, kind: 'weekly', state: 'current' }),
      expect.objectContaining({ key: 'seven_day_overage_included', scope: 'model', models: ['fable'], state: 'reset' })
    ]))
    expect(byProvider.claude!.windows.every(window => typeof window.observedAt === 'string' && typeof window.ageSeconds === 'number')).toBe(true)
    expect(byProvider.codex!.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: 'codex', key: 'codex:primary', usedPercent: 12, state: 'current' }),
      expect.objectContaining({ bucket: 'codex', key: 'codex:secondary', usedPercent: 96, kind: 'weekly' })
    ]))
    expect(byProvider.codex!.credits).toEqual([expect.objectContaining({ bucket: 'codex', hasCredits: true, unlimited: false, balance: '12.50', planType: 'pro' })])
    expect(byProvider.grok).toMatchObject({ status: 'unknown', windows: [] })
    expect(byProvider.grok!.unknown.join(' ')).toMatch(/Grok.*does not report/)
    expect(await f.control.call(f.scope, 'usage.limits', { provider: 'codex' })).toMatchObject({ providers: [expect.objectContaining({ provider: 'codex' })] })
    await expect(f.control.call(f.scope, 'usage.limits', { provider: 'openai' })).rejects.toThrow(/provider/)
    await expect(f.control.call(f.scope, 'usage.limits', { window: 'all' })).rejects.toThrow(/accepts only provider/)
    expect(JSON.stringify(await f.control.call(f.scope, 'tools.list'))).toContain('usage.limits')
    // A local model may read it in any mode; it writes nothing.
    expect(() => assertLocalControlAllowed('usage.limits', { provider: 'claude' }, true)).not.toThrow()
    expect(() => assertLocalControlAllowed('usage.limits', { projectId: 'x' }, true)).toThrow()
    // The record survives a restart: a fresh session manager over the same database reads it.
    const restarted = new StructuredSessions(f.database, () => 'synthetic-provider', vi.fn(), () => { throw new Error('No runtime is started to read limits') })
    dispose.push(() => restarted.dispose())
    const codexAfter = restarted.usageLimits().find(entry => entry.provider === 'codex')!
    expect(codexAfter.windows.map(window => [window.key, window.usedPercent, window.observedAt])).toEqual(byProvider.codex!.windows.map(window => [window.key, window.usedPercent, window.observedAt]))
  })

  it('dispatches a local model read-only without a sandbox mode it does not have, and keeps its writes refused', async () => {
    const f = fixture(false, { local: ['accept-edits', 'read-only'] }, { local: undefined })
    f.deps.providers().push({ id: 'local', displayName: 'Local', available: true, installUrl: '', models: [{ id: 'local-synthetic', label: 'Local synthetic' }], efforts: [] })
    const result = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Read-only inventory', prompt: 'List the fixture files.', provider: 'local', model: 'local-synthetic', permission: 'read-only', exactPermission: true }] }) as Array<{ agentSessionId: string; accepted: boolean; error?: string }>
    expect(result[0]).toMatchObject({ accepted: true })
    expect(result[0]!.error).toBeUndefined()
    const settings = f.database.structured.snapshot(result[0]!.agentSessionId)!.settings
    expect(settings.permission).toBe('read-only')
    expect(settings.sandbox).toBeUndefined()
    expect(f.submissions.at(-1)).toMatchObject({ provider: 'local', settings: expect.objectContaining({ permission: 'read-only' }) })
    // The local runtime's read-only mode is its permission: no write tool and no command runner.
    for (const tool of ['write_file', 'edit_file', 'apply_edits', 'run_command']) expect(() => assertToolAllowed(tool, true)).toThrow(/read-only/)
    expect(toolSpecs(true).map(spec => spec.function.name)).not.toEqual(expect.arrayContaining(['write_file']))
    // A provider that does have a read-only sandbox still gets it.
    const codex = await f.control.call(f.scope, 'tabs.open', { provider: 'codex', model: 'codex-synthetic', permission: 'read-only', exactPermission: true }) as AgentControlTab
    expect(f.database.structured.snapshot(codex.resourceId!)?.settings).toMatchObject({ permission: 'read-only', sandbox: 'read-only' })
  })

  it('closes the tab and drops the task of a dispatch whose prompt was refused before any turn', async () => {
    const f = fixture()
    vi.spyOn(f.sessions, 'submit').mockRejectedValueOnce(new Error('Synthetic refusal before any turn'))
    const result = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Refused worker', prompt: 'Never runs', provider: 'codex', model: 'codex-synthetic' }] }) as Array<Record<string, unknown>>
    expect(result[0]).toMatchObject({ accepted: false, error: 'Synthetic refusal before any turn', tabClosed: true })
    expect(result[0]!.taskId).toBeUndefined()
    expect(f.requests.at(-1)).toMatchObject({ action: 'tabs.close', params: { tabId: result[0]!.tabId } })
    expect(f.orchestration.listTasks(f.project.id).filter(task => task.title === 'Refused worker')).toEqual([])
    expect(f.control.listLinks(f.project.id, f.workspace.id).filter(link => link.targetAgentSessionId === result[0]!.agentSessionId)).toEqual([])
    expect(f.submissions).toHaveLength(0)
    // A worker that did get its prompt keeps its tab and task.
    const kept = await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'Accepted worker', prompt: 'Runs', provider: 'codex', model: 'codex-synthetic' }] }) as Array<Record<string, unknown>>
    expect(kept[0]).toMatchObject({ accepted: true })
    expect(f.orchestration.listTasks(f.project.id).filter(task => task.title === 'Accepted worker')).toHaveLength(1)
  })
})

describe('B1: orphaned live agents and the restart initiator', () => {
  const append = (f: ReturnType<typeof fixture>, id: string, data: AgentEventData): void => {
    const state = f.database.structured.snapshot(id)!, spec = f.database.structured.spec<AgentSpec>(id)!
    f.database.structured.append({ schemaVersion: 1, id: 'b1-event-' + (state.sequence + 1), sequence: state.sequence + 1, sessionId: id, runtimeId: state.runtimeId || 'b1-runtime', provider: spec.provider as StructuredProvider, projectId: spec.projectId, workspaceId: spec.sessionId, cwd: spec.cwd, timestamp: new Date().toISOString(), data })
  }
  const asWizard = (f: ReturnType<typeof fixture>): void => {
    const state = f.database.structured.snapshot(f.spec.id)!
    f.database.structured.update(f.spec.id, { settings: { ...state.settings, wizard: true, model: 'gpt-6-astra' } })
  }

  it('agents.list reports a running agent of this workspace that lost its tab, and agents.resume reopens a tab for it', async () => {
    const f = fixture()
    const orphan: AgentSpec = { id: 'orphan-coworker', projectId: f.project.id, sessionId: f.workspace.id, cwd: f.project.path, provider: 'claude', title: 'Lost coworker', model: 'claude-synthetic' }
    f.sessions.ensure(orphan)
    append(f, orphan.id, { type: 'session', phase: 'running' })
    // A settled conversation without a tab is history, not an orphan.
    const settled: AgentSpec = { ...orphan, id: 'settled-coworker', title: 'Settled' }
    f.sessions.ensure(settled)
    const listed = await f.control.call(f.scope, 'agents.list', {}) as Array<Record<string, unknown>>
    expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ agentSessionId: orphan.id, orphaned: true, phase: 'running', tabId: null, workspaceId: f.workspace.id, title: 'Lost coworker' })]))
    expect(listed.some(entry => entry.agentSessionId === settled.id)).toBe(false)
    const reopened = await f.control.call(f.scope, 'agents.resume', { agentSessionId: orphan.id }) as Record<string, unknown>
    const opened = f.requests.find(request => request.action === 'tabs.open' && (request.params.tab as PaneTab).resourceId === orphan.id)
    expect(opened).toBeTruthy()
    expect(opened!.params.focus).not.toBe(true)
    expect(reopened).toMatchObject({ agentSessionId: orphan.id, reopened: true })
    // Reopening does not restart a turn that is still running.
    expect(f.database.structured.snapshot(orphan.id)!.phase).toBe('running')
    const after = await f.control.call(f.scope, 'agents.list', {}) as Array<Record<string, unknown>>
    const entry = after.find(item => item.agentSessionId === orphan.id)
    expect(entry).toMatchObject({ tabId: (opened!.params.tab as PaneTab).id })
    expect(entry).not.toHaveProperty('orphaned', true)
  })

  it('a wizard restart names its caller as the initiator; the owner credential names none', async () => {
    const f = fixture()
    const ready = () => ({ phase: 'ready' as const, currentVersion: '2.0.0', availableVersion: '2.0.1', configured: true })
    const host = { version: '2.0.0', pid: 77, relaunch: vi.fn(async () => {}), updates: { state: vi.fn(ready), check: vi.fn(async () => ready()), download: vi.fn(async () => ready()), install: vi.fn(async () => {}) } }
    const control = new AgentControl({ ...f.deps, host })
    asWizard(f)
    vi.useFakeTimers()
    await control.call(f.scope, 'app.restart', { force: true })
    await control.call(f.scope, 'app.update.install', { force: false })
    await vi.runAllTimersAsync()
    expect(host.relaunch).toHaveBeenCalledWith(true, { agentSessionId: f.spec.id, method: 'app.restart' })
    expect(host.updates.install).toHaveBeenCalledWith(false, { agentSessionId: f.spec.id, method: 'app.update.install' })
    host.relaunch.mockClear(); host.updates.install.mockClear()
    const owner = control.ownerScope({ projectId: f.project.id })
    await control.call(owner, 'app.restart', { force: false })
    await control.call(owner, 'app.update.install', { force: true })
    await vi.runAllTimersAsync()
    expect(host.relaunch.mock.calls).toEqual([[false]])
    expect(host.updates.install.mock.calls).toEqual([[true]])
    vi.useRealTimers()
  })

  // conductor-task:wizard-answers-quit-dialog
  it('a restart a wizard starts itself never raises the running-work dialog, and a wizard can answer an open one', async () => {
    const f = fixture()
    const ready = () => ({ phase: 'ready' as const, currentVersion: '2.0.0', availableVersion: '2.0.1', configured: true })
    let open: { action: 'quit' | 'restart'; running: Array<{ id: string; title: string }>; openedAt: string } | null = { action: 'quit', running: [{ id: 'agent-x', title: 'Worker' }], openedAt: '2026-09-24T18:00:00.000Z' }
    const stopConfirmation = { pending: vi.fn(() => open), answer: vi.fn((_stopWork: boolean) => { const answered = open; open = null; return answered }) }
    const host = { version: '2.0.0', pid: 77, relaunch: vi.fn(async () => {}), stopConfirmation, updates: { state: vi.fn(ready), check: vi.fn(async () => ready()), download: vi.fn(async () => ready()), install: vi.fn(async () => {}) } }
    const control = new AgentControl({ ...f.deps, host })
    await expect(control.call(f.scope, 'app.quit.confirm', { stopWork: true })).rejects.toThrow(/wizard tab/)
    asWizard(f)
    expect(await control.call(f.scope, 'app.state', {})).toMatchObject({ pendingQuitConfirmation: { action: 'quit', running: [{ id: 'agent-x', title: 'Worker' }] } })
    await expect(control.call(f.scope, 'app.quit.confirm', {})).rejects.toThrow(/needs stopWork/)
    expect(await control.call(f.scope, 'app.quit.confirm', { stopWork: true })).toMatchObject({ answered: true, stopWork: true, action: 'quit' })
    expect(stopConfirmation.answer).toHaveBeenCalledWith(true)
    expect(await control.call(f.scope, 'app.state', {})).toMatchObject({ pendingQuitConfirmation: null })
    await expect(control.call(f.scope, 'app.quit.confirm', { stopWork: false })).rejects.toThrow(/No quit or restart confirmation is open/)
    vi.useFakeTimers()
    expect(await control.call(f.scope, 'app.restart', {})).toMatchObject({ force: true })
    expect(await control.call(f.scope, 'app.update.install', {})).toMatchObject({ force: true })
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    expect(host.relaunch).toHaveBeenCalledWith(true, { agentSessionId: f.spec.id, method: 'app.restart' })
    expect(host.updates.install).toHaveBeenCalledWith(true, { agentSessionId: f.spec.id, method: 'app.update.install' })
    expect(f.confirm).not.toHaveBeenCalled()
  })

  // conductor-task:wizard-restart-request
  it('a wizard can ask the owner to restart; the request names it, and nobody else may file one', async () => {
    const f = fixture()
    let stored: { agentSessionId: string; title: string; reason: string; at: string } | null = null
    const host = { version: '2.0.0', pid: 77, relaunch: vi.fn(async () => {}),
      requestRestart: vi.fn((request: { agentSessionId: string; title: string; reason: string }) => (stored = { ...request, at: '2026-09-24T18:00:00.000Z' })),
      restartRequest: vi.fn(() => stored) }
    const control = new AgentControl({ ...f.deps, host })
    await expect(control.call(f.scope, 'app.restart.request', { reason: 'Install the new build' })).rejects.toThrow(/wizard tab/)
    await expect(control.call(control.ownerScope({ projectId: f.project.id }), 'app.restart.request', { reason: 'x' })).rejects.toThrow(/is for a wizard tab/)
    asWizard(f)
    expect(Object.keys(await control.call(f.scope, 'tools.list', {}) as object)).toEqual(expect.arrayContaining(['app.restart.request', 'app.quit.confirm']))
    await expect(control.call(f.scope, 'app.restart.request', {})).rejects.toThrow(/Invalid reason/)
    await expect(control.call(f.scope, 'app.restart.request', { reason: 'x', force: true })).rejects.toThrow(/accepts only reason/)
    expect(await control.call(f.scope, 'app.restart.request', { reason: 'Install the new build' })).toMatchObject({ requested: true, agentSessionId: f.spec.id, reason: 'Install the new build' })
    expect(host.requestRestart).toHaveBeenCalledWith({ agentSessionId: f.spec.id, title: expect.any(String), reason: 'Install the new build' })
    expect(await control.call(f.scope, 'app.state', {})).toMatchObject({ restartRequest: { agentSessionId: f.spec.id, reason: 'Install the new build' } })
    // Asking is not restarting.
    expect(host.relaunch).not.toHaveBeenCalled()
  })
})

describe('supervision and bounded recovery through app control', () => {
  it('reports the observed turn start and an unchanged cursor, bounds recovery of a failed coworker and records a superseded one', async () => {
    const f = fixture()
    const tab = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', model: 'claude-synthetic' }) as AgentControlTab
    const id = tab.resourceId!, phase = () => f.database.structured.snapshot(id)!.phase
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: id, prompt: 'Do the work' })
    await vi.waitFor(() => expect(phase()).toBe('completed'))
    const status = await f.control.call(f.scope, 'agents.status', { agentSessionId: id }) as Record<string, any>
    expect(status.turnStart).toMatchObject({ state: 'started', evidence: 'assistant text', from: 'Controller' })
    expect(status).toMatchObject({ pending: [], activeTool: null, recovery: { attempts: 0, remaining: 3, superseded: null } })
    expect(status.usage.reviewer).toBeNull()
    expect(JSON.stringify(status).length).toBeLessThan(2500)
    expect(await f.control.call(f.scope, 'agents.status', { agentSessionId: id, since: status.cursor })).toEqual({ agentSessionId: id, unchanged: true, cursor: status.cursor, phase: 'completed', observedAt: expect.any(String) })
    // A routine reconnect of a settled conversation is not a recovery.
    expect(await f.control.call(f.scope, 'agents.resume', { agentSessionId: id })).toMatchObject({ recovery: { attempts: 0 } })
    const fail = async () => { f.submissions.at(-1)!.options.emit({ data: { type: 'session', phase: 'failed' } }); await vi.waitFor(() => expect(phase()).toBe('failed')) }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await f.control.call(f.scope, 'agents.submit', { agentSessionId: id, prompt: 'Try again' })
      await vi.waitFor(() => expect(phase()).toBe('completed'))
      await fail()
      expect(await f.control.call(f.scope, 'agents.resume', { agentSessionId: id })).toMatchObject({ recovery: { attempts: attempt, remaining: 3 - attempt } })
    }
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: id, prompt: 'Once more' })
    await vi.waitFor(() => expect(phase()).toBe('completed'))
    await fail()
    await expect(f.control.call(f.scope, 'agents.resume', { agentSessionId: id })).rejects.toThrow(/tell the owner/)
    const replacement = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', model: 'claude-synthetic' }) as AgentControlTab
    await expect(f.control.call(f.scope, 'agents.supersede', { agentSessionId: id, by: 'someone-else', reason: 'Redone' })).rejects.toThrow(/took this work over/)
    expect(await f.control.call(f.scope, 'agents.supersede', { agentSessionId: id, by: replacement.resourceId, reason: 'Replacement passed the acceptance test' })).toMatchObject({ agentSessionId: id, superseded: { by: replacement.resourceId } })
    const listed = await f.control.call(f.scope, 'agents.list', {}) as Array<Record<string, any>>
    expect(listed.find(entry => entry.agentSessionId === id)?.superseded).toMatchObject({ by: replacement.resourceId })
    expect(listed.find(entry => entry.agentSessionId === replacement.resourceId)).not.toHaveProperty('superseded')
    await expect(f.control.call(f.scope, 'agents.resume', { agentSessionId: id })).rejects.toThrow(/superseded by/)
    expect(JSON.stringify(await f.control.call(f.scope, 'tools.list', {}))).toContain('agents.supersede')
  })
})

describe('viewing through app control', () => {
  it('reports a settled turn whose background tasks still run as phase viewing with the count, never completed', async () => {
    const f = fixture()
    const tab = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', model: 'claude-synthetic' }) as AgentControlTab
    const id = tab.resourceId!
    await f.control.call(f.scope, 'agents.submit', { agentSessionId: id, prompt: 'Run the smoke in the background and wait for it' })
    await vi.waitFor(() => expect(f.database.structured.snapshot(id)!.phase).toBe('completed'))
    const before = await f.control.call(f.scope, 'agents.status', { agentSessionId: id }) as Record<string, any>
    expect(before).toMatchObject({ phase: 'completed', backgroundTasks: 0 })
    f.submissions.at(-1)!.options.emit({ data: { type: 'session', phase: 'completed', backgroundTasks: 1 } })
    await vi.waitFor(() => expect(f.database.structured.snapshot(id)!.backgroundTasks).toBe(1))
    const listed = (await f.control.call(f.scope, 'agents.list', {}) as Array<Record<string, any>>).find(entry => entry.agentSessionId === id)
    expect(listed).toMatchObject({ phase: 'viewing', backgroundTasks: 1 })
    const status = await f.control.call(f.scope, 'agents.status', { agentSessionId: id }) as Record<string, any>
    expect(status).toMatchObject({ phase: 'viewing', backgroundTasks: 1 })
    // The watcher reporting back is a meaningful change for a supervising controller.
    expect(status.cursor).not.toBe(before.cursor)
    f.submissions.at(-1)!.options.emit({ data: { type: 'session', phase: 'completed', backgroundTasks: 0 } })
    await vi.waitFor(() => expect(f.database.structured.snapshot(id)!.backgroundTasks ?? 0).toBe(0))
    expect(await f.control.call(f.scope, 'agents.status', { agentSessionId: id })).toMatchObject({ phase: 'completed', backgroundTasks: 0 })
  })
})

describe('agents.finish', () => {
  const settle = (f: ReturnType<typeof fixture>, id: string, phase: SessionProjection['phase'], extra: Record<string, unknown> = {}) =>
    f.database.structured.append({ schemaVersion: 1, id: 'finish-' + phase + '-' + Math.random(), sequence: f.database.structured.snapshot(id)!.sequence + 1, sessionId: id, runtimeId: 'finish-runtime', provider: 'codex', projectId: f.project.id, workspaceId: f.workspace.id, cwd: f.project.path, timestamp: new Date().toISOString(), data: { type: 'session', phase, ...extra } as AgentEventData })
  const closer = (f: ReturnType<typeof fixture>) => {
    const released: string[] = []
    f.control.setCoworkerAutoClose(new CoworkerAutoClose({
      settings: f.database, snapshot: id => f.database.structured.snapshot(id),
      targets: () => f.control.finishTargets(), close: target => f.control.closeFinished(target),
      release: select => f.sessions.killWhere(spec => { const chosen = select(spec); if (chosen) released.push(spec.id); return chosen })
    }))
    return released
  }
  const closes = (f: ReturnType<typeof fixture>) => f.requests.filter(request => request.action === 'tabs.close')

  it('marks the tabs a controller opens as coworkers, and not the owner’s', async () => {
    const f = fixture()
    const child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    expect(f.database.getSetting(COWORKER_OPENED_PREFIX + child.resourceId)).toBe('controller')
    const owned = await f.control.call(f.control.ownerScope({ projectId: f.project.id, workspaceId: f.workspace.id }), 'tabs.open', { provider: 'codex' }) as AgentControlTab
    expect(owned.resourceId).toBeTruthy()
    expect(f.database.getSetting(COWORKER_OPENED_PREFIX + owned.resourceId)).toBeNull()
  })

  it('is refused while the coworker runs or has background tasks, naming why, with no dialog', async () => {
    const f = fixture(); closer(f)
    const child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    settle(f, child.resourceId!, 'running')
    await expect(f.control.call(f.scope, 'agents.finish', { agentSessionId: child.resourceId })).rejects.toThrow(/its turn is still running/)
    settle(f, child.resourceId!, 'completed', { backgroundTasks: 1 })
    await expect(f.control.call(f.scope, 'agents.finish', { agentSessionId: child.resourceId })).rejects.toThrow(/1 background task still running/)
    expect(closes(f)).toHaveLength(0)
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it('lets the controller close a settled coworker at once, keeping history and releasing its runtime', async () => {
    const f = fixture(), released = closer(f)
    const child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    settle(f, child.resourceId!, 'completed')
    const result = await f.control.call(f.scope, 'agents.finish', { agentSessionId: child.resourceId }) as { finished: boolean; note: string }
    expect(result).toMatchObject({ finished: true, agentSessionId: child.resourceId, tabId: child.id })
    expect(closes(f).at(-1)).toMatchObject({ params: { tabId: child.id, unlessDraft: true } })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(released).toEqual([child.resourceId])
    expect(f.database.getSetting('agentControlParent:' + child.resourceId)).toBeNull()
    expect(f.database.getSetting(COWORKER_OPENED_PREFIX + child.resourceId)).toBeNull()
    expect(f.database.structured.snapshot(child.resourceId!)).toBeTruthy()
  })

  it('refuses a tab the caller does not control and takes only agentSessionId', async () => {
    const f = fixture(); closer(f)
    f.sessions.ensure({ ...f.spec, id: 'owners-own', title: 'Owner tab' })
    openAgentTab(f, 'owners-own', 'owners-own-tab')
    await expect(f.control.call(f.scope, 'agents.finish', { agentSessionId: 'owners-own' })).rejects.toThrow(/Finish only a coworker this agent controls/)
    await expect(f.control.call(f.scope, 'agents.finish', { agentSessionId: 'owners-own', force: true })).rejects.toThrow(/accepts only agentSessionId/)
    expect(closes(f)).toHaveLength(0)
  })

  it('lets a coworker finish itself once its own turn settles', async () => {
    const f = fixture(), released = closer(f)
    const child = await f.control.call(f.scope, 'tabs.open', {}) as AgentControlTab
    const self = { ...f.scope, agentSessionId: child.resourceId! }
    settle(f, child.resourceId!, 'running')
    expect(await f.control.call(self, 'agents.finish', {})).toMatchObject({ finished: false })
    await new Promise(resolve => setTimeout(resolve, 2_300))
    expect(closes(f)).toHaveLength(0)
    settle(f, child.resourceId!, 'completed')
    await vi.waitFor(() => expect(closes(f)).toHaveLength(1), { timeout: 5_000 })
    expect(released).toEqual([child.resourceId])
  })

  it('refuses a self-finish from the owner’s own tab', async () => {
    const f = fixture(); closer(f)
    await expect(f.control.call(f.scope, 'agents.finish', {})).rejects.toThrow(/owner’s own tab/)
  })
})

describe('FX21: agent-opened tabs never steal the owner’s focus', () => {
  const opens = (f: ReturnType<typeof fixture>) => f.requests.filter(request => request.action === 'tabs.open')
  const focuses = (f: ReturnType<typeof fixture>) => f.requests.filter(request => request.action === 'tabs.focus')
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  const append = (f: ReturnType<typeof fixture>, id: string, data: AgentEventData): void => {
    const state = f.database.structured.snapshot(id)!, spec = f.database.structured.spec<AgentSpec>(id)!
    f.database.structured.append({ schemaVersion: 1, id: 'fx21-event-' + (state.sequence + 1), sequence: state.sequence + 1, sessionId: id, runtimeId: state.runtimeId || 'fx21-runtime', provider: spec.provider as StructuredProvider, projectId: spec.projectId, workspaceId: spec.sessionId, cwd: spec.cwd, timestamp: new Date().toISOString(), data })
  }

  it('tabs.open lands in the background unless the agent asks for focus, which then waits for a typing pause', async () => {
    const f = fixture()
    await f.control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Quiet worker' })
    await f.control.call(f.scope, 'tabs.open', { kind: 'terminal', title: 'Quiet shell' })
    expect(opens(f).map(request => request.params.focus)).toEqual([false, false])
    expect(focuses(f)).toHaveLength(0)
    const wanted = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Look here', focus: true }) as { id: string }
    await flush()
    expect(opens(f).at(-1)?.params.focus).toBe(false)
    expect(focuses(f)).toEqual([expect.objectContaining({ params: { tabId: wanted.id, whenIdle: true } })])
  })

  it('router.dispatch opens every coworker in the background', async () => {
    const f = fixture()
    await f.control.call(f.scope, 'router.dispatch', { tasks: [{ title: 'One', prompt: 'First task', provider: 'claude' }, { title: 'Two', prompt: 'Second task', provider: 'claude' }] })
    expect(opens(f)).toHaveLength(2)
    expect(opens(f).every(request => request.params.focus === false)).toBe(true)
    expect(focuses(f)).toHaveLength(0)
  })

  it('agents.handoff opens the receiver in the background', async () => {
    const f = fixture()
    await f.control.call(f.scope, 'agents.handoff', { handoff: handoff() })
    expect(opens(f)).toHaveLength(1)
    expect(opens(f)[0]!.params.focus).toBe(false)
    expect(focuses(f)).toHaveLength(0)
  })

  it('agents.resume reopens a tabless conversation in the background', async () => {
    const f = fixture()
    const orphan: AgentSpec = { id: 'fx21-orphan', projectId: f.project.id, sessionId: f.workspace.id, cwd: f.project.path, provider: 'claude', title: 'Lost coworker', model: 'claude-synthetic' }
    f.sessions.ensure(orphan)
    append(f, orphan.id, { type: 'session', phase: 'running' })
    await f.control.call(f.scope, 'agents.resume', { agentSessionId: orphan.id })
    expect(opens(f).at(-1)?.params.focus).toBe(false)
  })

  it('an agent’s tabs.focus waits for the owner to pause typing and answers deferred while it waits', async () => {
    const f = fixture()
    const opened = await f.control.call(f.scope, 'tabs.open', { provider: 'claude', title: 'Worker' }) as { id: string }
    expect(await f.control.call(f.scope, 'tabs.focus', { tabId: opened.id })).toEqual({ applied: true })
    expect(focuses(f).at(-1)?.params).toMatchObject({ tabId: opened.id, whenIdle: true })
    vi.useFakeTimers()
    try {
      let release!: (value: unknown) => void
      f.ui.mockImplementationOnce(async request => { f.requests.push(request); return new Promise(resolve => { release = value => resolve(value as never) }) })
      const answer = f.control.call(f.scope, 'tabs.focus', { tabId: opened.id })
      await vi.advanceTimersByTimeAsync(3000)
      await expect(answer).resolves.toEqual({ tabId: opened.id, closed: false, deferred: true })
      release({ applied: true })
    } finally { vi.useRealTimers() }
  })

  it('the owner’s own credential keeps opening and focusing tabs in front', async () => {
    const f = fixture()
    const owner = f.control.ownerScope({ projectId: f.project.id })
    await f.control.call(owner, 'tabs.open', { provider: 'claude', title: 'Owner tab' })
    expect(opens(f).at(-1)?.params).not.toHaveProperty('focus')
    await f.control.call(owner, 'tabs.open', { provider: 'claude', title: 'Owner background', focus: false })
    expect(opens(f).at(-1)?.params.focus).toBe(false)
    const tab = f.control.tabs(owner).at(-1)!
    await f.control.call(owner, 'tabs.focus', { tabId: tab.id })
    expect(focuses(f).at(-1)?.params).not.toHaveProperty('whenIdle')
  })
})
