import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderCapabilities, SessionSettings } from '../../../shared/structured-agent'
import { StructuredComposerControls } from './StructuredComposerControls'
import { resolveEffortChoice, supportedEffortChoices } from '../../../shared/model-effort'

const settings: SessionSettings = { permission: 'default', plan: false }
const capabilities: ProviderCapabilities = {
  provider: 'codex', runtimeVersion: 'synthetic-offline', adapterVersion: 1, authentication: 'cli',
  steering: false, textStreaming: true, toolInputStreaming: false, toolOutputStreaming: true, approvals: true,
  questions: true, resume: true, fork: true, plans: true, permissions: ['default', 'read-only', 'accept-edits', 'auto'],
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
    expect(html).toContain('GPT-6-Astra</span>')
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
    expect(render({ capabilities: { ...capabilities, models: [] } }).html).toContain('type="range"')
    expect(render({ capabilities, settings: { ...settings, model: 'model-two', effort: 'high' } }).html).not.toContain('type="range"')
  })
  it('places supported effort values at their real slider positions and names the account default when none applies', () => {
    const html = render({ capabilities, settings: { ...settings, effort: 'medium' } }).html
    expect(html).toContain('aria-label="Reasoning effort"')
    expect(html).toContain('aria-valuetext="Medium"')
    expect(html).toContain('type="range" min="0" max="3" step="1"')
    expect(html).toContain('value="2"')
    expect(html).toContain('--effort-progress:67%')
    // No saved effort, no runtime-reported effort, no catalog default: nothing is guessed (the
    // runtime keeps its configured level) and the slider says so instead of claiming "Medium".
    for (const missing of [render({ capabilities }), render({ capabilities, settings: { ...settings, effort: 'auto' } })]) {
      expect(missing.html).toContain('aria-valuetext="Account default"')
      expect(missing.html).toContain('<output>Account default</output>')
      expect(missing.html).toContain('--effort-progress:0%')
      expect(missing.html).not.toContain('class="active"')
      expect(missing.html).not.toContain('Not reported')
      expect(missing.onChange).not.toHaveBeenCalled()
    }
    const filtered = render({ capabilities: { ...capabilities, models: [{ id: 'model-one', label: 'Model One', isDefault: true, effort: ['', 'auto', 'low', 'high'] }] }, settings: { ...settings, effort: 'high' } }).html
    expect(filtered).toContain('max="1"')
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
    expect(html).not.toContain('Not reported')
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
  // The CLI's own display name from model/list is shown verbatim, never re-spaced.
  const html = render({ capabilities: { ...capabilities, effectiveSettings: { model: 'gpt-6-astra', effort: 'xhigh' }, models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', effort: ['high', 'xhigh'], defaultEffort: 'high' }] }, settings: { ...settings, model: 'default', effort: 'auto' } }).html
  expect(html).toContain('GPT-6-Astra</span>')
  expect(html).toContain('aria-valuetext="Xhigh"')
  expect(html).toContain('value="1"')
  expect(html).toContain('--effort-progress:100%')
  expect(html).toContain('title="GPT-6-Astra · xhigh"')
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
  // A runtime that reported neither permission modes nor planning has nothing to pick between.
  expect(render({ capabilities: { ...capabilities, plans: false, permissions: undefined } }).html).not.toContain('Conversation mode')
})

it('shows a Codex conversation its own permission mode, so Auto is reachable without the settings dialog', () => {
  const codex = { ...capabilities, plans: false }
  const ask = render({ capabilities: codex }).html
  expect(ask).toContain('aria-label="Conversation mode"')
  expect(ask).toContain('Ask</span>')
  expect(ask).toContain('title="Approve requests the way your Codex CLI is configured to."')
  const auto = render({ capabilities: codex, settings: { ...settings, permission: 'auto' } }).html
  expect(auto).toContain('Auto</span>')
  expect(auto).toContain('Never ask')
  expect(auto).not.toContain('Edit</span>')
})


it('calls the pre-discovery Claude stand-in the account default until a catalog or system/init names the model', () => {
  const claude: ProviderCapabilities = { ...capabilities, provider: 'claude', models: [{ id: 'default', label: 'Default (Opus)', effort: ['high'] }] }
  expect(render({ capabilities: claude }).html).toContain('Account default</span>')
  expect(render({ capabilities: { ...claude, models: [] } }).html).toContain('Account default</span>')
  expect(render({ capabilities: { ...claude, effectiveSettings: { model: 'claude-opus-runtime' } } }).html).toContain('claude-opus-runtime</span>')
  // Once the catalog lists the stand-in, its own label wins; an owner's explicit pick of the same id reads the same.
  const discovered = { ...claude, models: [{ id: 'default', label: 'Default (recommended)', effort: ['high'] }, { id: 'opus[1m]', label: 'Opus (1M context)', effort: ['high'] }] }
  expect(render({ capabilities: discovered }).html).toContain('Opus (1M context)</span>')
  expect(render({ capabilities: discovered, settings: { ...settings, model: 'opus[1m]' } }).html).toContain('Opus (1M context)</span>')
})

it('labels a resolved Claude alias by its catalog name and offers the runtime name as the tooltip', () => {
  const claude: ProviderCapabilities = { ...capabilities, provider: 'claude', effectiveSettings: { model: 'claude-sonnet-5', effort: 'low' }, models: [{ id: 'sonnet', label: 'Sonnet', effort: ['low', 'high'] }, { id: 'haiku', label: 'Haiku', effort: [] }] }
  const html = render({ capabilities: claude, settings: { ...settings, model: 'sonnet', effort: 'low' } }).html
  expect(html).toContain('Sonnet</span>')
  expect(html).not.toContain('claude-sonnet-5</span>')
  expect(html).toContain('title="Sonnet (claude-sonnet-5) · low"')
  const haiku = render({ capabilities: { ...claude, effectiveSettings: { model: 'claude-haiku-4-5-20251001' } }, settings: { ...settings, model: 'haiku' } }).html
  expect(haiku).toContain('Haiku</span>')
  expect(haiku).toContain('title="Haiku (claude-haiku-4-5-20251001)"')
})


it('keeps default alias effort metadata when Claude reports a concrete runtime model ID', () => {
  const html = render({ capabilities: { ...capabilities, provider: 'claude', effectiveSettings: { model: 'claude-opus-runtime', effort: 'high' }, models: [{ id: 'default', label: 'Default (Opus)', effort: ['low', 'high'] }] } }).html
  expect(html).toContain('aria-valuetext="High"')
  expect(html).toContain('value="1"')
})

it('shows the effort ladder for a fresh Claude session before the model catalog loads, without guessing a level', () => {
  // Claude's initialize reports no default effort, so nothing is sent: the CLI applies its own
  // configured level (the owner's saved xhigh on 2026-09-21), and the slider says "Account default".
  const claude: ProviderCapabilities = { ...capabilities, provider: 'claude', models: [], effort: ['low', 'medium', 'high', 'xhigh', 'max'] }
  const { html, onChange } = render({ capabilities: claude, settings: { permission: 'default', plan: false } })
  expect(html).toContain('aria-label="Reasoning effort"')
  expect(html).toContain('aria-valuetext="Account default"')
  expect(html).not.toContain('aria-valuetext="Medium"')
  expect(html).toContain('type="range"')
  expect(onChange).not.toHaveBeenCalled()
  // Once the runtime reports an effort (system/init or a turn), the slider shows that level.
  const reported = render({ capabilities: { ...claude, effectiveSettings: { model: 'claude-opus-5[1m]', effort: 'xhigh' } }, settings: { permission: 'default', plan: false } }).html
  expect(reported).toContain('aria-valuetext="Xhigh"')
  expect(reported).toContain('value="3"')
})

it('keeps the effort control visible when the current model is not listed in an otherwise loaded catalog', () => {
  // A saved alias or a runtime-reported concrete ID the catalog never listed must read as
  // "unreported for this model", not "this model has no effort" — the tooltip already showed a
  // resolved value from settings, so the control must not silently disappear underneath it.
  const html = render({ capabilities, settings: { ...settings, model: 'claude-opus-5', effort: 'low' } }).html
  expect(html).toContain('aria-label="Reasoning effort"')
  expect(html).toContain('aria-valuetext="Low"')
  expect(html).not.toContain('Unavailable:')
})

it('resolves only a reported effort choice, never a guessed middle one', () => {
  expect(supportedEffortChoices(capabilities)).toEqual(['minimal', 'low', 'medium', 'high'])
  expect(supportedEffortChoices(capabilities, 'model-two')).toEqual([])
  expect(supportedEffortChoices(capabilities, 'unknown-model-id')).toEqual(['minimal', 'low', 'medium', 'high'])
  expect(resolveEffortChoice(['minimal', 'low', 'medium', 'high'])).toBeUndefined()
  expect(resolveEffortChoice(['minimal', 'low', 'medium', 'high'], 'low')).toBe('low')
  expect(resolveEffortChoice(['minimal', 'low', 'medium', 'high'], 'unsupported')).toBeUndefined()
  expect(resolveEffortChoice(['low', 'high'])).toBeUndefined()
  expect(resolveEffortChoice(['high'], 'high')).toBe('high')
  expect(resolveEffortChoice([])).toBeUndefined()
})
