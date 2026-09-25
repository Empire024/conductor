import { useCallback, useEffect, useSyncExternalStore, type SetStateAction } from 'react'
import type { ContextAttachment } from '../../../shared/structured-agent'
import { ComposerDraftStore, composerDraftKey } from './composer-draft-store'

const drafts = new ComposerDraftStore(() => localStorage, () => {
  window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Could not save this message draft to disk. Keep this window open until you can save or send it.' }))
})
// Typing is saved after a short pause; anything still unsaved is written the moment the page
// can go away (reload, close, restart to update) or the window stops being visible.
const flushAll = (): void => drafts.flush()
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushAll)
  window.addEventListener('beforeunload', flushAll)
  window.addEventListener('conductor:flush-session', flushAll)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll() })
}

/** Adds context to a conversation's draft whether or not a pane is showing it. */
export function attachToDraft(projectId: string, sessionId: string, attachment: ContextAttachment): void {
  drafts.update(composerDraftKey(projectId, sessionId), draft => ({
    ...draft, attachments: [...draft.attachments.filter(item => item.id !== attachment.id), attachment].slice(-20)
  }))
}

/** Whether a conversation holds words or context not sent yet: a tab Conductor must not close on its own. */
export function hasComposerDraft(projectId: string, sessionId: string): boolean {
  const draft = drafts.get(composerDraftKey(projectId, sessionId))
  return Boolean(draft.message.trim() || draft.attachments.length)
}

export function useComposerDraft(projectId: string, sessionId: string) {
  const key = composerDraftKey(projectId, sessionId)
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = drafts.subscribe(key, listener)
    const storageChanged = (event: StorageEvent): void => {
      if (event.key === key || event.key === null) listener()
    }
    window.addEventListener('storage', storageChanged)
    return () => { unsubscribe(); window.removeEventListener('storage', storageChanged) }
  }, [key])
  // Leaving a conversation (switching it, closing or suspending its tab) saves what it held.
  useEffect(() => () => drafts.flush(key), [key])
  const snapshot = useCallback(() => drafts.get(key), [key])
  const draft = useSyncExternalStore(subscribe, snapshot)
  const setMessage = useCallback((message: string) => drafts.update(key, current => ({ ...current, message })), [key])
  const setAttachments = useCallback((value: SetStateAction<ContextAttachment[]>) => drafts.update(key, current => ({
    ...current, attachments: typeof value === 'function' ? value(current.attachments) : value
  })), [key])
  /** One revision for an edit that changes both, such as folding a paste into an attachment. */
  const setDraft = useCallback((message: string, attachments: ContextAttachment[]) => drafts.update(key, () => ({ message, attachments })), [key])
  const clearSubmitted = useCallback((revision: string) => drafts.clearSubmitted(key, revision), [key])
  const flush = useCallback(() => drafts.flush(key), [key])
  return { draft, setMessage, setAttachments, setDraft, clearSubmitted, flush }
}
