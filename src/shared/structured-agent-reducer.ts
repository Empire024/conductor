import type { AgentEvent, AgentEventData, SessionProjection, TimelineItem } from './structured-agent'

export const MAX_TIMELINE_ITEMS = 2000
export const MAX_PREVIEW_CHARS = 64_000
export const emptyProjection = (sessionId: string): SessionProjection => ({ sessionId, runtimeId: '', phase: 'idle', sequence: 0, items: [], settings: { permission: 'default', plan: false }, title: '', archived: false, truncated: false })

function reconcile(previous: AgentEventData, next: AgentEventData): AgentEventData {
  if (previous.type === 'usage' && next.type === 'usage') return { ...previous, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) } as AgentEventData
  if (previous.type === 'text' && next.type === 'text') return { ...next, text: (next.mode === 'delta' ? previous.text + next.text : next.text).slice(-MAX_PREVIEW_CHARS) }
  if (previous.type === 'tool' && next.type === 'tool') return {
    ...previous, ...next,
    input: next.input ?? previous.input,
    inputDelta: next.input !== undefined ? undefined : ((previous.inputDelta ?? '') + (next.inputDelta ?? '')).slice(0, MAX_PREVIEW_CHARS),
    output: next.output === undefined ? previous.output : (next.outputMode === 'delta' ? (previous.output ?? '') + next.output : next.output).slice(-MAX_PREVIEW_CHARS)
  }
  return next
}
function bound(data: AgentEventData): AgentEventData {
  if (data.type === 'text') return { ...data, text: data.text.slice(-MAX_PREVIEW_CHARS) }
  if (data.type === 'tool') {
    const serialized = data.input === undefined ? '' : JSON.stringify(data.input)
    return { ...data, input: serialized.length > MAX_PREVIEW_CHARS ? { preview: serialized.slice(0, MAX_PREVIEW_CHARS), truncated: true, inspect: 'Full input is retained in the provider event journal' } : data.input, output: data.output?.slice(-MAX_PREVIEW_CHARS), stderr: data.stderr?.slice(-MAX_PREVIEW_CHARS), inputDelta: data.inputDelta?.slice(0, MAX_PREVIEW_CHARS) }
  }
  if (data.type === 'changes') return { ...data, changes: data.changes.map(change => ({ ...change, patch: change.patch?.slice(0, MAX_PREVIEW_CHARS) })) }
  if (data.type === 'notice' && data.payload && JSON.stringify(data.payload).length > MAX_PREVIEW_CHARS) return { ...data, payload: { preview: JSON.stringify(data.payload).slice(0, MAX_PREVIEW_CHARS), truncated: true } }
  return data
}

const settledPhases = new Set(['failed', 'disconnected', 'interrupted', 'completed'])
/** A turn that ended leaves nothing waiting on it: pending questions expire and running tools stop. */
function settleItem(item: TimelineItem): TimelineItem {
  if (item.data.type === 'interaction' && item.data.interaction.status === 'pending') return { ...item, data: { ...item.data, interaction: { ...item.data.interaction, status: 'expired' as const } } }
  if (item.data.type === 'tool' && !item.data.detached && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status)) return { ...item, data: { ...item.data, status: 'interrupted' as const } }
  return item
}
const accepts = (state: SessionProjection, event: AgentEvent): boolean => event.sessionId === state.sessionId && event.sequence > state.sequence
const advance = (state: SessionProjection, event: AgentEvent): SessionProjection => ({ ...state, sequence: event.sequence, runtimeId: event.runtimeId, nativeSessionId: state.nativeSessionId ?? event.nativeSessionId })
/** The projection after an event that changes no timeline item, or undefined for one that does. A
 *  session event that ends the turn also settles every item; that is left to the caller. */
function projectHeader(state: SessionProjection, event: AgentEvent): SessionProjection | undefined {
  const next = advance(state, event)
  if (event.data.type === 'steering') return { ...next, pendingSteering: event.data.prompts }
  if (event.data.type === 'input_delivery') return next // The host reconciles receipts with its captured input.
  if (event.data.type === 'queue') {
    const queuedPrompts = event.data.prompts ?? (event.data.prompt ? [event.data.prompt] : [])
    return { ...next, queued: queuedPrompts[0] ?? null, queuedPrompts }
  }
  if (event.data.type !== 'session') return undefined
  if (event.data.phase === 'disconnected' || event.runtimeId !== state.runtimeId) next.pendingSteering = next.pendingSteering?.map(input => ['sending', 'accepted'].includes(input.status) ? { ...input, status: 'uncertain' as const } : input)
  next.phase = event.data.phase
  next.view = event.data.view ?? next.view
  next.nativeSessionId = event.data.nativeSessionId ?? next.nativeSessionId
  next.capabilities = event.data.capabilities ?? next.capabilities
  next.title = event.data.title ?? next.title
  next.archived = event.data.archived ?? next.archived
  next.settings = event.data.settings ?? next.settings
  // Explicit null is the "window reopened" signal, so absent and null differ here.
  if (event.data.limitResumeAt !== undefined) next.limitResumeAt = event.data.limitResumeAt ?? undefined
  // Zero is the "the last background task drained" signal; absent leaves the count alone so a
  // provider that never reports one cannot erase another's.
  if (event.data.backgroundTasks !== undefined) next.backgroundTasks = event.data.backgroundTasks
  return next
}
/** The timeline id an item event updates, and the id the same item had before Claude revealed its
 *  root session (used only when no item has the first id yet). */
