import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProviderInfo, AgentSpec, PaneTab } from '../shared/models'
import type { ScheduleRun } from '../shared/schedules'
import type { ProviderCapabilities, StructuredProvider } from '../shared/structured-agent'
import { AgentCollaborationStore } from './agent-collaboration-store'
import { AgentControl } from './agent-control'
import { ConductorDatabase } from './database'
import { OrchestrationStore } from './orchestration-store'
import { ProjectBacklogs } from './project-backlog'
import type { ProviderAdapter } from './providers/adapter'
import { scheduleCall, type ScheduleControlCaller, type ScheduleControlContext } from './schedule-control'
import { ScheduleStore } from './schedule-store'
import { StructuredSessions } from './structured-sessions'

const dispose: Array<() => void> = []
afterEach(() => { vi.unstubAllEnvs(); for (const item of dispose.splice(0).reverse()) item() })

const catalog = [
  { provider: 'claude', available: true, models: [{ id: 'opus' }, { id: 'sonnet' }] },
  { provider: 'codex', available: true, models: [{ id: 'gpt-6-astra' }] },
  { provider: 'local', available: true, models: [{ id: 'local/qwen' }] }
]

const unit = () => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-schedule-control-')), path = join(root, 'state.db')
  const database = new ConductorDatabase(path), project = database.upsertProject(root, 'Control'), store = new ScheduleStore(path)
  dispose.push(() => { store.close(); database.close(); rmSync(root, { recursive: true, force: true }) })
  const runNow = vi.fn((projectId: string, scheduleId: string): ScheduleRun => store.begin(store.get(projectId, scheduleId), new Date(), 'manual'))
  const ask = vi.fn(async () => undefined), changed = vi.fn(), reauthorize = vi.fn()
  const context: ScheduleControlContext = { store, runner: { runNow, running: () => null, forget: vi.fn() }, changed, ask, reauthorize, catalog: () => catalog }
  const caller = (patch: Partial<ScheduleControlCaller> = {}): ScheduleControlCaller => ({ projectId: project.id, agentSessionId: 'agent-creator', title: 'Creator', provider: 'claude', sovereign: false, owner: false, wizard: false, restricted: false, model: 'opus', effort: 'high', ...patch })
  const call = (who: ScheduleControlCaller, method: string, args: Record<string, unknown> = {}) => scheduleCall(context, who, method, args)
  return { store, project, context, caller, call, ask, changed, runNow, reauthorize }
}

