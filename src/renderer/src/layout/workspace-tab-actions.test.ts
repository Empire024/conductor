import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '../../../shared/models'
import { createDefaultLayout } from '../../../shared/models'
import { addTab, listGroups } from './layout-operations'
import { applyWorkspaceTabAction } from './workspace-tab-actions'

function fixture(): SessionRecord {
  const layout = createDefaultLayout()
  return { id: 'inactive-workspace', projectId: 'project', name: 'Background', layout: addTab(layout, layout.root.id, { id: 'target', kind: 'agent', title: 'Target', resourceId: 'runtime', state: { provider: 'codex' } }), maximizedGroupId: null, closedTabs: [], continueOnLimit: true, createdAt: '', updatedAt: '' }
}

describe('workspace tab commands', () => {
  it('closes and retrieves the requested tab without mutating the source session', () => {
    const session = fixture(), group = listGroups(session.layout.root)[0]!
    const original = structuredClone(session)
    const closed = applyWorkspaceTabAction(session, group.id, 'target', 'close').session
    expect(listGroups(closed.layout.root)[0]!.tabs.some(tab => tab.id === 'target')).toBe(false)
    expect(closed.closedTabs.map(tab => tab.id)).toEqual(['target'])
    const restored = applyWorkspaceTabAction(closed, group.id, group.tabs[0]!.id, 'reopen').session
    expect(listGroups(restored.layout.root)[0]!.activeTabId).toBe('target')
    expect(restored.closedTabs).toEqual([])
    expect(session).toEqual(original)
  })
  it('detaches without adding a duplicate to the closed-tab history', () => {
    const session = fixture()
    const result = applyWorkspaceTabAction(session, session.layout.root.id, 'target', 'show')
    expect(result.session.closedTabs).toEqual([])
    expect(listGroups(result.session.layout.root).flatMap(group => group.tabs).find(tab => tab.id === 'target')).toBeUndefined()
  })
  it('focuses an inactive tab and clears a maximized group hiding it', () => {
    const session = fixture(), group = listGroups(session.layout.root)[0]!
    session.maximizedGroupId = 'other-group'
    const result = applyWorkspaceTabAction(session, group.id, group.tabs[0]!.id, 'focus')
    expect(listGroups(result.session.layout.root)[0]!.activeTabId).toBe(group.tabs[0]!.id)
    expect(result.session.maximizedGroupId).toBeNull()
  })
  it('uses inherited continuation and gives duplicates separate runtime identities', () => {
    const session = fixture()
    const toggled = applyWorkspaceTabAction(session, session.layout.root.id, 'target', 'continuation').session
    expect(listGroups(toggled.layout.root)[0]!.tabs.find(tab => tab.id === 'target')!.state?.continueOnLimit).toBe(false)
    const duplicated = applyWorkspaceTabAction(session, session.layout.root.id, 'target', 'duplicate').session
    const copy = listGroups(duplicated.layout.root)[0]!.tabs.at(-1)!
    expect(copy.id).not.toBe('target'); expect(copy.resourceId).not.toBe('runtime')
  })
})
