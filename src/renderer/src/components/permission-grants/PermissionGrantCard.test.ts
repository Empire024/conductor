import { describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { grantAnswerable, liveGrantStatus, PermissionGrantCard, retryWaiting, type GrantCardRequest } from './PermissionGrantCard'

const request: GrantCardRequest = {
  tool: 'Bash', action: 'Run a command', resource: 'ssh -i key root@192.0.2.10 bash -s < app/prod/fix-pool.sh', host: '192.0.2.10', class: 'external',
  category: 'Modify Shared Resources', rule: 'Bash(ssh -i key root@192.0.2.10 bash -s < app/prod/fix-pool.sh)', rollback: 'restore the two backups and restart'
}

const buttons = (node: ReactNode, found: Array<ReactElement<Record<string, unknown>>> = []): Array<ReactElement<Record<string, unknown>>> => {
  if (Array.isArray(node)) { for (const child of node) buttons(child, found); return found }
  if (!isValidElement(node)) return found
  const element = node as ReactElement<Record<string, unknown>>
  if (element.type === 'button') found.push(element)
  buttons(element.props.children as ReactNode, found)
  return found
}

describe('a card in the history after a restart (grant-survives-restart)', () => {
  const held = { ...request, id: 'grant:w', source: 'agent' as const, status: 'pending' as const, requestedAt: '2026-09-26T04:00:00.000Z', agentSessionId: 'agent_w' }
  it('is live while the restored request waits, shows an answer given before the restart, and stops asking once gone', () => {
    // Restored: the card asks again.
    expect(liveGrantStatus({ requests: [held], grants: [] }, 'agent_w', 'grant:w', 'pending')).toBe('pending')
    // A copy of the card from before the restart, answered since: its answer, never its buttons.
    expect(liveGrantStatus({ requests: [], grants: [], settled: [{ agentSessionId: 'agent_w', id: 'grant:w', status: 'used' }] }, 'agent_w', 'grant:w', 'pending')).toBe('used')
    expect(liveGrantStatus({ requests: [], grants: [], settled: [{ agentSessionId: 'agent_w', id: 'auto-denial:toolu_1', status: 'denied' }] }, 'agent_w', 'auto-denial:toolu_1', 'pending')).toBe('denied')
    // Neither held nor answered: an agent's request ended with its tab; a denial answers through its timeline.
    expect(liveGrantStatus({ requests: [], grants: [] }, 'agent_w', 'grant:w', 'pending')).toBe('expired')
    expect(liveGrantStatus({ requests: [], grants: [] }, 'agent_w', 'grant:w', 'pending', false)).toBe('pending')
    expect(liveGrantStatus({ requests: [], grants: [] }, 'agent_w', 'auto-denial:toolu_2', 'pending')).toBe('pending')
    // Another conversation's answer is not this card's.
    expect(liveGrantStatus({ requests: [], grants: [], settled: [{ agentSessionId: 'agent_x', id: 'grant:w', status: 'used' }] }, 'agent_w', 'grant:w', 'pending')).toBe('expired')
  })

  it('keeps a held request answerable on a card an earlier runtime drew, and nothing else', () => {
    // After the restart the holder's CLI reconnected under a new runtime: the pane calls the old card not interactive.
    expect(grantAnswerable({ requests: [held], grants: [] }, 'agent_w', 'grant:w', false)).toBe(true)
    expect(grantAnswerable({ requests: [{ ...held, status: 'approved-once' }], grants: [] }, 'agent_w', 'grant:w', false)).toBe(false)
    // A card a handoff moved away (the old tab no longer holds it), or another conversation's request.
    expect(grantAnswerable({ requests: [{ ...held, agentSessionId: 'agent_b' }], grants: [] }, 'agent_w', 'grant:w', false)).toBe(false)
    expect(grantAnswerable({ requests: [], grants: [] }, 'agent_w', 'grant:w', true)).toBe(true)
  })
})

describe('permission grant card', () => {
  it('shows the holder on a card a handoff moved, and no answers on the old tab card', () => {
    const holder = { agentSessionId: 'agent_b', title: 'Wizard (continued)' }
    const live = renderToStaticMarkup(PermissionGrantCard({ request: { ...request, holder }, status: 'pending', onDecide: () => {} }))
    // Every link of a chain is "Wizard (continued)"; the id's last segment tells them apart.
    expect(live).toContain('<dt>Holder</dt><dd title="agent_b">Wizard (continued) · b</dd>')
    expect(live).toContain('>Approve once</button>')
    const old = renderToStaticMarkup(PermissionGrantCard({ request: { ...request, holder }, status: 'moved', onDecide: () => {} }))
    expect(old).toContain('<dt>Moved to</dt><dd title="agent_b">Wizard (continued) · b</dd>')
    expect(old).not.toContain('<button')
  })

  it('names the exact action, resource, host, class, category, rule and rollback, with the three answers', () => {
    const html = renderToStaticMarkup(PermissionGrantCard({ request, status: 'pending', onDecide: () => {} }))
    expect(html).toContain('needs-attention')
    expect(html).toContain('Auto mode refused Bash')
    expect(html).toContain('Modify Shared Resources')
    expect(html).toContain('External: reaches another machine or service')
    expect(html).toContain('192.0.2.10')
    expect(html).toContain('Bash(ssh -i key root@192.0.2.10 bash -s &lt; app/prod/fix-pool.sh)')
    expect(html).toContain('restore the two backups and restart')
    expect(html).toContain('>Approve once</button>')
    expect(html).toContain('>Approve for this session</button>')
    expect(html).toContain('>Deny</button>')
  })

  it('sends the chosen answer, offers only Deny when no rule can cover the call, and shows no answers in history', () => {
    const onDecide = vi.fn()
    const [once, session, deny] = buttons(PermissionGrantCard({ request, status: 'pending', onDecide }))
    ;(once!.props.onClick as () => void)(); (session!.props.onClick as () => void)(); (deny!.props.onClick as () => void)()
    expect(onDecide.mock.calls).toEqual([['approve-once'], ['approve-session'], ['deny']])
    const refused = buttons(PermissionGrantCard({ request: { ...request, rule: undefined, refusal: 'This file holds agent permissions.' }, status: 'pending', onDecide, onSwitchToEdit: () => {} }))
    expect(refused.map(button => button.props.className)).toEqual(['sa-grant-deny', 'sa-auto-denial-switch'])
    expect(buttons(PermissionGrantCard({ request, status: 'pending' }))).toEqual([])
  })

  it('shows the answer and a Revoke for a live grant', () => {
    const onRevoke = vi.fn()
    const grant = { id: 'g', agentSessionId: 'a', requestId: 'r', rule: request.rule!, scope: 'session' as const, class: 'external' as const, tool: 'Bash', resource: request.resource, grantedAt: 'now', decidedBy: 'owner' as const, delivery: 'live' as const }
    const card = PermissionGrantCard({ request, status: 'approved-session', grant, onRevoke })
    expect(renderToStaticMarkup(card)).toContain('Approved for this session · in force now')
    const [revoke] = buttons(card)
    ;(revoke!.props.onClick as () => void)()
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('offers "Interrupt and retry" only while the approved retry waits behind a running turn (H06)', () => {
    const grant = { id: 'g', agentSessionId: 'a', requestId: 'r', rule: request.rule!, scope: 'once' as const, class: 'external' as const, tool: 'Bash', resource: request.resource, grantedAt: 'now', decidedBy: 'owner' as const, delivery: 'live' as const }
    const waiting = { requests: [], grants: [grant], waiting: [{ agentSessionId: 'a', grantIds: ['g'], rules: [grant.rule], since: 'now' }] }
    expect(retryWaiting(waiting, grant)).toBe(true)
    expect(retryWaiting({ ...waiting, waiting: undefined }, grant)).toBe(false)
    expect(retryWaiting(waiting, { ...grant, agentSessionId: 'b' })).toBe(false)
    const onInterrupt = vi.fn()
    const card = PermissionGrantCard({ request, status: 'approved-once', grant, onRevoke: () => {}, onInterrupt })
    expect(renderToStaticMarkup(card)).toContain('The retry is queued behind a turn that is still running.')
    const interrupt = buttons(card).find(button => button.props.className === 'sa-grant-interrupt')!
    expect(interrupt.props.children).toBe('Interrupt and retry')
    ;(interrupt.props.onClick as () => void)()
    expect(onInterrupt).toHaveBeenCalledTimes(1)
    expect(renderToStaticMarkup(PermissionGrantCard({ request, status: 'approved-once', grant }))).not.toContain('Interrupt and retry')
  })
})
