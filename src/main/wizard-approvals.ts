import { isAbsolute, relative, resolve } from 'node:path'
import { describeGrantRequest } from '../shared/permission-grants'
import type { InteractionResponse, Json, PendingInteraction, SessionProjection, TimelineItem } from '../shared/structured-agent'
import { ApprovalReviews, canonicalAction, type ReviewPersistence } from './approval-review'
import { attributeAnswer, reachOf } from './approval-review-gate'
import { commandClass, commandText, sessionRules } from './approval-review-rules'
import { ownerOnlyEscalation } from './providers/codex'

/**
 * A wizard answers its coworkers' approvals itself (wizard-answers-approvals, owner 2026-09-25:
 * "wizard needs exactly that ability"). agents.approvals lists what the caller's coworkers are
 * waiting on, with the exact action; agents.approve answers one, recorded in the approval journal
 * like a review. Only a wizard tab (over the coworkers it controls) or the owner's control
 * credential (over the project's conversations) may call them, never for its own request. The wand
 * holds the owner's authority, so, as in the card and in permissions.decide, every class may be
 * allowed (owner decision 2026-09-28, gap H13): a shared, destructive or external action, or one
 * that reaches credentials, the system or outside the workspace, is listed with why it needs
 * attention. The coworker's runtime still decides what it offers: only its enabled choices are
 * answered, so no provider or managed restriction is lifted here.
 */
export const WIZARD_APPROVAL_SIGNATURES: Record<string, string> = {
  'agents.approvals': '({agentSessionId?}) — wizard tab or owner credential only: the approvals your coworkers are waiting on (or one coworker\'s), each with requestId, the exact tool and arguments, its class (local/shared/destructive/external), attention (why a non-local action deserves a careful look, if it does), whether its runtime offers an allow (mayAllow), its choices, what allowing it "for the session" would really cover (sessionScope: "native-session", "once+app-rule" or "once", exactly as agents.approve then reports effectiveScope) with the app-side rule it would record (sessionClass, else null), and the stronger review\'s phase and rationale if one ran',
  'agents.approve': '({agentSessionId, requestId, decision:"allow"|"deny", scope?:"once"|"session", reason}) — wizard tab or owner credential only, the same authority as permissions.decide: the owner answers any conversation of this project, a wizard the coworkers it controls (and theirs), never its own request; any class, local, shared, destructive or external (production included), so review the exact action first. Answers one pending native approval with a choice its runtime offers. scope "session" uses the runtime\'s own for-this-session choice when it offers one (effectiveScope "native-session", lasting as the runtime states); otherwise Conductor answers once, and only when the request is under stronger review and its action forms a class the review gate covers (the program and subcommand, workspace edits, one tool; never an owner ask rule or owner-only boundary) does an in-memory rule answer later requests of that class while this runtime runs ("once+app-rule"; a restart, reconnect or handoff ends it); else only this request is allowed ("once"). agents.approvals shows which beforehand (sessionScope). Recorded in the approval journal with your reason'
}
export const WIZARD_APPROVAL_METHODS = Object.keys(WIZARD_APPROVAL_SIGNATURES)

export interface WizardApprovalScope { agentSessionId: string; projectId: string; owner?: boolean; wizard?: boolean }
export interface AnswerableConversation { agentSessionId: string; title?: string; cwd: string; projectId: string; provider?: string }
export interface WizardApprovalPorts {
  /** The conversations the caller may answer for: a wizard's coworkers (and theirs), or for the
   *  owner credential every agent conversation of the scope's project. Never the caller itself. */
  answerable(scope: WizardApprovalScope): AnswerableConversation[]
  snapshot(agentSessionId: string): SessionProjection | null | undefined
  respond(response: InteractionResponse): Promise<void>
  persistence: ReviewPersistence
  /** Whether this pending request is under stronger review, the only place an app-side session
   *  rule answers later requests, and the class that rule would cover (approval-review-gate.ts). */
  reviewClass?(agentSessionId: string, runtimeId: string, requestId: string): { reviewed: boolean; key?: string }
}

