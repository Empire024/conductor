import { describe, expect, it } from 'vitest'
import type { AgentControlLink } from './agent-control'
import type { AgentActivityPhase, PaneTab } from './models'
import { buildWorkspaceClarity, clarityStatus, distinctTabLabels, finishedCloseRefusal, finishedTabSweepHours, handedOffIn, statusLabel, stripRank, type AgentTabFacts } from './workspace-clarity'

const HOUR = 3_600_000
const at = (hoursAgo: number): string => new Date(Date.parse('2026-09-28T12:00:00Z') - hoursAgo * HOUR).toISOString()
const agent = (id: string, title = id, state: Record<string, unknown> = {}): PaneTab => ({ id, kind: 'agent', title, resourceId: 'agent_' + id, state: { provider: 'claude', ...state } })
const link = (controller: string, coworker: string): AgentControlLink => ({ projectId: 'p', sessionId: 's', controllerAgentSessionId: 'agent_' + controller, targetAgentSessionId: 'agent_' + coworker, controllerTabId: controller, controlledTabId: coworker })

/** The owner's 2026-09-28 workspace in miniature: a live wizard with two running coworkers,
 *  a failed old wizard that still holds a link, finished coworkers and an owner file tab. */
function ownerWorkspace(finishedCount = 20) {
  const finished = Array.from({ length: finishedCount }, (_, index) => agent('done' + index, 'Conductor coworker ' + index))
  const tabs: PaneTab[] = [
    agent('old', 'Conductor orchestrator (old)'), ...finished, agent('wiz', 'Conductor orchestrator'),
    agent('run1', 'Coworker one'), agent('run2', 'Coworker two'), { id: 'file', kind: 'code', title: 'notes.md' }
  ]
  const phases = new Map<string, AgentActivityPhase>([['agent_old', 'failed'], ['agent_wiz', 'complete'], ['agent_run1', 'working'], ['agent_run2', 'waiting_input'], ...finished.map((tab, index) => [tab.resourceId!, index % 5 === 0 ? 'failed' : 'complete'] as [string, AgentActivityPhase])])
  const facts: Record<string, AgentTabFacts> = {
    agent_old: { wizard: true, handedOff: false, settledAt: at(30) },
    agent_wiz: { wizard: true, handedOff: false, settledAt: at(0.1) },
    agent_run1: { wizard: false, handedOff: false }, agent_run2: { wizard: false, handedOff: false },
    ...Object.fromEntries(finished.map((tab, index) => [tab.resourceId!, { wizard: false, handedOff: false, settledAt: at(index + 1) }]))
  }
  const links = [link('wiz', 'run1'), link('wiz', 'run2'), link('old', 'done0'), link('wiz', 'done1')]
  return { tabs, phases, facts, links, input: { panes: [{ groupId: 'g', tabs, activeTabId: 'wiz' }], links, phases, facts } }
}

describe('clarityStatus', () => {
  it('reads live, waiting, finished and handed-off agent tabs; other tabs are open', () => {
    expect(clarityStatus({ kind: 'agent' }, 'working', undefined)).toBe('running')
    expect(clarityStatus({ kind: 'agent' }, 'limited', undefined)).toBe('running')
    expect(clarityStatus({ kind: 'agent' }, 'waiting_background', undefined)).toBe('running')
    expect(clarityStatus({ kind: 'agent' }, 'waiting_input', undefined)).toBe('waiting')
    expect(clarityStatus({ kind: 'agent' }, 'complete', undefined)).toBe('done')
    expect(clarityStatus({ kind: 'agent' }, 'disconnected', undefined)).toBe('failed')
    expect(clarityStatus({ kind: 'agent' }, 'stopped', undefined)).toBe('stopped')
    expect(clarityStatus({ kind: 'agent' }, 'complete', { wizard: false, handedOff: true })).toBe('handed-off')
    // A handed-off tab finishing its last step is still running.
    expect(clarityStatus({ kind: 'agent' }, 'working', { wizard: false, handedOff: true })).toBe('running')
    expect(clarityStatus({ kind: 'agent' }, 'idle', { wizard: false, handedOff: false, settledAt: at(1) })).toBe('done')
    expect(clarityStatus({ kind: 'agent' }, 'idle', { wizard: false, handedOff: false })).toBe('open')
    expect(clarityStatus({ kind: 'code' }, 'complete', undefined)).toBe('open')
  })
})

