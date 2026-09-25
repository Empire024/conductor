import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { recoverClaudeMessageDuplicates } from '../shared/claude-message-recovery'
import { isConversationActivity } from '../shared/conversation-activity'
import type { ConversationHistoryHit, ConversationHistoryPage, ConversationTranscript } from '../shared/conversation-history'
import { conversationMarkdown } from '../shared/conversation-transcript'
import { localModelLabel } from '../shared/local-models'
import type { AgentEvent, SessionProjection, TimelineItem } from '../shared/structured-agent'
import { emptyProjection, projectAgentEvent } from '../shared/structured-agent-reducer'
import type { StructuredAgentStore } from './structured-store'

type HistoryStore = Pick<StructuredAgentStore, 'snapshot' | 'spec' | 'journalFloor' | 'journalRange' | 'archive'>

/** Journal rows read per step. Each step is one primary-key range scan, and the loop yields to the
 *  event loop between steps, so rebuilding a long history never blocks the main process for long. */
const CHUNK = 1000
/** Events after the boundary that still belong to items which started before it (a message that
 *  was streaming, a tool that was running when the item after it began). */
const STRADDLE = 400
/** The reducer keeps at most 2000 items. A chunk can add at most CHUNK of them, so settling the
 *  older ones out of the running state at this size means it never truncates what we rebuild. */
const SETTLE_AT = 800, KEEP_LIVE = 300
const PAGE_LIMIT = 250, MAX_HITS = 1000

/** Everything older than a conversation's resident projection, rebuilt from its journal.
 *  `boundary` is the resident projection's first item sequence when this was built; the running
 *  reducer state lets a later, larger boundary continue where this left off. */
interface Region {
  boundary: number
  floor: number
  cursor: number
  state: SessionProjection
  settled: TimelineItem[]
  settledIds: Set<string>
  claude: boolean
  items: TimelineItem[]
}

/** A saved conversation's items were live once; nothing in history is still pending or running. */
function historical(item: TimelineItem): TimelineItem {
  if (item.data.type === 'interaction' && item.data.interaction.status === 'pending') return { ...item, data: { ...item.data, interaction: { ...item.data.interaction, status: 'expired' } } }
  if (item.data.type === 'tool' && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status)) return { ...item, data: { ...item.data, status: 'interrupted' } }
  return item
}
const assistantName = (provider: string | undefined, model: string | undefined): string =>
  provider === 'claude' ? 'Claude Code' : provider === 'grok' ? 'Grok' : provider === 'local' ? localModelLabel(model) : 'Codex'

/** The durable transcript archive's live tail: reducer state for events not yet flushed to
 *  storage, plus items the reducer's own item cap would otherwise have dropped before a flush
 *  caught them - settled the same way {@link Region} settles a rebuild, just grown one event at a
 *  time from `StructuredAgentStore.append` instead of rebuilt from a journal range. */
export interface ArchiveTail { state: SessionProjection; settled: TimelineItem[]; settledIds: Set<string>; claude: boolean }
export const emptyArchiveTail = (id: string): ArchiveTail => ({ state: emptyProjection(id), settled: [], settledIds: new Set(), claude: false })

/** One more event into the archive tail, in memory. The store calls this on every append once a
 *  conversation has grown past the journal's retention window, so the archive never depends on
 *  the journal still holding an event by the time a checkpoint gets around to flushing it. */
export function growArchiveTail(tail: ArchiveTail, event: AgentEvent): ArchiveTail {
  const state = projectAgentEvent(tail.state, event)
  const claude = tail.claude || event.provider === 'claude'
  if (state.items.length <= SETTLE_AT) return { state, settled: tail.settled, settledIds: tail.settledIds, claude }
  const settled = tail.settled.slice(), settledIds = new Set(tail.settledIds)
  for (const item of state.items.slice(0, -KEEP_LIVE)) if (!settledIds.has(item.id)) { settled.push(item); settledIds.add(item.id) }
  return { state: { ...state, items: state.items.slice(-KEEP_LIVE) }, settled, settledIds, claude }
}

