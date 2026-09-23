import { createHash, randomUUID } from 'node:crypto'
import type { Json } from '../shared/structured-agent'

export type ReviewPhase = 'reviewing' | 'owner' | 'approved' | 'denied' | 'blocked' | 'paused' | 'responding' | 'responded' | 'execution-unknown' | 'executed' | 'execution-failed'
export interface ReviewAction {
  projectId: string; machineId: string; workerId: string; runtimeId: string; requestId: string
  cwd?: string
  ownerTaskId?: string
  tool: string; arguments: Json; paths: string[]; boundary: 'workspace-write' | 'native-owner' | 'unsupported'
  reason: string; sideEffects: string[]; ownerEvidence: string; authorizationId: string
  native: Json
}
export interface ReviewRecord {
  id: string; digest: string; requestKey: string; operationKey: string; targetKeys: string[]; projectId: string; machineId: string
  workerId: string; runtimeId: string; requestId: string; phase: ReviewPhase; rationale: string
  reviewerId?: string; reviewerModel?: string; reviewerTurnId?: string
  reviewerElapsedMs?: number; reviewerUsage?: Json
  ownerAnswer?: 'allow' | 'deny'; grantScope: 'exact-action'; createdAt: string; updatedAt: string
  denied?: boolean
  history: Array<{ at: string; phase: ReviewPhase; rationale: string }>
}
export interface ReviewResult { decision: 'allow' | 'deny' | 'escalate'; rationale: string; digest: string; reviewerId: string; model: string; turnId: string; elapsedMs?: number; usage?: Json }
export interface ReviewPersistence { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
export class ReviewRunError extends Error {
  constructor(message: string, readonly evidence: Pick<ReviewRecord, 'reviewerId' | 'reviewerModel' | 'reviewerTurnId' | 'reviewerElapsedMs' | 'reviewerUsage'>) { super(message) }
}

/** Stable JSON, not JSON insertion order; no argument or authority field is excluded. */
export function canonicalAction(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalAction).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalAction((value as Record<string, unknown>)[key])).join(',') + '}'
}
const hash = (value: unknown) => createHash('sha256').update(canonicalAction(value)).digest('hex')
export const actionDigest = (action: ReviewAction): string => hash(action)
const requestKey = (action: ReviewAction) => hash([action.workerId, action.runtimeId, action.requestId])
const operationKey = (action: ReviewAction) => hash([action.projectId, action.machineId, action.tool, action.arguments, action.paths])
// A denial conservatively fences the target, including changed contents and another worker/tool.
const targetKeys = (action: ReviewAction) => (action.paths.length ? action.paths : ['*']).map(path => hash([action.projectId, action.machineId, path]))
const safe = (text: string) => text.replace(/Bearer\s+\S+|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/gi, '[credential redacted]').replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 1600)

/** Host-only journal. Persist response intent before transport; never replay an uncertain allow.
 * Raw arguments, prompts, paths and credentials are deliberately absent from this audit. */