type Args = Record<string, unknown>
const object = (value: unknown): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {}
const text = (args: Args, key: string, max: number, required = true): string | undefined => {
  const value = args[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${key} must be a non-empty string of at most ${max} characters`)
  return value.trim()
}
const ALLOW_ONCE = ['allow', 'accept'], ALLOW_SESSION = ['allow-session', 'acceptForSession'], DENY = ['deny', 'decline']
const pick = (interaction: PendingInteraction, ids: string[]) => ids.map(id => interaction.choices.find(choice => choice.id === id && !choice.disabled)).find(Boolean)?.id

/** The tool a pending approval is for: its tool row, the card title, or the shape of its input. */
function toolOf(state: SessionProjection, item: TimelineItem, interaction: PendingInteraction): string {
  const row = item.nativeItemId ? state.items.find(entry => entry.data.type === 'tool' && entry.nativeItemId === item.nativeItemId && entry.runtimeId === item.runtimeId) : undefined
  if (row?.data.type === 'tool' && row.data.name) return row.data.name
  const titled = /^Allow ([\w.-]+)\?$/.exec(interaction.title)?.[1]
  if (titled) return titled
  const input = object(interaction.input)
  return commandText(interaction.input) !== undefined ? 'Bash' : typeof input.file_path === 'string' || typeof input.notebook_path === 'string' ? 'Edit' : typeof input.url === 'string' ? 'WebFetch' : interaction.title
}

/** The action's class and, for anything beyond a local workspace action, why it deserves a careful look. */
function classify(tool: string, input: Json, cwd: string): { class: string; attention?: string; paths: string[] } {
  const command = commandText(input)
  const described = describeGrantRequest(command !== undefined ? { tool: tool === 'PowerShell' ? 'PowerShell' : 'Bash', input: { command }, cwd } : { tool, input, cwd })
  const args = object(input), requested = args.file_path ?? args.notebook_path ?? args.path
  const path = typeof requested === 'string' ? resolve(cwd, requested) : undefined
  const outside = path !== undefined && (isAbsolute(relative(cwd, path)) || relative(cwd, path).startsWith('..'))
  const reach = ownerOnlyEscalation(reachOf(args))
  const attention = described.class !== 'local' ? `a ${described.class} action (${described.action})`
    : reach ? `it reaches ${reach}`
      : outside ? 'it writes outside the coworker\'s workspace'
        : undefined
  return { class: described.class, ...(attention ? { attention } : {}), paths: path && !outside ? [process.platform === 'win32' ? path.toLowerCase() : path] : [] }
}

function pendingOf(state: SessionProjection): Array<{ item: TimelineItem; interaction: PendingInteraction }> {
  return state.items.flatMap(item => item.runtimeId === state.runtimeId && item.data.type === 'interaction' && item.data.interaction.kind === 'approval' && item.data.interaction.status === 'pending'
    ? [{ item, interaction: item.data.interaction }] : [])
}

/** What an allow "for the session" of this request would cover, before it is given: the runtime's
 *  own session choice, or the app-side rule agents.approve would record and whether the review gate
 *  would ever consult it. agents.approvals lists it; agents.approve acts on it. Read it before
 *  answering: the review binding ends with the answer. */
function sessionPlan(ports: WizardApprovalPorts, target: AnswerableConversation, runtimeId: string, interaction: PendingInteraction, tool: string, paths: string[]): { native: boolean; reviewed?: boolean; rule?: string; scope: 'native-session' | 'once+app-rule' | 'once' } {
  if (pick(interaction, ALLOW_SESSION)) return { native: true, scope: 'native-session' }
  const review = ports.reviewClass?.(target.agentSessionId, runtimeId, interaction.id) ?? { reviewed: false }
  // Under review the rule is the gate's own class for this action (none for an owner ask rule or an
  // owner-only boundary); otherwise it is kept for this runtime but not consulted.
  const rule = review.reviewed ? review.key : commandClass({ tool, arguments: interaction.input, paths, boundary: 'workspace-write', cwd: target.cwd })
  return { native: false, reviewed: review.reviewed, ...(rule ? { rule } : {}), scope: review.reviewed && rule ? 'once+app-rule' : 'once' }
}

/** What an allow actually covers, said truthfully: the runtime's own session choice (with the
 *  lifetime the runtime's adapter states), an app-side class rule, or only this one request. */
function effectiveScope(asked: string, nativeSession: boolean, interaction: PendingInteraction, rule: string | undefined, reviewed: boolean, applies: boolean): Record<string, Json> {
  if (nativeSession) {
    const stated = interaction.choices.find(choice => ALLOW_SESSION.includes(choice.id))?.description
    return { effectiveScope: 'native-session', note: stated ? `The runtime's own session approval. ${stated}` : 'The runtime\'s own session approval; it lasts as long as that runtime keeps it.' }
  }
  if (asked !== 'session') return { effectiveScope: 'once' }
  if (!rule) return { effectiveScope: 'once', sessionRule: null, note: reviewed
    ? 'The runtime offered no session answer, and under stronger review this action forms no class a session rule may cover (an owner ask rule or owner-only boundary, a compound or flag-led command, or an unsupported tool), so only this request was allowed.'
    : 'The runtime offered no session answer and this action forms no reusable class (a compound or flag-led command, or an unsupported tool), so only this request was allowed.' }
  return applies
    ? { effectiveScope: 'once+app-rule', sessionRule: rule, note: `The runtime offered no session answer, so this request was allowed once, and Conductor's in-memory rule "${rule}" answers later approvals of that class under this conversation's stronger review while this runtime runs; an app restart, a reconnect that starts a new runtime, or a handoff ends it.` }
    : { effectiveScope: 'once', sessionRule: rule, note: `The runtime offered no session answer, so only this request was allowed. The in-memory rule "${rule}" is kept for this runtime but is only consulted under stronger review, which is off for this conversation, so later requests of this class ask again.` }
}

