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
 * A runtime forgets on exactly two occasions: a new native conversation and a context compaction.
 * A new process is not one of them when it resumes the same provider session: Claude `--resume`
 * and Codex `thread/resume` reload the whole transcript, briefings included. Counting every
 * resume or reconnect as new resent the static block and the recalled memories on 40 % of turns
 * (docs/verification/2026-09-28-harness-gap-sweep.md, H12). So everything static is sent once per
 * provider session and again after a compaction or when the control credential it names changed;
 * a memory once per provider session; the coworker log and its leases as a delta. For Claude and
 * Codex the ledger outlives an app restart (a setting per conversation), since the conversation
 * does too.
 */
import { createHash } from 'node:crypto'
import type { AgentEvent } from '../shared/structured-agent'
import type { AgentSpec } from '../shared/models'
import type { ConductorDatabase } from './database'
import type { CoworkerBriefingOptions, SentLease } from './agent-collaboration-store'
import { fitRecalledMemories, formatRecalledMemories, MEMORY_PROTOCOL, memoryTokens } from './memory'
import { projectTaskBriefing } from './project-backlog'
import { COWORKER_OPENED_PREFIX } from './coworker-autoclose'
import { CoworkerRecovery } from './coworker-recovery'

/** An adapter sets this on a notice payload the moment the runtime has compacted its context. */
export const CONTEXT_RESET = 'contextReset'

export const MEMORY_HEADING = 'Conductor project memory (current project evidence takes precedence):'

/** Rides with the machine line, once per runtime, for the runtimes the conductor-local MCP
 *  server is attached to (src/main/local-assist). One sentence: it is paid on every new runtime. */
export const LOCAL_ASSIST_HINT = 'Save tokens: for tests, builds and long logs call run_and_summarize; for reading large files call local_ask (conductor-local tools, answered by the local model).'
const LOCAL_ASSIST_PROVIDERS = new Set(['claude', 'codex'])

/** Once per runtime, for Claude conversations, which get the `conductor` MCP tools and owner
 *  permission grants (src/main/permission-grants, docs/permissions-classifier.md). */
export const PERMISSION_GRANT_HINT = 'If Auto mode refuses a call you need, or will refuse one (production, shared or external), do not hand it to the owner to run: call request_permission (conductor tools; app control permissions.request) with {command|path|url, reason, rollback}. Split preparing (write the script) from running it, ask for exactly one call, keep working meanwhile, and after "[Conductor] approved: <rule>; retry it now" run exactly that call and verify it. Message other tabs with send_message, report and handoff, not from a shell.'

/** Once per runtime, for Claude conversations: the two shell habits that cost the most wasted
 *  calls (harness gap sweep H18: heredoc scripts mangled by the shell, and sleep polling Claude
 *  Code blocks outright). */
export const SHELL_HYGIENE_HINT = 'Write scripts with the Write tool and run them with node; Bash heredocs get mangled here. Do not sleep-poll: agents.status, git.ship.status({waitSeconds}) and run_and_summarize wait for you.'

/** Once per runtime, for a coworker a controller opened (coworker-autoclose.ts): a finished
 *  coworker left open keeps its CLI process alive for nothing. */
export const FINISH_HINT = 'When your work is delivered and reported, end with agents.finish({}) so your tab and CLI are released.'

/** Who a coworker reports to, and how, so it does not go looking for a way to reach its controller. */
export const coworkerHint = (controller: { id: string; title?: string }): string =>
  `You are a coworker of ${controller.title ? `"${controller.title}" (${controller.id})` : controller.id}. Report results with report (agents.report({text})): the first 2000 characters arrive inline and a longer report is kept whole for your controller to read, so never shorten or resend one; send_message to ${controller.id} reaches it too. ${FINISH_HINT}`

/** Claude Code refusals that are outages, not verdicts (harness gap H16). An adapter marks the
 *  notice it posts with one of these payload keys; the next message then carries the matching
 *  nudge, once per runtime, so the agent retries instead of stopping or handing the call to the owner. */
export const OUTAGE_NUDGES = {
  classifierUnavailable: 'Claude\'s auto-mode classifier is unavailable; this is transient. Retry the same call in 60 s; if it is still refused after 3 tries, request_permission for it.',
  hookUnreachable: 'Conductor\'s tool hook was unreachable for a while (the app restarting or stalled), so Claude Code refused tool calls without judging them. Retry the refused calls now; reads never wait for the hook. If they are refused again the same way, report it to your controller instead of working around it.'
} as const
type OutageKind = keyof typeof OUTAGE_NUDGES