export class ApprovalReviews {
  private inFlight = new Map<string, Promise<ReviewRecord>>()
  constructor(private persistence: ReviewPersistence) {}
  private key(projectId: string) { return 'approval-review:v1:' + hash(projectId) }
  private records(projectId: string): ReviewRecord[] {
    const raw = this.persistence.getSetting(this.key(projectId))
    if (!raw) return []
    const records: unknown = JSON.parse(raw)
    if (!Array.isArray(records) || records.some(r => !r || typeof r.id !== 'string' || !Array.isArray(r.targetKeys) || !Array.isArray(r.history))) throw new Error('Approval audit is invalid; review is paused')
    return records as ReviewRecord[]
  }
  get(projectId: string, id: string): ReviewRecord | undefined { return this.records(projectId).find(record => record.id === id) }
  lookup(action: ReviewAction): ReviewRecord | undefined { return this.records(action.projectId).find(record => record.requestKey === requestKey(action)) }
  hasDenials(projectId: string): boolean { return this.records(projectId).some(record => record.denied) }
  /** A denial fences the exact paths it named; a pathless denial (a command, a search) fences only
   *  the same logical operation again, never every later request of the project. */
  denied(action: ReviewAction): boolean {
    const keys = targetKeys(action), all = hash([action.projectId, action.machineId, '*']), operation = operationKey(action)
    return this.records(action.projectId).some(record => record.denied && record.machineId === action.machineId
      && record.targetKeys.some(key => key === all ? record.operationKey === operation : keys.includes(key) && key !== all))
  }
  private save(record: ReviewRecord): ReviewRecord {
    const records = this.records(record.projectId), index = records.findIndex(item => item.id === record.id)
    if (index < 0) {
      // Never evict denial/idempotency evidence to make room for another attempt.
      if (records.length >= 1000) throw new Error('Approval journal capacity reached; review is paused')
      records.push(record)
    } else records[index] = record
    this.persistence.setSetting(this.key(record.projectId), JSON.stringify(records))
    return record
  }
  transition(record: ReviewRecord, phase: ReviewPhase, rationale: string, extra: Partial<ReviewRecord> = {}): ReviewRecord {
    const current = this.get(record.projectId, record.id)
    if (!current || current.phase !== record.phase || current.history.length !== record.history.length || current.digest !== record.digest) throw new Error('Approval state changed; stale transition refused')
    const at = new Date().toISOString(), message = safe(rationale)
    return this.save({ ...record, ...extra, ...(phase === 'denied' ? { denied: true } : {}), phase, rationale: message, updatedAt: at, history: [...record.history, { at, phase, rationale: message }] })
  }
  async review(action: ReviewAction, run: (digest: string) => Promise<ReviewResult>, changed: (record: ReviewRecord) => void): Promise<ReviewRecord> {
    const key = requestKey(action), digest = actionDigest(action)
    const existing = this.lookup(action)
    if (existing && existing.digest !== digest) return this.transition(existing, 'blocked', 'Native request identity was reused with changed arguments or authority; no response will be replayed')
    if (this.inFlight.has(key)) return this.inFlight.get(key)!
    if (existing) {
      // Reconnecting views recover the record. A process restart never restarts a model turn
      // or replays an allow whose response/execution could already have happened.
      if (['reviewing', 'approved', 'responding'].includes(existing.phase)) return this.transition(existing, 'paused', 'Recovered outstanding review after restart; inspect the original request before continuing')
      return existing
    }
    const at = new Date().toISOString()
    const operation = operationKey(action)
    const replay = this.records(action.projectId).find(record => record.operationKey === operation && record.history.some(entry => entry.phase === 'responding'))
    // Only a concrete path carries an execution uncertainty forward; a pathless request (the
    // wildcard target) would otherwise fence every later command of the project behind the first
    // one whose completion was never observed.
    const concrete = action.paths.length ? targetKeys(action) : []
    const uncertain = this.records(action.projectId).some(record => record.history.some(entry => entry.phase === 'responding') && !record.history.some(entry => ['executed', 'execution-failed'].includes(entry.phase)) && record.targetKeys.some(key => concrete.includes(key)))
    let record = this.save({ id: randomUUID(), digest, requestKey: key, operationKey: operation, targetKeys: targetKeys(action), projectId: action.projectId, machineId: action.machineId, workerId: action.workerId, runtimeId: action.runtimeId, requestId: action.requestId, phase: 'reviewing', rationale: 'Waiting for a stronger reviewing turn', grantScope: 'exact-action', createdAt: at, updatedAt: at, history: [] })
    if (this.denied(action)) return this.transition(record, 'denied', 'A durable denial covers this target. Another worker, argument or tool route cannot retry it')
    if (replay) return this.transition(record, 'blocked', 'This logical operation already has a native response intent. Reconnect or replacement requests cannot execute it again')
    if (uncertain) return this.transition(record, 'blocked', 'A prior action on this target has no conclusive execution result; another route cannot retry it')
    if (action.boundary === 'unsupported') return this.transition(record, 'blocked', action.reason)
    changed(record)
    const promise = (async () => {
      try {
        const result = await run(digest)
        if (result.digest !== digest || !result.turnId || !result.reviewerId || !result.model || result.reviewerId === action.workerId || !['allow', 'deny', 'escalate'].includes(result.decision)) throw new Error('Review result lacks a matching digest and independent native reviewer identity')
        // A denial or payload replacement can arrive while a review turn runs.
        const current = this.get(record.projectId, record.id)!
        if (current.phase !== 'reviewing') return current
        const phase = result.decision === 'deny' ? 'denied' : result.decision === 'escalate' ? 'owner' : action.boundary === 'workspace-write' ? 'approved' : 'blocked'
        record = this.transition(current, phase, phase === 'blocked' ? 'The reviewer cannot approve this native owner boundary. Explicit escalation is required. ' + result.rationale : result.rationale, { reviewerId: result.reviewerId, reviewerModel: result.model, reviewerTurnId: result.turnId, reviewerElapsedMs: result.elapsedMs, reviewerUsage: result.usage })
      } catch (error) {
        // A record the owner has since answered keeps that answer; only a review still waiting pauses.
        const current = this.get(record.projectId, record.id)!
        record = current.phase === 'reviewing' ? this.transition(current, 'paused', error instanceof Error ? error.message : 'Reviewer failed', error instanceof ReviewRunError ? error.evidence : {}) : current
      }
      return record
    })()
    this.inFlight.set(key, promise)
    try { return await promise } finally { this.inFlight.delete(key) }
  }
  /** One narrow response grant. Host revalidates live payload and restrictions immediately first. */
  reserve(action: ReviewAction, ownerAnswer?: 'allow' | 'deny'): ReviewRecord {
    const record = this.lookup(action)
    if (!record || record.digest !== actionDigest(action)) throw new Error('Approval does not match the current action')
    if (ownerAnswer) {
      if (record.phase !== 'owner') throw new Error('Owner approval is available only after explicit reviewer escalation')
      if (ownerAnswer === 'deny') return this.transition(record, 'denied', 'Owner denied this action and target', { ownerAnswer })
    } else if (!['approved', 'denied'].includes(record.phase)) throw new Error('There is no unconsumed review decision')
    if ((ownerAnswer === 'allow' || record.phase === 'approved') && this.denied(action)) throw new Error('A durable denial covers this action target')
    if (ownerAnswer === 'allow' || record.phase === 'approved') {
      const peers = this.records(action.projectId).filter(peer => peer.id !== record.id)
      const keys = action.paths.length ? targetKeys(action) : []
      if (peers.some(peer => peer.history.some(entry => entry.phase === 'responding') && (peer.operationKey === record.operationKey || !peer.history.some(entry => ['executed', 'execution-failed'].includes(entry.phase)) && peer.targetKeys.some(key => keys.includes(key))))) throw new Error('A competing operation already reserved this mutation or target; duplicate execution refused')
    }
    return this.transition(record, 'responding', 'Response intent persisted before native transport; it must not be replayed', ownerAnswer ? { ownerAnswer } : {})
  }
}