export async function callWizardApprovals(ports: WizardApprovalPorts, scope: WizardApprovalScope, method: string, args: Args): Promise<unknown> {
  if (!scope.owner && !scope.wizard) throw new Error(`${method} answers only a wizard tab (the wand toggle, frontier models only) or the owner's own control credential; an ordinary conversation's coworker approvals go to the owner or its wizard`)
  const answerable = ports.answerable(scope).filter(entry => entry.agentSessionId !== scope.agentSessionId)
  const named = text(args, 'agentSessionId', 160, method === 'agents.approve')
  const targets = named ? answerable.filter(entry => entry.agentSessionId === named) : answerable
  if (named && !targets.length) throw new Error(scope.owner ? 'No such agent conversation in this project' : 'That conversation is not one of your coworkers; a wizard answers only for the coworkers it controls')
  const by = scope.owner ? 'Owner control credential' : `Wizard ${scope.agentSessionId}`

  if (method === 'agents.approvals') {
    const allowed = new Set(['agentSessionId'])
    const unknown = Object.keys(args).filter(key => !allowed.has(key))
    if (unknown.length) throw new Error(`agents.approvals does not take ${unknown.join(', ')}`)
    const journal = new ApprovalReviews(ports.persistence)
    const approvals = targets.flatMap(target => {
      const state = ports.snapshot(target.agentSessionId)
      if (!state) return []
      return pendingOf(state).map(({ item, interaction }) => {
        const tool = toolOf(state, item, interaction), verdict = classify(tool, interaction.input, target.cwd)
        const plan = sessionPlan(ports, target, state.runtimeId, interaction, tool, verdict.paths)
        const input = canonicalAction(interaction.input)
        let journaled: ReturnType<ApprovalReviews['forRequest']>
        try { journaled = journal.forRequest(target.projectId, target.agentSessionId, state.runtimeId, interaction.id) } catch { journaled = undefined }
        return {
          agentSessionId: target.agentSessionId, title: target.title ?? null, requestId: interaction.id, runtimeId: state.runtimeId, requestedAt: item.timestamp,
          tool, input: input.length > 4000 ? input.slice(0, 4000) + '…' : input, class: verdict.class, mayAllow: Boolean(pick(interaction, ALLOW_ONCE) ?? pick(interaction, ALLOW_SESSION)), ...(verdict.attention ? { attention: verdict.attention } : {}),
          sessionScope: plan.scope, sessionClass: plan.rule ?? null,
          choices: interaction.choices.filter(choice => !choice.disabled).map(choice => choice.id),
          review: interaction.review ? { phase: interaction.review.phase, rationale: interaction.review.rationale, reviewerModel: interaction.review.reviewerModel ?? null } : journaled ? { phase: journaled.phase, rationale: journaled.rationale, reviewerModel: journaled.reviewerModel ?? null } : null
        }
      })
    })
    return { approvals, coworkers: targets.length }
  }

  if (method === 'agents.approve') {
    const allowed = new Set(['agentSessionId', 'requestId', 'decision', 'scope', 'reason'])
    const unknown = Object.keys(args).filter(key => !allowed.has(key))
    if (unknown.length) throw new Error(`agents.approve does not take ${unknown.join(', ')}`)
    const requestId = text(args, 'requestId', 400)!, reason = text(args, 'reason', 600)!
    const decision = args.decision, grant = args.scope ?? 'once'
    if (decision !== 'allow' && decision !== 'deny') throw new Error('decision must be "allow" or "deny"')
    if (grant !== 'once' && grant !== 'session') throw new Error('scope must be "once" or "session"')
    const target = targets[0]!, state = ports.snapshot(target.agentSessionId)
    const pending = state && pendingOf(state).find(entry => entry.interaction.id === requestId)
    if (!state || !pending) throw new Error('That approval is no longer pending (answered, expired, or its runtime restarted); call agents.approvals again')
    const tool = toolOf(state, pending.item, pending.interaction), verdict = classify(tool, pending.interaction.input, target.cwd)
    const choice = decision === 'deny' ? pick(pending.interaction, DENY) : grant === 'session' ? pick(pending.interaction, ALLOW_SESSION) ?? pick(pending.interaction, ALLOW_ONCE) : pick(pending.interaction, ALLOW_ONCE)
    if (!choice) throw new Error(`The coworker's runtime does not offer a ${decision} answer for this request`)
    const response: InteractionResponse = { sessionId: target.agentSessionId, runtimeId: state.runtimeId, requestId, decision: choice }
    // Read before answering: the review binding ends with the answer.
    const plan = sessionPlan(ports, target, state.runtimeId, pending.interaction, tool, verdict.paths)
    const journaledByReview = attributeAnswer(response, `${by} (${decision} ${grant}: ${reason.slice(0, 300)})`)
    let bound: boolean
    try { await ports.respond(response) } finally { bound = journaledByReview() }
    // A request under review was journaled by the gate with this attribution; any other is recorded here.
    const journal = new ApprovalReviews(ports.persistence)
    let record: ReturnType<ApprovalReviews['forRequest']>
    try {
      record = bound ? journal.forRequest(target.projectId, target.agentSessionId, state.runtimeId, requestId) : undefined
      if (!record) record = journal.answered({ projectId: target.projectId, machineId: 'local', workerId: target.agentSessionId, runtimeId: state.runtimeId, requestId, tool, arguments: pending.interaction.input, paths: verdict.paths }, by, `${decision} (${grant})`, reason)
    } catch (error) { console.warn('A wizard approval answer could not be journaled; the answer itself was delivered', error); record = undefined }
    let rule: string | undefined
    const nativeSession = ALLOW_SESSION.includes(choice)
    if (decision === 'allow' && grant === 'session' && !nativeSession) {
      rule = plan.rule
      if (rule) sessionRules.add({ workerId: target.agentSessionId, runtimeId: state.runtimeId }, { key: rule, source: 'wizard', recordId: record?.id, by, at: new Date().toISOString(), example: tool })
    }
    return {
      agentSessionId: target.agentSessionId, requestId, decision, scope: grant, answered: choice, journal: record ? { id: record.id, phase: record.phase } : null,
      ...(decision === 'allow' ? effectiveScope(grant, nativeSession, pending.interaction, rule, plan.reviewed === true, plan.scope === 'once+app-rule') : {})
    }
  }
  throw new Error(`Unknown approvals method: ${method}`)
}
