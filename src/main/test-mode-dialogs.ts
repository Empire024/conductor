import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue, type OpenDialogOptions, type OpenDialogReturnValue, type SaveDialogOptions, type SaveDialogReturnValue } from 'electron'

/** A parked test window must never put a native dialog on the owner's real screen - a leaked
 *  overnight verifier left "Quit Conductor? Work is still running" and JS error boxes sitting on
 *  a real display (feature-list.md: smoke-instances-never-leak). Every dialog.show* call site in
 *  the main process goes through here so test mode answers headlessly with a safe default instead
 *  of blocking on a modal nobody can see. CONDUCTOR_TEST_DIALOGS=1 opts a smoke back into the real
 *  dialog, to exercise the dialog itself through its own stub. CONDUCTOR_TEST_DIALOGS=hold keeps the
 *  guard but plays an owner who has not clicked yet: a dialog that can close itself (it has an
 *  abort signal, like the running-work confirmation) stays open until it does, so a smoke can see
 *  it pending and watch it close once the work stops. */
export const guardingDialogs = (): boolean =>
  !app.isPackaged && !!process.env.CONDUCTOR_TEST_USER_DATA && process.env.CONDUCTOR_TEST_DIALOGS !== '1'

const logGuarded = (detail: string): void => {
  try { appendFileSync(join(app.getPath('userData'), 'main-errors.log'), `${new Date().toISOString()} [dialog] guarded: ${detail}\n`) }
  catch { /* logging never blocks the answer */ }
}

const ownerWindow = (owner: BrowserWindow | null | undefined): BrowserWindow | undefined => owner && !owner.isDestroyed() ? owner : undefined

/** `testResponse` names the button index a caller knows is safe to take unattended (e.g. "stop and
 *  quit" for the running-work confirmation); with none given, the dialog's own cancelId or
 *  defaultId is used, which declines rather than takes an unreviewed action. */
export async function showMessageBox(owner: BrowserWindow | null | undefined, options: MessageBoxOptions, testResponse?: number): Promise<MessageBoxReturnValue> {
  if (guardingDialogs()) {
    const signal = options.signal
    if (process.env.CONDUCTOR_TEST_DIALOGS === 'hold' && signal) {
      logGuarded(`"${options.message}" -> held until it closes itself`)
      if (!signal.aborted) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }))
      return { response: options.cancelId ?? options.defaultId ?? 0, checkboxChecked: false }
    }
    const response = testResponse ?? options.cancelId ?? options.defaultId ?? 0
    logGuarded(`"${options.message}" -> response ${response}`)
    return { response, checkboxChecked: false }
  }
  const window = ownerWindow(owner)
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

export async function showSaveDialog(owner: BrowserWindow | null | undefined, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  if (guardingDialogs()) { logGuarded(`save "${options.title ?? ''}" -> canceled`); return { canceled: true, filePath: '' } }
  const window = ownerWindow(owner)
  return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options)
}

export async function showOpenDialog(owner: BrowserWindow | null | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  if (guardingDialogs()) { logGuarded(`open "${options.title ?? ''}" -> canceled`); return { canceled: true, filePaths: [] } }
  const window = ownerWindow(owner)
  return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options)
}
