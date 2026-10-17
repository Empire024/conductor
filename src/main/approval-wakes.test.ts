import { describe, expect, it } from 'vitest'
import { ApprovalWakes, awaitWakeText, controllerWakeText, type PendingCard } from './approval-wakes'

const card = (requestId: string, extra: Partial<PendingCard> = {}): PendingCard => ({ agentSessionId: 'worker', title: 'Worker', kind: 'approval', requestId, runtimeId: 'r1', tool: 'Bash', action: 'npm install left-pad', controller: 'wizard', ...extra })

describe('approval wakes: grace, dedupe and coalescing', () => {
  it('waits the grace period, then wakes once per card', () => {
    let now = 1000
    const wakes = new ApprovalWakes({ graceMs: 5000, now: () => now })
    expect(wakes.due([card('a')])).toEqual([])
    now += 4999
    expect(wakes.due([card('a')])).toEqual([])
    now += 1
    const due = wakes.due([card('a')])
    expect(due.map(entry => entry.requestId)).toEqual(['a'])
    for (const entry of due) wakes.mark(entry)
    now += 60_000
    expect(wakes.due([card('a')])).toEqual([])
  })

  it('coalesces a burst: once one card of a controller is due, its younger cards ride along', () => {
    let now = 0
    const wakes = new ApprovalWakes({ graceMs: 5000, now: () => now })
    wakes.due([card('a')])
    now = 3000
    wakes.due([card('a'), card('b'), card('c', { controller: 'other' })])
    now = 5000
    // a is due; b (2 s old) comes with it; c belongs to another controller and is not due yet.
    expect(wakes.due([card('a'), card('b'), card('c', { controller: 'other' })]).map(entry => entry.requestId)).toEqual(['a', 'b'])
  })

  it('leaves a card alone while the stronger review answers it, and wakes once it hands the card to the owner', () => {
    let now = 0
    const wakes = new ApprovalWakes({ graceMs: 1000, now: () => now })
    wakes.due([card('a', { reviewPhase: 'reviewing' })])
    now = 10_000
    expect(wakes.due([card('a', { reviewPhase: 'reviewing' })])).toEqual([])
    expect(wakes.due([card('a', { reviewPhase: 'owner' })])).toEqual([])
    now = 11_000
    expect(wakes.due([card('a', { reviewPhase: 'owner' })]).map(entry => entry.requestId)).toEqual(['a'])
  })

  it('counts a card raised before it was first seen from when it was raised, and forgets answered cards', () => {
    let now = 100_000
    const wakes = new ApprovalWakes({ graceMs: 5000, now: () => now })
    expect(wakes.due([card('old', { requestedAt: 90_000 })]).map(entry => entry.requestId)).toEqual(['old'])
    wakes.due([card('b')])
    // b was answered (no longer pending) and is raised again later: its clock starts over.
    now = 104_000
    wakes.due([])
    expect(wakes.due([card('b')])).toEqual([])
  })

  it('tells the request apart by conversation, runtime and kind', () => {
    const wakes = new ApprovalWakes({ graceMs: 0 })
    const first = card('a')
    wakes.mark(first)
    expect(wakes.due([first, card('a', { runtimeId: 'r2' }), card('a', { kind: 'permission' })]).map(entry => [entry.runtimeId, entry.kind])).toEqual([['r2', 'approval'], ['r1', 'permission']])
  })
})

describe('approval wake texts', () => {
  it('names each card with the exact call that answers it', () => {
    const text = controllerWakeText([card('req-1', { class: 'shared', attention: 'a shared action (install)', reason: undefined }), card('grant:9', { kind: 'permission', tool: 'Write', action: 'C:/x/y.ts', reason: 'fix the build' })], { canAnswer: true })
    expect(text).toMatch(/^\[Conductor\] Your coworkers are waiting on 2 approvals/)
    expect(text).toContain('"Worker" (worker) approval req-1: Bash "npm install left-pad" (class shared; needs a careful look: a shared action (install))')
    expect(text).toContain('agents.approve({agentSessionId:"worker", requestId:"req-1", decision:"allow"|"deny", reason:"…"})')
    expect(text).toContain('permissions.decide({agentSessionId:"worker", requestId:"grant:9", decision:"approve-once"|"approve-session"|"deny"})')
    expect(text).toContain('reason: fix the build')
    expect(text).toMatch(/do not poll agents\.approvals/)
  })

  it('keeps an anonymous coworker\'s action out, and says who answers when the recipient cannot', () => {
    const text = awaitWakeText([card('a', { reason: 'secret plan' })], { canAnswer: false, reason: 'W5', sealed: () => true })
    expect(text).toMatch(/Your wait \(W5\) ended because a conversation you wait for is asking for an approval/)
    expect(text).not.toContain('left-pad')
    expect(text).not.toContain('secret plan')
    expect(text).toContain('the owner answers it in that tab')
  })
})