/** Context bands at which a conversation is told, once each per runtime, to hand its remaining
 *  work to a fresh tab. Two bands, not one threshold: docs/token-thrift-policy.md shows the
 *  payback varies by model and cache ratio, so the first is a prompt to plan and the second a
 *  prompt to act. */
export const HANDOFF_BANDS = [60, 85] as const

/** The nudge itself, kept short: it names the bounded handoff format and the control method
 *  that opens the fresh tab, and nothing the policy document does not say. */
export const handoffNudge = (percent: number, successor = false): string =>
  `Conductor: this conversation's context is at ${percent}% of its window. Finish the current step, then write a bounded handoff (Objective, Constraints, Owned files, Verified findings, Remaining work, Artifact references; at most about 1,200 tokens, with paths instead of pasted output) and call ${successor ? 'agents.handoff({handoff, successor:true})' : 'agents.handoff'} with it through Conductor app control to continue in a fresh tab. The owner sees both tabs; do not continue the work in parallel afterwards.`

/** When a main brain (a wizard tab, or a controller with live coworkers) should pass itself on.
 *  A main brain is woken by every coworker report and re-reads its whole transcript each time, so
 *  length costs it far sooner than a worker; hence thresholds well below HANDOFF_BANDS. */
export const SUCCESSION_TURNS = 25
export const SUCCESSION_PERCENT = 40

/** The per-runtime line a main brain gets with its static briefing. */
export const SUCCESSION_HINT = `Main brain: when this conversation passes about ${SUCCESSION_TURNS} turns or ${SUCCESSION_PERCENT}% context and your coworkers are idle, finish the step you're in and call agents.handoff({handoff, successor:true}) with the six-section handoff. The successor opens as a root tab with your wizard mode, model, effort and mode, and takes over every coworker you control.`

/** Set on the payload of the Conductor notice that told a main brain it crossed that threshold. */
export const SUCCESSION_NUDGE = 'successionNudge'

export const successionNudge = (turns: number, percent?: number): string =>
  `Conductor: this main conversation has run ${turns} turns${percent === undefined ? '' : ` and uses ${Math.round(percent)}% of its context`}. Once your coworkers are idle, finish the step you're in and call agents.handoff({handoff, successor:true}) with the six-section handoff; the successor continues as this conversation, with your coworkers.`

/** What a message's dispatch knows about the conversation it is sent into. `percent` is how full
 *  the runtime's window is; the rest is set only for a main brain: `turns` counts user messages
 *  including this one, `nudged` says its timeline already holds a succession notice, and
 *  `notice` posts one there. */
export interface BriefingContext {
  percent?: number
  mainBrain?: boolean
  turns?: number
  nudged?: boolean
  notice?: (message: string) => void
}

interface Ledger {
  /** The runtime this ledger describes. Empty while the first prompt of a conversation is
   *  composed, because its process does not exist until the prompt is dispatched. */
  runtimeId: string
  /** The provider conversation the runtime holds, once it has named it. A new process on the same
   *  one (a resume, a reconnect, an app restart) keeps what it was told; another one does not. */
  nativeSessionId?: string
  staticSent: boolean
  /** Which control paragraph the static block carried: a new credential or endpoint is news. */
  controlDigest?: string
  guidanceSent: boolean
  memoryIds: Set<string>
  /** Coworker records up to this time have been sent. */
  coworkerSince?: string
  /** The coworker leases this runtime has been told about (agent-collaboration-store.ts leaseKey). */
  leases: Map<string, SentLease>
  /** The highest context band this runtime has already been nudged at. */
  nudgedBand: number
  /** Whether this runtime has been told when a main brain hands off to a successor. */
  successionHinted: boolean
  /** The outage nudges this runtime has had (OUTAGE_NUDGES). */
  outagesNudged: Set<OutageKind>
}

/** Providers whose resumed session reloads its whole transcript, so a new process on the same
 *  provider session still holds every briefing it was sent. Grok's resume is not relied on and a
 *  local model is briefed with memory lines only. */
const RESUMABLE_PROVIDERS = new Set(['claude', 'codex'])
/** Where a resumable conversation's ledger survives an app restart. */
export const BRIEFING_LEDGER_PREFIX = 'briefingLedger:'

interface StoredLedger {
  nativeSessionId: string
  staticSent: boolean
  controlDigest?: string
  guidanceSent: boolean
  memoryIds: string[]
  coworkerSince?: string
  leases: Array<[string, SentLease]>
  nudgedBand: number
  successionHinted: boolean
  outagesNudged?: OutageKind[]
}

const digest = (text: string): string | undefined => text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : undefined

