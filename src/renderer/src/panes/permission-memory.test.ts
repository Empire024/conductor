import { describe, expect, it } from 'vitest'
import type { ProviderCapabilities } from '../../../shared/structured-agent'
import { initialPermission, rememberPermission, rememberedPermission, type PermissionStore } from './permission-memory'

function box(seed?: string): PermissionStore & { read(): string | null } {
  let value = seed ?? null
  return { getItem: () => value, setItem: (_key, next) => { value = next }, read: () => value }
}
const claude = (permissions: ProviderCapabilities['permissions']): ProviderCapabilities => ({
  provider: 'claude', runtimeVersion: 'synthetic-offline', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: false,
  toolInputStreaming: false, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: true, plans: true,
  permissions, effort: [], models: [], limitations: []
})

describe('remembered conversation permission', () => {
  it('pre-selects the last chosen mode for the next session of the same provider', () => {
    const disk = box()
    expect(initialPermission('claude', disk)).toBe('default')
    rememberPermission('claude', 'auto', claude(['default', 'auto', 'accept-edits']), disk)
    expect(rememberedPermission('claude', disk)).toBe('auto')
    expect(initialPermission('claude', disk)).toBe('auto')
    rememberPermission('claude', 'accept-edits', claude(['default', 'auto', 'accept-edits']), disk)
    expect(initialPermission('claude', disk)).toBe('accept-edits')
  })
  it('keeps providers independent instead of leaking one adapter choice into another', () => {
    const disk = box()
    rememberPermission('claude', 'auto', claude(['default', 'auto']), disk)
    expect(initialPermission('codex', disk)).toBe('default')
    rememberPermission('codex', 'read-only', undefined, disk)
    expect(initialPermission('codex', disk)).toBe('read-only')
    expect(initialPermission('claude', disk)).toBe('auto')
  })
  it('refuses to remember a mode the provider never offered, so the next session cannot be rejected on submit', () => {
    const disk = box()
    rememberPermission('claude', 'auto', claude(['default', 'accept-edits']), disk)
    expect(rememberedPermission('claude', disk)).toBeUndefined()
    expect(initialPermission('claude', disk)).toBe('default')
  })
  it('ignores capabilities reported by a different provider', () => {
    const disk = box()
    rememberPermission('codex', 'auto', claude(['default', 'auto']), disk)
    expect(rememberedPermission('codex', disk)).toBeUndefined()
  })
  it('only stores real permission values, never a plan toggle or junk', () => {
    const disk = box()
    for (const value of [undefined, null, '', 'plan', 'Auto', 42, { permission: 'auto' }]) rememberPermission('claude', value, undefined, disk)
    expect(disk.read()).toBeNull()
    expect(initialPermission('claude', disk)).toBe('default')
  })
  it('falls back to Ask on a missing, corrupt or non-object store without throwing', () => {
    expect(initialPermission('claude', box('not json at all'))).toBe('default')
    expect(initialPermission('claude', box('["auto"]'))).toBe('default')
    expect(initialPermission('claude', box('{"claude":"nonsense"}'))).toBe('default')
    expect(initialPermission('claude', box('null'))).toBe('default')
    expect(initialPermission('claude', undefined)).toBe('default')
    expect(rememberedPermission('claude', undefined)).toBeUndefined()
  })
  it('survives a blocked or full store instead of breaking the mode picker', () => {
    const blocked: PermissionStore = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
    expect(() => rememberPermission('claude', 'auto', undefined, blocked)).not.toThrow()
    expect(initialPermission('claude', blocked)).toBe('default')
    expect(() => rememberPermission('claude', 'auto', undefined, undefined)).not.toThrow()
  })
  it('preserves the other provider entry when overwriting one', () => {
    const disk = box()
    rememberPermission('claude', 'auto', undefined, disk)
    rememberPermission('codex', 'read-only', undefined, disk)
    rememberPermission('claude', 'default', undefined, disk)
    expect(JSON.parse(disk.read() ?? '{}')).toEqual({ claude: 'default', codex: 'read-only' })
  })
})