describe('buildWorkspaceClarity', () => {
  it('puts the live wizard first with its live coworkers nested, and everything finished in Done', () => {
    const clarity = buildWorkspaceClarity(ownerWorkspace().input)
    expect(clarity.mainTabId).toBe('wiz')
    expect(clarity.live.map(row => [row.tab.id, row.depth, row.role ?? null, row.status])).toEqual([
      ['wiz', 0, 'main', 'done'],
      // Waiting on the owner outranks running.
      ['run2', 1, 'coworker', 'waiting'],
      ['run1', 1, 'coworker', 'running'],
      ['file', 0, null, 'open']
    ])
    expect(clarity.done).toHaveLength(21)
    expect(clarity.done.some(row => row.role === 'main')).toBe(false)
  })

  it('has exactly one MAIN: a failed predecessor that still holds a link reads as ended in Done', () => {
    const clarity = buildWorkspaceClarity(ownerWorkspace().input)
    const roles = [...clarity.live, ...clarity.done].filter(row => row.role === 'main')
    expect(roles.map(row => row.tab.id)).toEqual(['wiz'])
    const old = clarity.done.find(row => row.tab.id === 'old')!
    expect(statusLabel(old)).toBe('ended')
    expect(statusLabel(clarity.done.find(row => row.tab.id === 'done5')!)).toBe('failed')
    expect(statusLabel(clarity.done.find(row => row.tab.id === 'done2')!)).toBe('')
  })

  it('orders Done newest first', () => {
    const settled = buildWorkspaceClarity(ownerWorkspace().input).done.map(row => row.settledAt ?? 0)
    expect(settled).toEqual([...settled].sort((a, b) => b - a))
  })

  it('reads a handed-off wizard as handed off and hands MAIN to its successor', () => {
    const { input } = ownerWorkspace(0)
    const facts = { ...input.facts, agent_old: { wizard: false, handedOff: true, settledAt: at(2) } }
    const clarity = buildWorkspaceClarity({ ...input, facts, phases: new Map([...input.phases, ['agent_old', 'complete']]) })
    expect(clarity.mainTabId).toBe('wiz')
    expect(statusLabel(clarity.done.find(row => row.tab.id === 'old')!)).toBe('handed off')
  })

  it('without a wizard, the controller with live coworkers is MAIN, even between its turns', () => {
    const { input } = ownerWorkspace(2)
    const facts = Object.fromEntries(Object.entries(input.facts).map(([id, value]) => [id, { ...value, wizard: false }]))
    const clarity = buildWorkspaceClarity({ ...input, facts })
    expect(clarity.mainTabId).toBe('wiz')
    expect(clarity.live[0]!.tab.id).toBe('wiz')
  })

  it('keeps a pinned finished tab live and never hides it', () => {
    const { input, tabs } = ownerWorkspace(1)
    const pinned = tabs.map(tab => tab.id === 'done0' ? { ...tab, state: { ...tab.state, pinned: true } } : tab)
    const clarity = buildWorkspaceClarity({ ...input, panes: [{ groupId: 'g', tabs: pinned, activeTabId: 'wiz' }] })
    expect(clarity.live.map(row => row.tab.id)).toContain('done0')
    expect(clarity.hiddenFromStrip.has('done0')).toBe(false)
  })

  it('hides finished tabs the owner has not looked at since they finished, never the one on screen', () => {
    const { input, tabs } = ownerWorkspace(3)
    const seen = tabs.map(tab => tab.id === 'done0' ? { ...tab, state: { ...tab.state, seenAt: at(0.5) } } : tab.id === 'done1' ? { ...tab, state: { ...tab.state, seenAt: at(5) } } : tab)
    const clarity = buildWorkspaceClarity({ ...input, panes: [{ groupId: 'g', tabs: seen, activeTabId: 'done2' }] })
    // done0 settled 1 h ago and was seen 30 min ago: stays. done1 settled 2 h ago, seen 5 h ago: hidden.
    expect(clarity.hiddenFromStrip.has('done0')).toBe(false)
    expect(clarity.hiddenFromStrip.has('done1')).toBe(true)
    expect(clarity.hiddenFromStrip.has('done2')).toBe(false)
    expect(clarity.hiddenFromStrip.has('old')).toBe(true)
    for (const live of ['wiz', 'run1', 'run2', 'file']) expect(clarity.hiddenFromStrip.has(live)).toBe(false)
  })

  it('does not hide a tab that just finished until main reports when it settled', () => {
    const { input } = ownerWorkspace(0)
    const clarity = buildWorkspaceClarity({ ...input, phases: new Map([...input.phases, ['agent_run1', 'complete']]) })
    expect(clarity.hiddenFromStrip.has('run1')).toBe(false)
    expect(clarity.done.map(row => row.tab.id)).toContain('run1')
  })
})

