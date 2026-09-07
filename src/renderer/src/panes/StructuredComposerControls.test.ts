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
  models: [{ id: 'model-one', label: 'Model One' }, { id: 'model-two', label: 'Model Two' }],
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
    expect(html).toContain('Default</span>')
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
    expect(render({ capabilities, settings: { ...settings, model: 'default' } }).html).toContain('Default</span>')
  })
  it('hides the effort slider unless supported effort choices are available', () => {
    expect(render().html).not.toContain('type="range"')
    expect(render({ capabilities: { ...capabilities, effort: [] } }).html).not.toContain('type="range"')
    expect(render({ capabilities: { ...capabilities, effort: ['', 'auto'] } }).html).not.toContain('type="range"')
  })
  it('places supported effort values and Auto at their real slider positions', () => {
    const html = render({ capabilities, settings: { ...settings, effort: 'medium' } }).html
    expect(html).toContain('aria-label="Reasoning effort"')
    expect(html).toContain('aria-valuetext="Medium"')
    expect(html).toContain('type="range" min="0" max="4" step="1"')
    expect(html).toContain('value="3"')
    expect(html).toContain('--effort-progress:75%')
    expect(render({ capabilities }).html).toContain('aria-valuetext="Auto"')
    expect(render({ capabilities, settings: { ...settings, effort: 'auto' } }).html).toContain('aria-valuetext="Auto"')
    const filtered = render({ capabilities: { ...capabilities, effort: ['', 'auto', 'low', 'high'] }, settings: { ...settings, effort: 'high' } }).html
    expect(filtered).toContain('max="2"')
    expect(filtered).toContain('aria-valuetext="High"')
  })
  it('disables both controls when a session cannot accept settings changes', () => {
    const html = render({ capabilities, disabled: true }).html
    expect(html.match(/disabled=""/g)).toHaveLength(2)
  })
  it('makes an unsupported saved effort explicit instead of silently displaying Auto', () => {
    const saved = { ...settings, effort: 'future-effort' }
    const { html, onChange } = render({ capabilities, settings: saved })
    expect(html).toContain('Unavailable: future-effort')
    expect(html).toContain('Click to reset to Auto.')
    expect(html).not.toContain('type="range"')
    expect(html).not.toContain('aria-valuetext="Auto"')
    expect(saved.effort).toBe('future-effort')
    expect(onChange).not.toHaveBeenCalled()
    const disabled = render({ capabilities, settings: saved, disabled: true }).html
    expect(disabled.match(/disabled=""/g)).toHaveLength(2)
  })
  it('escapes catalog labels and configured values as inert text', () => {
    const html = render({ capabilities: { ...capabilities, models: [{ id: 'evil', label: '<img src=x onerror=alert(1)>' }] }, settings: { ...settings, model: 'evil' } }).html
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })
})
