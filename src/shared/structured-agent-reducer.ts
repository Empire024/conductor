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

/** Pure replay: no clock, random IDs, provider calls, filesystem reads, or effects. */
export function projectAgentEvent(state: SessionProjection, event: AgentEvent): SessionProjection {
  if (event.sessionId !== state.sessionId || event.sequence <= state.sequence) return state
  let next = { ...state, sequence: event.sequence, runtimeId: event.runtimeId, nativeSessionId: state.nativeSessionId ?? event.nativeSessionId }
  if (event.data.type === 'queue') {
    const queuedPrompts = event.data.prompts ?? (event.data.prompt ? [event.data.prompt] : [])
    return { ...next, queued: queuedPrompts[0] ?? null, queuedPrompts }
  }
  if (event.data.type === 'session') {
    next.phase = event.data.phase
    next.view = event.data.view ?? next.view
    next.nativeSessionId = event.data.nativeSessionId ?? next.nativeSessionId
    next.capabilities = event.data.capabilities ?? next.capabilities
    next.title = event.data.title ?? next.title
    next.archived = event.data.archived ?? next.archived
    next.settings = event.data.settings ?? next.settings
    if (['failed', 'disconnected', 'interrupted', 'completed'].includes(next.phase)) {
      next.items = state.items.map(item => {
        if (item.data.type === 'interaction' && item.data.interaction.status === 'pending') return { ...item, data: { ...item.data, interaction: { ...item.data.interaction, status: 'expired' as const } } }
        if (item.data.type === 'tool' && ['running', 'preparing', 'awaiting_approval'].includes(item.data.status)) return { ...item, data: { ...item.data, status: 'interrupted' as const } }
        return item
      })
    }
    return next
  }
  const identity = event.data.type === 'interaction' ? event.requestId : event.itemId
  const id = identity ? JSON.stringify(event.data.type === 'interaction'
    ? [event.runtimeId, identity, event.data.type]
    : [event.runtimeId, event.nativeSessionId ?? state.nativeSessionId ?? '', event.turnId ?? '', identity, event.data.type]) : event.id
  let index = next.items.findIndex(item => item.id === id)
  // Claude can reveal its root session ID only after text has begun streaming.
  // Reconcile that initial item without merging explicitly identified child conversations.
  if (index < 0 && identity && event.provider === 'claude' && event.nativeSessionId && (!state.nativeSessionId || event.nativeSessionId === state.nativeSessionId)) {
    const initialId = JSON.stringify([event.runtimeId, '', event.turnId ?? '', identity, event.data.type])
    index = next.items.findIndex(item => item.id === initialId && item.parentId === event.parentId)
  }
  const existing = next.items[index]
  const item: TimelineItem = {
    id, runtimeId: event.runtimeId, turnId: event.turnId, nativeItemId: event.itemId, parentId: event.parentId,
    sequence: existing?.sequence ?? event.sequence, updatedSequence: event.sequence, timestamp: existing?.timestamp ?? event.timestamp,
    data: bound(existing ? reconcile(existing.data, event.data) : event.data)
  }
  next.items = index < 0 ? [...next.items, item] : next.items.map((entry, i) => i === index ? item : entry)
  if (next.items.length > MAX_TIMELINE_ITEMS) { next.items = next.items.slice(-MAX_TIMELINE_ITEMS); next.truncated = true }
  if (event.data.type === 'text' && event.data.role === 'user' && !next.title) next.title = event.data.text.replace(/\s+/g, ' ').slice(0, 80)
  return next
}

export const replayAgentEvents = (sessionId: string, events: AgentEvent[]): SessionProjection => events.reduce(projectAgentEvent, emptyProjection(sessionId))