/** Everything in the tail below `deleteBelow`, ready to persist as the events they came from
 *  leave the journal for good, and the tail that is left once they are gone. Items already
 *  settled but not yet below the cut, and live items still below the reducer's own item cap, both
 *  carry forward into the remainder rather than being dropped: a flush only removes what it
 *  actually persists. */
export function settleArchiveTail(tail: ArchiveTail, deleteBelow: number): { items: TimelineItem[]; remainder: ArchiveTail } {
  const flush: TimelineItem[] = []
  const settled: TimelineItem[] = [], settledIds = new Set<string>()
  for (const item of tail.settled) (item.sequence < deleteBelow ? flush : settled).push(item)
  for (const item of settled) settledIds.add(item.id)
  // A settled item that a later event touched again was re-created in the running state from that
  // event alone; the settled copy above is the complete one, so its stale recreation here is
  // never re-emitted (mirrors the same rule `ConversationHistory.build` applies to a journal
  // rebuild).
  const liveItems = tail.state.items.filter(item => {
    if (tail.settledIds.has(item.id)) return false
    if (item.sequence < deleteBelow) { flush.push(item); return false }
    return true
  })
  const recovered = tail.claude ? recoverClaudeMessageDuplicates(flush) : flush
  const items = recovered.map(historical).filter(isConversationActivity)
  const remainder: ArchiveTail = { state: { ...tail.state, items: liveItems }, settled, settledIds, claude: tail.claude }
  return { items, remainder }
}

/**
 * Conversation history beyond the renderer's reach. The main process keeps each conversation's
 * latest 2000 items resident and the renderer holds exactly that projection; older activity
 * survives in the event journal only for the last 20,000 events of each conversation. Paging and
 * find read that journal-only part here, through primary-key range scans only: the journal is
 * multi-gigabyte, and no read may scan it by content. Once a conversation has grown past that
 * window, its transcript also draws on the durable transcript archive (`StructuredAgentStore`'s
 * `structured_transcript_archive*` tables): the compact, already-rendered items a checkpoint
 * persisted before deleting their events, so Copy transcript still starts at the very first
 * prompt no matter how long the conversation has grown.
 */
export class ConversationHistory {
  private regions = new Map<string, Region>()
  private building = new Map<string, Promise<Region | null>>()
  constructor(private store: HistoryStore, private pause: () => Promise<void> = () => new Promise(resolve => setImmediate(resolve))) {}

  async page(id: string, before: number, limit = PAGE_LIMIT): Promise<ConversationHistoryPage> {
    const region = await this.region(id)
    if (!region) return { items: [], hasMore: false, unavailable: false }
    const older = region.items.filter(item => item.sequence < before)
    const items = older.slice(-Math.max(1, Math.min(limit, 500)))
    const hasMore = older.length > items.length
    return { items, hasMore, unavailable: !hasMore && region.floor > 1 }
  }

  async search(id: string, query: string): Promise<ConversationHistoryHit[]> {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const region = await this.region(id)
    if (!region) return []
    const hits: ConversationHistoryHit[] = []
    for (const item of region.items) {
      if (item.data.type !== 'text' || !item.data.text) continue
      const haystack = item.data.text.toLocaleLowerCase()
      let matches = 0
      for (let cursor = haystack.indexOf(needle); cursor !== -1; cursor = haystack.indexOf(needle, cursor + needle.length)) matches++
      if (matches) hits.push({ itemId: item.id, sequence: item.sequence, matches })
      if (hits.length >= MAX_HITS) break
    }
    return hits
  }

  async transcript(id: string): Promise<ConversationTranscript> {
    const resident = this.store.snapshot(id)
    if (!resident) throw new Error('This conversation is no longer stored.')
    const region = await this.region(id)
    const archive = this.store.archive(id)
    const items = [...(archive?.items ?? []), ...(region?.items ?? []), ...resident.items.filter(isConversationActivity)]
    const spec = this.store.spec<{ provider?: string }>(id)
    const provider = resident.capabilities?.provider ?? spec?.provider
    // The archive's own coverage, when it exists, is the authoritative earliest sequence: it may
    // reach back to the very first event even though the journal alone (`region.floor`) no longer
    // does. Without an archive at all, the journal floor is all there is to go on.
    const earliest = archive ? archive.from : (region ? region.floor : 1)
    const missingEvents = Math.max(0, earliest - 1)
    const olderUnavailable = resident.truncated && missingEvents > 0
    const { markdown, messages } = conversationMarkdown(items, { title: resident.title, assistant: assistantName(provider, resident.settings.model), olderUnavailable: missingEvents })
    return { markdown, messages, olderUnavailable }
  }

