import { describe, expect, it } from 'vitest'
import { resolvedComposerSettings } from './composer-settings'
import type { ProviderCapabilities, SessionSettings } from '../../../shared/structured-agent'
const settings = (model: string): SessionSettings => ({ permission: 'default', plan: false, model })
const capabilities = (model: string, effort: string): ProviderCapabilities => ({ provider: 'claude', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }], effectiveSettings: { model, effort } } as unknown as ProviderCapabilities)
describe('resolved composer settings', () => {
  it('uses the effective effort when Claude resolves a configured alias to its concrete model', () => {
    expect(resolvedComposerSettings(settings('opus'), capabilities('claude-opus-4-6', 'high'))).toEqual({ model: 'opus', label: 'claude-opus-4-6', effort: 'high' })
  })
  it('does not carry effort from a different effective model into a new selection', () => {
    expect(resolvedComposerSettings(settings('sonnet'), capabilities('claude-opus-4-6', 'high')).effort).toBeUndefined()
    expect(resolvedComposerSettings({ ...settings('opus'), effort: 'low' }, capabilities('claude-opus-4-6', 'high')).effort).toBe('low')
  })
})
