import type { FieldObservation, IngestionBatch, ModelKey, RegistryField, RegistryRecord, RegistryValue, SourceRef } from '../../../shared/model-routing'
import { familyOf } from '../registry'

/**
 * The linked pass (D1): CLI keys (`claude/opus[1m]`, `codex/gpt-5.6-sol`) are what the router
 * offers, but prices, context and capabilities arrive under provider `openrouter`. After each
 * refresh this copies them from the OpenRouter record of the same family onto each CLI key, as an
 * aggregator-authority source, so a config or CLI fact still wins and the two records stay apart.
 * Unversioned Claude aliases (opus, sonnet, haiku, fable) link to the newest family of their tier.
 */

export const LINKED_SOURCE: SourceRef = { kind: 'aggregator', name: 'linked:openrouter', url: 'https://openrouter.ai/api/v1/models' }
const CLI_PROVIDERS = new Set(['claude', 'codex', 'grok'])
const COPIED: RegistryField[] = ['priceInputPerMTok', 'priceOutputPerMTok', 'priceCachedInputPerMTok', 'contextTokens', 'maxOutputTokens', 'toolUse', 'modalities', 'capabilities']
const CLAUDE_TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const

const version = (family: string): number[] => (/-(\d+(?:\.\d+)*)$/.exec(family)?.[1] ?? '0').split('.').map(Number)
const newer = (a: string, b: string): boolean => {
  const [x, y] = [version(a), version(b)]
  for (let index = 0; index < Math.max(x.length, y.length); index++) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0)
  return false
}

/** The family a CLI key stands for: its own when an aggregator record shares it, else for a Claude
 *  alias without a version the newest family of its tier among the aggregator records. A key that
 *  already names a version the aggregator does not list (Haiku 5.5 before OpenRouter has it) is
 *  not linked: Haiku 4.5's 200k context and prices are not Haiku 5.5's. A family this pass itself
 *  gave an alias is not the alias's own (its name decides again), so it moves on to a newer family. */
export function linkedFamily(record: RegistryRecord, families: ReadonlySet<string>): string | null {
  const own = record.provenance.family?.source.name === LINKED_SOURCE.name ? familyOf(record.key.model, record.displayName) : record.family
  if (own && families.has(own)) return own
  if (record.key.provider !== 'claude') return null
  const name = `${record.key.model} ${record.displayName}`.toLowerCase()
  const tier = /\bdefault\b/.test(name) ? 'opus' : CLAUDE_TIERS.find(candidate => name.includes(candidate))
  if (!tier) return null
  if (own && /^claude-[a-z]+-\d/.test(own)) return null
  let best: string | null = null
  for (const family of families) if (new RegExp(`^claude-${tier}-\\d`).test(family) && (!best || newer(family, best))) best = family
  return best
}

/** The aggregator record a family's facts are copied from: the base id before variants (`:free`,
 *  `:thinking`), and one with prices before one without. */
const pick = (records: RegistryRecord[]): RegistryRecord | undefined =>
  [...records].sort((a, b) => Number(a.key.model.includes(':')) - Number(b.key.model.includes(':')) || Number(!a.pricing) - Number(!b.pricing) || a.key.model.localeCompare(b.key.model))[0]

function fieldOf(record: RegistryRecord, field: RegistryField): RegistryValue {
  switch (field) {
    case 'priceInputPerMTok': return record.pricing?.inputPerMTok ?? null
    case 'priceOutputPerMTok': return record.pricing?.outputPerMTok ?? null
    case 'priceCachedInputPerMTok': return record.pricing?.cachedInputPerMTok ?? null
    case 'modalities': case 'capabilities': return (record[field] as string[]).length ? record[field] as string[] : null
    default: return record[field as 'contextTokens' | 'maxOutputTokens' | 'toolUse'] ?? null
  }
}

/** Pure: one incomplete batch linking every CLI key that has a family match (and withdrawing an
 *  earlier link's facts from a key that lost its match), or null when there is nothing to say. */
export function linkedBatch(records: RegistryRecord[], fetchedAt: string): IngestionBatch | null {
  const byFamily = new Map<string, RegistryRecord[]>()
  for (const record of records) if (record.key.provider === 'openrouter' && record.family && record.status !== 'retired') byFamily.set(record.family, [...byFamily.get(record.family) ?? [], record])
  const families = new Set(byFamily.keys()), observations: FieldObservation[] = []
  for (const record of records) {
    if (!CLI_PROVIDERS.has(record.key.provider) || record.status === 'retired') continue
    const family = linkedFamily(record, families)
    const source = family ? pick(byFamily.get(family)!) : undefined
    const key: ModelKey = record.key
    if (!family || !source) {
      // No longer linked (its CLI now names a version the aggregator lacks): withdraw what an earlier
      // link copied, so the old family's facts stop standing in for this model's.
      for (const field of ['family', ...COPIED] as RegistryField[]) if (record.provenance[field]?.source.name === LINKED_SOURCE.name) observations.push({ key, field, value: null, source: LINKED_SOURCE, observedAt: fetchedAt })
      continue
    }
    const add = (field: RegistryField, value: RegistryValue): void => { if (value !== null) observations.push({ key, field, value, source: LINKED_SOURCE, observedAt: fetchedAt }) }
    add('family', family)
    for (const field of COPIED) add(field, fieldOf(source, field))
  }
  return observations.length ? { source: LINKED_SOURCE, fetchedAt, observations, benchmarks: [], complete: false } : null
}
