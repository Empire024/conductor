import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { QueuedPrompt } from '../../../shared/structured-agent'
import { IncomingMessageList, incomingQueued, ownQueued, QueuedMessageList, queuedShortcutTarget } from './QueuedMessageList'

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

describe('messages from agents are not the owner queue', () => {
  const fromAgent = (id: string, text: string): QueuedPrompt => ({ ...prompt(id, text), origin: { agentSessionId: 'agent_fixer1', label: 'Fixer' } })

  it('leaves agent and Conductor messages out of the numbered queue and the Alt+Backspace target', () => {
    const prompts = [prompt('mine', 'My note'), fromAgent('theirs', 'Report: done'), prompt('conductor', '[Conductor] approved: Bash(ls); retry it now')]
    const html = renderToStaticMarkup(createElement(QueuedMessageList, { prompts, onRemove: vi.fn() }))
    expect(html).toContain('My note')
    expect(html).not.toContain('Report: done')
    expect(html).not.toContain('Queued 2')
    expect(queuedShortcutTarget({ key: 'Backspace', altKey: true }, prompts)?.id).toBe('mine')
    expect(ownQueued(prompts).map(item => item.id)).toEqual(['mine'])
    expect(incomingQueued(prompts).map(item => item.id)).toEqual(['theirs', 'conductor'])
  })

  it('draws an incoming message with its sender badge and name, never as Queued', () => {
    const html = renderToStaticMarkup(createElement(IncomingMessageList, { prompts: [fromAgent('theirs', 'Report: done')], onDismiss: vi.fn() }))
    expect(html).toContain('sa-incoming-pending')
    expect(html).toContain('data-sender-kind="agent"')
    expect(html).toContain('Agent message')
    expect(html).toContain('Fixer')
    expect(html).toContain('Report: done')
    expect(html).not.toContain('Queued')
    expect(renderToStaticMarkup(createElement(IncomingMessageList, { prompts: [], onDismiss: vi.fn() }))).toBe('')
  })
})
