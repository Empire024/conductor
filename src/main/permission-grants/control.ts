import type { GrantDecision } from '../../shared/permission-grants'
import type { AgentGrantRequest, PermissionGrants } from './service'

/** The app-control methods (agent-control.ts delegates every `permissions.*` call here). */
export const PERMISSION_METHOD_SIGNATURES: Record<string, string> = {
  'permissions.request': '({command}|{path}|{url}, tool?, reason, rollback?) — ask the owner for exactly one call the classifier refused or would refuse: command for Bash (tool:"PowerShell" for PowerShell), path for Write (tool:"Edit" for Edit), url for WebFetch. The owner gets one card with Approve once / Approve for this session / Deny; you are then told "[Conductor] approved: <rule>; retry it now" (run exactly that call, unchanged) or that it was denied. Write a script and ask for running that script rather than one long command; never ask for edits to permission settings',
  'permissions.list': '({agentSessionId?}) — your own open requests and live grants; the owner or a wizard tab may name a conversation',
  'permissions.revoke': '({grantId, agentSessionId?}) — withdraw a live grant at once; your own, or any for the owner or a wizard tab'
}
/** Only the owner's credential or a wizard tab sees and may call this; a wizard answers local actions only. */
export const PERMISSION_OWNER_SIGNATURES: Record<string, string> = {
  'permissions.decide': '({agentSessionId, requestId, decision: "approve-once"|"approve-session"|"deny"}) — answer a permission request for the owner, for local, reversible actions only; shared, destructive and external requests are answered by the owner in the card'
}
export const PERMISSION_METHODS = [...Object.keys(PERMISSION_METHOD_SIGNATURES), ...Object.keys(PERMISSION_OWNER_SIGNATURES)]

export interface PermissionCallScope { agentSessionId: string; owner?: boolean; wizard?: boolean }

const text = (value: unknown, name: string, required = false): string | undefined => {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 8000) throw new Error(`${name} must be a non-empty string`)
  return value
}

export async function callPermissions(grants: PermissionGrants, scope: PermissionCallScope, method: string, args: Record<string, unknown>): Promise<unknown> {
  const sovereign = scope.owner === true || scope.wizard === true
  const target = (): string => {
    const named = text(args.agentSessionId, 'agentSessionId')
    if (named && named !== scope.agentSessionId && !sovereign) throw new Error('Only the owner or a wizard tab may name another conversation')
    return named ?? scope.agentSessionId
  }
  if (method === 'permissions.request') {
    const allowed = new Set(['tool', 'command', 'path', 'url', 'reason', 'rollback'])
    const unknown = Object.keys(args).filter(key => !allowed.has(key))
    if (unknown.length) throw new Error(`permissions.request does not take ${unknown.join(', ')}`)
    const request: AgentGrantRequest = { tool: text(args.tool, 'tool'), command: text(args.command, 'command'), path: text(args.path, 'path'), url: text(args.url, 'url'), reason: text(args.reason, 'reason', true), rollback: text(args.rollback, 'rollback') }
    const created = grants.request(scope.agentSessionId, request)
    return { requestId: created.id, status: created.status, class: created.class, ...(created.rule ? { rule: created.rule } : { refusal: created.refusal }), next: created.rule ? 'Wait for "[Conductor] approved: …; retry it now", then run exactly that call once. Carry on with other work meanwhile.' : 'No narrow rule can cover this; do not retry it. Report it as blocked or find another way the owner would expect.' }
  }
  if (method === 'permissions.list') return grants.list(target())
  if (method === 'permissions.revoke') return { revoked: await grants.revoke(target(), text(args.grantId, 'grantId', true)!) }
  if (method === 'permissions.decide') {
    if (!sovereign) throw new Error('permissions.decide answers only the owner\'s own control credential or a wizard tab')
    const agentSessionId = text(args.agentSessionId, 'agentSessionId', true)!
    if (agentSessionId === scope.agentSessionId && !scope.owner) throw new Error('A conversation cannot answer its own permission request')
    // Through app control an answer is automation (a wizard tab, or a script holding the owner's
    // credential), so it is held to local actions either way: shared, destructive and external
    // requests are answered only by the owner in the card.
    return grants.decide(agentSessionId, text(args.requestId, 'requestId', true)!, text(args.decision, 'decision', true) as GrantDecision, 'wizard')
  }
  throw new Error(`Unknown permissions method: ${method}`)
}
