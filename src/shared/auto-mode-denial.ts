import type { AgentEventData, Json } from './structured-agent'

/**
 * A tool call the claude CLI's own auto-mode classifier refused. In Auto the CLI never sends
 * Conductor a `can_use_tool` request for it: the only trace is a `tool_result` with `is_error` and
 * this wording (verified against claude 2.1.280, whose result frame also lists every denial in
 * `permission_denials: [{ tool_name, tool_input, tool_use_id }]`). Without this, the owner sees a
 * failed tool and thinks Conductor broke.
 */
export interface AutoModeDenial { tool: string; reason: string; toolUseId: string }

/** The CLI's wording, with the bracketed reason it appends: `Permission for this action was denied
 *  by the Claude Code auto mode classifier. Reason: [Security Weaken]. If it keeps failing, …`.
 *  Also seen: `[Create Unsafe Agents]`, `[Self-Modification]`. The brackets are optional because the
 *  CLI's own parser of this line (`Reason: ([\w][\w ,'-]{0,59})`) does not require them. */
export const AUTO_MODE_DENIAL_PATTERN = /denied by the Claude Code auto mode classifier\.?\s*Reason:\s*\[?([^\]\r\n]+?)\]?(?:\.(?=\s|$)|\r?\n|$)/i

export function parseAutoModeDenialReason(text: string): string | undefined {
  const reason = AUTO_MODE_DENIAL_PATTERN.exec(text)?.[1]?.trim()
  return reason ? reason.slice(0, 120) : undefined
}

export const autoModeDenialItemId = (toolUseId: string): string => `auto-denial:${toolUseId}`

/** What the conversation shows. Names the actual decider so the owner does not blame Conductor. */
export const autoModeDenialMessage = (denial: Pick<AutoModeDenial, 'tool' | 'reason'>): string =>
  `Auto mode refused ${denial.tool} (${denial.reason}). The claude CLI's own classifier decided this, so Conductor could not show you a card. Switch this conversation to Edit to get an Allow card for such actions, or add a permission rule.`

/** The one-line form a phone push or a list row uses. */
export const autoModeDenialSummary = (denial: Pick<AutoModeDenial, 'tool' | 'reason'>): string => `Auto mode refused ${denial.tool}: ${denial.reason}`

export const autoModeDenialPayload = (denial: AutoModeDenial, confirmed?: boolean): Json =>
  ({ autoModeDenial: { tool: denial.tool, reason: denial.reason, toolUseId: denial.toolUseId, ...(confirmed ? { confirmed: true } : {}) } })

/** The denial a notice item carries, if it is one. */
export function autoModeDenialOf(data: AgentEventData): AutoModeDenial | undefined {
  if (data.type !== 'notice' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return undefined
  const denial = data.payload.autoModeDenial
  if (!denial || typeof denial !== 'object' || Array.isArray(denial)) return undefined
  const { tool, reason, toolUseId } = denial
  if (typeof tool !== 'string' || typeof reason !== 'string' || typeof toolUseId !== 'string') return undefined
  return { tool, reason, toolUseId }
}
