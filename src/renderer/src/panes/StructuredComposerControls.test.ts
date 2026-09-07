import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderCapabilities, SessionSettings } from '../../../shared/structured-agent'
import { StructuredComposerControls } from './StructuredComposerControls'

const settings: SessionSettings = { permission: 'default', plan: false }
const capabilities: ProviderCapabilities = {
  provider: 'codex', runtimeVersion: 'synthetic-offline', adapterVersion: 1, authentication: 'cli',
  textStreaming: true, toolInputStreaming: false, toolOutputStreaming: true, approvals: true,
  questions: true, resume: true, fork: true, plans: true,
  models: [{ id: 'model-one', label: 'Model One', isDefault: true, effort: ['minimal', 'low', 'medium', 'high'] }, { id: 'model-two', label: 'Model Two', effort: [] }],
  effort: ['minimal', 'low', 'medium', 'high'], limitations: []
}
function render(options: { settings?: SessionSettings; capabilities?: ProviderCapabilities; disabled?: boolean } = {}): { html: string; onDiscover: ReturnType<typeof vi.fn>; onChange: ReturnType<typeof vi.fn> } {
  const onDiscover = vi.fn(async () => {})
  const onChange = vi.fn()
  return { html: renderToStaticMarkup(createElement(StructuredComposerControls, { settings: options.settings ?? settings, capabilities: options.capabilities, disabled: options.disabled ?? false, onDiscover, onChange })), onDiscover, onChange }
}

