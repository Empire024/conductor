import type { AgentSpec } from '../../shared/models'
import type { Decider, DeciderOutcome, DecisionRecord, DecisionRequest, ExecutionOutcome } from '../../shared/model-routing'
import type { ReviewAction, ReviewRecord } from '../approval-review'
import { captureApprovalReview } from './capture/approval-review'
import { topChoice, type DecisionService } from './decision-service'
import { LIVE_AUDIT_EVERY, type LiveBoundaries } from './live-boundaries'
import { boundaryOf, type ModelIntelligenceStore } from './store'

/**
 * The approval gate's shadow (docs/model-routing.md, E): when a reviewer turn is about to run, the
 * local decider is asked the same question in the background; the reviewer's own answer is the
 * frontier verdict of that DecisionRecord, and the owner's later answer is its outcome, so
 * agreement is counted per boundary (live-boundaries.ts). reviewing, reviewed and answered are called
 * synchronously and never wait: they cannot delay or change a review.
 *
 * decideLive is the one step the gate waits for, and only on a boundary the owner or a wizard switched
 * live (decisions.live, at 95% over 30 cases): a confident local allow of a workspace-write action then
 * answers it without a reviewer turn. Anything else (a deny, an escalation, an unsure verdict, native-owner,
 * no local server, a slow or failed decider) returns null and the reviewer runs as before. Every
 * LIVE_AUDIT_EVERY-th confident allow is still reviewed, so agreement keeps being measured; a boundary whose
 * agreement falls below the rule is reverted to shadow as soon as a reviewer's or owner's answer shows it.
 */

export interface ApprovalShadowService {
  /** A live boundary's answer for this action, or null: the reviewer decides as before. Never throws. */
  decideLive(spec: AgentSpec, action: ReviewAction): Promise<{ key: string; rationale: string } | null>
  reviewing(spec: AgentSpec, action: ReviewAction): void
  reviewed(record: ReviewRecord): void
  answered(record: ReviewRecord): void
  /** Settles in tests once every background step of this request has finished. */
  settled(record: Pick<ReviewRecord, 'workerId' | 'runtimeId' | 'requestId'>): Promise<DecisionRecord | null>
  /** Reviews the shadow skipped because no local model server was running (it never starts one); live answers and audits. */
  stats(): { skipped: number; lastSkip: string | null; liveAllowed: number; audited: number }
  dispose(): void
}
/** How long a live boundary waits for the local verdict before the reviewer takes the action as usual. */
export const LIVE_WAIT_MS = 30_000

interface Pending { resolve(outcome: DeciderOutcome): void; decision: Promise<DecisionRecord | null>; work: Promise<unknown>; expires: ReturnType<typeof setTimeout>; reviewer?: string }

const PENDING_MAX = 200
/** A reviewer that never reports back (a lost binding) must not hold the entry forever. */
const REVIEW_WAIT_MS = 20 * 60_000
const OPTIONS = [
  { id: 'allow', label: 'Allow this one action' },
  { id: 'deny', label: 'Deny it' },
  { id: 'escalate', label: 'Escalate to the owner' }
]
const keyOf = (record: Pick<ReviewRecord, 'workerId' | 'runtimeId' | 'requestId'>): string => `${record.workerId}\0${record.runtimeId}\0${record.requestId}`
const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max - 1) + '…' : text

/** The compact state the local decider sees: never the whole argument payload. */
export function approvalRequest(spec: AgentSpec, action: ReviewAction): DecisionRequest {
  let args = ''
  try { args = JSON.stringify(action.arguments) } catch { args = '[unserialisable]' }
  return {
    kind: 'approval', requester: 'approval-gate', impact: action.boundary === 'native-owner' ? 'high' : 'routine',
    question: `May the ${spec.provider} worker run ${action.tool} once, as described?`,
    options: OPTIONS,
    state: {
      tool: action.tool, boundary: action.boundary, reason: clip(action.reason, 400), sideEffects: action.sideEffects.slice(0, 4).map(effect => clip(effect, 200)),
      paths: action.paths.length, arguments: clip(args, 2_500), ownerEvidence: clip(action.ownerEvidence, 800)
    },
    projectId: action.projectId, agentSessionId: action.workerId
  }
}

