import { Menu, clipboard, type MenuItemConstructorOptions, type WebContents } from 'electron'

export type ContextMenuItemId =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'selectAll'
  | 'copyLink'
  | 'copyImage'
  | 'separator'

export interface ContextMenuParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
  mediaType: 'none' | 'image' | 'audio' | 'video' | 'canvas' | 'file' | 'plugin'
  x: number
  y: number
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

// Drop separators that would be empty, doubled, or trailing so the menu never shows a stray rule.
const compact = (ids: ContextMenuItemId[]): ContextMenuItemId[] => {
  const out: ContextMenuItemId[] = []
  for (const id of ids) {
    if (id === 'separator' && (out.length === 0 || out[out.length - 1] === 'separator')) continue
    out.push(id)
  }
  if (out[out.length - 1] === 'separator') out.pop()
  return out
}

export const contextMenuItemIds = (params: ContextMenuParams): ContextMenuItemId[] => {
  const ids: ContextMenuItemId[] = []
  if (params.isEditable) {
    if (params.editFlags.canUndo) ids.push('undo')
    if (params.editFlags.canRedo) ids.push('redo')
    ids.push('separator')
    if (params.editFlags.canCut) ids.push('cut')
    if (params.editFlags.canCopy) ids.push('copy')
    if (params.editFlags.canPaste) ids.push('paste', 'pasteAndMatchStyle')
    ids.push('separator')
    if (params.editFlags.canSelectAll) ids.push('selectAll')
  } else {
    if (params.selectionText.trim()) ids.push('copy')
    if (params.linkURL) ids.push('copyLink')
    if (params.mediaType === 'image') ids.push('copyImage')
    ids.push('separator')
    ids.push('selectAll')
  }
  return compact(ids)
}

const LABELS: Record<Exclude<ContextMenuItemId, 'separator'>, string> = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteAndMatchStyle: 'Paste as plain text',
  selectAll: 'Select All',
  copyLink: 'Copy link address',
  copyImage: 'Copy image'
}

export const buildContextMenuTemplate = (
  webContents: Pick<WebContents, 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll' | 'copyImageAt'>,
  params: ContextMenuParams
): MenuItemConstructorOptions[] =>
  contextMenuItemIds(params).map((id) => {
    if (id === 'separator') return { type: 'separator' }
    return {
      label: LABELS[id],
      click: () => {
        switch (id) {
          case 'undo': webContents.undo(); break
          case 'redo': webContents.redo(); break
          case 'cut': webContents.cut(); break
          case 'copy': webContents.copy(); break
          case 'paste': webContents.paste(); break
          case 'pasteAndMatchStyle': webContents.pasteAndMatchStyle(); break
          case 'selectAll': webContents.selectAll(); break
          case 'copyLink': clipboard.writeText(params.linkURL); break
          case 'copyImage': webContents.copyImageAt(params.x, params.y); break
        }
      }
    }
  })

export const installContextMenu = (webContents: WebContents): void => {
  webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(webContents, params)
    if (!template.length) return
    Menu.buildFromTemplate(template).popup()
  })
}
