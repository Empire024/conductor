import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../agent-control'
import { ConductorDatabase } from '../database'
import { StructuredSessions } from '../structured-sessions'
import { OrchestrationStore } from '../orchestration-store'
import { AgentCollaborationStore } from '../agent-collaboration-store'
import { ProjectBacklogs } from '../project-backlog'
import type { AgentControlScope, AgentControlTab, AgentControlUiRequest } from '../../shared/agent-control'
import type { AgentProviderInfo, AgentSpec, PaneTab } from '../../shared/models'
import type { ProviderCapabilities, SessionSettings, StructuredProvider } from '../../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from '../providers/adapter'
import { anonymousConversations } from './anonymous'
import { LOCAL_SWARM_LIMITS } from './swarm'
import { assertLocalControlAllowed, LOCAL_CONTROL_METHODS, toolSpecs } from './tools'

/** local-model-swarms through the real AgentControl: what a local tab may open, steer and read. */
const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs(); anonymousConversations.clearForTests() })

function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-swarm-')), projectPath = join(root, 'project')
  mkdirSync(projectPath)
  dispose.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(root, 'conductor.db'), database = new ConductorDatabase(path)
  dispose.push(() => database.close())
  const project = database.upsertProject(projectPath, 'Swarm project'), workspace = database.listSessions(project.id)[0]!
  const orchestration = new OrchestrationStore(path), collaboration = new AgentCollaborationStore(path)
  dispose.push(() => orchestration.close(), () => collaboration.close())
  const submissions: Array<{ id: string; provider: StructuredProvider; prompt: string; settings: SessionSettings }> = []
  const sessions = new StructuredSessions(database, () => 'synthetic-provider', vi.fn(), (provider, options: AdapterOptions): ProviderAdapter => {
    const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: false, toolInputStreaming: false, toolOutputStreaming: false, approvals: false, questions: false, resume: false, fork: false, plans: false, permissions: provider === 'local' ? ['read-only', 'accept-edits'] : ['default', 'read-only', 'accept-edits'], effort: [], models: [{ id: provider + '-synthetic', label: provider + ' Synthetic' }], limitations: [] }
    return { provider, capabilities, start: async () => { options.emit({ data: { type: 'session', phase: 'idle' } }) },
      submit: async (prompt, settings) => { submissions.push({ id: options.localTaskId ?? '', provider, prompt, settings: structuredClone(settings) }); options.emit({ itemId: 'result', data: { type: 'text', role: 'assistant', text: 'done', mode: 'snapshot' } }); options.emit({ data: { type: 'session', phase: 'completed' } }) },
      respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  })
  dispose.push(() => sessions.dispose())
  const scope = { projectId: project.id, sessionId: workspace.id, agentSessionId: 'controller' }
  const spec: AgentSpec = { id: 'controller', projectId: project.id, sessionId: workspace.id, cwd: project.path, provider: 'codex', title: 'Controller', model: 'codex-synthetic' }
  sessions.ensure(spec)
  const rootTab: PaneTab = { id: 'controller-tab', kind: 'agent', resourceId: spec.id, title: spec.title, state: { provider: spec.provider, model: spec.model } }
  database.saveSession(workspace.id, { version: 1, root: { type: 'group', id: 'group', activeTabId: rootTab.id, tabs: [rootTab] } }, null, [])
  const ui = vi.fn(async (request: AgentControlUiRequest) => {
    if (request.action === 'tabs.open') {
      const current = database.getSession(request.sessionId)!, tab = request.params.tab as PaneTab
      if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
      current.layout.root.tabs.push(tab)
      database.saveSession(request.sessionId, current.layout, null, [])
      return { tabId: tab.id }
    }
    return { applied: true }
  })
  const providers: AgentProviderInfo[] = (['codex', 'local'] as const).map(id => ({ id, displayName: id, available: true, installUrl: '', models: [{ id: id + '-synthetic', label: id + ' Synthetic' }], efforts: [] }))
  const control = new AgentControl({ database, sessions, orchestration, collaboration, backlogs: new ProjectBacklogs(database), ui, confirm: vi.fn(async () => false), fileChanged: vi.fn(), providers: () => providers } as unknown as ConstructorParameters<typeof AgentControl>[0])
  /** A local tab the owner opened by hand, on accept-edits with the given grants. */
  const ownersLocalTab = (id: string, settings: Partial<SessionSettings> = {}, anonymous = false): AgentControlScope => {
    sessions.ensure({ ...spec, id, provider: 'local', title: id, model: 'local-synthetic', ...(anonymous ? { anonymous: true } : {}) })
    database.structured.update(id, { settings: { ...database.structured.snapshot(id)!.settings, permission: 'accept-edits', ...settings } })
    const current = database.getSession(workspace.id)!
    if (current.layout.root.type !== 'group') throw new Error('Synthetic layout changed')
    current.layout.root.tabs.push({ id: id + '-tab', kind: 'agent', resourceId: id, title: id, state: { provider: 'local', model: 'local-synthetic', ...(anonymous ? { anonymous: true } : {}) } })
    database.saveSession(workspace.id, current.layout, null, [])
    return { ...scope, agentSessionId: id }
  }
  return { database, sessions, control, scope, submissions, ownersLocalTab }
}

