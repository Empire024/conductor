import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '../../shared/model-upgrades'
import { betterModels, freshestCatalog, modelLine } from './better'

const model = (id: string, extra: Partial<CatalogModel> = {}): CatalogModel => ({ id, displayName: extra.displayName ?? id, hidden: false, isDefault: false, ...extra })

describe('modelLine', () => {
  it('reads series, version and tier from Codex and Claude ids', () => {
    expect(modelLine('gpt-6.1-sol')).toEqual({ series: 'gpt', version: [6, 1], tier: 'sol' })
    expect(modelLine('gpt-6-astra')).toEqual({ series: 'gpt', version: [6], tier: 'astra' })
    expect(modelLine('claude-opus-5-5')).toEqual({ series: 'claude', version: [5, 5], tier: 'opus' })
    expect(modelLine('opus[1m]', 'Claude Opus 5.5 (1M context)')).toEqual({ series: 'claude', version: [5, 5], tier: 'opus' })
    expect(modelLine('sonnet')).toBeNull()
  })
})

describe('betterModels', () => {
  const astraCatalog = [model('gpt-6-astra', { displayName: 'GPT-6-Astra', isDefault: true }), model('gpt-5.6-sol'), model('gpt-5.6-luna')]

  it('finds GPT-6.1 Sol when the newer catalog makes it the default in Astra\'s place', () => {
    const next = [model('gpt-6.1-sol', { displayName: 'GPT-6.1-Sol', isDefault: true }), model('gpt-6-astra', { displayName: 'GPT-6-Astra' }), model('gpt-5.6-sol'), model('gpt-5.6-luna')]
    const found = betterModels('codex', astraCatalog, next, ['gpt-6-astra'])
    expect(found.map(entry => entry.model.id)).toEqual(['gpt-6.1-sol'])
    expect(found[0]!.replaces.id).toBe('gpt-6-astra')
    expect(found[0]!.reasons.map(reason => reason.kind)).toContain('catalog-default')
  })

  it('trusts the catalog\'s own upgrade marker and a previous-generation description', () => {
    const next = [model('gpt-7-astra'), model('gpt-6-astra', { upgrade: 'gpt-7-astra', description: 'Previous generation frontier model' })]
    const found = betterModels('codex', astraCatalog, next, ['gpt-6-astra'])
    expect(found[0]!.model.id).toBe('gpt-7-astra')
    expect(found[0]!.reasons.map(reason => reason.kind).sort()).toEqual(['catalog-upgrade', 'newer-version', 'previous-generation'])
  })

  it('finds a higher version of the same tier (Opus 5.5 → 5.6) and ignores lower tiers', () => {
    const before = [model('opus[1m]', { displayName: 'Claude Opus 5.5 (1M context)' }), model('sonnet', { displayName: 'Claude Sonnet 5' })]
    const after = [...before, model('claude-opus-5-6', { displayName: 'Claude Opus 5.6' }), model('claude-haiku-5', { displayName: 'Claude Haiku 5' })]
    const found = betterModels('claude', before, after, ['opus[1m]'])
    expect(found.map(entry => entry.model.id)).toEqual(['claude-opus-5-6'])
    expect(found[0]!.reasons[0]?.kind).toBe('newer-version')
  })

  it('offers nothing for a new model that is not above a pick, a hidden one, or a declined one', () => {
    const after = [...astraCatalog, model('gpt-6.1-luna'), model('gpt-7-astra', { hidden: true })]
    expect(betterModels('codex', astraCatalog, after, ['gpt-6-astra'])).toEqual([])
    const withNew = [...astraCatalog, model('gpt-7-astra')]
    expect(betterModels('codex', astraCatalog, withNew, ['gpt-6-astra'], new Set(['gpt-7-astra']))).toEqual([])
  })

  it('does not re-offer a model that was already in the catalog', () => {
    expect(betterModels('codex', astraCatalog, astraCatalog, ['gpt-6-astra'])).toEqual([])
  })
})

describe('freshestCatalog', () => {
  it('takes the newest runtime, not the first tab, and a tab over a probe of the same version', () => {
    const stale = { version: '0.155.1', models: [{ id: 'gpt-6-astra' }], from: 'old tab' }
    const probe = { version: '0.159.1', models: [{ id: 'gpt-6.1-sol' }], from: 'probe' }
    const tab = { version: 'codex-cli 0.159.1', models: [{ id: 'gpt-6.1-sol' }], from: 'new tab' }
    expect(freshestCatalog([stale, probe])?.from).toBe('probe')
    expect(freshestCatalog([stale, tab, probe])?.from).toBe('new tab')
    expect(freshestCatalog([{ version: '9.9.9', models: [], from: 'empty' }, stale])?.from).toBe('old tab')
    expect(freshestCatalog([])).toBeUndefined()
  })
})
