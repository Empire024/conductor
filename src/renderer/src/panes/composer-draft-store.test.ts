import { describe, expect, it, vi } from 'vitest'
import { ComposerDraftStore, DRAFT_SAVE_DELAY_MS, DRAFT_SAVE_MAX_WAIT_MS, composerDraftKey, type DraftSaveScheduler } from './composer-draft-store'

function manualClock() {
  let now = 0
  let next = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const scheduler: DraftSaveScheduler = {
    set: (run, delayMs) => { timers.set(++next, { at: now + delayMs, run }); return next },
    clear: handle => { timers.delete(handle as number) },
    now: () => now
  }
  const advance = (ms: number): void => {
    const until = now + ms
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].run()
    }
    now = until
  }
  return { scheduler, advance }
}

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  const warning = vi.fn()
  const clock = manualClock()
  return { values, storage, warning, clock, store: new ComposerDraftStore(() => storage, warning, clock.scheduler) }
}
const first = composerDraftKey('project-a', 'agent-1')
const second = composerDraftKey('project-b', 'agent-1')
const workspace = composerDraftKey('project-a', 'agent-2')
const attachment = { id: 'context-1', kind: 'selection' as const, name: 'draft.ts:2', path: 'draft.ts', content: '  unsaved content\n', startLine: 2, endLine: 3 }

/** One edit followed by the save pause, the way a window sees another window's typing. */
function type(store: ComposerDraftStore, key: string, message: string): void {
  store.update(key, draft => ({ ...draft, message }))
  store.flush()
}

describe('conversation drafts', () => {
  it('restores exact text and captured context after recreation without mixing projects or conversations', () => {
    const { store, storage } = fixture()
    store.update(first, () => ({ message: '  First draft\nCafé 🧪  ', attachments: [attachment] }))
    type(store, second, 'Second project')
    type(store, workspace, 'Second workspace')
    const reopened = new ComposerDraftStore(() => storage)
    expect(reopened.get(first)).toMatchObject({ message: '  First draft\nCafé 🧪  ', attachments: [attachment] })
    expect(reopened.get(second).message).toBe('Second project')
    expect(reopened.get(workspace).message).toBe('Second workspace')
  })

  it('removes a successfully submitted draft and its context from persistent storage', () => {
    const { store, storage, values } = fixture()
    store.update(first, () => ({ message: 'Send this', attachments: [attachment] }))
    store.clearSubmitted(first, store.get(first).revision)
    expect(values.has(first)).toBe(false)
    expect(new ComposerDraftStore(() => storage).get(first)).toMatchObject({ message: '', attachments: [] })
  })

  it('does not clear a newer draft when an older send acknowledges, even if the text was retyped identically', () => {
    const { store } = fixture()
    type(store, first, 'Send this')
    const sent = store.get(first)
    type(store, first, 'Next message')
    type(store, first, 'Send this')
    store.clearSubmitted(first, sent.revision)
    expect(store.get(first).message).toBe('Send this')
    expect(store.get(first).revision).not.toBe(sent.revision)
  })

  it('preserves newly attached context while an older send is pending', () => {
    const { store } = fixture()
    type(store, first, 'Send this')
    const sent = store.get(first)
    store.update(first, draft => ({ ...draft, attachments: [attachment] }))
    store.clearSubmitted(first, sent.revision)
    expect(store.get(first).attachments).toEqual([attachment])
  })

  it('observes another window editing or clearing the same conversation without restoring stale text', () => {
    const { store, storage } = fixture()
    type(store, first, 'Original')
    const sent = store.get(first)
    const detached = new ComposerDraftStore(() => storage)
    type(detached, first, 'Edited in detached window')
    store.clearSubmitted(first, sent.revision)
    expect(store.get(first).message).toBe('Edited in detached window')
    detached.clearSubmitted(first, detached.get(first).revision)
    expect(store.get(first).message).toBe('')
  })

  it('keeps typing usable after a storage failure, reports it once, and persists on recovery', () => {
    const { store, storage, warning } = fixture()
    type(store, first, 'Saved')
    const write = storage.setItem
    storage.setItem = () => { throw new Error('Quota exceeded') }
    type(store, first, 'Unsaved')
    type(store, first, 'Latest text')
    expect(store.get(first).message).toBe('Latest text')
    expect(warning).toHaveBeenCalledTimes(1)
    storage.setItem = write
    type(store, first, 'Recovered storage')
    expect(new ComposerDraftStore(() => storage).get(first).message).toBe('Recovered storage')
  })

  it('does not resurrect sent text in the current window if removing storage fails', () => {
    const { store, storage, warning } = fixture()
    type(store, first, 'Send this')
    storage.removeItem = () => { throw new Error('Storage unavailable') }
    store.clearSubmitted(first, store.get(first).revision)
    expect(store.get(first).message).toBe('')
    expect(warning).toHaveBeenCalledOnce()
  })

  it('safely opens malformed or unsupported saved drafts', () => {
    const { store, values } = fixture()
    for (const raw of ['invalid JSON', 'null', '{"version":2}', JSON.stringify({ version: 1, revision: 'r', message: 'bad attachment', attachments: [null] })]) {
      values.set(first, raw)
      expect(store.get(first)).toMatchObject({ message: '', attachments: [] })
    }
  })
})

