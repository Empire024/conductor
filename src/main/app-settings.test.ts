import { describe, expect, it } from 'vitest'
import { normalizeNewFileExtension, normalizeThemeSettings, rememberBrowserTools, rememberedBrowserTools, rememberedPermission, rememberPermission } from './app-settings'
import type { ProviderCapabilities } from '../shared/structured-agent'

function fakeStore(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed))
  return { rows, getSetting: (key: string) => rows.get(key) ?? null, setSetting: (key: string, value: string) => { rows.set(key, value) } }
}
const claude = (permissions: ProviderCapabilities['permissions']): ProviderCapabilities => ({
  provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: false,
  toolInputStreaming: false, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: true, plans: true,
  permissions, effort: [], models: [], limitations: []
})

describe('theme settings migration', () => {
  it.each([
    ['light', { themeId: 'night-owl', themeVariant: 'day', themeAuto: false }],
    ['dark', { themeId: 'night-owl', themeVariant: 'night', themeAuto: false }],
    ['auto', { themeId: 'night-owl', themeVariant: 'night', themeAuto: true }]
  ] as const)('migrates the legacy %s mode', (legacyThemeMode, expected) => {
    expect(normalizeThemeSettings({
      themeId: null,
      themeVariant: null,
      themeAuto: null,
      legacyThemeMode
    })).toEqual(expected)
  })

  it('keeps valid family settings instead of consulting the legacy mode', () => {
    expect(normalizeThemeSettings({
      themeId: 'obsidian',
      themeVariant: 'day',
      themeAuto: 'false',
      legacyThemeMode: 'auto'
    })).toEqual({ themeId: 'obsidian', themeVariant: 'day', themeAuto: false })
  })
})

describe('new file extension settings', () => {
  it('normalizes conventional extensions and rejects paths or invalid suffixes', () => {
    expect(normalizeNewFileExtension(' .MD ')).toBe('md')
    expect(normalizeNewFileExtension('test.ts')).toBe('test.ts')
    for (const value of ['../ts', 'a/b', 'a\\b', '', '.', 'md.', '..md', 'a'.repeat(33), null]) expect(normalizeNewFileExtension(value)).toBeNull()
  })
})

describe('main-process remembered permission (mirrors renderer permission-memory.ts)', () => {
  it('remembers a mode the provider actually offers and replays it for that provider only', () => {
    const store = fakeStore()
    rememberPermission(store.setSetting, 'claude', 'auto', claude(['default', 'auto', 'accept-edits']))
    expect(rememberedPermission(store.getSetting, 'claude')).toBe('auto')
    expect(rememberedPermission(store.getSetting, 'codex')).toBeUndefined()
    expect(store.rows.get('rememberedPermission:codex')).toBeUndefined()
  })
  it('refuses to remember a mode the provider never offered', () => {
    const store = fakeStore()
    rememberPermission(store.setSetting, 'claude', 'auto', claude(['default', 'accept-edits']))
    expect(rememberedPermission(store.getSetting, 'claude')).toBeUndefined()
  })
  it('ignores capabilities reported by a different provider than the one being remembered', () => {
    const store = fakeStore()
    rememberPermission(store.setSetting, 'codex', 'auto', claude(['default', 'auto']))
    expect(rememberedPermission(store.getSetting, 'codex')).toBeUndefined()
  })
  it('never surfaces a stored value that is not one of the real permission literals', () => {
    const store = fakeStore({ 'rememberedPermission:claude': 'plan' })
    expect(rememberedPermission(store.getSetting, 'claude')).toBeUndefined()
  })
  it('keeps providers independent when both have a remembered mode', () => {
    const store = fakeStore()
    rememberPermission(store.setSetting, 'claude', 'auto', claude(['default', 'auto']))
    rememberPermission(store.setSetting, 'codex', 'read-only', undefined)
    expect(rememberedPermission(store.getSetting, 'claude')).toBe('auto')
    expect(rememberedPermission(store.getSetting, 'codex')).toBe('read-only')
  })
})

describe('main-process remembered browser tools', () => {
  it('replays the owner\'s last deliberate choice per provider and never for a local model', () => {
    const store = fakeStore()
    expect(rememberedBrowserTools(store.getSetting, 'codex')).toBeUndefined()
    rememberBrowserTools(store.setSetting, 'codex', true)
    expect(rememberedBrowserTools(store.getSetting, 'codex')).toBe(true)
    expect(rememberedBrowserTools(store.getSetting, 'claude')).toBeUndefined()
    rememberBrowserTools(store.setSetting, 'codex', false)
    expect(rememberedBrowserTools(store.getSetting, 'codex')).toBe(false)
    rememberBrowserTools(store.setSetting, 'local', true)
    rememberBrowserTools(store.setSetting, undefined, true)
    expect(rememberedBrowserTools(store.getSetting, 'local')).toBeUndefined()
    expect([...store.rows.keys()]).toEqual(['rememberedBrowserTools:codex'])
  })
  it('ignores a stored value that is not a boolean literal', () => {
    const store = fakeStore({ 'rememberedBrowserTools:claude': 'yes' })
    expect(rememberedBrowserTools(store.getSetting, 'claude')).toBeUndefined()
  })
})
