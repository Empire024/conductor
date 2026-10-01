// A tab dragged to another workspace (feature-list ee0fbf15) takes its conversation along mid-turn:
// the real StructuredSessions, AgentControl and AgentControlServer, with a provider that never
// finishes its turn, so nothing here can pass by restarting the conversation.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from './agent-control'
import { AgentControlServer } from './agent-control-server'
import { AgentCollaborationStore } from './agent-collaboration-store'
import { ConductorDatabase } from './database'
import { OrchestrationStore } from './orchestration-store'
import { ProjectBacklogs } from './project-backlog'
import { StructuredSessions } from './structured-sessions'
import { moveTabsBetweenWorkspaces } from './workspace-tab-move'
import type { AgentControlLink } from '../shared/agent-control'
import type { AgentSpec, PaneTab, WorkspaceLayout } from '../shared/models'
import type { ProviderCapabilities } from '../shared/structured-agent'
import type { ProviderAdapter } from './providers/adapter'

const dispose: Array<() => void> = []
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); vi.unstubAllEnvs() })

function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0'); vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-tab-move-')), projectPath = join(root, 'project')
  mkdirSync(projectPath)
  dispose.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const path = join(root, 'conductor.db'), database = new ConductorDatabase(path)
  dispose.push(() => database.close())
  const project = database.upsertProject(projectPath, 'Move project'), first = database.listSessions(project.id)[0]!
  const second = database.createSession(project.id, 'Second')
  const orchestration = new OrchestrationStore(path), collaboration = new AgentCollaborationStore(path)
  dispose.push(() => orchestration.close(), () => collaboration.close())
  let runtimes = 0
  const sessions = new StructuredSessions(database, () => 'synthetic-provider', vi.fn(), (provider, options): ProviderAdapter => {
    runtimes += 1
    const capabilities: ProviderCapabilities = { provider, runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true, toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: false, plans: false, permissions: ['default', 'read-only', 'accept-edits'], sandboxModes: ['inherit', 'read-only', 'workspace-write'], effort: ['low'], models: [{ id: provider + '-synthetic', label: 'Synthetic', effort: ['low'], defaultEffort: 'low' }], limitations: [] }
    return { provider, capabilities,
      start: async () => { options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-' + options.runtimeId } }) },
      // The turn starts and never ends: whatever a move does must happen while it runs.
      submit: async () => { options.emit({ data: { type: 'session', phase: 'running' } }) },
      respond: async () => {}, interrupt: async () => {}, dispose: () => {} }
  })
  dispose.push(() => sessions.dispose())
  const spec = (id: string): AgentSpec => ({ id, projectId: project.id, sessionId: first.id, cwd: project.path, provider: 'codex', title: id, model: 'codex-synthetic' })
  const controller = spec('controller'), coworker = spec('coworker')
  sessions.ensure(controller); sessions.ensure(coworker)
  const tab = (agent: AgentSpec): PaneTab => ({ id: agent.id + '-tab', kind: 'agent', resourceId: agent.id, title: agent.title, state: { provider: 'codex', model: agent.model } })
  const layout = (tabs: PaneTab[], id: string): WorkspaceLayout => ({ version: 1, root: { type: 'group', id, activeTabId: tabs[0]?.id ?? '', tabs } })
  database.saveSession(first.id, layout([tab(controller), tab(coworker)], 'g1'), null, [])
  database.saveSession(second.id, layout([], 'g2'), null, [])
  const link: AgentControlLink = { projectId: project.id, sessionId: first.id, controllerAgentSessionId: controller.id, targetAgentSessionId: coworker.id, controllerTabId: tab(controller).id, controlledTabId: tab(coworker).id }
  database.setSetting('agentControlParent:' + coworker.id, JSON.stringify(link))
  const linksChanged = vi.fn()
  const control = new AgentControl({ database, sessions, orchestration, collaboration, backlogs: new ProjectBacklogs(database), ui: vi.fn(async () => ({ applied: true })), confirm: vi.fn(async () => false), fileChanged: vi.fn(), linksChanged, providers: () => [] } as unknown as ConstructorParameters<typeof AgentControl>[0])
  const move = (ids: string[], to = second.id, from = first.id) => {
    const source = database.getSession(from)!, target = database.getSession(to)!
    const keep = (node: WorkspaceLayout['root']): PaneTab[] => node.type === 'group' ? node.tabs : node.children.flatMap(keep)
    const moving = keep(source.layout.root).filter(item => ids.includes(item.id)), staying = keep(source.layout.root).filter(item => !ids.includes(item.id))
    return moveTabsBetweenWorkspaces({
      getSession: id => database.getSession(id),
      spec: id => database.structured.spec<AgentSpec>(id),
      isRemote: () => false,
      save: (sessionId, saved, maximizedGroupId, closedTabs) => { database.saveSession(sessionId, saved, maximizedGroupId, closedTabs); return { restoredTabIds: [], layout: saved } },
      moveConversation: (id, sessionId) => { sessions.moveWorkspace(id, sessionId); server?.rescope(id, project.id, sessionId) },
      linksMoved: (projectId, agentIds, fromId, toId) => control.workspaceMoved(projectId, agentIds, fromId, toId)
    }, {
      projectId: project.id, tabIds: ids,
      source: { id: from, layout: layout(staying, 'g-' + from), maximizedGroupId: null, closedTabs: [] },
      target: { id: to, layout: layout([...keep(target.layout.root), ...moving], 'g-' + to), maximizedGroupId: null, closedTabs: [] }
    })
  }
  let server: AgentControlServer | undefined
  const startServer = async (): Promise<AgentControlServer> => { server = new AgentControlServer(control, false); dispose.push(() => server!.close()); await server.start(); return server }
  return { database, sessions, control, project, first, second, controller, coworker, link, move, startServer, linksChanged, runtimes: () => runtimes }
}

