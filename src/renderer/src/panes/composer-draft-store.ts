import type { ContextAttachment } from '../../../shared/structured-agent'

export interface ComposerDraft {
  revision: string
  message: string
  attachments: ContextAttachment[]
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const emptyDraft: ComposerDraft = { revision: '', message: '', attachments: [] }
const attachmentKinds = new Set(['file', 'selection', 'editor', 'terminal', 'diagnostics', 'image'])

export const composerDraftKey = (projectId: string, sessionId: string): string =>
  'conductor.structured.draft.' + JSON.stringify([projectId, sessionId])

function readDraft(raw: string | null): ComposerDraft {
  if (!raw) return emptyDraft
  try {
    const value = JSON.parse(raw)
    if (value.version !== 1 || typeof value.revision !== 'string' || typeof value.message !== 'string' || !Array.isArray(value.attachments) || value.attachments.length > 20) return emptyDraft
    if (!value.attachments.every((item: ContextAttachment) => item && typeof item.id === 'string' && typeof item.name === 'string' && attachmentKinds.has(item.kind) &&
      (item.path === undefined || typeof item.path === 'string') && (item.content === undefined || typeof item.content === 'string') &&
      (item.startLine === undefined || Number.isSafeInteger(item.startLine) && item.startLine > 0) && (item.endLine === undefined || Number.isSafeInteger(item.endLine) && item.endLine > 0))) return emptyDraft
    return { revision: value.revision, message: value.message, attachments: value.attachments }
  } catch { return emptyDraft }
}

// Drafts belong to conversations, independent of the mounted pane or window.
// Persist in the input handler so switching/unmounting cannot race an effect.
export class ComposerDraftStore {
  private cache = new Map<string, { raw: string | null; draft: ComposerDraft }>()
  private volatile = new Set<string>()
  private listeners = new Set<() => void>()

  constructor(private storage: () => DraftStorage, private onWriteError: () => void = () => {}) {}

  get(key: string): ComposerDraft {
    const cached = this.cache.get(key)
    if (this.volatile.has(key) && cached) return cached.draft
    let raw: string | null
    try { raw = this.storage().getItem(key) } catch { return cached?.draft ?? emptyDraft }
    if (cached?.raw === raw) return cached.draft
    const draft = readDraft(raw)
    this.cache.set(key, { raw, draft })
    return draft
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  update(key: string, change: (draft: ComposerDraft) => Pick<ComposerDraft, 'message' | 'attachments'>): void {
    const next = change(this.get(key))
    const draft = next.message || next.attachments.length ? { ...next, revision: crypto.randomUUID() } : emptyDraft
    const raw = draft === emptyDraft ? null : JSON.stringify({ version: 1, ...draft })
    this.cache.set(key, { raw, draft })
    try {
      if (raw === null) this.storage().removeItem(key)
      else this.storage().setItem(key, raw)
      this.volatile.delete(key)
    } catch {
      // Keep the latest text usable for project switches even if storage is full.
      const alreadyReported = this.volatile.has(key)
      this.volatile.add(key)
      if (!alreadyReported) this.onWriteError()
    }
    this.listeners.forEach(listener => listener())
  }

  clearSubmitted(key: string, revision: string): void {
    // An acknowledgement may arrive after the owner has started another draft.
    if (this.get(key).revision === revision) this.update(key, () => emptyDraft)
  }
}