function itemIdentity(state: SessionProjection, event: AgentEvent): { id: string; initialId?: string } {
  const identity = event.data.type === 'interaction' ? event.requestId : event.itemId
  const id = identity ? JSON.stringify(event.data.type === 'interaction'
    ? [event.runtimeId, identity, event.data.type]
    : [event.runtimeId, event.nativeSessionId ?? state.nativeSessionId ?? '', event.turnId ?? '', identity, event.data.type]) : event.id
  // Claude can reveal its root session ID only after text has begun streaming.
  // Reconcile that initial item without merging explicitly identified child conversations.
  const initialId = identity && event.provider === 'claude' && event.nativeSessionId && (!state.nativeSessionId || event.nativeSessionId === state.nativeSessionId)
    ? JSON.stringify([event.runtimeId, '', event.turnId ?? '', identity, event.data.type]) : undefined
  return { id, initialId }
}
function projectItem(existing: TimelineItem | undefined, event: AgentEvent, id: string): TimelineItem {
  return {
    id, runtimeId: event.runtimeId, turnId: event.turnId, nativeItemId: event.itemId, parentId: event.parentId,
    sequence: existing?.sequence ?? event.sequence, updatedSequence: event.sequence, timestamp: existing?.timestamp ?? event.timestamp,
    data: bound(existing ? reconcile(existing.data, event.data) : event.data)
  }
}
function titled(next: SessionProjection, event: AgentEvent): SessionProjection {
  if (event.data.type === 'text' && event.data.role === 'user' && !next.title) next.title = event.data.text.replace(/\s+/g, ' ').slice(0, 80)
  return next
}

/** Pure replay: no clock, random IDs, provider calls, filesystem reads, or effects. */
export function projectAgentEvent(state: SessionProjection, event: AgentEvent): SessionProjection {
  if (!accepts(state, event)) return state
  const header = projectHeader(state, event)
  if (header) return event.data.type === 'session' && settledPhases.has(header.phase) ? { ...header, items: state.items.map(settleItem) } : header
  const next = advance(state, event)
  const { id, initialId } = itemIdentity(state, event)
  let index = next.items.findIndex(item => item.id === id)
  if (index < 0 && initialId) index = next.items.findIndex(item => item.id === initialId && item.parentId === event.parentId)
  const item = projectItem(next.items[index], event, id)
  next.items = index < 0 ? [...next.items, item] : next.items.map((entry, i) => i === index ? item : entry)
  if (next.items.length > MAX_TIMELINE_ITEMS) { next.items = next.items.slice(-MAX_TIMELINE_ITEMS); next.truncated = true }
  return titled(next, event)
}

/** The same projection as folding projectAgentEvent over the events, in O(items + events) rather
 *  than O(items) per event: the timeline is copied once and items are found through an id index. A
 *  renderer applying a fast stream (a reconnect replay, a tool flood) would otherwise rebuild a
 *  2,000-item array for every event and block input for seconds. */
export function projectAgentEvents(state: SessionProjection, events: readonly AgentEvent[]): SessionProjection {
  if (events.length < 2) return events.reduce(projectAgentEvent, state)
  let header = state
  let items: TimelineItem[] | undefined
  let positions: Map<string, number> | undefined
  // Items before this position fell off the capped timeline; they leave the index as they go.
  let start = 0
  const own = (): TimelineItem[] => {
    if (!items) { items = state.items.slice(); positions = new Map(items.map((item, position) => [item.id, position])) }
    return items
  }
  for (const event of events) {
    if (!accepts(header, event)) continue
    const projected = projectHeader(header, event)
    if (projected) {
      header = projected
      if (event.data.type === 'session' && settledPhases.has(projected.phase)) {
        const working = own()
        for (let position = start; position < working.length; position++) working[position] = settleItem(working[position]!)
      }
      continue
    }
    const working = own(), index = positions!
    const { id, initialId } = itemIdentity(header, event)
    let position = index.get(id)
    if (position === undefined && initialId) {
      const candidate = index.get(initialId)
      if (candidate !== undefined && working[candidate]!.parentId === event.parentId) position = candidate
    }
    const existing = position === undefined ? undefined : working[position]
    header = titled(advance(header, event), event)
    const item = projectItem(existing, event, id)
    if (position !== undefined) {
      if (existing!.id !== id) index.delete(existing!.id)
      working[position] = item
      index.set(id, position)
      continue
    }
    index.set(id, working.length)
    working.push(item)
    while (working.length - start > MAX_TIMELINE_ITEMS) { index.delete(working[start]!.id); start++; if (!header.truncated) header = { ...header, truncated: true } }
  }
  if (header === state) return state
  return { ...header, items: items ? (start ? items.slice(start) : items) : state.items }
}

export const replayAgentEvents = (sessionId: string, events: AgentEvent[]): SessionProjection => events.reduce(projectAgentEvent, emptyProjection(sessionId))
