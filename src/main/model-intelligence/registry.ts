import type { AgentProviderId } from '../../shared/models'
import {
  capabilityRank, modelKeyId, REGISTRY_STALE_DAYS, SOURCE_AUTHORITY,
  type Availability, type FieldObservation, type IngestionBatch, type ModelKey, type ModelStatus, type RegistryChange, type RegistryChangeKind,
  type RegistryField, type RegistryRecord, type RegistryValue, type SourceRef
} from '../../shared/model-routing'
import type { ModelIntelligenceStore, StoredObservation, StoredRecord } from './store'

const DAY_MS = 86_400_000

/** The contract's capabilityRank from the model name, or from its family when the name alone is
 *  unclassified (rank 2 is capabilityRank's default): `claude/opus[1m]` is 3 by name, a CLI alias
 *  linked to `claude-haiku-4.5` is 1 by family. */
export function rankOf(key: ModelKey, family: string | null): 0 | 1 | 2 | 3 {
  const byModel = capabilityRank(key.provider as AgentProviderId, key.model)
  return byModel === 2 && family ? capabilityRank(key.provider as AgentProviderId, family) : byModel
}
const FIELDS: ReadonlySet<RegistryField> = new Set<RegistryField>([
  'displayName', 'family', 'releasedAt', 'deprecatedAt', 'contextTokens', 'maxOutputTokens', 'modalities', 'toolUse', 'efforts', 'priceInputPerMTok',
  'priceOutputPerMTok', 'priceCachedInputPerMTok', 'latencyMs', 'tokensPerSecond', 'availability', 'capabilities', 'localSizeGb', 'localQuant', 'localVramGb', 'localGpuLayers'
])
const NUMBER_FIELDS: ReadonlySet<RegistryField> = new Set<RegistryField>(['contextTokens', 'maxOutputTokens', 'priceInputPerMTok', 'priceOutputPerMTok', 'priceCachedInputPerMTok', 'latencyMs', 'tokensPerSecond', 'localSizeGb', 'localVramGb', 'localGpuLayers'])
const LIST_FIELDS: ReadonlySet<RegistryField> = new Set<RegistryField>(['modalities', 'efforts', 'capabilities'])
const AVAILABILITY: ReadonlySet<string> = new Set<Availability>(['available', 'limited', 'unavailable', 'deprecated', 'unknown'])
const CHANGE_KIND: Partial<Record<RegistryField, RegistryChangeKind>> = {
  priceInputPerMTok: 'price', priceOutputPerMTok: 'price', priceCachedInputPerMTok: 'price', contextTokens: 'context', maxOutputTokens: 'context',
  toolUse: 'capability', capabilities: 'capability', modalities: 'capability', efforts: 'capability', availability: 'availability', deprecatedAt: 'deprecated'
}

/**
 * A family name shared by the same weights under different providers and aliases, so priors can
 * flow between keys without claiming they are one model: `claude/opus[1m]` ("Claude Opus 5.5"),
 * `anthropic/claude-opus-5-5` and `openrouter/anthropic/claude-opus-5.5` are all `claude-opus-5.5`.
 * Aliases without a version (opus, sonnet) take the family from their display name.
 */
export function familyOf(model: string, displayName?: string | null): string | null {
  const clean = (value: string): string => value.toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\[[^\]]*\]/g, '').replace(/:[a-z0-9-]+$/, '')
    .replace(/^[a-z0-9-]+:\s+/, '').trim().replace(/\s+/g, '-')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/-(?:latest|preview)$/, '')
  const id = clean(model.slice(model.lastIndexOf('/') + 1))
  if (!id || id === 'default' || id === 'auto') return null
  const base = /\d/.test(id) || !displayName ? id : clean(displayName)
  // An unversioned name (the Claude CLI's "Opus (1M context)") says nothing about the weights.
  if (!/\d/.test(base)) return null
  const claude = /^(?:claude-)?(?:(opus|sonnet|haiku|fable|instant)-(\d+)(?:[-.](\d{1,2}))?|claude-(\d+)(?:[-.](\d{1,2}))?-(opus|sonnet|haiku|instant))$/.exec(base)
  if (claude) {
    const [tier, major, minor] = claude[1] ? [claude[1], claude[2], claude[3]] : [claude[6], claude[4], claude[5]]
    return `claude-${tier}-${major}${minor ? `.${minor}` : ''}`
  }
  return base
}

