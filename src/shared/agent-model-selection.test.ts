import { describe, expect, it } from 'vitest'
import { CLAUDE_FALLBACK_MODEL, concreteModel, isFallbackModel } from './agent-model-selection'
import type { ProviderCapabilities } from './structured-agent'

describe('concrete conversation model', () => {
  it('chooses explicit defaults before connecting and preserves selected models', () => {
    expect(concreteModel('codex', 'default')).toBe('gpt-6-astra')
    // The Claude account default resolves to Opus with the 1M window, and `opus[1m]` is the only
    // Opus entry the CLI advertises (2026-09-21); a bare `opus` is not in its picker.
    expect(concreteModel('claude', 'auto')).toBe('opus[1m]')
    expect(CLAUDE_FALLBACK_MODEL).toBe('opus[1m]')
    expect(concreteModel('codex', 'custom')).toBe('custom')
  })
  it('respects native identity and discovered defaults, excluding account aliases', () => {
    const capabilities = { models: [{ id: 'default', isDefault: true }, { id: 'first' }, { id: 'recommended', isDefault: true }], effectiveSettings: { model: 'native' } } as unknown as ProviderCapabilities
    expect(concreteModel('codex', undefined, capabilities)).toBe('native')
    capabilities.effectiveSettings = { model: 'default' }
    expect(concreteModel('codex', undefined, capabilities)).toBe('recommended')
    expect(concreteModel('codex', 'selected', capabilities)).toBe('selected')
  })
  it('recognises the Claude stand-in so the composer can call it the account default', () => {
    expect(isFallbackModel('claude', 'opus[1m]')).toBe(true)
    expect(isFallbackModel('claude', 'sonnet')).toBe(false)
    expect(isFallbackModel('codex', 'gpt-6-astra')).toBe(false)
  })
})