const token = (briefing: string): string => briefing.match(/Bearer ([a-f0-9]{64})/)?.[1] ?? ''
const endpoint = (briefing: string): string => briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)?.[1] ?? ''
const post = async (briefing: string, method: string, args: Record<string, unknown> = {}): Promise<{ status: number; body: { result?: unknown; error?: string } }> => {
  const response = await fetch(endpoint(briefing), { method: 'POST', headers: { Authorization: 'Bearer ' + token(briefing), 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  return { status: response.status, body: await response.json() as { result?: unknown; error?: string } }
}

describe('dragging a tab to another workspace', () => {
  it('moves a coworker mid-turn: the turn keeps running, its credential keeps working there and its controller keeps it', async () => {
    const f = fixture()
    const settings = { permission: 'read-only' as const, sandbox: 'read-only' as const, plan: false, model: 'codex-synthetic', effort: 'low' }
    await f.sessions.submit(f.coworker.id, 'Long work', settings)
    expect(f.database.structured.snapshot(f.coworker.id)!.phase).toBe('running')
    const server = await f.startServer()
    const briefing = server.briefing(f.database.structured.spec<AgentSpec>(f.coworker.id)!)
    const runtimes = f.runtimes(), native = f.database.structured.snapshot(f.coworker.id)!.nativeSessionId

    expect(f.move(['coworker-tab'])).toMatchObject({ moved: ['coworker-tab'], conversations: ['coworker'], repairs: [] })

    const moved = f.database.structured.spec<AgentSpec>(f.coworker.id)!
    expect(moved.sessionId).toBe(f.second.id)
    expect(f.database.structured.snapshot(f.coworker.id)).toMatchObject({ phase: 'running', nativeSessionId: native })
    expect(f.runtimes()).toBe(runtimes)
    expect(f.database.listProcesses(f.project.id).find(process => process.id === f.coworker.id)?.sessionId).toBe(f.second.id)
    // Both layouts are on disk, so reloading the project shows the move.
    const tabsIn = (id: string) => { const root = f.database.getSession(id)!.layout.root; return root.type === 'group' ? root.tabs.map(item => item.id) : [] }
    expect(tabsIn(f.first.id)).toEqual(['controller-tab'])
    expect(tabsIn(f.second.id)).toEqual(['coworker-tab'])
    // The token the running CLI holds still answers, now for the new workspace.
    expect(token(server.briefing(moved))).toBe(token(briefing))
    const listed = await post(briefing, 'tabs.list')
    expect(listed.status).toBe(200)
    expect(listed.body.result).toEqual([expect.objectContaining({ id: 'coworker-tab' })])
    // The link now spans two workspaces and still binds: the controller reaches its coworker.
    expect(JSON.parse(f.database.getSetting('agentControlParent:' + f.coworker.id)!)).toEqual({ ...f.link, sessionId: f.second.id, controllerProjectId: f.project.id, controllerSessionId: f.first.id })
    const status = await f.control.call({ projectId: f.project.id, sessionId: f.first.id, agentSessionId: f.controller.id }, 'agents.status', { agentSessionId: f.coworker.id }) as { phase: string }
    expect(status.phase).toBe('running')
    expect(f.linksChanged).toHaveBeenCalledWith({ projectId: f.project.id, sessionId: f.second.id })
  })

  it('moving the controller after it joins the coworker makes the link one workspace again', () => {
    const f = fixture()
    f.move(['coworker-tab'])
    f.move(['controller-tab'])
    expect(JSON.parse(f.database.getSetting('agentControlParent:' + f.coworker.id)!)).toEqual({ ...f.link, sessionId: f.second.id })
    const root = f.database.getSession(f.first.id)!.layout.root
    expect(root.type === 'group' && root.tabs).toEqual([])
  })

  it('refuses a workspace of another project and leaves the conversation where it was', () => {
    const f = fixture()
    const otherPath = join(f.project.path, '..', 'other'); mkdirSync(otherPath)
    const other = f.database.upsertProject(otherPath, 'Other')
    expect(() => f.sessions.moveWorkspace(f.coworker.id, f.database.listSessions(other.id)[0]!.id)).toThrow('own project')
    expect(f.database.structured.spec<AgentSpec>(f.coworker.id)!.sessionId).toBe(f.first.id)
  })
})
