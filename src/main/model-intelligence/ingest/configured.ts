import type { AgentProviderInfo } from '../../../shared/models'
import type { FieldObservation, IngestionBatch, ModelKey, RegistryField, RegistryValue, SourceRef } from '../../../shared/model-routing'
import type { LocalModelConfig } from '../../local-models/config'
import { familyOf } from '../registry'

const GIB = 1024 ** 3
const PLACEHOLDER_IDS = new Set(['default', 'auto'])

/** One configured local model: the local-models config entry (loadConfig().models) plus, when the
 *  wiring can compute it, the admission estimate of its VRAM (resource-guard resourceRequirements). */
export type ConfiguredLocalModel = Pick<LocalModelConfig, 'id' | 'label' | 'quant' | 'sizeBytes' | 'contextTokens' | 'gpuLayers'> & { vramBytes?: number | null }

export interface ConfiguredCatalogs {
  /** AgentManager.listProviders(): the catalogs Conductor ships, and whether each CLI is installed. */
  providers: Array<Pick<AgentProviderInfo, 'id' | 'displayName' | 'available' | 'models' | 'efforts'>>
  /** null when the local stack is not set up (loadConfig throws). */
  localModels: ConfiguredLocalModel[] | null
}

export interface ConfiguredPorts { catalogs(): ConfiguredCatalogs | Promise<ConfiguredCatalogs> }

const gib = (bytes: number | null | undefined): number | null => typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? Number((bytes / GIB).toFixed(2)) : null

/**
 * Pure: one complete batch per provider catalog (`configured:<provider>`, config authority), so a
 * provider whose catalog is momentarily empty (local not set up) is simply skipped instead of
 * removing every model the other catalogs list.
 */
export function mapConfigured(catalogs: ConfiguredCatalogs, fetchedAt: string): IngestionBatch[] {
  const batches: IngestionBatch[] = []
  const locals = new Map((catalogs.localModels ?? []).map(model => [model.id, model]))
  for (const provider of catalogs.providers) {
    const source: SourceRef = { kind: 'config', name: `configured:${provider.id}` }
    const efforts = provider.efforts.map(effort => effort.id).filter(id => !PLACEHOLDER_IDS.has(id))
    const observations: FieldObservation[] = []
    const models = provider.id === 'local' && !provider.models.length ? [...locals.values()].map(model => ({ id: model.id, label: model.label })) : provider.models
    for (const model of models) {
      if (PLACEHOLDER_IDS.has(model.id)) continue
      const key: ModelKey = { provider: provider.id, model: model.id }
      const add = (field: RegistryField, value: RegistryValue): void => { if (value !== null) observations.push({ key, field, value, source, observedAt: fetchedAt }) }
      add('displayName', model.label || model.id)
      add('family', familyOf(model.id, model.label))
      add('efforts', efforts)
      add('availability', provider.available ? 'available' : 'unavailable')
      const local = provider.id === 'local' ? locals.get(model.id) : undefined
      if (local) {
        add('contextTokens', local.contextTokens)
        add('localQuant', local.quant)
        add('localSizeGb', gib(local.sizeBytes))
        add('localVramGb', gib(local.vramBytes))
        add('localGpuLayers', local.gpuLayers)
        // Conductor's local agent drives every configured model through its tool loop (local-models/agent.ts).
        add('toolUse', true)
      }
    }
    if (observations.length) batches.push({ source, fetchedAt, observations, benchmarks: [], complete: true })
  }
  return batches
}

export async function fetchBatches(ports: ConfiguredPorts, now: () => Date = () => new Date()): Promise<IngestionBatch[]> {
  return mapConfigured(await ports.catalogs(), now().toISOString())
}
