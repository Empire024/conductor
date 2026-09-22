import type { ProviderCapabilities } from './structured-agent'

function selectedModelInfo(capabilities: ProviderCapabilities | undefined, model?: string): ProviderCapabilities['models'][number] | undefined {
  const effective = capabilities?.effectiveSettings
  const defaultModel = effective && typeof effective === 'object' && !Array.isArray(effective) && typeof effective.model === 'string' ? effective.model : undefined
  const selected = model && model !== 'default' ? model : defaultModel
  return capabilities?.models.find(option => option.id === selected) ?? (!model || model === 'default' ? capabilities?.models.find(option => option.isDefault || option.id === 'default') : undefined)
}

/** Undefined means the runtime has not reported this model's capabilities. */
export function modelEfforts(capabilities: ProviderCapabilities | undefined, model?: string): string[] | undefined {
  return selectedModelInfo(capabilities, model)?.effort
}

/** Slider positions: real, reported efforts only. Auto is a placeholder, not a choice.
 * With no catalog at all, fall back to the provider's own declared effort ladder so the
 * slider is not gated behind a connect the user hasn't triggered yet. */
export function supportedEffortChoices(capabilities: ProviderCapabilities | undefined, model?: string): string[] {
  if (!capabilities) return []
  // A catalog entry not found for this exact model (a saved alias, a runtime-reported concrete
  // ID the catalog never listed, ...) is unreported, not unsupported — fall back to the provider's
  // own declared ladder so the control still shows instead of vanishing until a fresh connect.
  const ladder = modelEfforts(capabilities, model) ?? capabilities.effort
  return (ladder ?? []).filter(effort => effort && effort !== 'auto')
}

/** The effort Conductor sends: the owner's saved choice or the catalog/runtime default when it is
 *  one of the reported choices, otherwise nothing. Claude's `initialize` reports no default effort,
 *  and guessing `medium` there launched every new conversation below the CLI's own `high` and the
 *  owner's saved `xhigh`; with no effort sent the runtime applies its configured level. */
export function resolveEffortChoice(choices: string[], preferred?: string): string | undefined {
  if (!choices.length) return undefined
  return preferred && choices.includes(preferred) ? preferred : undefined
}

/** What "Account default" is shown as when nothing else names a level: never sent to the
 *  runtime, so it carries none of the risk `resolveEffortChoice` above guards against. The
 *  owner's own Claude Code settings recommend "medium effort for most tasks" (the CLI's
 *  `tengu_grey_step2` nudge, global settings.json, 2026-09-23), and Codex/OpenAI document the
 *  same middle tier as their reasoning default — used only when the model's ladder offers it,
 *  else the middle position of whatever ladder remains. */
export function documentedDefaultEffort(choices: string[]): string | undefined {
  if (!choices.length) return undefined
  return choices.includes('medium') ? 'medium' : choices[Math.floor((choices.length - 1) / 2)]
}
