import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentControlUiRequest } from '../shared/agent-control'
import type { AgentSpec, PaneTab, WorkspaceLayout } from '../shared/models'
import { ConductorDatabase } from './database'
import { CoworkerRecovery } from './coworker-recovery'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
const { recordTabOpener, tabLineage } = await import('./tab-archive-ipc')

const withDatabase = (run: (database: ConductorDatabase, root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'conductor-tab-archive-'))
  const database = new ConductorDatabase(join(root, 'conductor.db'))
  try { run(database, root) } finally { database.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) }
}
const tab = (id: string, extra: Partial<PaneTab> = {}): PaneTab => ({ id, kind: 'agent', title: 'Tab ' + id, resourceId: 'agent_' + id, ...extra })
const layoutOf = (...tabs: PaneTab[]): WorkspaceLayout => ({ version: 1, root: { type: 'group', id: 'group-1', tabs, activeTabId: tabs[0]?.id ?? '' } })

describe('TabArchiveStore', () => {
  it('keeps every closed tab beyond the 20-tab reopen list, newest first, and forgets reopened ones', () => {
    withDatabase((database, root) => {
      const project = database.upsertProject(join(root, 'p'), 'P')
      const session = database.listSessions(project.id)[0]!
      const closed = Array.from({ length: 30 }, (_, index) => tab('t' + index))
      // The renderer's list is capped at 20; tabs that fell off earlier were saved before.
      for (let index = 0; index < 30; index += 5) database.saveSession(session.id, layoutOf(tab('open')), null, closed.slice(Math.max(0, index - 15), index + 5))
      expect(database.getSession(session.id)!.closedTabs.length).toBeLessThanOrEqual(20)
      expect(database.tabArchive.list(session.id).total).toBe(30)
      // Reopened through Ctrl+Shift+T: it is in the layout again, so it leaves the archive.
      database.saveSession(session.id, layoutOf(tab('open'), closed[29]!), null, closed.slice(10, 29))
      const page = database.tabArchive.list(session.id)
      expect(page.total).toBe(29)
      expect(page.tabs.some(entry => entry.tab.id === 't29')).toBe(false)
    })
  })

  it('searches by title words or an id fragment, across open workspaces', () => {
    withDatabase((database, root) => {
      const project = database.upsertProject(join(root, 'p'), 'P')
      const session = database.listSessions(project.id)[0]!
      database.tabArchive.record(session.id, [tab('a', { title: 'Fix the llama slots' }), tab('b', { title: 'Release notes' }), { id: 'launcher-1', kind: 'launcher', title: 'New tab' }])
      expect(database.tabArchive.list(session.id).total).toBe(2)
      expect(database.tabArchive.list(session.id, 'llama').tabs.map(entry => entry.tab.id)).toEqual(['a'])
      expect(database.tabArchive.search('agent_b').map(entry => entry.tab.id)).toEqual(['b'])
      expect(database.tabArchive.search('slots fix')[0]?.workspaceName).toBe(session.name)
      expect(database.tabArchive.search('100%')).toEqual([])
    })
  })

  it('never archives anonymous conversations or launchers, and delete forever also trims the reopen list', () => {
    withDatabase((database, root) => {
      const project = database.upsertProject(join(root, 'p'), 'P')
      const session = database.listSessions(project.id)[0]!
      database.saveSession(session.id, layoutOf(tab('open')), null, [tab('keep'), tab('gone'), tab('anon', { state: { anonymous: true } })])
      expect(database.tabArchive.list(session.id).tabs.map(entry => entry.tab.id).sort()).toEqual(['gone', 'keep'])
      expect(database.tabArchive.remove(session.id, ['gone'], { forgetReopen: true })).toBe(1)
      expect(database.getSession(session.id)!.closedTabs.map(item => item.id)).toEqual(['keep'])
    })
  })

  it('a save that archives nothing is never broken by the archive', () => {
    withDatabase((database, root) => {
      const project = database.upsertProject(join(root, 'p'), 'P')
      const session = database.listSessions(project.id)[0]!
      const bad = [{ id: '', kind: 'agent', title: 'x' }, null] as unknown as PaneTab[]
      expect(() => database.saveSession(session.id, layoutOf(tab('open')), null, bad)).not.toThrow()
      expect(database.getSession(session.id)!.layout.root.type).toBe('group')
    })
  })
})

describe('tab lineage', () => {
  const request = (agentSessionId: string, opened: PaneTab): AgentControlUiRequest => ({ projectId: 'p', sessionId: 's', agentSessionId, id: 'r', action: 'tabs.open', params: { tab: opened, focus: false } })

  it('records the agent that opened an agent tab once, never the owner', () => {
    const settings = new Map<string, string>()
    const store = { getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string) => { settings.set(key, value) } }
    recordTabOpener(store, request('owner', tab('x')))
    recordTabOpener(store, request('agent_ctrl_1', { id: 't', kind: 'terminal', title: 'Shell' }))
    expect(settings.size).toBe(0)
    recordTabOpener(store, request('agent_ctrl_1', tab('x')))
    recordTabOpener(store, request('agent_other_2', tab('x')))
    expect(JSON.parse(settings.get('tabOpenedBy:agent_x')!).agentSessionId).toBe('agent_ctrl_1')
  })

  it('reads "opened by" for a coworker and "continued from" for a successor, pointing at the archive once the opener closed', () => {
    withDatabase((database, root) => {
      const project = database.upsertProject(join(root, 'p'), 'P')
      const session = database.listSessions(project.id)[0]!
      const specOf = (id: string, title: string): AgentSpec => ({ id, projectId: project.id, sessionId: session.id, provider: 'claude', title, cwd: project.path })
      for (const [id, title] of [['agent_boss', 'Boss'], ['agent_worker', 'Worker'], ['agent_next', 'Boss (continued)']]) { database.upsertAgent(specOf(id!, title!), 'idle'); database.structured.register(id!, project.id, 'claude', specOf(id!, title!)) }
      const boss = tab('boss', { title: 'Boss tab', resourceId: 'agent_boss' })
      database.saveSession(session.id, layoutOf(boss), null, [])
      recordTabOpener(database, request('agent_boss', tab('worker', { resourceId: 'agent_worker' })))
      recordTabOpener(database, request('agent_boss', tab('next', { resourceId: 'agent_next' })))
      expect(tabLineage(database, 'agent_worker')).toEqual({ relation: 'opened', agentSessionId: 'agent_boss', title: 'Boss tab' })
      new CoworkerRecovery(database).supersede({ projectId: project.id, sessionId: session.id, agentSessionId: 'agent_boss' }, 'agent_boss', 'completed', 'agent_next', 'handed on')
      // The predecessor's tab is closed: the line links into the archive.
      database.saveSession(session.id, layoutOf(tab('other')), null, [boss])
      expect(tabLineage(database, 'agent_next')).toEqual({ relation: 'continued', agentSessionId: 'agent_boss', title: 'Boss tab', archived: { projectId: project.id, sessionId: session.id, tabId: 'boss' } })
      expect(tabLineage(database, 'agent_boss')).toBeNull()
    })
  })
})