export interface TurnBriefingDependencies {
  database: Pick<ConductorDatabase, 'recall' | 'recordMemoryRecall' | 'forgetStaleMemories'> & Partial<Pick<ConductorDatabase, 'getSetting' | 'setSetting'>>
  /** The provider session a conversation resumes (its structured state's nativeSessionId). Without
   *  it every new runtime is treated as a new conversation. */
  nativeSession?: (agentSessionId: string) => string | undefined
  coworkers?: (agentSessionId: string, options: CoworkerBriefingOptions) => string
  control?: (spec: AgentSpec) => string
  /** The title of the conversation that opened a coworker, for its coworker hint. */
  controller?: (agentSessionId: string) => { id: string; title: string } | null
  /** One line on what this computer can carry, so no project's agent overloads it. */
  machine?: () => string
  now?: () => string
}

export class TurnBriefings {
  private readonly ledgers = new Map<string, Ledger>()
  constructor(private readonly deps: TurnBriefingDependencies) {}

  /** Composes the context appended to one user message. `runtimeId` is the adapter the message
   *  will reach, or '' when dispatching it is what creates the adapter. */
  compose(spec: AgentSpec, prompt: string, itemId: string, runtimeId: string, context?: BriefingContext): string {
    const ledger = this.ledger(spec, runtimeId)
    const local = spec.provider === 'local'
    // Local models use the scoped in-process tool bridge. Never put a bearer credential for the
    // unrestricted app-control HTTP surface into their prompt or sandbox.
    const control = local ? '' : this.deps.control?.(spec) ?? ''
    const staticDue = !ledger.staticSent || ledger.controlDigest !== digest(control)
    if (staticDue) {
      ledger.staticSent = true
      ledger.controlDigest = digest(control)
      try { this.deps.database.forgetStaleMemories(spec.projectId) } catch { /* Pruning is opportunistic; recall works without it. */ }
    }
    const memory = this.memory(spec, prompt, itemId, ledger, !local)
    // They get no per-turn nudge either: a small model takes the last imperative it reads as its
    // orders, so only the recalled memory lines travel, fenced ahead of the owner's words
    // (local-models/briefing.ts).
    if (local) return memory
    const coworkers = this.coworkers(spec, ledger)
    const text = [memory, staticDue ? MEMORY_PROTOCOL : '', coworkers, staticDue ? projectTaskBriefing(spec) : '', staticDue ? [this.deps.machine?.() ?? '', LOCAL_ASSIST_PROVIDERS.has(spec.provider) ? LOCAL_ASSIST_HINT : '', spec.provider === 'claude' ? PERMISSION_GRANT_HINT : '', spec.provider === 'claude' ? SHELL_HYGIENE_HINT : ''].filter(Boolean).join(' ') : '', staticDue ? control : '', staticDue ? this.coworkerHint(spec) : '', this.successionHint(ledger, context), this.succession(spec.id, context) || this.nudge(ledger, context), this.outageNudges(spec.id, ledger)].filter(Boolean).join('\n\n')
    this.save(spec, ledger)
    return text
  }

  private coworkerHint(spec: AgentSpec): string {
    try {
      const controllerId = this.controllerOf(spec)
      if (!controllerId) return ''
      return coworkerHint(this.deps.controller?.(controllerId) ?? { id: controllerId })
    } catch { return '' /* A hint never stops a message. */ }
  }

  /** Who a coworker reports to now: the conversation that controls its tab (AgentControl's link,
   *  which moves when another controller takes the tab over), else the one that opened it; and a
   *  controller that handed itself on (agents.handoff successor, agents.supersede) is named by its
   *  successor, since agents.report and send_message deliver there. Naming the old one sent
   *  reports to a superseded wizard (2026-09-28). */
  private controllerOf(spec: AgentSpec): string | undefined {
    const database = this.deps.database
    if (!database.getSetting) return undefined
    const read = (key: string): string | null => database.getSetting!(key)
    // Only a coworker a controller opened gets the hint (and its agents.finish advice); the
    // owner's own tab that a controller merely took over does not.
    const opened = read(COWORKER_OPENED_PREFIX + spec.id)
    if (!opened) return undefined
    let link: { controllerAgentSessionId?: string; controllerProjectId?: string; projectId?: string } | null = null
    try { link = JSON.parse(read('agentControlParent:' + spec.id) || 'null') } catch { link = null }
    let id = link?.controllerAgentSessionId ?? opened
    const recovery = new CoworkerRecovery({ getSetting: read, setSetting: () => undefined })
    const projectId = link?.controllerProjectId ?? link?.projectId ?? spec.projectId
    for (let hops = 0; hops < 8; hops++) {
      const by = recovery.status(projectId, id).superseded?.by
      if (!by || by === id || by === spec.id) break
      id = by
    }
    return id
  }

