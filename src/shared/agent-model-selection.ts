import { DEFAULT_LOCAL_MODEL } from './local-models'
import { promotedModel } from './promoted-models'
import type { ProviderCapabilities } from './structured-agent'

export const explicitModel = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !['default', 'auto'].includes(value.trim().toLowerCase())
/** What a Claude conversation runs on before discovery names anything: the account default on
 *  2026-09-24 (Claude Code 2.1.281) resolves to `claude-opus-5-5[1m]`, and `opus[1m]` is the only Opus entry the CLI's
 *  picker offers (a bare `opus` is not advertised). Passing it is the same model the CLI would
 *  choose on its own for this account. */
export const CLAUDE_FALLBACK_MODEL = 'opus[1m]'
/** codex-cli 0.159.1's own default (`model/list` isDefault, 2026-09-30); 0.155 does not list it. */
export const CODEX_FALLBACK_MODEL = 'gpt-6.1-sol'
/** A signed-in Grok 1.0.41's own default model (`initialize` modelState, 2026-09-24). */
export const GROK_FALLBACK_MODEL = 'grok-4.7'
/** True when a Claude selection is only Conductor's pre-discovery stand-in, not something the
 *  owner chose from a catalog or the runtime reported, so the composer can call it "Account default".
 *  With no capabilities yet the provider is unknown to the caller; no other provider uses this id. */
export function isFallbackModel(provider: string | undefined, model: string): boolean {
  return (provider === 'claude' || provider === undefined) && model === CLAUDE_FALLBACK_MODEL
}
/** Resolve a concrete selection before dispatch; catalog and native settings take precedence. */
export function concreteModel(provider: string, configured?: string, capabilities?: ProviderCapabilities): string {
  if (explicitModel(configured)) return configured
  const effective = capabilities?.effectiveSettings
  if (effective && typeof effective === 'object' && !Array.isArray(effective) && explicitModel(effective.model)) return effective.model
  const models = capabilities?.models.filter(model => explicitModel(model.id)) ?? []
  // The owner's accepted auto model upgrade (docs/model-upgrades.md) is the default where the
  // runtime offers it, before discovery included.
  const promoted = promotedModel(provider)
  if (promoted && (!models.length || models.some(model => model.id === promoted))) return promoted
  return models.find(model => model.isDefault)?.id ?? models[0]?.id ?? (provider === 'claude' ? CLAUDE_FALLBACK_MODEL : provider === 'grok' ? GROK_FALLBACK_MODEL : provider === 'local' ? DEFAULT_LOCAL_MODEL : CODEX_FALLBACK_MODEL)
}
