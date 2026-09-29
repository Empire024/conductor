import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionGrantRequest, PermissionGrantsState } from '../../../../shared/permission-grants'
import { dockedGrantRequests, revealConversation, REVEAL_CONVERSATION_EVENT } from './PendingGrantDock'

const successor = 'agent_muna1sbz_mvtqaoh'
const asked = (id: string, requestedAt: string, extra: Partial<PermissionGrantRequest> = {}): PermissionGrantRequest & { agentSessionId: string } => ({
  agentSessionId: successor, id, source: 'agent', tool: 'Bash', action: 'Run a command', resource: `bash ${id}.sh`, class: 'local', rule: `Bash(bash ${id}.sh)`,
  status: 'pending', requestedAt, holder: { agentSessionId: successor, title: 'Haftheme controller (launch, successor 2)' }, ...extra
})

describe('the waiting permission cards pinned above the composer (grant-cards-lost-at-handoff)', () => {
  it('lists every request this conversation holds pending, oldest first, from the grants state rather than the timeline', () => {
    // Haftheme 2026-09-29: four cards moved to the successor by agents.handoff sat among its first
    // items, paged out of a 324-item timeline; the state still held them pending.
    const state: PermissionGrantsState = {
      requests: [
        asked('grant:step2', '2026-09-29T22:56:22.266Z'), asked('grant:step1', '2026-09-29T22:56:20.125Z'),
        asked('grant:answered', '2026-09-29T22:50:00.000Z', { status: 'approved-once' }),
        { ...asked('grant:elsewhere', '2026-09-29T22:56:00.000Z'), agentSessionId: 'agent_other' }
      ],
      grants: []
    }
    expect(dockedGrantRequests(state, successor).map(request => request.id)).toEqual(['grant:step1', 'grant:step2'])
    // A card already in view at the live end is not shown twice.
    expect(dockedGrantRequests(state, successor, new Set(['grant:step2'])).map(request => request.id)).toEqual(['grant:step1'])
    expect(dockedGrantRequests(state, 'agent_mulrrkjd_fm0lha3')).toEqual([])
  })

  describe('a conversation link or Needs attention row reveals the tab it names', () => {
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
    it('tells the pane now and again once a pane mounted by the focus can listen', () => {
      vi.useFakeTimers()
      const target = new EventTarget()
      vi.stubGlobal('window', Object.assign(target, { setTimeout: globalThis.setTimeout }))
      const seen: unknown[] = []
      target.addEventListener(REVEAL_CONVERSATION_EVENT, event => seen.push((event as CustomEvent).detail))
      revealConversation(successor)
      expect(seen).toEqual([{ agentSessionId: successor }])
      vi.advanceTimersByTime(300)
      expect(seen).toEqual([{ agentSessionId: successor }, { agentSessionId: successor }])
      revealConversation(undefined)
      vi.runAllTimers()
      expect(seen).toHaveLength(2)
    })
  })
})
