import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'
import { ThreadList } from './ThreadList'

describe('starting a thread without a project', () => {
  it('offers "Start without a project" before "New project" on the empty state', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { onOpen: vi.fn(), onNewThread: vi.fn() }))
    expect(html).toContain('What should we work on?')
    expect(html.indexOf('data-empty-new-thread')).toBeGreaterThan(-1)
    expect(html.indexOf('data-empty-new-thread')).toBeLessThan(html.indexOf('data-empty-new-project'))
    expect(html).toContain('Start without a project')
  })

  it('keeps the old single action when the window has no thread handler', () => {
    const html = renderToStaticMarkup(createElement(EmptyState, { onOpen: vi.fn() }))
    expect(html).toContain('Open a project')
    expect(html).not.toContain('data-empty-new-thread')
  })

  it('shows the Threads section with a New thread button before anything has loaded', () => {
    const html = renderToStaticMarkup(createElement(ThreadList, {
      projects: [], refreshKey: '', onNewThread: vi.fn(), onOpenThread: vi.fn(), onContinueInProject: vi.fn(), onPromoteGeneral: vi.fn(async () => undefined)
    }))
    expect(html).toContain('aria-label="Threads"')
    expect(html).toContain('aria-label="New thread"')
    expect(html).toContain('Ctrl+Alt+N')
  })
})
