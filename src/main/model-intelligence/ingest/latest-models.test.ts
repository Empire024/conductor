import { describe, expect, it } from 'vitest'
import { fetchBatches, parseCliCatalogs, parsePrimarySources } from './latest-models'

const AT = '2026-09-28T03:00:00.000Z'

/** cli-catalogs.mjs stdout: sorted keys, the fields it keeps (claude from initialize.models, codex from model/list). */
const CLI_CATALOGS = JSON.stringify({
  claude: {
    missingFlags: [], version: '2.1.278',
    models: [
      { description: 'Opus 5.5 with 1M context', displayName: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true, resolvedModel: 'claude-opus-5-5[1m]', supportsEffort: true, value: 'default' },
      { description: 'Fable 5.1', displayName: 'Fable', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: false, resolvedModel: 'claude-fable-5-1', supportsEffort: true, value: 'claude-fable-5-1' },
      { description: 'Haiku 4.5', displayName: 'Haiku', efforts: [], isDefault: false, resolvedModel: 'claude-haiku-4-5-20251001', supportsEffort: false, value: 'haiku' },
      { description: 'Opus 5.5 with 1M context', displayName: 'Opus (1M context)', efforts: ['low', 'high'], isDefault: false, resolvedModel: 'claude-opus-5-5[1m]', supportsEffort: true, value: 'opus[1m]' }
    ]
  },
  codex: {
    version: '0.153.4',
    models: [
      { defaultEffort: 'medium', description: 'Retiring', displayName: 'GPT-5.5', efforts: ['low', 'medium', 'high'], hidden: false, id: 'gpt-5.5', isDefault: false, retirementAt: '2026-10-14T00:00:00Z', upgrade: 'gpt-5.6-sol' },
      { defaultEffort: 'high', description: 'Frontier', displayName: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], hidden: false, id: 'gpt-6-astra', isDefault: true, retirementAt: null, upgrade: null },
      { defaultEffort: 'low', description: 'Internal', displayName: 'Codex Mini', efforts: ['low'], hidden: true, id: 'codex-mini-2', isDefault: false, retirementAt: null, upgrade: null }
    ]
  }
}, null, 2)

const PRIMARY = JSON.stringify({
  sources: {
    'anthropic-models': { modelIds: ['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-opus-5-5'] },
    'llama-cpp-release': { tagName: 'b9123' },
    'openai-models': { modelIds: ['gpt-5.6-sol', 'gpt-6-astra'], stale: true },
    'qwen-3.5-9b-metadata': { unavailable: true }
  }
})

const facts = (batches: ReturnType<typeof parseCliCatalogs>, provider: string, model: string) =>
  Object.fromEntries(batches.flatMap(batch => batch.observations).filter(entry => entry.key.provider === provider && entry.key.model === model).map(entry => [entry.field, entry.value]))

describe('latest-models source', () => {
  it('maps each answering CLI catalog to a complete cli batch', () => {
    const batches = parseCliCatalogs(CLI_CATALOGS, AT)
    expect(batches.map(batch => [batch.source.name, batch.source.kind, batch.complete])).toEqual([['latest-models:cli-catalogs:claude', 'cli', true], ['latest-models:cli-catalogs:codex', 'cli', true]])
    expect(facts(batches, 'claude', 'default')).toEqual({})
    expect(facts(batches, 'claude', 'opus[1m]')).toEqual({ displayName: 'Opus (1M context)', family: 'claude-opus-5.5', efforts: ['low', 'high'], availability: 'available' })
    expect(facts(batches, 'claude', 'haiku')).toMatchObject({ family: 'claude-haiku-4.5', efforts: [] })
    expect(facts(batches, 'codex', 'gpt-5.5')).toMatchObject({ deprecatedAt: '2026-10-14T00:00:00.000Z', availability: 'deprecated' })
    expect(facts(batches, 'codex', 'codex-mini-2')).toMatchObject({ availability: 'limited' })
    expect(facts(batches, 'codex', 'gpt-6-astra').efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  it('yields nothing for a CLI that reported an error, so it cannot read as every model removed', () => {
    const batches = parseCliCatalogs(JSON.stringify({ claude: { error: 'Claude Code executable not found' }, codex: { version: '0.153.4', error: 'app-server model/list timed out after 60 s' } }), AT)
    expect(batches).toEqual([])
  })

  it('keys primary-source ids under the creator API provider; only a fresh page is complete', () => {
    const batches = parsePrimarySources(PRIMARY, AT)
    expect(batches.map(batch => [batch.source.name, batch.source.kind, batch.complete])).toEqual([
      ['latest-models:primary-sources:anthropic-models', 'provider-docs', true], ['latest-models:primary-sources:openai-models', 'provider-docs', false]
    ])
    expect(facts(batches, 'anthropic', 'claude-opus-5-5')).toEqual({ family: 'claude-opus-5.5', availability: 'available' })
    expect(facts(batches, 'openai', 'gpt-6-astra')).toEqual({ family: 'gpt-6-astra', availability: 'available' })
  })

  it('parses each script output on its own and reports the unreadable one', async () => {
    const result = await fetchBatches({ outputs: () => ({ cliCatalogs: { stdout: '{"claude": {"models": [', at: AT }, primarySources: { stdout: PRIMARY, at: AT } }) })
    expect(result.batches.map(batch => batch.source.name)).toEqual(['latest-models:primary-sources:anthropic-models', 'latest-models:primary-sources:openai-models'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^cli-catalogs: /)
    expect((await fetchBatches({ outputs: () => ({ cliCatalogs: null, primarySources: { stdout: PRIMARY, at: 'never' } }) })).errors).toEqual(['primary-sources: output has no valid timestamp'])
  })
})
