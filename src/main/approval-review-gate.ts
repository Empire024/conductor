import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { AgentSpec } from '../shared/models'
import type { AdapterEvent, InteractionResponse, Json, PendingInteraction, SessionSettings } from '../shared/structured-agent'
import { workspacePath } from './agent-artifacts'
import { ApprovalReviews, actionDigest, canonicalAction, type ReviewAction, type ReviewPersistence, type ReviewRecord, type ReviewResult } from './approval-review'
import { commandClass, sessionRules } from './approval-review-rules'
import { routineClass } from './approval-review-routine'
import { ownerOnlyEscalation } from './providers/codex'
import { sanitizeDiagnostic } from './structured-store'

/** Arguments as the reviewer sees them: whole when small, a deterministic prefix when a file
 *  write or diff would blow the reviewer context. The same inputs always give the same value, so
 *  the digest that binds the review to the request still holds. */
const REVIEWER_ARGUMENT_CHARS = 20000
function boundedArguments(value: Json): Json {
  const canonical = canonicalAction(value)
  if (canonical.length <= REVIEWER_ARGUMENT_CHARS) return value
  return { truncatedForReview: true, totalChars: canonical.length, preview: canonical.slice(0, REVIEWER_ARGUMENT_CHARS) }
}
/** The canonical workspace target of a file a tool may create, also inside folders that do not
 *  exist yet (VR8a A4): the nearest existing ancestor gets workspacePath's realpath containment
 *  check, and the missing rest, which cannot be a link, is appended to it. */
