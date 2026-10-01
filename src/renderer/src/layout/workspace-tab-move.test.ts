import { describe, expect, it } from 'vitest'
import type { PaneTab, SessionRecord, WorkspaceLayout } from '../../../shared/models'
import { listGroups } from './layout-operations'
import { movedConversationIds, moveTabsToWorkspace, workspaceDropVerdict } from './workspace-tab-move'

const tab = (id: string, extra: Partial<PaneTab> = {}): PaneTab => ({ id, kind: 'agent', title: id.toUpperCase(), resourceId: 'agent_' + id, state: { provider: 'claude', draftHint: id }, ...extra })
const twoPanes = (): WorkspaceLayout => ({ version: 1, root: { type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [
  { type: 'group', id: 'left', tabs: [tab('a', { tabGroupId: 'g1' }), tab('b', { tabGroupId: 'g1' }), tab('c')], activeTabId: 'a', tabGroups: [{ id: 'g1', title: 'Pair', color: 'blue' }] },
  { type: 'group', id: 'right', tabs: [tab('d')], activeTabId: 'd' }
] } } as WorkspaceLayout)
const onePane = (ids: string[], id = 'only'): WorkspaceLayout => ({ version: 1, root: { type: 'group', id, tabs: ids.map(item => tab(item)), activeTabId: ids[0] ?? '' } })
const session = (id: string, layout: WorkspaceLayout, projectId = 'p'): SessionRecord => ({ id, projectId, name: id.toUpperCase(), layout, maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '' })
const strip = (layout: WorkspaceLayout): Record<string, string[]> => Object.fromEntries(listGroups(layout.root).map(group => [group.id, group.tabs.map(item => item.id)]))

describe('moving tabs to another workspace', () => {
  it('lifts a tab out of its workspace and appends it, active, to the target pane, unchanged', () => {
    const source = session('w1', twoPanes()), target = session('w2', onePane(['x', 'y']))
    const result = moveTabsToWorkspace(source, target, ['c'])!
    expect(strip(result.source.layout)).toEqual({ left: ['a', 'b'], right: ['d'] })
    expect(strip(result.target.layout)).toEqual({ only: ['x', 'y', 'c'] })
    expect(listGroups(result.target.layout.root)[0]!.activeTabId).toBe('c')
    // Same id, resource and state: the conversation, its draft and its control links follow.
    expect(listGroups(result.target.layout.root)[0]!.tabs[2]).toEqual(tab('c'))
    expect(result.groupId).toBe('only')
  })

  it('moves a selection together, in strip order, the first of it active, and leaves its tab-strip group behind', () => {
    const result = moveTabsToWorkspace(session('w1', twoPanes()), session('w2', onePane(['x'])), ['d', 'a'])!
    expect(result.moved.map(item => item.id)).toEqual(['d', 'a'])
    expect(strip(result.target.layout)).toEqual({ only: ['x', 'd', 'a'] })
    expect(listGroups(result.target.layout.root)[0]!.activeTabId).toBe('d')
    expect(result.moved.every(item => item.tabGroupId === undefined)).toBe(true)
  })

  it('leaves the source workspace empty, not gone, when its last tab moves', () => {
    const result = moveTabsToWorkspace(session('w1', onePane(['a'])), session('w2', onePane(['x'])), ['a'])!
    expect(result.source.layout.root).toMatchObject({ type: 'group', tabs: [] })
    expect(result.source.id).toBe('w1')
  })

  it('lands in an empty target workspace and in the pane the owner last used there', () => {
    const empty = moveTabsToWorkspace(session('w1', onePane(['a', 'b'])), session('w2', onePane([], 'root')), ['b'])!
    expect(strip(empty.target.layout)).toEqual({ root: ['b'] })
    const chosen = moveTabsToWorkspace(session('w2', onePane(['x'])), session('w1', twoPanes()), ['x'], 'right')!
    expect(strip(chosen.target.layout).right).toEqual(['d', 'x'])
  })

  it('clears a maximized pane the move emptied', () => {
    const layout = twoPanes()
    const source = { ...session('w1', layout), maximizedGroupId: 'right' }
    expect(moveTabsToWorkspace(source, session('w2', onePane(['x'])), ['d'])!.source.maximizedGroupId).toBeNull()
    expect(moveTabsToWorkspace(source, session('w2', onePane(['x'])), ['c'])!.source.maximizedGroupId).toBe('right')
  })

  it('does nothing for the same workspace, another project or tabs it cannot find', () => {
    const source = session('w1', twoPanes())
    expect(moveTabsToWorkspace(source, source, ['a'])).toBeNull()
    expect(moveTabsToWorkspace(source, session('w9', onePane(['x']), 'other'), ['a'])).toBeNull()
    expect(moveTabsToWorkspace(source, session('w2', onePane(['x'])), ['nope'])).toBeNull()
  })

  it('names the agent conversations that have to move with the tabs', () => {
    expect(movedConversationIds([tab('a'), { id: 't', kind: 'terminal', title: 'T', resourceId: 'terminal_1' }, { id: 'l', kind: 'launcher', title: 'New' }])).toEqual(['agent_a'])
  })
})

describe('a workspace drop target', () => {
  const drag = { projectId: 'p', sessionId: 'w1', tabIds: ['a'] }
  it('moves into another workspace of the project, no-ops on its own, refuses another project', () => {
    expect(workspaceDropVerdict(drag, { projectId: 'p', id: 'w2' })).toBe('move')
    expect(workspaceDropVerdict(drag, { projectId: 'p', id: 'w1' })).toBe('same')
    expect(workspaceDropVerdict(drag, { projectId: 'q', id: 'w3' })).toBe('foreign')
    expect(workspaceDropVerdict(null, { projectId: 'p', id: 'w2' })).toBe('none')
    expect(workspaceDropVerdict({ ...drag, tabIds: [] }, { projectId: 'p', id: 'w2' })).toBe('none')
  })
})
