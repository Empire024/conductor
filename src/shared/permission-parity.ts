import type { ProviderCapabilities, SessionSettings } from './structured-agent'

/** Whether a parity text reports a mode the runtime has not (yet) confirmed, rather than plain status. */
export function permissionParityNeedsAttention(text: string | undefined): boolean {
  return Boolean(text && /^(Permission transition|Permission mismatch|Full Auto requested)/.test(text))
}

/** Native-reported values remain distinct from the owner's requested mode. */
export function permissionParity(settings: SessionSettings, capabilities?: Pick<ProviderCapabilities, 'provider' | 'effectiveSettings' | 'approvalRouting'>): string | undefined {
  if (capabilities?.provider !== 'claude') return undefined
  const effective = capabilities.effectiveSettings
  const mode = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective.permissionMode : undefined
  const values = effective && typeof effective === 'object' && !Array.isArray(effective) ? effective : {}
  const requested = values.requestedPermissionMode
  const status = values.permissionModeStatus
  if (status === 'blocked') return `Permission transition blocked: requested ${String(requested ?? 'unknown')}; confirmed ${String(mode ?? 'unknown')}. ${String(values.permissionModeError ?? 'The provider did not confirm the requested mode.')}`
  if (status === 'pending' || status === 'restart-pending') return `Permission transition pending: requested ${String(requested ?? 'unknown')}; confirmed ${String(mode ?? 'unknown')}.${status === 'restart-pending' ? ' Waiting for a safe checkpoint to resume this runtime.' : ''}`
  if (settings.permission === 'auto' && !settings.plan && !settings.claudeGuardedAuto && values.claudeFullAutoAuthorized === true) {
    return mode === 'bypassPermissions' && status === 'confirmed'
      ? 'Full Auto active — requested and confirmed: bypassPermissions.'
      : `Full Auto requested; confirmed runtime mode: ${String(mode ?? 'unknown')}. Awaiting provider confirmation.`
  }
  if (settings.permission === 'auto' && !settings.plan && mode === 'auto') return 'Guarded Auto — Claude Code’s tool-permission classifier is active.'
  // Stronger review no longer changes the native mode: a worker on Auto runs on Auto and only the
  // requests the runtime raises itself go to review first, so there is nothing to explain unless
  // the native mode genuinely differs from the configured one.
  if (typeof mode !== 'string') return undefined
  const expected = settings.plan ? 'plan' : settings.permission === 'auto' ? 'auto' : settings.permission === 'accept-edits' ? 'acceptEdits' : 'manual'
  const actual = mode === 'default' ? 'manual' : mode
  return actual === expected ? undefined : `Permission mismatch: configured ${settings.plan ? 'plan' : settings.permission}; native ${mode}. Native restrictions remain enforced.`
}
