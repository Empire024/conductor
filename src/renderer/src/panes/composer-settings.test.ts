import { describe, expect, it } from 'vitest'
import { composerChildKey, nextComposerSettings, resolvedComposerSettings } from './composer-settings'
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

describe('composer setting changes', () => {
  it('keeps the rest of the conversation settings when only the effort changes', () => {
    const current: SessionSettings = { permission: 'accept-edits', plan: false, model: 'opus', effort: 'low', sandbox: 'workspace-write' }
    expect(nextComposerSettings(current, { effort: 'high' })).toEqual({ ...current, effort: 'high' })
  })
  it('drops a runtime-scoped permission grant once the mode itself is chosen again', () => {
    const granted: SessionSettings = { permission: 'accept-edits', plan: false, temporaryPermission: { runtimeId: 'runtime-1', restore: 'default' } }
    expect(nextComposerSettings(granted, { permission: 'auto', plan: false })).toEqual({ permission: 'auto', plan: false })
    expect(nextComposerSettings(granted, { effort: 'high' })).toEqual({ ...granted, effort: 'high' })
  })
})

describe('composer child keys', () => {
  // React keeps only the last of same-keyed siblings and orphans the DOM of the others, which
  // showed up as a second ask/model/effort row after switching conversation.
  it('gives each remounting composer child its own key for the same conversation', () => {
    const keys = ['images', 'controls', 'usage'].map(child => composerChildKey(child, 'agent-1'))
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('changes every child key when the conversation changes', () => {
    expect(composerChildKey('controls', 'agent-1')).not.toBe(composerChildKey('controls', 'agent-2'))
  })
})
