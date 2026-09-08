import { describe, expect, it } from 'vitest'
import { concreteModel } from './agent-model-selection'
import type { ProviderCapabilities } from './structured-agent'

describe('concrete conversation model', () => {
  it('chooses explicit defaults before connecting and preserves selected models', () => {
    expect(concreteModel('codex', 'default')).toBe('gpt-6-astra')
    expect(concreteModel('claude', 'auto')).toBe('opus')
    expect(concreteModel('codex', 'custom')).toBe('custom')
  })
  it('respects native identity and discovered defaults, excluding account aliases', () => {
    const capabilities = { models: [{ id: 'default', isDefault: true }, { id: 'first' }, { id: 'recommended', isDefault: true }], effectiveSettings: { model: 'native' } } as unknown as ProviderCapabilities
    expect(concreteModel('codex', undefined, capabilities)).toBe('native')
    capabilities.effectiveSettings = { model: 'default' }
    expect(concreteModel('codex', undefined, capabilities)).toBe('recommended')
    expect(concreteModel('codex', 'selected', capabilities)).toBe('selected')
  })
})
