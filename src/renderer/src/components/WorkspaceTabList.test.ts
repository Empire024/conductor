import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentActivityPhase, SessionRecord } from '../../../shared/models'
import { createDefaultLayout } from '../../../shared/models'
import type { AgentControlLink } from '../../../shared/agent-control'
import { tabControlRole, tabRoleLabel, WorkspaceTabList, WorkspaceTabToggle } from './WorkspaceTabList'

const makeSession = (): SessionRecord => {
  const layout = createDefaultLayout()
  if (layout.root.type !== 'group') throw new Error('Expected a tab group')
  layout.root.tabs[0] = { id: 'agent-tab', kind: 'agent', title: 'Codex', resourceId: 'agent-resource' }
  layout.root.tabs.push({ id: 'terminal-tab', kind: 'terminal', title: 'Terminal' })
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

const render = (activityPhases: ReadonlyMap<string, AgentActivityPhase>): string =>
  renderToStaticMarkup(createElement(WorkspaceTabList, { session: makeSession(), active: true, expanded: true, activityPhases, onAction: vi.fn(), onGroupAction: vi.fn() }))

describe('workspace tab disclosure', () => {
  const toggle = (expanded: boolean): string => renderToStaticMarkup(createElement(WorkspaceTabToggle, { expanded, name: 'Workspace 1', onToggle: vi.fn() }))
  it('is a chevron alone, with no tab-count text', () => {
    expect(toggle(true)).toMatch(/class="workspace-tab-toggle" aria-expanded="true" aria-label="Hide tabs in Workspace 1"/)
    expect(toggle(false)).toMatch(/aria-expanded="false" aria-label="List tabs in Workspace 1"/)
    expect(toggle(true)).not.toMatch(/\d+\s*tabs?</)
  })
  // It sits in the workspace row beside the name, so the list itself must never draw a second one.
  it('is never rendered by the tab list it governs', () => {
    expect(render(new Map())).not.toContain('workspace-tab-toggle')
  })
  it('renders no tab rows while collapsed', () => {
    const collapsed = renderToStaticMarkup(createElement(WorkspaceTabList, { session: makeSession(), active: true, expanded: false, activityPhases: new Map(), onAction: vi.fn(), onGroupAction: vi.fn() }))
    expect(collapsed).not.toContain('workspace-tab-row')
    expect(render(new Map())).toContain('workspace-tab-row')
  })
})

describe('WorkspaceTabList activity indicator', () => {
  it('shows the same tab-activity badge an open pane tab shows, for the matching phase', () => {
    const html = render(new Map([['agent-resource', 'working']]))
    expect(html).toContain('class="tab-activity working"')
  })

  it('renders the attention bell when the agent is waiting on input', () => {
    const html = render(new Map([['agent-resource', 'waiting_input']]))
    expect(html).toContain('class="tab-activity waiting_input"')
    expect(html).toContain('Codex: Needs your attention')
  })

  it('defaults an agent tab with no known phase to idle', () => {
    const html = render(new Map())
    expect(html).toContain('class="tab-activity idle"')
  })

  it('never shows an activity badge on a non-agent tab', () => {
    const html = render(new Map([['agent-resource', 'working']]))
    expect(html.match(/tab-activity/g)).toHaveLength(1)
    expect(html).toContain('Terminal')
  })
})

describe('persistent main/coworker roles', () => {
  const links: AgentControlLink[] = [
    { projectId: 'project-1', sessionId: 'workspace-1', controllerAgentSessionId: 'main-agent', targetAgentSessionId: 'worker-a', controllerTabId: 'main-tab', controlledTabId: 'worker-tab-a' },
    { projectId: 'project-1', sessionId: 'workspace-1', controllerAgentSessionId: 'main-agent', targetAgentSessionId: 'worker-b', controllerTabId: 'main-tab', controlledTabId: 'worker-tab-b' }
  ]
  it('identifies one main tab by the coworkers it controls', () => {
    expect(tabControlRole('main-tab', links)).toMatchObject({ controlledBy: undefined, controlling: [links[0], links[1]] })
  })
  it('identifies each coworker by its actual controller relationship', () => {
    expect(tabControlRole('worker-tab-a', links)).toMatchObject({ controlledBy: links[0], controlling: [] })
  })
  it('uses one compact persistent label when a coworker also coordinates children', () => {
    expect(tabRoleLabel({ controlledBy: links[0], controlling: [links[1]!] })).toBe('Coworker · Main')
    expect(tabRoleLabel({ controlledBy: links[0], controlling: [] })).toBe('Coworker')
    expect(tabRoleLabel({ controlledBy: undefined, controlling: links })).toBe('Main')
  })
})
