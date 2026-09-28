import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchBatch, fileCache, mapOpenRouter, OPENROUTER_MODELS_URL, openRouterFamily } from './openrouter'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** Shaped like a real /api/v1/models entry (2026), trimmed to the fields the mapper reads plus noise. */
const BODY = {
  data: [
    {
      id: 'anthropic/claude-opus-5.5', canonical_slug: 'anthropic/claude-opus-5.5-20260801', name: 'Anthropic: Claude Opus 5.5', created: 1785542400, description: 'Frontier model',
      context_length: 1000000, architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'file'], output_modalities: ['text'], tokenizer: 'Claude' },
      pricing: { prompt: '0.000005', completion: '0.000025', request: '0', image: '0', input_cache_read: '0.0000005', input_cache_write: '0.00000625' },
      top_provider: { context_length: 1000000, max_completion_tokens: 128000, is_moderated: true },
      supported_parameters: ['include_reasoning', 'max_tokens', 'reasoning', 'response_format', 'stop', 'structured_outputs', 'temperature', 'tool_choice', 'tools']
    },
    {
      id: 'qwen/qwen3.6-35b-a3b:free', name: 'Qwen: Qwen3.6 35B A3B (free)', created: 1780000000, context_length: 262144,
      architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, top_provider: { context_length: 262144, max_completion_tokens: null }, supported_parameters: ['max_tokens']
    },
    { id: 'openrouter/auto', name: 'Auto Router', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' }, supported_parameters: ['tools'], expiration_date: null },
    { id: 'openai/gpt-4o-2024-05-13', name: 'OpenAI: GPT-4o (2024-05-13)', context_length: 128000, pricing: { prompt: '0.000005', completion: '0.000015' }, expiration_date: '2026-11-01' },
    { name: 'no id' },
    { id: 'anthropic/claude-opus-5.5', name: 'duplicate' }
  ]
}
const AT = '2026-09-28T00:00:00.000Z'

const response = (status: number, body: string, headers: Record<string, string> = {}): Response => new Response(status === 304 ? null : body, { status, headers })

describe('OpenRouter source', () => {
  it('maps per-token prices to per-MTok, context, tools and family under provider openrouter', () => {
    const batch = mapOpenRouter(BODY, AT)
    expect(batch).toMatchObject({ source: { kind: 'aggregator', name: 'openrouter', url: OPENROUTER_MODELS_URL }, complete: true, benchmarks: [] })
    const facts = (model: string) => Object.fromEntries(batch.observations.filter(entry => entry.key.model === model).map(entry => [entry.field, entry.value]))
    expect(new Set(batch.observations.map(entry => entry.key.provider))).toEqual(new Set(['openrouter']))
    expect(facts('anthropic/claude-opus-5.5')).toEqual({
      displayName: 'Anthropic: Claude Opus 5.5', family: 'claude-opus-5.5', releasedAt: '2026-08-01T00:00:00.000Z', contextTokens: 1_000_000, maxOutputTokens: 128_000,
      priceInputPerMTok: 5, priceOutputPerMTok: 25, priceCachedInputPerMTok: 0.5, modalities: ['file', 'image', 'text'], toolUse: true,
      capabilities: ['reasoning', 'response_format', 'structured_outputs', 'tool_choice', 'tools'], availability: 'available'
    })
    expect(facts('qwen/qwen3.6-35b-a3b:free')).toMatchObject({ family: 'qwen3.6-35b-a3b', priceInputPerMTok: 0, priceOutputPerMTok: 0, toolUse: false, contextTokens: 262_144 })
    expect(facts('qwen/qwen3.6-35b-a3b:free').maxOutputTokens).toBeUndefined()
    expect(facts('openrouter/auto').priceInputPerMTok).toBeUndefined()
    expect(facts('openai/gpt-4o-2024-05-13')).toMatchObject({ family: 'gpt-4o', deprecatedAt: '2026-11-01T00:00:00.000Z', availability: 'deprecated' })
    expect(new Set(batch.observations.map(entry => entry.key.model)).size).toBe(4)
    expect(facts('anthropic/claude-opus-5.5').displayName).not.toBe('duplicate')
  })

  it('maps family names so priors can reach the first-party keys', () => {
    expect(openRouterFamily('anthropic/claude-opus-5.5')).toBe('claude-opus-5.5')
    expect(openRouterFamily('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4.5')
    expect(openRouterFamily('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(openRouterFamily('x-ai/grok-4.7')).toBe('grok-4.7')
    expect(openRouterFamily('qwen/qwen3.5-9b:free')).toBe('qwen3.5-9b')
  })

  it('rejects a body without models', () => {
    expect(() => mapOpenRouter({ error: 'nope' }, AT)).toThrow(/data list/)
    expect(() => mapOpenRouter({ data: [{ name: 'x' }] }, AT)).toThrow(/no models/)
  })

  it('fetches through the injected fetch, and fails on HTTP errors, bad JSON and the timeout', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const ok = await fetchBatch({ fetch: async (url, init) => { calls.push({ url: String(url), init: init! }); return response(200, JSON.stringify(BODY)) }, now: () => new Date(AT) })
    expect(ok.fetchedAt).toBe(AT)
    expect(calls[0]).toMatchObject({ url: OPENROUTER_MODELS_URL, init: { method: 'GET', credentials: 'omit' } })
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
    await expect(fetchBatch({ fetch: async () => response(503, 'down') })).rejects.toThrow(/HTTP 503/)
    await expect(fetchBatch({ fetch: async () => response(200, '<html>') })).rejects.toThrow(/invalid JSON/)
    await expect(fetchBatch({ fetch: async () => { throw new TypeError('fetch failed') } })).rejects.toThrow(/fetch failed/)
    const hanging = (_url: unknown, init?: RequestInit): Promise<Response> => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
    await expect(fetchBatch({ fetch: hanging as typeof fetch, timeoutMs: 30 })).rejects.toThrow(/timed out after 30 ms/)
  })

  it('makes a conditional GET from the cache and maps the cached body on 304', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-intel-openrouter-'))
    dirs.push(dir)
    const cache = fileCache(join(dir, 'model-intelligence', 'openrouter-models.json'))
    expect(cache.read()).toBeNull()
    await fetchBatch({ cache, fetch: async () => response(200, JSON.stringify(BODY), { etag: '"v1"', 'last-modified': 'Mon, 28 Sep 2026 00:00:00 GMT' }) })
    expect(cache.read()).toMatchObject({ etag: '"v1"', lastModified: 'Mon, 28 Sep 2026 00:00:00 GMT' })
    let headers: Record<string, string> = {}
    const again = await fetchBatch({ cache, fetch: async (_url, init) => { headers = init!.headers as Record<string, string>; return response(304, '') } })
    expect(headers).toMatchObject({ 'if-none-match': '"v1"', 'if-modified-since': 'Mon, 28 Sep 2026 00:00:00 GMT' })
    expect(again.observations.length).toBe(mapOpenRouter(BODY, AT).observations.length)
  })
})
