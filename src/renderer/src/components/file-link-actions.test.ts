import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFileLinkAction, type FileLinkTarget } from './file-link-actions'

const target: FileLinkTarget = { projectId: 'p1', path: 'src/a.ts', line: 12 }

describe('runFileLinkAction', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('edit calls the host-supplied callback with the target path and line, and touches nothing else', () => {
    const edit = vi.fn()
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    runFileLinkAction('edit', target, edit, vi.fn())
    expect(edit).toHaveBeenCalledWith('src/a.ts', 12)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('live-preview and preview open a workspace tab through the shared conductor:open-file event, never the edit callback', () => {
    const events: CustomEvent[] = []
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => { events.push(event); return true } })
    const edit = vi.fn()
    runFileLinkAction('live-preview', target, edit, vi.fn())
    runFileLinkAction('preview', target, edit, vi.fn())
    expect(edit).not.toHaveBeenCalled()
    expect(events.map((event) => event.type)).toEqual(['conductor:open-file', 'conductor:open-file'])
    expect(events[0]!.detail).toEqual({ projectId: 'p1', path: 'src/a.ts', mode: 'browser', line: 12, allowBinary: undefined })
    expect(events[1]!.detail).toMatchObject({ mode: 'preview', path: 'src/a.ts' })
  })

  it('reveal-explorer dispatches conductor:reveal-in-explorer with the project id and relative path', () => {
    const events: CustomEvent[] = []
    vi.stubGlobal('window', { dispatchEvent: (event: CustomEvent) => { events.push(event); return true } })
    runFileLinkAction('reveal-explorer', target, vi.fn(), vi.fn())
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('conductor:reveal-in-explorer')
    expect(events[0]!.detail).toEqual({ projectId: 'p1', relativePath: 'src/a.ts' })
  })

  it('default-browser and show-os-explorer call the matching IPC method with the project id and path', () => {
    const openInBrowser = vi.fn().mockResolvedValue(undefined)
    const reveal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { conductor: { files: { openInBrowser, reveal } } })
    runFileLinkAction('default-browser', target, vi.fn(), vi.fn())
    runFileLinkAction('show-os-explorer', target, vi.fn(), vi.fn())
    expect(openInBrowser).toHaveBeenCalledWith('p1', 'src/a.ts')
    expect(reveal).toHaveBeenCalledWith('p1', 'src/a.ts')
  })

  it('reports a failed default-browser or show-os-explorer IPC call through notify instead of throwing', async () => {
    const openInBrowser = vi.fn().mockRejectedValue(new Error('no default browser'))
    const reveal = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { conductor: { files: { openInBrowser, reveal } } })
    const notify = vi.fn()
    runFileLinkAction('default-browser', target, vi.fn(), notify)
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('Error: no default browser'))
  })
})
