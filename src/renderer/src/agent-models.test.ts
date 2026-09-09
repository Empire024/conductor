import { describe, expect, it } from 'vitest'
import { createDefaultLayout } from '../../shared/models'
import { migrateLegacyCodexModels, migrateLegacyCodexTab, processModelLabel, runtimeModelLabel } from './agent-models'

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
    for (const model of [undefined, '', 'default', 'auto']) expect(runtimeModelLabel(model)).toBe('Choose model')
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

describe('process dashboard model resolution', () => {
  const providers = [
    { id: 'claude', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet-5', label: 'Sonnet 5' }] },
    { id: 'codex', models: [{ id: 'gpt-6-astra', label: 'Astra' }] }
  ]

  it('shows the model a running process actually resolved to, not its saved default configuration', () => {
    const process = { id: 'agent-1', provider: 'claude', model: 'default' }
    const reportedModels = new Map([['agent-1', 'opus']])
    expect(processModelLabel(process, providers, reportedModels)).toBe('Opus')
  })

  it('falls back to the configured model when nothing has been reported yet', () => {
    const process = { id: 'agent-2', provider: 'codex', model: 'gpt-6-astra' }
    expect(processModelLabel(process, providers, new Map())).toBe('Astra')
  })

  it('only shows the placeholder when a process genuinely has no model to report', () => {
    const process = { id: 'agent-3', provider: 'unlisted-provider', model: undefined }
    expect(processModelLabel(process, providers, new Map())).toBe('Choose model')
  })

  it('never crashes on a process from a provider missing its catalog', () => {
    const process = { id: 'agent-4', provider: 'unknown-provider', model: 'default' }
    const reportedModels = new Map([['agent-4', 'some-model']])
    expect(processModelLabel(process, providers, reportedModels)).toBe('some-model')
  })
})
