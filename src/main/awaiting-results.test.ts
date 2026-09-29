import { describe, expect, it } from 'vitest'
import type { AgentEvent, SessionProjection, TimelineItem } from '../shared/structured-agent'
import { AWAITING_RESULTS_PREFIX } from '../shared/awaiting-results'
import { AwaitingResults } from './awaiting-results'
import { archiveRefusal } from './tab-archive-eligibility'

const text = (sequence: number, from?: string): TimelineItem => ({ id: 'i' + sequence, runtimeId: 'r', sequence, timestamp: '2026-09-29T09:00:00.000Z', data: { type: 'text', role: 'user', text: 'x', mode: 'snapshot', ...(from ? { origin: { agentSessionId: from, label: from } } : {}) } } as TimelineItem)
const succession = (sequence: number): TimelineItem => ({ id: 'n' + sequence, runtimeId: 'r', sequence, timestamp: '2026-09-29T09:00:00.000Z', data: { type: 'notice', level: 'info', message: 'Handed on', payload: { succession: { to: 'next' } } } } as unknown as TimelineItem)

function harness(settings = new Map<string, string>()) {
  // The durable journal: every event ever emitted, minus what a trim removed below the floor.
  const journal = new Map<string, AgentEvent[]>()
  const floors = new Map<string, number>()
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
    journal: (id, from, to, limit) => (journal.get(id) ?? []).filter(event => event.sequence >= from && event.sequence < to && event.sequence >= (floors.get(id) ?? 0)).slice(0, limit),
    journalFloor: id => { const kept = (journal.get(id) ?? []).filter(event => event.sequence >= (floors.get(id) ?? 0)); return kept[0]?.sequence ?? null },
    open: id => open[id], successors: () => [], superseded: id => superseded.has(id)
  })
  /** Appends journal events and a projection that holds only the newest window items. */
  const emit = (id: string, items: TimelineItem[], window = 2000): SessionProjection => {
    journal.set(id, [...journal.get(id) ?? [], ...items.map(item => ({ sessionId: id, runtimeId: 'r', sequence: item.sequence, timestamp: item.timestamp, itemId: item.id, data: item.data }) as AgentEvent)])
    const all = (journal.get(id) ?? []).map(event => ({ id: 'i' + event.sequence, runtimeId: 'r', sequence: event.sequence, timestamp: event.timestamp, data: event.data }) as TimelineItem)
    const value = state(id, 'completed', all.slice(-window))
    value.sequence = all.at(-1)?.sequence ?? 0
    return value
  }
  return { settings, state, ledger, open, superseded, emit, floors }
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
    expect(h.ledger.add('reviewer', 'other', 0)).toMatchObject({ agents: ['fixer', 'other'], reason: 'first' })
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

  it('consumes a partial reply durably: projection eviction, a journal trim and a restart never bring it back (93c049f review)', () => {
    const h = harness()
    h.emit('reviewer', Array.from({ length: 10 }, (_, index) => text(index + 1)))
    h.ledger.declare('reviewer', ['fixer', 'other'])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['fixer', 'other'], sinceSequence: 10 })
    // The fixer replies at 11; one read consumes it.
    h.emit('reviewer', [text(11, 'fixer')])
    expect(h.ledger.fact('reviewer')!.agents.map(agent => agent.agentSessionId)).toEqual(['other'])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other'], sinceSequence: 11 })
    // A long turn pushes the reply out of the 2000-item projection and the journal is trimmed past it.
    h.emit('reviewer', Array.from({ length: 2500 }, (_, index) => text(12 + index)))
    h.floors.set('reviewer', 1000)
    expect(h.ledger.fact('reviewer')!.agents.map(agent => agent.agentSessionId)).toEqual(['other'])
    // A restart: a fresh ledger over the same settings.
    const restarted = harness(h.settings)
    restarted.emit('reviewer', Array.from({ length: 2511 }, (_, index) => text(index + 1)))
    expect(restarted.ledger.fact('reviewer')!.agents.map(agent => agent.agentSessionId)).toEqual(['other'])
  })

  it('reads a reply that has already left the projection from the durable journal', () => {
    const h = harness()
    h.emit('reviewer', [text(1)])
    h.ledger.declare('reviewer', ['fixer', 'other'])
    // The reply at 2 is followed by 2100 items before anything reads the wait.
    h.emit('reviewer', [text(2, 'fixer'), ...Array.from({ length: 2100 }, (_, index) => text(3 + index))])
    expect(h.ledger.fact('reviewer')!.agents.map(agent => agent.agentSessionId)).toEqual(['other'])
  })

  it('counts a reply that arrived after the baseline even before the wait was registered', () => {
    const h = harness()
    h.emit('reviewer', [text(1), text(2)])
    // The send went out at baseline 2; the reply at 3 landed before add() ran.
    h.emit('reviewer', [text(3, 'fixer')])
    expect(h.ledger.add('reviewer', 'fixer', 2).agents).toEqual([])
    expect(h.ledger.record('reviewer')).toBeNull()
  })

  it('the archive refuses a waiting tab', () => {
    expect(archiveRefusal({ wizard: false, controlsLiveCoworkers: false, remote: false, awaiting: 'it is waiting for results from Fixer (fixer)' }, null)).toBe('it is waiting for results from Fixer (fixer)')
    expect(archiveRefusal({ wizard: false, controlsLiveCoworkers: false, remote: false }, null)).toBeNull()
  })
})
