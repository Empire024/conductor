import { randomUUID } from 'node:crypto'
import { autoModeDenialItemId, autoModeDenialMessage, autoModeDenialPayload, type AutoModeDenial, type DenialGrantRequest } from '../../shared/auto-mode-denial'
import {
  describeGrantRequest, grantApprovedMessage, grantDeniedMessage, grantHolderLabel, grantNeedsPhone, grantRequestSummary, wizardMayDecide,
  type GrantDecision, type GrantRule, type GrantStatus, type PermissionGrant, type PermissionGrantDecisionResult, type PermissionGrantRequest, type PermissionGrantsState
} from '../../shared/permission-grants'
import type { Json } from '../../shared/structured-agent'

/**
 * One narrow owner approval per sensitive action, consumed by the conversation that asked
 * (docs/permissions-classifier.md). A request comes from a classifier denial the Claude adapter
 * recorded (its notice item in the timeline is the card, a pending request from the moment the
 * adapter shows it: denied), or from the agent itself through permissions.request before it
 * tries. The owner answers in the card; a wizard tab may answer
 * only for local, reversible actions. An approval becomes exactly one native allow rule for that
 * one conversation, handed to the running CLI (apply_flag_settings) or, where the CLI cannot take
 * it live, through --settings on its next start. Grants live in memory only: they end with the
 * tab, with this app, when the owner revokes them, or (approve once) when their call has run.
 * A tab that hands itself on (agents.handoff successor) hands its waiting requests and unspent
 * grants to the successor (transfer), which is the same brain continued; a tab closed without one
 * withdraws its waiting cards. Nothing here lets an agent approve its own request.
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
  /** The tab title, shown on a card that a handoff moved (holder). */
  title?(agentSessionId: string): string | undefined
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
  /** A conversation that handed itself on -> its successor (transfer). */
  private readonly successors = new Map<string, string>()
  /** A grant a handoff moved -> the conversations that held it before, so a spend the old runtime
   *  still reports (a rule it took at launch and could not give back) spends the moved grant. */
  private readonly movedFrom = new Map<string, string[]>()
  /** A conversation that handed itself on -> the request ids the handoff moved out of it. A denial
   *  id is only unique within one CLI process, so a repeat is matched to these, not by id alone. */
  private readonly movedOut = new Map<string, Set<string>>()
  /** A conversation -> a denial card it showed for a call it had already asked about -> that request's id. */
  private readonly aliases = new Map<string, Map<string, string>>()
  constructor(private readonly ports: PermissionGrantPorts) {}

  private now(): string { return this.ports.now?.() ?? new Date().toISOString() }
  private changed(): void { this.ports.changed?.(this.state()) }

  rules(agentSessionId: string): GrantRule[] {
    return (this.grants.get(agentSessionId) ?? []).map(grant => ({ rule: grant.rule, once: grant.scope === 'once' }))
  }

  /** What the Claude adapter is given (AdapterOptions.permissionGrants). */
  adapterPort(agentSessionId: string): { rules(): GrantRule[]; used(rule: string): void; refused(rule: string): void; denied(itemId: string, request: DenialGrantRequest): void } {
    return { rules: () => this.rules(agentSessionId), used: rule => this.used(agentSessionId, rule), refused: rule => this.refused(agentSessionId, rule), denied: (itemId, request) => this.denied(agentSessionId, itemId, request) }
  }

  /**
   * The adapter showed a classifier denial's card (its notice item, itemId). From that moment it is
   * a pending request like an agent's own, so a handoff moves it and a tab closed without a
   * successor withdraws it; built only when the owner answered, it stayed with a superseded tab.
   * The same card shown again (the turn's result confirms the denial) replaces the notice with
   * its bare form, so an answer or a move already made is restated over it. A denial of a call the
   * conversation already asked about (still waiting, or handed to its successor) is not a second
   * request: its card becomes another view of that one (aliases), so one answer settles both.
   */
  denied(agentSessionId: string, itemId: string, described: DenialGrantRequest): void {
    const known = this.requests.get(agentSessionId)?.get(itemId)
    if (known) {
      if (known.status !== 'pending') this.card(agentSessionId, known)
      return
    }
    if (this.movedOut.get(agentSessionId)?.has(itemId)) {
      const moved = this.lookup(agentSessionId, itemId)
      if (moved) this.card(agentSessionId, { ...moved, status: 'moved' })
      return
    }
    const aliased = this.aliases.get(agentSessionId)?.get(itemId)
    const sameCall = (entry: PermissionGrantRequest | undefined): entry is PermissionGrantRequest => entry?.tool === described.tool && entry.resource === described.resource
    const same = aliased ? this.lookup(agentSessionId, aliased)
      : [...(this.requests.get(agentSessionId)?.values() ?? [])].find(entry => entry.status === 'pending' && sameCall(entry))
        ?? [...(this.movedOut.get(agentSessionId) ?? [])].map(id => this.lookup(agentSessionId, id)).find(sameCall)
    if (same) {
      const views = this.aliases.get(agentSessionId) ?? new Map<string, string>()
      this.aliases.set(agentSessionId, views.set(itemId, same.id))
      this.aliasCard(agentSessionId, itemId, this.requests.get(agentSessionId)?.has(same.id) ? same : { ...same, status: 'moved' })
      return
    }
    const request: PermissionGrantRequest = { ...described, id: itemId, source: 'denial', status: 'pending', requestedAt: this.now() }
    const open = this.requests.get(agentSessionId) ?? new Map<string, PermissionGrantRequest>()
    open.set(itemId, request)
    this.requests.set(agentSessionId, open)
    this.changed()
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
    requestId = this.aliases.get(agentSessionId)?.get(requestId) ?? requestId
    agentSessionId = this.holderOf(agentSessionId, requestId)
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
  used(reporter: string, rule: string): void {
    let agentSessionId = reporter
    let grant = (this.grants.get(agentSessionId) ?? []).find(entry => entry.rule === rule && entry.scope === 'once')
    for (let next = this.successors.get(reporter), hops = 0; !grant && next && hops < 16; next = this.successors.get(next), hops++) {
      grant = (this.grants.get(next) ?? []).find(entry => entry.rule === rule && entry.scope === 'once' && this.movedFrom.get(entry.id)?.includes(reporter))
      if (grant) agentSessionId = next
    }
    if (!grant) return
    this.movedFrom.delete(grant.id)
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

  /**
   * agents.handoff({successor:true}): the successor is this conversation continued, so its
   * waiting requests and unspent grants move to it. Synchronous up to the first await: from the
   * moment this is called the predecessor can neither be approved for, consume nor revoke them.
   * The predecessor's card stops asking and names the holder; the successor's tab gets the live
   * card, and an approval (or an approval already given) tells the successor to retry. The
   * predecessor's live runtime has the rules taken back before the successor is handed them.
   */
  async transfer(fromId: string, toId: string): Promise<{ requests: number; grants: number }> {
    const open = this.requests.get(fromId)
    const granted = this.grants.get(fromId) ?? []
    const pending = [...(open?.values() ?? [])].filter(request => request.status === 'pending')
    if (fromId === toId || (!pending.length && !granted.length) || this.ports.provider(toId) !== 'claude') return { requests: 0, grants: 0 }
    const title = this.ports.title?.(toId)
    const holder = { agentSessionId: toId, ...(title ? { title } : {}) }
    const target = this.requests.get(toId) ?? new Map<string, PermissionGrantRequest>()
    const out = this.movedOut.get(fromId) ?? new Set<string>()
    for (const id of new Set([...pending.map(request => request.id), ...granted.map(grant => grant.requestId)])) {
      const request = open?.get(id)
      if (!request) continue
      open!.delete(id)
      out.add(id)
      request.holder = holder
      target.set(id, request)
    }
    if (target.size) this.requests.set(toId, target)
    if (out.size) this.movedOut.set(fromId, out)
    if (open && !open.size) this.requests.delete(fromId)
    this.grants.delete(fromId)
    for (const grant of granted) {
      grant.agentSessionId = toId
      this.movedFrom.set(grant.id, [...(this.movedFrom.get(grant.id) ?? []), fromId])
    }
    if (granted.length) this.grants.set(toId, [...(this.grants.get(toId) ?? []).filter(entry => !granted.some(grant => grant.rule === entry.rule)), ...granted])
    this.successors.set(fromId, toId)
    for (const request of pending) {
      if (request.source === 'agent') {
        this.ports.notice(fromId, `Permission request moved to ${grantHolderLabel(holder)}: ${grantRequestSummary(request)}`, { permissionGrant: { ...request, status: 'moved' } as unknown as Json }, request.id)
        this.aliasCards(fromId, { ...request, status: 'moved' })
      } else this.card(fromId, { ...request, status: 'moved' })
      this.card(toId, request)
    }
    this.changed()
    if (granted.length) {
      await this.ports.apply(fromId).catch(error => console.warn('Moved grants could not be taken back out of the previous conversation; a spend it reports still spends them', error))
      const applied = await this.ports.apply(toId).catch(error => { console.warn('Moved grants could not be handed to the successor live; they apply when it next starts', error); return 'offline' as const })
      for (const grant of granted) grant.delivery = applied === 'applied' ? 'live' : applied === 'unsupported' ? 'restart' : 'pending'
      this.changed()
      const text = granted.map(grant => grantApprovedMessage(grant.rule, grant.scope)).join('\n')
      if (applied === 'unsupported') void this.restartThenTell(toId, text)
      else await this.ports.tell(toId, text).catch(error => console.warn('The successor could not be told about the grants it now holds', error))
    }
    return { requests: pending.length, grants: granted.length }
  }

  /** The runtime stopped for good: its requests and grants end with it, and a waiting card says so. */
  closed(agentSessionId: string): void {
    this.missing.delete(agentSessionId)
    this.successors.delete(agentSessionId)
    this.movedOut.delete(agentSessionId)
    this.withdraw(agentSessionId)
    this.aliases.delete(agentSessionId)
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
      this.withdraw(agentSessionId)
      this.requests.delete(agentSessionId)
      this.aliases.delete(agentSessionId)
      this.changed()
      if (granted.length) void this.ports.apply(agentSessionId).catch(error => console.warn('A grant of a closed tab could not be removed from its live runtime; it ends with the runtime', error))
    }
  }

  /** A tab that ends without a successor: its waiting cards stop asking (no orphaned card). */
  private withdraw(agentSessionId: string): void {
    for (const request of this.requests.get(agentSessionId)?.values() ?? []) {
      if (request.status !== 'pending') continue
      request.status = 'expired'
      this.card(agentSessionId, request)
    }
  }

  /** Who holds a request now: the named conversation, or the successor a handoff moved it to. */
  private holderOf(agentSessionId: string, requestId: string): string {
    for (let current = agentSessionId, hops = 0; hops < 16; hops++) {
      if (this.requests.get(current)?.has(requestId)) return current
      const next = this.successors.get(current)
      if (!next) break
      current = next
    }
    return agentSessionId
  }

  /** A request as its holder has it now, looked up from the conversation that asked. */
  private lookup(agentSessionId: string, requestId: string): PermissionGrantRequest | undefined {
    return this.requests.get(this.holderOf(agentSessionId, requestId))?.get(requestId)
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
   *  adapter's notice, restated in place with the answer. A successor a handoff moved a denial to
   *  has no such notice, so its card is built from the request under the same item id. */
  private card(agentSessionId: string, request: PermissionGrantRequest): void {
    this.aliasCards(agentSessionId, request)
    if (request.source === 'agent') {
      const message = request.status === 'pending'
        ? `Permission requested: ${grantRequestSummary(request)}${request.rule ? `. Approving hands this conversation exactly ${request.rule}.` : `. ${request.refusal ?? ''}`}`
        : `Permission ${request.status}: ${grantRequestSummary(request)}`
      this.ports.notice(agentSessionId, message, { permissionGrant: request as unknown as Json }, request.id)
      return
    }
    const recorded = this.ports.denial(agentSessionId, request.id)
    const { id, source: _source, status: _status, requestedAt: _requestedAt, decidedAt: _decidedAt, decidedBy: _decidedBy, holder, ...described } = request
    const denial: AutoModeDenial | undefined = recorded ?? (holder?.agentSessionId === agentSessionId
      ? { tool: request.tool, reason: request.category ?? 'Permission denied', toolUseId: request.toolUseId ?? id.replace(/^auto-denial:/, ''), request: described }
      : undefined)
    if (!denial) return
    const shown = denial.request && holder ? { ...denial, request: { ...denial.request, holder } } : denial
    this.ports.notice(agentSessionId, autoModeDenialMessage(shown), { ...(autoModeDenialPayload(shown) as Record<string, Json>), grantStatus: request.status }, request.id)
  }

  /** Every other view of this request in the conversation shows its current answer. */
  private aliasCards(agentSessionId: string, request: PermissionGrantRequest): void {
    for (const [itemId, requestId] of this.aliases.get(agentSessionId) ?? []) if (requestId === request.id) this.aliasCard(agentSessionId, itemId, request)
  }

  /** A denial card that is another view of an earlier request: the same card, answered as that request. */
  private aliasCard(agentSessionId: string, itemId: string, request: PermissionGrantRequest): void {
    this.ports.notice(agentSessionId, `Auto mode refused this call again; it is the one already asked about: ${grantRequestSummary(request)}`, { permissionGrant: request as unknown as Json }, itemId)
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
