import { describe, expect, it } from 'vitest'
import { projectBrowserViewId } from './browser-view-identity'

describe('project browser view identity', () => {
  it('is stable and project scoped', () => {
    expect(projectBrowserViewId('project-a')).toBe('project-browser:project-a')
    expect(projectBrowserViewId('project-b')).not.toBe(projectBrowserViewId('project-a'))
  })

  it.each([undefined, null, '', '   ', '../outside', 'a/b', 'x'.repeat(201)])('fails closed for %s', value => {
    expect(projectBrowserViewId(value)).toBeNull()
  })
})
