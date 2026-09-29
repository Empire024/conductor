import { afterEach, describe, expect, it } from 'vitest'
import { concreteModel } from './agent-model-selection'
import { capabilityRank } from './model-routing'
import { setPromotedModels } from './promoted-models'
import { isFrontierModel } from './structured-agent'

describe('promoted models', () => {
  afterEach(() => setPromotedModels({}))

  it('puts an accepted upgrade where the model it replaced was: rank, wizard eligibility and default', () => {
    expect(capabilityRank('codex', 'gpt-7-sol')).toBe(1)
    expect(isFrontierModel('codex', 'gpt-7-sol')).toBe(false)
    setPromotedModels({ codex: { model: 'gpt-7-sol', replaces: 'gpt-6.1-sol', rank: 3, frontier: true, at: '2026-10-01T00:00:00Z' } })
    expect(capabilityRank('codex', 'gpt-7-sol')).toBe(3)
    expect(isFrontierModel('codex', 'gpt-7-sol')).toBe(true)
    expect(concreteModel('codex')).toBe('gpt-7-sol')
    expect(concreteModel('codex', 'default', { models: [{ id: 'gpt-6.1-sol', label: 'Sol', isDefault: true }, { id: 'gpt-7-sol', label: 'Sol 7' }] } as never)).toBe('gpt-7-sol')
    // An explicit choice still wins, and a runtime that does not offer it keeps its own default.
    expect(concreteModel('codex', 'gpt-6-astra')).toBe('gpt-6-astra')
    expect(concreteModel('codex', undefined, { models: [{ id: 'gpt-6.1-sol', label: 'Sol', isDefault: true }] } as never)).toBe('gpt-6.1-sol')
    // Other providers are untouched.
    expect(capabilityRank('claude', 'gpt-7-sol')).toBe(1)
  })
})
