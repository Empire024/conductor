import { describe, expect, it, vi } from 'vitest'
import { createDefaultLayout, makeId, type PaneTab, type SessionRecord, type WorkspaceLayout } from '../shared/models'
import { RemoteFullMirror, seedLayout } from './remote-full-mirror'
import type { RemoteSessionBinding } from './remote-session-mirror'

type HostAgent = { tabId: string; agentSessionId: string; title: string; provider: string }

/** A host (MAIN) with workspaces and tabs, and a laptop-side store, wired the way the service wires them. */
function fixture(options: { mirroring?: boolean } = {}) {
  const settings = new Map<string, string>()
  const sessions: SessionRecord[] = []
  const host: { workspaces: Array<{ id: string; name: string; agents: HostAgent[] }> } = {
    workspaces: [
      { id: 'main-ws-1', name: 'Workspace 1', agents: [{ tabId: 'main-tab-1', agentSessionId: 'main-agent-1', title: 'Wizard', provider: 'claude' }, { tabId: 'main-tab-2', agentSessionId: 'main-agent-2', title: 'Builder', provider: 'codex' }] },
      { id: 'main-ws-2', name: 'rosin model', agents: [{ tabId: 'main-tab-3', agentSessionId: 'main-agent-3', title: 'Rosin ROOT', provider: 'claude' }, { tabId: 'main-tab-x', agentSessionId: 'main-agent-x', title: 'Shell', provider: 'terminal' }] },
      { id: 'main-ws-empty', name: 'Empty', agents: [] }
    ]
  }
  const record = (projectId: string, name: string, layout: WorkspaceLayout = createDefaultLayout()): SessionRecord => {
    const session: SessionRecord = { id: makeId('session'), projectId, name, layout, maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '' }
    sessions.push(session)
    return session
  }
  // The adopted "Remote: MAIN" project starts with one empty workspace, as adoption leaves it.
  const starter = record('laptop-project', 'Workspace')
  const bindings = new Map<string, RemoteSessionBinding>()
  const opened: Array<{ sessionId: string; tab: PaneTab }> = []
  const closed: string[] = []
  const changed: string[] = []
  let mirroring = options.mirroring ?? true
  const mirror = new RemoteFullMirror({
    database: {
      getSetting: key => settings.get(key) ?? null,
      setSetting: (key, value) => { settings.set(key, value) },
      listSessions: projectId => sessions.filter(session => session.projectId === projectId),
      createSession: (projectId, name) => record(projectId, name ?? 'New session'),
      renameSession: (id, name) => { const session = sessions.find(entry => entry.id === id); if (session) session.name = name },
      saveSession: (id, layout) => { const session = sessions.find(entry => entry.id === id); if (session) session.layout = layout }
    },
    call: async (_machineId, method, args) => {
      if (method === 'workspaces.list') return host.workspaces.map(({ id, name }) => ({ id, name, projectId: args.projectId }))
      if (method === 'agents.list') return host.workspaces.find(workspace => workspace.id === args.sessionId)?.agents ?? []
      throw new Error('unexpected ' + method)
    },
    hosts: () => mirroring ? [{ machineId: 'main', machineName: 'MAIN', projects: [{ localProjectId: 'laptop-project', remoteProjectId: 'main-project' }] }] : [],
    mirror: {
      list: () => [...bindings.values()],
      bind: binding => { bindings.set(binding.localSessionId, binding); return binding },
      release: id => { bindings.delete(id) },
      start: vi.fn()
    },
    cwdFor: async () => 'C:\\Claude\\conductor',
    openTab: async (scope, tab) => { opened.push({ sessionId: scope.sessionId, tab }) },
    closeTab: async (_scope, localSessionId) => { closed.push(localSessionId) },
    workspacesChanged: projectId => { changed.push(projectId) },
    subscriptionsChanged: vi.fn(),
    makeId
  })
  const tabsOf = (session: SessionRecord): PaneTab[] => {
    const collect = (node: WorkspaceLayout['root']): PaneTab[] => node.type === 'group' ? node.tabs : node.children.flatMap(collect)
    return collect(session.layout.root)
  }
  return { mirror, host, sessions, starter, bindings, opened, closed, changed, settings, tabsOf, setMirroring(value: boolean) { mirroring = value } }
}

