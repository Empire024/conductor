import type { ProviderCapabilities } from './structured-agent'

/** Undefined means the runtime has not reported this model's capabilities. */
export function modelEfforts(capabilities: ProviderCapabilities | undefined, model?: string): string[] | undefined {
  const effective = capabilities?.effectiveSettings
  const defaultModel = effective && typeof effective === 'object' && !Array.isArray(effective) && typeof effective.model === 'string' ? effective.model : undefined
  const selected = model && model !== 'default' ? model : defaultModel
  const info = capabilities?.models.find(option => option.id === selected) ?? (!model || model === 'default' ? capabilities?.models.find(option => option.isDefault || option.id === 'default') : undefined)
  return info?.effort
}

/** Slider positions: real, reported efforts only. Auto is a placeholder, not a choice. */
export function supportedEffortChoices(capabilities: ProviderCapabilities | undefined, model?: string): string[] {
  return (modelEfforts(capabilities, model) ?? []).filter(effort => effort && effort !== 'auto')
}

/** Conductor always sends a concrete effort, so a conversation never runs on 'not reported'. */
export function resolveEffortChoice(choices: string[], preferred?: string): string | undefined {
  if (!choices.length) return undefined
  if (preferred && choices.includes(preferred)) return preferred
  return choices.find(choice => choice === 'medium') ?? choices[Math.floor((choices.length - 1) / 2)]
}