/** The reviewer's decision as a verdict: a decided phase is a choice, anything else a failure. */
export function reviewVerdict(record: ReviewRecord): DeciderOutcome {
  const decided = record.history.find(entry => ['approved', 'denied', 'owner'].includes(entry.phase))
  const decider = record.reviewerModel ? `approval-reviewer:${record.reviewerModel}` : 'approval-reviewer'
  if (!decided || record.coveredBy) return { ok: false, decider, reason: `review ended ${record.phase}: ${clip(record.rationale, 200)}` }
  const choice = decided.phase === 'approved' ? 'allow' : decided.phase === 'denied' ? 'deny' : 'escalate'
  return { ok: true, verdict: { decider, probabilities: { allow: 0, deny: 0, escalate: 0, [choice]: 1 }, rationale: clip(decided.rationale, 600), elapsedMs: record.reviewerElapsedMs ?? 0 } }
}

export function createApprovalShadow(deps: {
  decisions: Pick<DecisionService, 'decide' | 'thresholds' | 'askSystemOne'>
  store: Pick<ModelIntelligenceStore, 'updateDecisionOutcome'>
  recordOutcome(outcome: ExecutionOutcome | null): ExecutionOutcome | null
  log(message: string, error?: unknown): void
  now(): Date
  /** A local decider exists and a model server is already running; otherwise the shadow only records the skip. */
  localAvailable?(): boolean
  /** Which boundaries are live, and the automatic revert once a decision's final answer is known. */
  boundaries?: Pick<LiveBoundaries, 'isLive' | 'status' | 'check'>
  liveWaitMs?: number
}): ApprovalShadowService {
  const pending = new Map<string, Pending>()
  /** The local verdict decideLive already asked for an action it left to the reviewer, for reviewing to journal. */
  const asked = new Map<string, { verdict: DeciderOutcome; audit: boolean }>()
  let skipped = 0, lastSkip: string | null = null, confidentAllows = 0, liveAllowed = 0, audited = 0
  const drop = (key: string): void => { const entry = pending.get(key); if (entry) { clearTimeout(entry.expires); pending.delete(key) } }
  const guard = (what: string, work: () => void): void => { try { work() } catch (error) { deps.log(`approval shadow: ${what}`, error) } }
  /** A decision with a reviewer's or owner's answer may show a live boundary's agreement falling: revert it then. */
  const checkLive = (journaled: DecisionRecord | null): void => {
    if (!journaled || !deps.boundaries) return
    try { deps.boundaries.check('approval', boundaryOf(journaled)) } catch (error) { deps.log('approval shadow: live boundary not checked', error) }
  }
  const capture = (entry: Pending | undefined, record: ReviewRecord): void => {
    const decision = entry?.decision ?? Promise.resolve(null)
    const work = decision.then(journaled => { deps.recordOutcome(captureApprovalReview({ record, decisionId: journaled?.id ?? null })); checkLive(journaled) }).catch(error => deps.log('approval shadow: review outcome not recorded', error))
    if (entry) entry.work = Promise.all([entry.work, work])
  }
  const skip = (): void => {
    // D6: the shadow never loads a model onto the GPU; it notes the skip and does nothing else.
    if (!skipped || Date.parse(lastSkip ?? '') < deps.now().getTime() - 3_600_000) deps.log('approval shadow: local decider unavailable (no local model server is running); reviews are not shadowed')
    skipped++; lastSkip = deps.now().toISOString()
  }
  return {
    async decideLive(spec, action) {
      try {
        if (action.boundary !== 'workspace-write' || !deps.boundaries?.isLive('approval', action.boundary) || deps.decisions.thresholds('approval').mode === 'off') return null
        if (deps.localAvailable && !deps.localAvailable()) return null
        const key = keyOf(action), request = approvalRequest(spec, action)
        let timer: ReturnType<typeof setTimeout> | undefined
        const controller = new AbortController()
        const verdict = await Promise.race([
          deps.decisions.askSystemOne(request, controller.signal),
          new Promise<null>(done => { timer = setTimeout(() => { controller.abort(); done(null) }, deps.liveWaitMs ?? LIVE_WAIT_MS); timer.unref?.() })
        ]).finally(() => clearTimeout(timer))
        if (!verdict) return null
        const thresholds = deps.decisions.thresholds('approval'), top = verdict.ok ? topChoice(verdict.verdict.probabilities, request.options.map(option => option.id)) : null
        const confident = !!top && top.choice === 'allow' && !thresholds.frontierOnly.includes('allow') && top.confidence >= thresholds.minConfidence && top.margin >= thresholds.minMargin
        const audit = confident && ++confidentAllows % LIVE_AUDIT_EVERY === 0
        if (!confident || audit) {
          // The reviewer decides; reviewing journals this verdict beside its answer instead of asking again.
          if (asked.size >= PENDING_MAX) asked.delete(asked.keys().next().value!)
          asked.set(key, { verdict, audit })
          if (audit) audited++
          return null
        }
        const record = await deps.decisions.decide({ ...request, state: { ...request.state, live: true } }, { systemOne: verdict, mode: 'live' })
        if (record.choice !== 'allow' || record.escalated) return null
        liveAllowed++
        const status = deps.boundaries.status('approval', action.boundary)
        return { key: `live:${record.decidedBy}`, rationale: `Allowed by the local decision model ${record.decidedBy} (confidence ${record.confidence.toFixed(2)}): workspace-write approvals are live (decisions.live) at ${status.agreement === null ? '?' : Math.round(status.agreement * 1000) / 10}% agreement over ${status.cases} reviewed cases; decision ${record.id}` }
      } catch (error) { deps.log('approval shadow: live decision failed; the reviewer decides', error); return null }
    },
    reviewing(spec, action) {
      guard('not started', () => {
        const key = keyOf(action), early = asked.get(key)
        asked.delete(key)
        if (deps.decisions.thresholds('approval').mode === 'off') return
        if (!early && deps.localAvailable && !deps.localAvailable()) { skip(); return }
        if (pending.has(key)) return
        if (pending.size >= PENDING_MAX) { const oldest = pending.keys().next().value!; pending.get(oldest)!.resolve({ ok: false, decider: 'approval-reviewer', reason: 'shadow queue full' }); drop(oldest) }
        let resolve!: (outcome: DeciderOutcome) => void
        const review = new Promise<DeciderOutcome>(done => { resolve = done })
        const frontier: Decider = { id: 'approval-reviewer', tier: 'frontier', supports: kind => kind === 'approval', decide: () => review }
        const expires = setTimeout(() => { resolve({ ok: false, decider: 'approval-reviewer', reason: 'the review never reported back' }); drop(key) }, REVIEW_WAIT_MS)
        expires.unref?.()
        // Always measured as shadow: the reviewer's verdict is journaled beside the local one, whatever the kind's mode.
        const request = approvalRequest(spec, action), state = early?.audit ? { ...request.state, liveAudit: true } : request.state
        const decision = deps.decisions.decide({ ...request, state }, { frontier, mode: 'shadow', ...(early ? { systemOne: early.verdict } : {}) }).catch(error => { deps.log('approval shadow decision failed', error); return null })
        pending.set(key, { resolve, decision, work: decision, expires })
      })
    },
    reviewed(record) {
      guard('review not recorded', () => {
        const key = keyOf(record), entry = pending.get(key)
        entry?.resolve(reviewVerdict(record))
        capture(entry, record)
        // Only an escalation waits for the owner's answer; every other ending is final.
        if (entry && record.phase !== 'owner') { const work = entry.work; void work.finally(() => { if (pending.get(key) === entry) drop(key) }) }
      })
    },
    answered(record) {
      guard('answer not recorded', () => {
        const key = keyOf(record), entry = pending.get(key)
        const owner = record.ownerAnswer
        entry?.resolve(reviewVerdict(record))
        capture(entry, record)
        if (!entry) return
        const work = entry.decision.then(journaled => {
          if (!journaled || !owner) return
          // The decision was right when the owner's answer matches it, or when it left the answer to the owner.
          const agreed = journaled.choice === 'escalate' || journaled.choice === owner
          deps.store.updateDecisionOutcome(journaled.id, { result: agreed ? 'success' : 'failure', at: deps.now().toISOString(), detail: `${record.answeredBy ?? 'owner'} answered ${owner}`, answer: owner })
          checkLive(journaled)
        }).catch(error => deps.log('approval shadow: owner outcome not recorded', error))
        entry.work = Promise.all([entry.work, work])
        void entry.work.finally(() => { if (pending.get(key) === entry) drop(key) })
      })
    },
    async settled(record) {
      const entry = pending.get(keyOf(record))
      if (!entry) return null
      await entry.work.catch(() => undefined)
      return entry.decision
    },
    stats: () => ({ skipped, lastSkip, liveAllowed, audited }),
    dispose() { asked.clear(); for (const key of [...pending.keys()]) { pending.get(key)!.resolve({ ok: false, decider: 'approval-reviewer', reason: 'shutting down' }); drop(key) } }
  }
}