describe('the laptop as a full mirror of MAIN', () => {
  it('shows every MAIN conversation, workspace by workspace, without the owner opening anything', async () => {
    const fix = fixture()
    await fix.mirror.sync('main')
    // The empty starter workspace takes MAIN's first workspace; the window already holds it, so
    // its tabs go in through the window. A workspace the window has never seen is seeded on disk.
    expect(fix.starter.name).toBe('Workspace 1')
    expect(fix.opened.filter(entry => entry.sessionId === fix.starter.id).map(entry => entry.tab.title)).toEqual(['Wizard', 'Builder'])
    const rosin = fix.sessions.find(session => session.name === 'rosin model')!
    expect(fix.tabsOf(rosin).map(tab => [tab.title, tab.kind, tab.state?.machineId, tab.state?.machineName])).toEqual([['Rosin ROOT', 'agent', 'main', 'MAIN']])
    // An empty host workspace and a non-conversation tab are not mirrored.
    expect(fix.sessions.some(session => session.name === 'Empty')).toBe(false)
    expect([...fix.bindings.values()].map(binding => binding.remoteAgentSessionId).sort()).toEqual(['main-agent-1', 'main-agent-2', 'main-agent-3'])
    // Each is an attached, auto mirror: closing it here only stops watching, and its authority is a placed tab's.
    for (const binding of fix.bindings.values()) expect(binding).toMatchObject({ attached: true, auto: true, machineId: 'main', projectId: 'laptop-project', remoteProjectId: 'main-project', cwd: 'C:\\Claude\\conductor' })
    expect(fix.changed).toContain('laptop-project')
    expect(fix.mirror.wanted('main').map(entry => entry.sessionId).sort()).toEqual(['main-ws-1', 'main-ws-2'])
  })

  it('is idempotent, adds what MAIN opens, and closes here what ended there', async () => {
    const fix = fixture()
    await fix.mirror.sync('main')
    const before = fix.sessions.length
    await fix.mirror.sync('main')
    expect(fix.sessions.length).toBe(before)
    expect(fix.opened).toHaveLength(2)
    fix.host.workspaces[0]!.agents.push({ tabId: 'main-tab-4', agentSessionId: 'main-agent-4', title: 'New coworker', provider: 'claude' })
    const ended = [...fix.bindings.values()].find(binding => binding.remoteAgentSessionId === 'main-agent-2')!
    fix.host.workspaces[0]!.agents.splice(1, 1)
    await fix.mirror.sync('main')
    expect(fix.opened.map(entry => entry.tab.title)).toContain('New coworker')
    expect(fix.closed).toEqual([ended.localSessionId])
    expect(fix.bindings.has(ended.localSessionId)).toBe(false)
  })

  it('leaves tabs the owner opened or placed alone, and never reopens one the owner closed', async () => {
    const fix = fixture()
    // A conversation the laptop placed on MAIN itself: already bound, not auto.
    fix.bindings.set('placed', { localSessionId: 'placed', machineId: 'main', projectId: 'laptop-project', workspaceId: fix.starter.id, provider: 'claude', cwd: 'x', remoteProjectId: 'main-project', remoteSessionId: 'main-ws-1', remoteAgentSessionId: 'main-agent-1', remoteSequence: 0 })
    fix.mirror.dismiss({ machineId: 'main', remoteAgentSessionId: 'main-agent-2' })
    await fix.mirror.sync('main')
    expect(fix.opened.map(entry => entry.tab.title)).toEqual([])
    expect([...fix.bindings.keys()].filter(id => id !== 'placed')).toHaveLength(1)
    // It ending on MAIN does not close the owner's own tab.
    fix.host.workspaces[0]!.agents = []
    await fix.mirror.sync('main')
    expect(fix.bindings.has('placed')).toBe(true)
    expect(fix.closed).toEqual([])
    // Opening it again by hand lifts the dismissal.
    fix.mirror.undismiss('main', 'main-agent-2')
    fix.host.workspaces[0]!.agents = [{ tabId: 'main-tab-2', agentSessionId: 'main-agent-2', title: 'Builder', provider: 'codex' }]
    await fix.mirror.sync('main')
    expect(fix.opened.map(entry => entry.tab.title)).toEqual(['Builder'])
  })

  it('follows a workspace renamed on MAIN unless the owner renamed it here, and keeps a closed one closed', async () => {
    const fix = fixture()
    await fix.mirror.sync('main')
    const rosin = fix.sessions.find(session => session.name === 'rosin model')!
    fix.host.workspaces[1]!.name = 'rosin v2'
    fix.host.workspaces[0]!.name = 'renamed on MAIN'
    fix.starter.name = 'my own name'
    await fix.mirror.sync('main')
    expect(rosin.name).toBe('rosin v2')
    expect(fix.starter.name).toBe('my own name')
    // The owner closes the mirrored workspace here: it is not recreated.
    fix.sessions.splice(fix.sessions.indexOf(rosin), 1)
    fix.host.workspaces[1]!.agents.push({ tabId: 'main-tab-5', agentSessionId: 'main-agent-5', title: 'Another', provider: 'claude' })
    await fix.mirror.sync('main')
    expect(fix.sessions.some(session => session.name === 'rosin v2')).toBe(false)
    expect(fix.mirror.wanted('main').map(entry => entry.sessionId)).toEqual(['main-ws-1'])
  })

  it('does nothing for a host that does not mirror everything', async () => {
    const fix = fixture({ mirroring: false })
    await fix.mirror.sync('main')
    expect(fix.opened).toEqual([])
    expect(fix.bindings.size).toBe(0)
    expect(fix.starter.name).toBe('Workspace')
  })
})

describe('seedLayout', () => {
  it('gives the launcher’s place to the mirrored tabs, or adds them after real tabs', () => {
    const tab = (title: string): PaneTab => ({ id: makeId('pane'), kind: 'agent', title })
    const empty = createDefaultLayout()
    const seeded = seedLayout(empty, [tab('a'), tab('b')])
    expect(seeded.root.type === 'group' && seeded.root.tabs.map(entry => entry.title)).toEqual(['a', 'b'])
    expect(seeded.root.type === 'group' && seeded.root.activeTabId).toBe(seeded.root.type === 'group' ? seeded.root.tabs[1]!.id : '')
    const busy = seedLayout(seeded, [tab('c')])
    expect(busy.root.type === 'group' && busy.root.tabs.map(entry => entry.title)).toEqual(['a', 'b', 'c'])
  })
})
