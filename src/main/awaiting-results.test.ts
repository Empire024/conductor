import { describe, expect, it } from 'vitest'
import type { SessionProjection, TimelineItem } from '../shared/structured-agent'
import { AWAITING_RESULTS_PREFIX } from '../shared/awaiting-results'
import { AwaitingResults } from './awaiting-results'
import { archiveRefusal } from './tab-archive-eligibility'

const text = (sequence: number, from?: string): TimelineItem => ({ id: 'i' + sequence, runtimeId: 'r', sequence, timestamp: '2026-09-29T09:00:00.000Z', data: { type: 'text', role: 'user', text: 'x', mode: 'snapshot', ...(from ? { origin: { agentSessionId: from, label: from } } : {}) } } as TimelineItem)
const succession = (sequence: number): TimelineItem => ({ id: 'n' + sequence, runtimeId: 'r', sequence, timestamp: '2026-09-29T09:00:00.000Z', data: { type: 'notice', level: 'info', message: 'Handed on', payload: { succession: { to: 'next' } } } } as unknown as TimelineItem)

function harness() {
  const settings = new Map<string, string>()
  const states = new Map<string, SessionProjection>()
  const open: Record<string, string> = { fixer: 'Fixer', other: 'Other fixer' }
  const superseded = new Set<string>()
  const state = (id: string, phase: SessionProjection['phase'] = 'completed', items: TimelineItem[] = []): SessionProjection => {
    const value = { sessionId: id, runtimeId: 'r', phase, sequence: items.reduce((max, item) => Math.max(max, item.sequence), 0), items, settings: { permission: 'default', plan: false }, title: id, archived: false, truncated: false } as SessionProjection
    states.set(id, value)
    return value
  }
  const ledger = new AwaitingResults({
    settings: { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) }, removeSetting: key => { settings.delete(key) } },
    snapshot: id => states.get(id) ?? null,
    open: id => open[id], successors: () => [], superseded: id => superseded.has(id)
  })
  return { settings, state, ledger, open, superseded }
}

describe('AwaitingResults', () => {
  it('declares at the current sequence, resolves on arrival and deletes the record', () => {
    const h = harness()
    h.state('reviewer', 'completed', [text(1), text(2, 'fixer')])
    const record = h.ledger.declare('reviewer', ['fixer', 'fixer', 'reviewer', 'other'], '  fix commits  ')
    expect(record).toMatchObject({ agents: ['fixer', 'other'], sinceSequence: 2, reason: 'fix commits' })
    // The fixer's message from before the declaration does not count.
    expect(h.ledger.fact('reviewer')).toMatchObject({ agents: [{ agentSessionId: 'fixer', title: 'Fixer' }, { agentSessionId: 'other', title: 'Other fixer' }] })
    h.state('reviewer', 'completed', [text(1), text(2, 'fixer'), text(3, 'fixer')])
    expect(h.ledger.fact('reviewer')!.agents.map(agent => agent.agentSessionId)).toEqual(['other'])
    h.state('reviewer', 'completed', [text(1), text(2, 'fixer'), text(3, 'fixer'), text(4, 'other')])
    expect(h.ledger.fact('reviewer')).toBeUndefined()
    expect(h.settings.has(AWAITING_RESULTS_PREFIX + 'reviewer')).toBe(false)
  })

  it('add keeps what is still owed; clear cancels', () => {
    const h = harness()
    h.state('reviewer')
    h.ledger.declare('reviewer', ['fixer'], 'first')
    expect(h.ledger.add('reviewer', 'other')).toMatchObject({ agents: ['fixer', 'other'], reason: 'first' })
    expect(h.ledger.clear('reviewer')).toBe(true)
    expect(h.ledger.clear('reviewer')).toBe(false)
    expect(h.ledger.fact('reviewer')).toBeUndefined()
    expect(() => h.ledger.declare('reviewer', ['reviewer'])).toThrow(/at least one other/)
  })

  it('is not waiting while stopped, handed off, superseded or when every awaited tab is gone; the record stays for those', () => {
    const h = harness()
    h.state('reviewer')
    h.ledger.declare('reviewer', ['fixer'])
    h.state('reviewer', 'interrupted')
    expect(h.ledger.fact('reviewer')).toBeUndefined()
    h.state('reviewer', 'completed', [succession(1)])
    expect(h.ledger.fact('reviewer')).toBeUndefined()
    h.state('reviewer')
    h.superseded.add('reviewer')
    expect(h.ledger.fact('reviewer')).toBeUndefined()
    h.superseded.clear()
    delete h.open.fixer
    expect(h.ledger.fact('reviewer')).toBeUndefined()
    // Reopened (a message brings a finished coworker back): waited for again.
    h.open.fixer = 'Fixer'
    expect(h.ledger.fact('reviewer')).toBeDefined()
    expect(h.settings.has(AWAITING_RESULTS_PREFIX + 'reviewer')).toBe(true)
  })

  it('the archive refuses a waiting tab', () => {
    expect(archiveRefusal({ wizard: false, controlsLiveCoworkers: false, remote: false, awaiting: 'it is waiting for results from Fixer (fixer)' }, null)).toBe('it is waiting for results from Fixer (fixer)')
    expect(archiveRefusal({ wizard: false, controlsLiveCoworkers: false, remote: false }, null)).toBeNull()
  })
})