describe('stripRank', () => {
  it('puts the MAIN first, then its live coworkers, then the rest where they stood', () => {
    const { input, tabs } = ownerWorkspace(2)
    const clarity = buildWorkspaceClarity(input)
    expect(stripRank(tabs.map(tab => tab.id), clarity)).toEqual(['wiz', 'run1', 'run2', 'old', 'done0', 'done1', 'file'])
  })
})

describe('distinctTabLabels', () => {
  it('drops a leading run of words every title shares', () => {
    expect(distinctTabLabels(['Conductor continuation (continued)', 'Conductor continuation fix sidebar', 'Conductor continuation'])).toEqual(['…continuation (continued)', '…continuation fix sidebar', '…continuation'])
    expect(distinctTabLabels(['Claude Opus: sidebar', 'Claude Opus: sweep'])).toEqual(['…sidebar', '…sweep'])
    expect(distinctTabLabels(['Alpha', 'Beta'])).toEqual(['Alpha', 'Beta'])
    expect(distinctTabLabels(['Only one'])).toEqual(['Only one'])
    // Only titles that start alike are compared with each other.
    expect(distinctTabLabels(['Claude Opus: sidebar', 'notes.md', 'Claude Opus: sweep'])).toEqual(['…sidebar', 'notes.md', '…sweep'])
  })
})

describe('handedOffIn', () => {
  it('finds the succession notice', () => {
    const notice = (payload: unknown) => ({ id: 'i', sequence: 1, timestamp: at(0), data: { type: 'notice', message: 'm', payload } }) as never
    expect(handedOffIn([notice({ succession: { agentSessionId: 'a', title: 't' } })])).toBe(true)
    expect(handedOffIn([notice({ other: 1 })])).toBe(false)
  })
})

describe('finishedCloseRefusal and the sweep age', () => {
  const base = { finished: true, pinned: false, wizard: false, controlsLiveCoworkers: false, remote: false, busy: null }
  const now = Date.parse(at(0))
  it('the owner button closes any finished, unprotected tab', () => {
    expect(finishedCloseRefusal(base)).toBeNull()
    expect(finishedCloseRefusal({ ...base, busy: 'its turn is still running' })).toBe('its turn is still running')
    expect(finishedCloseRefusal({ ...base, finished: false })).toBe('it is not finished')
    expect(finishedCloseRefusal({ ...base, pinned: true })).toBe('it is pinned')
    expect(finishedCloseRefusal({ ...base, wizard: true })).toBe('it is the live wizard')
    expect(finishedCloseRefusal({ ...base, controlsLiveCoworkers: true })).toBe('it still controls open coworkers')
  })
  it('the sweep also needs the tab settled and unseen for the age, and off screen', () => {
    const aged = { active: false, settledAt: now - 25 * HOUR, now, ageMs: 24 * HOUR }
    expect(finishedCloseRefusal(base, aged)).toBeNull()
    expect(finishedCloseRefusal(base, { ...aged, active: true })).toBe('it is the tab on screen in its pane')
    expect(finishedCloseRefusal(base, { ...aged, settledAt: now - 2 * HOUR })).toBe('it finished too recently')
    expect(finishedCloseRefusal(base, { ...aged, settledAt: undefined })).toBe('it finished too recently')
    expect(finishedCloseRefusal(base, { ...aged, seenAt: now - HOUR })).toBe('you looked at it recently')
  })
  it('defaults to one day and accepts only the offered choices', () => {
    expect(finishedTabSweepHours(() => null)).toBe(24)
    expect(finishedTabSweepHours(() => '0')).toBe(0)
    expect(finishedTabSweepHours(() => '5')).toBe(24)
  })
})

describe('distinctTabLabels, word by word', () => {
  it('drops every word a group shares, one level at a time', () => {
    expect(distinctTabLabels(['Conductor orchestrator (continued)', 'Conductor orchestrator', 'Conductor coworker: llama slots', 'Conductor coworker: qwen context', 'Coworker: sidebar grouping', 'Coworker: strip overflow', 'New tab']))
      .toEqual(['…orchestrator (continued)', '…orchestrator', '…llama slots', '…qwen context', '…sidebar grouping', '…strip overflow', 'New tab'])
  })
})
