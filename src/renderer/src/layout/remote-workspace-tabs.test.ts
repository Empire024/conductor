import { describe, expect, it } from 'vitest'
import { createDefaultLayout, type PaneGroupNode } from '../../../shared/models'
import type { RemoteAttachedTab, RemoteWorkspaceTab } from '../../../shared/remote-control'
import { conversationsToOpen, placeAttachedTabs } from './remote-workspace-tabs'

const tab = (id: string, localSessionId?: string): RemoteWorkspaceTab => ({
  tabId: 'tab-' + id, agentSessionId: id, title: 'Conversation ' + id, provider: 'claude', ...(localSessionId ? { localSessionId } : {})
})
const attached = (localSessionId: string, existingWorkspaceId?: string): RemoteAttachedTab => ({
  localSessionId, machineId: 'main', machineName: 'MAIN', title: 'Title ' + localSessionId, provider: 'codex',
  ...(existingWorkspaceId ? { existingWorkspaceId } : {})
})

describe('showing the host\'s conversations in a workspace here', () => {
  it('opens every conversation of a host workspace except the ones already shown here', () => {
    expect(conversationsToOpen('their-workspace', [tab('a'), tab('b', 'local-b'), tab('c')])).toEqual([
      { remoteSessionId: 'their-workspace', tab: tab('a') },
      { remoteSessionId: 'their-workspace', tab: tab('c') }
    ])
  })

  it('puts the first in the launcher\'s place and the rest beside it, as mirrored tabs of that machine', () => {
    const layout = createDefaultLayout()
    const group = layout.root as PaneGroupNode
    const launcher = group.tabs[0]!.id
    const placed = placeAttachedTabs(layout, group.id, launcher, 'workspace', [attached('one'), attached('two')])
    const tabs = (placed.layout.root as PaneGroupNode).tabs
    expect(tabs.map(entry => entry.kind)).toEqual(['agent', 'agent'])
    expect(tabs.map(entry => entry.resourceId)).toEqual(['one', 'two'])
    expect(tabs[0]).toMatchObject({ title: 'Title one · MAIN', state: { provider: 'codex', machineId: 'main' } })
    expect((placed.layout.root as PaneGroupNode).activeTabId).toBe(tabs[1]!.id)
    expect(placed.elsewhere).toEqual([])
  })

  it('selects a conversation already shown instead of opening it twice, and never moves one from another workspace', () => {
    const layout = createDefaultLayout()
    const group = layout.root as PaneGroupNode
    const first = placeAttachedTabs(layout, group.id, group.tabs[0]!.id, 'workspace', [attached('one'), attached('two')])
    const again = placeAttachedTabs(first.layout, group.id, null, 'workspace', [attached('one', 'workspace'), attached('three', 'other-workspace')])
    const tabs = (again.layout.root as PaneGroupNode).tabs
    expect(tabs.map(entry => entry.resourceId)).toEqual(['one', 'two'])
    expect((again.layout.root as PaneGroupNode).activeTabId).toBe(tabs[0]!.id)
    expect(again.elsewhere).toEqual(['Title three'])
  })
})
