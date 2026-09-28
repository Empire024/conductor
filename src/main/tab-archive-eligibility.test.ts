import { describe, expect, it } from 'vitest'
import type { PaneTab } from '../shared/models'
import type { SessionProjection } from '../shared/structured-agent'
import type { FinishTarget } from './coworker-autoclose'
import { archiveRefusal, archiveRefusalMessage, TabArchiver } from './tab-archive-eligibility'

const state = (patch: Partial<SessionProjection> = {}): SessionProjection => ({ phase: 'completed', items: [{ id: 'i', sequence: 1, timestamp: '2026-09-28T10:00:00.000Z', data: { type: 'text', role: 'assistant', text: 'done' } }], ...patch } as unknown as SessionProjection)
const target = (patch: Partial<FinishTarget> = {}): FinishTarget => ({ agentSessionId: 'agent_a', projectId: 'p', sessionId: 's', tabId: 'tab_a', title: 'Coworker', controller: null, opened: true, wizard: false, controlsLiveCoworkers: false, remote: false, ...patch })

describe('archiveRefusal: the busy / uncollected contract', () => {
  it.each([
    [{ phase: 'running' }, 'its turn is still running'],
    [{ phase: 'interrupting' }, 'its turn is still running'],
    [{ phase: 'waiting_approval' }, 'it is waiting on an approval'],
    [{ phase: 'waiting_input' }, 'it is waiting on an answer to a question'],
    [{ limitResumeAt: '2026-09-28T12:00:00.000Z' }, 'it waits out a usage limit and continues at the reset'],
    [{ queued: true }, 'it has queued messages'],
    [{ pendingSteering: [{ id: 'x', text: 'report', status: 'accepted' }] }, 'a message is being steered into it'],
    [{ backgroundTasks: 2 }, 'it has 2 background tasks still running']
  ] as Array<[Partial<SessionProjection>, string]>)('refuses %j: %s', (patch, reason) => {
    expect(archiveRefusal(target(), state(patch))).toBe(reason)
  })
  it('refuses an unfinished delivery it started, the live wizard, a controller with open coworkers, a remote tab', () => {
    expect(archiveRefusal(target(), state(), 'a git.ship delivery it started is still running')).toBe('a git.ship delivery it started is still running')
    expect(archiveRefusal(target({ wizard: true }), state())).toBe('it is the live wizard')
    expect(archiveRefusal(target({ controlsLiveCoworkers: true }), state())).toMatch(/controls open coworkers/)
    expect(archiveRefusal(target({ remote: true }), state())).toBe('it runs on another machine')
  })
  it('lets a settled conversation, a never-started tab and a non-agent tab go', () => {
    expect(archiveRefusal(target(), state())).toBeNull()
    expect(archiveRefusal(undefined, null)).toBeNull()
    expect(archiveRefusalMessage('Coworker: llama', 'its turn is still running')).toBe('“Coworker: llama” was not archived: its turn is still running.')
  })
})

describe('TabArchiver', () => {
  it('closes the eligible tabs one request at a time and names every refused one', async () => {
    const tabs: Record<string, PaneTab> = {
      tab_a: { id: 'tab_a', kind: 'agent', title: 'Busy coworker', resourceId: 'agent_a' },
      tab_b: { id: 'tab_b', kind: 'agent', title: 'Done coworker', resourceId: 'agent_b' },
      tab_t: { id: 'tab_t', kind: 'terminal', title: 'Shell', resourceId: 'terminal_t' }
    }
    const phases: Record<string, string> = { agent_a: 'running', agent_b: 'completed' }
    const closed: string[] = []
    const archiver = new TabArchiver({
      layoutTab: (_p, _s, id) => closed.includes(id) ? undefined : tabs[id],
      targets: () => [target({ agentSessionId: 'agent_a', tabId: 'tab_a' }), target({ agentSessionId: 'agent_b', tabId: 'tab_b', title: 'Done coworker' })],
      snapshot: id => state({ phase: phases[id] as SessionProjection['phase'] }),
      closeAgent: async closing => { closed.push(closing.tabId) },
      closeOther: async (_p, _s, id) => { closed.push(id) }
    })
    const [first, second] = await Promise.all([archiver.archive('p', 's', ['tab_a', 'tab_b', 'tab_t', 'tab_gone']), archiver.archive('p', 's', ['tab_b'])])
    expect(first.archived.map(entry => entry.tabId)).toEqual(['tab_b', 'tab_t'])
    expect(first.refused.map(entry => [entry.tabId, entry.reason])).toEqual([['tab_a', 'its turn is still running'], ['tab_gone', 'it is not open in this workspace']])
    expect(first.refused[0]!.message).toBe('“Busy coworker” was not archived: its turn is still running.')
    // The second request ran after the first, so the tab it named was already gone.
    expect(second).toEqual({ archived: [], refused: [{ tabId: 'tab_b', title: 'tab_b', reason: 'it is not open in this workspace', message: archiveRefusalMessage('tab_b', 'it is not open in this workspace') }] })
    expect(closed).toEqual(['tab_b', 'tab_t'])
  })
})
