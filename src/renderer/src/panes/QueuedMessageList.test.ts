import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { QueuedPrompt } from '../../../shared/structured-agent'
import { QueuedMessageList, queuedShortcutTarget } from './QueuedMessageList'

const prompt = (id: string, text: string): QueuedPrompt => ({ id, text, settings: { permission: 'default', plan: false }, attachments: [] })

describe('queued message chips', () => {
  it('renders a removable chip for every not-yet-sent message', () => {
    const html = renderToStaticMarkup(createElement(QueuedMessageList, { prompts: [prompt('one', 'First'), prompt('two', 'Second')], onRemove: vi.fn() }))
    expect(html).toContain('aria-label="Remove queued message 1"')
    expect(html).toContain('aria-label="Remove queued message 2"')
    expect(html).toContain('First')
    expect(html).toContain('Second')
  })

  it('targets only the last queued message for Alt+Backspace', () => {
    const prompts = [prompt('one', 'First'), prompt('two', 'Second')]
    expect(queuedShortcutTarget({ key: 'Backspace', altKey: true }, prompts)?.id).toBe('two')
    expect(queuedShortcutTarget({ key: 'Backspace', altKey: false }, prompts)).toBeNull()
    expect(queuedShortcutTarget({ key: 'Delete', altKey: true }, prompts)).toBeNull()
  })
})
