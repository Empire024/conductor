import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivityPhase, DetachedWindowRecord, PaneTab, SessionRecord } from '../shared/models'
import type { SessionPhase, SessionProjection, TimelineItem } from '../shared/structured-agent'
import { PROVIDER_USAGE_LIMIT } from '../shared/structured-agent'
import { computeNeedsAttention, NeedsAttention, type AttentionAgentRow, type NeedsAttentionSources } from './needs-attention'

const AT = '2026-09-29T09:00:00.000Z'
const tab = (id: string, state: Record<string, unknown> = {}): PaneTab => ({ id: 'tab-' + id, kind: 'agent', title: 'Tab ' + id, resourceId: id, state: { provider: 'claude', ...state } })
const workspace = (id: string, projectId: string, tabs: PaneTab[], continueOnLimit = false): SessionRecord => ({ id, projectId, name: 'Workspace ' + id, layout: { version: 1, root: { type: 'group', id: 'g-' + id, activeTabId: tabs[0]?.id ?? '', tabs } }, maximizedGroupId: null, closedTabs: [], continueOnLimit, createdAt: AT, updatedAt: AT } as SessionRecord)
const text = (sequence: number, timestamp = AT): TimelineItem => ({ id: 'i' + sequence, runtimeId: 'r', sequence, timestamp, data: { type: 'text', role: 'assistant', text: 'x', mode: 'snapshot' } } as TimelineItem)
const error = (sequence: number, message: string, code?: string): TimelineItem => ({ id: 'e' + sequence, runtimeId: 'r', sequence, timestamp: AT, data: { type: 'error', message, ...(code ? { code } : {}) } } as unknown as TimelineItem)
const notice = (sequence: number): TimelineItem => ({ id: 'n' + sequence, runtimeId: 'r', sequence, timestamp: AT, data: { type: 'notice', level: 'info', message: 'Handed on', payload: { succession: { to: 'next' } } } } as unknown as TimelineItem)
const projection = (id: string, phase: SessionPhase, items: TimelineItem[] = [text(1)], extra: Partial<SessionProjection> = {}): SessionProjection => ({ sessionId: id, runtimeId: 'r', phase, sequence: items.length, items, settings: { permission: 'default', plan: false }, title: id, archived: false, truncated: false, ...extra } as SessionProjection)

function sources(options: { tabs: PaneTab[]; rows: Array<[string, AgentActivityPhase]>; states: Record<string, SessionProjection>; detached?: DetachedWindowRecord[]; permissions?: Array<{ agentSessionId: string; status: string; command?: string; reason?: string }>; superseded?: string[]; continueOnLimit?: boolean; other?: PaneTab[] }): NeedsAttentionSources {
  const main = workspace('w1', 'p1', options.tabs, options.continueOnLimit)
  const other = workspace('w2', 'p2', options.other ?? [])
  const rows: AttentionAgentRow[] = options.rows.map(([id, activityPhase]) => ({ id, projectId: (options.other ?? []).some(entry => entry.resourceId === id) ? 'p2' : 'p1', sessionId: (options.other ?? []).some(entry => entry.resourceId === id) ? 'w2' : 'w1', activityPhase }))
  return {
    projects: () => [{ id: 'p1', name: 'Conductor' }, { id: 'p2', name: 'Haftheme' }],
    workspaces: id => id === 'p1' ? [main] : [other],
    detached: () => options.detached ?? [],
    agents: () => rows,
    snapshot: id => options.states[id] ?? null,
    permissionRequests: () => options.permissions ?? [],
    superseded: (_projectId, id) => (options.superseded ?? []).includes(id)
  }
}

