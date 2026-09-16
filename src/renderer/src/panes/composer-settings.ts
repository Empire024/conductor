import { concreteModel } from '../../../shared/agent-model-selection'
import { MAX_PROMPT_CHARS, settingsForRuntime } from '../../../shared/structured-agent'
import type { ContextAttachment, ProviderCapabilities, SessionSettings } from '../../../shared/structured-agent'

/** Attachment content is expanded into the same request text the CLI/API sees, so a short-looking
 *  draft with large attachments can silently cross the true prompt ceiling. Counting it here is
 *  what lets the composer warn before sending instead of surfacing the provider's raw rejection. */
export function promptCharacterCount(message: string, attachments: Pick<ContextAttachment, 'content'>[]): number {
  return message.trim().length + attachments.reduce((sum, attachment) => sum + (attachment.content?.length ?? 0), 0)
}

export type ComposerSendBlock = 'empty' | 'oversized'
export function composerSendBlock(message: string, attachments: Pick<ContextAttachment, 'content'>[]): ComposerSendBlock | undefined {
  if (!message.trim()) return 'empty'
  if (promptCharacterCount(message, attachments) > MAX_PROMPT_CHARS) return 'oversized'
  return undefined
}

const reported = (value: unknown): value is string => typeof value === 'string' && Boolean(value) && !['default', 'auto'].includes(value)
export function modelDisplayName(id: string): string {
  if (/^gpt-\d/i.test(id)) return id.split('-').map((part, index) => index === 0 ? 'GPT' : /^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1)).join(' ')
  return id
}
export function resolvedComposerSettings(settings: SessionSettings, capabilities?: ProviderCapabilities): { model: string; label: string; effort?: string } {
  const effective = capabilities?.effectiveSettings
  const values = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective : {}
  const configured = reported(settings.model) ? settings.model : undefined
  const model = concreteModel(capabilities?.provider ?? 'codex', settings.model, capabilities)
  const actual = reported(values.model) && ['opus', 'sonnet', 'haiku', 'fable'].includes(model) && values.model.includes(model) ? values.model : model
  const info = capabilities?.models.find(option => option.id === actual)
  const label = info && !/^default\b/i.test(info.label) ? modelDisplayName(info.label) : modelDisplayName(actual === 'opus' ? 'Claude Opus' : actual)
  const effort = reported(settings.effort) ? settings.effort : (!configured || configured === values.model || actual === values.model) && reported(values.effort) ? values.effort : info?.defaultEffort
  return { model, label, effort }
}

/** A mode change takes effect on the next turn, so it also drops a temporary permission that
 *  only the current runtime was holding. Everything else is a straight overlay. */
export function nextComposerSettings(current: SessionSettings, change: Partial<SessionSettings>): SessionSettings {
  return { ...(change.permission !== undefined || change.plan !== undefined ? settingsForRuntime(current) : current), ...change }
}

/** The composer children remount per conversation. React drops all but the last of sibling
 *  elements that share a key and leaves their DOM behind — a second ask/model/effort row —
 *  so each child namespaces the conversation it belongs to. */
export const composerChildKey = (child: string, conversationId: string): string => child + ':' + conversationId

export function conversationModes(capabilities?: ProviderCapabilities): Array<{ id: string; label: string; change: Partial<SessionSettings> }> {
  if (!capabilities) return []
  if (capabilities.provider === 'codex') return capabilities.plans ? [{ id: 'edit', label: 'Edit', change: { plan: false } }, { id: 'plan', label: 'Plan', change: { plan: true } }] : []
  const labels: Record<SessionSettings['permission'], string> = { default: 'Ask', auto: 'Auto', 'accept-edits': 'Edit', 'read-only': 'Read only' }
  const modes = (capabilities.permissions ?? []).map(permission => ({ id: permission as string, label: labels[permission], change: { permission, plan: false } as Partial<SessionSettings> }))
  if (capabilities.plans) modes.push({ id: 'plan', label: 'Plan', change: { plan: true } })
  return modes
}
