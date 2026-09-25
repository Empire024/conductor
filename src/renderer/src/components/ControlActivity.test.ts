import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { AppControlHistoryList, ControlActivityRow, ControlledByBadge, ControlledByNotice } from './ControlActivity'
import { StructuredActivity, isConversationActivity } from '../panes/StructuredAgentRenderers'
import type { ControlActivity } from '../../../shared/control-activity'
import type { TimelineItem } from '../../../shared/structured-agent'

// conductor-task:44a4ba26-0ec7-4d40-a1d9-c2634b3b7206
const at = '2026-09-25T10:00:00.000Z'
const activity: ControlActivity = {
  actions: [
    { method: 'tabs.open', kind: 'open', label: 'Opened FX9', at, target: { agentSessionId: 'fx9', tabId: 'tab-9', title: 'FX9' } },
    { method: 'agents.steer', kind: 'steer', label: 'Steered FX7', at, target: { agentSessionId: 'fx7', title: 'FX7' } },
    { method: 'git.ship', kind: 'ship', label: 'git.ship', at, runId: 'run', commit: '634b1fa99887766' },
    { method: 'app.update.install', kind: 'app', label: 'Installed the update', at, appWide: true },
    { method: 'agents.finish', kind: 'close', label: 'Finished FX3', at, failed: true, error: 'not yours' }
  ],
  reads: 12, readMethods: { 'agents.snapshot': 9, 'usage.limits': 3 }, dropped: 0
}
const notice = (payload: unknown): TimelineItem => ({ id: 'n', runtimeId: 'r', sequence: 1, timestamp: at, data: { type: 'notice', message: 'Used Conductor', payload } } as TimelineItem)

describe('control activity rendering', () => {
  it('draws one chip per action, a single read chip, and clickable tab and commit chips', () => {
    const html = renderToStaticMarkup(createElement(ControlActivityRow, { activity, onFocusAgent: () => {} }))
    expect(html).toContain('aria-label="Conductor app control used in this turn"')
    for (const text of ['Opened FX9', 'Steered FX7', 'git.ship → 634b1fa', 'Installed the update', 'Finished FX3', 'read 12 times']) expect(html).toContain(text)
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html).toContain('control-chip kind-app app-wide')
    expect(html).toContain('control-chip kind-close failed')
    expect(html).toContain('agents.snapshot ×9')
    // Without a way to focus a tab, only the commit stays a button.
    expect(renderToStaticMarkup(createElement(ControlActivityRow, { activity })).match(/<button/g)).toHaveLength(1)
  })

  it('names who drove a tab, in its timeline and on its tab entry', () => {
    const html = renderToStaticMarkup(createElement(ControlledByNotice, { driven: { agentSessionId: 'c', title: 'Swarm', verb: 'Opened', method: 'tabs.open', at }, onFocusAgent: () => {} }))
    expect(html).toContain('Opened by <button')
    expect(html).toContain('>Swarm</button>')
    expect(html).toContain('<small>tabs.open</small>')
    expect(renderToStaticMarkup(createElement(ControlledByBadge, { controllerTitle: 'Swarm' }))).toContain('<span>by Swarm</span>')
    const compact = renderToStaticMarkup(createElement(ControlledByBadge, { controllerTitle: 'Swarm', compact: true }))
    expect(compact).toContain('aria-label="Controlled by Swarm"')
    expect(compact).not.toContain('by Swarm</span>')
  })

  it('lists app-wide actions newest first', () => {
    const html = renderToStaticMarkup(createElement(AppControlHistoryList, { now: Date.parse(at) + 120_000, entries: [
      { method: 'app.update.install', label: 'Installed the update', at, by: { agentSessionId: 'c', title: 'Swarm' } },
      { method: 'app.restart', label: 'Restarted Conductor', at, by: { agentSessionId: null, title: 'the owner' } }
    ] }))
    expect(html.indexOf('Restarted Conductor')).toBeLessThan(html.indexOf('Installed the update'))
    expect(html).toContain('by the owner')
    expect(html).toContain('2m ago')
  })

  it('shows control notices in the conversation timeline, where other payload notices stay hidden', () => {
    const row = notice({ controlActivity: activity })
    const driven = notice({ controlledBy: { agentSessionId: 'c', title: 'Swarm', verb: 'Closed', method: 'tabs.close', at } })
    expect(isConversationActivity(row)).toBe(true)
    expect(isConversationActivity(driven)).toBe(true)
    expect(isConversationActivity(notice({ successionNudge: true }))).toBe(false)
    const props = { sessionId: 's', cwd: '', expanded: false, interactive: true, onExpand: () => {}, onOpenFile: () => {}, onDiff: () => {}, onRespond: async () => {} }
    expect(renderToStaticMarkup(createElement(StructuredActivity, { ...props, item: row }))).toContain('control-activity')
    expect(renderToStaticMarkup(createElement(StructuredActivity, { ...props, item: driven }))).toContain('Closed by')
  })
})
