import { describe, expect, it } from 'vitest'
import { buildFileLinkMenuEntries } from './file-link-menu'

describe('buildFileLinkMenuEntries', () => {
  it('labels every modifier shortcut that the agent file links actually implement', () => {
    const entries = buildFileLinkMenuEntries()
    expect(entries.find((entry) => entry.action === 'edit')?.shortcut).toBe('Click')
    expect(entries.find((entry) => entry.action === 'live-preview')?.shortcut).toBe('Ctrl+Click')
    expect(entries.find((entry) => entry.action === 'default-browser')?.shortcut).toBe('Ctrl+Shift+Click')
  })

  it('includes the preview entry without a shortcut by default', () => {
    const entries = buildFileLinkMenuEntries()
    const preview = entries.find((entry) => entry.action === 'preview')
    expect(preview).toBeDefined()
    expect(preview?.shortcut).toBeUndefined()
  })

  it('omits preview when the caller opts out', () => {
    const entries = buildFileLinkMenuEntries({ includePreview: false })
    expect(entries.some((entry) => entry.action === 'preview')).toBe(false)
  })

  it('always ends with the two explorer reveal actions', () => {
    const entries = buildFileLinkMenuEntries()
    expect(entries.at(-2)?.action).toBe('reveal-explorer')
    expect(entries.at(-1)?.action).toBe('show-os-explorer')
  })

  it('never invents a shortcut for the new reveal actions', () => {
    const entries = buildFileLinkMenuEntries()
    expect(entries.find((entry) => entry.action === 'reveal-explorer')?.shortcut).toBeUndefined()
    expect(entries.find((entry) => entry.action === 'show-os-explorer')?.shortcut).toBeUndefined()
  })
})
