import type { ContextAttachment } from '../../../shared/structured-agent'

export interface ComposerDraft {
  revision: string
  message: string
  attachments: ContextAttachment[]
}
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface DraftSaveScheduler {
  set(run: () => void, delayMs: number): unknown
  clear(handle: unknown): void
  now(): number
}
const emptyDraft: ComposerDraft = { revision: '', message: '', attachments: [] }
const attachmentKinds = new Set(['file', 'selection', 'editor', 'terminal', 'diagnostics', 'image'])
/** Typing is written this long after the last keystroke... */
export const DRAFT_SAVE_DELAY_MS = 300
/** ...but never later than this after the first unsaved one, so a long burst still reaches disk. */
export const DRAFT_SAVE_MAX_WAIT_MS = 1_500
const timers: DraftSaveScheduler = { set: (run, delayMs) => setTimeout(run, delayMs), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now() }

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

// Drafts belong to conversations, independent of the mounted pane or window. The text lives in
// memory the moment it is typed; storage is written after a short pause (and at once on blur,
// conversation switch, unmount and page exit), so a keystroke never waits on JSON and
// localStorage. Listeners are per draft: typing in one conversation wakes no other.
export class ComposerDraftStore {
  private cache = new Map<string, { raw: string | null; draft: ComposerDraft }>()
  /** Edits storage has not seen yet: this window's latest text wins over what storage holds. */
  private unsaved = new Set<string>()
  private volatile = new Set<string>()
  private listeners = new Map<string, Set<() => void>>()
  private timer: unknown = null
  private firstUnsavedAt = 0
  private revisionPrefix = crypto.randomUUID()
  private revisionCount = 0

  constructor(private storage: () => DraftStorage, private onWriteError: () => void = () => {}, private scheduler: DraftSaveScheduler = timers) {}

  get(key: string): ComposerDraft {
    const cached = this.cache.get(key)
    if (cached && (this.unsaved.has(key) || this.volatile.has(key))) return cached.draft
    let raw: string | null
    try { raw = this.storage().getItem(key) } catch { return cached?.draft ?? emptyDraft }
    if (cached?.raw === raw) return cached.draft
    const draft = readDraft(raw)
    this.cache.set(key, { raw, draft })
    return draft
  }

  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key)
    if (!set) this.listeners.set(key, set = new Set())
    set.add(listener)
    return () => {
      set.delete(listener)
      if (!set.size && this.listeners.get(key) === set) this.listeners.delete(key)
    }
  }

  update(key: string, change: (draft: ComposerDraft) => Pick<ComposerDraft, 'message' | 'attachments'>): void {
    const next = change(this.get(key))
    // Unique across windows (prefix) and edits (counter) without a UUID per keystroke.
    const draft = next.message || next.attachments.length ? { ...next, revision: this.revisionPrefix + ':' + (++this.revisionCount).toString(36) } : emptyDraft
    this.cache.set(key, { raw: this.cache.get(key)?.raw ?? null, draft })
    if (!this.unsaved.size) this.firstUnsavedAt = this.scheduler.now()
    this.unsaved.add(key)
    this.scheduleSave()
    this.listeners.get(key)?.forEach(listener => listener())
  }

  clearSubmitted(key: string, revision: string): void {
    // An acknowledgement may arrive after the owner has started another draft.
    if (this.get(key).revision !== revision) return
    this.update(key, () => emptyDraft)
    // Sent text leaves storage at once so a crash cannot bring it back.
    this.flush(key)
  }

  /** Writes unsaved drafts now: one conversation's, or every one when no key is given. */
  flush(key?: string): void {
    const keys = key === undefined ? [...this.unsaved] : this.unsaved.has(key) ? [key] : []
    for (const item of keys) this.write(item)
    if (this.unsaved.size) return
    if (this.timer !== null) this.scheduler.clear(this.timer)
    this.timer = null
  }

  hasUnsaved(key?: string): boolean {
    return key === undefined ? this.unsaved.size > 0 : this.unsaved.has(key)
  }

  private scheduleSave(): void {
    const now = this.scheduler.now()
    const due = Math.min(now + DRAFT_SAVE_DELAY_MS, this.firstUnsavedAt + DRAFT_SAVE_MAX_WAIT_MS)
    if (this.timer !== null) this.scheduler.clear(this.timer)
    this.timer = this.scheduler.set(() => { this.timer = null; this.flush() }, Math.max(0, due - now))
  }

  private write(key: string): void {
    this.unsaved.delete(key)
    const draft = this.cache.get(key)?.draft ?? emptyDraft
    const raw = draft === emptyDraft ? null : JSON.stringify({ version: 1, ...draft })
    try {
      if (raw === null) this.storage().removeItem(key)
      else this.storage().setItem(key, raw)
      this.cache.set(key, { raw, draft })
      this.volatile.delete(key)
    } catch {
      // Keep the latest text usable for project switches even if storage is full.
      const alreadyReported = this.volatile.has(key)
      this.volatile.add(key)
      if (!alreadyReported) this.onWriteError()
    }
  }
}