  /** Once per runtime, like the static briefing, but from the first message after the
   *  conversation became a main brain: a controller only becomes one when it opens coworkers. */
  private successionHint(ledger: Ledger, context?: BriefingContext): string {
    if (!context?.mainBrain || ledger.successionHinted) return ''
    ledger.successionHinted = true
    return SUCCESSION_HINT
  }

  /** Main brains already told to pass themselves on. Their timeline is the durable record (the
   *  notice's SUCCESSION_NUDGE, read back as context.nudged); this set covers the moment between
   *  posting it and the next dispatch reading it. */
  private readonly succeeded = new Set<string>()

  /** Once per conversation, not per runtime: a restart or a compaction does not make a long main
   *  brain any shorter, and the owner sees the notice in its tab. */
  private succession(id: string, context?: BriefingContext): string {
    if (!context?.mainBrain || context.nudged || this.succeeded.has(id)) return ''
    const turns = context.turns ?? 0
    const percent = context.percent !== undefined && Number.isFinite(context.percent) ? context.percent : undefined
    if (turns < SUCCESSION_TURNS && (percent === undefined || percent < SUCCESSION_PERCENT)) return ''
    this.succeeded.add(id)
    const message = successionNudge(turns, percent)
    context.notice?.(message)
    return message
  }

  /** Once per band per runtime; a compaction or a new process starts the count again, since
   *  the context it measures is gone with them. */
  private nudge(ledger: Ledger, context?: BriefingContext): string {
    const percent = context?.percent
    if (percent === undefined || !Number.isFinite(percent)) return ''
    const band = [...HANDOFF_BANDS].reverse().find(edge => percent >= edge)
    if (!band || band <= ledger.nudgedBand) return ''
    ledger.nudgedBand = band
    return handoffNudge(Math.round(percent), context?.mainBrain === true)
  }

  /** Outages seen since the conversation's last message, by conversation. Kept apart from the
   *  ledger, which does not exist yet for a conversation this launch has not sent to. */
  private readonly outages = new Map<string, Set<OutageKind>>()

  /** Once per runtime per kind: an outage lasts many calls, and the rule does not change. */
  private outageNudges(id: string, ledger: Ledger): string {
    const seen = this.outages.get(id)
    if (!seen) return ''
    this.outages.delete(id)
    const due = [...seen].filter(kind => !ledger.outagesNudged.has(kind))
    for (const kind of due) ledger.outagesNudged.add(kind)
    return due.map(kind => OUTAGE_NUDGES[kind]).join(' ')
  }

