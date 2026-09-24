import { describe, expect, it } from 'vitest'
import type { LayoutNode, PaneTab, WorkspaceLayout } from '../shared/models'
import { guardLayoutSave } from './layout-save-guard'

/* B1 contract (conductor-task:764a7740). A layout save that drops a tab whose agent still has a
   running or waiting turn is repaired in the main process, the same protection tabs.close gives
   active work. The owner's own close is honoured: it lists the tab in the saved closedTabs. */

const agent = (id: string): PaneTab => ({ id, kind: 'agent', resourceId: 'agent-' + id, title: id, state: { provider: 'claude' } })
const file = (id: string): PaneTab => ({ id, kind: 'code', resourceId: id + '.ts', title: id })
const group = (id: string, tabs: PaneTab[]): LayoutNode => ({ type: 'group', id, activeTabId: tabs[0]?.id ?? '', tabs })
const layout = (root: LayoutNode): WorkspaceLayout => ({ version: 1, root })
const ids = (node: LayoutNode): string[] => node.type === 'split' ? node.children.flatMap(ids) : node.tabs.map(tab => tab.id)
const live = new Set(['agent-coworker-1', 'agent-coworker-2'])
const hasLiveWork = (agentSessionId: string): boolean => live.has(agentSessionId)

describe('guardLayoutSave', () => {
  it('restores a live agent tab a stale write dropped, into the group it was in', () => {
    const previous = layout({ type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [group('left', [agent('controller'), agent('coworker-1')]), group('right', [agent('coworker-2'), file('notes')])] })
    const stale = layout({ type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [group('left', [agent('controller')]), group('right', [file('notes')])] })
    const result = guardLayoutSave({ previous, next: stale, closedTabs: [], elsewhereTabIds: new Set(), hasLiveWork })
    expect(result.restoredTabIds).toEqual(['coworker-1', 'coworker-2'])
    expect(result.layout.root.type).toBe('split')
    if (result.layout.root.type !== 'split') return
    expect(ids(result.layout.root.children[0]!)).toEqual(['controller', 'coworker-1'])
    expect(ids(result.layout.root.children[1]!)).toEqual(['notes', 'coworker-2'])
  })

  it('puts a restored tab in the first group when its old group no longer exists', () => {
    const previous = layout({ type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [group('left', [agent('controller')]), group('right', [agent('coworker-1')])] })
    const next = layout(group('left', [agent('controller')]))
    const result = guardLayoutSave({ previous, next, closedTabs: [], elsewhereTabIds: new Set(), hasLiveWork })
    expect(result.restoredTabIds).toEqual(['coworker-1'])
    expect(ids(result.layout.root)).toEqual(['controller', 'coworker-1'])
  })

  it('lets a save drop settled agents, non-agent tabs, owner-closed tabs and tabs moved elsewhere', () => {
    const previous = layout(group('g', [agent('controller'), agent('settled'), file('notes'), agent('coworker-1'), agent('coworker-2')]))
    const next = layout(group('g', [agent('controller')]))
    const result = guardLayoutSave({ previous, next, closedTabs: [agent('coworker-1')], elsewhereTabIds: new Set(['coworker-2']), hasLiveWork })
    expect(result.restoredTabIds).toEqual([])
    expect(result.layout).toBe(next)
  })

  it('does not duplicate a live tab that moved to another group, and passes an unchanged save through', () => {
    const previous = layout({ type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [group('left', [agent('controller'), agent('coworker-1')]), group('right', [file('notes')])] })
    const moved = layout({ type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [group('left', [agent('controller')]), group('right', [file('notes'), agent('coworker-1')])] })
    const result = guardLayoutSave({ previous, next: moved, closedTabs: [], elsewhereTabIds: new Set(), hasLiveWork })
    expect(result).toEqual({ layout: moved, restoredTabIds: [] })
    expect(guardLayoutSave({ previous: null, next: moved, closedTabs: [], elsewhereTabIds: new Set(), hasLiveWork })).toEqual({ layout: moved, restoredTabIds: [] })
  })
})

it('does not restore live work already placed elsewhere under a different tab id', () => {
  const previous = layout(group('g', [agent('controller'), agent('coworker-1')]))
  const next = layout(group('g', [agent('controller')]))
  const result = guardLayoutSave({ previous, next, closedTabs: [], elsewhereTabIds: new Set(['replacement-tab-id']), elsewhereResourceIds: new Set(['agent-coworker-1']), hasLiveWork })
  expect(result.restoredTabIds).toEqual([])
  expect(result.layout).toBe(next)
})
