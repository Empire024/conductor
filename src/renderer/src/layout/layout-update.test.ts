import { describe, expect, it } from 'vitest'
import type { PaneTab, WorkspaceLayout } from '../../../shared/models'
import { addTab, listGroups } from './layout-operations'
import { applyLayoutUpdate, patchTabState, restoreTabs, type LayoutUpdate } from './layout-update'

/* B1 contract (conductor-task:764a7740, regression part). A pane callback outlives the render that
   made it: the Chat -> CLI -> Chat toggle on a controller tab wrote back the layout from when the
   controller mounted and deleted the coworker tabs router.dispatch had opened since. Every layout
   writer is now an update applied to the latest layout, never a whole layout from a closure. */

const agentTab = (id: string, viewMode: 'visual' | 'cli' = 'visual'): PaneTab => ({ id, kind: 'agent', resourceId: 'agent-' + id, title: id, state: { provider: 'claude', model: 'opus', viewMode } })
const controllerOnly = (): WorkspaceLayout => ({ version: 1, root: { type: 'group', id: 'group', activeTabId: 'controller', tabs: [agentTab('controller')] } })
const tabIds = (layout: WorkspaceLayout): string[] => listGroups(layout.root).flatMap(group => group.tabs.map(tab => tab.id))

describe('layout updates apply to the latest layout', () => {
  it('a whole layout replaces, an updater sees the latest layout', () => {
    const latest = addTab(controllerOnly(), 'group', agentTab('coworker-1'))
    const replaced = controllerOnly()
    expect(applyLayoutUpdate(latest, replaced)).toBe(replaced)
    const update: LayoutUpdate = layout => addTab(layout, 'group', agentTab('coworker-2'))
    expect(tabIds(applyLayoutUpdate(latest, update))).toEqual(['controller', 'coworker-1', 'coworker-2'])
  })

  it('patchTabState returns the same layout when nothing changes and ignores a tab that is gone', () => {
    const layout = controllerOnly()
    expect(patchTabState('group', 'controller', { viewMode: 'visual' })(layout)).toBe(layout)
    expect(patchTabState('group', 'missing', { viewMode: 'cli' })(layout)).toBe(layout)
    expect(patchTabState('elsewhere', 'controller', { viewMode: 'cli' })(layout)).toBe(layout)
  })

  it('regression: Chat -> CLI -> Chat on a controller keeps coworker tabs opened after it mounted', () => {
    // The controller mounts; its view-mode callbacks are created now and captured by effects.
    let session = controllerOnly()
    const toCli = patchTabState('group', 'controller', { viewMode: 'cli' })
    const toChat = patchTabState('group', 'controller', { viewMode: 'visual' })
    // router.dispatch opens two coworkers through the main-process path (use-agent-control tabs.open).
    session = addTab(session, 'group', agentTab('coworker-1'))
    session = addTab(session, 'group', agentTab('coworker-2'))
    // The owner clicks CLI, then Chat; the stale callbacks fire from their mount-time closures.
    session = applyLayoutUpdate(session, toCli)
    expect(tabIds(session)).toEqual(['controller', 'coworker-1', 'coworker-2'])
    expect(listGroups(session.root)[0]!.tabs[0]!.state?.viewMode).toBe('cli')
    session = applyLayoutUpdate(session, toChat)
    expect(tabIds(session)).toEqual(['controller', 'coworker-1', 'coworker-2'])
    expect(listGroups(session.root)[0]!.tabs[0]!.state?.viewMode).toBe('visual')
    // The active tab chosen meanwhile is not reset either.
    expect(listGroups(session.root)[0]!.activeTabId).toBe('coworker-2')
  })
})

it('merges a delayed repair while preserving newer tabs, selection, closes and moved resources', () => {
  const saved = addTab(addTab(addTab(controllerOnly(), 'group', agentTab('lost')), 'group', agentTab('closed')), 'group', agentTab('moved'))
  const newer = { ...agentTab('newer-id'), resourceId: 'agent-moved' }
  const latest = addTab(addTab(controllerOnly(), 'group', newer), 'group', agentTab('opened-since'))
  const restored = restoreTabs(latest, saved, ['lost', 'closed', 'moved'], [agentTab('closed')])
  expect(tabIds(restored)).toEqual(['controller', 'newer-id', 'opened-since', 'lost'])
  expect(listGroups(restored.root)[0]!.activeTabId).toBe('opened-since')
  expect(restoreTabs(restored, saved, ['lost', 'closed', 'moved'], [agentTab('closed')])).toBe(restored)
})