describe('schedules.* control methods', () => {
  it('lets an agent create a task for the owner, assigned to itself by default, and write its scripts', async () => {
    const f = unit()
    const created = await f.call(f.caller(), 'schedules.create', { name: 'Nightly dependency audit', prompt: 'Tell me about new advisories for our dependencies.', timing: 'night' }) as { task: { id: string; agent: unknown; createdBy: unknown; nextDueAt: string }; note: string }
    expect(created.task).toMatchObject({ agent: { provider: 'claude', model: 'opus', effort: 'high' }, createdBy: { kind: 'agent', agentSessionId: 'agent-creator', title: 'Creator' } })
    expect(created.note).toContain('schedules.scripts.save')
    const saved = await f.call(f.caller(), 'schedules.scripts.save', { taskId: created.task.id, name: 'npm-audit', content: 'console.log("[]")', format: 'json', description: 'npm audit summary' }) as { script: Record<string, unknown> }
    expect(saved.script).toMatchObject({ name: 'npm-audit', origin: 'agent', author: { agentSessionId: 'agent-creator' } })
    expect(saved.script).not.toHaveProperty('content')
    const got = await f.call(f.caller({ agentSessionId: 'someone-else' }), 'schedules.get', { taskId: created.task.id }) as { scripts: Array<{ content: string }> }
    expect(got.scripts[0]!.content).toBe('console.log("[]")')
    const listed = await f.call(f.caller({ agentSessionId: 'reader', provider: 'local' }), 'schedules.list') as Array<{ scripts: Array<{ name: string }> }>
    expect(listed[0]!.scripts.map(script => script.name)).toEqual(['npm-audit'])
    expect(f.changed).toHaveBeenCalledWith(f.project.id)
  })

  it('validates the assigned agent, churn model and arguments against what this Conductor offers', async () => {
    const f = unit()
    await expect(f.call(f.caller(), 'schedules.create', { name: 'x', agent: { provider: 'claude', model: 'gpt-6-astra' } })).rejects.toThrow('not a claude model')
    await expect(f.call(f.caller(), 'schedules.create', { name: 'x', agent: { provider: 'gemini', model: 'x' } })).rejects.toThrow('agent.provider')
    await expect(f.call(f.caller(), 'schedules.create', { name: 'x', churnModel: 'opus' })).rejects.toThrow('churnModel')
    await expect(f.call(f.caller(), 'schedules.create', { name: 'x', command: 'rm -rf' })).rejects.toThrow('command is not an argument')
    await expect(f.call(f.caller(), 'schedules.get', {})).rejects.toThrow('taskId is required')
    const local = await f.call(f.caller(), 'schedules.create', { name: 'Local only', agent: { provider: 'local', model: 'local/qwen' }, churnModel: 'local/qwen' }) as { task: { agent: unknown } }
    expect(local.task.agent).toEqual({ provider: 'local', model: 'local/qwen' })
  })

  it('keeps changes to the maintainer, the owner and wizard tabs, and pausing or running to writable coworkers', async () => {
    const f = unit()
    const { task } = await f.call(f.caller(), 'schedules.create', { name: 'Watch' }) as { task: { id: string } }
    const peer = f.caller({ agentSessionId: 'peer', title: 'Peer' })
    await expect(f.call(peer, 'schedules.update', { taskId: task.id, prompt: 'changed' })).rejects.toThrow('maintainer')
    await expect(f.call(peer, 'schedules.scripts.save', { taskId: task.id, name: 'x', content: 'x' })).rejects.toThrow('maintainer')
    await expect(f.call(f.caller({ provider: 'local' }), 'schedules.update', { taskId: task.id, prompt: 'x' })).rejects.toThrow('sandboxed local conversation')
    await expect(f.call(f.caller({ restricted: true }), 'schedules.pause', { taskId: task.id })).rejects.toThrow('read-only')
    expect(await f.call(peer, 'schedules.pause', { taskId: task.id })).toMatchObject({ enabled: false, nextDueAt: null })
    expect(await f.call(peer, 'schedules.resume', { taskId: task.id })).toMatchObject({ enabled: true })
    expect(await f.call(peer, 'schedules.runNow', { taskId: task.id })).toMatchObject({ run: { trigger: 'manual' } })
    // The owner assigned the scripts to the peer: now it maintains the task too.
    f.store.setDelegate(f.project.id, task.id, 'peer')
    expect(await f.call(peer, 'schedules.update', { taskId: task.id, prompt: 'Watch the releases page', everyMinutes: 360 })).toMatchObject({ prompt: 'Watch the releases page', everyMinutes: 360 })
    const wizard = f.caller({ agentSessionId: 'wizard-tab', sovereign: true, wizard: true })
    expect(await f.call(wizard, 'schedules.update', { taskId: task.id, urgent: true })).toMatchObject({ urgent: true })
  })

  it('asks the owner before a maintainer deletes a task, not when the owner or a wizard tab asks, and never deletes a built-in', async () => {
    const f = unit()
    const { task } = await f.call(f.caller(), 'schedules.create', { name: 'Temporary' }) as { task: { id: string } }
    f.ask.mockRejectedValueOnce(new Error('The owner declined to delete this scheduled task'))
    await expect(f.call(f.caller(), 'schedules.delete', { taskId: task.id })).rejects.toThrow('declined')
    expect(f.store.list(f.project.id)).toHaveLength(1)
    expect(await f.call(f.caller(), 'schedules.delete', { taskId: task.id })).toEqual({ deleted: true, taskId: task.id })
    expect(f.ask).toHaveBeenCalledWith(expect.stringContaining('delete the scheduled task “Temporary”'), 'delete this scheduled task')
    expect(f.reauthorize).toHaveBeenCalled()
    const owned = await f.call(f.caller({ owner: true, sovereign: true, agentSessionId: 'owner' }), 'schedules.create', { name: 'Owner task' }) as { task: { id: string; agent: unknown; createdBy: unknown } }
    expect(owned.task).toMatchObject({ agent: null, createdBy: { kind: 'owner' } })
    f.ask.mockClear()
    await f.call(f.caller({ owner: true, sovereign: true, agentSessionId: 'owner' }), 'schedules.delete', { taskId: owned.task.id })
    expect(f.ask).not.toHaveBeenCalled()
    const builtin = f.store.create({ projectId: f.project.id, name: 'Built-in', kind: 'latest-models-methods', createdBy: { kind: 'conductor' } })
    await expect(f.call(f.caller({ owner: true, sovereign: true }), 'schedules.delete', { taskId: builtin.id })).rejects.toThrow('pause it instead')
    await expect(f.call(f.caller(), 'schedules.update', { taskId: builtin.id, prompt: 'x' })).rejects.toThrow('built-in task is changed by the owner')
  })
})

