import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppUpdateState } from '../../../shared/models'
import { AppUpdateButton } from './AppUpdateButton'
import { UpdatePrompt } from './UpdatePrompt'

const state = (phase: AppUpdateState['phase'], extra: Partial<AppUpdateState> = {}): AppUpdateState => ({
  phase, currentVersion: '0.1.4', availableVersion: '0.1.5-local.1', configured: true, source: 'local', ...extra
})
const prompt = (value: AppUpdateState): string => renderToStaticMarkup(createElement(UpdatePrompt, {
  state: value, autoDownload: false, onAutoDownload() {}, onAction() {}, onDismiss() {}
}))
const button = (value: AppUpdateState): string => renderToStaticMarkup(createElement(AppUpdateButton, { state: value, onAction() {} }))

describe('update action feedback', () => {
  it('does not fabricate zero percent while the download request is being prepared', () => {
    for (const render of [prompt, button]) {
      const html = render(state('downloading'))
      expect(html).toContain('Preparing download')
      expect(html).toContain('disabled=""')
      expect(html).toContain('aria-busy="true"')
      expect(html).not.toContain('0%')
    }
  })

  it('shows authoritative progress, including actual zero, with accessible progress metadata', () => {
    expect(prompt(state('downloading', { progress: 0 }))).toContain('Downloading 0%')
    const html = prompt(state('downloading', { progress: 42.4 }))
    expect(html).toContain('Downloading 42%')
    expect(html).toContain('aria-label="Update download progress" value="42" max="100"')
    expect(button(state('downloading', { progress: Number.NaN }))).not.toContain('NaN')
  })

  it('keeps restart preparation busy without claiming installation completed', () => {
    const value = state('installing', { message: 'Saving windows and stopping processes…' })
    expect(prompt(value)).toContain('Saving windows and stopping processes')
    for (const render of [prompt, button]) {
      const html = render(value)
      expect(html).toContain('Preparing restart')
      expect(html).toContain('disabled=""')
      expect(html).not.toContain('100%')
    }
  })

  it('shows errors accessibly and permits explicit retry', () => {
    const value = state('error', { message: 'Synthetic download transport failed' })
    expect(prompt(value)).toContain('role="alert"')
    for (const render of [prompt, button]) {
      const html = render(value)
      expect(html).toContain('Retry update')
      expect(html).toContain('Synthetic download transport failed')
      expect(html).not.toContain('disabled=""')
    }
  })
})
