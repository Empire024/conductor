import { describe, expect, it } from 'vitest'
import type { AgentControlLink } from '../shared/agent-control'
import type { WorkspaceTabMoveRequest } from '../shared/ipc'
import type { AgentSpec, PaneTab, SessionRecord, WorkspaceLayout } from '../shared/models'
import { movedControlLink, moveTabsBetweenWorkspaces, type WorkspaceTabMoveDeps } from './workspace-tab-move'

const agent = (id: string): PaneTab => ({ id, kind: 'agent', title: id, resourceId: 'agent_' + id })
const layout = (tabs: PaneTab[], id = 'g'): WorkspaceLayout => ({ version: 1, root: { type: 'group', id, tabs, activeTabId: tabs[0]?.id ?? '' } })
const record = (id: string, projectId = 'p'): SessionRecord => ({ id, projectId, name: id, layout: layout([]), maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '' })
const spec = (id: string, sessionId: string, projectId = 'p'): AgentSpec => ({ id, projectId, sessionId, provider: 'claude', title: id, cwd: '' } as AgentSpec)

function harness(options: { remote?: string[]; specs?: AgentSpec[]; sessions?: SessionRecord[] } = {}) {
  const calls: string[] = []
  const specs = new Map((options.specs ?? [spec('agent_a', 'w1'), spec('agent_b', 'w1')]).map(item => [item.id, item]))
  const sessions = new Map((options.sessions ?? [record('w1'), record('w2')]).map(item => [item.id, item]))
  const deps: WorkspaceTabMoveDeps = {
    getSession: id => sessions.get(id),
    spec: id => specs.get(id),
    isRemote: id => options.remote?.includes(id) ?? false,
    save: (sessionId, saved) => { calls.push(`save ${sessionId}`); return { restoredTabIds: [], layout: saved } },
    moveConversation: (id, sessionId) => { calls.push(`move ${id} -> ${sessionId}`); specs.set(id, { ...specs.get(id)!, sessionId }) },
    linksMoved: (projectId, ids, from, to) => { calls.push(`links ${ids.join(',')} ${from}->${to}`) },
    notifyTabs: (_projectId, sessionId) => { calls.push(`notify ${sessionId}`) }
  }
  return { deps, calls, specs }
}
const request = (tabIds: string[], source: PaneTab[], target: PaneTab[], extra: Partial<WorkspaceTabMoveRequest> = {}): WorkspaceTabMoveRequest => ({
  projectId: 'p', tabIds,
  source: { id: 'w1', layout: layout(source), maximizedGroupId: null, closedTabs: [] },
  target: { id: 'w2', layout: layout(target), maximizedGroupId: null, closedTabs: [] },
  ...extra
})

describe('moving tabs between workspaces in main', () => {
  it('rebinds each moved conversation, moves its links, then writes the target before the source', () => {
    const { deps, calls, specs } = harness()
    const result = moveTabsBetweenWorkspaces(deps, request(['a', 't'], [agent('b')], [agent('a'), { id: 't', kind: 'terminal', title: 'T', resourceId: 'terminal_1' }]))
    expect(result).toEqual({ moved: ['a', 't'], conversations: ['agent_a'], repairs: [] })
    expect(calls).toEqual(['move agent_a -> w2', 'links agent_a w1->w2', 'save w2', 'notify w2', 'save w1', 'notify w1'])
    expect(specs.get('agent_a')!.sessionId).toBe('w2')
    expect(specs.get('agent_b')!.sessionId).toBe('w1')
  })

  it('returns what the save guard restored', () => {
    const { deps } = harness()
    deps.save = (sessionId, saved) => sessionId === 'w1' ? { restoredTabIds: ['b'], layout: saved } : { restoredTabIds: [], layout: saved }
    expect(moveTabsBetweenWorkspaces(deps, request(['a'], [], [agent('a')])).repairs.map(item => item.sessionId)).toEqual(['w1'])
  })

  it('refuses another project, a remote conversation and a stale layout before changing anything', () => {
    const cases: Array<[ReturnType<typeof harness>, WorkspaceTabMoveRequest, RegExp]> = [
      [harness({ sessions: [record('w1'), record('w2', 'q')] }), request(['a'], [], [agent('a')]), /one project/],
      [harness({ specs: [spec('agent_a', 'w1', 'q')] }), request(['a'], [], [agent('a')]), /one project/],
      [harness({ remote: ['agent_a'] }), request(['a'], [], [agent('a')]), /another machine/],
      [harness(), request(['a'], [agent('a')], [agent('a')]), /no longer matches/],
      [harness(), request(['a'], [], []), /no longer matches/],
      [harness(), request(['a'], [], [agent('a')], { target: { id: 'w1', layout: layout([agent('a')]), maximizedGroupId: null, closedTabs: [] } }), /already in that workspace/],
      [harness({ sessions: [record('w1')] }), request(['a'], [], [agent('a')]), /no longer open/]
    ]
    for (const [{ deps, calls }, move, error] of cases) {
      expect(() => moveTabsBetweenWorkspaces(deps, move)).toThrow(error)
      expect(calls).toEqual([])
    }
  })

  it('moves a tab whose conversation was never registered as layout only', () => {
    const { deps, calls } = harness({ specs: [] })
    expect(moveTabsBetweenWorkspaces(deps, request(['a'], [], [agent('a')])).conversations).toEqual([])
    expect(calls[0]).toBe('links  w1->w2')
  })
})

describe('control links after a move', () => {
  const link = (extra: Partial<AgentControlLink> = {}): AgentControlLink => ({ projectId: 'p', sessionId: 'w1', controllerAgentSessionId: 'main', targetAgentSessionId: 'cow', controllerTabId: 'tm', controlledTabId: 'tc', ...extra })

  it('a coworker moved away from its controller keeps it across workspaces', () => {
    expect(movedControlLink(link(), new Set(['cow']), 'p', 'w2')).toEqual(link({ sessionId: 'w2', controllerProjectId: 'p', controllerSessionId: 'w1' }))
  })
  it('a controller moved away keeps its coworker across workspaces', () => {
    expect(movedControlLink(link(), new Set(['main']), 'p', 'w2')).toEqual(link({ controllerProjectId: 'p', controllerSessionId: 'w2' }))
  })
  it('both moved, or one moved back to the other, is one workspace again', () => {
    expect(movedControlLink(link(), new Set(['main', 'cow']), 'p', 'w2')).toEqual(link({ sessionId: 'w2' }))
    expect(movedControlLink(link({ sessionId: 'w2', controllerProjectId: 'p', controllerSessionId: 'w1' }), new Set(['cow']), 'p', 'w1')).toEqual(link())
  })
  it('a controller in another project stays where it is', () => {
    const across = link({ controllerProjectId: 'q', controllerSessionId: 'x1' })
    expect(movedControlLink(across, new Set(['cow']), 'p', 'w2')).toEqual({ ...across, sessionId: 'w2' })
  })
  it('an untouched link is returned as is', () => {
    const untouched = link()
    expect(movedControlLink(untouched, new Set(['other']), 'p', 'w2')).toBe(untouched)
  })
})
