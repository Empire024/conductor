import { DEFAULT_LOCAL_MODEL } from './local-models'
import type { ProviderCapabilities } from './structured-agent'

export const explicitModel = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !['default', 'auto'].includes(value.trim().toLowerCase())
/** Resolve a concrete selection before dispatch; catalog and native settings take precedence. */
export function concreteModel(provider: string, configured?: string, capabilities?: ProviderCapabilities): string {
  if (explicitModel(configured)) return configured
  const effective = capabilities?.effectiveSettings
  if (effective && typeof effective === 'object' && !Array.isArray(effective) && explicitModel(effective.model)) return effective.model
  const models = capabilities?.models.filter(model => explicitModel(model.id)) ?? []
  return models.find(model => model.isDefault)?.id ?? models[0]?.id ?? (provider === 'claude' ? 'opus' : provider === 'local' ? DEFAULT_LOCAL_MODEL : 'gpt-6-astra')
}
