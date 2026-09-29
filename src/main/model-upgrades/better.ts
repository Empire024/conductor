import type { AgentProviderId } from '../../shared/models'
import { capabilityRank } from '../../shared/model-routing'
import type { CatalogModel, UpgradeReason } from '../../shared/model-upgrades'

/** `gpt-6.1-sol` → series gpt, version [6, 1], tier sol; `claude-opus-5-5` / `opus[1m]` (label
 *  "Claude Opus 5.5") → series claude, version [5, 5], tier opus. Null when the id carries no
 *  version (an alias such as `sonnet` without a display name). */
export interface ModelLine { series: string; version: number[]; tier: string | null }
export function modelLine(id: string, displayName?: string | null): ModelLine | null {
  const clean = (value: string): string => value.toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim()
  const fromId = clean(id.slice(id.lastIndexOf('/') + 1))
  const source = /\d/.test(fromId) ? fromId : displayName ? clean(displayName).replace(/\s+/g, '-') : fromId
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d+))?/.exec(source)
  if (claude) return { series: 'claude', version: [Number(claude[2]), ...(claude[3] ? [Number(claude[3])] : [])], tier: claude[1] ?? null }
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z]+))?/.exec(source)
  if (gpt) return { series: 'gpt', version: (gpt[1] ?? '').split('.').map(Number), tier: gpt[2] ?? null }
  const generic = /^([a-z]+)-?(\d+(?:\.\d+)*)(?:-([a-z]+))?/.exec(source)
  return generic ? { series: generic[1] ?? '', version: (generic[2] ?? '').split('.').map(Number), tier: generic[3] ?? null } : null
}
export function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta) return delta
  }
  return 0
}
/** The catalog of the newest runtime among several (tabs on different CLI versions, the upgrade
 *  probe); the first listed wins a tie, so a tab's richer entry beats a probe of the same CLI. */
export function freshestCatalog<T extends { version?: string | null; models: unknown[] }>(candidates: readonly T[]): T | undefined {
  const parse = (value: string | null | undefined): number[] => (/\d+(?:\.\d+)*/.exec(value ?? '')?.[0] ?? '0').split('.').map(Number)
  let best: T | undefined
  for (const candidate of candidates) if (candidate.models.length && (!best || compareVersions(parse(candidate.version), parse(best.version)) > 0)) best = candidate
  return best
}
const PREVIOUS =/previous[- ]generation|legacy|superseded|being retired|will be retired/i

export interface BetterModel { model: CatalogModel; replaces: CatalogModel; reasons: UpgradeReason[] }

/**
 * Which models of `next` (a newer CLI's catalog, or the current CLI's catalog re-read) are better
 * than the models the owner actually uses (`picks`: the provider default and preferred picks).
 * A model is better than a pick when the catalog itself says so (the pick's `upgrade` names it, or
 * the pick is now described as a previous generation), when it is the same tier at a higher version
 * (Opus 5.5 → Opus 5.6), or when the catalog made it the default in the pick's place and it ranks
 * at least as high. A model already in `previous` is not new unless the catalog newly points at it.
 * Pure; `declined` filters out models the owner said no to.
 */
export function betterModels(provider: AgentProviderId, previous: readonly CatalogModel[], next: readonly CatalogModel[], picks: readonly string[], declined: ReadonlySet<string> = new Set()): BetterModel[] {
  const before = new Map(previous.map(model => [model.id, model]))
  const after = new Map(next.map(model => [model.id, model]))
  const oldDefault = previous.find(model => model.isDefault)?.id ?? null
  const references = [...new Set(picks)].map(id => after.get(id) ?? before.get(id)).filter((model): model is CatalogModel => Boolean(model))
  const found = new Map<string, BetterModel>()
  for (const candidate of next) {
    if (candidate.hidden || candidate.id === 'default' || declined.has(candidate.id)) continue
    const isNew = !before.has(candidate.id)
    for (const pick of references) {
      if (pick.id === candidate.id) continue
      const reasons: UpgradeReason[] = []
      const pickNow = after.get(pick.id)
      if (pickNow?.upgrade === candidate.id && (isNew || before.get(pick.id)?.upgrade !== candidate.id)) reasons.push({ kind: 'catalog-upgrade', text: `the catalog names it the upgrade for ${label(pick)}` })
      if (isNew) {
        const a = modelLine(candidate.id, candidate.displayName), b = modelLine(pick.id, pick.displayName)
        if (a && b && a.series === b.series && a.tier && a.tier === b.tier && compareVersions(a.version, b.version) > 0) reasons.push({ kind: 'newer-version', text: `a newer ${a.tier} than ${label(pick)}` })
        if (a && b && a.series === b.series && compareVersions(a.version, b.version) > 0 && (a.version[0] ?? 0) > (b.version[0] ?? 0) && rank(provider, candidate) >= rank(provider, pick) && !reasons.some(reason => reason.kind === 'newer-version')) reasons.push({ kind: 'new-generation', text: `a new generation after ${label(pick)}` })
        // The catalog's own default is a ranking: taken when it ranks as high or is a later version of the same series.
        const later = Boolean(a && b && a.series === b.series && compareVersions(a.version, b.version) > 0)
        if (candidate.isDefault && oldDefault === pick.id && (later || rank(provider, candidate) >= rank(provider, pick))) reasons.push({ kind: 'catalog-default', text: `the catalog now makes it the default instead of ${label(pick)}` })
      }
      if (pickNow && PREVIOUS.test(pickNow.description ?? '') && !PREVIOUS.test(before.get(pick.id)?.description ?? '') && (isNew || candidate.isDefault) && rank(provider, candidate) >= rank(provider, pick)) reasons.push({ kind: 'previous-generation', text: `${label(pick)} is now marked as a previous generation` })
      if (!reasons.length) continue
      const existing = found.get(candidate.id)
      if (!existing || reasons.length > existing.reasons.length) found.set(candidate.id, { model: candidate, replaces: pick, reasons })
    }
  }
  return [...found.values()].sort((a, b) => rank(provider, b.model) - rank(provider, a.model) || b.reasons.length - a.reasons.length || a.model.id.localeCompare(b.model.id))
}
const rank = (provider: AgentProviderId, model: CatalogModel): number => capabilityRank(provider, model.id)
export const label = (model: Pick<CatalogModel, 'id' | 'displayName'>): string => model.displayName || model.id
