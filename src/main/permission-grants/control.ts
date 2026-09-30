import type { GrantDecision } from '../../shared/permission-grants'
import type { AgentGrantRequest, PermissionGrants } from './service'

/** The app-control methods (agent-control.ts delegates every `permissions.*` call here). */
export const PERMISSION_METHOD_SIGNATURES: Record<string, string> = {
  'permissions.request': '({command}|{path}|{url}, tool?, reason, rollback?) — ask the owner for exactly one call the classifier refused or would refuse: command for Bash (tool:"PowerShell" for PowerShell), path for Write (tool:"Edit" for Edit), url for WebFetch. The owner gets one card with Approve once / Approve for this session / Deny; you are then told "[Conductor] approved: <rule>; retry it now" (run exactly that call, unchanged) or that it was denied. Write a script and ask for running that script rather than one long command; never ask for edits to permission settings',
  'permissions.list': '({agentSessionId?}) — your own open requests and live grants; the owner or a wizard tab may name a conversation',
  'permissions.revoke': '({grantId, agentSessionId?}) — withdraw a live grant at once; your own, or any for the owner or a wizard tab',
  'permissions.withdraw': '({requestId, reason, agentSessionId?}) — take back your own PENDING request (one you asked, or one a handoff moved to you) that is no longer needed: its card stops asking the owner and reads expired with your reason; returns {withdrawn:false,status} when it was already answered. The owner or a wizard tab may name a conversation. permissions.revoke is for live grants'
}
/** Only the owner's credential or a wizard tab sees and may call this. The same authority as
 *  agents.approve (wizard-approvals.ts): the owner answers any conversation of the project; a
 *  wizard holds that authority, its own requests included, plus the coworkers it controls anywhere
 *  and a co-open project's wizard and its coworkers. */
export const PERMISSION_OWNER_SIGNATURES: Record<string, string> = {
  'permissions.decide': '({agentSessionId, requestId, decision: "approve-once"|"approve-session"|"deny"}) — owner credential or wizard tab only: answer a permission request for the owner, the same authority as agents.approve: the owner answers any conversation of this project, a wizard the same plus its own requests (and those a handoff moved to it), the coworkers it controls in other projects, and the wizard of a project co-opened in this window and its coworkers; any class, local, shared, destructive or external (production included), so review the exact call, reason and rollback first. An approval of a conversation whose turn is still running interrupts that turn at once, so the retry runs as a message of its own'
}
export const PERMISSION_METHODS = [...Object.keys(PERMISSION_METHOD_SIGNATURES), ...Object.keys(PERMISSION_OWNER_SIGNATURES)]

export interface PermissionCallScope {
  agentSessionId: string; owner?: boolean; wizard?: boolean
  /** Whether this caller may answer for that conversation: agents.approve's answerable set (the
   *  project's conversations for the owner, a wizard's coworkers and co-open projects' wizards with
   *  their coworkers). permissions.decide requires it. */
  answers?: (agentSessionId: string) => boolean
}

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
    return { requestId: created.id, status: created.status, class: created.class, ...(created.rule ? { rule: created.rule } : { refusal: created.refusal }), next: created.rule ? (scope.wizard ? `You hold the owner's authority: answer it yourself with permissions.decide({agentSessionId:"${scope.agentSessionId}", requestId:"${created.id}", decision}), then run exactly that call once when "[Conductor] approved: …; retry it now" arrives.` : 'Wait for "[Conductor] approved: …; retry it now", then run exactly that call once. Carry on with other work meanwhile.') : 'No narrow rule can cover this; do not retry it. Report it as blocked or find another way the owner would expect.' }
  }
  if (method === 'permissions.list') return grants.list(target())
  if (method === 'permissions.revoke') return { revoked: await grants.revoke(target(), text(args.grantId, 'grantId', true)!) }
  if (method === 'permissions.withdraw') {
    const unknown = Object.keys(args).filter(key => !['requestId', 'reason', 'agentSessionId'].includes(key))
    if (unknown.length) throw new Error(`permissions.withdraw does not take ${unknown.join(', ')}; it takes {requestId, reason}`)
    return grants.withdrawRequest(target(), text(args.requestId, 'requestId', true)!, text(args.reason, 'reason', true)!)
  }
  if (method === 'permissions.decide') {
    if (!sovereign) throw new Error('permissions.decide answers only the owner\'s own control credential or a wizard tab')
    const agentSessionId = text(args.agentSessionId, 'agentSessionId', true)!
    const requestId = text(args.requestId, 'requestId', true)!
    // Its own, or one a handoff moved to it, too: the wand holds the owner's authority (owner
    // 2026-09-30, "wizard means wizard"); the request records who answered it.
    if (!scope.answers?.(agentSessionId) && !(scope.wizard && grants.holder(agentSessionId, requestId) === scope.agentSessionId)) throw new Error(scope.owner ? 'No such agent conversation in this project' : 'That conversation is neither in this project, one of your coworkers, nor a co-open project\'s wizard or its coworkers')
    // Every class, as in the card (owner decision 2026-09-28, H13).
    return grants.decide(agentSessionId, requestId, text(args.decision, 'decision', true) as GrantDecision, scope.owner ? 'owner' : 'wizard')
  }
  throw new Error(`Unknown permissions method: ${method}`)
}
