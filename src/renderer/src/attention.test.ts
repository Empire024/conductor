import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '../../shared/models'
import { createDefaultLayout } from '../../shared/models'
import { closeTab } from './layout/layout-operations'
import { getAttentionSessionIds, retainVisibleAttentionResources } from './attention'

const makeSession = (): SessionRecord => {
  const layout = createDefaultLayout()
  if (layout.root.type !== 'group') throw new Error('Expected a tab group')
  layout.root.tabs[0] = {
    id: 'agent-tab',
    kind: 'agent',
    title: 'Codex',
    resourceId: 'agent-resource'
  }
  layout.root.activeTabId = 'agent-tab'
  return {
    id: 'workspace-1',
    projectId: 'project-1',
    name: 'Workspace 1',
    layout,
    maximizedGroupId: null,
    closedTabs: [],
    continueOnLimit: false,
    createdAt: '',
    updatedAt: ''
  }
}

describe('workspace attention', () => {
  it('drops an alert as soon as its originating tab is closed', () => {
    const session = makeSession()
    const attention = new Set(['agent-resource'])

    expect([...getAttentionSessionIds([session], attention)]).toEqual(['workspace-1'])
    const result = closeTab(session.layout, session.layout.root.id, 'agent-tab')
    const closedSession = { ...session, layout: result.layout }

    expect([...getAttentionSessionIds([closedSession], attention)]).toEqual([])
    expect([...retainVisibleAttentionResources([closedSession], attention)]).toEqual([])
  })
})
