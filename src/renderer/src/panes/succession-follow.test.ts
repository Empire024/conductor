import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextAttachment } from '../../../shared/structured-agent'
import { ComposerDraftStore, composerDraftKey } from './composer-draft-store'
import {
  MAX_DRAFT_ATTACHMENTS, beginSuccessionFollow, finishSuccessionFollow, hasSuccessionArrivalListener, mergeMovedDraft, notifySuccessionArrival,
  resetSuccessionFollows, shouldFollowSuccession, subscribeSuccessionArrival, successionFollowFrom, successionFollowInto, type SuccessionFollow
} from './succession-follow'

const attachment = (id: string): ContextAttachment => ({ id, kind: 'selection', name: id + '.ts', path: id + '.ts', content: 'x' })

function memoryStore() {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  return { values, storage, store: new ComposerDraftStore(() => storage, () => {}, { set: () => 0, clear: () => {}, now: () => 0 }) }
}

afterEach(() => resetSuccessionFollows())

// feature-list conductor-task:3a590e76: the wizard handed itself on while the owner was typing;
// the composer froze and the message had to be copied over by hand.
describe('following a main brain to its successor', () => {
  it('follows only a succession that arrived while the conversation was open live, once', () => {
    expect(shouldFollowSuccession({ succession: true, sawLiveConversation: true, followed: false, historical: false })).toBe(true)
    // Opened after the handoff: the banner is already there, nobody is taken anywhere.
    expect(shouldFollowSuccession({ succession: true, sawLiveConversation: false, followed: false, historical: false })).toBe(false)
    expect(shouldFollowSuccession({ succession: true, sawLiveConversation: true, followed: true, historical: false })).toBe(false)
    expect(shouldFollowSuccession({ succession: true, sawLiveConversation: true, followed: false, historical: true })).toBe(false)
    expect(shouldFollowSuccession({ succession: false, sawLiveConversation: true, followed: false, historical: false })).toBe(false)
  })

  it('moves text, attachments and caret onto the successor draft', () => {
    const moved = mergeMovedDraft({ message: 'half a thought', attachments: [attachment('a')] }, { message: '', attachments: [] }, 4)
    expect(moved).toEqual({ target: { message: 'half a thought', attachments: [attachment('a')] }, source: { message: '', attachments: [] }, caret: 4, moved: true })
    // No caret known: the end of the moved text.
    expect(mergeMovedDraft({ message: 'abc', attachments: [] }, { message: '', attachments: [] }).caret).toBe(3)
    expect(mergeMovedDraft({ message: 'abc', attachments: [] }, { message: '', attachments: [] }, 99).caret).toBe(3)
    // Whitespace is the owner's typing too.
    expect(mergeMovedDraft({ message: 'hi ', attachments: [] }, { message: '', attachments: [] }).target.message).toBe('hi ')
  })

  it('keeps text the successor already holds first and doubles no attachment', () => {
    const moved = mergeMovedDraft({ message: 'mine', attachments: [attachment('a'), attachment('b')] }, { message: 'there', attachments: [attachment('a')] }, 2)
    expect(moved.target).toEqual({ message: 'there\n\nmine', attachments: [attachment('a'), attachment('b')] })
    expect(moved.caret).toBe('there\n\n'.length + 2)
    expect(moved.source).toEqual({ message: '', attachments: [] })
  })

  it('leaves attachments that do not fit with the predecessor rather than dropping them', () => {
    const full = Array.from({ length: MAX_DRAFT_ATTACHMENTS - 1 }, (_, index) => attachment('t' + index))
    const moved = mergeMovedDraft({ message: 'x', attachments: [attachment('a'), attachment('b')] }, { message: '', attachments: full })
    expect(moved.target.attachments).toHaveLength(MAX_DRAFT_ATTACHMENTS)
    expect(moved.source).toEqual({ message: '', attachments: [attachment('b')] })
    // Nothing that can move: nothing changes.
    const stuck = mergeMovedDraft({ message: '', attachments: [attachment('c')] }, { message: '', attachments: [...full, attachment('z')] })
    expect(stuck.moved).toBe(false)
    expect(stuck.source.attachments).toEqual([attachment('c')])
    expect(mergeMovedDraft({ message: '', attachments: [] }, { message: 'there', attachments: [] }).moved).toBe(false)
  })

  it('moves a stored draft in one step and writes both sides at once', () => {
    const { store, values } = memoryStore()
    const from = composerDraftKey('p', 'old'), to = composerDraftKey('p', 'new')
    store.update(from, () => ({ message: 'typing when it handed off', attachments: [attachment('a')] }))
    expect(store.move(from, to, 6)).toEqual({ caret: 6, moved: true })
    expect(store.get(to)).toMatchObject({ message: 'typing when it handed off', attachments: [attachment('a')] })
    expect(store.get(from).message).toBe('')
    expect(store.hasUnsaved()).toBe(false)
    expect(values.has(from)).toBe(false)
    expect(JSON.parse(values.get(to)!).message).toBe('typing when it handed off')
    // Moving again finds nothing to move and leaves the successor's draft alone.
    expect(store.move(from, to, 0)).toEqual({ caret: 'typing when it handed off'.length, moved: false })
    expect(store.get(to).message).toBe('typing when it handed off')
  })

  it('keeps an anonymous draft out of storage when it moves', () => {
    const { store, values } = memoryStore()
    const from = composerDraftKey('p', 'old'), to = composerDraftKey('p', 'new')
    store.keepInMemory(from)
    store.update(from, () => ({ message: 'secret', attachments: [] }))
    store.move(from, to)
    expect(store.get(to).message).toBe('secret')
    expect(values.size).toBe(0)
  })

  it('tracks a follow from predecessor to successor until the successor takes it', () => {
    const follow: SuccessionFollow = { projectId: 'p', fromSessionId: 'old', toSessionId: 'new', focus: true, caret: () => 3 }
    const cancel = beginSuccessionFollow(follow)
    expect(successionFollowInto('p', 'new')).toBe(follow)
    expect(successionFollowFrom('p', 'old')).toBe(follow)
    expect(successionFollowInto('other', 'new')).toBeUndefined()
    // A switch that did not happen forgets the follow; the draft never moved.
    cancel()
    expect(successionFollowInto('p', 'new')).toBeUndefined()
    // A delivered follow is not cancelled: the words are already over there.
    const delivered: SuccessionFollow = { ...follow, delivered: { caret: 3, moved: true } }
    const cancelDelivered = beginSuccessionFollow(delivered)
    cancelDelivered()
    expect(successionFollowInto('p', 'new')).toBe(delivered)
    finishSuccessionFollow(delivered)
    expect(successionFollowFrom('p', 'old')).toBeUndefined()
  })

  it('tells a successor pane that is already showing that the draft arrived', () => {
    const listener = vi.fn()
    expect(hasSuccessionArrivalListener('p', 'new')).toBe(false)
    const off = subscribeSuccessionArrival('p', 'new', listener)
    expect(hasSuccessionArrivalListener('p', 'new')).toBe(true)
    notifySuccessionArrival('p', 'other')
    notifySuccessionArrival('p', 'new')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    expect(hasSuccessionArrivalListener('p', 'new')).toBe(false)
  })

  it('moves the draft exactly once whichever side gets there first, and puts the caret where the owner was', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true })
    vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' })
    vi.resetModules()
    try {
      const drafts = await import('./use-composer-draft')
      const follows = await import('./succession-follow')
      const key = (session: string) => composerDraftKey('p', session)
      values.set(key('old'), JSON.stringify({ version: 1, revision: 'r', message: 'keep typing', attachments: [] }))
      // The predecessor leaves first (the usual tab switch): its cleanup moves the draft, then
      // the successor pane mounts and takes the caret.
      const follow: SuccessionFollow = { projectId: 'p', fromSessionId: 'old', toSessionId: 'new', focus: true, caret: () => 4 }
      follows.beginSuccessionFollow(follow)
      expect(drafts.hasComposerDraft('p', 'new')).toBe(false)
      const arrived = vi.fn()
      const off = follows.subscribeSuccessionArrival('p', 'new', arrived)
      expect(drafts.deliverSuccessionDraft(follow)).toEqual({ caret: 4, moved: true })
      expect(arrived).toHaveBeenCalledTimes(1)
      expect(drafts.deliverSuccessionDraft(follow)).toEqual({ caret: 4, moved: true })
      expect(arrived).toHaveBeenCalledTimes(1)
      expect(drafts.hasComposerDraft('p', 'old')).toBe(false)
      expect(JSON.parse(values.get(key('new'))!).message).toBe('keep typing')
      expect(drafts.receiveSuccessionDraft('p', 'new')).toEqual({ caret: 4 })
      // Taken: a second mount finds nothing.
      expect(drafts.receiveSuccessionDraft('p', 'new')).toBeNull()
      off()
      // The successor mounts first: it moves the draft itself; the predecessor's later cleanup finds no follow.
      values.set(key('a'), JSON.stringify({ version: 1, revision: 'r', message: 'second', attachments: [] }))
      follows.beginSuccessionFollow({ projectId: 'p', fromSessionId: 'a', toSessionId: 'b', focus: false, caret: () => null })
      expect(drafts.receiveSuccessionDraft('p', 'b')).toEqual({ caret: 'second'.length })
      expect(follows.successionFollowFrom('p', 'a')).toBeUndefined()
      // Not typing and nothing to move: the successor does not grab the focus.
      follows.beginSuccessionFollow({ projectId: 'p', fromSessionId: 'c', toSessionId: 'd', focus: false, caret: () => null })
      expect(drafts.receiveSuccessionDraft('p', 'd')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('keeps the predecessor composer editable and lets the arriving composer take keys before it is ready', () => {
    const pane = readFileSync(new URL('./StructuredAgentPane.tsx', import.meta.url), 'utf8')
    const disabled = pane.match(/<ComposerTextarea [^\n]*? disabled=\{([^}]*)\}/)?.[1]
    expect(disabled).toBeDefined()
    expect(disabled).not.toContain('succession')
    expect(disabled).toContain('(!ready && !arriving)')
    // The predecessor sends nothing itself: Enter and the banner take the draft along.
    expect(pane).toContain('if (succession) { followSuccession(succession); return }')
    expect(pane).toContain('onOpen={() => followSuccession(succession)}')
    // Leaving moves the draft in a layout cleanup, ahead of the successor pane's layout effects.
    expect(pane).toMatch(/useLayoutEffect\(\(\) => \(\) => \{\s*const follow = successionFollowFrom/)
  })
})
