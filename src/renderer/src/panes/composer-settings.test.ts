import { describe, expect, it } from 'vitest'
import { composerChildKey, composerSendBlock, modelDisplayName, nextComposerSettings, promptCharacterCount, resolvedComposerSettings } from './composer-settings'
import { MAX_PROMPT_CHARS } from '../../../shared/structured-agent'
import type { ProviderCapabilities, SessionSettings } from '../../../shared/structured-agent'
const settings = (model: string): SessionSettings => ({ permission: 'default', plan: false, model })
const capabilities = (model: string, effort: string): ProviderCapabilities => ({ provider: 'claude', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }], effectiveSettings: { model, effort } } as unknown as ProviderCapabilities)
describe('resolved composer settings', () => {
  it('uses the effective effort when Claude resolves a configured alias to its concrete model', () => {
    // The saved alias is what the catalog names; the runtime's resolved name is offered for the tooltip.
    expect(resolvedComposerSettings(settings('opus'), capabilities('claude-opus-4-6', 'high'))).toEqual({ model: 'opus', label: 'Opus', effort: 'high', resolvedModel: 'claude-opus-4-6' })
  })
  it('does not carry effort from a different effective model into a new selection', () => {
    expect(resolvedComposerSettings(settings('sonnet'), capabilities('claude-opus-4-6', 'high')).effort).toBeUndefined()
    expect(resolvedComposerSettings({ ...settings('opus'), effort: 'low' }, capabilities('claude-opus-4-6', 'high')).effort).toBe('low')
  })
  it('labels a resolved alias by its catalog entry instead of the raw runtime id (live turns 3 and 4 of the 2026-09-21 sweep)', () => {
    const live = { provider: 'claude', models: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }, { id: 'opus[1m]', label: 'Opus (1M context)' }] } as unknown as ProviderCapabilities
    expect(resolvedComposerSettings(settings('sonnet'), { ...live, effectiveSettings: { model: 'claude-sonnet-5', effort: 'low' } })).toEqual({ model: 'sonnet', label: 'Sonnet', effort: 'low', resolvedModel: 'claude-sonnet-5' })
    expect(resolvedComposerSettings(settings('haiku'), { ...live, effectiveSettings: { model: 'claude-haiku-4-5-20251001', effort: null } })).toEqual({ model: 'haiku', label: 'Haiku', resolvedModel: 'claude-haiku-4-5-20251001' })
    expect(resolvedComposerSettings(settings('opus[1m]'), { ...live, effectiveSettings: { model: 'claude-opus-5', effort: 'low' } })).toEqual({ model: 'opus[1m]', label: 'Opus (1M context)', effort: 'low', resolvedModel: 'claude-opus-5' })
  })
  it('calls the pre-discovery Claude stand-in "Account default" and a discovered or chosen model by its name', () => {
    const undiscovered = { provider: 'claude', models: [], effort: ['low', 'medium', 'high', 'xhigh', 'max'] } as unknown as ProviderCapabilities
    expect(resolvedComposerSettings({ permission: 'default', plan: false }, undiscovered)).toEqual({ model: 'opus[1m]', label: 'Account default' })
    expect(resolvedComposerSettings(settings('opus[1m]'), undiscovered).label).toBe('Account default')
    expect(resolvedComposerSettings(settings('sonnet'), undiscovered).label).toBe('sonnet')
    expect(resolvedComposerSettings({ permission: 'default', plan: false }, { ...undiscovered, effectiveSettings: { model: 'claude-opus-5[1m]' } }).label).toBe('claude-opus-5[1m]')
    expect(resolvedComposerSettings({ permission: 'default', plan: false }, undefined)).toEqual({ model: 'gpt-6-astra', label: 'GPT-6-Astra' })
    // Before the pane has any capabilities the provider is unknown here; the stand-in id is Claude's alone.
    expect(resolvedComposerSettings(settings('opus[1m]'), undefined)).toEqual({ model: 'opus[1m]', label: 'Account default' })
  })
})

describe('model display names', () => {
  it('formats a bare Codex id the way the CLI displays it and leaves CLI labels and other ids verbatim', () => {
    expect(modelDisplayName('gpt-6-astra')).toBe('GPT-6-Astra')
    expect(modelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6-Sol')
    expect(modelDisplayName('gpt-5.5')).toBe('GPT-5.5')
    expect(modelDisplayName('GPT-6-Astra')).toBe('GPT-6-Astra')
    expect(modelDisplayName('GPT 6 Astra')).toBe('GPT 6 Astra')
    expect(modelDisplayName('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(modelDisplayName('Qwen 3.5 9B')).toBe('Qwen 3.5 9B')
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

describe('composer send blocking', () => {
  it('blocks an empty or whitespace-only draft even when attachments are present', () => {
    expect(composerSendBlock('', [])).toBe('empty')
    expect(composerSendBlock('   \n\t  ', [])).toBe('empty')
    expect(composerSendBlock('   ', [{ content: 'x'.repeat(500) }])).toBe('empty')
  })
  it('allows an ordinary short draft', () => {
    expect(composerSendBlock('Fix the bug', [])).toBeUndefined()
  })
  it('blocks once the draft plus attachment content crosses the true prompt ceiling', () => {
    const huge = [{ content: 'x'.repeat(MAX_PROMPT_CHARS + 1) }]
    expect(composerSendBlock('short draft', huge)).toBe('oversized')
    expect(promptCharacterCount('short draft', huge)).toBe('short draft'.length + MAX_PROMPT_CHARS + 1)
  })
  it('counts a short draft with no attachments as just its trimmed length', () => {
    expect(promptCharacterCount('  hello  ', [])).toBe(5)
    expect(promptCharacterCount('  hello  ', [{ content: undefined }])).toBe(5)
  })
  it('stays within the limit right at the boundary', () => {
    expect(composerSendBlock('a'.repeat(MAX_PROMPT_CHARS), [])).toBeUndefined()
    expect(composerSendBlock('a'.repeat(MAX_PROMPT_CHARS + 1), [])).toBe('oversized')
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
