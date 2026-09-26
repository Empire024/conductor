import { describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionGrantCard, type GrantCardRequest } from './PermissionGrantCard'

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
})
