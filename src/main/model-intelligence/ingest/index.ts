import type { IngestionBatch, RegistryChange } from '../../../shared/model-routing'
import type { ModelRegistry } from '../registry'
import * as benchmarks from './benchmarks'
import * as configured from './configured'
import * as latestModels from './latest-models'
import * as openrouter from './openrouter'
import * as runtime from './runtime'

export type IngestionSourceName = 'configured' | 'runtime' | 'latest-models' | 'openrouter' | 'benchmarks'
export const INGESTION_SOURCES: readonly IngestionSourceName[] = ['configured', 'runtime', 'latest-models', 'openrouter', 'benchmarks']
/** A source that hangs past this is abandoned; its own timeouts (OpenRouter's 8 s) are shorter. */
export const SOURCE_TIMEOUT_MS = 30_000

/** Every port is optional: a source without one is skipped (the wiring supplies what exists). */
export interface IngestionPorts {
  configured?: configured.ConfiguredPorts
  runtime?: runtime.RuntimePorts
  latestModels?: latestModels.LatestModelsPorts
  openrouter?: openrouter.OpenRouterPorts
  benchmarks?: benchmarks.BenchmarkPorts
  now?: () => Date
}

export interface SourceResult {
  source: IngestionSourceName
  status: 'ok' | 'failed' | 'skipped'
  batches: number
  models: number
  observationsAdded: number
  changes: RegistryChange[]
  /** Why nothing (or not everything) was applied. A partial latest-models read is ok with errors. */
  errors: string[]
  elapsedMs: number
}

export interface RefreshResult { results: SourceResult[]; changes: RegistryChange[] }

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); timer.unref?.() })])
    .finally(() => clearTimeout(timer))
}

async function collect(source: IngestionSourceName, ports: IngestionPorts): Promise<{ batches: IngestionBatch[]; errors: string[] } | null> {
  const now = ports.now ?? (() => new Date())
  switch (source) {
    case 'configured': return ports.configured ? { batches: await configured.fetchBatches(ports.configured, now), errors: [] } : null
    case 'runtime': return ports.runtime ? { batches: await runtime.fetchBatches(ports.runtime, now), errors: [] } : null
    case 'latest-models': return ports.latestModels ? await latestModels.fetchBatches(ports.latestModels) : null
    case 'openrouter': return ports.openrouter ? { batches: [await openrouter.fetchBatch({ now, ...ports.openrouter })], errors: [] } : null
    case 'benchmarks': return ports.benchmarks ? { batches: [await benchmarks.fetchBatch(ports.benchmarks, now)], errors: [] } : null
  }
}

/**
 * Runs the sources independently: fetches in parallel, then applies each source's batches in one
 * transaction of its own. A source that throws, times out or produces an invalid batch changes
 * nothing and never stops the others.
 */
export async function refreshAll(registry: ModelRegistry, ports: IngestionPorts, only: readonly IngestionSourceName[] = INGESTION_SOURCES): Promise<RefreshResult> {
  const fetched = await Promise.all(only.map(async source => {
    const started = Date.now()
    try { return { source, started, collected: await within(collect(source, ports), SOURCE_TIMEOUT_MS, source), error: null } } catch (error) { return { source, started, collected: null, error: (error as Error)?.message ?? String(error) } }
  }))
  const results: SourceResult[] = []
  for (const { source, started, collected, error } of fetched) {
    const result: SourceResult = { source, status: 'ok', batches: 0, models: 0, observationsAdded: 0, changes: [], errors: [], elapsedMs: 0 }
    if (error !== null) Object.assign(result, { status: 'failed', errors: [error] })
    else if (!collected) result.status = 'skipped'
    else {
      result.errors.push(...collected.errors)
      if (!collected.batches.length) { if (collected.errors.length) result.status = 'failed' }
      else {
        try {
          for (const applied of registry.applyBatches(collected.batches)) {
            result.batches++
            result.models += applied.keys
            result.observationsAdded += applied.observationsAdded
            result.changes.push(...applied.changes)
          }
        } catch (applyError) {
          Object.assign(result, { status: 'failed', batches: 0, models: 0, observationsAdded: 0, changes: [] })
          result.errors.push(`apply: ${(applyError as Error)?.message ?? String(applyError)}`)
        }
      }
    }
    result.elapsedMs = Date.now() - started
    results.push(result)
  }
  return { results, changes: results.flatMap(result => result.changes) }
}
