export interface ModalLike {
  open: boolean
  checkVisibility?(): boolean
  close(): void
}

export function releaseHiddenModals(root: { querySelectorAll(selector: 'dialog[open]'): Iterable<ModalLike> }): number {
  let released = 0
  for (const dialog of root.querySelectorAll('dialog[open]')) {
    if (dialog.open && dialog.checkVisibility?.() === false) { dialog.close(); released++ }
  }
  return released
}
