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
  const clock = { now: Date.parse('2026-09-30T00:00:00.000Z') }
  const state = (id: string, phase: SessionProjection['phase'] = 'completed', items: TimelineItem[] = []): SessionProjection => {
    const value = { sessionId: id, runtimeId: 'r', phase, sequence: items.reduce((max, item) => Math.max(max, item.sequence), 0), items, settings: { permission: 'default', plan: false }, title: id, archived: false, truncated: false } as SessionProjection
    states.set(id, value)
    return value
  }
  const ledger = new AwaitingResults({
    settings: { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) }, removeSetting: key => { settings.delete(key) } },
    snapshot: id => states.get(id) ?? null,
    journal: (id, from, to, limit) => (journal.get(id) ?? []).filter(event => event.sequence >= from && event.sequence < to && event.sequence >= (floors.get(id) ?? 0)).slice(0, limit),
    open: id => open[id], successors: () => [], superseded: id => superseded.has(id), now: () => clock.now
  })
  const staged = new Map<string, TimelineItem[]>()
  const toEvent = (id: string, item: TimelineItem): AgentEvent => ({ sessionId: id, runtimeId: 'r', sequence: item.sequence, timestamp: item.timestamp, itemId: item.id, data: item.data }) as AgentEvent
  const project = (id: string, window: number): SessionProjection => {
    const all = [...(journal.get(id) ?? []).map(event => ({ id: 'i' + event.sequence, runtimeId: 'r', sequence: event.sequence, timestamp: event.timestamp, data: event.data }) as TimelineItem), ...staged.get(id) ?? []]
    const value = state(id, 'completed', all.slice(-window))
    value.sequence = all.at(-1)?.sequence ?? 0
    return value
  }
  /** Appends journal events and a projection that holds only the newest window items. */
  const emit = (id: string, items: TimelineItem[], window = 2000): SessionProjection => {
    journal.set(id, [...journal.get(id) ?? [], ...items.map(item => toEvent(id, item))])
    return project(id, window)
  }
  /** Events applied to the projection but not written to the journal yet (StructuredStore.stage). */
  const stage = (id: string, items: TimelineItem[]): SessionProjection => { staged.set(id, [...staged.get(id) ?? [], ...items]); return project(id, 2000) }
  return { settings, state, ledger, open, superseded, emit, stage, floors, toEvent, clock }
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

  it('consumes a reply that joins a running turn as it is broadcast, with no status change, past the journal retention (review of 66e7037)', () => {
    const h = harness()
    h.emit('reviewer', [text(1)])
    h.ledger.declare('reviewer', ['fixer', 'other'])
    // The reply is steered into a running turn: an event, but no agent:status change.
    const reply = text(2, 'fixer')
    h.emit('reviewer', [reply])
    h.ledger.noteEvents([h.toEvent('reviewer', reply)])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other'] })
    // The turn streams on past the journal's retention and the projection's window before anything reads the wait.
    h.emit('reviewer', Array.from({ length: 25_000 }, (_, index) => text(3 + index)))
    h.floors.set('reviewer', 5_000)
    expect(h.ledger.fact('reviewer')!.agents.map(agent => agent.agentSessionId)).toEqual(['other'])
    // Broadcast events from unrelated conversations, or without an origin, read nothing.
    h.ledger.noteEvents([h.toEvent('someone-else', text(9, 'fixer')), h.toEvent('reviewer', text(10))])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other'] })
  })

  it('reads a staged reply from the projection and never moves the cursor past what it read', () => {
    const h = harness()
    h.emit('reviewer', [text(1), text(2)])
    h.ledger.declare('reviewer', ['fixer', 'other'])
    // Journal durable through 2; the fixer's reply at 3 is staged, not yet written.
    h.stage('reviewer', [text(3, 'fixer')])
    expect(h.ledger.consume('reviewer')).toMatchObject({ agents: ['other'], sinceSequence: 3 })
  })

  it('reads the journal in bounded pages and continues from the last durable event it read', () => {
    const h = harness()
    h.emit('reviewer', [text(1)])
    h.ledger.declare('reviewer', ['fixer', 'other'])
    // 25,000 events after the cursor; the reply at 22,000 is beyond one consume's 20 pages and outside the projection.
    h.emit('reviewer', Array.from({ length: 25_000 }, (_, index) => text(2 + index, 2 + index === 22_000 ? 'fixer' : undefined)))
    const first = h.ledger.consume('reviewer')!
    expect(first.agents).toEqual(['fixer', 'other'])
    expect(first.sinceSequence).toBe(20_001)
    expect(h.ledger.consume('reviewer')).toMatchObject({ agents: ['other'], sinceSequence: 25_001 })
  })

  it('counts a reply whose broadcast arrives only after it left the journal and the projection (review of 14208ca)', () => {
    const h = harness()
    h.emit('reviewer', [text(1)])
    h.ledger.declare('reviewer', ['fixer', 'other'])
    // The durable reply at 2 is still waiting in the broadcast outbox when a 25,000-event burst is
    // flushed and checkpointed: the journal now holds 5,002..25,001 and the projection the last 2,000.
    const reply = text(2, 'fixer')
    h.emit('reviewer', [reply, ...Array.from({ length: 25_000 }, (_, index) => text(3 + index))])
    h.floors.set('reviewer', 5_002)
    // A catch-up read in between moves the cursor past the trimmed gap.
    expect(h.ledger.consume('reviewer')).toMatchObject({ agents: ['fixer', 'other'] })
    expect(h.ledger.record('reviewer')!.sinceSequence).toBeGreaterThan(2)
    // The late broadcast carries the reply itself: it counts against the fixer's own baseline.
    h.ledger.noteEvents([h.toEvent('reviewer', reply)])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other'] })
    // Durable: a restart reads the same.
    expect(harness(h.settings).ledger.record('reviewer')).toMatchObject({ agents: ['other'] })
  })

  it('judges each agent against its own baseline: an older message from a newly awaited recipient does not count', () => {
    const h = harness()
    h.emit('reviewer', [text(1)])
    h.ledger.declare('reviewer', ['other'])
    // The fixer wrote at 2, before the reviewer asked it anything at baseline 3.
    const old = text(2, 'fixer')
    h.emit('reviewer', [old, text(3)])
    expect(h.ledger.add('reviewer', 'fixer', 3).agents).toEqual(['other', 'fixer'])
    h.ledger.noteEvents([h.toEvent('reviewer', old)])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other', 'fixer'], baselines: { other: 1, fixer: 3 } })
    const answer = text(4, 'fixer')
    h.emit('reviewer', [answer])
    h.ledger.noteEvents([h.toEvent('reviewer', answer)])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other'] })
  })

  it('gives a newly awaited recipient its own pre-send baseline, not the shared scan cursor (review of fcd3558)', () => {
    const h = harness()
    h.emit('reviewer', [text(1)])
    h.ledger.declare('reviewer', ['other'])
    // Then the journal fills to 5,001..25,001 after a trim; its last row is an older message from the fixer.
    h.emit('reviewer', Array.from({ length: 25_000 }, (_, index) => text(2 + index, 2 + index === 25_001 ? 'fixer' : undefined)))
    h.floors.set('reviewer', 5_001)
    // The reviewer asks the fixer at 25,001. add()'s own catch-up stops at 25,000 (one consume's page
    // budget), before the fixer's old message: that message must still not count.
    const added = h.ledger.add('reviewer', 'fixer', 25_001)
    expect(added.agents).toEqual(['other', 'fixer'])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other', 'fixer'], baselines: { other: 1, fixer: 25_001 } })
  })

  it('writes the baselines of a legacy record out before its cursor first moves (review of fcd3558)', () => {
    const h = harness()
    const reply = text(2, 'fixer')
    h.emit('reviewer', [text(1), reply, ...Array.from({ length: 25_000 }, (_, index) => text(3 + index))])
    h.floors.set('reviewer', 5_002)
    // A record written before per-agent baselines existed.
    h.settings.set('awaitingResults:reviewer', JSON.stringify({ agents: ['fixer', 'other'], since: '2026-09-29T09:00:00.000Z', sinceSequence: 1 }))
    h.ledger.consume('reviewer')
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['fixer', 'other'], baselines: { fixer: 1, other: 1 } })
    expect(h.ledger.record('reviewer')!.sinceSequence).toBeGreaterThan(1)
    // The late broadcast of the reply at 2 still counts against the fixer's original baseline.
    h.ledger.noteEvents([h.toEvent('reviewer', reply)])
    expect(h.ledger.record('reviewer')).toMatchObject({ agents: ['other'] })
  })

  it('ends a wait at its deadline, the default one when none was named, and only for a waiter whose turn ended', () => {
    const h = harness()
    h.state('reviewer', 'completed', [text(1)])
    h.state('fixer', 'running')
    expect(h.ledger.declare('reviewer', ['fixer']).deadline).toBe('2026-09-30T01:00:00.000Z')
    expect(h.ledger.waiters()).toEqual(['reviewer'])
    const busy = () => false
    h.clock.now += 59 * 60_000
    expect(h.ledger.sweep(busy)).toEqual([])
    h.clock.now += 2 * 60_000
    // Mid-turn, or stopped by the owner, it is not woken; the wait stays.
    h.state('reviewer', 'running', [text(1)])
    expect(h.ledger.sweep(busy)).toEqual([])
    h.state('reviewer', 'interrupted', [text(1)])
    expect(h.ledger.sweep(busy)).toEqual([])
    h.state('reviewer', 'completed', [text(1)])
    expect(h.ledger.sweep(busy)).toMatchObject([{ waiter: 'reviewer', kind: 'deadline', agents: ['fixer'] }])
    expect(h.ledger.record('reviewer')).toBeNull()
    expect(h.ledger.waiters()).toEqual([])
    expect(h.ledger.sweep(busy)).toEqual([])
    // An explicit deadline, kept when awaitReply adds a recipient.
    h.ledger.declare('reviewer', ['fixer'], undefined, undefined, {}, '2026-09-30T01:05:00.000Z')
    expect(h.ledger.add('reviewer', 'other', 1).deadline).toBe('2026-09-30T01:05:00.000Z')
  })

  it('wakes the waiter once everyone it waits for stayed quiet for the grace period without messaging', () => {
    const h = harness()
    h.state('reviewer', 'completed', [text(1)])
    h.ledger.declare('reviewer', ['fixer', 'other'])
    const quiet = new Set<string>(['fixer'])
    const isQuiet = (id: string) => quiet.has(id)
    expect(h.ledger.sweep(isQuiet, 60_000)).toEqual([])
    quiet.add('other')
    expect(h.ledger.sweep(isQuiet, 60_000)).toEqual([])
    h.clock.now += 30_000
    // Work resumed in between: the grace period starts again.
    quiet.delete('other')
    expect(h.ledger.sweep(isQuiet, 60_000)).toEqual([])
    quiet.add('other')
    expect(h.ledger.sweep(isQuiet, 60_000)).toEqual([])
    h.clock.now += 59_000
    expect(h.ledger.sweep(isQuiet, 60_000)).toEqual([])
    h.clock.now += 1_000
    expect(h.ledger.sweep(isQuiet, 60_000)).toMatchObject([{ waiter: 'reviewer', kind: 'quiet', agents: ['fixer', 'other'] }])
    expect(h.ledger.record('reviewer')).toBeNull()
    // A closed tab counts as quiet; a reply that arrived resolves the wait before any sweep.
    h.ledger.declare('reviewer', ['fixer'])
    delete h.open.fixer
    expect(h.ledger.sweep(() => false, 0)).toMatchObject([{ kind: 'quiet', agents: ['fixer'] }])
    h.open.fixer = 'Fixer'
    h.ledger.declare('reviewer', ['fixer'])
    h.state('reviewer', 'completed', [text(1), text(2, 'fixer')])
    expect(h.ledger.sweep(() => true, 0)).toEqual([])
    expect(h.ledger.waiters()).toEqual([])
  })

  it('the archive refuses a waiting tab', () => {
    expect(archiveRefusal({ wizard: false, controlsLiveCoworkers: false, remote: false, awaiting: 'it is waiting for results from Fixer (fixer)' }, null)).toBe('it is waiting for results from Fixer (fixer)')
    expect(archiveRefusal({ wizard: false, controlsLiveCoworkers: false, remote: false }, null)).toBeNull()
  })
})
