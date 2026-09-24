import type { TimelineItem } from './structured-agent'

/** A page of conversation activity older than what the renderer holds. The resident projection
 *  keeps the latest 2000 items; anything older only survives in the event journal, so a page is
 *  rebuilt there (src/main/conversation-history.ts) and handed over already filtered to what the
 *  timeline shows. `unavailable` means older activity existed but the journal no longer holds it. */
export interface ConversationHistoryPage { items: TimelineItem[]; hasMore: boolean; unavailable: boolean }
/** A find hit in journal-only history: the same shape the renderer's own matches have. */
export interface ConversationHistoryHit { itemId: string; sequence: number; matches: number }
export interface ConversationTranscript { markdown: string; messages: number; olderUnavailable: boolean }
export interface ConversationHistoryBridge {
  /** Activities strictly older than `before` (a timeline sequence), newest `limit` of them. */
  page(id: string, before: number, limit?: number): Promise<ConversationHistoryPage>
  /** Message find over the journal-only part of a conversation; the renderer searches the rest. */
  search(id: string, query: string): Promise<ConversationHistoryHit[]>
  /** The whole stored conversation as Markdown, built from the store rather than the DOM. */
  transcript(id: string): Promise<ConversationTranscript>
}