describe('computeNeedsAttention', () => {
  it('lists approvals, questions, permission cards, unseen failures, interruptions and stopped limits across projects, blocking asks first', () => {
    const snapshot = computeNeedsAttention(sources({
      tabs: [tab('approve'), tab('ask'), tab('perm'), tab('fail'), tab('cut'), tab('limit'), tab('run'), tab('wait'), tab('done')],
      other: [tab('elsewhere')],
      rows: [['approve', 'waiting_input'], ['ask', 'waiting_input'], ['perm', 'working'], ['fail', 'failed'], ['cut', 'disconnected'], ['limit', 'failed'], ['run', 'working'], ['wait', 'complete'], ['done', 'complete'], ['elsewhere', 'waiting_input']],
      states: {
        approve: projection('approve', 'waiting_approval'), ask: projection('ask', 'waiting_input'), elsewhere: projection('elsewhere', 'waiting_approval'),
        fail: projection('fail', 'failed', [text(1), error(2, 'Tests failed')]), cut: projection('cut', 'disconnected'),
        limit: projection('limit', 'failed', [text(1), error(2, 'You are out of quota', PROVIDER_USAGE_LIMIT)]),
        run: projection('run', 'running'), wait: projection('wait', 'completed'), done: projection('done', 'completed')
      },
      permissions: [{ agentSessionId: 'perm', status: 'pending', command: 'npm publish', reason: 'release' }, { agentSessionId: 'done', status: 'approved' }]
    }))
    expect(snapshot.entries.map(entry => [entry.agentSessionId, entry.reason])).toEqual([
      ['approve', 'approval'], ['elsewhere', 'approval'], ['perm', 'permission'], ['ask', 'question'], ['limit', 'limit'], ['fail', 'failed'], ['cut', 'interrupted']
    ])
    expect(snapshot.entries.find(entry => entry.agentSessionId === 'elsewhere')).toMatchObject({ projectId: 'p2', projectName: 'Haftheme', workspaceId: 'w2', tabId: 'tab-elsewhere' })
    expect(snapshot.entries.find(entry => entry.agentSessionId === 'perm')!.detail).toBe('npm publish — release')
    expect(snapshot.entries.find(entry => entry.agentSessionId === 'fail')!.detail).toBe('Tests failed')
    expect(snapshot.total).toBe(7)
  })

  it('leaves out a failure the owner has looked at, one taken over or handed on, a closed tab, and a limit that continues by itself', () => {
    const settled = '2026-09-29T09:00:00.000Z', later = '2026-09-29T09:05:00.000Z'
    const snapshot = computeNeedsAttention(sources({
      tabs: [tab('seen', { seenAt: later }), tab('unseen', { seenAt: '2026-09-29T08:00:00.000Z' }), tab('taken'), tab('handed'), tab('resumes', { continueOnLimit: true })],
      rows: [['seen', 'failed'], ['unseen', 'failed'], ['taken', 'failed'], ['handed', 'failed'], ['closed', 'waiting_input'], ['resumes', 'limited']],
      states: {
        seen: projection('seen', 'failed', [text(1, settled)]), unseen: projection('unseen', 'failed', [text(1, settled)]),
        taken: projection('taken', 'failed'), handed: projection('handed', 'failed', [text(1), notice(2)]),
        closed: projection('closed', 'waiting_approval'), resumes: projection('resumes', 'completed', [text(1)], { limitResumeAt: later })
      },
      superseded: ['taken']
    }))
    expect(snapshot.entries.map(entry => entry.agentSessionId)).toEqual(['unseen'])
  })

  it('lists a limit wait that will not continue, and a tab in a detached window', () => {
    const detachedTab = tab('floating')
    const snapshot = computeNeedsAttention(sources({
      tabs: [tab('stopped')], rows: [['stopped', 'limited'], ['floating', 'waiting_input']],
      states: { stopped: projection('stopped', 'completed', [text(1)], { limitResumeAt: '2026-09-29T12:00:00.000Z' }), floating: projection('floating', 'waiting_input') },
      detached: [{ id: 'd1', projectId: 'p1', sessionId: 'w1', layout: { version: 1, root: { type: 'group', id: 'gd', activeTabId: detachedTab.id, tabs: [detachedTab] } }, maximizedGroupId: null, createdAt: AT, updatedAt: AT }]
    }))
    expect(snapshot.entries.map(entry => [entry.agentSessionId, entry.reason])).toEqual([['floating', 'question'], ['stopped', 'limit']])
    expect(snapshot.entries[1]!.detail).toMatch(/limit continuation is off/)
  })

  it('reads a conversation only for the tabs whose phase flags it', () => {
    const base = sources({ tabs: [tab('a'), tab('b'), tab('c')], rows: [['a', 'working'], ['b', 'complete'], ['c', 'waiting_input']], states: { c: projection('c', 'waiting_input') } })
    const snapshot = vi.fn(base.snapshot)
    computeNeedsAttention({ ...base, snapshot })
    expect(snapshot.mock.calls.map(call => call[0])).toEqual(['c'])
  })
})

describe('NeedsAttention', () => {
  afterEach(() => { vi.useRealTimers() })
  it('recomputes once per burst and publishes only a changed list', () => {
    vi.useFakeTimers()
    let phase: AgentActivityPhase = 'working'
    const base = sources({ tabs: [tab('a')], rows: [], states: { a: projection('a', 'waiting_approval') } })
    const publish = vi.fn()
    const attention = new NeedsAttention({ ...base, agents: () => [{ id: 'a', projectId: 'p1', sessionId: 'w1', activityPhase: phase }] }, publish, 100)
    expect(attention.snapshot().entries).toEqual([])
    attention.changed(); attention.changed(); vi.advanceTimersByTime(150)
    expect(publish).not.toHaveBeenCalled()
    phase = 'waiting_input'
    attention.changed(); attention.changed(); vi.advanceTimersByTime(150)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]![0].entries.map((entry: { reason: string }) => entry.reason)).toEqual(['approval'])
    attention.changed(); vi.advanceTimersByTime(150)
    expect(publish).toHaveBeenCalledTimes(1)
    attention.dispose()
  })
})
