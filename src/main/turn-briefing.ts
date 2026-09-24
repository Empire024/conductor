/**
 * What rides along with a user message, and how much of it the native runtime has already
 * been told.
 *
 * Every prompt used to carry the whole briefing — the memory-write protocol, the checklist
 * rules, the app-control endpoint, the recalled memories and the coworker log — and because
 * a provider keeps its conversation, each copy stayed in the context for the rest of the
 * session and was re-read on every call after it. Measured over two weeks of real sessions
 * (scripts/measure-context-churn.mjs), the briefing outweighed the owner's own words more
 * than two to one, and the control paragraph alone was repeated verbatim in four turns out
 * of ten.
 *
 * A runtime forgets on exactly two occasions: a new process (a fresh conversation, a resume,
 * a reconnect) and a context compaction. So everything static is sent once per runtime and
 * again after either; a memory is sent once per runtime; the coworker log is sent as a delta.
 */
import type { AgentEvent } from '../shared/structured-agent'
import type { AgentSpec } from '../shared/models'
import type { ConductorDatabase } from './database'
import type { CoworkerBriefingOptions } from './agent-collaboration-store'
import { fitRecalledMemories, formatRecalledMemories, MEMORY_PROTOCOL, memoryTokens } from './memory'
import { projectTaskBriefing } from './project-backlog'

/** An adapter sets this on a notice payload the moment the runtime has compacted its context. */
export const CONTEXT_RESET = 'contextReset'

export const MEMORY_HEADING = 'Conductor project memory (current project evidence takes precedence):'

/** Rides with the machine line, once per runtime, for the runtimes the conductor-local MCP
 *  server is attached to (src/main/local-assist). One sentence: it is paid on every new runtime. */
export const LOCAL_ASSIST_HINT = 'Save tokens: for tests, builds and long logs call run_and_summarize; for reading large files call local_ask (conductor-local tools, answered by the local model).'
const LOCAL_ASSIST_PROVIDERS = new Set(['claude', 'codex'])

/** Context bands at which a conversation is told, once each per runtime, to hand its remaining
 *  work to a fresh tab. Two bands, not one threshold: docs/token-thrift-policy.md shows the
 *  payback varies by model and cache ratio, so the first is a prompt to plan and the second a
 *  prompt to act. */
export const HANDOFF_BANDS = [60, 85] as const

/** The nudge itself, kept short: it names the bounded handoff format and the control method
 *  that opens the fresh tab, and nothing the policy document does not say. */
export const handoffNudge = (percent: number): string =>
  `Conductor: this conversation's context is at ${percent}% of its window. Finish the current step, then write a bounded handoff (Objective, Constraints, Owned files, Verified findings, Remaining work, Artifact references; at most about 1,200 tokens, with paths instead of pasted output) and call agents.handoff with it through Conductor app control to continue in a fresh tab. The owner sees both tabs; do not continue the work in parallel afterwards.`

interface Ledger {
  /** The runtime this ledger describes. Empty while the first prompt of a conversation is
   *  composed, because its process does not exist until the prompt is dispatched. */
  runtimeId: string
  staticSent: boolean
  guidanceSent: boolean
  memoryIds: Set<string>
  /** Coworker records up to this time have been sent. */
  coworkerSince?: string
  /** The highest context band this runtime has already been nudged at. */
  nudgedBand: number
}

export interface TurnBriefingDependencies {
  database: Pick<ConductorDatabase, 'recall' | 'recordMemoryRecall' | 'forgetStaleMemories'>
  coworkers?: (agentSessionId: string, options: CoworkerBriefingOptions) => string
  control?: (spec: AgentSpec) => string
  /** One line on what this computer can carry, so no project's agent overloads it. */
  machine?: () => string
  now?: () => string
}

export class TurnBriefings {
  private readonly ledgers = new Map<string, Ledger>()
  constructor(private readonly deps: TurnBriefingDependencies) {}

