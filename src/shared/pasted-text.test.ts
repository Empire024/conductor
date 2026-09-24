import { describe, expect, it } from 'vitest'
import type { ContextAttachment } from './structured-agent'
import { FOLD_MIN_CHARS, MESSAGE_MAX_CHARS, PASTED_TEXT_MAX_CHARS, PASTED_TEXT_PREFIX, foldInsertedText, foldOversizedMessage, insertedRange, isPastedText, lineCount, mayFoldInput, removePastedText, shouldFoldText, unfoldPastedText } from './pasted-text'

const lines = (count: number): string => Array.from({ length: count }, (_, index) => 'line ' + (index + 1)).join('\n')

describe('pasted text folding', () => {
  it('folds only a long run of text, by characters or by lines', () => {
    expect(shouldFoldText('short')).toBe(false)
    expect(shouldFoldText('x'.repeat(FOLD_MIN_CHARS))).toBe(false)
    expect(shouldFoldText('x'.repeat(FOLD_MIN_CHARS + 1))).toBe(true)
    expect(shouldFoldText(lines(30))).toBe(false)
    expect(shouldFoldText(lines(31))).toBe(true)
    expect(lineCount('')).toBe(0)
    expect(lineCount('a\r\nb\rc\nd')).toBe(4)
  })

  it('finds the inserted run between two drafts', () => {
    expect(insertedRange('ab', 'aXYZb')).toEqual({ start: 1, end: 4 })
    expect(insertedRange('', 'new')).toEqual({ start: 0, end: 3 })
    expect(insertedRange('abc', 'abcd')).toEqual({ start: 3, end: 4 })
    expect(insertedRange('abcd', 'abd')).toEqual({ start: 2, end: 2 })
  })

  it('replaces a long paste with its placeholder where it landed and carries it as context', () => {
    const paste = lines(612)
    const result = foldInsertedText('Fix this: \n\nthanks', 'Fix this: ' + paste + '\n\nthanks', [], 'one')
    expect(result.folded).toBe(true)
    if (!result.folded) return
    expect(result.attachment).toEqual({ id: PASTED_TEXT_PREFIX + 'one', kind: 'selection', name: 'Pasted text #1: 612 lines', content: paste })
    expect(result.message).toBe('Fix this: [Pasted text #1: 612 lines]\n\nthanks')
    expect(result.caret).toBe('Fix this: [Pasted text #1: 612 lines]'.length)
    expect(isPastedText(result.attachment)).toBe(true)
  })

  it('numbers a second paste after the first and leaves ordinary typing alone', () => {
    const first: ContextAttachment = { id: PASTED_TEXT_PREFIX + 'a', kind: 'selection', name: 'Pasted text #1: 40 lines', content: lines(40) }
    const second = foldInsertedText('[Pasted text #1: 40 lines] ', '[Pasted text #1: 40 lines] ' + 'y'.repeat(31_000), [first], 'b')
    expect(second.folded && second.attachment.name).toBe('Pasted text #2: 1 line')
    expect(foldInsertedText('x'.repeat(5_000), 'x'.repeat(5_000) + 'z', [])).toEqual({ folded: false })
  })

  it('refuses a paste too large for one attachment, or one more than the attachment cap', () => {
    const huge = foldInsertedText('', 'x'.repeat(PASTED_TEXT_MAX_CHARS + 1), [])
    expect(huge).toMatchObject({ folded: false, error: expect.stringMatching(/128,000/) })
    const full = Array.from({ length: 20 }, (_, index): ContextAttachment => ({ id: 'f' + index, kind: 'file', name: 'f' + index }))
    expect(foldInsertedText('', lines(50), full)).toMatchObject({ folded: false, error: expect.stringMatching(/20 attachments/) })
  })

  it('unfolds a paste back into the message at its placeholder, or at the end if the placeholder is gone', () => {
    const paste: ContextAttachment = { id: PASTED_TEXT_PREFIX + 'a', kind: 'selection', name: 'Pasted text #1: 2 lines', content: 'one\ntwo' }
    const file: ContextAttachment = { id: 'file', kind: 'file', name: 'notes.md', path: 'notes.md' }
    expect(unfoldPastedText('see [Pasted text #1: 2 lines] now', [file, paste])).toEqual({ message: 'see one\ntwo now', attachments: [file] })
    expect(unfoldPastedText('see above', [paste])).toEqual({ message: 'see above\n\none\ntwo', attachments: [] })
    expect(unfoldPastedText('see above', [paste], 'other')).toEqual({ message: 'see above', attachments: [paste] })
  })

  it('removes a pasted chip together with its placeholder', () => {
    const paste: ContextAttachment = { id: PASTED_TEXT_PREFIX + 'a', kind: 'selection', name: 'Pasted text #1: 2 lines', content: 'one\ntwo' }
    expect(removePastedText('see [Pasted text #1: 2 lines] now', [paste], paste.id)).toEqual({ message: 'see  now', attachments: [] })
    const selection: ContextAttachment = { id: 'sel', kind: 'selection', name: 'a.ts', content: 'x' }
    expect(removePastedText('[a.ts]', [selection], 'sel')).toEqual({ message: '[a.ts]', attachments: [] })
    expect(isPastedText(selection)).toBe(false)
  })

  it('sends a draft past the per-message ceiling as pasted context', () => {
    expect(foldOversizedMessage('x'.repeat(MESSAGE_MAX_CHARS), [])).toBeUndefined()
    const folded = foldOversizedMessage('x'.repeat(MESSAGE_MAX_CHARS + 1), [], 'big')
    expect(folded).toEqual({ message: '[Pasted text #1: 1 line]', attachment: { id: PASTED_TEXT_PREFIX + 'big', kind: 'selection', name: 'Pasted text #1: 1 line', content: 'x'.repeat(MESSAGE_MAX_CHARS + 1) } })
  })

  it('decides in constant time whether an edit could fold, so typing never diffs the draft', () => {
    const draft = 'x'.repeat(40_000)
    expect(mayFoldInput('insertText', 'a', draft.length, draft.length + 1)).toBe(false)
    expect(mayFoldInput('insertCompositionText', 'ka', draft.length, draft.length + 2)).toBe(false)
    expect(mayFoldInput('deleteContentBackward', null, draft.length, draft.length - 1)).toBe(false)
    expect(mayFoldInput('insertLineBreak', null, draft.length, draft.length + 1)).toBe(false)
    expect(mayFoldInput('insertFromPaste', null, draft.length, draft.length + 5)).toBe(true)
    expect(mayFoldInput('insertFromDrop', null, draft.length, draft.length)).toBe(true)
    expect(mayFoldInput('historyUndo', null, draft.length, draft.length)).toBe(true)
    expect(mayFoldInput(undefined, undefined, draft.length, draft.length + 1)).toBe(true)
    // Text inserted in one event (an IME commit, dictation, a text expander) still folds, even
    // when it replaces a selection and the draft barely grows.
    expect(mayFoldInput('insertText', lines(31), draft.length, draft.length + 1)).toBe(true)
    // Programmatic insertion arrives as one small input event per line; the composer sees the
    // whole run as one change against the draft it last rendered.
    expect(mayFoldInput('insertText', 'line 31', draft.length, draft.length + lines(31).length)).toBe(true)
    expect(mayFoldInput('insertLineBreak', null, draft.length, draft.length + lines(31).length)).toBe(true)
    // Nothing shorter than the smallest foldable run can fold, whatever it contains.
    const shortest = '\n'.repeat(30)
    expect(shouldFoldText(shortest)).toBe(true)
    expect(shouldFoldText(shortest.slice(1))).toBe(false)
    expect(mayFoldInput('insertText', shortest.slice(1), 0, 29)).toBe(false)
    expect(mayFoldInput('insertText', shortest, 0, 30)).toBe(true)
  })
})
