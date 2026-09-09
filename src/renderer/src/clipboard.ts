/** Chromium rejects navigator.clipboard whenever the document is not focused —
 * a context menu, a detached window, or a busy editor is enough. Every copy in
 * the app goes through here so that failure becomes a toast, never an
 * unhandled rejection, and falls back to the main process which has no such rule. */
export const copyText = async (value: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      await window.conductor.system.copyText(value)
      return true
    } catch {
      return false
    }
  }
}

/** Copies and reports the outcome to the user, for the many call sites that
 * only want the toast. */
export const copyTextWithFeedback = async (value: string, copied: string, failed = 'Could not copy to the clipboard'): Promise<boolean> => {
  const ok = await copyText(value)
  window.dispatchEvent(new CustomEvent('conductor:toast', { detail: ok ? copied : failed }))
  return ok
}
