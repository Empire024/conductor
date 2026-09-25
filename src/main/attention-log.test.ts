import { describe, expect, it } from 'vitest'
import type { PhoneNotification } from '../shared/phone-access'
import type { AgentEventData, PendingInteraction, TimelineItem } from '../shared/structured-agent'
import { ATTENTION_GRACE_MS, ATTENTION_LOG_KEY, ATTENTION_LOG_LIMIT, ATTENTION_WATCH_MS, AttentionGate, attentionVerdict, type AttentionCandidate, type AttentionView } from './attention-log'

// conductor-task:phone-needs-you-only-when-blocked
const item = (sequence: number, data: AgentEventData, id = `item-${sequence}`): TimelineItem => ({ id, runtimeId: 'rt', sequence, timestamp: '', data })
const question = (status: PendingInteraction['status'] = 'pending', extra: Partial<PendingInteraction> = {}): PendingInteraction => ({ id: 'q-1', kind: 'question', title: 'Which branch?', input: null, choices: [], status, ...extra })
const approval = (status: PendingInteraction['status'], review?: PendingInteraction['review'], outcome?: string): PendingInteraction => ({ id: 'a-1', kind: 'approval', title: 'Allow Bash?', input: null, choices: [], status, ...(review ? { review } : {}), ...(outcome ? { outcome } : {}) })
const notification = (id: string): PhoneNotification => ({ id, kind: 'attention', sessionId: 's', title: 'Needs you: Swarm', body: 'b', at: 'then', url: '/#/session/s' })
const asking: AttentionCandidate = { sessionId: 's', title: 'Swarm', kind: 'question', detail: 'Which branch?', pendingId: 'q-1', notification: notification('n-q') }
const refused: AttentionCandidate = { sessionId: 's', title: 'Swarm', kind: 'denial', detail: 'Auto mode refused Bash', denialItemId: 'deny-1', notification: notification('n-d') }
const approving: AttentionCandidate = { sessionId: 's', title: 'Swarm', kind: 'approval', detail: 'Allow Bash?', pendingId: 'a-1', notification: notification('n-a') }
const denialItem = item(2, { type: 'notice', message: 'Auto mode refused Bash' }, 'deny-1')

function gate() {
  const settings = new Map<string, string>()
  const sent: PhoneNotification[] = []
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  let clock = Date.parse('2026-09-25T12:00:00Z')
  let view: AttentionView | undefined
  const attention = new AttentionGate({
    view: () => view,
    send: value => { sent.push(value) },
    store: { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) } },
    now: () => clock,
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: handle => { (handle as { cleared: boolean }).cleared = true }
  })
  const elapse = (ms: number) => { clock += ms; for (const timer of timers) if (!timer.cleared && timer.ms <= ms) { timer.cleared = true; timer.callback() } }
  return { attention, sent, timers, settings, elapse, set: (next: AttentionView | undefined) => { view = next } }
}

