import { describe, expect, it } from 'vitest'
import { supervisorTab } from './supervisor-overview'
import type { SessionProjection, TimelineItem } from '../shared/structured-agent'

const item = (sequence: number, data: TimelineItem['data'], parentId?: string): TimelineItem => ({ id: `i${sequence}`, runtimeId: 'r', sequence, timestamp: new Date(Date.UTC(2026, 8, 29, 23, sequence)).toISOString(), data, ...(parentId ? { parentId } : {}) })
const state = (items: TimelineItem[], extra: Partial<SessionProjection> = {}): SessionProjection => ({ sessionId: 's', runtimeId: 'r', phase: 'completed', sequence: items.length, items, settings: {} as SessionProjection['settings'], title: 'T', archived: false, truncated: false, ...extra })
const base = { agentSessionId: 'agent_a', tabId: 'tab_a', title: 'Haftheme wizard', projectId: 'p', project: 'Haftheme', workspaceId: 'w', provider: 'claude', phase: 'completed', backgroundTasks: 0, wizard: true, controller: null, lastActivityAt: null }

describe('supervisorTab', () => {
  it('carries the refusal text and recipient of a rejected send_message, the last top-level answer and the wait with its deadline', () => {
    const row = supervisorTab(base, state([
      item(1, { type: 'text', role: 'assistant', text: 'W5 is done.' } as TimelineItem['data']),
      item(2, { type: 'text', role: 'assistant', text: 'sub-agent chatter' } as TimelineItem['data'], 'i1'),
      item(3, { type: 'tool', name: 'mcp__conductor__send_message', status: 'rejected', input: { agentSessionId: 'agent_waiter', text: 'safe' }, output: 'PreToolUse hook error: A durable approval denial protects this project target.' } as unknown as TimelineItem['data'])
    ], { limitResumeAt: '2026-09-30T02:00:00.000Z' }), { agents: ['agent_b'], since: '2026-09-29T23:44:00.000Z', sinceSequence: 1, deadline: '2026-09-30T00:44:00.000Z' } as never)
    expect(row.lastTool).toMatchObject({ name: 'mcp__conductor__send_message', status: 'rejected', target: 'agent_waiter', output: expect.stringContaining('durable approval denial') })
    expect(row.lastAnswer).toBe('W5 is done.')
    expect(row.awaiting).toEqual({ agents: ['agent_b'], since: '2026-09-29T23:44:00.000Z', deadline: '2026-09-30T00:44:00.000Z', reason: null })
    expect(row.limitResumeAt).toBe('2026-09-30T02:00:00.000Z')
  })

  it('counts pending cards by who answers them and leaves the output of a completed tool out', () => {
    const row = supervisorTab(base, state([
      item(1, { type: 'tool', name: 'Bash', status: 'completed', input: { command: 'npm test' }, output: 'ok' } as unknown as TimelineItem['data']),
      item(2, { type: 'interaction', interaction: { id: 'q1', kind: 'approval', status: 'pending', title: 'Run it?' } } as unknown as TimelineItem['data']),
      item(3, { type: 'interaction', interaction: { id: 'q2', kind: 'approval', status: 'pending', title: 'And this?', review: { phase: 'reviewing' } } } as unknown as TimelineItem['data'])
    ]), null)
    expect(row.lastTool).toEqual({ name: 'Bash', status: 'completed', at: expect.any(String) })
    expect(row.pending).toEqual({ owner: 1, reviewer: 1 })
    expect(row.awaiting).toBeNull()
  })

  it('answers for a tab with no projection', () => {
    expect(supervisorTab(base, null, null)).toMatchObject({ lastTool: null, lastAnswer: null, lastError: null, limitResumeAt: null, pending: { owner: 0, reviewer: 0 } })
  })
})
