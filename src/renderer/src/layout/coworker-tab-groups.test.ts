import { describe, expect, it } from 'vitest'
import type { AgentControlLink } from '../../../shared/agent-control'
import type { PaneTab } from '../../../shared/models'
import { coworkerCloseTargets, coworkerTabGroups } from './coworker-tab-groups'

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

describe('coworkerCloseTargets', () => {
  it('closing a controller targets the controller and every coworker', () => {
    const tabs = [tab('child'), tab('main'), tab('grandchild')]
    const presentation = coworkerTabGroups(tabs, [link('main', 'child'), link('child', 'grandchild')])
    expect(coworkerCloseTargets(tab('main'), presentation)).toEqual([tab('main'), tab('child'), tab('grandchild')])
  })

  it('closing a coworker, or a tab outside any group, targets only that one tab', () => {
    const tabs = [tab('child'), tab('main')]
    const presentation = coworkerTabGroups(tabs, [link('main', 'child')])
    expect(coworkerCloseTargets(tab('child'), presentation)).toEqual([tab('child')])
    expect(coworkerCloseTargets(tab('lone'), presentation)).toEqual([tab('lone')])
  })
})
