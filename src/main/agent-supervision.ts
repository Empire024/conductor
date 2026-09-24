import { createHash } from 'node:crypto'
import type { Json, SessionProjection, TimelineItem } from '../shared/structured-agent'
import { summarizeUsageRun, type TokenFigures } from '../shared/usage-accounting'
import type { ReviewRecord } from './approval-review'

/**
 * What a controller needs to supervise a coworker without pulling its history, on top of
 * agents.status: who a pending request waits on, whether the last accepted prompt actually
 * started a native turn, what the turn produced, what it cost as measured, and a cursor that
 * moves only when one of those changes (never on a streamed token).
 */
export interface Supervision {
  /** Changes only on a meaningful change; pass it back as `since` to get `unchanged: true`. */
  cursor: string
  /** Requests the conversation is blocked on; `reviewer` while a stronger-model review runs. */
  pending: Array<{ requestId: string; kind: 'approval' | 'question'; waitingOn: 'reviewer' | 'owner'; title: string; review: { phase: string; reviewerModel: string | null } | null }>
  activeTool: { name: string; status: string; since: string } | null
  /** The newest prompt the conversation accepted, and the first native event that answered it.
   *  `accepted` is Conductor's own record; only `started` is the runtime's evidence. */
  turnStart: { promptItemId: string; from: string | null; acceptedAt: string; state: 'started' | 'awaiting-native' | 'not-started'; startedAt: string | null; evidence: string | null } | null
  /** Prompts accepted but not yet part of a turn: queued behind it or waiting to be steered in. */
  waitingPrompts: number
  artifacts: { applied: number; rejected: number; pending: number; reverted: number }
  /** Provider-reported and Conductor-measured figures only; null where nothing was reported.
   *  Tokens and cost are the provider's (`*Estimated` when it marked them so); turns, wall time
   *  and errors are counted from this timeline; reviewer figures come from the approval journal. */
  usage: {
    tokens: TokenFigures | null; tokensEstimated: boolean; costUsd: number | null; costEstimated: boolean
    turns: number; wallMs: number | null; errors: number
    reviewer: { reviews: number; elapsedMs: number | null; tokens: TokenFigures | null; records: string[] } | null
  }
}

/** Timeline entries a native runtime produces for a turn; Conductor's own echo of the prompt,
 *  its settings acknowledgements and its session bookkeeping do not count as a started turn. */
const NATIVE_TURN_EVIDENCE = new Set(['tool', 'changes', 'interaction', 'subagent', 'usage', 'plan', 'error'])
const TERMINAL = new Set(['failed', 'disconnected', 'interrupted', 'completed'])

const order = (item: TimelineItem) => item.updatedSequence ?? item.sequence
const object = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {}

function turnStart(state: SessionProjection): Supervision['turnStart'] {
  const prompt = state.items.filter(item => item.data.type === 'text' && item.data.role === 'user' && !item.parentId).sort((a, b) => a.sequence - b.sequence).at(-1)
  if (!prompt || prompt.data.type !== 'text') return null
  const answer = state.items.filter(item => item.sequence > prompt.sequence && item.runtimeId === prompt.runtimeId
    && (NATIVE_TURN_EVIDENCE.has(item.data.type) || item.data.type === 'text' && item.data.role === 'assistant')).sort((a, b) => a.sequence - b.sequence)[0]
  const base = { promptItemId: prompt.id, from: prompt.data.origin?.label ?? null, acceptedAt: prompt.timestamp }
  if (answer) return { ...base, state: 'started', startedAt: answer.timestamp, evidence: answer.data.type === 'text' ? 'assistant text' : answer.data.type }
  // A turn that already settled with nothing native in it never started, whatever was accepted.
  return { ...base, state: TERMINAL.has(state.phase) ? 'not-started' : 'awaiting-native', startedAt: null, evidence: null }
}

function addTokens(total: TokenFigures, add: TokenFigures | undefined): void {
  for (const [key, value] of Object.entries(add ?? {}) as Array<[keyof TokenFigures, number | undefined]>) if (typeof value === 'number') total[key] = (total[key] ?? 0) + value
}