describe('attention verdicts', () => {
  it('holds a question or approval on the owner only while it is still the pending one', () => {
    expect(attentionVerdict(asking, { open: true, state: 'attention', pendingId: 'q-1', items: [item(1, { type: 'interaction', interaction: question() })] })).toMatchObject({ verdict: 'blocked' })
    expect(attentionVerdict(asking, { open: true, state: 'working', items: [item(1, { type: 'interaction', interaction: question('resolved', { outcome: 'main' }) })] })).toEqual({ verdict: 'settled', outcome: 'answered', next: 'Answered within the grace period: main.' })
    expect(attentionVerdict(asking, { open: true, state: 'working', items: [item(1, { type: 'interaction', interaction: question('resolved', { outcome: 'allow', answers: { q: ['main'] } }) })] })).toMatchObject({ next: 'Answered within the grace period: main.' })
    expect(attentionVerdict(asking, { open: true, state: 'working', items: [item(1, { type: 'interaction', interaction: question('expired') })] })).toMatchObject({ verdict: 'settled', outcome: 'routed-around' })
    expect(attentionVerdict(asking, { open: false, items: [] })).toMatchObject({ verdict: 'settled', outcome: 'closed' })
    expect(attentionVerdict(asking, undefined)).toMatchObject({ verdict: 'settled', outcome: 'closed' })
  })

  it('leaves an approval a reviewer or wizard holds undecided, credits its answer, and blocks once escalated', () => {
    const reviewing = { id: 'r', digest: 'd', phase: 'reviewing', rationale: 'Waiting for a stronger reviewing turn' }
    expect(attentionVerdict(approving, { open: true, state: 'attention', pendingId: 'a-1', items: [item(1, { type: 'interaction', interaction: approval('pending', reviewing) })] })).toEqual({ verdict: 'undecided' })
    expect(attentionVerdict(approving, { open: true, state: 'attention', pendingId: 'a-1', items: [item(1, { type: 'interaction', interaction: approval('pending', { ...reviewing, phase: 'owner', rationale: 'Escalated' }) })] })).toMatchObject({ verdict: 'blocked', next: 'The reviewer handed it to the owner; still waiting.' })
    expect(attentionVerdict(approving, { open: true, state: 'working', items: [item(1, { type: 'interaction', interaction: approval('resolved', { ...reviewing, phase: 'responded', rationale: 'Scoped to the checkout', reviewerModel: 'Opus' }, 'allow') })] }))
      .toEqual({ verdict: 'settled', outcome: 'reviewer', next: 'Answered by the reviewer (Opus): allow.' })
    // The owner answering while the review ran is the owner's answer, not the reviewer's.
    expect(attentionVerdict(approving, { open: true, state: 'working', items: [item(1, { type: 'interaction', interaction: approval('resolved', { ...reviewing, phase: 'responding', rationale: 'Owner answered while the review was reviewing' }, 'deny') })] }))
      .toMatchObject({ verdict: 'settled', outcome: 'answered' })
  })

  it('reads a refusal as routed around once another tool runs or the agent asks instead, and as blocked when the turn stops on it', () => {
    const tool = item(3, { type: 'tool', name: 'Read', status: 'completed', input: {} })
    expect(attentionVerdict(refused, { open: true, state: 'working', items: [denialItem] })).toEqual({ verdict: 'undecided' })
    expect(attentionVerdict(refused, { open: true, state: 'working', items: [denialItem, tool] })).toEqual({ verdict: 'settled', outcome: 'routed-around', next: 'The agent went another way: 1 tool call since.' })
    expect(attentionVerdict(refused, { open: true, state: 'attention', pendingId: 'q-1', items: [denialItem] })).toMatchObject({ verdict: 'settled', outcome: 'routed-around' })
    expect(attentionVerdict(refused, { open: true, state: 'done', items: [denialItem, item(3, { type: 'text', role: 'assistant', text: 'I could not push.', mode: 'snapshot' })] })).toMatchObject({ verdict: 'blocked' })
  })
})

