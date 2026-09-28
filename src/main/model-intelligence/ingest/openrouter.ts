import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FieldObservation, IngestionBatch, ModelKey, RegistryField, RegistryValue, SourceRef } from '../../../shared/model-routing'
import { familyOf } from '../registry'

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
export const OPENROUTER_TIMEOUT_MS = 8_000
const MAX_BODY_BYTES = 32 * 1024 * 1024
const SOURCE: SourceRef = { kind: 'aggregator', name: 'openrouter', url: OPENROUTER_MODELS_URL }
/** supported_parameters worth routing on; the rest are sampling knobs. */
const CAPABILITY_PARAMETERS = new Set(['tools', 'tool_choice', 'reasoning', 'structured_outputs', 'response_format', 'web_search_options'])

export interface OpenRouterCacheEntry { etag: string | null; lastModified: string | null; body: string; fetchedAt: string }
export interface OpenRouterCache { read(): OpenRouterCacheEntry | null; write(entry: OpenRouterCacheEntry): void }

export interface OpenRouterPorts {
  fetch?: typeof fetch
  timeoutMs?: number
  /** Conditional GET state under userData; without it every refresh downloads the full list. */
  cache?: OpenRouterCache
  now?: () => Date
}

/** A JSON file cache (userData/model-intelligence/openrouter-models.json, chosen by the wiring). */
export function fileCache(path: string): OpenRouterCache {
  return {
    read: () => {
      try {
        const entry = JSON.parse(readFileSync(path, 'utf8')) as OpenRouterCacheEntry
        return typeof entry?.body === 'string' ? entry : null
      } catch { return null }
    },
    write: entry => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(`${path}.tmp`, JSON.stringify(entry))
      renameSync(`${path}.tmp`, path)
    }
  }
}

/** The first-party family for an OpenRouter id (`anthropic/claude-opus-4.5` -> `claude-opus-4.5`),
 *  so reputation priors can flow to the CLI keys without treating the two as one record. */
export const openRouterFamily = (id: string, name?: string | null): string | null => familyOf(id.replace(/:[a-z0-9-]+$/i, ''), name?.replace(/^[^:]+:\s*/, ''))

/** Per-token USD strings to per-million; OpenRouter uses -1 (or omits) for variable pricing. */
const perMTok = (value: unknown): number | null => {
  const number = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(number) && number >= 0 ? Number((number * 1_000_000).toFixed(6)) : null
}
const count = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= 60))].sort() : []

interface OpenRouterModel {
  id?: unknown; name?: unknown; created?: unknown; context_length?: unknown; expiration_date?: unknown
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown }
  architecture?: { input_modalities?: unknown }
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown }
  supported_parameters?: unknown
}

/** Pure: the /api/v1/models body to one complete batch under provider `openrouter`. */
export function mapOpenRouter(body: unknown, fetchedAt: string): IngestionBatch {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error('OpenRouter answered without a data list')
  const observations: FieldObservation[] = []
  const seen = new Set<string>()
  for (const entry of data as OpenRouterModel[]) {
    if (typeof entry?.id !== 'string' || !/^[\w.:/-]{1,200}$/.test(entry.id) || seen.has(entry.id)) continue
    seen.add(entry.id)
    const key: ModelKey = { provider: 'openrouter', model: entry.id }
    const add = (field: RegistryField, value: RegistryValue): void => { if (value !== null) observations.push({ key, field, value, source: SOURCE, observedAt: fetchedAt }) }
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : entry.id
    const parameters = strings(entry.supported_parameters)
    const expires = typeof entry.expiration_date === 'string' && Number.isFinite(Date.parse(entry.expiration_date)) ? new Date(entry.expiration_date).toISOString() : null
    add('displayName', name)
    add('family', openRouterFamily(entry.id, name))
    add('releasedAt', typeof entry.created === 'number' && entry.created > 0 ? new Date(entry.created * 1000).toISOString() : null)
    add('deprecatedAt', expires)
    add('contextTokens', count(entry.context_length) ?? count(entry.top_provider?.context_length))
    add('maxOutputTokens', count(entry.top_provider?.max_completion_tokens))
    add('priceInputPerMTok', perMTok(entry.pricing?.prompt))
    add('priceOutputPerMTok', perMTok(entry.pricing?.completion))
    add('priceCachedInputPerMTok', perMTok(entry.pricing?.input_cache_read))
    add('modalities', strings(entry.architecture?.input_modalities))
    add('toolUse', parameters.includes('tools'))
    add('capabilities', parameters.filter(parameter => CAPABILITY_PARAMETERS.has(parameter)))
    add('availability', expires ? 'deprecated' : 'available')
  }
  if (!seen.size) throw new Error('OpenRouter listed no models')
  return { source: SOURCE, fetchedAt, observations, benchmarks: [], complete: true }
}

async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new Error('OpenRouter response exceeded 32 MB')
  if (!response.body) return await response.text()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Error('OpenRouter response exceeded 32 MB') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One GET of the public model list (no credentials), conditional when a cache is given, bounded
 *  by the timeout for headers and body together. Throws on any failure: a failing source
 *  produces no batch. */
export async function fetchBatch(ports: OpenRouterPorts = {}): Promise<IngestionBatch> {
  const fetcher = ports.fetch ?? fetch
  const cached = ports.cache?.read() ?? null
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'conductor-model-intelligence' }
  if (cached?.etag) headers['if-none-match'] = cached.etag
  if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified
  const signal = AbortSignal.timeout(ports.timeoutMs ?? OPENROUTER_TIMEOUT_MS)
  const fetchedAt = (ports.now?.() ?? new Date()).toISOString()
  let response: Response
  try {
    response = await fetcher(OPENROUTER_MODELS_URL, { method: 'GET', headers, credentials: 'omit', redirect: 'follow', signal })
  } catch (error) {
    throw new Error(`OpenRouter fetch failed: ${(error as Error)?.name === 'TimeoutError' ? `timed out after ${ports.timeoutMs ?? OPENROUTER_TIMEOUT_MS} ms` : (error as Error)?.message ?? String(error)}`)
  }
  if (response.status === 304 && cached) {
    await response.body?.cancel().catch(() => {})
    return mapOpenRouter(JSON.parse(cached.body), fetchedAt)
  }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`OpenRouter answered HTTP ${response.status}`) }
  const body = await boundedText(response)
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { throw new Error('OpenRouter answered with invalid JSON') }
  const batch = mapOpenRouter(parsed, fetchedAt)
  try { ports.cache?.write({ etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), body, fetchedAt }) } catch { /* a cache that cannot be written only costs the next conditional GET */ }
  return batch
}
