import { describe, expect, it } from 'vitest'
import { followsBottomAfterScroll, hasTimelineSelection, isAtConversationBottom, latestOwnerPrompt, truncatePromptPreview, type ScrollGeometry } from './conversation-scroll'
import type { PromptOrigin, TimelineItem } from '../../../shared/structured-agent'

const geometry = (distanceFromBottom: number, scrollHeight = 1000, clientHeight = 500): ScrollGeometry =>
  ({ scrollHeight, clientHeight, scrollTop: scrollHeight - clientHeight - distanceFromBottom })

describe('isAtConversationBottom', () => {
  it('treats the loose 80px band as bottom and anything past it as not', () => {
    expect(isAtConversationBottom(geometry(0))).toBe(true)
    expect(isAtConversationBottom(geometry(79))).toBe(true)
    expect(isAtConversationBottom(geometry(80))).toBe(false)
    expect(isAtConversationBottom(geometry(200))).toBe(false)
  })
})

describe('followsBottomAfterScroll', () => {
  it('keeps following while still inside the loose band', () => {
    expect(followsBottomAfterScroll(true, geometry(0))).toBe(true)
    expect(followsBottomAfterScroll(true, geometry(79))).toBe(true)
  })

  it('releases following once a real scroll moves past the loose band', () => {
    expect(followsBottomAfterScroll(true, geometry(80))).toBe(false)
    expect(followsBottomAfterScroll(true, geometry(400))).toBe(false)
  })

  it('does not let a small wheel tick that still lands inside the loose band re-engage a deliberate release', () => {
    // Regression: the wheel handler sets nearBottom=false on any upward tick, then the resulting
    // scroll event used to recompute nearBottom with the same 80px band, immediately flipping it
    // back to true and yanking the view back down on the next streamed token.
    expect(followsBottomAfterScroll(false, geometry(50))).toBe(false)
    expect(followsBottomAfterScroll(false, geometry(5))).toBe(false)
  })

  it('resumes following only once the user actually scrolls back to the end', () => {
    expect(followsBottomAfterScroll(false, geometry(3))).toBe(true)
    expect(followsBottomAfterScroll(false, geometry(0))).toBe(true)
    expect(followsBottomAfterScroll(false, geometry(4))).toBe(false)
  })

  it('lets a user who scrolled away drift further without ever snapping back on its own', () => {
    let following = false
    for (const distance of [10, 30, 60, 90, 60, 30, 10]) following = followsBottomAfterScroll(following, geometry(distance))
    expect(following).toBe(false)
    following = followsBottomAfterScroll(following, geometry(0))
    expect(following).toBe(true)
  })
})

let sequence = 0
const userText = (id: string, text: string, origin?: PromptOrigin): TimelineItem =>
  ({ id, runtimeId: 'r', sequence: sequence++, timestamp: '', data: { type: 'text', role: 'user', text, mode: 'snapshot', origin } })
const assistantText = (id: string, text: string): TimelineItem =>
  ({ id, runtimeId: 'r', sequence: sequence++, timestamp: '', data: { type: 'text', role: 'assistant', text, mode: 'snapshot' } })
const toolItem = (id: string): TimelineItem =>
  ({ id, runtimeId: 'r', sequence: sequence++, timestamp: '', data: { type: 'tool', name: 'bash', status: 'completed' } })

describe('latestOwnerPrompt', () => {
  it('finds nothing before the owner has sent a message', () => {
    expect(latestOwnerPrompt([])).toBeNull()
    expect(latestOwnerPrompt([assistantText('a1', 'hello'), toolItem('t1')])).toBeNull()
  })

  it('picks the most recent owner message, not an earlier one or a reply after it', () => {
    const items = [userText('u1', 'first question'), assistantText('a1', 'reply'), userText('u2', 'second question'), assistantText('a2', 'reply 2')]
    expect(latestOwnerPrompt(items)?.id).toBe('u2')
    expect(latestOwnerPrompt(items)?.text).toBe('second question')
  })

  it('skips prompts dispatched by another tab through app control', () => {
    const items = [userText('u1', 'typed here'), userText('u2', 'sent from elsewhere', { agentSessionId: 's', label: 'Other tab' })]
    expect(latestOwnerPrompt(items)?.id).toBe('u1')
  })

  it('ignores assistant and tool activity even when they are last', () => {
    const items = [userText('u1', 'only prompt'), assistantText('a1', 'reply'), toolItem('t1')]
    expect(latestOwnerPrompt(items)?.id).toBe('u1')
  })
})

describe('truncatePromptPreview', () => {
  it('leaves short, single-line text untouched', () => {
    expect(truncatePromptPreview('fix the bug')).toBe('fix the bug')
  })

  it('collapses internal whitespace so a pasted multi-line prompt reads as one line', () => {
    expect(truncatePromptPreview('line one\n\nline two\tindented')).toBe('line one line two indented')
  })

  it('trims surrounding whitespace', () => {
    expect(truncatePromptPreview('  padded  ')).toBe('padded')
  })

  it('cuts to the budget and appends an ellipsis when text is longer', () => {
    const long = 'a'.repeat(200)
    const result = truncatePromptPreview(long)
    expect(result).toBe('a'.repeat(160) + '…')
    expect(result.length).toBe(161)
  })

  it('honors a custom limit', () => {
    expect(truncatePromptPreview('abcdefghij', 5)).toBe('abcde…')
  })

  it('does not leave a dangling space before the ellipsis', () => {
    expect(truncatePromptPreview('abcde fghij', 6)).toBe('abcde…')
  })
})

describe('hasTimelineSelection', () => {
  const inside = {} as Node, outside = {} as Node
  const timeline = { contains: (node: Node | null) => node === inside } as HTMLElement
  const selection = (anchorNode: Node, isCollapsed: boolean, text: string) => {
    let serialized = 0
    return { value: { anchorNode, focusNode: anchorNode, isCollapsed, toString: () => { serialized++; return text } } as unknown as Selection, serialized: () => serialized }
  }
  it('never serializes a caret or a selection outside the timeline, which would force a layout per keystroke', () => {
    const caret = selection(inside, true, '')
    const elsewhere = selection(outside, false, 'composer text')
    expect(hasTimelineSelection(timeline, caret.value)).toBe(false)
    expect(hasTimelineSelection(timeline, elsewhere.value)).toBe(false)
    expect(caret.serialized() + elsewhere.serialized()).toBe(0)
  })
  it('does not read the selection at all while a text field such as the composer has focus', () => {
    const touched: string[] = []
    const spy = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); return undefined } }) as Selection
    const focusedComposer = { contains: () => true, ownerDocument: { activeElement: { tagName: 'TEXTAREA' } } } as unknown as HTMLElement
    expect(hasTimelineSelection(focusedComposer, spy)).toBe(false)
    expect(touched).toEqual([])
  })
  it('reports a real selection of timeline text, and not an empty one', () => {
    expect(hasTimelineSelection(timeline, selection(inside, false, 'selected words').value)).toBe(true)
    expect(hasTimelineSelection(timeline, selection(inside, false, '').value)).toBe(false)
    expect(hasTimelineSelection(null, selection(inside, false, 'selected words').value)).toBe(false)
  })
})