describe('the attention gate', () => {
  it('notifies a moment still blocked after the grace period, once, and logs it', () => {
    const g = gate()
    g.set({ open: true, state: 'attention', pendingId: 'q-1', items: [item(1, { type: 'interaction', interaction: question() })] })
    g.attention.offer(asking)
    g.attention.offer(asking)
    g.attention.review()
    expect(g.sent).toHaveLength(0)
    expect(g.timers.map(timer => timer.ms)).toEqual([ATTENTION_GRACE_MS])
    g.elapse(ATTENTION_GRACE_MS)
    expect(g.sent.map(value => value.id)).toEqual(['n-q'])
    expect(g.sent[0]!.at).toBe('2026-09-25T12:00:20.000Z')
    g.attention.review()
    expect(g.sent).toHaveLength(1)
    expect(g.attention.entries()).toEqual([{ id: 'n-q', at: '2026-09-25T12:00:00.000Z', sessionId: 's', title: 'Swarm', kind: 'question', detail: 'Which branch?', outcome: 'notified', next: 'Still waiting for the owner.', waitedMs: ATTENTION_GRACE_MS }])
  })

  it('cancels a moment that resolves inside the grace period and only logs it', () => {
    const g = gate()
    g.set({ open: true, state: 'attention', pendingId: 'q-1', items: [item(1, { type: 'interaction', interaction: question() })] })
    g.attention.offer(asking)
    g.elapse(4000)
    g.set({ open: true, state: 'working', items: [item(1, { type: 'interaction', interaction: question('resolved', { outcome: 'main' }) })] })
    g.attention.review()
    expect(g.timers[0]!.cleared).toBe(true)
    expect(g.attention.held()).toBe(0)
    g.elapse(ATTENTION_GRACE_MS)
    expect(g.sent).toHaveLength(0)
    expect(g.attention.entries()).toEqual([expect.objectContaining({ kind: 'question', outcome: 'answered', waitedMs: 4000 })])
  })

  it('never notifies a routed-around refusal, only logs it', () => {
    const g = gate()
    g.set({ open: true, state: 'working', items: [denialItem] })
    g.attention.offer(refused)
    g.elapse(ATTENTION_GRACE_MS)
    expect(g.attention.held()).toBe(1)
    g.set({ open: true, state: 'working', items: [denialItem, item(3, { type: 'tool', name: 'Bash', status: 'running', input: {} })] })
    g.attention.review()
    g.set({ open: true, state: 'done', items: [denialItem, item(3, { type: 'tool', name: 'Bash', status: 'completed', input: {} })] })
    g.attention.review()
    expect(g.sent).toHaveLength(0)
    expect(g.attention.entries()).toEqual([expect.objectContaining({ kind: 'denial', outcome: 'routed-around', next: 'The agent went another way: 1 tool call since.' })])
  })

  it('logs an approval answered by a reviewer after the grace period without notifying, and gives up on a moment nobody decides', () => {
    const g = gate()
    const reviewing = { id: 'r', digest: 'd', phase: 'reviewing', rationale: 'Waiting' }
    g.set({ open: true, state: 'attention', pendingId: 'a-1', items: [item(1, { type: 'interaction', interaction: approval('pending', reviewing) })] })
    g.attention.offer(approving)
    g.elapse(ATTENTION_GRACE_MS)
    expect(g.sent).toHaveLength(0)
    g.set({ open: true, state: 'working', items: [item(1, { type: 'interaction', interaction: approval('resolved', { ...reviewing, phase: 'responded', rationale: 'Fine' }, 'allow') })] })
    g.attention.review()
    expect(g.attention.entries().map(entry => entry.outcome)).toEqual(['reviewer'])

    g.set({ open: true, state: 'working', items: [denialItem] })
    g.attention.offer(refused)
    g.elapse(ATTENTION_GRACE_MS)
    g.elapse(ATTENTION_WATCH_MS)
    g.attention.review()
    expect(g.sent).toHaveLength(0)
    expect(g.attention.entries().map(entry => entry.outcome)).toEqual(['reviewer', 'undecided'])
  })

  it('keeps the log bounded and survives a corrupt one', () => {
    const g = gate()
    g.settings.set(ATTENTION_LOG_KEY, '{not json')
    expect(g.attention.entries()).toEqual([])
    g.set({ open: false, items: [] })
    for (let index = 0; index < ATTENTION_LOG_LIMIT + 5; index++) { g.attention.offer({ ...asking, pendingId: `q-${index}`, notification: notification(`n-${index}`) }); g.attention.review() }
    const entries = g.attention.entries()
    expect(entries).toHaveLength(ATTENTION_LOG_LIMIT)
    expect(entries.at(-1)).toMatchObject({ id: `n-${ATTENTION_LOG_LIMIT + 4}`, outcome: 'closed' })
    g.attention.clear()
    expect(g.attention.entries()).toEqual([])
  })
})