describe('schedules.* through AgentControl', () => {
  const integration = () => {
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
    const root = mkdtempSync(join(tmpdir(), 'conductor-schedule-agent-control-')), projectPath = join(root, 'project')
    mkdirSync(projectPath)
    dispose.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    const path = join(root, 'conductor.db'), database = new ConductorDatabase(path)
    dispose.push(() => database.close())
    const project = database.upsertProject(projectPath, 'Project'), workspace = database.listSessions(project.id)[0]!
    const orchestration = new OrchestrationStore(path), collaboration = new AgentCollaborationStore(path), store = new ScheduleStore(path)
    dispose.push(() => orchestration.close(), () => collaboration.close(), () => store.close())
    const sessions = new StructuredSessions(database, () => 'synthetic-provider', vi.fn(), (provider, options): ProviderAdapter => {
      const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: ['default', 'read-only', 'accept-edits'], effort: ['low', 'high'], models: [{ id: provider + '-synthetic', label: provider + ' Synthetic' }], limitations: [] }
      return { provider, capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle' } }) }, submit: async () => {}, respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
    })
    dispose.push(() => sessions.dispose())
    const tabs: PaneTab[] = []
    const open = (spec: AgentSpec): void => { sessions.ensure(spec); tabs.push({ id: `${spec.id}-tab`, kind: 'agent', resourceId: spec.id, title: spec.title, state: { provider: spec.provider, model: spec.model } }); database.saveSession(workspace.id, { version: 1, root: { type: 'group', id: 'group', activeTabId: tabs[0]!.id, tabs } }, null, []) }
    const controller: AgentSpec = { id: 'controller', projectId: project.id, sessionId: workspace.id, cwd: project.path, provider: 'codex', title: 'Controller', model: 'codex-synthetic' }
    const local: AgentSpec = { ...controller, id: 'local-worker', provider: 'local', title: 'Local worker', model: 'local/qwen' }
    open(controller); open(local)
    const providers: AgentProviderInfo[] = (['codex', 'claude'] as StructuredProvider[]).map(id => ({ id, displayName: id, available: true, installUrl: '', models: [{ id: id + '-synthetic', label: id + ' Synthetic' }], efforts: [{ id: 'low', label: 'Low' }] }))
    const confirm = vi.fn(async () => true as const)
    const control = new AgentControl({ database, sessions, orchestration, collaboration, backlogs: new ProjectBacklogs(database), ui: vi.fn(async () => ({})), confirm, fileChanged: vi.fn(), providers: () => providers })
    const runner = { runNow: vi.fn((projectId: string, id: string) => store.begin(store.get(projectId, id), new Date(), 'manual')), running: () => null, forget: vi.fn() }
    const scope = { projectId: project.id, sessionId: workspace.id, agentSessionId: controller.id }
    return { control, store, runner, confirm, scope, localScope: { ...scope, agentSessionId: local.id }, project }
  }

  it('lists schedules.* only once the scheduler is plugged in, and routes calls with the caller\'s real authority', async () => {
    const f = integration()
    expect(Object.keys(await f.control.call(f.scope, 'tools.list') as object)).not.toContain('schedules.create')
    await expect(f.control.call(f.scope, 'schedules.list')).rejects.toThrow('Scheduled tasks are unavailable')
    f.control.setSchedules({ store: f.store, runner: f.runner, changed: vi.fn() })
    const tools = await f.control.call(f.scope, 'tools.list') as Record<string, string>
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['schedules.list', 'schedules.get', 'schedules.create', 'schedules.update', 'schedules.pause', 'schedules.resume', 'schedules.runNow', 'schedules.delete', 'schedules.scripts.save', 'schedules.scripts.delete']))
    expect(tools['schedules.scripts.save']).toContain('CONDUCTOR_SCHEDULE_RUN_DIR')
    const created = await f.control.call(f.scope, 'schedules.create', { name: 'Codex release notes', prompt: 'Summarize new Codex releases.' }) as { task: { id: string; agent: unknown; createdBy: unknown } }
    expect(created.task).toMatchObject({ agent: { provider: 'codex', model: 'codex-synthetic' }, createdBy: { kind: 'agent', agentSessionId: 'controller', title: 'Controller' } })
    // The sandboxed local model reads, but writes nothing that would run on the host.
    expect(await f.control.call(f.localScope, 'schedules.list')).toHaveLength(1)
    await expect(f.control.call(f.localScope, 'schedules.create', { name: 'x' })).rejects.toThrow('sandboxed local conversation')
    await expect(f.control.call(f.scope, 'schedules.list', { projectId: 'another-project' })).rejects.toThrow('only runs in the authorized project')
    // Deleting asks the owner through the ordinary confirmation path.
    await f.control.call(f.scope, 'schedules.delete', { taskId: created.task.id })
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: 'controller' }), expect.stringContaining('Codex release notes'))
    expect(f.store.list(f.project.id)).toEqual([])
  })
})
