import { describe, expect, it } from 'vitest'
import { createLiveLogState, formatLiveEvents } from './cli-live-log'
import type { AgentEvent, AgentEventData } from '../../../shared/structured-agent'

let sequence = 0
const event = (data: AgentEventData, itemId?: string, extra: Partial<AgentEvent> = {}): AgentEvent => ({ schemaVersion: 1, id: 'event-' + ++sequence, sequence, sessionId: 'chat', runtimeId: 'runtime', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: 'fixture', timestamp: '2026-09-24T00:00:00.000Z', itemId, data, ...extra })
// Colors are for the terminal; the assertions read the words.
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

describe('live CLI activity log', () => {
  it('writes a turn as a terminal would: prompt, streamed answer once, tool call with output and its end', () => {
    const state = createLiveLogState()
    const log = [
      formatLiveEvents([event({ type: 'session', phase: 'running' }), event({ type: 'text', role: 'user', text: 'Run the tests', mode: 'snapshot' }, 'prompt')], state),
      formatLiveEvents([event({ type: 'text', role: 'assistant', text: 'Running ', mode: 'delta' }, 'answer'), event({ type: 'text', role: 'assistant', text: 'them now.', mode: 'delta' }, 'answer')], state),
      // The closing snapshot repeats the deltas and must not print them twice.
      formatLiveEvents([event({ type: 'text', role: 'assistant', text: 'Running them now.', mode: 'snapshot' }, 'answer')], state),
      formatLiveEvents([event({ type: 'tool', name: 'Bash', input: { command: 'npm test' }, status: 'running' }, 'tool')], state),
      formatLiveEvents([event({ type: 'tool', name: 'Bash', status: 'running', output: 'PASS 12\n', outputMode: 'delta' }, 'tool')], state),
      formatLiveEvents([event({ type: 'tool', name: 'Bash', status: 'failed', exitCode: 1, output: 'PASS 12\n', outputMode: 'snapshot' }, 'tool')], state),
      formatLiveEvents([event({ type: 'session', phase: 'completed' })], state)
    ].map(plain).join('')
    expect(log).toBe('── running ──\r\n❯ Run the tests\r\n● Running them now.\r\n● Bash npm test\r\n    PASS 12\r\n    ⎿ failed\r\n── completed ──\r\n')
    expect(log.match(/Running them now/g)).toHaveLength(1)
  })

  it('shows a long output as a bounded head and says where the rest is', () => {
    const state = createLiveLogState()
    const text = plain(formatLiveEvents([
      event({ type: 'tool', name: 'Bash', input: { command: 'cat big.log' }, status: 'running' }, 'tool'),
      event({ type: 'tool', name: 'Bash', status: 'running', output: 'x'.repeat(5000), outputMode: 'delta' }, 'tool'),
      event({ type: 'tool', name: 'Bash', status: 'running', output: 'y'.repeat(100), outputMode: 'delta' }, 'tool')
    ], state))
    expect(text.match(/x/g)).toHaveLength(2400)
    expect(text).not.toContain('y')
    expect(text).toContain('(full output in Chat)')
  })

  it('shows what Chat hides: approvals, errors and the runtime diagnostics', () => {
    const text = plain(formatLiveEvents([
      event({ type: 'interaction', interaction: { id: 'r', kind: 'approval', title: 'Run rm -rf out', input: {}, choices: [], status: 'pending' } }, undefined, { requestId: 'r' }),
      event({ type: 'interaction', interaction: { id: 'r', kind: 'approval', title: 'Run rm -rf out', input: {}, choices: [], status: 'resolved', outcome: 'accept' } }, undefined, { requestId: 'r' }),
      event({ type: 'notice', message: 'Claude process diagnostic', payload: { stderr: 'warning: slow disk\n' } }, undefined, { native: { method: 'stderr' } }),
      event({ type: 'error', message: 'Usage limit reached' })
    ], createLiveLogState()))
    expect(text).toContain('? Run rm -rf out  (answer in Chat)\r\n    ⎿ accept')
    expect(text).toContain('· warning: slow disk')
    expect(text).toContain('✗ Usage limit reached')
  })
})
