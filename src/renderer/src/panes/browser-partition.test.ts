import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPane } from './BrowserPane'
import { BrowserSidebar } from '../components/BrowserSidebar'
import { browserPartition } from './browser-partition'

afterEach(() => vi.unstubAllGlobals())

describe('project browser credentials', () => {
  it('uses distinct persistent profiles with stable identity for a project', () => {
    expect(browserPartition('project-a')).toBe('persist:conductor-browser-project-a')
    expect(browserPartition('project-b')).toBe('persist:conductor-browser-project-b')
    expect(browserPartition('project-a')).not.toBe(browserPartition('project-b'))
  })

  it.each([undefined, null, '', '   '])('fails closed for absent project %s', projectId => {
    expect(browserPartition(projectId)).toBeNull()
    const props = { projectId: projectId ?? undefined }
    expect(renderToStaticMarkup(createElement(BrowserPane, props))).not.toContain('<webview')
    expect(renderToStaticMarkup(createElement(BrowserSidebar, props))).not.toContain('<webview')
  })

  it('remounts the pane when project identity changes, including navigation state', () => {
    const a = BrowserPane({ projectId: 'project-a' })
    const b = BrowserPane({ projectId: 'project-b' })
    expect(a.key).toBe('persist:conductor-browser-project-a')
    expect(b.key).not.toBe(a.key)
    expect(BrowserPane({ projectId: 'project-a' }).key).toBe(a.key)
  })

  it('renders one main-owned project surface without an in-renderer webview or popup attribute', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null) })
    const html = renderToStaticMarkup(createElement(BrowserSidebar, { projectId: 'project-a' }))
    expect(html).toContain('data-conductor-browser-view-id="project-browser:project-a"')
    expect(html).not.toContain('<webview')
    expect(html).not.toContain('allowpopups')
  })

  it('does not let a legacy workspace BrowserPane construct a competing guest', () => {
    const html = renderToStaticMarkup(createElement(BrowserPane, { projectId: 'project-a' }))
    expect(html).toContain('Browser moved to the activity rail')
    expect(html).not.toContain('data-conductor-browser-view-id')
  })
})
