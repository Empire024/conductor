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
 * credential may call them. Through app control an answer is automation either way, so it is held
 * to what FX32b's classification calls local: a shared, destructive or external action, or one that
 * reaches credentials, the system or recursive deletion, may be denied here but only allowed by the
 * owner in the card.
 */
export const WIZARD_APPROVAL_SIGNATURES: Record<string, string> = {
  'agents.approvals': '({agentSessionId?}) — wizard tab or owner credential only: the approvals your coworkers are waiting on (or one coworker\'s), each with requestId, the exact tool and arguments, its class (local/shared/destructive/external), whether you may allow it (mayAllow, or ownerOnly with the reason), its choices and the stronger review\'s phase and rationale if one ran',
  'agents.approve': '({agentSessionId, requestId, decision:"allow"|"deny", scope?:"once"|"session", reason}) — wizard tab or owner credential only: answer one pending approval of a coworker you control, so the owner is not interrupted. scope "session" also allows the same class of action (the program and subcommand, workspace edits, one tool) for the rest of that conversation. Recorded in the approval journal with your reason. Allow is refused for shared, destructive, external or credential-reaching actions: those stay the owner\'s card; deny is always yours'
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

/** Whether automation may allow this action, and if not, why it stays the owner's. */
function classify(tool: string, input: Json, cwd: string): { class: string; ownerOnly?: string; paths: string[] } {
  const command = commandText(input)
  const described = describeGrantRequest(command !== undefined ? { tool: tool === 'PowerShell' ? 'PowerShell' : 'Bash', input: { command }, cwd } : { tool, input, cwd })
  const args = object(input), requested = args.file_path ?? args.notebook_path ?? args.path
  const path = typeof requested === 'string' ? resolve(cwd, requested) : undefined
  const outside = path !== undefined && (isAbsolute(relative(cwd, path)) || relative(cwd, path).startsWith('..'))
  const reach = ownerOnlyEscalation(reachOf(args))
  const ownerOnly = described.class !== 'local' ? `a ${described.class} action (${described.action}); only the owner allows it, in the card`
    : reach ? `it reaches ${reach}; only the owner allows it, in the card`
      : outside ? 'it writes outside the coworker\'s workspace; only the owner allows it, in the card'
        : undefined
  return { class: described.class, ...(ownerOnly ? { ownerOnly } : {}), paths: path && !outside ? [process.platform === 'win32' ? path.toLowerCase() : path] : [] }
}

function pendingOf(state: SessionProjection): Array<{ item: TimelineItem; interaction: PendingInteraction }> {
  return state.items.flatMap(item => item.runtimeId === state.runtimeId && item.data.type === 'interaction' && item.data.interaction.kind === 'approval' && item.data.interaction.status === 'pending'
    ? [{ item, interaction: item.data.interaction }] : [])
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
        const input = canonicalAction(interaction.input)
        let journaled: ReturnType<ApprovalReviews['forRequest']>
        try { journaled = journal.forRequest(target.projectId, target.agentSessionId, state.runtimeId, interaction.id) } catch { journaled = undefined }
        return {
          agentSessionId: target.agentSessionId, title: target.title ?? null, requestId: interaction.id, runtimeId: state.runtimeId, requestedAt: item.timestamp,
          tool, input: input.length > 4000 ? input.slice(0, 4000) + '…' : input, class: verdict.class, mayAllow: !verdict.ownerOnly, ...(verdict.ownerOnly ? { ownerOnly: verdict.ownerOnly } : {}),
          sessionClass: commandClass({ tool, arguments: interaction.input, paths: verdict.paths, boundary: 'workspace-write', cwd: target.cwd }) ?? null,
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
    if (decision === 'allow' && verdict.ownerOnly) throw new Error(`Not allowed through app control: ${verdict.ownerOnly}. You may deny it, or leave it for the owner`)
    const choice = decision === 'deny' ? pick(pending.interaction, DENY) : grant === 'session' ? pick(pending.interaction, ALLOW_SESSION) ?? pick(pending.interaction, ALLOW_ONCE) : pick(pending.interaction, ALLOW_ONCE)
    if (!choice) throw new Error(`The coworker's runtime does not offer a ${decision} answer for this request`)
    const response: InteractionResponse = { sessionId: target.agentSessionId, runtimeId: state.runtimeId, requestId, decision: choice }
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
    if (decision === 'allow' && grant === 'session') {
      rule = commandClass({ tool, arguments: pending.interaction.input, paths: verdict.paths, boundary: 'workspace-write', cwd: target.cwd })
      if (rule) sessionRules.add({ workerId: target.agentSessionId, runtimeId: state.runtimeId }, { key: rule, source: 'wizard', recordId: record?.id, by, at: new Date().toISOString(), example: tool })
    }
    return {
      agentSessionId: target.agentSessionId, requestId, decision, scope: grant, answered: choice, journal: record ? { id: record.id, phase: record.phase } : null,
      ...(grant === 'session' && decision === 'allow' ? { sessionRule: rule ?? null, ...(rule ? {} : { note: 'This action forms no reusable class (a compound or flag-led command, or an unsupported tool), so only this request was allowed.' }) } : {})
    }
  }
  throw new Error(`Unknown approvals method: ${method}`)
}
