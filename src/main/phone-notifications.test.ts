import { describe, expect, it } from 'vitest'
import type { PhoneSessionSummary } from '../shared/phone-access'
import type { TimelineItem } from '../shared/structured-agent'
import { autoModeDenialMessage, autoModeDenialPayload } from '../shared/auto-mode-denial'
import { autoModeDenials, describeDenials, phoneSessionState } from './phone-notifications'

const item = (sequence: number, data: TimelineItem['data'], id = `item-${sequence}`): TimelineItem => ({ id, runtimeId: 'r1', sequence, timestamp: `2026-09-22T21:00:0${sequence}.000Z`, data })
const denialItem = (sequence: number, toolUseId: string, tool: string, reason: string, confirmed = false): TimelineItem =>
  item(sequence, { type: 'notice', message: autoModeDenialMessage({ tool, reason }), payload: autoModeDenialPayload({ tool, reason, toolUseId }, confirmed) }, `auto-denial:${toolUseId}`)

const summary: PhoneSessionSummary = { id: 'a', projectId: 'p', projectName: 'P', workspaceId: 'w', workspaceName: 'W', tabId: 't', title: 'Fix it', provider: 'claude', machineId: 'local', machineName: 'MAIN', phase: 'running', activity: 'working', state: 'working', needs: null, updatedAt: 'now', queued: 0, archived: false }

describe('claude auto-mode classifier denials on the phone', () => {
  it('collects the denials a conversation recorded, one per denial even after the result frame confirms it', () => {
    const items = [
      item(1, { type: 'text', role: 'user', text: 'Harden the hosts file', mode: 'snapshot' }),
      item(2, { type: 'tool', name: 'Edit', input: {}, status: 'failed' }),
      denialItem(3, 'toolu_1', 'Edit', 'Security Weaken'),
      item(4, { type: 'notice', message: 'Claude process diagnostic', payload: { stderr: 'noise' } }),
      denialItem(5, 'toolu_2', 'Bash', 'Permission Grant'),
      // The confirmed re-emission lands on the same timeline item and adds nothing.
      denialItem(6, 'toolu_1', 'Edit', 'Security Weaken', true)
    ]
    expect(autoModeDenials(items)).toEqual([
      { id: 'auto-denial:toolu_1', tool: 'Edit', reason: 'Security Weaken' },
      { id: 'auto-denial:toolu_2', tool: 'Bash', reason: 'Permission Grant' }
    ])
    expect(autoModeDenials([])).toEqual([])
  })

  it('pushes "Auto mode refused <tool>: <reason>" once per denial, never on first sight, while the turn is still working', () => {
    const denied = { ...summary, autoModeDenials: [{ id: 'auto-denial:toolu_1', tool: 'Edit', reason: 'Security Weaken' }] }
    let counter = 0
    const nextId = (): string => `n${++counter}`
    // A denial changes no phase, so the state word stays what the turn says.
    expect(phoneSessionState({ phase: 'running' }, 'working')).toBe('working')
    expect(describeDenials(undefined, denied, 'now', nextId)).toEqual([])
    expect(describeDenials({}, denied, 'now', nextId)).toEqual([
      { id: 'n1', kind: 'attention', sessionId: 'a', at: 'now', url: '/#/session/a', title: 'Needs you: Fix it', body: 'Auto mode refused Edit: Security Weaken' }
    ])
    expect(describeDenials({ autoModeDenials: denied.autoModeDenials }, denied, 'now', nextId)).toEqual([])
    const second = { ...denied, autoModeDenials: [...denied.autoModeDenials, { id: 'auto-denial:toolu_2', tool: 'Bash', reason: 'Permission Grant' }] }
    expect(describeDenials({ autoModeDenials: denied.autoModeDenials }, second, 'now', nextId)).toMatchObject([{ id: 'n2', kind: 'attention', body: 'Auto mode refused Bash: Permission Grant' }])
    expect(describeDenials({ autoModeDenials: second.autoModeDenials }, { ...second, autoModeDenials: undefined }, 'now', nextId)).toEqual([])
  })
})
