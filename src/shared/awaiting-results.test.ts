import { describe, expect, it } from 'vitest'
import type { PaneTab } from './models'
import type { TimelineItem } from './structured-agent'
import { awaitingLabel, awaitingSentence, evaluateAwaiting, parseAwaitingRecord, type AwaitingFact, type AwaitingRecord } from './awaiting-results'
import { buildWorkspaceClarity, clarityStatus, finishedCloseRefusal, statusLabel, type AgentTabFacts } from './workspace-clarity'

const item = (sequence: number, from?: string, role: 'user' | 'assistant' = 'user'): TimelineItem => ({
  id: 'item' + sequence, runtimeId: 'r', sequence, timestamp: '2026-09-29T09:00:00.000Z',
  data: { type: 'text', role, text: 'x', mode: 'snapshot', ...(from ? { origin: { agentSessionId: from, label: from } } : {}) }
} as TimelineItem)
const record = (agents: string[], sinceSequence = 10): AwaitingRecord => ({ agents, since: '2026-09-29T09:00:00.000Z', sinceSequence })
const lookup = (open: Record<string, string>, successors: Record<string, string[]> = {}) => ({ open: (id: string) => open[id], successors: (id: string) => successors[id] ?? [] })

describe('evaluateAwaiting', () => {
  it('owes each awaited conversation until its own message arrives after the declaration', () => {
    const open = lookup({ a: 'Fixer A', b: 'Fixer B' })
    expect(evaluateAwaiting(record(['a', 'b']), { items: [] }, open)).toEqual({ owed: ['a', 'b'], open: [{ agentSessionId: 'a', title: 'Fixer A' }, { agentSessionId: 'b', title: 'Fixer B' }] })
    // Older than the declaration, from the owner (no origin), or an assistant line: not an arrival.
    const noise = [item(5, 'a'), item(11), item(12, 'a', 'assistant')]
    expect(evaluateAwaiting(record(['a', 'b']), { items: noise }, open).owed).toEqual(['a', 'b'])
    expect(evaluateAwaiting(record(['a', 'b']), { items: [...noise, item(13, 'a')] }, open).owed).toEqual(['b'])
    expect(evaluateAwaiting(record(['a', 'b']), { items: [item(13, 'a'), item(14, 'b')] }, open).owed).toEqual([])
  })

  it('counts a successor’s message and waits on the open successor; a closed awaited tab is not waited for', () => {
    const chain = lookup({ a2: 'Fixer A (continued)' }, { a: ['a2'] })
    expect(evaluateAwaiting(record(['a']), { items: [] }, chain)).toEqual({ owed: ['a'], open: [{ agentSessionId: 'a2', title: 'Fixer A (continued)' }] })
    expect(evaluateAwaiting(record(['a']), { items: [item(11, 'a2')] }, chain).owed).toEqual([])
    expect(evaluateAwaiting(record(['gone']), { items: [] }, lookup({}))).toEqual({ owed: ['gone'], open: [] })
  })

  it('parses only well-formed records', () => {
    expect(parseAwaitingRecord(JSON.stringify(record(['a'])))).toEqual(record(['a']))
    expect(parseAwaitingRecord('{"agents":"a"}')).toBeNull()
    expect(parseAwaitingRecord('not json')).toBeNull()
    expect(parseAwaitingRecord(null)).toBeNull()
  })

  it('labels whom it waits for', () => {
    const fact: AwaitingFact = { agents: [{ agentSessionId: 'a', title: 'Fixer A' }, { agentSessionId: 'b', title: 'Fixer B' }, { agentSessionId: 'c', title: 'Fixer C' }], reason: 'fix commits', since: '' }
    expect(awaitingLabel(fact)).toBe('waiting for Fixer A, Fixer B +1')
    expect(awaitingSentence(fact)).toBe('Waiting for results from Fixer A (a), Fixer B (b), Fixer C (c): fix commits. It wakes when they message it.')
  })
})

describe('workspace clarity with a waiting tab', () => {
  const awaiting: AwaitingFact = { agents: [{ agentSessionId: 'agent_fixer', title: 'Fixer' }], since: '2026-09-29T09:00:00.000Z' }
  const agent = (id: string): PaneTab => ({ id, kind: 'agent', title: id, resourceId: 'agent_' + id, state: { provider: 'codex' } })

  it('a settled tab that declared a wait is live and labelled; the owner’s stop still ends it', () => {
    const facts: AgentTabFacts = { wizard: false, handedOff: false, settledAt: '2026-09-29T09:00:00.000Z', awaiting }
    expect(clarityStatus({ kind: 'agent' }, 'complete', facts)).toBe('awaiting')
    expect(clarityStatus({ kind: 'agent' }, 'failed', facts)).toBe('awaiting')
    expect(clarityStatus({ kind: 'agent' }, 'working', facts)).toBe('running')
    expect(clarityStatus({ kind: 'agent' }, 'stopped', facts)).toBe('stopped')
    expect(clarityStatus({ kind: 'agent' }, 'complete', { ...facts, handedOff: true })).toBe('handed-off')
    expect(statusLabel({ status: 'awaiting', awaiting })).toBe('waiting for Fixer')
  })

  it('keeps the reviewer in the live group while a plain completed tab and a superseded one go to Done', () => {
    const tabs = [agent('reviewer'), agent('fixer'), agent('plain'), agent('old')]
    const settled = '2026-09-29T08:00:00.000Z'
    const clarity = buildWorkspaceClarity({
      panes: [{ groupId: 'g', tabs, activeTabId: 'fixer' }], links: [],
      phases: new Map([['agent_reviewer', 'complete'], ['agent_fixer', 'working'], ['agent_plain', 'complete'], ['agent_old', 'complete']]),
      facts: {
        agent_reviewer: { wizard: false, handedOff: false, settledAt: settled, awaiting },
        agent_fixer: { wizard: false, handedOff: false },
        agent_plain: { wizard: false, handedOff: false, settledAt: settled },
        // Superseded: main does not report a wait for it (AwaitingResults.fact), so it is done work.
        agent_old: { wizard: false, handedOff: false, settledAt: settled }
      }
    })
    expect(clarity.live.map(row => [row.tab.id, row.status])).toEqual([['fixer', 'running'], ['reviewer', 'awaiting']])
    expect(clarity.live.find(row => row.tab.id === 'reviewer')!.awaiting).toEqual(awaiting)
    expect(clarity.done.map(row => row.tab.id).sort()).toEqual(['old', 'plain'])
    expect(clarity.hiddenFromStrip.has('reviewer')).toBe(false)
  })

  it('the close rules keep a waiting tab and say why', () => {
    const base = { finished: true, pinned: false, wizard: false, controlsLiveCoworkers: false, remote: false, busy: null }
    expect(finishedCloseRefusal(base)).toBeNull()
    expect(finishedCloseRefusal({ ...base, awaiting: 'it is waiting for results from Fixer (agent_fixer)' })).toBe('it is waiting for results from Fixer (agent_fixer)')
  })
})
