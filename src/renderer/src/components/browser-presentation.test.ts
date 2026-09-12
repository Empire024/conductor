import { describe, expect, it, vi } from 'vitest'
import { browserPresentationKey, mountedBrowserProjectsKey, persistBrowserPresentation, persistMountedBrowserProjects, savedBrowserPresentation, savedMountedBrowserProjects } from './browser-presentation'

describe('browser presentation preference', () => {
  it('keeps the preference project scoped and accepts only known modes', () => {
    expect(browserPresentationKey('project-a')).not.toBe(browserPresentationKey('project-b'))
    expect(savedBrowserPresentation('project-a', { getItem: () => 'expanded' })).toBe('expanded')
    expect(savedBrowserPresentation('project-a', { getItem: () => 'background' })).toBe('background')
    expect(savedBrowserPresentation('project-a', { getItem: () => 'surprise-window' })).toBe('pane')
  })

  it('persists an explicit choice without activating a view', () => {
    const setItem = vi.fn()
    persistBrowserPresentation('project-a', 'background', { setItem })
    expect(setItem).toHaveBeenCalledWith('conductor.browserPresentation.project-a', 'background')
  })
})

describe('mounted project browser catalog', () => {
  it('round-trips distinct project identities without accepting malformed storage', () => {
    let saved = ''
    persistMountedBrowserProjects(['project-a', 'project-b', 'project-a'], { setItem: (key, value) => { expect(key).toBe(mountedBrowserProjectsKey); saved = value } })
    expect([...savedMountedBrowserProjects({ getItem: () => saved })]).toEqual(['project-a', 'project-b'])
    expect([...savedMountedBrowserProjects({ getItem: () => '{broken' })]).toEqual([])
  })
})
