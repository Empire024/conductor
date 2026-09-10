import { describe, expect, it } from 'vitest'
import { createDefaultLayout, makeLauncherTab } from '../../../shared/models'
import { addTab, listGroups, splitGroup } from './layout-operations'
import { browserTabOpen, toggleBrowserTab } from './browser-tab'

describe('toggleBrowserTab', () => {
  it('creates a browser tab in the focused group when the workspace has none', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const result = toggleBrowserTab(layout, groupId)
    const group = listGroups(result.layout.root).find(item => item.id === groupId)!
    const tab = group.tabs.find(item => item.kind === 'browser')
    expect(tab).toBeDefined()
    expect(group.activeTabId).toBe(tab!.id)
    expect(result.focusedGroupId).toBe(groupId)
    expect(result.maximizedGroupId).toBeNull()
    expect(browserTabOpen(result.layout)).toBe(true)
  })

  it('closes the browser tab on a second toggle once it is showing', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const opened = toggleBrowserTab(layout, groupId)
    const closed = toggleBrowserTab(opened.layout, opened.focusedGroupId)
    expect(browserTabOpen(closed.layout)).toBe(false)
    expect(listGroups(closed.layout.root).flatMap(group => group.tabs).some(tab => tab.kind === 'browser')).toBe(false)
    expect(closed.closedTab?.kind).toBe('browser')
  })

  it('focuses an existing browser tab instead of creating a second one when it is not the active tab', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const opened = toggleBrowserTab(layout, groupId)
    // Switch away to another tab in the same group, as if the owner clicked a sibling tab.
    const switched = addTab(opened.layout, groupId, makeLauncherTab())
    expect(browserTabOpen(switched)).toBe(false)

    const refocused = toggleBrowserTab(switched, groupId)
    const group = listGroups(refocused.layout.root).find(item => item.id === groupId)!
    const browserTabs = group.tabs.filter(tab => tab.kind === 'browser')
    expect(browserTabs).toHaveLength(1)
    expect(group.activeTabId).toBe(browserTabs[0]!.id)
    expect(browserTabOpen(refocused.layout)).toBe(true)
  })

  it('finds and focuses a browser tab that lives in a different group than the one asked to receive a new tab', () => {
    const layout = createDefaultLayout()
    const rootId = layout.root.id
    const split = splitGroup(layout, rootId, 'right', makeLauncherTab())
    const [left, right] = listGroups(split.root)
    // Add the browser tab, then a sibling tab that steals activation - a browser tab that
    // exists but sits behind another tab in its own group, the way a real workspace would end
    // up after the owner switched to a different tab without closing the browser one.
    const withBrowser = addTab(split, right!.id, { id: 'existing-browser', kind: 'browser', title: 'Browser' })
    const backgrounded = addTab(withBrowser, right!.id, makeLauncherTab())

    const result = toggleBrowserTab(backgrounded, left!.id)
    expect(result.focusedGroupId).toBe(right!.id)
    expect(result.maximizedGroupId).toBeNull()
    const group = listGroups(result.layout.root).find(item => item.id === right!.id)!
    expect(group.activeTabId).toBe('existing-browser')
    // No new tab was created in the group that was asked for.
    const leftGroup = listGroups(result.layout.root).find(item => item.id === left!.id)!
    expect(leftGroup.tabs.some(tab => tab.kind === 'browser')).toBe(false)
  })
})

describe('browserTabOpen', () => {
  it('is false when a browser tab exists but is not the active tab in its group', () => {
    const layout = createDefaultLayout()
    const groupId = layout.root.id
    const withBrowser = addTab(layout, groupId, { id: 'bg-browser', kind: 'browser', title: 'Browser' })
    const switchedAway = addTab(withBrowser, groupId, makeLauncherTab())
    expect(browserTabOpen(switchedAway)).toBe(false)
  })
})