describe('compact composer controls (synthetic, zero inference)', () => {
  it('renders one discoverable model picker without connecting or adding provider setup clutter', () => {
    const { html, onDiscover, onChange } = render()
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-label="Model"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Choose model</span>')
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('Search models')
    expect(html).not.toContain('Provider')
    expect(onDiscover).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('uses the actual catalog label and preserves an unknown configured model ID', () => {
    expect(render({ capabilities, settings: { ...settings, model: 'model-two' } }).html).toContain('Model Two</span>')
    const unknown = render({ capabilities, settings: { ...settings, model: 'configured-custom-model' } }).html
    expect(unknown).toContain('configured-custom-model</span>')
    expect(unknown).not.toContain('Default</span>')
    expect(render({ capabilities, settings: { ...settings, model: 'default' } }).html).toContain('Model One</span>')
  })
  it('hides the effort slider unless supported effort choices are available', () => {
    expect(render().html).not.toContain('type="range"')
    expect(render({ capabilities: { ...capabilities, models: [] } }).html).not.toContain('type="range"')
    expect(render({ capabilities, settings: { ...settings, model: 'model-two', effort: 'high' } }).html).not.toContain('type="range"')
  })
  it('places supported effort values at their real slider positions and labels missing defaults', () => {
    const html = render({ capabilities, settings: { ...settings, effort: 'medium' } }).html
    expect(html).toContain('aria-label="Reasoning effort"')
    expect(html).toContain('aria-valuetext="Medium"')
    expect(html).toContain('type="range" min="0" max="4" step="1"')
    expect(html).toContain('value="3"')
    expect(html).toContain('--effort-progress:75%')
    expect(render({ capabilities }).html).toContain('aria-valuetext="Not reported"')
    expect(render({ capabilities, settings: { ...settings, effort: 'auto' } }).html).toContain('aria-valuetext="Not reported"')
    const filtered = render({ capabilities: { ...capabilities, models: [{ id: 'model-one', label: 'Model One', isDefault: true, effort: ['', 'auto', 'low', 'high'] }] }, settings: { ...settings, effort: 'high' } }).html
    expect(filtered).toContain('max="2"')
    expect(filtered).toContain('aria-valuetext="High"')
  })
  it('disables both controls when a session cannot accept settings changes', () => {
    const html = render({ capabilities, disabled: true }).html
    expect(html.match(/disabled=""/g)).toHaveLength(3)
  })
  it('makes an unsupported saved effort explicit instead of silently displaying Auto', () => {
    const saved = { ...settings, effort: 'future-effort' }
    const { html, onChange } = render({ capabilities, settings: saved })
    expect(html).toContain('Unavailable: future-effort')
    expect(html).toContain('Click to use the configured effort.')
    expect(html).not.toContain('type="range"')
    expect(html).not.toContain('aria-valuetext="Not reported"')
    expect(saved.effort).toBe('future-effort')
    expect(onChange).not.toHaveBeenCalled()
    const disabled = render({ capabilities, settings: saved, disabled: true }).html
    expect(disabled.match(/disabled=""/g)).toHaveLength(3)
  })
  it('escapes catalog labels and configured values as inert text', () => {
    const html = render({ capabilities: { ...capabilities, models: [{ id: 'evil', label: '<img src=x onerror=alert(1)>' }] }, settings: { ...settings, model: 'evil' } }).html
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })
})

it('resolves the default effort capability from the effective model instead of the provider union', () => {
  const html = render({ capabilities: { ...capabilities, effectiveSettings: { model: 'model-two' } } }).html
  expect(html).not.toContain('Reasoning effort')
  expect(html).not.toContain('Unavailable:')
  const known = render({ capabilities: { ...capabilities, effectiveSettings: { model: 'model-two' } }, settings: { ...settings, model: 'model-one' } }).html
  expect(known).toContain('Reasoning effort')
})

it('uses Claude default alias metadata while hiding effort for a non-reasoning model', () => {
  const claude: ProviderCapabilities = { ...capabilities, provider: 'claude', models: [{ id: 'default', label: 'Default (recommended)', effort: ['low', 'high'] }, { id: 'haiku', label: 'Haiku', effort: [] }] }
  expect(render({ capabilities: claude }).html).toContain('Reasoning effort')
  const html = render({ capabilities: claude, settings: { ...settings, model: 'haiku', effort: 'high' } }).html
  expect(html).not.toContain('Reasoning effort')
  expect(html).not.toContain('Unavailable:')
})

it('shows the effective model and effort in place of ambiguous saved aliases', () => {
  const html = render({ capabilities: { ...capabilities, effectiveSettings: { model: 'gpt-6-astra', effort: 'xhigh' }, models: [{ id: 'gpt-6-astra', label: 'gpt-6-astra', effort: ['high', 'xhigh'], defaultEffort: 'high' }] }, settings: { ...settings, model: 'default', effort: 'auto' } }).html
  expect(html).toContain('GPT 6 Astra</span>')
  expect(html).toContain('aria-valuetext="Xhigh"')
  expect(html).toContain('value="2"')
  expect(html).toContain('--effort-progress:100%')
  expect(html).toContain('title="GPT 6 Astra · xhigh"')
  expect(html).not.toContain('Default</span>')
  expect(html).not.toContain('Auto</output>')
})

it('uses the new model default effort instead of carrying the running model effort over', () => {
  const html = render({ capabilities: { ...capabilities, effectiveSettings: { model: 'model-two', effort: 'high' }, models: [{ id: 'model-one', label: 'Model One', defaultEffort: 'low', effort: ['low', 'high'] }] }, settings: { ...settings, model: 'model-one' } }).html
  expect(html).toContain('aria-valuetext="Low"')
})

it('offers only modes reported by the provider in the bottom controls', () => {
  const claude = render({ capabilities: { ...capabilities, provider: 'claude', permissions: ['default', 'auto', 'accept-edits'], plans: true } }).html
  expect(claude).toContain('aria-label="Conversation mode"')
  expect(claude).toContain('aria-haspopup="menu"')
  expect(claude).toContain('Ask</span>')
  expect(claude).not.toContain('<select')
  expect(render({ capabilities: { ...capabilities, plans: false } }).html).not.toContain('Conversation mode')
})


it('shows Claude configured default metadata until the runtime reports the model', () => {
  const claude: ProviderCapabilities = { ...capabilities, provider: 'claude', models: [{ id: 'default', label: 'Default (Opus)', effort: ['high'] }] }
  expect(render({ capabilities: claude }).html).toContain('Default (Opus)</span>')
  expect(render({ capabilities: { ...claude, models: [] } }).html).toContain('Claude configured model</span>')
  expect(render({ capabilities: { ...claude, effectiveSettings: { model: 'claude-opus-runtime' } } }).html).toContain('claude-opus-runtime</span>')
})


it('keeps default alias effort metadata when Claude reports a concrete runtime model ID', () => {
  const html = render({ capabilities: { ...capabilities, provider: 'claude', effectiveSettings: { model: 'claude-opus-runtime', effort: 'high' }, models: [{ id: 'default', label: 'Default (Opus)', effort: ['low', 'high'] }] } }).html
  expect(html).toContain('aria-valuetext="High"')
  expect(html).toContain('value="2"')
})
