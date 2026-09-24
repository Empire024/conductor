import { describe, expect, it } from 'vitest'
import { releaseHiddenModals, type ModalLike } from './modal-guard'

/* B1 contract (conductor-task:88138288). AgentDialog (View usage and the other sa-dialog modals)
   opens with showModal(), which makes the rest of the document inert. When its pane is hidden
   behind another tab the dialog is invisible but still modal, so every click in the app does
   nothing until the owner happens to Ctrl+Tab back to it. A modal must be visible or closed. */

class FakeDialog implements ModalLike {
  closed = 0
  constructor(public open: boolean, private visible: boolean | undefined) {}
  checkVisibility?(): boolean
  close(): void { this.open = false; this.closed += 1 }
  static make(open: boolean, visible: boolean | undefined): FakeDialog {
    const dialog = new FakeDialog(open, visible)
    if (visible !== undefined) dialog.checkVisibility = () => visible
    return dialog
  }
}
const root = (dialogs: FakeDialog[]) => ({ querySelectorAll: (selector: string) => { expect(selector).toBe('dialog[open]'); return dialogs.filter(dialog => dialog.open) } })

describe('releaseHiddenModals', () => {
  it('closes an open modal whose pane is hidden and leaves a visible one alone', () => {
    const hidden = FakeDialog.make(true, false), shown = FakeDialog.make(true, true)
    expect(releaseHiddenModals(root([hidden, shown]))).toBe(1)
    expect(hidden).toMatchObject({ open: false, closed: 1 })
    expect(shown).toMatchObject({ open: true, closed: 0 })
  })

  it('does nothing without open dialogs, and never closes one it cannot judge', () => {
    expect(releaseHiddenModals(root([]))).toBe(0)
    const unknown = FakeDialog.make(true, undefined)
    expect(releaseHiddenModals(root([unknown]))).toBe(0)
    expect(unknown.open).toBe(true)
  })
})