  /** Watches a conversation for the two moments its runtime forgets: another provider session
   *  and a compaction; and for the outages the next message has to explain. */
  observe(spec: AgentSpec, event: Pick<AgentEvent, 'runtimeId' | 'data'> & Partial<Pick<AgentEvent, 'nativeSessionId'>>): void {
    const { data } = event
    if (data.type === 'notice' && data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)) {
      const payload = data.payload
      for (const kind of Object.keys(OUTAGE_NUDGES) as OutageKind[]) if (payload[kind] && this.ledgers.get(spec.id)?.outagesNudged.has(kind) !== true) {
        const seen = this.outages.get(spec.id) ?? new Set<OutageKind>()
        this.outages.set(spec.id, seen.add(kind))
      }
    }
    const ledger = this.ledgers.get(spec.id)
    if (!ledger) return
    if (data.type === 'session') {
      if (data.phase === 'starting' && event.runtimeId) {
        // The first prompt was composed before its process existed; this is that process.
        if (!ledger.runtimeId) ledger.runtimeId = event.runtimeId
        else if (ledger.runtimeId !== event.runtimeId) this.newRuntime(spec, ledger, event.runtimeId, data.nativeSessionId ?? event.nativeSessionId)
      }
      // The runtime names its provider session. Another one than the ledger describes (a resume
      // that found no history and started over) holds none of what was sent.
      if (data.nativeSessionId && data.nativeSessionId !== ledger.nativeSessionId) {
        if (ledger.nativeSessionId) this.reset(ledger, ledger.runtimeId)
        ledger.nativeSessionId = data.nativeSessionId
        this.save(spec, ledger)
      }
      return
    }
    if (data.type === 'notice' && data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) && data.payload[CONTEXT_RESET] === true) {
      this.reset(ledger, ledger.runtimeId)
      this.save(spec, ledger)
    }
  }

  forget(agentSessionId: string): void { this.ledgers.delete(agentSessionId); this.succeeded.delete(agentSessionId); this.outages.delete(agentSessionId) }

  private ledger(spec: AgentSpec, runtimeId: string): Ledger {
    let ledger = this.ledgers.get(spec.id) ?? this.restore(spec, runtimeId)
    // A new ledger describes the provider session the conversation resumes, if it names one yet.
    if (!ledger) ledger = { runtimeId, nativeSessionId: this.nativeSession(spec), staticSent: false, guidanceSent: false, memoryIds: new Set(), leases: new Map(), nudgedBand: 0, successionHinted: false, outagesNudged: new Set() }
    else if (runtimeId && ledger.runtimeId && ledger.runtimeId !== runtimeId) this.newRuntime(spec, ledger, runtimeId, this.nativeSession(spec))
    else if (runtimeId) ledger.runtimeId = runtimeId
    this.ledgers.set(spec.id, ledger)
    return ledger
  }

  /** A new process keeps its ledger only when it resumes the provider session the ledger
   *  describes; anything unknown is a new conversation. */
  private newRuntime(spec: AgentSpec, ledger: Ledger, runtimeId: string, nativeSessionId: string | undefined): void {
    if (RESUMABLE_PROVIDERS.has(spec.provider) && ledger.nativeSessionId && nativeSessionId === ledger.nativeSessionId) ledger.runtimeId = runtimeId
    else this.reset(ledger, runtimeId)
  }

  private nativeSession(spec: AgentSpec): string | undefined {
    try { return this.deps.nativeSession?.(spec.id) || undefined } catch { return undefined }
  }

  private reset(ledger: Ledger, runtimeId: string): void {
    ledger.runtimeId = runtimeId
    ledger.staticSent = false
    ledger.controlDigest = undefined
    ledger.guidanceSent = false
    ledger.memoryIds.clear()
    ledger.coworkerSince = undefined
    ledger.leases.clear()
    ledger.nudgedBand = 0
    ledger.successionHinted = false
    ledger.outagesNudged.clear()
  }

  /** The ledger of a resumable conversation this app launch has not seen yet, if it was kept for
   *  the provider session the conversation still resumes. */
  private restore(spec: AgentSpec, runtimeId: string): Ledger | undefined {
    if (!RESUMABLE_PROVIDERS.has(spec.provider) || !this.deps.database.getSetting) return undefined
    try {
      const raw = this.deps.database.getSetting(BRIEFING_LEDGER_PREFIX + spec.id)
      if (!raw) return undefined
      const stored = JSON.parse(raw) as StoredLedger
      if (!stored.nativeSessionId || stored.nativeSessionId !== this.nativeSession(spec)) return undefined
      return {
        runtimeId, nativeSessionId: stored.nativeSessionId, staticSent: stored.staticSent === true, controlDigest: stored.controlDigest, guidanceSent: stored.guidanceSent === true,
        memoryIds: new Set(stored.memoryIds ?? []), coworkerSince: stored.coworkerSince, leases: new Map(stored.leases ?? []),
        nudgedBand: Number(stored.nudgedBand) || 0, successionHinted: stored.successionHinted === true,
        outagesNudged: new Set((stored.outagesNudged ?? []).filter(kind => kind in OUTAGE_NUDGES))
      }
    } catch { return undefined /* An unreadable ledger only means the briefing is sent again. */ }
  }

  private save(spec: AgentSpec, ledger: Ledger): void {
    if (!RESUMABLE_PROVIDERS.has(spec.provider) || !ledger.nativeSessionId || !this.deps.database.setSetting) return
    const stored: StoredLedger = {
      nativeSessionId: ledger.nativeSessionId, staticSent: ledger.staticSent, controlDigest: ledger.controlDigest, guidanceSent: ledger.guidanceSent,
      memoryIds: [...ledger.memoryIds], coworkerSince: ledger.coworkerSince, leases: [...ledger.leases], nudgedBand: ledger.nudgedBand, successionHinted: ledger.successionHinted,
      ...(ledger.outagesNudged.size ? { outagesNudged: [...ledger.outagesNudged] } : {})
    }
    try { this.deps.database.setSetting(BRIEFING_LEDGER_PREFIX + spec.id, JSON.stringify(stored)) }
    catch { /* The ledger saves briefing bytes; it never blocks a message. */ }
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
    try { text = this.deps.coworkers(spec.id, { since: ledger.coworkerSince, workOnly: true, guidance: !ledger.guidanceSent, leases: ledger.leases }) }
    catch { return '' /* Coordination is advisory; it never blocks a message. */ }
    ledger.coworkerSince = watermark
    if (text) ledger.guidanceSent = true
    return text
  }
}
