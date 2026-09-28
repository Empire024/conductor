import type { AgentEventData, Json } from './structured-agent'
import { grantRequestSummary, type PermissionGrantRequest } from './permission-grants'

/**
 * A tool call the claude CLI's own auto-mode classifier refused. In Auto the CLI never sends
 * Conductor a `can_use_tool` request for it: the only trace is a `tool_result` with `is_error` and
 * this wording (verified against claude 2.1.280, whose result frame also lists every denial in
 * `permission_denials: [{ tool_name, tool_input, tool_use_id }]`). Without this, the owner sees a
 * failed tool and thinks Conductor broke.
 */
export interface AutoModeDenial { tool: string; reason: string; toolUseId: string; request?: DenialGrantRequest }
/** The narrow approval a denial turns into (permission-grants.ts), minus what the grant service adds. */
export type DenialGrantRequest = Omit<PermissionGrantRequest, 'id' | 'source' | 'status' | 'requestedAt'>

/** The CLI's wording, with the bracketed reason it appends: `Permission for this action was denied
 *  by the Claude Code auto mode classifier. Reason: [Security Weaken]. If it keeps failing, …`.
 *  Also seen: `[Create Unsafe Agents]`, `[Self-Modification]`. The brackets are optional because the
 *  CLI's own parser of this line (`Reason: ([\w][\w ,'-]{0,59})`) does not require them. */
export const AUTO_MODE_DENIAL_PATTERN = /denied by the Claude Code auto mode classifier\.?\s*Reason:\s*\[?([^\]\r\n]+?)\]?(?:\.(?=\s|$)|\r?\n|$)/i

export function parseAutoModeDenialReason(text: string): string | undefined {
  const reason = AUTO_MODE_DENIAL_PATTERN.exec(text)?.[1]?.trim()
  return reason ? reason.slice(0, 120) : undefined
}

/** The reason as the CLI's PermissionDenied hook hands it: the bracketed category when there is
 *  one, else the classifier's own sentence, bounded. */
export function hookDenialReason(reason: string): string {
  const bracketed = /\[([^\]\r\n]{1,120})\]/.exec(reason)?.[1]?.trim()
  return bracketed || parseAutoModeDenialReason(reason) || reason.trim().replace(/\s+/g, ' ').slice(0, 120) || 'Permission denied'
}

/**
 * A denial that is an outage of the server-side classifier, not a judgment: the CLI blocks the call
 * because the check gave no verdict. Its PermissionDenied reasons (claude 2.1.28x): "Classifier
 * unavailable", "Classifier unavailable - blocking for safety", "Stage 2 classifier error - …",
 * "Auto mode could not evaluate this action …", and after repeated no-verdicts the turn-ending
 * "Auto mode unavailable — stopped after repeated responses with no safety verdict". The tool_result
 * wording is "The server-side auto mode classifier gave no verdict (error) …". None of these is a
 * question for the owner: an approval would not help, the same call works once the check is back.
 */
const CLASSIFIER_OUTAGE_PATTERN = /\bclassifier unavailable\b|\bauto mode unavailable\b|\bgave no verdict\b|\bno safety verdict\b|\bclassifier error\b|\bauto mode could not evaluate\b/i
export const isClassifierOutage = (reason: string | undefined): boolean => Boolean(reason && CLASSIFIER_OUTAGE_PATTERN.test(reason))
/** The CLI's circuit breaker: it stopped the turn after repeated responses without a verdict. */
export const classifierOutageStoppedTurn = (reason: string | undefined): boolean => Boolean(reason && /\bstopped after repeated\b|\bno safety verdict\b/i.test(reason))

export interface ClassifierOutage { tool: string; reason: string; toolUseId: string; stopped?: boolean; count?: number }
/** What the conversation shows for an outage: a plain notice, never an approval card. */
export const classifierOutageMessage = (outage: Pick<ClassifierOutage, 'tool' | 'reason' | 'stopped' | 'count'>): string => {
  const times = outage.count && outage.count > 1 ? ` (${outage.count} calls this turn)` : ''
  return outage.stopped
    ? `Auto mode's safety check was unavailable for ${outage.tool}${times}, so the claude CLI stopped this turn (${outage.reason}). This is an outage of the classifier, not a refusal: nothing needs approval. Continue the conversation once the check is back.`
    : `Auto mode's safety check was unavailable for ${outage.tool}${times} (${outage.reason}). This is a transient outage of the classifier, not a refusal: nothing needs approval. The agent was told to retry the same call after a short pause.`
}
export const classifierOutagePayload = (outage: ClassifierOutage): Json =>
  ({ classifierUnavailable: { tool: outage.tool, reason: outage.reason, toolUseId: outage.toolUseId, ...(outage.stopped ? { stopped: true } : {}), ...(outage.count ? { count: outage.count } : {}) } })

export const autoModeDenialItemId = (toolUseId: string): string => `auto-denial:${toolUseId}`

/** What the conversation shows. Names the actual decider so the owner does not blame Conductor. */
export const autoModeDenialMessage = (denial: Pick<AutoModeDenial, 'tool' | 'reason' | 'request'>): string => {
  const request = denial.request
  if (!request) return `Auto mode refused ${denial.tool} (${denial.reason}). The claude CLI's own classifier decided this, so Conductor could not show you a card. Switch this conversation to Edit to get an Allow card for such actions, or add a permission rule.`
  const what = grantRequestSummary(request)
  return request.rule
    ? `Auto mode refused ${denial.tool} (${denial.reason}): ${what}. The claude CLI's own classifier decided this. Approve it once or for this session, or deny it: Conductor then hands this conversation exactly ${request.rule} and tells it to retry.`
    : `Auto mode refused ${denial.tool} (${denial.reason}): ${what}. The claude CLI's own classifier decided this. ${request.refusal ?? 'No narrow rule can cover it.'}`
}

/** The one-line form a phone push or a list row uses. */
export const autoModeDenialSummary = (denial: Pick<AutoModeDenial, 'tool' | 'reason' | 'request'>): string =>
  denial.request ? `Auto mode refused ${denial.tool}: ${denial.reason}. ${grantRequestSummary(denial.request)}` : `Auto mode refused ${denial.tool}: ${denial.reason}`

export const autoModeDenialPayload = (denial: AutoModeDenial, confirmed?: boolean): Json =>
  ({ autoModeDenial: { tool: denial.tool, reason: denial.reason, toolUseId: denial.toolUseId, ...(denial.request ? { request: denial.request as unknown as Json } : {}), ...(confirmed ? { confirmed: true } : {}) } })

/** The denial a notice item carries, if it is one. */
export function autoModeDenialOf(data: AgentEventData): AutoModeDenial | undefined {
  if (data.type !== 'notice' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return undefined
  const denial = data.payload.autoModeDenial
  if (!denial || typeof denial !== 'object' || Array.isArray(denial)) return undefined
  const { tool, reason, toolUseId, request } = denial
  if (typeof tool !== 'string' || typeof reason !== 'string' || typeof toolUseId !== 'string') return undefined
  return { tool, reason, toolUseId, ...(denialRequestOf(request) ? { request: denialRequestOf(request) } : {}) }
}

const CLASSES = new Set(['local', 'shared', 'destructive', 'external'])
function denialRequestOf(value: Json | undefined): DenialGrantRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { tool, action, resource, class: kind } = value
  if (typeof tool !== 'string' || typeof action !== 'string' || typeof resource !== 'string' || typeof kind !== 'string' || !CLASSES.has(kind)) return undefined
  return value as unknown as DenialGrantRequest
}
