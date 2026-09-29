/** Models the owner accepted through an auto model upgrade (docs/model-upgrades.md): each takes
 *  the place of the model it replaced wherever Conductor's own picks named that one, meaning the
 *  pre-discovery default, routing rank and wizard frontier eligibility, without a code change.
 *  Main loads it from the settings table and pushes it to the renderer; both keep this copy. */
export interface PromotedModel { model: string; replaces: string; rank: 0 | 1 | 2 | 3; frontier: boolean; at: string }
export type PromotedModels = Partial<Record<string, PromotedModel>>

let promoted: PromotedModels = {}

export const setPromotedModels = (value: PromotedModels | null | undefined): void => { promoted = value && typeof value === 'object' ? { ...value } : {} }
export const promotedModels = (): PromotedModels => ({ ...promoted })
/** The model an upgrade made this provider's pick, if any. */
export const promotedModel = (provider: string | undefined): string | null => (provider && promoted[provider]?.model) || null
const entryFor = (provider: string | undefined, model: string): PromotedModel | null => {
  const entry = provider ? promoted[provider] : undefined
  return entry && entry.model.toLowerCase() === model.toLowerCase() ? entry : null
}
/** The rank the promoted model inherits from the model it replaced (never lower than its own). */
export const promotedRank = (provider: string | undefined, model: string): 0 | 1 | 2 | 3 | null => entryFor(provider, model)?.rank ?? null
/** True when the promoted model replaced a wizard-eligible model. */
export const promotedFrontier = (provider: string | undefined, model: string | undefined): boolean => Boolean(model && entryFor(provider, model)?.frontier)
