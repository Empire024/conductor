import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../../shared/models'
import { migrateLegacyCodexModels, migrateLegacyCodexTab } from './agent-models'

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