function reviewerCost(records: ReviewRecord[] | undefined): Supervision['usage']['reviewer'] {
  const ran = (records ?? []).filter(record => record.reviewerId)
  if (!ran.length) return null
  const tokens: TokenFigures = {}
  let elapsed = 0, timed = false
  for (const record of ran) {
    if (typeof record.reviewerElapsedMs === 'number') { elapsed += record.reviewerElapsedMs; timed = true }
    const usage = object(record.reviewerUsage)
    addTokens(tokens, (object(usage.run).tokens ?? object(usage.conversation).tokens) as TokenFigures | undefined)
  }
  return { reviews: ran.length, elapsedMs: timed ? elapsed : null, tokens: Object.keys(tokens).length ? tokens : null, records: ran.slice(-20).map(record => record.id) }
}

export function supervise(state: SessionProjection, reviews?: ReviewRecord[]): Supervision {
  const pending: Supervision['pending'] = []
  const artifacts = { applied: 0, rejected: 0, pending: 0, reverted: 0 }
  let activeTool: Supervision['activeTool'] = null, errors = 0
  for (const item of [...state.items].sort((a, b) => order(a) - order(b))) {
    const data = item.data
    if (data.type === 'interaction' && data.interaction.status === 'pending') {
      const review = data.interaction.review
      pending.push({ requestId: data.interaction.id, kind: data.interaction.kind, waitingOn: review?.phase === 'reviewing' ? 'reviewer' : 'owner', title: data.interaction.title.slice(0, 200), review: review ? { phase: review.phase, reviewerModel: review.reviewerModel ?? null } : null })
    } else if (data.type === 'tool' && ['preparing', 'running', 'awaiting_approval'].includes(data.status) && data.name !== 'acceptance') activeTool = { name: data.name, status: data.status, since: item.timestamp }
    else if (data.type === 'changes') for (const change of data.changes) {
      const status = change.status
      if (status === 'applied') artifacts.applied++
      else if (status === 'rejected' || status === 'failed') artifacts.rejected++
      else if (status === 'reverted') artifacts.reverted++
      else artifacts.pending++
    } else if (data.type === 'error') errors++
  }
  if (activeTool && TERMINAL.has(state.phase)) activeTool = null
  const started = turnStart(state)
  const waitingPrompts = (state.queuedPrompts?.length ?? (state.queued ? 1 : 0)) + (state.pendingSteering?.length ?? 0)
  const report = summarizeUsageRun(state.items)
  const usage: Supervision['usage'] = {
    tokens: report.conversation.tokens ?? null, tokensEstimated: report.conversation.tokensEstimated,
    costUsd: report.conversation.costUsd ?? null, costEstimated: report.conversation.costEstimated,
    turns: report.conversation.turns, wallMs: report.conversation.wallMs ?? null, errors,
    reviewer: reviewerCost(reviews)
  }
  // The newest settled answer, by identity: a streaming answer changes its text, not its id, and
  // while a turn runs the answer is not a result yet.
  const settled = TERMINAL.has(state.phase) || state.phase === 'idle' ? state.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').sort((a, b) => a.sequence - b.sequence).at(-1)?.id ?? null : null
  const cursor = createHash('sha256').update(JSON.stringify([state.phase, pending.map(entry => [entry.requestId, entry.waitingOn, entry.review?.phase ?? null]), activeTool && [activeTool.name, activeTool.status, activeTool.since],
    started && [started.promptItemId, started.state], waitingPrompts, artifacts, settled, errors, state.backgroundTasks ?? 0])).digest('hex').slice(0, 16)
  return { cursor, pending, activeTool, turnStart: started, waitingPrompts, artifacts, usage }
}

/** agents.status with `since`: the unchanged marker when nothing meaningful moved. */
export function sinceCursor<T extends { cursor: string; phase: unknown; observedAt: string; agentSessionId?: unknown }>(view: T, since: unknown): T | { agentSessionId: unknown; unchanged: true; cursor: string; phase: unknown; observedAt: string } {
  return typeof since === 'string' && since === view.cursor ? { agentSessionId: view.agentSessionId, unchanged: true, cursor: view.cursor, phase: view.phase, observedAt: view.observedAt } : view
}
