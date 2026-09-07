import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../../shared/models'
import { migrateLegacyCodexModels, migrateLegacyCodexTab, runtimeModelLabel } from './agent-models'

describe('Codex model migration', () => {
  it('replaces retired persisted selections with Astra', () => {
    const tab = migrateLegacyCodexTab({
      id: 'codex',
      kind: 'agent',
      title: 'Codex',
      state: { provider: 'codex', model: 'gpt-5.3-codex' }
    })
    expect(tab.state?.model).toBe('gpt-6-astra')

    const layout = createDefaultLayout()
    if (layout.root.type !== 'group') throw new Error('Expected a tab group')
    layout.root.tabs[0] = { ...tab, state: { provider: 'codex', model: 'gpt-5.2-codex' } }
    expect(migrateLegacyCodexModels(layout).root).toMatchObject({
      tabs: [{ state: { model: 'gpt-6-astra' } }]
    })
  })

  it('preserves custom and non-Codex models', () => {
    const custom = { id: 'custom', kind: 'agent' as const, title: 'Codex', state: { provider: 'codex', model: 'custom-model' } }
    expect(migrateLegacyCodexTab(custom)).toBe(custom)
  })
})

describe('runtime model identity', () => {
  it('does not turn saved defaults into a claimed model', () => {
    for (const model of [undefined, '', 'default', 'auto']) expect(runtimeModelLabel(model)).toBe('Model not reported')
  })
  it('uses an explicit runtime report before a configured alias', () => {
    const models = [{ id: 'model-current', label: 'Current model' }]
    expect(runtimeModelLabel('older-model', models, 'model-current')).toBe('Current model')
    expect(runtimeModelLabel('default', models, 'model-current')).toBe('Current model')
  })
  it('preserves a known configured model when the runtime only echoes a placeholder', () => {
    expect(runtimeModelLabel('custom-model', [], 'default')).toBe('custom-model')
    expect(runtimeModelLabel('model-current', [{ id: 'model-current', label: 'Current model' }])).toBe('Current model')
  })
})
