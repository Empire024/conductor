import type { ProviderCapabilities, SessionSettings } from './structured-agent'

/** Native-reported values remain distinct from the owner's requested mode. */
export function permissionParity(settings: SessionSettings, capabilities?: Pick<ProviderCapabilities, 'provider' | 'effectiveSettings' | 'approvalRouting'>): string | undefined {
  if (capabilities?.provider !== 'claude') return undefined
  const effective = capabilities.effectiveSettings
  const mode = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective.permissionMode : undefined
  if (capabilities.approvalRouting === 'stronger-review') return `This coworker's approvals go to a stronger-model review first, so the runtime asks before each action even though you configured ${settings.permission}${typeof mode === 'string' ? ` (native mode ${mode})` : ''}. You can always answer a request yourself; turn off "Review coworkers" in the controlling tab to stop the reviews.`
  if (typeof mode !== 'string') return undefined
  const expected = settings.plan ? 'plan' : settings.permission === 'auto' ? 'auto' : settings.permission === 'accept-edits' ? 'acceptEdits' : 'manual'
  const actual = mode === 'default' ? 'manual' : mode
  return actual === expected ? undefined : `Permission mismatch: configured ${settings.plan ? 'plan' : settings.permission}; native ${mode}. Native restrictions remain enforced.`
}
