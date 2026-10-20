import { describe, expect, it } from 'vitest'
import { supervisorTab } from './supervisor-overview'
import type { SessionProjection, TimelineItem } from '../shared/structured-agent'

const item = (sequence: number, data: TimelineItem['data'], parentId?: string): TimelineItem => ({ id: `i${sequence}`, runtimeId: 'r', sequence, timestamp: new Date(Date.UTC(2026, 8, 29, 23, sequence)).toISOString(), data, ...(parentId ? { parentId } : {}) })
const state = (items: TimelineItem[], extra: Partial<SessionProjection> = {}): SessionProjection => ({ sessionId: 's', runtimeId: 'r', phase: 'completed', sequence: items.length, items, settings: {} as SessionProjection['settings'], title: 'T', archived: false, truncated: false, ...extra })
const base = { agentSessionId: 'agent_a', tabId: 'tab_a', title: 'Haftheme wizard', projectId: 'p', project: 'Haftheme', workspaceId: 'w', provider: 'claude', phase: 'completed', backgroundTasks: 0, wizard: true, controller: null, successor: null, lastActivityAt: null }

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

  const allowDeny = [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }]
  const card = (sequence: number, interaction: Record<string, unknown>, runtimeId = 'r'): TimelineItem => ({ ...item(sequence, { type: 'interaction', interaction: { kind: 'approval', status: 'pending', title: 'Run it?', input: {}, choices: allowDeny, ...interaction } } as unknown as TimelineItem['data']), runtimeId })

  it('counts pending cards by who answers them and leaves the output of a completed tool out', () => {
    const row = supervisorTab(base, state([
      item(1, { type: 'tool', name: 'Bash', status: 'completed', input: { command: 'npm test' }, output: 'ok' } as unknown as TimelineItem['data']),
      card(2, { id: 'q1' }),
      card(3, { id: 'q2', title: 'And this?', review: { phase: 'reviewing' } })
    ]), null)
    expect(row.lastTool).toEqual({ name: 'Bash', status: 'completed', at: expect.any(String) })
    expect(row.pending).toEqual({ owner: 1, reviewer: 1 })
    expect(row.awaiting).toBeNull()
  })

  it('counts only cards the attached runtime can take and that offer an allow (owner rule 2026-10-20)', () => {
    const row = supervisorTab(base, state([
      card(1, { id: 'live' }),
      card(2, { id: 'old-runtime' }, 'r-before-restart'),
      card(3, { id: 'deny-only', choices: [{ id: 'deny', label: 'Deny' }] }),
      card(4, { id: 'no-choice', choices: [] }),
      card(5, { id: 'allow-disabled', choices: [{ id: 'allow', label: 'Allow', disabled: true }, { id: 'deny', label: 'Deny' }] }),
      card(6, { id: 'question', kind: 'question', choices: [] }),
      card(7, { id: 'async-current', kind: 'question', choices: [], input: { protocol: 'codex-async-question', threadId: 'thread-now' } }, 'r-earlier'),
      card(8, { id: 'async-stale', kind: 'question', choices: [], input: { protocol: 'codex-async-question', threadId: 'thread-old' } }, 'r-earlier')
    ], { nativeSessionId: 'thread-now' }), null)
    expect(row.pending).toEqual({ owner: 3, reviewer: 0 })
  })

  it('counts permission-grant requests that can be approved, in place of their native card', () => {
    const call = { runtimeId: 'r', nativeSessionId: 'n', toolUseId: 't', tool: 'Bash', argsDigest: 'd', requestId: '7' }
    const items = [card(1, { id: 'native-card', permissionGrantId: 'native-grant:r:7' }), card(2, { id: 'plain' })]
    // Without the grant state, the native card stands for itself.
    expect(supervisorTab(base, state(items), null).pending).toEqual({ owner: 2, reviewer: 0 })
    const row = supervisorTab(base, state(items), null, [
      { source: 'native', status: 'pending', nativeAvailable: true, call },
      { source: 'native', status: 'pending', nativeAvailable: false, call },
      { source: 'agent', status: 'pending', rule: 'Bash(npm test)' },
      { source: 'agent', status: 'pending' },
      { source: 'denial', status: 'denied', rule: 'Write(C:/x)' }
    ])
    expect(row.pending).toEqual({ owner: 3, reviewer: 0 })
  })

  it('answers for a tab with no projection', () => {
    expect(supervisorTab(base, null, null)).toMatchObject({ lastTool: null, lastAnswer: null, lastError: null, limitResumeAt: null, pending: { owner: 0, reviewer: 0 } })
  })
})
