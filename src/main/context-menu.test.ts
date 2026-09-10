import { describe, expect, it, vi } from 'vitest'
import { buildContextMenuTemplate, contextMenuItemIds, installContextMenu, type ContextMenuParams } from './context-menu'

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn((template) => ({ popup: vi.fn(), template })) },
  clipboard: { writeText: vi.fn() }
}))

const editFlags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false
}

const baseParams = (overrides: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  isEditable: false,
  selectionText: '',
  linkURL: '',
  mediaType: 'none',
  x: 0,
  y: 0,
  editFlags: { ...editFlags },
  ...overrides
})

describe('contextMenuItemIds', () => {
  it('offers Copy for a plain-text selection in a read-only region', () => {
    expect(contextMenuItemIds(baseParams({ selectionText: 'hello' }))).toEqual(['copy', 'separator', 'selectAll'])
  })

  it('offers only Select All for read-only text with no selection', () => {
    expect(contextMenuItemIds(baseParams())).toEqual(['selectAll'])
  })

  it('offers Copy link address for a link, even without a text selection', () => {
    expect(contextMenuItemIds(baseParams({ linkURL: 'https://example.com' }))).toEqual(['copyLink', 'separator', 'selectAll'])
  })

  it('offers Copy image for an image target', () => {
    expect(contextMenuItemIds(baseParams({ mediaType: 'image' }))).toEqual(['copyImage', 'separator', 'selectAll'])
  })

  it('combines selection, link and image affordances in one menu', () => {
    expect(contextMenuItemIds(baseParams({ selectionText: 'hi', linkURL: 'https://example.com', mediaType: 'image' })))
      .toEqual(['copy', 'copyLink', 'copyImage', 'separator', 'selectAll'])
  })

  it('offers the full editable set when every edit flag is enabled', () => {
    expect(contextMenuItemIds(baseParams({
      isEditable: true,
      editFlags: { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    }))).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'separator', 'selectAll'])
  })

  it('omits Copy in an editable field with no selection', () => {
    expect(contextMenuItemIds(baseParams({
      isEditable: true,
      editFlags: { ...editFlags, canPaste: true, canSelectAll: true }
    }))).toEqual(['paste', 'pasteAndMatchStyle', 'separator', 'selectAll'])
  })

  it('never produces a leading, trailing, or doubled separator', () => {
    const ids = contextMenuItemIds(baseParams({ isEditable: true, editFlags: { ...editFlags } }))
    expect(ids[0]).not.toBe('separator')
    expect(ids[ids.length - 1]).not.toBe('separator')
    expect(ids.some((id, i) => id === 'separator' && ids[i + 1] === 'separator')).toBe(false)
  })

  it('produces nothing for an editable field with every edit flag off', () => {
    expect(contextMenuItemIds(baseParams({ isEditable: true }))).toEqual([])
  })
})

describe('buildContextMenuTemplate', () => {
  const fakeWebContents = () => ({
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    pasteAndMatchStyle: vi.fn(),
    selectAll: vi.fn(),
    copyImageAt: vi.fn()
  })

  it('invokes webContents.copy when the Copy item is clicked', () => {
    const webContents = fakeWebContents()
    const template = buildContextMenuTemplate(webContents, baseParams({ selectionText: 'hi' }))
    const copyItem = template.find((item) => item.label === 'Copy')
    expect(typeof copyItem?.click).toBe('function')
    ;(copyItem!.click as () => void)()
    expect(webContents.copy).toHaveBeenCalledOnce()
  })

  it('invokes webContents.copyImageAt with the event coordinates for Copy image', () => {
    const webContents = fakeWebContents()
    const template = buildContextMenuTemplate(webContents, baseParams({ mediaType: 'image', x: 12, y: 34 }))
    const item = template.find((entry) => entry.label === 'Copy image')
    ;(item!.click as () => void)()
    expect(webContents.copyImageAt).toHaveBeenCalledWith(12, 34)
  })
})

describe('installContextMenu', () => {
  it('registers a context-menu listener that builds and pops up a menu', async () => {
    const { Menu } = await import('electron')
    const handlers: Array<(event: unknown, params: ContextMenuParams) => void> = []
    const webContents = {
      on: vi.fn((event: string, handler: (event: unknown, params: ContextMenuParams) => void) => {
        if (event === 'context-menu') handlers.push(handler)
      }),
      undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(),
      pasteAndMatchStyle: vi.fn(), selectAll: vi.fn(), copyImageAt: vi.fn()
    }
    installContextMenu(webContents as never)
    expect(handlers).toHaveLength(1)
    handlers[0]!({}, baseParams({ selectionText: 'hi' }))
    expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalledOnce()
  })

  it('does not pop up an empty menu', async () => {
    const { Menu } = await import('electron')
    vi.mocked(Menu.buildFromTemplate).mockClear()
    const handlers: Array<(event: unknown, params: ContextMenuParams) => void> = []
    const webContents = {
      on: vi.fn((event: string, handler: (event: unknown, params: ContextMenuParams) => void) => {
        if (event === 'context-menu') handlers.push(handler)
      }),
      undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(),
      pasteAndMatchStyle: vi.fn(), selectAll: vi.fn(), copyImageAt: vi.fn()
    }
    installContextMenu(webContents as never)
    handlers[0]!({}, baseParams({ isEditable: true }))
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled()
  })
})
