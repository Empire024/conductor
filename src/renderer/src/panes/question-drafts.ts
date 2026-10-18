import type { QuestionDraft } from './StructuredAgentRenderers'

/**
 * Half-typed answers to question cards, kept outside the card so they survive the card unmounting.
 * tab-keep-alive.ts unmounts an inactive conversation view on purpose (typing stays fast with many
 * tabs open), so a card's own state would be lost every time the owner switched tabs mid-answer.
 *
 * Memory only, never storage: an answer can be a secret (InputQuestion.isSecret), and a restart
 * already ends the request it answers. Keyed by conversation and timeline item, since a request id
 * alone can repeat across a provider's runtimes. Cleared when the answer is sent or discarded, or
 * when the card no longer has anything to keep.
 */
const drafts = new Map<string, QuestionDraft>()
/** Far more than any owner has half-answered at once; the oldest goes first past it. */
export const QUESTION_DRAFT_LIMIT = 200

export const questionDraftKey = (sessionId: string, itemId: string): string => JSON.stringify([sessionId, itemId])

export const questionDrafts = {
  get(key: string): QuestionDraft | undefined { return drafts.get(key) },
  set(key: string, draft: QuestionDraft): void {
    drafts.delete(key)
    drafts.set(key, draft)
    while (drafts.size > QUESTION_DRAFT_LIMIT) drafts.delete(drafts.keys().next().value!)
  },
  delete(key: string): void { drafts.delete(key) },
  /** For tests. */
  clear(): void { drafts.clear() },
  get size(): number { return drafts.size }
}
