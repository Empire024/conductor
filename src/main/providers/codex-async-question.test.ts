import { describe, expect, it } from 'vitest'
import { CodexAdapter } from './codex'
import type { AdapterEvent } from '../../shared/structured-agent'
import type { ThreadItem } from './generated/codex/v2/ThreadItem'
import { replayAgentEvents } from '../../shared/structured-agent-reducer'

const questions = [
  { title: 'May I repair the fault?', options: ['Approve', 'Decline'] },
  { title: 'May the guards rebuild?', options: ['Allow', 'Block'] },
  { title: 'When should the soak run?', options: ['Overnight', 'Later'] }
]

describe('Codex async user questions from actual agentMessage protocol', () => {
  it('emits one stable question card beside the text, with multiple questions and custom answers', () => {
    const events: AdapterEvent[] = []
    const adapter = new CodexAdapter({ executable: 'unused', cwd: '.', runtimeId: 'runtime', settings: { permission: 'auto', plan: false }, emit: event => events.push(event) })
    const internals = adapter as unknown as { threadId: string; item(item: ThreadItem, context: object, complete: boolean, native: AdapterEvent['native']): void }
    internals.threadId = 'thread'
    const item: ThreadItem = { type: 'agentMessage', id: 'call-1', text: 'May I repair the fault?\n- Approve\n- Decline', phase: null, memoryCitation: null, delivery: null, questions }
    const context = { nativeSessionId: 'thread', turnId: 'turn-1' }
    internals.item(item, context, false, { method: 'item/started' })
    internals.item(item, context, true, { method: 'item/completed' })
    const cards = events.filter(event => event.data.type === 'interaction')
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({ requestId: 'codex-async:thread:call-1', data: { interaction: {
      status: 'pending', input: { protocol: 'codex-async-question' }, questions: [
        { id: 'call-1:0', question: questions[0]!.title, options: [{ label: 'Approve' }, { label: 'Decline' }], allowCustom: true },
        { id: 'call-1:1' }, { id: 'call-1:2' }
      ]
    } } })
    expect(cards[1]!.requestId).toBe(cards[0]!.requestId)
    const projection = replayAgentEvents('session', events.map((event, index) => ({ ...event, schemaVersion: 1, id: String(index), sequence: index + 1,
      sessionId: 'session', runtimeId: 'runtime', provider: 'codex' as const, projectId: 'project', workspaceId: 'workspace', cwd: '.', timestamp: '2026-09-28T00:00:00Z' })))
    expect(projection.items.filter(entry => entry.data.type === 'interaction')).toHaveLength(1)
    adapter.dispose()
  })
})
