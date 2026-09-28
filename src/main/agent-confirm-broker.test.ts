import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConfirmBroker, agentConfirmFailure, type AgentConfirmSurface } from './agent-confirm-broker'
import type { AgentConfirmRequest } from '../shared/agent-confirm'

function surface(live = true) {
  const sent: Array<{ channel: string; payload: AgentConfirmRequest | string }> = []
  const window: AgentConfirmSurface & { live: boolean } = {
    live,
    send: vi.fn((channel, payload) => { if (!window.live) return false; sent.push({ channel, payload }); return true }),
    reveal: vi.fn()
  }
  return { window, sent, requests: () => sent.filter(item => item.channel === 'agent-confirm:request').map(item => item.payload as AgentConfirmRequest), cancels: () => sent.filter(item => item.channel === 'agent-confirm:cancel').map(item => item.payload) }
}

describe('agent confirm broker', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('resolves the owner’s answer once the renderer has the request', async () => {
    const s = surface(), broker = new AgentConfirmBroker(() => s.window)
    const answer = broker.request('agent-a', 'Build it?')
    const [request] = s.requests()
    expect(s.window.reveal).toHaveBeenCalledTimes(1)
    broker.received(request!.id)
    broker.respond(request!.id, true)
    await expect(answer).resolves.toBe('allowed')
    const refused = broker.request('agent-a', 'Build it?')
    broker.received(s.requests()[1]!.id); broker.respond(s.requests()[1]!.id, false)
    await expect(refused).resolves.toBe('declined')
    // Answers need no cancel: the renderer already removed the dialog it answered.
    expect(s.cancels()).toEqual([])
  })

  it('reports a request the renderer never acknowledged as undelivered, not declined, and withdraws it', async () => {
    const s = surface(), broker = new AgentConfirmBroker(() => s.window, { deliveryMs: 15_000, answerMs: 120_000 })
    const answer = broker.request('agent-a', 'Build it?')
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(answer).resolves.toBe('undelivered')
    expect(s.cancels()).toEqual([s.requests()[0]!.id])
    expect(broker.list()).toEqual([])
  })

  it('times out an acknowledged but unanswered request and tells the renderer to drop the dead dialog', async () => {
    const s = surface(), broker = new AgentConfirmBroker(() => s.window, { deliveryMs: 15_000, answerMs: 120_000 })
    const answer = broker.request('agent-a', 'Build it?')
    const id = s.requests()[0]!.id
    broker.received(id)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(broker.list()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(answer).resolves.toBe('timeout')
    expect(s.cancels()).toEqual([id])
    // A late click on the withdrawn dialog changes nothing.
    broker.respond(id, true)
    await expect(answer).resolves.toBe('timeout')
  })

  it('asks once for a repeated request from the same caller, and separately for another caller', async () => {
    const s = surface(), broker = new AgentConfirmBroker(() => s.window)
    const first = broker.request('agent-a', 'Build it?'), again = broker.request('agent-a', 'Build it?')
    const other = broker.request('agent-b', 'Build it?')
    expect(s.requests()).toHaveLength(2)
    expect(s.window.reveal).toHaveBeenCalledTimes(3)
    const [mine, theirs] = s.requests()
    broker.received(mine!.id); broker.received(theirs!.id)
    broker.respond(mine!.id, true); broker.respond(theirs!.id, false)
    await expect(first).resolves.toBe('allowed')
    await expect(again).resolves.toBe('allowed')
    await expect(other).resolves.toBe('declined')
  })

  it('keeps waiting requests listable for a renderer that reloaded, and says so when there is no window', async () => {
    const s = surface(), broker = new AgentConfirmBroker(() => s.window)
    void broker.request('agent-a', 'Build it?')
    expect(broker.list()).toEqual([expect.objectContaining({ message: 'Build it?', title: 'Agent request' })])
    await expect(new AgentConfirmBroker(() => null).request('agent-a', 'Build it?')).resolves.toBe('unavailable')
    const closing = surface(false)
    await expect(new AgentConfirmBroker(() => closing.window).request('agent-a', 'Build it?')).resolves.toBe('unavailable')
  })

  it('names each outcome truthfully for the agent, who decided, and the next step it can take', () => {
    expect(agentConfirmFailure('declined', 'build a local update')).toMatch(/^The owner declined to build a local update in Conductor's confirmation dialog, so nothing was done\. Do not ask again.*report that it is blocked/)
    expect(agentConfirmFailure('timeout', 'build a local update')).toMatch(/did not answer.*nothing was done.*did not decline.*ask once more when the owner is back.*wizard tab/)
    expect(agentConfirmFailure('undelivered', 'build a local update')).toMatch(/could not show the owner.*was not asked\. Ask once more.*report it as blocked/)
    expect(agentConfirmFailure('unavailable', 'build a local update')).toMatch(/No Conductor main window.*was not asked\. Report it as blocked/)
    for (const outcome of ['timeout', 'undelivered', 'unavailable'] as const) expect(agentConfirmFailure(outcome, 'x')).not.toMatch(/declined/)
    // Every text ends in something the agent can do, not a bare verdict.
    for (const outcome of ['declined', 'timeout', 'undelivered', 'unavailable'] as const) expect(agentConfirmFailure(outcome, 'x')).toMatch(/nothing was done.*(carry on|report|ask)/i)
  })
})
