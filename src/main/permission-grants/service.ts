import { randomUUID } from 'node:crypto'
import { autoModeDenialItemId, autoModeDenialMessage, autoModeDenialPayload, type AutoModeDenial } from '../../shared/auto-mode-denial'
import {
  describeGrantRequest, grantApprovedMessage, grantDeniedMessage, grantNeedsPhone, grantRequestSummary, wizardMayDecide,
  type GrantDecision, type GrantRule, type GrantStatus, type PermissionGrant, type PermissionGrantDecisionResult, type PermissionGrantRequest, type PermissionGrantsState
} from '../../shared/permission-grants'
import type { Json } from '../../shared/structured-agent'

/**
 * One narrow owner approval per sensitive action, consumed by the conversation that asked
 * (docs/permissions-classifier.md). A request comes from a classifier denial the Claude adapter
 * recorded (its notice item in the timeline is the card), or from the agent itself through
 * permissions.request before it tries. The owner answers in the card; a wizard tab may answer
 * only for local, reversible actions. An approval becomes exactly one native allow rule for that
 * one conversation, handed to the running CLI (apply_flag_settings) or, where the CLI cannot take
 * it live, through --settings on its next start. Grants live in memory only: they end with the
 * tab, with this app, when the owner revokes them, or (approve once) when their call has run.
 * Nothing here lets an agent approve its own request.
 */
export interface PermissionGrantPorts {
  now?(): string
  /** A Conductor card in the conversation's timeline (StructuredSessions.notice); false when the
   *  conversation has no live session here. The same itemId replaces the card in place. */
  notice(agentSessionId: string, message: string, payload: Json, itemId: string): boolean
  /** The classifier denial the adapter recorded under this notice item, from the durable timeline. */
  denial(agentSessionId: string, itemId: string): AutoModeDenial | undefined
  /** The provider of the conversation, or undefined when it is not registered. */
  provider(agentSessionId: string): string | undefined
  /** The conversation's working folder, where a relative path in a request is resolved. */
  cwd(agentSessionId: string): string | undefined
  /** Hands the live runtime its current rules; 'offline' when there is none (its next start reads them). */
  apply(agentSessionId: string): Promise<'applied' | 'unsupported' | 'offline'>
  phase(agentSessionId: string): string | undefined
  /** Restarts the idle conversation's runtime on the same native conversation. */
  restart(agentSessionId: string): Promise<void>
  /** Delivers a Conductor message: steered into a running turn, or starting one. */
  tell(agentSessionId: string, text: string): Promise<void>
  /** Phone push for external, shared and destructive requests. */
  phone?(agentSessionId: string, title: string, body: string): void
  changed?(state: PermissionGrantsState): void
  /** Whether the conversation still has a tab in any window. Closing a tab only changes the layout
   *  (its runtime may run on for the undo window), so sweep() asks this rather than waiting for the
   *  runtime to stop. Absent: only closed() ends a conversation's grants. */
  tabOpen?(agentSessionId: string): boolean
  idleWaitMs?: number
  idlePollMs?: number
}

export type GrantActor = 'owner' | 'wizard'
export interface AgentGrantRequest { tool?: string; command?: string; path?: string; url?: string; reason?: string; rollback?: string }