describe('local swarms through app control', () => {
  it('opens a coworker of the same model with the same or narrower grants and starts it on the prompt', async () => {
    const f = fixture()
    const local = f.ownersLocalTab('local-lead', { localGit: true, localResearch: false })
    const opened = await f.control.call(local, 'tabs.open', { title: 'Tests for add', prompt: 'Write tests for add()', repository: false }) as AgentControlTab & { grants: { repository: boolean; research: boolean }; delivery: string; swarm: { coworkers: number; maxCoworkers: number; maxDepth: number } }
    const id = opened.resourceId!
    expect(opened.state).toMatchObject({ provider: 'local', model: 'local-synthetic' })
    expect(opened.grants).toEqual({ repository: false, research: false })
    expect(opened.swarm).toEqual({ coworkers: 1, maxCoworkers: LOCAL_SWARM_LIMITS.coworkers, maxDepth: 1, anonymous: false })
    const settings = f.database.structured.snapshot(id)!.settings
    expect(settings.permission).toBe('accept-edits')
    expect(settings.localGit).toBe(false)
    await vi.waitFor(() => expect(f.submissions.find(entry => entry.id === id)?.prompt).toContain('Write tests for add()'))
    // The fixture coworker answers without agents.report; its controller hears anyway.
    await vi.waitFor(() => expect(f.database.structured.snapshot('local-lead')!.items.some(item => item.data.type === 'text' && item.data.role === 'user' && item.data.origin?.agentSessionId === id && /Automatic report: Tests for add/.test(item.data.text))).toBe(true), { timeout: 10_000 })
    await expect(f.control.call(local, 'tabs.open', { research: true })).rejects.toThrow(/deep-research grant/)
    await expect(f.control.call(local, 'tabs.open', { provider: 'codex' })).rejects.toThrow(/only local coworkers/)
  })

  it('bounds the swarm to three coworkers, one level deep', async () => {
    const f = fixture()
    const local = f.ownersLocalTab('local-lead')
    const ids: string[] = []
    for (let index = 0; index < LOCAL_SWARM_LIMITS.coworkers; index++) ids.push((await f.control.call(local, 'tabs.open', { title: 'worker ' + index }) as AgentControlTab).resourceId!)
    await expect(f.control.call(local, 'tabs.open', {})).rejects.toThrow(/most a local swarm/)
    await expect(f.control.call({ ...local, agentSessionId: ids[0]! }, 'tabs.open', {})).rejects.toThrow(/1 level deep/)
  })

  it('steers and finishes only its own local coworkers', async () => {
    const f = fixture()
    const local = f.ownersLocalTab('local-lead')
    const other = f.ownersLocalTab('local-other')
    const worker = (await f.control.call(local, 'tabs.open', {}) as AgentControlTab).resourceId!
    await expect(f.control.call(local, 'agents.steer', { agentSessionId: 'controller', prompt: 'hi' })).rejects.toThrow(/only the local coworkers it opened/)
    await expect(f.control.call(local, 'agents.steer', { agentSessionId: other.agentSessionId, prompt: 'hi' })).rejects.toThrow(/only the local coworkers it opened/)
    expect(await f.control.call(local, 'agents.steer', { agentSessionId: worker, prompt: 'next step' })).toMatchObject({ agentSessionId: worker })
  })

  it('an anonymous opener opens anonymous coworkers, and a kept conversation cannot read them', async () => {
    const f = fixture()
    const local = f.ownersLocalTab('local-anon', {}, true)
    const opened = await f.control.call(local, 'tabs.open', { title: 'secret worker', prompt: 'work' }) as AgentControlTab
    const id = opened.resourceId!
    expect(anonymousConversations.has(id)).toBe(true)
    expect(opened.state?.anonymous).toBe(true)
    // Nothing of it in SQLite, while it is fully there in memory.
    expect(f.database.structured.snapshot(id)).not.toBeNull()
    expect(f.database.listProcesses().some(process => process.id === id)).toBe(true)
    // The kept Codex controller sees a masked tab and cannot read its content.
    const listed = await f.control.call(f.scope, 'agents.list', {}) as Array<{ agentSessionId: string; title: string }>
    expect(listed.find(entry => entry.agentSessionId === id)?.title).toBe('Anonymous local conversation')
    await expect(f.control.call(f.scope, 'agents.snapshot', { agentSessionId: id })).rejects.toThrow(/anonymous/)
    // Its anonymous opener reads it.
    expect(await f.control.call(local, 'agents.snapshot', { agentSessionId: id })).toMatchObject({ agentSessionId: id })
    // The anonymous coworker reports to its anonymous opener.
    await vi.waitFor(() => expect(f.database.structured.snapshot(id)?.phase).toBe('completed'))
    expect(await f.control.call({ ...local, agentSessionId: id }, 'agents.report', { text: 'finished' })).toMatchObject({ agentSessionId: 'local-anon' })
  })

  it('an anonymous tab opened by a kept controller cannot report into its history', async () => {
    const f = fixture()
    f.database.structured.update('controller', { settings: { ...f.database.structured.snapshot('controller')!.settings, permission: 'accept-edits' } })
    const opened = await f.control.call(f.scope, 'tabs.open', { provider: 'local', model: 'local-synthetic', anonymous: true }) as AgentControlTab
    expect(anonymousConversations.has(opened.resourceId!)).toBe(true)
    await expect(f.control.call({ ...f.scope, agentSessionId: opened.resourceId! }, 'agents.report', { text: 'secret' })).rejects.toThrow(/anonymous/)
    await expect(f.control.call(f.scope, 'tabs.open', { provider: 'codex', anonymous: true })).rejects.toThrow(/local models only/)
  })
})

describe('local control surface for swarms', () => {
  it('offers tabs.open, agents.steer and agents.finish only to writable turns, with their fields only', () => {
    expect(LOCAL_CONTROL_METHODS).toEqual(expect.arrayContaining(['tabs.open', 'agents.steer', 'agents.finish']))
    expect(() => assertLocalControlAllowed('tabs.open', { title: 'x', prompt: 'y' }, true)).toThrow(/unavailable/)
    expect(() => assertLocalControlAllowed('tabs.open', { title: 'x', prompt: 'y' }, false)).not.toThrow()
    expect(() => assertLocalControlAllowed('tabs.open', { projectId: 'elsewhere' }, false)).toThrow(/cannot be overridden/)
    expect(() => assertLocalControlAllowed('agents.steer', { agentSessionId: 'a', prompt: 'p', projectId: 'x' }, false)).toThrow(/cannot be overridden/)
    const readOnly = toolSpecs(true, true).find(spec => spec.function.name === 'conductor')!
    expect(JSON.stringify(readOnly)).not.toContain('tabs.open')
    expect(JSON.stringify(toolSpecs(false, true).find(spec => spec.function.name === 'conductor'))).toContain('Local swarm')
  })
})
