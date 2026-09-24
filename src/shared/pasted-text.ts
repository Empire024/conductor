import type { ContextAttachment } from './structured-agent'

/** A long paste rides beside the message as attached context instead of inline, the way the
 *  Claude CLI folds one into a "[Pasted text]" placeholder. It is an ordinary `selection`
 *  attachment carrying its own content, so structured-sessions expands it for the provider
 *  exactly like other attached context and the timeline keeps it as an attachment; only the id
 *  prefix marks it as pasted. */
export const PASTED_TEXT_PREFIX = 'pasted-text:'
export const FOLD_MIN_CHARS = 2_000
export const FOLD_MIN_LINES = 30
/** structured-sessions expands one attachment's content up to this many characters. */
export const PASTED_TEXT_MAX_CHARS = 128_000
/** structured-sessions refuses the typed message itself (not its attachments) past this length. */
export const MESSAGE_MAX_CHARS = 60_000

export type PastedTextAttachment = ContextAttachment & { kind: 'selection'; content: string }

export const lineCount = (text: string): number => text ? text.split(/\r\n|\r|\n/).length : 0
export const shouldFoldText = (text: string): boolean => text.length > FOLD_MIN_CHARS || lineCount(text) > FOLD_MIN_LINES
export const isPastedText = (attachment: Pick<ContextAttachment, 'id' | 'kind'>): boolean =>
  attachment.kind === 'selection' && attachment.id.startsWith(PASTED_TEXT_PREFIX)
export const pastedTextPlaceholder = (attachment: Pick<ContextAttachment, 'name'>): string => `[${attachment.name}]`

const pastedNumber = (name: string): number => Number(/^Pasted text #(\d+)/.exec(name)?.[1] ?? 0)

/** The attachment a paste becomes, numbered after the pastes already in the draft. */
export function pastedTextAttachment(text: string, existing: Pick<ContextAttachment, 'id' | 'kind' | 'name'>[], id: string = crypto.randomUUID()): PastedTextAttachment {
  const number = 1 + Math.max(0, ...existing.filter(isPastedText).map(item => pastedNumber(item.name)))
  const lines = lineCount(text)
  return { id: PASTED_TEXT_PREFIX + id, kind: 'selection', name: `Pasted text #${number}: ${lines.toLocaleString('en-US')} line${lines === 1 ? '' : 's'}`, content: text }
}

/** The shortest run that can fold: more than FOLD_MIN_LINES lines take FOLD_MIN_LINES line breaks. */
const FOLDABLE_MIN_CHARS = Math.min(FOLD_MIN_CHARS + 1, FOLD_MIN_LINES)

const TYPING_INPUTS = new Set(['insertText', 'insertCompositionText', 'insertLineBreak', 'insertParagraph'])

/** Whether a composer edit could have inserted a foldable run, decided in constant time so an
 *  ordinary keystroke never diffs the whole draft. Pastes, drops, undo/redo and anything
 *  unrecognised take the full check. Typing, IME, line breaks and deletions take it only when the
 *  event itself carries a foldable run or the draft grew by one since it was last rendered: text
 *  inserted programmatically (dictation, a text expander, an automation's insertText) arrives as
 *  one small input event per line, which the composer sees as a single change. */
export function mayFoldInput(inputType: string | undefined, data: string | null | undefined, previousLength: number, nextLength: number): boolean {
  if (!inputType || !(TYPING_INPUTS.has(inputType) || inputType.startsWith('delete'))) return true
  return nextLength - previousLength >= FOLDABLE_MIN_CHARS || typeof data === 'string' && data.length >= FOLDABLE_MIN_CHARS
}

/** Where `next` differs from `previous` as one inserted run: [start, end) in `next`. */
export function insertedRange(previous: string, next: string): { start: number; end: number } {
  let start = 0
  const shortest = Math.min(previous.length, next.length)
  while (start < shortest && previous[start] === next[start]) start++
  let suffix = 0
  while (suffix < shortest - start && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  return { start, end: next.length - suffix }
}

export type FoldResult =
  | { folded: false }
  | { folded: true; message: string; caret: number; attachment: PastedTextAttachment }
  | { folded: false; error: string }

/** A composer edit that inserted a long run of text (a paste, a drop) folds that run into an
 *  attachment and leaves its placeholder where it landed. Ordinary typing never folds. */
export function foldInsertedText(previous: string, next: string, attachments: Pick<ContextAttachment, 'id' | 'kind' | 'name'>[], id?: string): FoldResult {
  const { start, end } = insertedRange(previous, next)
  const inserted = next.slice(start, end)
  if (!shouldFoldText(inserted)) return { folded: false }
  if (inserted.length > PASTED_TEXT_MAX_CHARS) return { folded: false, error: `The pasted text is ${inserted.length.toLocaleString('en-US')} characters; one pasted attachment holds up to ${PASTED_TEXT_MAX_CHARS.toLocaleString('en-US')}. Paste it in parts or save it to a project file and attach that.` }
  if (attachments.length >= 20) return { folded: false, error: 'A prompt can have up to 20 attachments. Remove one before pasting more long text.' }
  const attachment = pastedTextAttachment(inserted, attachments, id)
  const placeholder = pastedTextPlaceholder(attachment)
  return { folded: true, message: next.slice(0, start) + placeholder + next.slice(end), caret: start + placeholder.length, attachment }
}

/** Puts pasted attachments back into the message as plain text, where their placeholders
 *  stand (or at the end when the owner deleted the placeholder). `only` restores just one. */
export function unfoldPastedText<T extends ContextAttachment>(message: string, attachments: T[], only?: string): { message: string; attachments: T[] } {
  let text = message
  const kept: T[] = []
  for (const attachment of attachments) {
    if (!isPastedText(attachment) || (only !== undefined && attachment.id !== only) || typeof attachment.content !== 'string') { kept.push(attachment); continue }
    const placeholder = pastedTextPlaceholder(attachment)
    const at = text.indexOf(placeholder)
    text = at >= 0 ? text.slice(0, at) + attachment.content + text.slice(at + placeholder.length) : (text ? text + '\n\n' : '') + attachment.content
  }
  return { message: text, attachments: kept }
}

/** Removing a pasted chip also removes its placeholder, so the message does not point at
 *  context that is no longer attached. */
export function removePastedText<T extends ContextAttachment>(message: string, attachments: T[], id: string): { message: string; attachments: T[] } {
  const target = attachments.find(item => item.id === id)
  const rest = attachments.filter(item => item.id !== id)
  if (!target || !isPastedText(target)) return { message, attachments: rest }
  const placeholder = pastedTextPlaceholder(target)
  const at = message.indexOf(placeholder)
  return { message: at >= 0 ? message.slice(0, at) + message.slice(at + placeholder.length) : message, attachments: rest }
}

/** A draft typed or assembled past the per-message ceiling is sent as a pasted attachment
 *  rather than refused. Returns undefined when the message already fits. */
export function foldOversizedMessage(message: string, attachments: Pick<ContextAttachment, 'id' | 'kind' | 'name'>[], id?: string): { message: string; attachment: PastedTextAttachment } | undefined {
  const text = message.trim()
  if (text.length <= MESSAGE_MAX_CHARS || text.length > PASTED_TEXT_MAX_CHARS || attachments.length >= 20) return undefined
  const attachment = pastedTextAttachment(text, attachments, id)
  return { message: pastedTextPlaceholder(attachment), attachment }
}
