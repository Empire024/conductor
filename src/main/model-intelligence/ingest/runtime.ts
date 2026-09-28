import type { FieldObservation, IngestionBatch, ModelKey, RegistryField, RegistryValue, SourceRef } from '../../../shared/model-routing'
import { familyOf } from '../registry'

/** One entry of the `models.list` control method (agent-control catalog()). */
export interface ModelsListEntry {
  provider: string
  available: boolean
  source?: 'runtime' | 'configured'
  models: Array<{ id: string; label?: string; effort?: string[]; defaultEffort?: string; isDefault?: boolean }>
}

export interface RuntimePorts { modelsList(): ModelsListEntry[] | Promise<ModelsListEntry[]> }

/**
 * Pure: what open tabs' CLIs advertised (cli authority for efforts and availability). Entries
 * models.list only filled from the configured catalog are skipped: that is the configured
 * source's job, and repeating it here would pass config facts off as CLI facts. Never complete,
 * because only providers with an open tab report anything.
 */
export function mapRuntime(entries: ModelsListEntry[], fetchedAt: string): IngestionBatch[] {
  const batches: IngestionBatch[] = []
  for (const entry of entries) {
    if (entry.source !== 'runtime' || !entry.provider || !Array.isArray(entry.models)) continue
    const source: SourceRef = { kind: 'cli', name: `runtime:${entry.provider}` }
    const observations: FieldObservation[] = []
    for (const model of entry.models) {
      if (!model?.id || model.id === 'default' || model.id === 'auto') continue
      const key: ModelKey = { provider: entry.provider, model: model.id }
      const add = (field: RegistryField, value: RegistryValue): void => { if (value !== null) observations.push({ key, field, value, source, observedAt: fetchedAt }) }
      if (model.label) add('displayName', model.label)
      add('family', familyOf(model.id, model.label))
      if (Array.isArray(model.effort)) add('efforts', model.effort.filter(effort => typeof effort === 'string' && effort !== 'auto'))
      add('availability', entry.available ? 'available' : 'unavailable')
    }
    if (observations.length) batches.push({ source, fetchedAt, observations, benchmarks: [], complete: false })
  }
  return batches
}

export async function fetchBatches(ports: RuntimePorts, now: () => Date = () => new Date()): Promise<IngestionBatch[]> {
  return mapRuntime(await ports.modelsList(), now().toISOString())
}
