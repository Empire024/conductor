import type { FieldObservation, IngestionBatch, ModelKey, RegistryField, RegistryValue, SourceRef } from '../../../shared/model-routing'
import { familyOf } from '../registry'

/** The latest stdout of one latest-models-methods schedule script, as the scheduler kept it. */
export interface ScriptOutput { stdout: string; at: string }
export interface LatestModelsOutputs { cliCatalogs: ScriptOutput | null; primarySources: ScriptOutput | null }
export interface LatestModelsPorts { outputs(): LatestModelsOutputs | Promise<LatestModelsOutputs> }

/** primary-sources ids to the creator's own API provider; model ids there are API ids, not CLI aliases. */
const PRIMARY_SOURCES: Record<string, { provider: string; url: string }> = {
  'anthropic-models': { provider: 'anthropic', url: 'https://platform.claude.com/docs/en/models/overview.md' },
  'openai-models': { provider: 'openai', url: 'https://developers.openai.com/api/docs/models/all.md' }
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null

function builder(source: SourceRef, fetchedAt: string) {
  const observations: FieldObservation[] = []
  return {
    observations,
    add: (key: ModelKey, field: RegistryField, value: RegistryValue): void => { if (value !== null) observations.push({ key, field, value, source, observedAt: fetchedAt }) }
  }
}

/**
 * Pure: cli-catalogs.mjs output ({claude: {version, models|error}, codex: {...}}) to one complete
 * cli batch per CLI that answered. A CLI that reported an error yields nothing, so a missing
 * executable never reads as every model removed.
 */
export function parseCliCatalogs(stdout: string, fetchedAt: string): IngestionBatch[] {
  const parsed = JSON.parse(stdout) as Record<string, { error?: unknown; version?: unknown; models?: unknown }>
  const batches: IngestionBatch[] = []
  const claude = parsed?.claude
  if (claude && !claude.error && Array.isArray(claude.models)) {
    const source: SourceRef = { kind: 'cli', name: 'latest-models:cli-catalogs:claude' }
    const { observations, add } = builder(source, fetchedAt)
    for (const model of claude.models as Array<Record<string, unknown>>) {
      const id = text(model.value)
      if (!id || id === 'default') continue
      const key: ModelKey = { provider: 'claude', model: id }
      const displayName = text(model.displayName)
      if (displayName) add(key, 'displayName', displayName)
      add(key, 'family', familyOf(text(model.resolvedModel) ?? id, displayName))
      add(key, 'efforts', strings(model.efforts))
      add(key, 'availability', 'available')
    }
    if (observations.length) batches.push({ source, fetchedAt, observations, benchmarks: [], complete: true })
  }
  const codex = parsed?.codex
  if (codex && !codex.error && Array.isArray(codex.models)) {
    const source: SourceRef = { kind: 'cli', name: 'latest-models:cli-catalogs:codex' }
    const { observations, add } = builder(source, fetchedAt)
    for (const model of codex.models as Array<Record<string, unknown>>) {
      const id = text(model.id)
      if (!id) continue
      const key: ModelKey = { provider: 'codex', model: id }
      const displayName = text(model.displayName)
      const retires = timestamp(model.retirementAt)
      if (displayName) add(key, 'displayName', displayName)
      add(key, 'family', familyOf(id, displayName))
      add(key, 'efforts', strings(model.efforts))
      add(key, 'deprecatedAt', retires)
      add(key, 'availability', retires ? 'deprecated' : model.hidden === true ? 'limited' : 'available')
    }
    if (observations.length) batches.push({ source, fetchedAt, observations, benchmarks: [], complete: true })
  }
  return batches
}

/**
 * Pure: primary-sources.mjs output ({sources: {<id>: {modelIds, stale?, problem?, unavailable?}}})
 * to provider-docs batches keyed under the creator's API provider. Only a fresh, clean page is a
 * complete listing; cached facts after a failure (stale) or an unparseable page (problem) still
 * confirm what they name but cannot remove anything.
 */
export function parsePrimarySources(stdout: string, fetchedAt: string): IngestionBatch[] {
  const parsed = JSON.parse(stdout) as { sources?: Record<string, { modelIds?: unknown; stale?: unknown; problem?: unknown; unavailable?: unknown }> }
  const batches: IngestionBatch[] = []
  for (const [id, target] of Object.entries(PRIMARY_SOURCES)) {
    const entry = parsed?.sources?.[id]
    const ids = strings(entry?.modelIds)
    if (!entry || entry.unavailable || !ids.length) continue
    const source: SourceRef = { kind: 'provider-docs', name: `latest-models:primary-sources:${id}`, url: target.url }
    const { observations, add } = builder(source, fetchedAt)
    for (const model of new Set(ids)) {
      const key: ModelKey = { provider: target.provider, model }
      add(key, 'family', familyOf(model))
      add(key, 'availability', 'available')
    }
    batches.push({ source, fetchedAt, observations, benchmarks: [], complete: !entry.stale && !entry.problem })
  }
  return batches
}

/** Each script output is parsed on its own: an unreadable one is reported and the other still counts. */
export async function fetchBatches(ports: LatestModelsPorts): Promise<{ batches: IngestionBatch[]; errors: string[] }> {
  const outputs = await ports.outputs()
  const batches: IngestionBatch[] = [], errors: string[] = []
  const parse = (name: string, output: ScriptOutput | null, parser: (stdout: string, at: string) => IngestionBatch[]): void => {
    if (!output) return
    const at = timestamp(output.at)
    if (!at) { errors.push(`${name}: output has no valid timestamp`); return }
    try { batches.push(...parser(output.stdout, at)) } catch (error) { errors.push(`${name}: ${(error as Error).message}`) }
  }
  parse('cli-catalogs', outputs.cliCatalogs, parseCliCatalogs)
  parse('primary-sources', outputs.primarySources, parsePrimarySources)
  return { batches, errors }
}
