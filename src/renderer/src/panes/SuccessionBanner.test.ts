import { describe, expect, it } from 'vitest'
import type { SessionProjection } from '../../../shared/structured-agent'
import { successionOf } from './SuccessionBanner'

const item = (data: SessionProjection['items'][number]['data'], sequence: number) => ({ id: 'item-' + sequence, sequence, runtimeId: 'runtime', timestamp: '2026-09-24T21:00:00.000Z', data }) as SessionProjection['items'][number]

// conductor-task:main-brain-succession
describe('the "Continued in" banner of a main brain that handed itself on', () => {
  it('finds the successor in the notice main posted, and nothing in an ordinary conversation', () => {
    expect(successionOf([])).toBeNull()
    expect(successionOf([item({ type: 'notice', message: 'Usage window reopened' }, 1), item({ type: 'notice', message: 'nudge', payload: { successionNudge: true } }, 2)])).toBeNull()
    const items = [
      item({ type: 'text', role: 'user', text: 'Run the swarm', mode: 'snapshot' }, 1),
      item({ type: 'notice', message: 'Continued in “Swarm (continued)”.', payload: { succession: { agentSessionId: 'agent-2', tabId: 'tab-2', title: 'Swarm (continued)', uri: 'conductor://p/tab/tab-2' } } }, 2),
      item({ type: 'text', role: 'assistant', text: 'Finishing the step.', mode: 'snapshot' }, 3)
    ]
    expect(successionOf(items)).toEqual({ agentSessionId: 'agent-2', tabId: 'tab-2', title: 'Swarm (continued)' })
    // A malformed payload is not a succession.
    expect(successionOf([item({ type: 'notice', message: 'x', payload: { succession: { tabId: 'tab-2' } } }, 1)])).toBeNull()
  })
})