  /** Null when the resident projection is the whole conversation. */
  private region(id: string): Promise<Region | null> {
    const pending = this.building.get(id)
    if (pending) return pending
    const task = this.build(id).finally(() => { if (this.building.get(id) === task) this.building.delete(id) })
    this.building.set(id, task)
    return task
  }

  private async build(id: string): Promise<Region | null> {
    const resident = this.store.snapshot(id)
    const first = resident?.items[0]
    if (!resident?.truncated || !first) return null
    const boundary = first.sequence
    const floor = this.store.journalFloor(id)
    if (floor === null || floor >= boundary) return { boundary, floor: floor ?? boundary, cursor: boundary, state: emptyProjection(id), settled: [], settledIds: new Set(), claude: false, items: [] }
    const cached = this.regions.get(id)
    if (cached && cached.boundary === boundary) return this.touch(id, cached)
    // A later boundary only means more items left the resident projection: keep reading from
    // where the cached rebuild stopped. Anything else (a fork, a trimmed journal) starts over.
    const region: Region = cached && cached.boundary < boundary && cached.floor <= floor ? cached
      : { boundary, floor, cursor: floor, state: emptyProjection(id), settled: [], settledIds: new Set(), claude: false, items: [] }
    const end = boundary + STRADDLE
    while (region.cursor < end) {
      const events = this.store.journalRange(id, region.cursor, end, CHUNK)
      if (!events.length) break
      for (const event of events) region.state = projectAgentEvent(region.state, event)
      region.claude ||= events[0]!.provider === 'claude'
      region.cursor = events.at(-1)!.sequence + 1
      if (region.state.items.length > SETTLE_AT) {
        const settle = region.state.items.slice(0, -KEEP_LIVE)
        for (const item of settle) if (!region.settledIds.has(item.id)) { region.settled.push(item); region.settledIds.add(item.id) }
        region.state = { ...region.state, items: region.state.items.slice(-KEEP_LIVE) }
      }
      if (events.length < CHUNK) break
      await this.pause()
    }
    region.boundary = boundary
    const residentIds = new Set(resident.items.map(item => item.id))
    // A settled item that a later event touched again was re-created in the running state from
    // that event alone; the settled copy is the complete one.
    const rebuilt = [...region.settled, ...region.state.items.filter(item => !region.settledIds.has(item.id))]
      .filter(item => item.sequence < boundary && !residentIds.has(item.id))
    const items = (region.claude ? recoverClaudeMessageDuplicates(rebuilt) : rebuilt).map(historical)
    region.items = items.filter(isConversationActivity)
    return this.touch(id, region)
  }

  /** Two conversations' rebuilt history at most: the one being read and the one before it. */
  private touch(id: string, region: Region): Region {
    this.regions.delete(id)
    this.regions.set(id, region)
    while (this.regions.size > 2) this.regions.delete(this.regions.keys().next().value!)
    return region
  }
}

export function registerConversationHistoryIpc(ipc: Pick<IpcMain, 'handle'>, history: ConversationHistory, guard: { trusted(event: IpcMainInvokeEvent): void; id(value: unknown): string }): void {
  ipc.handle('conversation-history:page', (event, id, before, limit) => {
    guard.trusted(event)
    if (!Number.isSafeInteger(before) || before < 0 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) throw new Error('Invalid history page')
    return history.page(guard.id(id), before, limit)
  })
  ipc.handle('conversation-history:search', (event, id, query) => {
    guard.trusted(event)
    if (typeof query !== 'string' || query.length > 500) throw new Error('Invalid search')
    return history.search(guard.id(id), query)
  })
  ipc.handle('conversation-history:transcript', (event, id) => { guard.trusted(event); return history.transcript(guard.id(id)) })
}