export interface ApplyResult {
  source: SourceRef
  keys: number
  observationsAdded: number
  observationsConfirmed: number
  benchmarksAdded: number
  changes: RegistryChange[]
}

const same = (a: RegistryValue | undefined, b: RegistryValue | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function validate(observation: FieldObservation): void {
  const { key, field, value } = observation
  const where = `${modelKeyId(key)} ${field}`
  if (typeof key?.provider !== 'string' || !key.provider || key.provider.length > 60 || typeof key.model !== 'string' || !key.model || key.model.length > 200) throw new Error(`Invalid model key in observation: ${JSON.stringify(key)}`)
  if (!FIELDS.has(field)) throw new Error(`Unknown registry field: ${String(field)}`)
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error(`${where}: observedAt is not a timestamp`)
  if (value === null) return
  if (NUMBER_FIELDS.has(field) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`${where} must be a non-negative number`)
  if (LIST_FIELDS.has(field) && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new Error(`${where} must be a list of strings`)
  if (field === 'toolUse' && typeof value !== 'boolean') throw new Error(`${where} must be true or false`)
  if (field === 'availability' && !AVAILABILITY.has(String(value))) throw new Error(`${where} must be one of ${[...AVAILABILITY].join(', ')}`)
  if (['displayName', 'family', 'releasedAt', 'deprecatedAt', 'localQuant'].includes(field) && typeof value !== 'string') throw new Error(`${where} must be text`)
}

/** Per field: a source still listing the key beats one that dropped it, then authority, then the
 *  most recently confirmed. A dropped source's value only fills a field no live source reports,
 *  so a withdrawn listing cannot keep overriding a live one. */
function winners(observations: StoredObservation[], dropped: ReadonlySet<string>): Map<RegistryField, StoredObservation> {
  const best = new Map<RegistryField, StoredObservation>()
  for (const observation of observations) {
    const current = best.get(observation.field)
    if (!current) { best.set(observation.field, observation); continue }
    const live = Number(!dropped.has(observation.source.name)) - Number(!dropped.has(current.source.name))
    const rank = live || SOURCE_AUTHORITY[observation.source.kind] - SOURCE_AUTHORITY[current.source.kind]
    if (rank > 0 || rank === 0 && observation.confirmedAt > current.confirmedAt) best.set(observation.field, observation)
  }
  return best
}

/**
 * Effective model records derived from observations with provenance (docs/model-routing.md, A).
 * Ingestion never deletes: a batch only adds or confirms observations, and a key a complete
 * source stops listing is a `removed` change; it is `retired` once every source has dropped it.
 */
export class ModelRegistry {
  constructor(private readonly store: ModelIntelligenceStore) {}

  /** One transaction: observations stored, touched records recomputed, changes emitted. A throw
   *  anywhere (an invalid observation included) leaves the registry exactly as it was. */
  applyBatch(batch: IngestionBatch): ApplyResult {
    return this.store.transaction(() => this.apply(batch))
  }

  /** Several batches of one source, all or nothing. */
  applyBatches(batches: IngestionBatch[]): ApplyResult[] {
    return this.store.transaction(() => batches.map(batch => this.apply(batch)))
  }

  private apply(batch: IngestionBatch): ApplyResult {
    if (!Number.isFinite(Date.parse(batch.fetchedAt))) throw new Error('Batch fetchedAt is not a timestamp')
    const at = new Date(Date.parse(batch.fetchedAt)).toISOString()
    for (const observation of batch.observations) {
      validate(observation)
      if (observation.source.name !== batch.source.name) throw new Error(`Observation from ${observation.source.name} in a batch from ${batch.source.name}`)
    }
    const keys = new Map<string, ModelKey>()
    for (const observation of batch.observations) keys.set(modelKeyId(observation.key), observation.key)
    if (batch.complete && keys.size === 0) throw new Error(`Complete batch from ${batch.source.name} lists no models; refusing to treat that as every model removed`)

    const result: ApplyResult = { source: batch.source, keys: keys.size, observationsAdded: 0, observationsConfirmed: 0, benchmarksAdded: 0, changes: [] }
    const change = (entry: Omit<RegistryChange, 'source' | 'at'>): void => { const full = { ...entry, source: batch.source, at }; this.store.recordChange(full); result.changes.push(full) }
    const before = new Map<string, StoredRecord | null>()
    for (const [id, key] of keys) before.set(id, this.store.record(key))
    const newProviders = new Set([...keys.values()].map(key => key.provider).filter(provider => !this.store.hasProvider(provider)))

    for (const observation of batch.observations) {
      if (this.store.observe(observation) === 'added') result.observationsAdded++
      else result.observationsConfirmed++
    }
    const relisted = new Set(this.store.list(batch.source, [...keys.values()], at).map(modelKeyId))

    for (const [id, key] of keys) {
      const previous = before.get(id) ?? null
      const status: ModelStatus = !previous ? 'unproven' : previous.status === 'retired' && relisted.has(id) ? 'unproven' : previous.status
      const next = this.derive(key, status, previous?.firstSeenAt ?? at, previous && previous.updatedAt > at ? previous.updatedAt : at)
      this.store.saveRecord(next)
      if (!previous || previous.status === 'retired') {
        change({ kind: 'new-model', key, after: next.displayName })
        if (newProviders.delete(key.provider)) change({ kind: 'new-provider', key, after: key.provider })
        continue
      }
      for (const field of FIELDS) {
        const was = fieldValue(previous, field), now = fieldValue(next, field)
        if (!same(was, now)) change({ kind: CHANGE_KIND[field] ?? 'updated', key, field, before: was ?? null, after: now ?? null })
      }
    }

    if (batch.complete) {
      for (const key of this.store.listedBy(batch.source.name)) {
        if (keys.has(modelKeyId(key))) continue
        this.store.drop(batch.source.name, key, at)
        change({ kind: 'removed', key })
        if (this.store.listings(key).every(listing => listing.droppedAt)) {
          const record = this.store.record(key)
          if (record && record.status !== 'retired') this.store.saveRecord({ ...record, status: 'retired' })
        }
      }
    }
    for (const benchmark of batch.benchmarks) if (this.store.recordBenchmark(benchmark) === 'added') result.benchmarksAdded++
    return result
  }

  private derive(key: ModelKey, status: ModelStatus, firstSeenAt: string, updatedAt: string): StoredRecord {
    const dropped = new Set(this.store.listings(key).filter(listing => listing.droppedAt).map(listing => listing.source))
    const best = winners(this.store.latestObservations(key), dropped)
    const value = <T extends RegistryValue>(field: RegistryField, fallback: T): T => (best.get(field)?.value ?? fallback) as T
    const num = (field: RegistryField): number | null => value<number | null>(field, null)
    const price = { inputPerMTok: num('priceInputPerMTok'), outputPerMTok: num('priceOutputPerMTok'), cachedInputPerMTok: num('priceCachedInputPerMTok') }
    const local = { sizeGb: num('localSizeGb'), quant: value<string | null>('localQuant', null), vramGb: num('localVramGb'), gpuLayers: num('localGpuLayers') }
    const displayName = value<string>('displayName', key.model)
    const family = value<string | null>('family', null) ?? familyOf(key.model, displayName)
    const provenance: RegistryRecord['provenance'] = {}
    for (const [field, observation] of best) provenance[field] = { source: observation.source, observedAt: observation.confirmedAt }
    return {
      key, status, displayName,
      family, capabilityRank: rankOf(key, family),
      releasedAt: value<string | null>('releasedAt', null), deprecatedAt: value<string | null>('deprecatedAt', null),
      contextTokens: num('contextTokens'), maxOutputTokens: num('maxOutputTokens'),
      modalities: value<string[]>('modalities', []), toolUse: value<boolean | null>('toolUse', null), efforts: value<string[]>('efforts', []),
      pricing: Object.values(price).some(entry => entry !== null) ? { ...price, currency: 'USD' } : null,
      latencyMs: num('latencyMs'), tokensPerSecond: num('tokensPerSecond'),
      availability: value<Availability>('availability', 'unknown'), capabilities: value<string[]>('capabilities', []),
      local: key.provider === 'local' || Object.values(local).some(entry => entry !== null) ? { ...local, loaded: false } : null,
      provenance, firstSeenAt, updatedAt
    }
  }

  private read(record: StoredRecord, now = this.store.now()): RegistryRecord {
    return { ...record, capabilityRank: record.capabilityRank ?? rankOf(record.key, record.family), stale: now.getTime() - Date.parse(record.updatedAt) > REGISTRY_STALE_DAYS * DAY_MS }
  }

  get(key: ModelKey): RegistryRecord | null {
    const record = this.store.record(key)
    return record ? this.read(record) : null
  }

  list(filter: { provider?: string; model?: string; status?: ModelStatus; includeRetired?: boolean; limit?: number } = {}): RegistryRecord[] {
    const now = this.store.now()
    return this.store.records(filter).filter(record => filter.includeRetired || filter.status === 'retired' || record.status !== 'retired').map(record => this.read(record, now))
  }

  /** The other keys of this key's family (the same weights elsewhere, or its aliases). */
  family(key: ModelKey): RegistryRecord[] {
    const family = this.store.record(key)?.family ?? familyOf(key.model)
    if (!family) return []
    const id = modelKeyId(key), now = this.store.now()
    return this.store.records({ family }).filter(record => modelKeyId(record.key) !== id && record.status !== 'retired').map(record => this.read(record, now))
  }

  /** Status moves only on evaluation or reputation evidence (modules B and D). */
  setStatus(key: ModelKey, status: ModelStatus): RegistryRecord {
    return this.store.transaction(() => {
      const record = this.store.record(key)
      if (!record) throw new Error(`Model not registered: ${modelKeyId(key)}`)
      if (record.status !== status) this.store.saveRecord({ ...record, status })
      return this.read({ ...record, status })
    })
  }

  /** Enough Conductor evidence: proven. A retired key stays retired. */
  promote(key: ModelKey): RegistryRecord {
    const record = this.get(key)
    if (!record) throw new Error(`Model not registered: ${modelKeyId(key)}`)
    return record.status === 'retired' || record.status === 'proven' ? record : this.setStatus(key, 'proven')
  }

  changes(query: { since: string; key?: ModelKey; limit?: number }): RegistryChange[] {
    return this.store.changes({ ...query, limit: query.limit ?? 500 })
  }

  observations(key: ModelKey, field?: RegistryField): StoredObservation[] {
    return this.store.observations(key, field)
  }
}

function fieldValue(record: StoredRecord, field: RegistryField): RegistryValue | undefined {
  switch (field) {
    case 'priceInputPerMTok': return record.pricing?.inputPerMTok ?? null
    case 'priceOutputPerMTok': return record.pricing?.outputPerMTok ?? null
    case 'priceCachedInputPerMTok': return record.pricing?.cachedInputPerMTok ?? null
    case 'localSizeGb': return record.local?.sizeGb ?? null
    case 'localQuant': return record.local?.quant ?? null
    case 'localVramGb': return record.local?.vramGb ?? null
    case 'localGpuLayers': return record.local?.gpuLayers ?? null
    default: return record[field] as RegistryValue
  }
}
