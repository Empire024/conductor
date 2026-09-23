import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeLocalContext } from './local'

afterEach(() => vi.unstubAllGlobals())
describe('local endpoint context metadata', () => {
  it('uses runtime n_ctx, preserves the configured ceiling and probes only authenticated metadata', async () => {
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      expect(options.headers).toEqual({ Authorization: 'Bearer fixture' })
      expect(options.method).toBeUndefined()
      return new Response(JSON.stringify(url.endsWith('/props')
        ? { default_generation_settings: { n_ctx: 8192 }, chat_template: 'fixture', chat_template_caps: { supports_tool_calls: true, supports_tools: true } }
        : { data: [{ id: 'model', meta: { n_ctx_train: 131072 } }] }))
    })
    vi.stubGlobal('fetch', fetch)
    const result = await probeLocalContext('http://127.0.0.1:1234/', 'fixture', 'model', 32768)
    expect(result.effectiveTokens).toBe(8192)
    expect(result.serverTokens).toBe(8192)
    expect(result.propsProbed).toBe(true)
    expect(result.template).toEqual({ available: true, toolCalls: 'supported', thinking: 'unspecified', capabilities: { supports_tools: true, supports_tool_calls: true } })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:1234/props', 'http://127.0.0.1:1234/v1/models'])
    expect((await probeLocalContext('http://127.0.0.1:1234', 'fixture', 'model', 4096)).effectiveTokens).toBe(4096)
  })
  it('does not mistake training context or another model for the live capacity', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/props') ? {} : { data: [{ id: 'model', meta: { n_ctx_train: 131072 } }, { id: 'other', n_ctx: 2048 }] }))))
    const result = await probeLocalContext('http://127.0.0.1:1234', 'key', 'model', 32768)
    expect(result.serverTokens).toBeUndefined()
    expect(result.effectiveTokens).toBe(32768)
    expect(result.diagnostics.join(' ')).toContain('unverified')
  })
  it('reports missing metadata and explicit template incompatibility without assuming reasoning mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/props') ? new Response(JSON.stringify({ n_ctx: 16384, chat_template_caps: { supports_tool_calls: false } })) : new Response('{}', { status: 503 })))
    const result = await probeLocalContext('http://127.0.0.1:1234', 'key', 'model', 32768)
    expect(result.effectiveTokens).toBe(16384)
    expect(result.template.toolCalls).toBe('unsupported')
    expect(result.diagnostics).toContain('/v1/models: HTTP 503')
    expect(result.template.thinking).toBe('unspecified')
  })
  it('enables exact request measurement only after valid props metadata, not models alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/props') ? new Response('[]') : new Response(JSON.stringify({ data: [{ id: 'model', meta: { n_ctx: 8192 } }] }))))
    const result = await probeLocalContext('http://127.0.0.1:1234', 'key', 'model', 32768)
    expect(result.propsProbed).toBe(false)
    expect(result.effectiveTokens).toBe(8192)
    expect(result.diagnostics).toContain('/props: malformed metadata')
  })
})
