import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { AgentSpec } from '../shared/models'
import type { AdapterEvent, InteractionResponse, Json, PendingInteraction, SessionSettings } from '../shared/structured-agent'
import { workspacePath } from './agent-artifacts'
import { ApprovalReviews, actionDigest, canonicalAction, type ReviewAction, type ReviewPersistence, type ReviewRecord, type ReviewResult } from './approval-review'
import { sanitizeDiagnostic } from './structured-store'

export interface ApprovalReviewRouting {
  enabled(spec: AgentSpec): boolean
  authorization(spec: AgentSpec): { text: string; id: string; ownerTaskId?: string }
  run(spec: AgentSpec, action: ReviewAction, digest: string): Promise<ReviewResult>
  /** Trusted executor contract, never read from a worker or a native request payload.
   * No current production adapter establishes atomic preconditions/cross-route fencing. */
  supportsExactExecution?(spec: AgentSpec): boolean
}
type Binding = { spec: AgentSpec; runtimeId: string; source: AdapterEvent; interaction: PendingInteraction; action?: ReviewAction; record?: ReviewRecord }
const object = (value: unknown): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {}

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
        const path = await workspacePath(spec.cwd, requested, true)
        const action = { projectId: spec.projectId, machineId: 'local', paths: [process.platform === 'win32' ? path.toLowerCase() : path] } as ReviewAction
        if (!this.journal.denied(action)) return undefined
      }
    }
    return 'A durable approval denial protects this project target. This tool route cannot retry or bypass it.'
  }
  private projection(binding: Binding): AdapterEvent {
    const record = binding.record
    const review = record ? { id: record.id, digest: record.digest, phase: record.phase, rationale: record.rationale, reviewerModel: record.reviewerModel } : { id: '', digest: '', phase: 'reviewing', rationale: 'Preparing exact action and authorization for review' }
    const owner = record?.phase === 'owner'
    return { ...binding.source, data: { type: 'interaction', interaction: { ...binding.interaction, review,
      title: owner ? `Owner decision: ${binding.interaction.title}` : record?.phase === 'blocked' ? 'Approval boundary blocked' : record?.phase === 'paused' ? 'Approval review paused' : 'Pending stronger-model review',
      choices: binding.interaction.choices.map(choice => ({ ...choice, disabled: !owner || !['allow', 'deny', 'accept', 'decline'].includes(choice.id) || choice.disabled })) } } }
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
  private update(binding: Binding, record: ReviewRecord): void { binding.record = record; this.publish(binding.spec.id, binding.runtimeId, this.projection(binding)) }
  private pause(binding: Binding, error: unknown): void {
    const reason = String(sanitizeDiagnostic(error instanceof Error ? error.message : 'Review unavailable'))
    if (binding.record) this.update(binding, this.journal.transition(this.journal.get(binding.record.projectId, binding.record.id)!, 'paused', reason))
    else this.publish(binding.spec.id, binding.runtimeId, { ...binding.source, data: { type: 'interaction', interaction: { ...binding.interaction, title: 'Approval review paused', review: { id: '', digest: '', phase: 'paused', rationale: reason }, choices: binding.interaction.choices.map(choice => ({ ...choice, disabled: true })) } } })
  }
  private async action(binding: Binding): Promise<ReviewAction> {
    if (!this.routing?.enabled(binding.spec)) throw new Error('Owner review authorization is absent or was revoked')
    const authorization = this.routing.authorization(binding.spec), native = object(binding.source.native?.payload)
    const input = object(binding.interaction.input), tool = typeof native.tool_name === 'string' ? native.tool_name : binding.source.native?.method ?? 'Unknown native action'
    const settings = this.settings(binding.spec.id)
    let boundary: ReviewAction['boundary'] = 'unsupported', reason = 'This native approval has no implemented exact-action review boundary', paths: string[] = [], sideEffects: string[] = []
    if (binding.spec.provider === 'claude' && binding.source.native?.method === 'can_use_tool' && ['Write', 'Edit'].includes(tool) && typeof input.file_path === 'string') {
      const path = await workspacePath(binding.spec.cwd, input.file_path, true)
      const localPath = relative(binding.spec.cwd, path).replaceAll('\\', '/')
      if (localPath.includes(':') || /(?:^|\/)(?:\.git|\.codex|\.claude|\.agents)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|\.mcp\.json)$/i.test(localPath)) throw new Error('Protected configuration, repository metadata or alternate-stream writes require an unsupported native boundary')
      // Existing protected-path and realpath validation stays authoritative. Bind the existing
      // file bytes as a review precondition; a writer racing the reviewer invalidates the grant.
      let before = 'absent'
      try { if ((await stat(path)).size > 1_000_000) throw new Error('Review target exceeds the bounded file limit'); before = createHash('sha256').update(await readFile(path)).digest('hex') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      paths = [process.platform === 'win32' ? path.toLowerCase() : path]
      sideEffects = [tool === 'Write' ? 'Replace this file with the exact supplied content' : 'Apply the exact supplied string replacement', 'Prior file SHA-256: ' + before]
      const mandatory = native.matched_ask_rule != null || /requires? (?:user )?approval|requires? user interaction/i.test(String(native.decision_reason ?? ''))
      boundary = mandatory ? 'native-owner' : 'workspace-write'
      reason = mandatory ? String(native.decision_reason ?? 'Claude matched an owner ask rule; stronger review cannot replace that rule') : 'One exact native workspace file mutation; no session grants or mode switches'
      if (settings?.plan || settings?.permission === 'read-only' || settings?.sandbox === 'read-only') { boundary = 'unsupported'; reason = 'Owner plan/read-only restriction forbids approving this mutation' }
      if (boundary !== 'unsupported' && !this.routing.supportsExactExecution?.(binding.spec)) {
        boundary = 'unsupported'
        reason = 'This native runtime cannot enforce reviewed file preconditions at execution time or fence equivalent writes across providers. Automatic execution is blocked; a shared mutation broker is required.'
      }
    }
    const action: ReviewAction = { projectId: binding.spec.projectId, machineId: 'local', cwd: binding.spec.cwd, ...(authorization.ownerTaskId ? { ownerTaskId: authorization.ownerTaskId } : {}), workerId: binding.spec.id, runtimeId: binding.runtimeId, requestId: binding.interaction.id,
      tool, arguments: binding.interaction.input, paths, boundary, reason, sideEffects, ownerEvidence: authorization.text, authorizationId: authorization.id, native }
    if (canonicalAction(action).length > 24000) throw new Error('Exact action and authorization exceed the bounded reviewer context; no truncated review was sent')
    if (canonicalAction(sanitizeDiagnostic(action)) !== canonicalAction(action)) throw new Error('Exact review context contains sensitive fields; automatic review is unavailable without exposing credentials')
    return action
  }
  private async prepare(binding: Binding): Promise<void> {
    binding.action = await this.action(binding)
    const record = await this.journal.review(binding.action, digest => this.routing!.run(binding.spec, binding.action!, digest), record => this.update(binding, record))
    this.update(binding, record)
    if (this.bindings.get(this.key(binding.spec.id, binding.runtimeId, binding.interaction.id)) !== binding) return
    if (record.phase === 'approved' || record.phase === 'denied') {
      const decision = record.phase === 'approved' ? 'allow' : 'deny'
      if (!binding.interaction.choices.some(choice => choice.id === decision && !choice.disabled)) { this.update(binding, this.journal.transition(record, 'blocked', 'Native provider did not offer the exact one-action response')); return }
      await this.respond({ sessionId: binding.spec.id, runtimeId: binding.runtimeId, requestId: binding.interaction.id, decision })
    }
  }
  async reserve(response: InteractionResponse, automatic: boolean, required = false): Promise<ReviewRecord | undefined> {
    const binding = this.bindings.get(this.key(response.sessionId, response.runtimeId, response.requestId))
    if (!binding) { if (required) throw new Error('Required stronger review has no live action binding'); return undefined }
    if (!binding.action || !binding.record) throw new Error('Stronger-model review has not completed')
    const current = await this.action(binding)
    if (actionDigest(current) !== actionDigest(binding.action)) { this.update(binding, this.journal.transition(binding.record, 'blocked', 'Arguments, target contents or owner authorization changed during review; fresh review is required')); throw new Error('Reviewed action has changed') }
    if (!['allow', 'deny'].includes(response.decision ?? '')) throw new Error('Only the exact one-action decision is supported by review routing')
    if (automatic && (response.decision === 'allow' ? binding.record.phase !== 'approved' : binding.record.phase !== 'denied')) throw new Error('The reviewer did not authorize this decision')
    const record = this.journal.reserve(current, automatic ? undefined : response.decision as 'allow' | 'deny')
    binding.record = record
    return record
  }
  finish(record: ReviewRecord, delivered: boolean): void {
    const latest = this.journal.get(record.projectId, record.id)!
    if (['executed', 'execution-failed'].includes(latest.phase)) return
    // Native response delivery is not evidence of actual execution.
    this.journal.transition(latest, delivered ? 'responded' : 'execution-unknown', delivered ? 'Native response delivered; execution result not yet observed' : 'Native response delivery uncertain; never retry this logical operation')
  }
}
