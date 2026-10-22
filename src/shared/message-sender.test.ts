import { describe, expect, it } from 'vitest'
import { CONDUCTOR_ORIGIN, isOwnMessage, messageSenderOf } from './message-sender'

describe('who sent a user-role message', () => {
  it('is the owner only when nothing says otherwise', () => {
    expect(messageSenderOf({ text: 'fix the header' })).toEqual({ kind: 'owner', label: 'You' })
    expect(messageSenderOf({ text: 'I said [Conductor] earlier' })).toMatchObject({ kind: 'owner' })
    expect(isOwnMessage({ text: 'plain' })).toBe(true)
  })

  it('names another conversation by its origin, so it can be opened', () => {
    expect(messageSenderOf({ text: 'Done: shipped 1a2b', origin: { agentSessionId: 'agent_abc123', label: 'Fixer' } })).toEqual({ kind: 'agent', label: 'Fixer', agentSessionId: 'agent_abc123' })
    expect(isOwnMessage({ text: 'x', origin: { agentSessionId: 'agent_abc123', label: 'Fixer' } })).toBe(false)
  })

  it('tells Conductor, a paired machine and a scheduled task apart from agents', () => {
    expect(messageSenderOf({ text: 'continue', origin: CONDUCTOR_ORIGIN })).toEqual({ kind: 'conductor', label: 'Conductor' })
    expect(messageSenderOf({ text: 'x', origin: { agentSessionId: 'durable-job', label: 'Durable job' } })).toMatchObject({ kind: 'conductor' })
    expect(messageSenderOf({ text: 'x', origin: { agentSessionId: 'remote:peer1', label: 'Lap (remote)', authority: { kind: 'remote-peer', peerId: 'peer1', projectId: 'p' } } })).toEqual({ kind: 'machine', label: 'Lap (remote)' })
    expect(messageSenderOf({ text: 'x', origin: { agentSessionId: 'scheduled-task', label: 'Scheduled task' } })).toEqual({ kind: 'schedule', label: 'Scheduled task' })
  })

  it('reads the sender from the text when an older journal kept no origin', () => {
    expect(messageSenderOf({ text: '[Conductor] approved: Bash(npm test); retry it now' })).toEqual({ kind: 'conductor', label: 'Conductor' })
    expect(messageSenderOf({ text: '[From HAF Ops (agent_mvx1abcd, project haf-stuff)] the rosin room is at 180' })).toEqual({ kind: 'agent', label: 'HAF Ops', agentSessionId: 'agent_mvx1abcd' })
    expect(messageSenderOf({ text: '[From Worker 2 (agent_q9w8e7r6), workspace "Main"] overlap on app.css' })).toEqual({ kind: 'agent', label: 'Worker 2', agentSessionId: 'agent_q9w8e7r6' })
  })
})