export async function reviewTargetPath(cwd: string, requested: string): Promise<string> {
  try { return await workspacePath(cwd, requested, true) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const missing: string[] = []
  for (let current = resolve(cwd, requested); dirname(current) !== current;) {
    missing.unshift(basename(current))
    current = dirname(current)
    try { return join(await workspacePath(cwd, current), ...missing) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new Error('No existing folder holds this path')
}
/** The text a command-like request acts through, for the owner-only boundary check. */
export function reachOf(input: Record<string, Json>): string {
  const parts: string[] = []
  for (const key of ['command', 'cmd', 'commands', 'permissions', 'grantRoot', 'changes', 'file_path', 'notebook_path', 'path', 'url'] as const) if (input[key] !== undefined) parts.push(canonicalAction(input[key]))
  return parts.join('\n')
}

/** Who answers the next owner-path response to one request instead of the owner's card: set by
 *  agents.approve (wizard-approvals.ts) just before it responds, consumed by reserve(). */
const attributions = new Map<string, string>()
const attributionKey = (response: Pick<InteractionResponse, 'sessionId' | 'runtimeId' | 'requestId'>) => canonicalAction([response.sessionId, response.runtimeId, response.requestId])
/** Returns a check to run after the response: true when a bound review journaled the answer. */
export function attributeAnswer(response: Pick<InteractionResponse, 'sessionId' | 'runtimeId' | 'requestId'>, answeredBy: string): () => boolean {
  const key = attributionKey(response)
  attributions.set(key, answeredBy)
  return () => !attributions.delete(key)
}
/** The review cost line a worker's usage summary shows (a payload notice, so not a timeline row). */
export interface ApprovalReviewUsage { reviews: number; covered: number; rules: number; routine: number; tokens: number | null; elapsedMs: number | null; budget: { used: number; cap: number } | null }
export const APPROVAL_REVIEW_USAGE_ITEM = 'approval-review-usage'
const tokenTotal = (usage: Json | undefined): number | undefined => {
  const report = object(usage), tokens = object(object(report.run).tokens ?? object(report.conversation).tokens)
  const value = (key: string) => typeof tokens[key] === 'number' ? tokens[key] as number : 0
  const total = typeof tokens.totalTokens === 'number' ? tokens.totalTokens : value('inputTokens') + value('outputTokens') + value('cacheCreationTokens') + value('cachedTokens')
  return total > 0 ? total : undefined
}

export interface ApprovalReviewRouting {
  enabled(spec: AgentSpec): boolean
  /** Reviews spent and allowed for the owner task this action belongs to. */
  budget?(action: ReviewAction): { used: number; cap: number }
  authorization(spec: AgentSpec): { text: string; id: string; ownerTaskId?: string }
  run(spec: AgentSpec, action: ReviewAction, digest: string): Promise<ReviewResult>
  /** Model intelligence's approval shadow (docs/model-routing.md, E): told when a reviewer turn
   *  starts, what it decided and what the owner answered. Called synchronously and guarded; it
   *  never delays or changes a review. Absent: the gate behaves exactly as without it. */
  shadow?: ApprovalReviewShadow
  /** @deprecated Never consulted since 18312fd: the owner accepted review without execution-time
   *  enforcement of the reviewed preconditions for their own coworkers. Kept so older fixtures type-check. */
  supportsExactExecution?(spec: AgentSpec): boolean
}
export interface ApprovalReviewShadow {
  /** Only on a boundary the owner switched live (decisions.list/decisions.live): a confident local allow of a
   *  workspace-write action, answered as covered without a reviewer turn. Null, or a throw: the reviewer runs. */
  decideLive?(spec: AgentSpec, action: ReviewAction): Promise<{ key: string; rationale: string } | null>
  reviewing(spec: AgentSpec, action: ReviewAction): void
  reviewed(record: ReviewRecord): void
  answered(record: ReviewRecord): void
}
type Binding = { spec: AgentSpec; runtimeId: string; source: AdapterEvent; interaction: PendingInteraction; action?: ReviewAction; record?: ReviewRecord; settled?: 'owner' }
const object = (value: unknown): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {}
/** Phases after which a record carries a response intent; an owner answer no longer changes them. */
const SETTLED_PHASES = ['responding', 'responded', 'execution-unknown', 'executed', 'execution-failed']

/** Intercepts before actionable UI publication and is also checked by the single response API. */
export class ApprovalReviewGate {
  readonly journal: ApprovalReviews
  routing?: ApprovalReviewRouting
  private bindings = new Map<string, Binding>()
  constructor(persistence: ReviewPersistence, private settings: (id: string) => SessionSettings | undefined,
    private publish: (id: string, runtimeId: string, source: AdapterEvent) => void,
    private respond: (response: InteractionResponse) => Promise<void>) { this.journal = new ApprovalReviews(persistence) }
  private key(id: string, runtime: string, request: string) { return canonicalAction([id, runtime, request]) }
  async guardTool(spec: AgentSpec, tool: string, input: Json): Promise<string | undefined> {
    if (!this.journal.hasDenials(spec.projectId) || ['Read', 'Grep', 'Glob', 'LS', 'AskUserQuestion', 'TodoWrite'].includes(tool)) return undefined
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      const args = object(input), requested = args.file_path ?? args.notebook_path
      if (typeof requested === 'string') {
        const path = await reviewTargetPath(spec.cwd, requested)
        const action = { projectId: spec.projectId, machineId: 'local', paths: [process.platform === 'win32' ? path.toLowerCase() : path] } as ReviewAction
        if (!this.journal.denied(action)) return undefined
      }
    }
    return 'A durable approval denial protects this project target. This tool route cannot retry or bypass it.'
  }
  /** What the owner sees while the review runs or after it stopped. The owner's own choices are
   *  never taken away: a reviewer may answer for the owner, but no review state, least of all a
   *  review that could not run, may lock the owner out of a request the runtime is waiting on. */
  private projection(binding: Binding): AdapterEvent {
    const record = binding.record
    const review = record ? { id: record.id, digest: record.digest, phase: record.phase, rationale: record.rationale, reviewerModel: record.reviewerModel } : { id: '', digest: '', phase: 'reviewing', rationale: 'Preparing exact action and authorization for review' }
    const title = record?.phase === 'owner' ? `Owner decision: ${binding.interaction.title}` : !record || record.phase === 'reviewing' ? 'Pending stronger-model review' : binding.interaction.title
    return { ...binding.source, data: { type: 'interaction', interaction: { ...binding.interaction, review, title } } }
  }
  intercept(spec: AgentSpec, runtimeId: string, source: AdapterEvent): AdapterEvent {
    if (source.data.type === 'tool' && ['completed', 'failed', 'rejected'].includes(source.data.status)) {
      for (const binding of this.bindings.values()) if (binding.spec.id === spec.id && binding.runtimeId === runtimeId && binding.source.itemId && binding.source.itemId === source.itemId && binding.record) {
        const record = this.journal.get(binding.record.projectId, binding.record.id)!
        if (['responding', 'responded', 'execution-unknown'].includes(record.phase)) binding.record = this.journal.transition(record, source.data.status === 'completed' ? 'executed' : 'execution-failed', 'Native tool reported ' + source.data.status)
      }
    }
    if (source.data.type !== 'interaction' || source.data.interaction.kind !== 'approval') return source
    if (source.data.interaction.status !== 'pending') {
      const binding = this.bindings.get(this.key(spec.id, runtimeId, source.data.interaction.id))
      const record = binding?.record && this.journal.get(spec.projectId, binding.record.id)
      return record ? { ...source, data: { type: 'interaction', interaction: { ...source.data.interaction, review: { id: record.id, digest: record.digest, phase: record.phase, rationale: record.rationale, reviewerModel: record.reviewerModel } } } } : source
    }
    const interaction = source.data.interaction, key = this.key(spec.id, runtimeId, interaction.id)
    const old = this.bindings.get(key)
    if (!old && !this.routing?.enabled(spec)) return source
    if (old && canonicalAction(old.interaction.input) === canonicalAction(interaction.input) && canonicalAction(old.source.native) === canonicalAction(source.native)) return this.projection(old)
    const binding: Binding = { spec, runtimeId, source: structuredClone(source), interaction: structuredClone(interaction) }
    this.bindings.set(key, binding)
    queueMicrotask(() => { void this.prepare(binding).catch(error => this.pause(binding, error)) })
    return this.projection(binding)
  }
  /** Tells the shadow, if any; its failure is never the review's. */
  private tell(event: 'reviewed' | 'answered', record: ReviewRecord | undefined): void {
    if (!record) return
    try { this.routing?.shadow?.[event](record) } catch { /* the shadow only observes */ }
  }
  private update(binding: Binding, record: ReviewRecord): void { binding.record = record; this.publish(binding.spec.id, binding.runtimeId, this.projection(binding)) }
  /** The review stopped without a decision. The request stays a normal owner approval, with the
   *  reason shown; nothing about the owner's choices changes. */
  private pause(binding: Binding, error: unknown): void {
    if (binding.settled) return
    const reason = String(sanitizeDiagnostic(error instanceof Error ? error.message : 'Review unavailable'))
    if (binding.record) { this.update(binding, this.journal.transition(this.journal.get(binding.record.projectId, binding.record.id)!, 'paused', reason)); this.tell('reviewed', binding.record) }
    else this.publish(binding.spec.id, binding.runtimeId, { ...binding.source, data: { type: 'interaction', interaction: { ...binding.interaction, review: { id: '', digest: '', phase: 'paused', rationale: reason } } } })
  }
  private async action(binding: Binding): Promise<ReviewAction> {
    if (!this.routing?.enabled(binding.spec)) throw new Error('Owner review authorization is absent or was revoked')
    const authorization = this.routing.authorization(binding.spec), native = object(binding.source.native?.payload)
    const input = object(binding.interaction.input), tool = typeof native.tool_name === 'string' ? native.tool_name : binding.source.native?.method ?? 'Unknown native action'
    const settings = this.settings(binding.spec.id)
    // Every request a worker under review raises is reviewable: the point of "Review coworkers"
    // is that a stronger model answers what Auto could not answer by itself, so the owner sees
    // fewer cards, not more. Only an owner-only boundary (an explicit ask rule, a protected
    // path, or a command that reaches the system, credentials or recursive deletion) is kept
    // as 'native-owner', where the reviewer may deny or escalate but never allow.
    let boundary: ReviewAction['boundary'] = 'workspace-write', reason = 'A routine action of a delegated task: allow what the task plausibly needs inside the workspace, deny what harms it, escalate what needs more owner permission', paths: string[] = [], sideEffects: string[] = []
    const claudeTool = binding.spec.provider === 'claude' && binding.source.native?.method === 'can_use_tool'
    const requested = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
    if (claudeTool && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && requested) {
      const path = await reviewTargetPath(binding.spec.cwd, requested)
      const localPath = relative(binding.spec.cwd, path).replaceAll('\\', '/')
      if (localPath.includes(':') || /(?:^|\/)(?:\.git|\.codex|\.claude|\.agents)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|\.mcp\.json)$/i.test(localPath)) throw new Error('Protected configuration, repository metadata or alternate-stream writes require an unsupported native boundary')
      // Existing protected-path and realpath validation stays authoritative. Bind the existing
      // file bytes as a review precondition; a writer racing the reviewer invalidates the grant.
      let before = 'absent'
      try { if ((await stat(path)).size > 1_000_000) throw new Error('Review target exceeds the bounded file limit'); before = createHash('sha256').update(await readFile(path)).digest('hex') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      paths = [process.platform === 'win32' ? path.toLowerCase() : path]
      sideEffects = [tool === 'Write' ? 'Replace this file with the exact supplied content' : 'Apply the exact supplied edit', 'Prior file SHA-256: ' + before]
      reason = 'One exact native workspace file mutation; no session grants or mode switches'
    } else if (claudeTool) {
      sideEffects = [`Run the ${tool} tool once with exactly these arguments; no session grant`]
    } else {
      sideEffects = ['Answer this native request once, for this request only; no session-wide grant, no policy amendment']
    }
    const reach = ownerOnlyEscalation(reachOf(input))
    if (claudeTool && native.matched_ask_rule != null) { boundary = 'native-owner'; reason = String(native.decision_reason ?? 'Claude matched an owner ask rule; stronger review cannot replace that rule') }
    else if (reach) { boundary = 'native-owner'; reason = `This request reaches ${reach}, an owner-only boundary; the reviewer may only deny it or escalate it to the owner` }
    if (settings?.plan || settings?.permission === 'read-only' || settings?.sandbox === 'read-only') { boundary = 'unsupported'; reason = 'Owner plan/read-only restriction forbids approving this action' }
    const action: ReviewAction = { projectId: binding.spec.projectId, machineId: 'local', cwd: binding.spec.cwd, ...(authorization.ownerTaskId ? { ownerTaskId: authorization.ownerTaskId } : {}), workerId: binding.spec.id, runtimeId: binding.runtimeId, requestId: binding.interaction.id,
      tool, arguments: boundedArguments(binding.interaction.input), paths, boundary, reason, sideEffects, ownerEvidence: authorization.text, authorizationId: authorization.id, native: boundedArguments(native) }
    if (canonicalAction(action).length > 64000) throw new Error('Exact action and authorization exceed the bounded reviewer context; no truncated review was sent')
    if (canonicalAction(sanitizeDiagnostic(action)) !== canonicalAction(action)) throw new Error('Exact review context contains sensitive fields; automatic review is unavailable without exposing credentials')
    return action
  }
  private async prepare(binding: Binding): Promise<void> {
    binding.action = await this.action(binding)
    // A class this worker was already allowed in this session is answered from that rule: the
    // journal still records it and every fence still applies, but no reviewer turn is paid for.
    // A routine in-workspace action an Auto worker would simply run (approval-review-routine.ts)
    // is allowed without any review at all, and journaled as that automatic allow.
    const scope = { workerId: binding.spec.id, runtimeId: binding.runtimeId }
    const claudeTool = binding.spec.provider === 'claude' && binding.source.native?.method === 'can_use_tool'
    const routine = claudeTool ? await routineClass(binding.action, binding.interaction.input, binding.spec.cwd) : undefined
    const rule = routine ? undefined : sessionRules.covering(scope, { ...binding.action, cwd: binding.spec.cwd })
    const covered = routine ? { key: routine, rationale: `Routine in-workspace action (${routine.slice('routine:'.length)}): allowed automatically, as Auto mode would; no review` }
      : rule ? { key: rule.key, rationale: `Covered by this conversation's session rule "${rule.key}" (${rule.source === 'wizard' ? 'allowed for the session by ' + rule.by : 'first allowed by the ' + rule.by + ' review'}); no new review` }
      : await this.liveVerdict(binding.spec, binding.action)
    if (!covered) try { this.routing?.shadow?.reviewing(binding.spec, binding.action) } catch { /* the shadow only observes */ }
    const record = await this.journal.review(binding.action, digest => this.routing!.run(binding.spec, binding.action!, digest), record => { if (!binding.settled) this.update(binding, record) }, covered)
    if (record.phase === 'approved' && record.reviewerId && !record.coveredBy) {
      const key = commandClass({ ...binding.action, cwd: binding.spec.cwd })
      if (key) sessionRules.add(scope, { key, source: 'review', recordId: record.id, by: record.reviewerModel ?? 'stronger', at: record.updatedAt, example: binding.action.tool })
    }
    if (!covered) this.tell('reviewed', record)
    this.report(binding)
    // An owner who answered meanwhile has already settled the record; the reviewer's late word is not used.
    if (binding.settled) return
    this.update(binding, record)
    if (this.bindings.get(this.key(binding.spec.id, binding.runtimeId, binding.interaction.id)) !== binding) return
    if (record.phase === 'approved' || record.phase === 'denied') {
      const decision = record.phase === 'approved' ? 'allow' : 'deny'
      if (!binding.interaction.choices.some(choice => choice.id === decision && !choice.disabled)) { this.update(binding, this.journal.transition(record, 'blocked', 'Native provider did not offer the exact one-action response')); return }
      await this.respond({ sessionId: binding.spec.id, runtimeId: binding.runtimeId, requestId: binding.interaction.id, decision })
    }
  }
  /** A live boundary's local allow (model intelligence, decisions.live), else undefined and the reviewer decides. */
  private async liveVerdict(spec: AgentSpec, action: ReviewAction): Promise<{ key: string; rationale: string } | undefined> {
    try { return await this.routing?.shadow?.decideLive?.(spec, action) ?? undefined } catch { return undefined }
  }
  /** What the worker's reviews cost so far, for its usage line (StructuredUsageSummary). */
  usage(spec: AgentSpec, action?: ReviewAction): ApprovalReviewUsage {
    const records = this.journal.forWorker(spec.projectId, spec.id)
    const reviewed = records.filter(record => record.reviewerId && !record.coveredBy)
    let tokens = 0, counted = false, elapsed = 0, timed = false
    for (const record of reviewed) {
      const total = tokenTotal(record.reviewerUsage)
      if (total !== undefined) { tokens += total; counted = true }
      if (typeof record.reviewerElapsedMs === 'number') { elapsed += record.reviewerElapsedMs; timed = true }
    }
    const routine = records.filter(record => record.coveredBy?.startsWith('routine:')).length
    return { reviews: reviewed.length, covered: records.filter(record => record.coveredBy).length - routine, routine, rules: action ? sessionRules.list({ workerId: spec.id, runtimeId: action.runtimeId }).length : 0, tokens: counted ? tokens : null, elapsedMs: timed ? elapsed : null, budget: action && this.routing?.budget ? this.routing.budget(action) : null }
  }
  private report(binding: Binding): void {
    try {
      const usage = this.usage(binding.spec, binding.action)
      const cost = [usage.tokens !== null ? `${usage.tokens.toLocaleString('en-US')} tokens` : '', usage.elapsedMs !== null ? `${Math.round(usage.elapsedMs / 1000)} s` : ''].filter(Boolean).join(', ')
      const message = `Approval reviews: ${usage.reviews}${cost ? ` (${cost})` : ''}; ${usage.covered} answered by ${usage.rules} session rule${usage.rules === 1 ? '' : 's'}; ${usage.routine} routine allowed without review${usage.budget ? `; task budget ${usage.budget.used}/${usage.budget.cap}` : ''}`
      this.publish(binding.spec.id, binding.runtimeId, { itemId: APPROVAL_REVIEW_USAGE_ITEM, data: { type: 'notice', message, payload: { approvalReviews: usage as unknown as Json } } })
    } catch { /* The cost line is informational; it never holds up an answer. */ }
  }
  /** The automatic path is strict: an exact, unchanged action and a matching reviewer decision, or
   *  nothing is sent. The owner's path always passes. A review that never reached a record, one
   *  that paused or was blocked, one still running: none of them may hold back the answer of the
   *  person the review was standing in for. An answer given after the reviewer's explicit
   *  escalation keeps its journaled meaning, so a denial there still fences the target. */
  async reserve(response: InteractionResponse, automatic: boolean, required = false): Promise<ReviewRecord | undefined> {
    const binding = this.bindings.get(this.key(response.sessionId, response.runtimeId, response.requestId))
    if (!binding) { if (automatic && required) throw new Error('Required stronger review has no live action binding'); return undefined }
    const decision = response.decision ?? ''
    const record = binding.record && this.journal.get(binding.record.projectId, binding.record.id)
    if (automatic) {
      if (!binding.action || !record) throw new Error('Stronger-model review has not completed')
      if (binding.settled) throw new Error('The owner already answered this request')
      const current = await this.action(binding)
      if (actionDigest(current) !== actionDigest(binding.action)) { this.update(binding, this.journal.transition(record, 'blocked', 'Arguments, target contents or owner authorization changed during review; fresh review is required')); throw new Error('Reviewed action has changed') }
      if (!['allow', 'deny'].includes(decision)) throw new Error('Only the exact one-action decision is supported by review routing')
      if (decision === 'allow' ? record.phase !== 'approved' : record.phase !== 'denied') throw new Error('The reviewer did not authorize this decision')
      binding.record = this.journal.reserve(current)
      return binding.record
    }
    binding.settled = 'owner'
    const answeredBy = attributions.get(attributionKey(response))
    attributions.delete(attributionKey(response))
    if (record?.phase === 'owner' && binding.action && (decision === 'allow' || decision === 'deny')) {
      try {
        const current = await this.action(binding)
        if (actionDigest(current) === actionDigest(binding.action)) { binding.record = this.journal.reserve(current, decision, answeredBy); this.tell('answered', binding.record); return binding.record }
      } catch { /* The exact-action grant cannot be journaled; the owner's answer still goes through below. */ }
    }
    if (record && !SETTLED_PHASES.includes(record.phase)) {
      binding.record = this.journal.transition(record, 'responding', `${answeredBy ?? 'Owner'} answered while the review was ${record.phase}; the reviewer's result is not used`, { ...(decision === 'allow' || decision === 'deny' ? { ownerAnswer: decision } : {}), ...(answeredBy ? { answeredBy } : {}) })
      this.tell('answered', binding.record)
      return binding.record
    }
    return undefined
  }
  finish(record: ReviewRecord, delivered: boolean): void {
    const latest = this.journal.get(record.projectId, record.id)!
    if (['executed', 'execution-failed'].includes(latest.phase)) return
    // Native response delivery is not evidence of actual execution.
    this.journal.transition(latest, delivered ? 'responded' : 'execution-unknown', delivered ? 'Native response delivered; execution result not yet observed' : 'Native response delivery uncertain; never retry this logical operation')
  }
}