  /** Composes the context appended to one user message. `runtimeId` is the adapter the message
   *  will reach, or '' when dispatching it is what creates the adapter. */
  compose(spec: AgentSpec, prompt: string, itemId: string, runtimeId: string, context?: { percent: number }): string {
    const ledger = this.ledger(spec.id, runtimeId)
    const staticDue = !ledger.staticSent
    if (staticDue) {
      ledger.staticSent = true
      try { this.deps.database.forgetStaleMemories(spec.projectId) } catch { /* Pruning is opportunistic; recall works without it. */ }
    }
    const local = spec.provider === 'local'
    const memory = this.memory(spec, prompt, itemId, ledger, !local)
    // Local models use the scoped in-process tool bridge. Never put a bearer credential for the
    // unrestricted app-control HTTP surface into their prompt or sandbox. They get no per-turn
    // nudge either: a small model takes the last imperative it reads as its orders, so only the
    // recalled memory lines travel, fenced ahead of the owner's words (local-models/briefing.ts).
    if (local) return memory
    const coworkers = this.coworkers(spec, ledger)
    return [memory, staticDue ? MEMORY_PROTOCOL : '', coworkers, staticDue ? projectTaskBriefing(spec) : '', staticDue ? [this.deps.machine?.() ?? '', LOCAL_ASSIST_PROVIDERS.has(spec.provider) ? LOCAL_ASSIST_HINT : ''].filter(Boolean).join(' ') : '', staticDue ? this.deps.control?.(spec) ?? '' : '', this.nudge(ledger, context)].filter(Boolean).join('\n\n')
  }

  /** Once per band per runtime; a compaction or a new process starts the count again, since
   *  the context it measures is gone with them. */
  private nudge(ledger: Ledger, context?: { percent: number }): string {
    if (!context || !Number.isFinite(context.percent)) return ''
    const band = [...HANDOFF_BANDS].reverse().find(edge => context.percent >= edge)
    if (!band || band <= ledger.nudgedBand) return ''
    ledger.nudgedBand = band
    return handoffNudge(Math.round(context.percent))
  }

  /** Watches a conversation for the two moments its runtime forgets. */
  observe(spec: AgentSpec, event: Pick<AgentEvent, 'runtimeId' | 'data'>): void {
    const ledger = this.ledgers.get(spec.id)
    if (!ledger) return
    const { data } = event
    if (data.type === 'session' && data.phase === 'starting' && event.runtimeId) {
      // The first prompt was composed before its process existed; this is that process.
      if (!ledger.runtimeId) ledger.runtimeId = event.runtimeId
      else if (ledger.runtimeId !== event.runtimeId) this.reset(ledger, event.runtimeId)
      return
    }
    if (data.type === 'notice' && data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) && data.payload[CONTEXT_RESET] === true) this.reset(ledger, ledger.runtimeId)
  }

  forget(agentSessionId: string): void { this.ledgers.delete(agentSessionId) }

  private ledger(id: string, runtimeId: string): Ledger {
    let ledger = this.ledgers.get(id)
    if (!ledger) { ledger = { runtimeId, staticSent: false, guidanceSent: false, memoryIds: new Set(), nudgedBand: 0 }; this.ledgers.set(id, ledger) }
    else if (runtimeId && ledger.runtimeId && ledger.runtimeId !== runtimeId) this.reset(ledger, runtimeId)
    else if (runtimeId) ledger.runtimeId = runtimeId
    return ledger
  }

  private reset(ledger: Ledger, runtimeId: string): void {
    ledger.runtimeId = runtimeId
    ledger.staticSent = false
    ledger.guidanceSent = false
    ledger.memoryIds.clear()
    ledger.coworkerSince = undefined
    ledger.nudgedBand = 0
  }

  private memory(spec: AgentSpec, prompt: string, itemId: string, ledger: Ledger, heading = true): string {
    // A bare "continue" names nothing; whatever steered the previous turn is still in context.
    if (!memoryTokens(prompt).length) return ''
    const fresh = this.deps.database.recall(spec.projectId, prompt, spec.provider, 8).filter(memory => !ledger.memoryIds.has(memory.id))
    const sent = fitRecalledMemories(fresh)
    if (!sent.length) return ''
    for (const memory of sent) ledger.memoryIds.add(memory.id)
    // Recall that reached the prompt is recorded against the user message it travelled with,
    // so a memory steering the turn is visible in the conversation rather than being an
    // invisible edit to the prompt.
    try { this.deps.database.recordMemoryRecall({ projectId: spec.projectId, agentSessionId: spec.id, itemId, prompt, memoryIds: sent.map(memory => memory.id) }) }
    catch { /* The ledger explains a turn; it is never a precondition for sending one. */ }
    return heading ? `${MEMORY_HEADING}\n${formatRecalledMemories(sent)}` : formatRecalledMemories(sent)
  }

  private coworkers(spec: AgentSpec, ledger: Ledger): string {
    if (!this.deps.coworkers) return ''
    const watermark = (this.deps.now ?? (() => new Date().toISOString()))()
    let text = ''
    try { text = this.deps.coworkers(spec.id, { since: ledger.coworkerSince, workOnly: true, guidance: !ledger.guidanceSent }) }
    catch { return '' /* Coordination is advisory; it never blocks a message. */ }
    ledger.coworkerSince = watermark
    if (text) ledger.guidanceSent = true
    return text
  }
}