describe('draft persistence off the typing path', () => {
  const keystrokes = (store: ComposerDraftStore, key: string, text: string, advance: (ms: number) => void, gapMs: number): void => {
    for (let index = 1; index <= text.length; index++) {
      store.update(key, draft => ({ ...draft, message: text.slice(0, index) }))
      advance(gapMs)
    }
  }

  it('keeps every keystroke in memory and writes storage once after the owner pauses', () => {
    const { store, storage, clock } = fixture()
    const setItem = vi.spyOn(storage, 'setItem')
    keystrokes(store, first, 'Hello', clock.advance, 50)
    expect(store.get(first).message).toBe('Hello')
    expect(setItem).not.toHaveBeenCalled()
    expect(store.hasUnsaved(first)).toBe(true)
    clock.advance(DRAFT_SAVE_DELAY_MS)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(store.hasUnsaved()).toBe(false)
    expect(new ComposerDraftStore(() => storage).get(first).message).toBe('Hello')
  })

  it('still saves an unbroken burst of typing within the maximum wait', () => {
    const { store, storage, clock } = fixture()
    const setItem = vi.spyOn(storage, 'setItem')
    keystrokes(store, first, 'x'.repeat(30), clock.advance, 100)
    expect(setItem.mock.calls.length).toBeGreaterThanOrEqual(Math.floor(3_000 / DRAFT_SAVE_MAX_WAIT_MS))
    expect(setItem.mock.calls.length).toBeLessThan(5)
    // Whatever reached storage is never older than the maximum wait.
    const saved = new ComposerDraftStore(() => storage).get(first).message.length
    expect(30 - saved).toBeLessThanOrEqual(DRAFT_SAVE_MAX_WAIT_MS / 100)
  })

  it('writes at once when flushed for a blur, a conversation switch or page exit', () => {
    const { store, storage } = fixture()
    store.update(first, draft => ({ ...draft, message: 'Leaving now' }))
    store.update(second, draft => ({ ...draft, message: 'Other project' }))
    store.flush(first)
    expect(new ComposerDraftStore(() => storage).get(first).message).toBe('Leaving now')
    expect(new ComposerDraftStore(() => storage).get(second).message).toBe('')
    store.flush()
    expect(new ComposerDraftStore(() => storage).get(second).message).toBe('Other project')
  })

  it('does not let the older saved text replace what was typed since the last save', () => {
    const { store, values } = fixture()
    type(store, first, 'Saved')
    store.update(first, draft => ({ ...draft, message: 'Saved and more' }))
    expect(values.get(first)).toContain('"Saved"')
    expect(store.get(first).message).toBe('Saved and more')
  })

  it('wakes only the listeners of the conversation being typed in', () => {
    const { store } = fixture()
    const typing = vi.fn()
    const other = vi.fn()
    store.subscribe(first, typing)
    const off = store.subscribe(second, other)
    store.update(first, draft => ({ ...draft, message: 'a' }))
    store.update(first, draft => ({ ...draft, message: 'ab' }))
    expect(typing).toHaveBeenCalledTimes(2)
    expect(other).not.toHaveBeenCalled()
    off()
    store.update(second, draft => ({ ...draft, message: 'b' }))
    expect(other).not.toHaveBeenCalled()
  })

  it('removes a sent draft from storage immediately, not after the pause', () => {
    const { store, values } = fixture()
    type(store, first, 'Send this')
    store.clearSubmitted(first, store.get(first).revision)
    expect(values.has(first)).toBe(false)
    expect(store.hasUnsaved()).toBe(false)
  })
})
