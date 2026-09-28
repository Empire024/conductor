import type { AgentSpec } from '../../shared/models'
import type { Decider, DeciderOutcome, DecisionRecord, DecisionRequest, ExecutionOutcome } from '../../shared/model-routing'
import type { ReviewAction, ReviewRecord } from '../approval-review'
import { captureApprovalReview } from './capture/approval-review'
import type { DecisionService } from './decision-service'
import type { ModelIntelligenceStore } from './store'

/**
 * The approval gate's shadow (docs/model-routing.md, E): when a reviewer turn is about to run, the
 * local decider is asked the same question in the background; the reviewer's own answer is the
 * frontier verdict of that DecisionRecord, and the owner's later answer is its outcome, so
 * agreement can be counted before `live` is ever considered. The gate calls these synchronously and
 * never waits: nothing here can delay or change a review. Mode `live` is not wired: it behaves as
 * shadow.
 */

export interface ApprovalShadowService {
  reviewing(spec: AgentSpec, action: ReviewAction): void
  reviewed(record: ReviewRecord): void
  answered(record: ReviewRecord): void
  /** Settles in tests once every background step of this request has finished. */
  settled(record: Pick<ReviewRecord, 'workerId' | 'runtimeId' | 'requestId'>): Promise<DecisionRecord | null>
  /** Reviews the shadow skipped because no local model server was running (it never starts one). */
  stats(): { skipped: number; lastSkip: string | null }
  dispose(): void
}

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
  decisions: Pick<DecisionService, 'decide' | 'thresholds'>
  store: Pick<ModelIntelligenceStore, 'updateDecisionOutcome'>
  recordOutcome(outcome: ExecutionOutcome | null): ExecutionOutcome | null
  log(message: string, error?: unknown): void
  now(): Date
  /** A local decider exists and a model server is already running; otherwise the shadow only records the skip. */
  localAvailable?(): boolean
}): ApprovalShadowService {
  const pending = new Map<string, Pending>()
  let skipped = 0, lastSkip: string | null = null
  const drop = (key: string): void => { const entry = pending.get(key); if (entry) { clearTimeout(entry.expires); pending.delete(key) } }
  const guard = (what: string, work: () => void): void => { try { work() } catch (error) { deps.log(`approval shadow: ${what}`, error) } }
  const capture = (entry: Pending | undefined, record: ReviewRecord): void => {
    const decision = entry?.decision ?? Promise.resolve(null)
    const work = decision.then(journaled => { deps.recordOutcome(captureApprovalReview({ record, decisionId: journaled?.id ?? null })) }).catch(error => deps.log('approval shadow: review outcome not recorded', error))
    if (entry) entry.work = Promise.all([entry.work, work])
  }
  return {
    reviewing(spec, action) {
      guard('not started', () => {
        if (deps.decisions.thresholds('approval').mode === 'off') return
        if (deps.localAvailable && !deps.localAvailable()) {
          // D6: the shadow never loads a model onto the GPU; it notes the skip and does nothing else.
          if (!skipped || Date.parse(lastSkip ?? '') < deps.now().getTime() - 3_600_000) deps.log('approval shadow: local decider unavailable (no local model server is running); reviews are not shadowed')
          skipped++; lastSkip = deps.now().toISOString()
          return
        }
        const key = keyOf(action)
        if (pending.has(key)) return
        if (pending.size >= PENDING_MAX) { const oldest = pending.keys().next().value!; pending.get(oldest)!.resolve({ ok: false, decider: 'approval-reviewer', reason: 'shadow queue full' }); drop(oldest) }
        let resolve!: (outcome: DeciderOutcome) => void
        const review = new Promise<DeciderOutcome>(done => { resolve = done })
        const frontier: Decider = { id: 'approval-reviewer', tier: 'frontier', supports: kind => kind === 'approval', decide: () => review }
        const expires = setTimeout(() => { resolve({ ok: false, decider: 'approval-reviewer', reason: 'the review never reported back' }); drop(key) }, REVIEW_WAIT_MS)
        expires.unref?.()
        const decision = deps.decisions.decide(approvalRequest(spec, action), { frontier }).catch(error => { deps.log('approval shadow decision failed', error); return null })
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
    stats: () => ({ skipped, lastSkip }),
    dispose() { for (const key of [...pending.keys()]) { pending.get(key)!.resolve({ ok: false, decider: 'approval-reviewer', reason: 'shutting down' }); drop(key) } }
  }
}
