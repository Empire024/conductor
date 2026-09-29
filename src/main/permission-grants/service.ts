import { randomUUID } from 'node:crypto'
import { autoModeDenialItemId, autoModeDenialMessage, autoModeDenialPayload, classifierOutageMessage, classifierOutagePayload, isClassifierOutage, type AutoModeDenial, type DenialGrantRequest } from '../../shared/auto-mode-denial'
import {
  describeGrantRequest, grantApprovedMessage, grantDeniedMessage, grantHolderLabel, grantNeedsPhone, grantRequestSummary, nativeGrantRules,
  type GrantCallIdentity, type GrantDecision, type GrantExecution, type GrantExecutionStatus, type GrantRule, type GrantStatus, type PermissionGrant, type PermissionGrantDecisionResult, type PermissionGrantRequest, type PermissionGrantsState
} from '../../shared/permission-grants'
import type { Json } from '../../shared/structured-agent'
import { grantCallIdentity, grantWorkKey, sameNativeCall, sameToolAttempt, type NativeGrantCall } from './identity'

/**
 * One narrow owner approval per sensitive action, consumed by the conversation that asked
 * (docs/permissions-classifier.md). A request comes from a classifier denial the Claude adapter
 * recorded (its notice item in the timeline is the card, a pending request from the moment the
 * adapter shows it: denied), or from the agent itself through permissions.request before it
 * tries. The owner answers in the card; a wizard tab holds the owner's authority and may answer
 * any class. An approval becomes exactly one native allow rule for that
 * one conversation, handed to the running CLI (apply_flag_settings) or, where the CLI cannot take
 * it live, through --settings on its next start, and the conversation is told to retry in a user
 * turn of its own (retry). A classifier denial itself has no pending native request to answer.
 * Whether a correctly matching rule takes precedence in Guarded Auto remains unconfirmed.
 * Waiting requests and unspent
 * grants survive an
 * app restart (snapshot/restore, permission-grants.json in userData); they end with the tab, when
 * the owner revokes them, or (approve once) when their call has run.
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
  /** Answer only a still-pending provider request with this exact identity. A stale response must
   *  return stale; a transport failure with uncertain delivery must throw. */
  respondNative?(agentSessionId: string, call: GrantCallIdentity, decision: 'allow' | 'deny'): Promise<'sent' | 'stale'>
  phase(agentSessionId: string): string | undefined
  /** Restarts the idle conversation's runtime on the same native conversation. */
  restart(agentSessionId: string): Promise<void>
  /** Delivers a Conductor message: steered into a running turn, or starting one. */
  tell(agentSessionId: string, text: string): Promise<void>
  /** Delivers an approval's "retry it now" as a user turn of its own: queued behind a turn that is
   *  under way, never steered into it, and started at once when the conversation is idle. The
   *  delivery as a separate turn keeps the approval visible and ordered, though the haftheme
   *  case did not establish that delivery form caused its classifier result. */
  retry(agentSessionId: string, text: string): Promise<void>
  /** Whether that turn is still waiting in the conversation's queue. A refusal before it starts is
   *  the agent retrying on its own, which says nothing yet about the grant. */
  retryQueued?(agentSessionId: string, text: string): boolean
  /** Phone push for external, shared and destructive requests. */
  phone?(agentSessionId: string, title: string, body: string): void
  changed?(state: PermissionGrantsState): void
  /** Whether the conversation still has a tab in any window. Closing a tab only changes the layout
   *  (its runtime may run on for the undo window), so sweep() asks this rather than waiting for the
   *  runtime to stop. Absent: only closed() ends a conversation's grants. */
  tabOpen?(agentSessionId: string): boolean
  /** Writes what must survive a restart (snapshot()), after every change. */
  persist?(saved: SavedPermissionGrants): void
  /** Steers a short note into the running turn when it can take one right now; false when it
   *  cannot. Never queues: the approval itself must stay a turn of its own. */
  headsUp?(agentSessionId: string, text: string): Promise<boolean>
  /** Stops the running turn and sends what waits in its queue straight after (Esc in the tab). */
  interrupt?(agentSessionId: string): Promise<void>
  /** When the turn under way started and the last tool it ran, for the waiting notice. */
  turn?(agentSessionId: string): { startedAt?: string; lastTool?: string } | undefined
  /** Takes a message that has not started yet back out of the conversation's queue; false when it
   *  is no longer there (being sent, or already running). */
  unqueue?(agentSessionId: string, text: string): boolean
  idleWaitMs?: number
  idlePollMs?: number
  /** How long an approval turn waits behind a running turn before its approver hears (RETRY_NOTICE_MS). */
  retryNoticeMs?: number
}

export type GrantActor = 'owner' | 'wizard'

/** What survives an app restart: the waiting requests, the unspent grants and the handoff links
 *  they depend on. Answered, spent, withdrawn and expired requests are not kept, only their ids
 *  and answers (settled), so a denial card a reattached runtime shows again is not asked twice. */
export interface SavedPermissionGrants {
  version: 1
  requests: Array<PermissionGrantRequest & { agentSessionId: string }>
  grants: PermissionGrant[]
  successors: Array<[string, string]>
  movedFrom: Array<[string, string[]]>
  movedOut: Array<[string, string[]]>
  aliases: Array<[string, Array<[string, string]>]>
  settled: Array<[string, string, GrantStatus]>
  /** Terminal work keys prevent a repeated unchanged denial from asking the owner again. */
  terminal?: Array<[string, string, GrantExecution]>
}
export interface AgentGrantRequest { tool?: string; command?: string; path?: string; url?: string; reason?: string; rollback?: string }

