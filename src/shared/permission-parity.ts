import type { ProviderCapabilities, SessionSettings } from './structured-agent'

/** Native-reported values remain distinct from the owner's requested mode. */
export function permissionParity(settings: SessionSettings, capabilities?: Pick<ProviderCapabilities, 'provider' | 'effectiveSettings' | 'approvalRouting'>): string | undefined {
  if (capabilities?.provider !== 'claude') return undefined
  const effective = capabilities.effectiveSettings
  const mode = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective.permissionMode : undefined
  // Stronger review no longer changes the native mode: a worker on Auto runs on Auto and only the
  // requests the runtime raises itself go to review first, so there is nothing to explain unless
  // the native mode genuinely differs from the configured one.
  if (typeof mode !== 'string') return undefined
  const expected = settings.plan ? 'plan' : settings.permission === 'auto' ? 'auto' : settings.permission === 'accept-edits' ? 'acceptEdits' : 'manual'
  const actual = mode === 'default' ? 'manual' : mode
  return actual === expected ? undefined : `Permission mismatch: configured ${settings.plan ? 'plan' : settings.permission}; native ${mode}. Native restrictions remain enforced.`
}
