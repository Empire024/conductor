import { useCallback, useSyncExternalStore, type SetStateAction } from 'react'
import type { ContextAttachment } from '../../../shared/structured-agent'
import { ComposerDraftStore, composerDraftKey } from './composer-draft-store'

const drafts = new ComposerDraftStore(() => localStorage, () => {
  window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Could not save this message draft to disk. Keep this window open until you can save or send it.' }))
})

export function useComposerDraft(projectId: string, sessionId: string) {
  const key = composerDraftKey(projectId, sessionId)
  const subscribe = useCallback((listener: () => void) => {
    const unsubscribe = drafts.subscribe(listener)
    const storageChanged = (event: StorageEvent): void => {
      if (event.key === key || event.key === null) listener()
    }
    window.addEventListener('storage', storageChanged)
    return () => { unsubscribe(); window.removeEventListener('storage', storageChanged) }
  }, [key])
  const snapshot = useCallback(() => drafts.get(key), [key])
  const draft = useSyncExternalStore(subscribe, snapshot)
  const setMessage = useCallback((message: string) => drafts.update(key, current => ({ ...current, message })), [key])
  const setAttachments = useCallback((value: SetStateAction<ContextAttachment[]>) => drafts.update(key, current => ({
    ...current, attachments: typeof value === 'function' ? value(current.attachments) : value
  })), [key])
  const clearSubmitted = useCallback((revision: string) => drafts.clearSubmitted(key, revision), [key])
  return { draft, setMessage, setAttachments, clearSubmitted }
}
