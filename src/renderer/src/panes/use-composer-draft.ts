import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject, type SetStateAction } from 'react'
import { MAX_PROMPT_CHARS, type ContextAttachment } from '../../../shared/structured-agent'
import { composerCommandQuery } from './composer-commands'
import { ComposerDraftStore, composerDraftKey, type ComposerDraft } from './composer-draft-store'
import { composerSendBlock, promptCharacterCount, type ComposerSendBlock } from './composer-settings'

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

function useDraftSubscription(key: string): (listener: () => void) => () => void {
  return useCallback((listener: () => void) => {
    const unsubscribe = drafts.subscribe(key, listener)
    const storageChanged = (event: StorageEvent): void => {
      if (event.key === key || event.key === null) listener()
    }
    window.addEventListener('storage', storageChanged)
    return () => { unsubscribe(); window.removeEventListener('storage', storageChanged) }
  }, [key])
}

/** What the conversation pane reads from its draft, apart from the text itself. Ordinary typing
 *  changes none of it, so a keystroke re-renders nothing (the textarea is uncontrolled, see
 *  useComposerTextSync), not the pane with its timeline, header and composer controls. */
export interface ComposerDraftView {
  attachments: ContextAttachment[]
  /** The text while it can open the / or @ command list, '' otherwise. */
  commandQuery: string
  sendBlock: ComposerSendBlock | undefined
  /** The prompt's size once it is past 90% of the ceiling (the pane shows a count), 0 below that. */
  nearLimitChars: number
}

export function composerDraftView(draft: Pick<ComposerDraft, 'message' | 'attachments'>): ComposerDraftView {
  const chars = promptCharacterCount(draft.message, draft.attachments)
  return {
    attachments: draft.attachments,
    commandQuery: composerCommandQuery(draft.message),
    sendBlock: composerSendBlock(draft.message, draft.attachments),
    nearLimitChars: chars > MAX_PROMPT_CHARS * 0.9 ? chars : 0
  }
}

const sameView = (a: ComposerDraftView, b: ComposerDraftView): boolean =>
  a.attachments === b.attachments && a.commandQuery === b.commandQuery && a.sendBlock === b.sendBlock && a.nearLimitChars === b.nearLimitChars

/** Keeps the composer's uncontrolled textarea showing the draft's text: when it mounts or the
 *  conversation changes, and whenever the draft changes to something other than what the textarea
 *  holds (sending clears it, a command or a restored message fills it, a paste folds into a chip,
 *  another window). Typing itself renders nothing: onChange writes the store, and the textarea
 *  already holds that text. A controlled textarea re-rendered on every key, and React rewrote its
 *  defaultValue (its child text node) each time. */
export function useComposerTextSync(projectId: string, sessionId: string, textarea: RefObject<HTMLTextAreaElement | null>): void {
  const key = composerDraftKey(projectId, sessionId)
  const subscribe = useDraftSubscription(key)
  useLayoutEffect(() => {
    const sync = (): void => {
      const node = textarea.current
      const message = drafts.get(key).message
      if (node && node.value !== message) node.value = message
    }
    sync()
    return subscribe(sync)
  }, [subscribe, key, textarea])
}

export function useComposerDraft(projectId: string, sessionId: string, memoryOnly = false) {
  const key = composerDraftKey(projectId, sessionId)
  // An anonymous conversation's unsent words stay in this window's memory, never localStorage.
  if (memoryOnly) drafts.keepInMemory(key)
  const subscribe = useDraftSubscription(key)
  // Leaving a conversation (switching it, closing or suspending its tab) saves what it held.
  useEffect(() => () => drafts.flush(key), [key])
  // The same view object for as long as what it holds is the same, so a keystroke that changes
  // only the text leaves the pane alone.
  const lastView = useRef<ComposerDraftView | null>(null)
  const snapshot = useCallback(() => {
    const next = composerDraftView(drafts.get(key))
    if (lastView.current && sameView(lastView.current, next)) return lastView.current
    return (lastView.current = next)
  }, [key])
  const view = useSyncExternalStore(subscribe, snapshot)
  /** The whole draft as it is now, for handlers: the pane does not re-render per keystroke. */
  const current = useCallback(() => drafts.get(key), [key])
  const setMessage = useCallback((message: string) => drafts.update(key, current => ({ ...current, message })), [key])
  const setAttachments = useCallback((value: SetStateAction<ContextAttachment[]>) => drafts.update(key, current => ({
    ...current, attachments: typeof value === 'function' ? value(current.attachments) : value
  })), [key])
  /** One revision for an edit that changes both, such as folding a paste into an attachment. */
  const setDraft = useCallback((message: string, attachments: ContextAttachment[]) => drafts.update(key, () => ({ message, attachments })), [key])
  const clearSubmitted = useCallback((revision: string) => drafts.clearSubmitted(key, revision), [key])
  const flush = useCallback(() => drafts.flush(key), [key])
  return { view, current, setMessage, setAttachments, setDraft, clearSubmitted, flush }
}
