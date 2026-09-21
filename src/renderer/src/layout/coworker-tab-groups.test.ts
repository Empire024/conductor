import { describe, expect, it } from 'vitest'
import type { AgentControlLink } from '../../../shared/agent-control'
import type { PaneTab } from '../../../shared/models'
import { coworkerTabGroups } from './coworker-tab-groups'

const tab = (id: string, tabGroupId?: string): PaneTab => ({ id, kind: 'agent', title: id, resourceId: `${id}-agent`, ...(tabGroupId ? { tabGroupId } : {}) })
const link = (controllerTabId: string, controlledTabId: string): AgentControlLink => ({ projectId: 'p', sessionId: 's', controllerAgentSessionId: `${controllerTabId}-agent`, targetAgentSessionId: `${controlledTabId}-agent`, controllerTabId, controlledTabId })

describe('coworkerTabGroups', () => {
  it('collects nested coworkers under the root without changing their stable order', () => {
    const result = coworkerTabGroups([tab('child'), tab('main'), tab('grandchild')], [link('main', 'child'), link('child', 'grandchild')])
    expect(result.groups).toEqual([{ controller: tab('main'), coworkers: [tab('child'), tab('grandchild')], insertionTabId: 'child' }])
  })

  it('leaves manual groups and links with missing endpoints standalone', () => {
    const grouped = tab('child', 'manual')
    const result = coworkerTabGroups([tab('main'), grouped, tab('local')], [link('main', 'child'), link('missing', 'local')])
    expect(result.groups).toEqual([])
    expect(result.groupByTabId.size).toBe(0)
  })

  it('does not manufacture a hierarchy from cyclic links', () => {
    const result = coworkerTabGroups([tab('a'), tab('b')], [link('a', 'b'), link('b', 'a')])
    expect(result.groups).toEqual([])
  })
})
