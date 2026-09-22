import { describe, expect, it } from 'vitest'
import { documentedDefaultEffort, modelEfforts, resolveEffortChoice, supportedEffortChoices } from './model-effort'
import type { ProviderCapabilities } from './structured-agent'

/** The catalog Claude Code 2.1.278 advertised on 2026-09-21: effort ladders per model, but no
 *  `defaultEffort` on any entry (parity ledger R7). */
const claude = {
  provider: 'claude', effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  models: [
    { id: 'default', label: 'Default (recommended)', effort: ['low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
    { id: 'opus[1m]', label: 'Opus (1M context)', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'haiku', label: 'Haiku', effort: [] }
  ]
} as unknown as ProviderCapabilities
const codex = {
  provider: 'codex', effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', isDefault: true }]
} as unknown as ProviderCapabilities

describe('effort resolution (synthetic catalogs, zero inference)', () => {
  it('resolves to nothing when the catalog carries no default, instead of guessing medium', () => {
    const choices = supportedEffortChoices(claude, 'opus[1m]')
    expect(choices).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(modelEfforts(claude, 'opus[1m]')).not.toHaveProperty('defaultEffort')
    expect(resolveEffortChoice(choices, undefined)).toBeUndefined()
    expect(resolveEffortChoice(choices, 'auto')).toBeUndefined()
  })
  it('keeps the owner\'s saved effort when the model offers it', () => {
    expect(resolveEffortChoice(supportedEffortChoices(claude, 'opus[1m]'), 'xhigh')).toBe('xhigh')
  })
  it('uses a catalog default effort when the runtime reports one', () => {
    const info = codex.models.find(model => model.id === 'gpt-6-astra')
    expect(resolveEffortChoice(supportedEffortChoices(codex, 'gpt-6-astra'), info?.defaultEffort)).toBe('medium')
  })
  it('does not resolve an effort the model does not offer, or any effort for an effort-less model', () => {
    expect(resolveEffortChoice(supportedEffortChoices(claude, 'opus[1m]'), 'ultra')).toBeUndefined()
    expect(supportedEffortChoices(claude, 'haiku')).toEqual([])
    expect(resolveEffortChoice(supportedEffortChoices(claude, 'haiku'), 'high')).toBeUndefined()
  })
})

describe('documented default effort (display-only guess, never committed by resolveEffortChoice)', () => {
  it('names medium for a ladder that offers it, on either provider', () => {
    expect(documentedDefaultEffort(supportedEffortChoices(claude, 'opus[1m]'))).toBe('medium')
    expect(documentedDefaultEffort(supportedEffortChoices(codex, 'gpt-6-astra'))).toBe('medium')
  })
  it('falls to the middle of the ladder when medium is not offered', () => {
    expect(documentedDefaultEffort(['low', 'high'])).toBe('low')
    expect(documentedDefaultEffort(['high'])).toBe('high')
  })
  it('names nothing for an effort-less model', () => {
    expect(documentedDefaultEffort(supportedEffortChoices(claude, 'haiku'))).toBeUndefined()
    expect(documentedDefaultEffort([])).toBeUndefined()
  })
})