const ACTIVE_PHASES = new Set(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
const AGENT_PREFIX = 'grant:'
const DECIDED: Record<Exclude<GrantDecision, 'deny'>, GrantStatus> = { 'approve-once': 'approved-once', 'approve-session': 'approved-session' }

export class PermissionGrants {
  private readonly requests = new Map<string, Map<string, PermissionGrantRequest>>()
  private readonly grants = new Map<string, PermissionGrant[]>()
  /** Conversations found without a tab once: a tab moving between windows is briefly in neither
   *  layout, so a grant ends only when its tab is missing on two sweeps in a row. */
  private readonly missing = new Set<string>()
  constructor(private readonly ports: PermissionGrantPorts) {}

  private now(): string { return this.ports.now?.() ?? new Date().toISOString() }
  private changed(): void { this.ports.changed?.(this.state()) }

  rules(agentSessionId: string): GrantRule[] {
    return (this.grants.get(agentSessionId) ?? []).map(grant => ({ rule: grant.rule, once: grant.scope === 'once' }))
  }

  /** What the Claude adapter is given (AdapterOptions.permissionGrants). */
  adapterPort(agentSessionId: string): { rules(): GrantRule[]; used(rule: string): void; refused(rule: string): void } {
    return { rules: () => this.rules(agentSessionId), used: rule => this.used(agentSessionId, rule), refused: rule => this.refused(agentSessionId, rule) }
  }

  state(): PermissionGrantsState {
    return {
      requests: [...this.requests].flatMap(([agentSessionId, requests]) => [...requests.values()].map(request => ({ ...request, agentSessionId }))),
      grants: [...this.grants.values()].flat()
    }
  }

  list(agentSessionId: string): { requests: PermissionGrantRequest[]; grants: PermissionGrant[] } {
    return { requests: [...(this.requests.get(agentSessionId)?.values() ?? [])], grants: [...(this.grants.get(agentSessionId) ?? [])] }
  }

  /**
   * The agent asks before it tries, for exactly one call: `command` (Bash, or PowerShell with
   * tool), `path` (Write, or Edit with tool) or `url` (WebFetch). The card appears in its own tab.
   * An identical request still waiting is returned rather than asked twice.
   */
  request(agentSessionId: string, args: AgentGrantRequest): PermissionGrantRequest {
    if (this.ports.provider(agentSessionId) !== 'claude') throw new Error('Permission grants apply to Claude conversations: other runtimes have their own approval cards')
    const cwd = this.ports.cwd(agentSessionId)
    if (!cwd) throw new Error('The conversation is not registered')
    const fields = [args.command, args.path, args.url].filter(value => typeof value === 'string' && value.trim())
    if (fields.length !== 1) throw new Error('Name exactly one of command, path or url')
    const tool = args.command ? (args.tool === 'PowerShell' ? 'PowerShell' : 'Bash') : args.path ? (args.tool === 'Edit' ? 'Edit' : 'Write') : 'WebFetch'
    if (args.tool && args.tool !== tool) throw new Error(`tool ${args.tool} does not go with the field given; use command for Bash or PowerShell, path for Write or Edit, url for WebFetch`)
    const input = args.command ? { command: args.command } : args.path ? { file_path: args.path } : { url: args.url }
    const described = describeGrantRequest({ tool, input, cwd, reason: args.reason, rollback: args.rollback })
    const open = this.requests.get(agentSessionId) ?? new Map<string, PermissionGrantRequest>()
    const existing = [...open.values()].find(request => request.status === 'pending' && request.tool === described.tool && request.resource === described.resource)
    if (existing) return existing
    const request: PermissionGrantRequest = { ...described, id: AGENT_PREFIX + randomUUID(), source: 'agent', status: 'pending', requestedAt: this.now() }
    open.set(request.id, request)
    this.requests.set(agentSessionId, open)
    this.card(agentSessionId, request)
    if (grantNeedsPhone(request)) this.ports.phone?.(agentSessionId, 'Needs your approval', grantRequestSummary(request))
    this.changed()
    return request
  }

  /** Owner (card) or wizard (app control, local actions only) answers one request. */
  async decide(agentSessionId: string, requestId: string, decision: GrantDecision, actor: GrantActor): Promise<PermissionGrantDecisionResult> {
    if (!['approve-once', 'approve-session', 'deny'].includes(decision)) throw new Error('decision must be approve-once, approve-session or deny')
    const request = this.pendingRequest(agentSessionId, requestId)
    if (actor === 'wizard' && !wizardMayDecide(request)) throw new Error(`Only the owner can answer a ${request.class} request; the card is in the conversation's tab`)
    const decidedAt = this.now()
    if (decision === 'deny') {
      this.settle(agentSessionId, request, { status: 'denied', decidedAt, decidedBy: actor })
      await this.ports.tell(agentSessionId, grantDeniedMessage(request)).catch(error => console.warn('The denied grant could not be reported to the conversation', error))
      return { status: 'denied', message: 'Denied; the conversation was told not to retry it.' }
    }
    if (!request.rule) throw new Error(request.refusal ?? 'No narrow rule can cover this request')
    if (this.ports.provider(agentSessionId) !== 'claude') throw new Error('Permission grants apply to Claude conversations only')
    const scope = decision === 'approve-once' ? 'once' : 'session'
    const grant: PermissionGrant = {
      id: randomUUID(), agentSessionId, requestId: request.id, rule: request.rule, scope, class: request.class, tool: request.tool,
      resource: request.resource, grantedAt: decidedAt, decidedBy: actor, delivery: 'pending'
    }
    this.grants.set(agentSessionId, [...(this.grants.get(agentSessionId) ?? []).filter(entry => entry.rule !== grant.rule), grant])
    this.settle(agentSessionId, request, { status: DECIDED[decision], decidedAt, decidedBy: actor })
    const applied = await this.ports.apply(agentSessionId).catch(error => { this.drop(agentSessionId, grant.id); throw error })
    if (applied === 'unsupported') {
      grant.delivery = 'restart'
      this.changed()
      void this.restartThenTell(agentSessionId, grantApprovedMessage(grant.rule, scope))
      return { status: DECIDED[decision], grant, message: 'Approved. This CLI cannot take a rule while it runs, so the conversation restarts with it once its turn ends, then retries.' }
    }
    grant.delivery = applied === 'applied' ? 'live' : 'pending'
    this.changed()
    await this.ports.tell(agentSessionId, grantApprovedMessage(grant.rule, scope))
    return { status: DECIDED[decision], grant, message: `Approved: ${grant.rule}. The conversation was told to retry it.` }
  }

  /** Revoking only narrows: the conversation's own grant, or any grant for the owner or a wizard. */
  async revoke(agentSessionId: string, grantId: string): Promise<boolean> {
    const grant = (this.grants.get(agentSessionId) ?? []).find(entry => entry.id === grantId)
    if (!grant) return false
    this.drop(agentSessionId, grantId)
    this.statusOf(agentSessionId, grant.requestId, 'revoked')
    await this.ports.apply(agentSessionId).catch(error => console.warn('A revoked grant could not be removed from the live conversation; it ends with the runtime', error))
    return true
  }

  /** An approve-once grant's call ran: it is spent and taken back out of the live settings. */
  used(agentSessionId: string, rule: string): void {
    const grant = (this.grants.get(agentSessionId) ?? []).find(entry => entry.rule === rule && entry.scope === 'once')
    if (!grant) return
    this.drop(agentSessionId, grant.id)
    this.statusOf(agentSessionId, grant.requestId, 'used')
    void this.ports.apply(agentSessionId).catch(error => console.warn('A spent grant could not be removed from the live conversation; it ends with the runtime', error))
  }

  /** The classifier refused a call the owner had granted: the rule did not take effect in this CLI
   *  (docs/permissions-classifier.md, precedence UNCONFIRMED). It is withdrawn and the owner told how
   *  to get a one-off approval instead. */
  refused(agentSessionId: string, rule: string): void {
    const grant = (this.grants.get(agentSessionId) ?? []).find(entry => entry.rule === rule)
    if (!grant) return
    this.drop(agentSessionId, grant.id)
    this.statusOf(agentSessionId, grant.requestId, 'ineffective')
    this.ports.notice(agentSessionId, `Conductor handed this conversation ${rule}, but the claude CLI's classifier still refused the call, so this CLI does not let an allow rule decide it. Switch the conversation to Edit mode: the next attempt then asks you with an ordinary Allow card.`, { permissionGrantIneffective: { rule } }, `grant-ineffective:${grant.id}`)
    void this.ports.apply(agentSessionId).catch(() => undefined)
  }

  /** The runtime stopped for good: its requests and grants end with it. */
  closed(agentSessionId: string): void {
    this.missing.delete(agentSessionId)
    if (!this.requests.delete(agentSessionId) && !this.grants.delete(agentSessionId)) return
    this.grants.delete(agentSessionId)
    this.changed()
  }

  /** Ends the grants of every conversation whose tab was closed (tabOpen), and takes them back out
   *  of a runtime that is still running. Cheap when nothing is granted; wiring.ts runs it on a timer. */
  sweep(): void {
    if (!this.ports.tabOpen) return
    for (const agentSessionId of new Set([...this.grants.keys(), ...this.requests.keys()])) {
      if (this.ports.tabOpen(agentSessionId)) { this.missing.delete(agentSessionId); continue }
      if (!this.missing.has(agentSessionId)) { this.missing.add(agentSessionId); continue }
      this.missing.delete(agentSessionId)
      const granted = this.grants.get(agentSessionId) ?? []
      this.grants.delete(agentSessionId)
      for (const grant of granted) this.statusOf(agentSessionId, grant.requestId, 'expired')
      this.requests.delete(agentSessionId)
      this.changed()
      if (granted.length) void this.ports.apply(agentSessionId).catch(error => console.warn('A grant of a closed tab could not be removed from its live runtime; it ends with the runtime', error))
    }
  }

  private pendingRequest(agentSessionId: string, requestId: string): PermissionGrantRequest {
    const known = this.requests.get(agentSessionId)?.get(requestId)
    if (known) {
      if (known.status !== 'pending') throw new Error(`This request was already answered (${known.status})`)
      return known
    }
    if (requestId.startsWith(AGENT_PREFIX)) throw new Error('No such permission request in this conversation')
    const denial = this.ports.denial(agentSessionId, requestId)
    if (!denial?.request || autoModeDenialItemId(denial.toolUseId) !== requestId) throw new Error('No such permission request in this conversation')
    const request: PermissionGrantRequest = { ...denial.request, id: requestId, source: 'denial', status: 'pending', requestedAt: this.now() }
    const open = this.requests.get(agentSessionId) ?? new Map<string, PermissionGrantRequest>()
    open.set(requestId, request)
    this.requests.set(agentSessionId, open)
    return request
  }

  private settle(agentSessionId: string, request: PermissionGrantRequest, update: Pick<PermissionGrantRequest, 'status' | 'decidedAt' | 'decidedBy'>): void {
    Object.assign(request, update)
    this.card(agentSessionId, request)
    this.changed()
  }

  private statusOf(agentSessionId: string, requestId: string, status: GrantStatus): void {
    const request = this.requests.get(agentSessionId)?.get(requestId)
    if (request) this.settle(agentSessionId, request, { status, decidedAt: request.decidedAt, decidedBy: request.decidedBy })
    else this.changed()
  }

  private drop(agentSessionId: string, grantId: string): void {
    const remaining = (this.grants.get(agentSessionId) ?? []).filter(entry => entry.id !== grantId)
    if (remaining.length) this.grants.set(agentSessionId, remaining)
    else this.grants.delete(agentSessionId)
    this.changed()
  }

  /** The card in the tab: an agent's request is Conductor's own notice; a denial's card is the
   *  adapter's notice, restated in place with the answer. */
  private card(agentSessionId: string, request: PermissionGrantRequest): void {
    if (request.source === 'agent') {
      const message = request.status === 'pending'
        ? `Permission requested: ${grantRequestSummary(request)}${request.rule ? `. Approving hands this conversation exactly ${request.rule}.` : `. ${request.refusal ?? ''}`}`
        : `Permission ${request.status}: ${grantRequestSummary(request)}`
      this.ports.notice(agentSessionId, message, { permissionGrant: request as unknown as Json }, request.id)
      return
    }
    const denial = this.ports.denial(agentSessionId, request.id)
    if (!denial) return
    this.ports.notice(agentSessionId, autoModeDenialMessage(denial), { ...(autoModeDenialPayload(denial) as Record<string, Json>), grantStatus: request.status }, request.id)
  }

  private async restartThenTell(agentSessionId: string, text: string): Promise<void> {
    const deadline = Date.now() + (this.ports.idleWaitMs ?? 10 * 60_000)
    while (ACTIVE_PHASES.has(this.ports.phase(agentSessionId) ?? '') && Date.now() < deadline) await new Promise(done => setTimeout(done, this.ports.idlePollMs ?? 2000))
    if (!this.grants.get(agentSessionId)?.length) return
    try {
      if (ACTIVE_PHASES.has(this.ports.phase(agentSessionId) ?? '')) throw new Error('the conversation did not settle')
      await this.ports.restart(agentSessionId)
      await this.ports.tell(agentSessionId, text)
    } catch (error) {
      this.ports.notice(agentSessionId, `The approved rule could not be handed to this conversation (${error instanceof Error ? error.message : 'restart failed'}). It still applies the next time the conversation starts.`, { permissionGrantDelivery: 'failed' }, `grant-delivery:${agentSessionId}`)
    }
  }
}
