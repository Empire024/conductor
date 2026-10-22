import type { AdapterEvent, AgentEventData, ProviderCapabilities } from '../shared/structured-agent'

/**
 * What keeps the event journal from paying a whole envelope for every streamed character
 * (conductor-task:db-growth-1022). Claude streams a tool's input as `input_json_delta` fragments of
 * a few bytes each, and every fragment became one journal row of ~580 bytes (ids, cwd, runtime,
 * timestamps): a 7 KB `control` call was 520 rows and 320 KB, and on 2026-10-22 two thirds of all
 * new rows were such fragments. Text deltas stream the same way.
 *
 * A streamed delta is held instead of journaled and grows by every following delta of the same
 * item; anything else from the conversation, or the end of the burst (the store flush), journals
 * it as one event. The reducer folds a merged delta exactly as it folds its parts (inputDelta and
 * delta text are concatenated), so the projection, the renderer and the phone see the same text.
 */

/** The identity a following delta must share to be merged into a held one, or null when the
 *  event is not a mergeable delta. Events that carry the provider's raw frame (`native`) are never
 *  merged: each frame is its own diagnostic record. */
export function streamedDeltaKey(event: AdapterEvent): string | null {
  if (event.native || event.requestId) return null
  const data = event.data
  if (data.type === 'tool') {
    if (data.status !== 'preparing' || typeof data.inputDelta !== 'string' || data.input !== undefined || data.output !== undefined || data.stderr !== undefined) return null
    return JSON.stringify(['tool', event.itemId ?? null, event.parentId ?? null, event.turnId ?? null, event.nativeSessionId ?? null, data.name, data.description ?? null, data.detached ?? null])
  }
  if (data.type === 'text' && data.mode === 'delta' && event.itemId) {
    const { text: _text, ...rest } = data
    return JSON.stringify(['text', event.itemId, event.parentId ?? null, event.turnId ?? null, event.nativeSessionId ?? null, rest])
  }
  return null
}

/** `held` with `next`'s delta appended; both must have the same {@link streamedDeltaKey}. */
export function mergeStreamedDelta(held: AdapterEvent, next: AdapterEvent): AdapterEvent {
  const a = held.data, b = next.data
  if (a.type === 'tool' && b.type === 'tool') return { ...held, data: { ...a, inputDelta: (a.inputDelta ?? '') + (b.inputDelta ?? '') } }
  if (a.type === 'text' && b.type === 'text') return { ...held, data: { ...a, text: a.text + b.text } }
  throw new Error('Only streamed deltas of one item merge')
}

/** How far back (in sequences) this runtime's journal must already state the current capabilities
 *  for a restatement to be dropped. Well inside the 20,000-event journal window, so weekly
 *  accounting, which reads the model from the newest session event that names one
 *  (`capabilities.effectiveSettings.model`), always still finds it in the journal. */
export const CAPABILITIES_RESTATE_EVERY = 5_000

/** A session event without a `capabilities` block identical to the one the projection already
 *  holds, when this runtime journaled that same block within {@link CAPABILITIES_RESTATE_EVERY}
 *  events. Claude restates its whole capability set (~3.5 KB of models and limitations) on every
 *  turn start; the reducer keeps the previous set when an event names none, so an unchanged
 *  restatement adds nothing to the projection and 3.5 KB to the journal each time. */
export function withoutRestatedCapabilities(data: AgentEventData, current: ProviderCapabilities | undefined, statedAt: number | undefined, sequence: number): AgentEventData {
  if (data.type !== 'session' || !data.capabilities || !current || statedAt === undefined) return data
  if (sequence - statedAt >= CAPABILITIES_RESTATE_EVERY) return data
  if (JSON.stringify(data.capabilities) !== JSON.stringify(current)) return data
  const { capabilities: _capabilities, ...rest } = data
  return rest
}
