import { concreteModel, isFallbackModel } from '../../../shared/agent-model-selection'
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
/** A bare Codex id (`gpt-6-astra`) reads the way the CLI's own `model/list` display name does
 *  (`GPT-6-Astra`); a label that already came from the CLI, or any other id, is shown verbatim. */
export function modelDisplayName(id: string): string {
  if (/^gpt-\d[\w.-]*$/.test(id)) return id.split('-').map((part, index) => index === 0 ? 'GPT' : /^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1)).join('-')
  return id
}
/** The Claude aliases the CLI resolves to a concrete API name on the message frames. */
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku', 'fable']
export function resolvedComposerSettings(settings: SessionSettings, capabilities?: ProviderCapabilities): { model: string; label: string; effort?: string; resolvedModel?: string } {
  const provider = capabilities?.provider ?? 'codex'
  const effective = capabilities?.effectiveSettings
  const values = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective : {}
  const configured = reported(settings.model) ? settings.model : undefined
  const model = concreteModel(provider, settings.model, capabilities)
  const alias = CLAUDE_ALIASES.find(name => model === name || model === `${name}[1m]`)
  const actual = reported(values.model) && alias && values.model.includes(alias) ? values.model : model
  // The saved alias is what the catalog names ("Sonnet"), the runtime's resolved name
  // (`claude-sonnet-5`) is not a catalog id; it is offered as the tooltip instead of the label.
  const info = capabilities?.models.find(option => option.id === model) ?? capabilities?.models.find(option => option.id === actual)
  const resolvedModel = actual !== model ? actual : undefined
  // Before a catalog or system/init names the model, a Claude tab runs on Conductor's stand-in
  // for the account default; calling it "Claude Opus" claimed a choice nobody had made.
  const label = info && !/^default\b/i.test(info.label) ? info.label : !info && !reported(values.model) && isFallbackModel(capabilities?.provider, model) ? 'Account default' : modelDisplayName(actual)
  const effort = reported(settings.effort) ? settings.effort : (!configured || configured === values.model || actual === values.model) && reported(values.effort) ? values.effort : info?.defaultEffort
  return { model, label, effort, ...(resolvedModel ? { resolvedModel } : {}) }
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

/** What a Codex mode actually does, in the terms its own `/permissions` presets use. The picker
 *  has to say this: Edit and Auto differ by whether Codex interrupts at all, and only the owner
 *  can decide that an uninterrupted conversation may also reach the network. */
const codexModeDescriptions: Record<string, string> = {
  default: 'Approve requests the way your Codex CLI is configured to.',
  'read-only': 'Inspect the workspace without making changes.',
  'accept-edits': 'Edit files and run workspace commands; ask before leaving the workspace.',
  auto: 'Never ask: workspace edits, commands, network and MCP tools such as the project browser run without approval.'
}
export function conversationModes(capabilities?: ProviderCapabilities): Array<{ id: string; label: string; description?: string; change: Partial<SessionSettings> }> {
  if (!capabilities) return []
  const labels: Record<SessionSettings['permission'], string> = { default: 'Ask', auto: 'Auto', 'accept-edits': 'Edit', 'read-only': 'Read only' }
  const modes = (capabilities.permissions ?? []).map(permission => ({
    id: permission as string, label: labels[permission],
    ...(capabilities.provider === 'codex' ? { description: codexModeDescriptions[permission] } : {}),
    change: { permission, plan: false } as Partial<SessionSettings>
  }))
  if (capabilities.plans) modes.push({ id: 'plan', label: 'Plan', change: { plan: true } })
  return modes
}
