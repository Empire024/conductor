import type { ProviderCapabilities, SessionProjection, SessionSettings, TimelineItem } from '../../../shared/structured-agent'
import { summarizeContext } from '../../../shared/usage-accounting'
import type { conversationModes } from './composer-settings'

type Mode = ReturnType<typeof conversationModes>[number]
const MODE_WORDS: Record<string, string> = {
  ask: 'default', default: 'default', manual: 'default', 'on-request': 'default',
  auto: 'auto', 'full-auto': 'auto', full: 'auto', 'full-access': 'auto', yolo: 'auto',
  edit: 'accept-edits', edits: 'accept-edits', 'accept-edits': 'accept-edits', acceptedits: 'accept-edits',
  'read-only': 'read-only', readonly: 'read-only', read: 'read-only',
  guarded: 'guarded-auto', 'guarded-auto': 'guarded-auto', plan: 'plan'
}
/** `/permissions auto`: the mode the argument names, by id, label or the CLIs' own words for it. */
export function matchConversationMode(modes: readonly Mode[], argument: string): Mode | undefined {
  const key = argument.trim().toLowerCase().replace(/\s+/g, '-')
  if (!key) return undefined
  return modes.find(mode => mode.id === key || mode.label.toLowerCase().replace(/\s+/g, '-') === key)
    ?? modes.find(mode => mode.id === MODE_WORDS[key])
}
/** `/model sonnet`: an exact id or label, else the one model whose id or label contains the words. */
export function matchModel(models: ProviderCapabilities['models'], argument: string): { id: string; label: string } | undefined {
  const key = argument.trim().toLowerCase()
  if (!key) return undefined
  const choices = models.filter(model => model.id !== 'default')
  const exact = choices.find(model => model.id.toLowerCase() === key || model.label.toLowerCase() === key)
  if (exact) return exact
  const words = key.split(/\s+/)
  const partial = choices.filter(model => words.every(word => (model.id + ' ' + model.label).toLowerCase().includes(word)))
  return partial.length === 1 ? partial[0] : undefined
}
export function matchEffort(efforts: readonly string[], argument: string): string | undefined {
  const key = argument.trim().toLowerCase()
  return efforts.find(effort => effort.toLowerCase() === key)
}
/** The text of the latest answer, for /copy. */
export function lastAssistantText(items: readonly TimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const data = items[index]!.data
    if (data.type === 'text' && data.role === 'assistant' && !items[index]!.parentId && data.text.trim()) return data.text
  }
  return undefined
}
/** /status (and Codex /context, /usage, /pwd): what the CLI's status card shows, from what Conductor knows. */
export function conversationStatusText(input: {
  name: string; projection: SessionProjection; settings: SessionSettings; modelLabel: string; resolvedModel?: string
  modeLabel?: string; parity?: string; workspace: string
}): string {
  const { projection, settings } = input
  const capabilities = projection.capabilities
  const context = summarizeContext(projection.items, projection.runtimeId)
  const lines = [
    `${input.name}${capabilities?.runtimeVersion ? ' ' + capabilities.runtimeVersion : ''} · ${projection.phase.replaceAll('_', ' ')}`,
    `Model: ${input.modelLabel}${input.resolvedModel && input.resolvedModel !== input.modelLabel ? ' (' + input.resolvedModel + ')' : ''}${settings.effort ? ' · effort ' + settings.effort : ''}`,
    `Mode: ${input.modeLabel ?? (settings.plan ? 'Plan' : settings.permission)}${input.parity ? ' · ' + input.parity : ''}`,
    `Context: ${context ? `${Math.floor(context.percent)}% used (${context.used.toLocaleString()} / ${context.capacity.toLocaleString()} tokens)` : 'not reported yet'}`,
    `Workspace: ${input.workspace}`,
    `Session: ${projection.nativeSessionId ?? 'not started'}`,
    `Sign-in: ${capabilities?.authentication === 'cli' ? 'existing local CLI sign-in' : capabilities?.authentication ?? 'not connected'}`
  ]
  return lines.join('\n')
}