const ACTIVE_PHASES = new Set(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'])
const AGENT_PREFIX = 'grant:'
const DECIDED: Record<Exclude<GrantDecision, 'deny'>, GrantStatus> = { 'approve-once': 'approved-once', 'approve-session': 'approved-session' }
/** Bounds on what a restart keeps of history that is neither waiting nor unspent. */
const SAVED_SETTLED = 200
const SAVED_MOVED = 200
const LIVE_STATUSES = new Set<GrantStatus>(['pending', 'approved-once', 'approved-session'])
const TERMINAL_EXECUTIONS = new Set<GrantExecutionStatus>(['succeeded', 'failed', 'blocked', 'cancelled', 'unknown'])
const STEERABLE_PHASES = new Set(['running', 'waiting_approval', 'waiting_input'])
/** An approval turn queued behind a turn still running this long: the owner is told how to
 *  interrupt it; a wizard's approval interrupts it (owner decision 2026-09-28, H06). */
const RETRY_NOTICE_MS = 120_000
/** An approval turn still queued after this long is withdrawn rather than delivered as "retry it
 *  now": by then the call it names is usually no longer what the conversation is doing. */
const RETRY_STALE_MS = 30 * 60_000
/** A handoff hands the successor only grants approved this recently; an older unspent grant ends
 *  with a notice instead of reaching the successor as a "retry it now" for a call it never made. */
const HANDOFF_FRESH_MS = 10 * 60_000
/** An approval turn a conversation could not take yet (still stopping its last turn) is handed
 *  over again this many times, this far apart, before the owner is told. */
const DELIVERY_ATTEMPTS = 20
const DELIVERY_RETRY_MS = 3000
/** An approval turn Conductor is delivering: handed to the conversation (queued or started), or
 *  not yet, because the conversation was still stopping its last turn. */
interface Delivery {
  agentSessionId: string
  text: string
  rules: string[]
  grantIds: string[]
  approver: GrantActor
  /** When it was handed over (queued), or first tried. */
  since: number
  handed: boolean
  attempts: number
  lastAttempt: number
  sending: boolean
  headsUp: 'no' | 'sending' | 'done'
  noticed: boolean
  /** The owner's card offers "Interrupt and retry" (state().waiting): the waiting notice went out
   *  and nothing interrupted the turn yet. */
  offered: boolean
}
/** A denial card whose only "reason" is that the server-side classifier gave no verdict. */
const outageCard = (request: Pick<PermissionGrantRequest, 'source' | 'category'>): boolean => request.source === 'denial' && isClassifierOutage(request.category)

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
  /** Answers a previous run gave (restore): a request answered before the restart stays answered. */
  private readonly settled = new Map<string, Map<string, GrantStatus>>()
  private readonly terminal = new Map<string, { agentSessionId: string; execution: GrantExecution }>()
  /** A grant -> the approval turn it was announced with (retry), until the grant ends. */
  private readonly retries = new Map<string, string>()
  /** Approval turns being delivered, by conversation and text (deliver, followDeliveries). */
  private readonly deliveries = new Map<string, Delivery>()
  /** The app is quitting (freeze): runtimes stopping now are not conversations ending. */
  private stopping = false
  constructor(private readonly ports: PermissionGrantPorts) {}

  private now(): string { return this.ports.now?.() ?? new Date().toISOString() }
  private clock(): number { return Date.parse(this.now()) }
  private changed(): void {
    this.ports.changed?.(this.state())
    this.save()
  }
  private save(): void {
    if (!this.ports.persist) return
    try { this.ports.persist(this.snapshot()) } catch (error) { console.warn('Permission grants could not be saved; a restart would drop them', error) }
  }

  /** What a restart must keep (SavedPermissionGrants), bounded. */
  snapshot(): SavedPermissionGrants {
    const grants = [...this.grants.values()].flat()
    const granted = new Set(grants.map(grant => `${grant.agentSessionId}\n${grant.requestId}`))
    const requests: SavedPermissionGrants['requests'] = []
    const settled: SavedPermissionGrants['settled'] = []
    for (const [agentSessionId, statuses] of this.settled) for (const [id, status] of statuses) settled.push([agentSessionId, id, status])
    for (const [agentSessionId, open] of this.requests) for (const request of open.values()) {
      if (request.status === 'pending' || granted.has(`${agentSessionId}\n${request.id}`) || request.source === 'native' ||
          request.execution && TERMINAL_EXECUTIONS.has(request.execution.status)) requests.push({ ...request, agentSessionId })
      else settled.push([agentSessionId, request.id, request.status])
    }
    const movedOut = new Map<string, string[]>()
    for (const [from, id] of [...this.movedOut].flatMap(([from, ids]) => [...ids].map(id => [from, id] as const)).slice(-SAVED_MOVED)) movedOut.set(from, [...(movedOut.get(from) ?? []), id])
    const ids = new Set(grants.map(grant => grant.id))
    return {
      version: 1,
      requests,
      grants: grants.map(grant => ({ ...grant })),
      successors: [...this.successors].slice(-SAVED_MOVED),
      movedFrom: [...this.movedFrom].filter(([id]) => ids.has(id)),
      movedOut: [...movedOut],
      aliases: [...this.aliases].map(([agentSessionId, views]) => [agentSessionId, [...views]]),
      settled: settled.slice(-SAVED_SETTLED),
      terminal: [...this.terminal].slice(-SAVED_SETTLED).map(([key, value]) => [key, value.agentSessionId, value.execution])
    }
  }

  /**
   * Takes back what the previous run saved (snapshot), before any runtime reattaches or resumes:
   * the owner's card, permissions.list, an approval's "retry it now" and a grant's rules work for
   * the holder as before the restart. An entry whose conversation no longer exists (exists) is
   * dropped; one whose tab was closed while the app was down ends on the next sweeps, as it would
   * have. A restored grant reaches the runtime when it next starts or reattaches.
   */
  restore(saved: unknown, exists: (agentSessionId: string) => boolean): { requests: number; grants: number; dropped: number } {
    const data = saved && typeof saved === 'object' ? saved as Partial<SavedPermissionGrants> : {}
    const list = <T>(value: T[] | undefined): T[] => Array.isArray(value) ? value : []
    const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
    let dropped = 0, restoredRequests = 0, restoredGrants = 0
    for (const entry of list(data.requests)) {
      if (!entry || !text(entry.id) || !text(entry.agentSessionId) ||
          (!LIVE_STATUSES.has(entry.status) && !(entry.execution && TERMINAL_EXECUTIONS.has(entry.execution.status)))) continue
      const { agentSessionId, ...request } = entry
      if (!exists(agentSessionId)) { dropped++; continue }
      // A classifier outage an older build saved as a card was never a question: withdrawn, not asked again.
      if (request.status === 'pending' && outageCard(request)) { this.settledAs(agentSessionId, request.id, 'expired'); dropped++; continue }
      if (request.source === 'native') {
        // A kept native runtime can preserve the pending request through an app restart. The
        // card remains visible but cannot answer until that *same* can_use_tool is observed live
        // again. An already authorized response is uncertain and must never be replayed.
        request.nativeAvailable = false
        if (request.execution && request.execution.status !== 'pending' && !TERMINAL_EXECUTIONS.has(request.execution.status))
          request.execution = { ...request.execution, status: 'unknown', updatedAt: this.now(), detail: 'The app restarted after authorization; inspect execution before any retry.' }
      } else if (request.execution && request.execution.status !== 'pending' && !TERMINAL_EXECUTIONS.has(request.execution.status)) {
        request.execution = { ...request.execution, status: 'unknown', updatedAt: this.now(), detail: 'The app restarted after authorization and before execution was confirmed; do not retry automatically.' }
      }
      if (request.execution && TERMINAL_EXECUTIONS.has(request.execution.status))
        this.terminal.set(grantWorkKey(request.execution.call, request.execution.scope), { agentSessionId, execution: request.execution })
      const open = this.requests.get(agentSessionId) ?? new Map<string, PermissionGrantRequest>()
      if (open.has(request.id)) continue
      this.requests.set(agentSessionId, open.set(request.id, request))
      restoredRequests++
    }
    for (const grant of list(data.grants)) {
      if (!grant || !text(grant.id) || !text(grant.rule) || !text(grant.agentSessionId) || (grant.scope !== 'once' && grant.scope !== 'session')) continue
      const request = this.requests.get(grant.agentSessionId)?.get(grant.requestId)
      if (!request || request.status === 'pending' || request.execution?.status === 'unknown') { dropped++; continue }
      const held = this.grants.get(grant.agentSessionId) ?? []
      if (held.some(entry => entry.id === grant.id || entry.rule === grant.rule)) continue
      this.grants.set(grant.agentSessionId, [...held, { ...grant, delivery: 'pending' }])
      restoredGrants++
    }
    // A request saved as approved whose grant did not come back is not approved any more.
    for (const [agentSessionId, open] of [...this.requests]) {
      for (const request of [...open.values()]) {
        if (request.status === 'pending' || request.source === 'native' || request.execution && TERMINAL_EXECUTIONS.has(request.execution.status) ||
            (this.grants.get(agentSessionId) ?? []).some(grant => grant.requestId === request.id)) continue
        open.delete(request.id)
        this.settledAs(agentSessionId, request.id, 'expired')
        restoredRequests--
        dropped++
      }
      if (!open.size) this.requests.delete(agentSessionId)
    }
    const grantIds = new Set([...this.grants.values()].flat().map(grant => grant.id))
    for (const [from, to] of list(data.successors)) if (text(from) && text(to) && exists(from) && !this.successors.has(from)) this.successors.set(from, to)
    for (const [id, froms] of list(data.movedFrom)) if (grantIds.has(id) && Array.isArray(froms)) this.movedFrom.set(id, froms.filter(text))
    for (const [from, ids] of list(data.movedOut)) if (text(from) && exists(from) && Array.isArray(ids)) this.movedOut.set(from, new Set([...(this.movedOut.get(from) ?? []), ...ids.filter(text)]))
    for (const [agentSessionId, views] of list(data.aliases)) {
      if (!text(agentSessionId) || !exists(agentSessionId) || !Array.isArray(views)) continue
      const map = this.aliases.get(agentSessionId) ?? new Map<string, string>()
      for (const [itemId, requestId] of views) if (text(itemId) && text(requestId)) map.set(itemId, requestId)
      if (map.size) this.aliases.set(agentSessionId, map)
    }
    for (const [agentSessionId, id, status] of list(data.settled)) if (text(agentSessionId) && text(id) && text(status) && !LIVE_STATUSES.has(status) && exists(agentSessionId)) this.settledAs(agentSessionId, id, status)
    for (const entry of list(data.terminal)) {
      if (!Array.isArray(entry) || entry.length !== 3) continue
      const [key, agentSessionId, execution] = entry
      if (text(key) && text(agentSessionId) && exists(agentSessionId) && execution && TERMINAL_EXECUTIONS.has(execution.status))
        this.terminal.set(key, { agentSessionId, execution })
    }
    this.changed()
    return { requests: restoredRequests, grants: restoredGrants, dropped }
  }

  /** The app is quitting: every runtime is stopped next, which ends no conversation, so what is
   *  waiting stays saved for the next launch instead of being withdrawn (closed, sweep). */
  freeze(): void { this.stopping = true }

  private settledAs(agentSessionId: string, id: string, status: GrantStatus): void {
    const statuses = this.settled.get(agentSessionId) ?? new Map<string, GrantStatus>()
    this.settled.set(agentSessionId, statuses.set(id, status))
  }

  rules(agentSessionId: string): GrantRule[] {
    return (this.grants.get(agentSessionId) ?? []).map(grant => ({ rule: grant.rule, once: grant.scope === 'once' }))
  }

  /** What the Claude adapter is given (AdapterOptions.permissionGrants). */
  adapterPort(agentSessionId: string): { rules(): GrantRule[]; used(rule: string): void; refused(rule: string): void; denied(itemId: string, request: DenialGrantRequest): void;
    nativePending(call: NativeGrantCall): PermissionGrantRequest | undefined; executionStarted(call: NativeGrantCall, evidence: 'tool-progress'): void;
    executionFinished(call: NativeGrantCall, outcome: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown'): void } {
    return { rules: () => this.rules(agentSessionId), used: rule => this.used(agentSessionId, rule), refused: rule => this.refused(agentSessionId, rule),
      denied: (itemId, request) => this.denied(agentSessionId, itemId, request), nativePending: call => this.nativePending(agentSessionId, call),
      executionStarted: (call, evidence) => this.executionStarted(agentSessionId, call, evidence), executionFinished: (call, outcome) => this.executionFinished(agentSessionId, call, outcome) }
  }

  /** A provider request that is still pending can be answered once without adding a reusable
   *  permission rule. The provider must supply its exact runtime, session, request and arguments. */
  nativePending(agentSessionId: string, call: NativeGrantCall): PermissionGrantRequest | undefined {
    if (!call.requestId || call.tool === 'AskUserQuestion' || !this.ports.respondNative || this.ports.provider(agentSessionId) !== 'claude') return undefined
    const cwd = this.ports.cwd(agentSessionId)
    if (!cwd) return undefined
    const described = describeGrantRequest({ tool: call.tool, input: call.input, cwd })
    if (described.rule) return undefined
    const identity = grantCallIdentity(call)
    const id = `native-grant:${identity.runtimeId}:${identity.requestId}`
    const existing = this.requests.get(agentSessionId)?.get(id)
    if (existing) {
      if (!existing.call || !sameNativeCall(existing.call, identity)) throw new Error('Native request identity was reused with changed arguments')
      if (existing.status === 'pending' && existing.execution?.status === 'pending' && !existing.nativeAvailable) {
        existing.nativeAvailable = true
        this.card(agentSessionId, existing)
        this.changed()
      }
      return existing
    }
    const terminal = this.terminal.get(grantWorkKey(identity, 'once'))
    if (terminal?.agentSessionId === agentSessionId && ['blocked', 'unknown'].includes(terminal.execution.status)) {
      const request: PermissionGrantRequest = { ...described, id, source: 'native', call: identity,
        status: terminal.execution.status === 'blocked' ? 'ineffective' : 'expired', requestedAt: this.now(), execution: terminal.execution, nativeAvailable: false }
      const open = this.requests.get(agentSessionId) ?? new Map<string, PermissionGrantRequest>()
      this.requests.set(agentSessionId, open.set(id, request))
      this.card(agentSessionId, request)
      this.changed()
      return request
    }
    const request: PermissionGrantRequest = { ...described, id, source: 'native', call: identity, nativeAvailable: true, status: 'pending', requestedAt: this.now(),
      execution: { status: 'pending', call: identity, scope: 'once', updatedAt: this.now() } }
    const open = this.requests.get(agentSessionId) ?? new Map<string, PermissionGrantRequest>()
    this.requests.set(agentSessionId, open.set(id, request))
    this.card(agentSessionId, request)
    this.changed()
    return request
  }

  /** The provider observed the exact authorized tool begin. Only this event makes execution
   *  "executing"; handing a rule to the CLI or answering a request never does. */
  executionStarted(agentSessionId: string, raw: NativeGrantCall, evidence: 'tool-progress'): void {
    if (evidence !== 'tool-progress') return
    const call = grantCallIdentity(raw)
    for (const grant of this.grants.get(agentSessionId) ?? []) {
      const request = this.requests.get(agentSessionId)?.get(grant.requestId)
      if (!request?.call || request.call.tool !== call.tool || request.call.argsDigest !== call.argsDigest ||
          request.call.nativeSessionId !== call.nativeSessionId || request.call.runtimeId !== call.runtimeId ||
          TERMINAL_EXECUTIONS.has(grant.execution?.status ?? 'pending')) continue
      const execution: GrantExecution = { status: 'executing', call, scope: grant.scope, updatedAt: this.now() }
      grant.execution = execution
      request.execution = execution
      this.changed()
      return
    }
    const native = [...(this.requests.get(agentSessionId)?.values() ?? [])].find(request =>
      request.source === 'native' && request.call && sameToolAttempt(request.call, call) && request.status === 'approved-once')
    if (native?.execution && !TERMINAL_EXECUTIONS.has(native.execution.status)) {
      native.execution = { ...native.execution, status: 'executing', updatedAt: this.now() }
      this.changed()
    }
  }

  /** A definite provider result closes the exact attempt. A missing or mismatched result leaves
   *  it executing until recovery marks it unknown; it is never guessed from the approval. */
  executionFinished(agentSessionId: string, raw: NativeGrantCall, outcome: Extract<GrantExecutionStatus, 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'unknown'>): void {
    const call = grantCallIdentity(raw)
    const request = [...(this.requests.get(agentSessionId)?.values() ?? [])].find(entry => {
      if (!entry.execution || TERMINAL_EXECUTIONS.has(entry.execution.status) || !entry.call) return false
      return entry.source === 'native' ? sameToolAttempt(entry.call, call) :
        entry.call.runtimeId === call.runtimeId && entry.call.nativeSessionId === call.nativeSessionId &&
        entry.call.tool === call.tool && entry.call.argsDigest === call.argsDigest
    })
    if (!request?.execution) return
    const execution: GrantExecution = { ...request.execution, call, status: outcome, updatedAt: this.now() }
    request.execution = execution
    this.terminal.set(grantWorkKey(call, execution.scope), { agentSessionId, execution })
    if (this.terminal.size > SAVED_SETTLED) this.terminal.delete(this.terminal.keys().next().value!)
    if (request.source === 'native') {
      request.nativeAvailable = false
      this.statusOf(agentSessionId, request.id, outcome === 'succeeded' ? 'used' : outcome === 'failed' || outcome === 'blocked' ? 'ineffective' : 'expired')
      return
    }
    const grant = (this.grants.get(agentSessionId) ?? []).find(entry => entry.requestId === request.id)
    if (grant) {
      grant.execution = execution
      if (grant.scope === 'once' || outcome === 'blocked' || outcome === 'cancelled' || outcome === 'unknown') {
        this.drop(agentSessionId, grant.id)
        this.statusOf(agentSessionId, request.id, outcome === 'succeeded' ? 'used' : outcome === 'failed' || outcome === 'blocked' ? 'ineffective' : 'expired')
        void this.ports.apply(agentSessionId).catch(() => undefined)
      }
    }
    this.changed()
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
    if (isClassifierOutage(described.category)) return
    const known = this.requests.get(agentSessionId)?.get(itemId)
    if (known) {
      if (known.status !== 'pending') this.card(agentSessionId, known)
      return
    }
    const answered = this.settled.get(agentSessionId)?.get(itemId)
    if (answered) {
      this.card(agentSessionId, { ...described, id: itemId, source: 'denial', status: answered, requestedAt: this.now() })
      return
    }
    if (described.call) {
      const terminal = (['once', 'session'] as const).map(scope => this.terminal.get(grantWorkKey(described.call!, scope)))
        .find(entry => entry?.agentSessionId === agentSessionId && ['blocked', 'unknown'].includes(entry.execution.status))
      if (terminal) {
        const status: GrantStatus = terminal.execution.status === 'blocked' ? 'ineffective' : 'expired'
        this.settledAs(agentSessionId, itemId, status)
        this.card(agentSessionId, { ...described, id: itemId, source: 'denial', status, execution: terminal.execution, requestedAt: this.now() })
        this.save()
        return
      }
    }
    if (this.movedOut.get(agentSessionId)?.has(itemId)) {
      const moved = this.lookup(agentSessionId, itemId)
      if (moved) this.card(agentSessionId, { ...moved, status: 'moved' })
      return
    }
    const aliased = this.aliases.get(agentSessionId)?.get(itemId)
    const sameCall = (entry: PermissionGrantRequest | undefined): entry is PermissionGrantRequest => entry?.tool === described.tool &&
      (entry.call && described.call ? entry.call.runtimeId === described.call.runtimeId && entry.call.nativeSessionId === described.call.nativeSessionId && entry.call.argsDigest === described.call.argsDigest : entry.resource === described.resource)
    const same = aliased ? this.lookup(agentSessionId, aliased)
      : [...(this.requests.get(agentSessionId)?.values() ?? [])].find(entry => entry.status === 'pending' && !outageCard(entry) && sameCall(entry))
        ?? [...(this.movedOut.get(agentSessionId) ?? [])].map(id => this.lookup(agentSessionId, id)).find(sameCall)
        // Refused while its approval turn still waits (refused kept the grant): the approved request.
        ?? (this.grants.get(agentSessionId) ?? []).filter(grant => this.retryWaiting(agentSessionId, grant.id)).map(grant => this.lookup(agentSessionId, grant.requestId)).find(sameCall)
    if (same) {
      const views = this.aliases.get(agentSessionId) ?? new Map<string, string>()
      this.aliases.set(agentSessionId, views.set(itemId, same.id))
      this.aliasCard(agentSessionId, itemId, this.requests.get(agentSessionId)?.has(same.id) ? same : { ...same, status: 'moved' })
      this.save()
      return
    }
    const request: PermissionGrantRequest = { ...described, id: itemId, source: 'denial', status: 'pending', requestedAt: this.now() }
    const open = this.requests.get(agentSessionId) ?? new Map<string, PermissionGrantRequest>()
    open.set(itemId, request)
    this.requests.set(agentSessionId, open)
    this.changed()
  }

  state(): PermissionGrantsState {
    const settled = [...this.settled].flatMap(([agentSessionId, statuses]) => [...statuses].map(([id, status]) => ({ agentSessionId, id, status })))
    const waiting = [...this.deliveries.values()].filter(delivery => delivery.offered)
      .map(({ agentSessionId, grantIds, rules, since }) => ({ agentSessionId, grantIds: [...grantIds], rules: [...rules], since: new Date(since).toISOString() }))
    return {
      requests: [...this.requests].flatMap(([agentSessionId, requests]) => [...requests.values()].map(request => ({ ...request, agentSessionId }))),
      grants: [...this.grants.values()].flat(),
      ...(settled.length ? { settled } : {}),
      ...(waiting.length ? { waiting } : {})
    }
  }

  /** The owner's "Interrupt and retry" on a grant card: stops the turn the approved retry waits
   *  behind, with the queue expedited, as a wizard approver's interrupt does (follow). */
  async interruptForRetry(agentSessionId: string, grantId: string): Promise<void> {
    const found = [...this.deliveries].find(([, delivery]) => delivery.agentSessionId === agentSessionId && delivery.grantIds.includes(grantId))
    if (!found || !found[1].handed || !this.ports.retryQueued?.(agentSessionId, found[1].text)) {
      if (found) this.endDelivery(found[0], found[1])
      throw new Error('The approved retry is no longer waiting: it already ran, or its grant ended.')
    }
    if (!this.ports.interrupt) throw new Error('This conversation cannot be interrupted from here; press Esc in its tab.')
    const [, delivery] = found
    const itemId = `grant-waiting:${delivery.grantIds[0]}`
    delivery.noticed = true
    delivery.offered = false
    this.changed()
    try {
      await this.ports.interrupt(agentSessionId)
    } catch (error) {
      delivery.offered = true
      this.changed()
      throw error
    }
    this.ports.notice(agentSessionId, `The approved call ${delivery.rules.join(', ')} waited behind a running turn; you interrupted that turn, so the retry runs now as a message of its own.`, { permissionGrantWaiting: { rules: delivery.rules, interrupted: true } }, itemId)
  }

  /** A delivery is over; the owner's card stops offering its interrupt. */
  private endDelivery(key: string, delivery: Delivery): void {
    this.deliveries.delete(key)
    if (delivery.offered) { delivery.offered = false; this.changed() }
  }

  list(agentSessionId: string): { requests: PermissionGrantRequest[]; grants: PermissionGrant[] } {
    // Where each grant lives natively: this conversation's session permissions (the claude CLI's
    // flag-settings layer, apply_flag_settings live or --settings at launch), never a settings
    // file that every Claude tab of the project would also read.
    const installed = (grant: PermissionGrant): PermissionGrant => ({ ...grant, nativeRules: nativeGrantRules(grant.rule), installedIn: grant.delivery === 'live' ? 'this conversation\'s Claude Code session permissions (live)' : 'this conversation\'s Claude Code session permissions (--settings when its runtime next starts)' })
    return { requests: [...(this.requests.get(agentSessionId)?.values() ?? [])], grants: (this.grants.get(agentSessionId) ?? []).map(installed) }
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

  /** Owner (card) or wizard (app control; the wand holds the owner's authority, so every class)
   *  answers one request. Once the grant is applied this never throws: an approval turn the
   *  conversation cannot take yet is handed over again from sweep(). */
  async decide(agentSessionId: string, requestId: string, decision: GrantDecision, actor: GrantActor): Promise<PermissionGrantDecisionResult> {
    if (!['approve-once', 'approve-session', 'deny'].includes(decision)) throw new Error('decision must be approve-once, approve-session or deny')
    requestId = this.aliases.get(agentSessionId)?.get(requestId) ?? requestId
    agentSessionId = this.holderOf(agentSessionId, requestId)
    const request = this.pendingRequest(agentSessionId, requestId)
    const decidedAt = this.now()
    if (decision === 'deny') {
      this.settle(agentSessionId, request, { status: 'denied', decidedAt, decidedBy: actor })
      if (request.source === 'native' && request.call && this.ports.respondNative) {
        try { await this.ports.respondNative(agentSessionId, request.call, 'deny') }
        catch { /* The owner denied it; a lost response cannot grant execution. */ }
        request.execution = { status: 'cancelled', call: request.call, scope: 'once', updatedAt: this.now(), detail: 'The owner denied this native request.' }
        this.changed()
      }
      await this.ports.tell(agentSessionId, grantDeniedMessage(request, actor)).catch(error => console.warn('The denied grant could not be reported to the conversation', error))
      return { status: 'denied', message: 'Denied; the conversation was told not to retry it.' }
    }
    if (request.source === 'native') {
      if (decision !== 'approve-once' || !request.nativeAvailable || !request.call || !request.call.requestId || !this.ports.respondNative)
        throw new Error('This native request can only be allowed once while the exact provider request is pending')
      request.execution = { status: 'owner-authorized', call: request.call, scope: 'once', updatedAt: this.now() }
      this.settle(agentSessionId, request, { status: 'approved-once', decidedAt, decidedBy: actor })
      request.execution = { ...request.execution, status: 'applying', updatedAt: this.now() }
      this.changed()
      try {
        const response = await this.ports.respondNative(agentSessionId, request.call, 'allow')
        if (response === 'stale') {
          request.execution = { ...request.execution, status: 'cancelled', updatedAt: this.now(), detail: 'The exact native request was no longer pending.' }
          this.changed()
          return { status: 'approved-once', message: 'The exact provider request had already ended; nothing was run.' }
        }
        this.changed()
        return { status: 'approved-once', message: 'Allowed this exact pending provider request once; waiting for evidence of execution or its result.' }
      } catch (error) {
        request.execution = { ...request.execution, status: 'unknown', updatedAt: this.now(), detail: 'The native response may have been delivered; inspect its result before any retry.' }
        this.terminal.set(grantWorkKey(request.call, 'once'), { agentSessionId, execution: request.execution })
        this.changed()
        return { status: 'approved-once', message: `Provider response is uncertain (${error instanceof Error ? error.message : String(error)}). Do not retry automatically.` }
      }
    }
    if (!request.rule) throw new Error(request.refusal ?? 'No narrow rule can cover this request')
    if (this.ports.provider(agentSessionId) !== 'claude') throw new Error('Permission grants apply to Claude conversations only')
    const scope = decision === 'approve-once' ? 'once' : 'session'
    const grant: PermissionGrant = {
      id: randomUUID(), agentSessionId, requestId: request.id, rule: request.rule, scope, class: request.class, tool: request.tool,
      resource: request.resource, grantedAt: decidedAt, decidedBy: actor, delivery: 'pending',
      ...(request.call ? { execution: { status: 'owner-authorized' as const, call: request.call, scope, updatedAt: decidedAt } } : {})
    }
    if (grant.execution) request.execution = grant.execution
    this.grants.set(agentSessionId, [...(this.grants.get(agentSessionId) ?? []).filter(entry => entry.rule !== grant.rule), grant])
    this.settle(agentSessionId, request, { status: DECIDED[decision], decidedAt, decidedBy: actor })
    if (grant.execution) { grant.execution = { ...grant.execution, status: 'applying', updatedAt: this.now() }; request.execution = grant.execution; this.changed() }
    const applied = await this.ports.apply(agentSessionId).catch(error => { this.drop(agentSessionId, grant.id); throw error })
    const text = this.approvalText(agentSessionId, [grant])
    this.retries.set(grant.id, text)
    if (applied === 'unsupported') {
      grant.delivery = 'restart'
      this.changed()
      void this.restartThenRetry(agentSessionId, text)
      return { status: DECIDED[decision], grant, message: 'Approved. This CLI cannot take a rule while it runs, so the conversation restarts with it once its turn ends, then retries.' }
    }
    grant.delivery = applied === 'applied' ? 'live' : 'pending'
    this.changed()
    const busy = ACTIVE_PHASES.has(this.ports.phase(agentSessionId) ?? '')
    const handed = await this.deliver(agentSessionId, text, [grant], actor)
    const next = !handed ? 'The conversation is still stopping its last turn; Conductor hands it the retry as soon as it has stopped.'
      : busy ? (this.ports.interrupt ? 'Conductor interrupts its running turn, and the retry runs at once as a message of its own.' : 'The conversation retries it in a message of its own once its current turn ends; Esc in its tab interrupts that turn so the retry runs at once.') : 'The conversation was told to retry it.'
    return { status: DECIDED[decision], grant, message: `Approved: ${grant.rule}. ${next}` }
  }

  /** "[Conductor] approved: …; retry it now", saying which conversation made the call and when it
   *  was approved, so a successor or a late delivery can tell whose call it is. */
  private approvalText(holder: string, granted: PermissionGrant[]): string {
    const at = (iso: string | undefined): string => iso && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'an unknown time'
    return granted.map(grant => {
      const request = this.requests.get(holder)?.get(grant.requestId)
      const asker = this.askedIn(holder, grant.requestId)
      const title = this.ports.title?.(asker)
      const where = asker === holder ? 'this conversation' : `${grantHolderLabel({ agentSessionId: asker, ...(title ? { title } : {}) })} (which handed itself on to this one)`
      return `${grantApprovedMessage(grant.rule, grant.scope)} (Asked in ${where} at ${at(request?.requestedAt)}; approved by ${grant.decidedBy === 'wizard' ? 'a wizard tab' : 'the owner'} at ${at(grant.grantedAt)}.)`
    }).join('\n')
  }

  /** The conversation that first asked for a request a handoff chain moved to holder. */
  private askedIn(holder: string, requestId: string): string {
    let current = holder
    for (let hops = 0; hops < 16; hops++) {
      const previous = [...this.successors].find(([from, to]) => to === current && this.movedOut.get(from)?.has(requestId))?.[0]
      if (!previous) break
      current = previous
    }
    return current
  }

  /** Hands the conversation its approval turn (retry) and follows it until it has run: a heads-up
   *  steered into the running turn, a notice or (wizard approver) an interrupt after
   *  RETRY_NOTICE_MS, withdrawal after RETRY_STALE_MS. False when the conversation could not take
   *  it yet; sweep() hands it over again. */
  private async deliver(agentSessionId: string, text: string, granted: PermissionGrant[], approver: GrantActor): Promise<boolean> {
    const key = `${agentSessionId}\n${text}`
    const delivery: Delivery = {
      agentSessionId, text, rules: granted.map(grant => grant.rule), grantIds: granted.map(grant => grant.id), approver,
      since: this.clock(), handed: false, attempts: 0, lastAttempt: 0, sending: false, headsUp: 'no', noticed: false, offered: false
    }
    this.deliveries.set(key, delivery)
    return this.hand(key, delivery)
  }

  private async hand(key: string, delivery: Delivery): Promise<boolean> {
    delivery.sending = true
    delivery.attempts++
    delivery.lastAttempt = this.clock()
    try {
      await this.ports.retry(delivery.agentSessionId, delivery.text)
      delivery.handed = true
      delivery.since = this.clock()
      this.follow(key, delivery)
      return true
    } catch (error) {
      console.warn('An approval turn could not be handed to its conversation yet', error)
      if (delivery.attempts >= DELIVERY_ATTEMPTS) {
        this.deliveries.delete(key)
        this.ports.notice(delivery.agentSessionId, `The approval of ${delivery.rules.join(', ')} could not be handed to this conversation (${error instanceof Error ? error.message : 'delivery failed'}). The rule stays in place; ask it to retry the call.`, { permissionGrantDelivery: 'failed' }, `grant-delivery:${delivery.agentSessionId}`)
      }
      return false
    } finally { delivery.sending = false }
  }

  /** Every approval turn being delivered, once per sweep. */
  private followDeliveries(): void {
    for (const [key, delivery] of [...this.deliveries]) this.follow(key, delivery)
  }

  private follow(key: string, delivery: Delivery): void {
    const { agentSessionId, text } = delivery
    // Its grants ended (spent, revoked, moved on by a handoff, tab closed): nothing to deliver.
    if (!delivery.grantIds.some(id => this.retries.get(id) === text)) { this.endDelivery(key, delivery); return }
    const phase = this.ports.phase(agentSessionId) ?? ''
    const now = this.clock()
    if (!delivery.handed) {
      if (!delivery.sending && phase !== 'interrupting' && now - delivery.lastAttempt >= DELIVERY_RETRY_MS) void this.hand(key, delivery)
      return
    }
    // It started (or went at once to an idle conversation): the classifier judges from here.
    if (!this.ports.retryQueued?.(agentSessionId, text)) { this.endDelivery(key, delivery); return }
    const waited = now - delivery.since
    if (waited >= RETRY_STALE_MS) { this.withdrawStale(key, delivery, waited); return }
    if (!ACTIVE_PHASES.has(phase)) return
    // Any approval interrupts the running turn at once (owner 2026-09-29: while an approval waited,
    // the model went round the refused call four times). The retry then runs as a turn of its own,
    // which is the only form the classifier honours.
    if (!delivery.noticed && this.ports.interrupt && phase !== 'interrupting') {
      delivery.noticed = true
      const rules = delivery.rules.join(', ')
      const itemId = `grant-waiting:${delivery.grantIds[0]}`
      const by = delivery.approver === 'wizard' ? 'A wizard tab' : 'The owner'
      this.ports.notice(agentSessionId, `${by} approved ${rules}, so Conductor interrupted the running turn; the retry runs now as a message of its own.`, { permissionGrantWaiting: { rules: delivery.rules, interrupted: true } }, itemId)
      void this.ports.interrupt(agentSessionId).catch(error => {
        this.ports.notice(agentSessionId, `The approved call ${rules} is queued behind a running turn, and Conductor could not interrupt it (${error instanceof Error ? error.message : 'interrupt failed'}). Use "Interrupt and retry" on its approval card, or press Esc in this tab; the retry then runs at once.`, { permissionGrantWaiting: { rules: delivery.rules, interrupted: false } }, itemId)
        if (this.deliveries.get(key) === delivery) { delivery.offered = true; this.changed() }
      })
      return
    }
    if (delivery.headsUp === 'no' && this.ports.headsUp && STEERABLE_PHASES.has(phase)) {
      delivery.headsUp = 'sending'
      // Steered into the running turn or not sent at all (wiring headsUp), so it never comes after
      // the retry. An interrupt that expedites the queue can still send an unread heads-up together
      // with it, just ahead of it; the wording holds in that order too.
      const note = `[Conductor] approval queued: ${delivery.rules.join(', ')}. It arrives as a message of its own, "[Conductor] approved: …; retry it now", once this turn ends. Until that message arrives, do not retry the call (it would be refused again); finish or pause this turn soon so it can run.`
      void this.ports.headsUp(agentSessionId, note).then(sent => { delivery.headsUp = sent ? 'done' : 'no' }, () => { delivery.headsUp = 'done' })
    }
    if (delivery.noticed || waited < (this.ports.retryNoticeMs ?? RETRY_NOTICE_MS)) return
    delivery.noticed = true
    const turn = this.ports.turn?.(agentSessionId)
    const started = turn?.startedAt ? Date.parse(turn.startedAt) : NaN
    const running = `a turn that has run ${Number.isNaN(started) ? 'over 2' : Math.max(1, Math.round((now - started) / 60_000))} min${turn?.lastTool ? ` (last tool: ${turn.lastTool})` : ''}`
    const rules = delivery.rules.join(', ')
    const itemId = `grant-waiting:${delivery.grantIds[0]}`
    if (delivery.approver === 'wizard' && this.ports.interrupt) {
      this.ports.notice(agentSessionId, `The approved call ${rules} waited behind ${running}. A wizard tab approved it, so Conductor interrupted that turn; the retry runs now as a message of its own.`, { permissionGrantWaiting: { rules: delivery.rules, interrupted: true } }, itemId)
      void this.ports.interrupt(agentSessionId).catch(error => {
        this.ports.notice(agentSessionId, `The approved call ${rules} is queued behind ${running}, and Conductor could not interrupt it (${error instanceof Error ? error.message : 'interrupt failed'}). Use "Interrupt and retry" on its approval card, or press Esc in this tab; the retry then runs at once.`, { permissionGrantWaiting: { rules: delivery.rules, interrupted: false } }, itemId)
        if (this.deliveries.get(key) === delivery) { delivery.offered = true; this.changed() }
      })
      return
    }
    this.ports.notice(agentSessionId, `The approved call ${rules} is queued behind ${running}. Use "Interrupt and retry" on its approval card, or press Esc in this tab, to interrupt the turn: the queued retry then runs at once as a message of its own (the Stop button keeps it held above the composer instead).`, { permissionGrantWaiting: { rules: delivery.rules, interrupted: false } }, itemId)
    delivery.offered = true
    this.changed()
  }

  /** An approval turn that waited RETRY_STALE_MS behind a running turn is taken back out of the
   *  queue and its grants end: a "retry it now" that late is no longer about the current work. */
  private withdrawStale(key: string, delivery: Delivery, waited: number): void {
    this.endDelivery(key, delivery)
    if (!this.ports.unqueue?.(delivery.agentSessionId, delivery.text)) return
    const { agentSessionId } = delivery
    const held = this.grants.get(agentSessionId) ?? []
    for (const id of delivery.grantIds) {
      const grant = held.find(entry => entry.id === id)
      if (!grant || this.retries.get(id) !== delivery.text) continue
      this.drop(agentSessionId, id)
      this.statusOf(agentSessionId, grant.requestId, 'expired')
    }
    void this.ports.apply(agentSessionId).catch(error => console.warn('A withdrawn grant could not be removed from the live conversation; it ends with the runtime', error))
    this.ports.notice(agentSessionId, `Withdrawn: the approval of ${delivery.rules.join(', ')} waited ${Math.round(waited / 60_000)} min behind a turn that kept running, so it was not delivered as "retry it now". Ask again if the call is still needed.`, { permissionGrantWaiting: { rules: delivery.rules, withdrawn: true } }, `grant-waiting:${delivery.grantIds[0]}`)
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
    // The provider has announced this exact attempt and will report its real result. A pre-tool
    // hook alone proves neither success nor failure, so keep the grant until that result arrives.
    if (grant.execution && !TERMINAL_EXECUTIONS.has(grant.execution.status)) return
    this.movedFrom.delete(grant.id)
    this.drop(agentSessionId, grant.id)
    this.statusOf(agentSessionId, grant.requestId, 'used')
    void this.ports.apply(agentSessionId).catch(error => console.warn('A spent grant could not be removed from the live conversation; it ends with the runtime', error))
  }

  /** The provider refused a call after its matching rule was applied. A refusal while the
   *  owner-approved retry still waits in the queue leaves the grant in place. Once that retry
   *  has been delivered, a repeated refusal ends the grant without another automatic retry. */
  refused(agentSessionId: string, rule: string): void {
    const grant = (this.grants.get(agentSessionId) ?? []).find(entry => entry.rule === rule)
    if (!grant) return
    if (this.retryWaiting(agentSessionId, grant.id)) return
    if (grant.execution?.call) {
      const execution: GrantExecution = { ...grant.execution, status: 'blocked', updatedAt: this.now(), detail: 'The provider refused the approved call.' }
      this.terminal.set(grantWorkKey(execution.call, grant.scope), { agentSessionId, execution })
      const request = this.requests.get(agentSessionId)?.get(grant.requestId)
      if (request) request.execution = execution
    }
    this.drop(agentSessionId, grant.id)
    this.statusOf(agentSessionId, grant.requestId, 'ineffective')
    this.ports.notice(agentSessionId, `Conductor applied ${rule}, but the provider refused the same call again. This approval is terminally blocked and has been withdrawn; Conductor will not retry it automatically. Inspect the native denial, rule matching and effective settings before deciding what to do. Full Auto is a separate owner-controlled setting.`, { permissionGrantIneffective: { rule } }, `grant-ineffective:${grant.id}`)
    void this.ports.apply(agentSessionId).catch(() => undefined)
  }

  /**
   * agents.handoff({successor:true}): the successor is this conversation continued, so its
   * waiting requests and unspent grants move to it. Synchronous up to the first await: from the
   * moment this is called the predecessor can neither be approved for, consume nor revoke them.
   * The predecessor's card stops asking and names the holder; the successor's tab gets the live
   * card, and an approval (or an approval already given) tells the successor to retry. The
   * predecessor's live runtime has the rules taken back before the successor is handed them.
   * Only grants approved within HANDOFF_FRESH_MS move; an older unspent one ends (expired) with a
   * notice in the predecessor's tab rather than reaching the successor as a "retry it now".
   */
  async transfer(fromId: string, toId: string): Promise<{ requests: number; grants: number }> {
    const open = this.requests.get(fromId)
    const held = this.grants.get(fromId) ?? []
    // A provider request is tied to the predecessor's live runtime. A successor cannot answer it.
    let nativeChanged = false
    for (const request of open?.values() ?? []) {
      if (request.source !== 'native') continue
      if (request.status === 'pending') {
        request.status = 'expired'
        if (request.execution) request.execution = { ...request.execution, status: 'cancelled', updatedAt: this.now(), detail: 'The native request stayed with the previous runtime at handoff.' }
        this.card(fromId, request)
        nativeChanged = true
      } else if (request.execution && !TERMINAL_EXECUTIONS.has(request.execution.status)) {
        request.execution = { ...request.execution, status: 'unknown', updatedAt: this.now(), detail: 'The previous runtime may have executed this call; inspect it before retrying.' }
        this.card(fromId, request)
        nativeChanged = true
      }
    }
    if (nativeChanged) this.changed()
    // Only a recent waiting request is still what the conversation is doing; an older one ends in
    // the predecessor's tab instead of greeting the successor with a card for a call it never made
    // (owner 2026-09-29: a successor opened with two of its predecessor's night-old denials).
    const now = this.clock()
    const movable = (request: PermissionGrantRequest): boolean => !(now - Date.parse(request.requestedAt) > HANDOFF_FRESH_MS)
    const waiting = [...(open?.values() ?? [])].filter(request => request.status === 'pending' && request.source !== 'native')
    const pending = waiting.filter(movable)
    const left = waiting.filter(request => !movable(request))
    for (const request of left) {
      request.status = 'expired'
      this.card(fromId, request)
    }
    if (left.length) this.changed()
    if (fromId === toId || (!pending.length && !held.length) || this.ports.provider(toId) !== 'claude') return { requests: 0, grants: 0 }
    // Only a recent approval is the successor's to retry; an older unspent grant (a session grant
    // is never spent) would reach it as "retry it now" for a call it never made.
    const granted = held.filter(grant => !(now - Date.parse(grant.grantedAt) > HANDOFF_FRESH_MS))
    const stale = held.filter(grant => !granted.includes(grant))
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
      // The exact call belonged to the predecessor's runtime; the successor's retry is a new call
      // that no finished-execution report of the old runtime can match, so bind by rule instead.
      delete request.call
      delete request.execution
      target.set(id, request)
    }
    if (target.size) this.requests.set(toId, target)
    if (out.size) this.movedOut.set(fromId, out)
    if (open && !open.size) this.requests.delete(fromId)
    this.grants.delete(fromId)
    for (const grant of granted) {
      grant.agentSessionId = toId
      delete grant.execution
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
    for (const grant of stale) {
      this.retries.delete(grant.id)
      this.statusOf(fromId, grant.requestId, 'expired')
      this.ports.notice(fromId, `Not handed on to ${grantHolderLabel(holder)}: ${grant.rule} was approved ${Math.round((now - Date.parse(grant.grantedAt)) / 60_000)} min ago and not retried in this conversation, so its successor is not told to retry a call it never made. It asks again if it needs the call.`, { permissionGrantStale: { rule: grant.rule } }, `grant-stale:${grant.id}`)
    }
    this.changed()
    if (held.length) await this.ports.apply(fromId).catch(error => console.warn('Moved grants could not be taken back out of the previous conversation; a spend it reports still spends them', error))
    if (granted.length) {
      const applied = await this.ports.apply(toId).catch(error => { console.warn('Moved grants could not be handed to the successor live; they apply when it next starts', error); return 'offline' as const })
      for (const grant of granted) grant.delivery = applied === 'applied' ? 'live' : applied === 'unsupported' ? 'restart' : 'pending'
      this.changed()
      const text = this.approvalText(toId, granted)
      for (const grant of granted) this.retries.set(grant.id, text)
      if (applied === 'unsupported') void this.restartThenRetry(toId, text)
      else await this.deliver(toId, text, granted, granted.some(grant => grant.decidedBy !== 'wizard') ? 'owner' : 'wizard')
    }
    return { requests: pending.length, grants: granted.length }
  }

  /** The runtime stopped for good: its requests and grants end with it, and a waiting card says so.
   *  A runtime stopped while its tab stays open (an idle CLI given back, the app quitting) ends
   *  nothing: the conversation reconnects on its next message, and sweep() ends them once the tab
   *  is closed. */
  closed(agentSessionId: string): void {
    if (this.stopping || this.ports.tabOpen?.(agentSessionId)) return
    this.missing.delete(agentSessionId)
    this.successors.delete(agentSessionId)
    this.movedOut.delete(agentSessionId)
    this.withdraw(agentSessionId)
    this.aliases.delete(agentSessionId)
    this.settled.delete(agentSessionId)
    for (const grant of this.grants.get(agentSessionId) ?? []) this.retries.delete(grant.id)
    if (!this.requests.delete(agentSessionId) && !this.grants.delete(agentSessionId)) return
    this.grants.delete(agentSessionId)
    this.changed()
  }

  /** Follows the approval turns being delivered (followDeliveries), ends the grants of every
   *  conversation whose tab was closed (tabOpen), and takes them back out of a runtime that is
   *  still running. Cheap when nothing is granted; wiring.ts runs it every second. */
  sweep(): void {
    if (this.stopping) return
    this.expireOutages()
    this.followDeliveries()
    if (!this.ports.tabOpen) return
    for (const agentSessionId of new Set([...this.grants.keys(), ...this.requests.keys()])) {
      if (this.ports.tabOpen(agentSessionId)) { this.missing.delete(agentSessionId); continue }
      if (!this.missing.has(agentSessionId)) { this.missing.add(agentSessionId); continue }
      this.missing.delete(agentSessionId)
      const granted = this.grants.get(agentSessionId) ?? []
      this.grants.delete(agentSessionId)
      for (const grant of granted) { this.retries.delete(grant.id); this.statusOf(agentSessionId, grant.requestId, 'expired') }
      this.withdraw(agentSessionId)
      this.requests.delete(agentSessionId)
      this.aliases.delete(agentSessionId)
      this.settled.delete(agentSessionId)
      this.changed()
      if (granted.length) void this.ports.apply(agentSessionId).catch(error => console.warn('A grant of a closed tab could not be removed from its live runtime; it ends with the runtime', error))
    }
  }

  /** A classifier-outage card an older build raised (the adapter no longer does) is withdrawn once
   *  its conversation's turn has settled: expired, never answered, and restated as a plain notice
   *  so the tab stops asking for attention. */
  expireOutages(): void {
    let changed = false
    for (const [agentSessionId, open] of this.requests) {
      if (ACTIVE_PHASES.has(this.ports.phase(agentSessionId) ?? '')) continue
      for (const request of open.values()) {
        if (request.status !== 'pending' || !outageCard(request)) continue
        request.status = 'expired'
        changed = true
        const outage = { tool: request.tool, reason: request.category!, toolUseId: request.toolUseId ?? request.id.replace(/^auto-denial:/, '') }
        this.ports.notice(agentSessionId, `Withdrawn: ${classifierOutageMessage(outage)}`, { ...(classifierOutagePayload(outage) as Record<string, Json>), grantStatus: 'expired' }, request.id)
      }
    }
    if (changed) this.changed()
  }

  /** A tab that ends without a successor: its waiting cards stop asking (no orphaned card). */
  private withdraw(agentSessionId: string): void {
    for (const request of this.requests.get(agentSessionId)?.values() ?? []) {
      if (request.status !== 'pending') continue
      request.status = 'expired'
      this.card(agentSessionId, request)
    }
  }

  /** Whether the grant's approval turn (retry) still waits in the conversation's queue. */
  private retryWaiting(agentSessionId: string, grantId: string): boolean {
    const told = this.retries.get(grantId)
    return Boolean(told && this.ports.retryQueued?.(agentSessionId, told))
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
    const answered = this.settled.get(agentSessionId)?.get(requestId)
    if (answered) throw new Error(`This request was already answered (${answered})`)
    if (requestId.startsWith(AGENT_PREFIX)) throw new Error('No such permission request in this conversation')
    const denial = this.ports.denial(agentSessionId, requestId)
    if (!denial?.request || autoModeDenialItemId(denial.toolUseId) !== requestId) throw new Error('No such permission request in this conversation')
    if (isClassifierOutage(denial.reason)) throw new Error('This request was already answered (expired): the classifier was unavailable, which is not a permission question')
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
    this.retries.delete(grantId)
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
    if (request.source !== 'denial') {
      const message = request.status === 'pending'
        ? `Permission requested: ${grantRequestSummary(request)}${request.rule ? `. Approving hands this conversation exactly ${request.rule}.` : request.source === 'native' ? '. The exact native provider request can be allowed once while it remains pending.' : `. ${request.refusal ?? ''}`}`
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

  private async restartThenRetry(agentSessionId: string, text: string): Promise<void> {
    const deadline = Date.now() + (this.ports.idleWaitMs ?? 10 * 60_000)
    while (ACTIVE_PHASES.has(this.ports.phase(agentSessionId) ?? '') && Date.now() < deadline) await new Promise(done => setTimeout(done, this.ports.idlePollMs ?? 2000))
    if (!this.grants.get(agentSessionId)?.length) return
    try {
      if (ACTIVE_PHASES.has(this.ports.phase(agentSessionId) ?? '')) throw new Error('the conversation did not settle')
      await this.ports.restart(agentSessionId)
      await this.ports.retry(agentSessionId, text)
    } catch (error) {
      this.ports.notice(agentSessionId, `The approved rule could not be handed to this conversation (${error instanceof Error ? error.message : 'restart failed'}). It still applies the next time the conversation starts.`, { permissionGrantDelivery: 'failed' }, `grant-delivery:${agentSessionId}`)
    }
  }
}
