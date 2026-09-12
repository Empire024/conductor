import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSidebarPanel } from './WorkspaceSidebarPanel'

afterEach(() => vi.unstubAllGlobals())

describe('persistent project browser sidebar', () => {
  it.each(['workspace', 'explorer'] as const)('keeps an explicitly opened project guest mounted but hidden behind %s', mode => {
    vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => key === 'conductor.browserMountedProjects' ? '["project-a"]' : null), setItem: vi.fn() })
    const html = renderToStaticMarkup(createElement(WorkspaceSidebarPanel, {
      mode,
      project: { id: 'project-a', name: 'A', path: 'C:/a', createdAt: 'now', updatedAt: 'now' },
      projects: [],
      workspace: createElement('p', null, 'Workspace content')
    }))
    expect(html).toContain('class="workspace-sidebar-pane browser-sidebar"')
    expect(html).toMatch(/<section[^>]+browser-sidebar[^>]+hidden=""/)
    expect((html.match(/browser-owned-surface/g) ?? [])).toHaveLength(1)
  })

  it('does not activate or navigate a project browser before it is explicitly opened', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
    const html = renderToStaticMarkup(createElement(WorkspaceSidebarPanel, {
      mode: 'workspace',
      project: { id: 'project-a', name: 'A', path: 'C:/a', createdAt: 'now', updatedAt: 'now' },
      projects: [],
      workspace: createElement('p', null, 'Workspace content')
    }))
    expect(html).not.toContain('browser-owned-surface')
  })

  it('shows that same browser surface when Browser is selected', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
    const html = renderToStaticMarkup(createElement(WorkspaceSidebarPanel, {
      mode: 'browser',
      project: { id: 'project-a', name: 'A', path: 'C:/a', createdAt: 'now', updatedAt: 'now' },
      workspace: null
    }))
    expect(html).toContain('project-browser:project-a')
    expect(html).not.toMatch(/browser-sidebar[^>]+hidden=""/)
  })

  it('retains project A in the background when the owner opens project B', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => key === 'conductor.browserMountedProjects' ? '["project-a"]' : null), setItem: vi.fn() })
    const projects = [
      { id: 'project-a', name: 'A', path: 'C:/a', createdAt: 'now', updatedAt: 'now' },
      { id: 'project-b', name: 'B', path: 'C:/b', createdAt: 'now', updatedAt: 'now' }
    ]
    const html = renderToStaticMarkup(createElement(WorkspaceSidebarPanel, { mode: 'browser', project: projects[1]!, projects, workspace: null }))
    expect((html.match(/browser-owned-surface/g) ?? [])).toHaveLength(2)
    expect(html).toContain('project-browser:project-a')
    expect(html).toContain('project-browser:project-b')
    expect((html.match(/browser-sidebar[^>]+hidden=""/g) ?? [])).toHaveLength(1)
  })

  it('shows the selected remote tree while preserving the mounted browser guest', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => key === 'conductor.browserMountedProjects' ? '["project-a"]' : null), setItem: vi.fn() })
    vi.stubGlobal('window', {
      conductor: {
        remote: {
          files: {
            list: vi.fn(() => new Promise(() => {})),
            preview: vi.fn(),
            revokePreview: vi.fn(),
            download: vi.fn()
          }
        }
      }
    })
    const html = renderToStaticMarkup(createElement(WorkspaceSidebarPanel, {
      mode: 'explorer',
      project: { id: 'project-a', name: 'A', path: 'C:/a', createdAt: 'now', updatedAt: 'now' },
      projects: [],
      workspace: null,
      remoteFiles: {
        machineId: 'host-a',
        machineName: 'Remote host',
        projectId: 'project-a',
        onOpenFile: vi.fn()
      }
    }))
    expect(html).toContain('class="remote-files-pane"')
    expect(html).toContain('data-machine-id="host-a"')
    expect(html).not.toContain('all-project-explorer')
    expect(html).toMatch(/<section[^>]+browser-sidebar[^>]+hidden=""/)
    expect((html.match(/browser-owned-surface/g) ?? [])).toHaveLength(1)
  })
})
