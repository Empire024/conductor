import { describe, expect, it, vi } from 'vitest'
import { ComposerDraftStore, composerDraftKey } from './composer-draft-store'

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  const warning = vi.fn()
  return { values, storage, warning, store: new ComposerDraftStore(() => storage, warning) }
}
const first = composerDraftKey('project-a', 'agent-1')
const second = composerDraftKey('project-b', 'agent-1')
const workspace = composerDraftKey('project-a', 'agent-2')
const attachment = { id: 'context-1', kind: 'selection' as const, name: 'draft.ts:2', path: 'draft.ts', content: '  unsaved content\n', startLine: 2, endLine: 3 }

function type(store: ComposerDraftStore, key: string, message: string): void {
  store.update(key, draft => ({ ...draft, message }))
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
