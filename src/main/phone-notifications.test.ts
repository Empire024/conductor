import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhoneNotification, PhoneSessionSummary } from '../shared/phone-access'
import type { TimelineItem } from '../shared/structured-agent'
import { autoModeDenialMessage, autoModeDenialPayload } from '../shared/auto-mode-denial'
import { autoModeDenials, describeDenials, describeTransition, NOTIFICATION_BATCH_MS, NotificationBatcher, phoneSessionState, type NotificationMoment } from './phone-notifications'

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

describe('phone notification bursts', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T00:38:00.000Z')) })
  afterEach(() => { vi.useRealTimers() })

  const RESET = '2026-10-18T08:50:00.000Z'
  const tab = (id: string, title: string, state: PhoneSessionSummary['state'], extra: Partial<PhoneSessionSummary> = {}): PhoneSessionSummary => ({ ...summary, id, title, state, ...extra })
  const moment = (next: PhoneSessionSummary, from: PhoneSessionSummary['state'] = 'working'): NotificationMoment => ({
    notification: describeTransition({ state: from }, next, 'now', `n-${next.id}-${next.state}`)!, title: next.title, provider: next.provider, resumeAt: next.limitResumeAt
  })
  const batcher = () => {
    const sent: PhoneNotification[] = []
    let ids = 0
    const instance = new NotificationBatcher({ emit: notification => sent.push(notification), now: () => Date.now(), nextId: () => `batch-${++ids}`, providerLabel: id => (id === 'claude' ? 'Claude' : id) })
    return { instance, sent }
  }

  it('sends one usage-limit notification for a swarm that hits the same window, and stays quiet for latecomers', () => {
    const { instance, sent } = batcher()
    for (const [id, title] of [['a', 'Rosin swarm · Opus'], ['b', 'Rosin swarm · Opus 2'], ['c', 'Rosin swarm · Fable'], ['d', 'Controller'], ['e', 'Docs']]) {
      instance.offer(moment(tab(id!, title!, 'limited', { limitResumeAt: RESET })))
      vi.advanceTimersByTime(300)
    }
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(NOTIFICATION_BATCH_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'limited', sessionId: null, url: '/#/tabs', tag: 'usage-limit-claude' })
    expect(sent[0]!.title.startsWith('Usage limit: 5 tabs (Claude) · resumes at ')).toBe(true)
    expect(sent[0]!.body).toContain('Rosin swarm · Fable')
    // A sixth tab reaching the same closed window a minute later is not news, even with a reset a few seconds off.
    vi.advanceTimersByTime(60_000)
    instance.offer(moment(tab('f', 'Late', 'limited', { limitResumeAt: '2026-10-18T08:50:20.000Z' })))
    vi.advanceTimersByTime(NOTIFICATION_BATCH_MS * 2)
    expect(sent).toHaveLength(1)
  })

  it('keeps a lone limit as it was, tagged so the next one replaces it, and announces a different provider or window', () => {
    const { instance, sent } = batcher()
    instance.offer(moment(tab('a', 'Solo', 'limited', { limitResumeAt: RESET })))
    instance.offer(moment(tab('b', 'Sol', 'limited', { provider: 'codex', limitResumeAt: RESET })))
    vi.advanceTimersByTime(NOTIFICATION_BATCH_MS)
    expect(sent.map(entry => [entry.sessionId, entry.title, entry.tag])).toEqual([['a', 'Usage limit: Solo', 'usage-limit-claude'], ['b', 'Usage limit: Sol', 'usage-limit-codex']])
    // The weekly window closing later is a different window.
    instance.offer(moment(tab('c', 'Weekly', 'limited', { limitResumeAt: '2026-10-20T08:00:00.000Z' })))
    vi.advanceTimersByTime(NOTIFICATION_BATCH_MS)
    expect(sent).toHaveLength(3)
    // Once the window has reopened, the same provider closing again is announced again.
    vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
    instance.offer(moment(tab('a', 'Solo', 'limited', { limitResumeAt: '2026-10-21T05:00:00.000Z' })))
    vi.advanceTimersByTime(NOTIFICATION_BATCH_MS)
    expect(sent).toHaveLength(4)
  })

  it('merges finished and failed tabs per kind, keeping coworker and main tasks apart for the per-phone choice', () => {
    const { instance, sent } = batcher()
    instance.offer(moment(tab('a', 'One', 'done', { controllerId: 'boss' })))
    instance.offer(moment(tab('b', 'Two', 'done', { controllerId: 'boss' })))
    instance.offer(moment(tab('c', 'Main', 'done')))
    instance.offer(moment(tab('d', 'Broke', 'failed')))
    instance.offer(moment(tab('e', 'Broke too', 'failed')))
    vi.advanceTimersByTime(NOTIFICATION_BATCH_MS)
    expect(sent.map(entry => [entry.kind, entry.title, entry.isCoworker ?? null])).toEqual([
      ['done', 'Done: 2 conversations', true],
      ['done', 'Done: Main', false],
      ['failed', 'Failed: 2 conversations', null]
    ])
    expect(sent[0]!.body).toBe('One, Two')
  })

  it('never holds or merges a question or an approval', () => {
    const { instance, sent } = batcher()
    instance.offer(moment(tab('a', 'Ships', 'done')))
    const asking = (id: string): NotificationMoment => ({ notification: describeTransition({ state: 'working' }, tab(id, 'Asks ' + id, 'attention', { needs: 'approval', pendingId: 'p-' + id }), 'now', 'q-' + id)!, title: 'Asks ' + id, provider: 'claude' })
    instance.offer(asking('b'))
    instance.offer(asking('c'))
    expect(sent.map(entry => [entry.kind, entry.sessionId])).toEqual([['attention', 'b'], ['attention', 'c']])
    vi.advanceTimersByTime(NOTIFICATION_BATCH_MS)
    expect(sent.map(entry => entry.kind)).toEqual(['attention', 'attention', 'done'])
  })
})
