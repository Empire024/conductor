import type { ProviderCapabilities } from './structured-agent'

/** Undefined means the runtime has not reported this model's capabilities. */
export function modelEfforts(capabilities: ProviderCapabilities | undefined, model?: string): string[] | undefined {
  const effective = capabilities?.effectiveSettings
  const defaultModel = effective && typeof effective === 'object' && !Array.isArray(effective) && typeof effective.model === 'string' ? effective.model : undefined
  const selected = model && model !== 'default' ? model : defaultModel
  const info = capabilities?.models.find(option => option.id === selected) ?? (!model || model === 'default' ? capabilities?.models.find(option => option.isDefault || option.id === 'default') : undefined)
  return info?.effort
}
