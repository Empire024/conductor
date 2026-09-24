import { createHash } from 'node:crypto'
import type { AgentControlScope } from '../shared/agent-control'
import type { SessionPhase } from '../shared/structured-agent'

/**
 * Bounded recovery of a coworker's stopped work, and the record that a failure was superseded.
 *
 * A controller may reconnect a failed, interrupted or disconnected coworker (agents.resume), but
 * only a few times in a window: a supervising loop that keeps resuming a conversation that keeps
 * failing is burning the owner's allowance, and after the bound the decision is the owner's. The
 * owner's own calls (scope.owner) are not counted against it. A wizard tab holds the owner's
 * authority but is unattended, so it is bounded like any other caller.
 *
 * Nothing here widens authority: who may resume whom is still AgentControl.target's check (never
 * the caller itself or an ancestor, never a tab another controller holds). A resume never runs
 * while a request is pending (StructuredSessions.resume refuses active phases), so a pending
 * approval is not expired by recovery.
 *
 * A failure whose work an accepted replacement took over is marked superseded, so a roll-up can
 * tell "this failed and was redone by X" from "this failed and nobody picked it up", and a
 * superseded conversation is not resumed again by mistake.
 */
export const RECOVERY_ATTEMPTS = 3
export const RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1000
/** A conversation that stopped without finishing: resuming it is a recovery, and counts. */
export const FAILED: ReadonlySet<SessionPhase> = new Set(['failed', 'interrupted', 'disconnected'])
/** Stopped at all: what can be superseded. Resuming an idle or completed one is routine, not counted. */
export const STOPPED: ReadonlySet<SessionPhase> = new Set([...FAILED, 'idle', 'completed'])

export interface RecoveryAttempt { by: string; at: string; phaseBefore: SessionPhase; owner: boolean }
export interface Supersession { by: string; at: string; reason: string; recordedBy: string }
export interface RecoveryRecord { targetId: string; attempts: RecoveryAttempt[]; superseded?: Supersession }
export interface RecoveryStatus { attempts: number; remaining: number; windowHours: number; lastAttemptAt: string | null; superseded: Supersession | null }
interface Persistence { getSetting(key: string): string | null; setSetting(key: string, value: string): void }

export class CoworkerRecovery {
  constructor(private persistence: Persistence, private now: () => number = Date.now) {}
  private key(projectId: string, targetId: string) { return 'coworker-recovery:v1:' + createHash('sha256').update(JSON.stringify([projectId, targetId])).digest('hex') }
  get(projectId: string, targetId: string): RecoveryRecord {
    const raw = this.persistence.getSetting(this.key(projectId, targetId))
    const parsed: unknown = raw ? JSON.parse(raw) : undefined
    return parsed && typeof parsed === 'object' && Array.isArray((parsed as RecoveryRecord).attempts) ? parsed as RecoveryRecord : { targetId, attempts: [] }
  }
  private save(projectId: string, record: RecoveryRecord): void { this.persistence.setSetting(this.key(projectId, record.targetId), JSON.stringify(record)) }
  private counted(record: RecoveryRecord): RecoveryAttempt[] {
    const since = this.now() - RECOVERY_WINDOW_MS
    return record.attempts.filter(attempt => !attempt.owner && FAILED.has(attempt.phaseBefore) && Date.parse(attempt.at) >= since)
  }
  status(projectId: string, targetId: string): RecoveryStatus {
    const record = this.get(projectId, targetId), counted = this.counted(record)
    return { attempts: counted.length, remaining: Math.max(0, RECOVERY_ATTEMPTS - counted.length), windowHours: RECOVERY_WINDOW_MS / 3_600_000, lastAttemptAt: record.attempts.at(-1)?.at ?? null, superseded: record.superseded ?? null }
  }
  /** Throws when this caller may not recover the target now; returns nothing when it may. */
  admit(scope: AgentControlScope, targetId: string, phase: SessionPhase): void {
    const record = this.get(scope.projectId, targetId)
    if (record.superseded) throw new Error(`This conversation's work was superseded by ${record.superseded.by} (${record.superseded.reason}); it is not unfinished work. Continue in ${record.superseded.by} instead`)
    if (!STOPPED.has(phase)) throw new Error(`Recovery applies to a stopped conversation; this one is ${phase}. A pending request is answered, not recovered`)
    if (scope.owner || !FAILED.has(phase)) return
    if (this.counted(record).length >= RECOVERY_ATTEMPTS) throw new Error(`This conversation was already recovered ${RECOVERY_ATTEMPTS} times in the last ${RECOVERY_WINDOW_MS / 3_600_000} hours. Stop and tell the owner what keeps failing; the owner can resume it again`)
  }
  record(scope: AgentControlScope, targetId: string, phaseBefore: SessionPhase): RecoveryStatus {
    const record = this.get(scope.projectId, targetId)
    // Bounded storage: the window only ever needs the newest few attempts.
    record.attempts = [...record.attempts, { by: scope.owner ? 'owner' : scope.agentSessionId, at: new Date(this.now()).toISOString(), phaseBefore, owner: scope.owner === true }].slice(-20)
    this.save(scope.projectId, record)
    return this.status(scope.projectId, targetId)
  }
  /** Marks a stopped conversation's work as taken over by `by`. Only a stopped one: a running
   *  conversation is not a failure, and its pending requests stay its own. */
  supersede(scope: AgentControlScope, targetId: string, phase: SessionPhase, by: string, reason: string): RecoveryStatus {
    if (by === targetId) throw new Error('A conversation cannot supersede itself')
    if (!STOPPED.has(phase)) throw new Error(`Only a stopped conversation can be superseded; this one is ${phase}`)
    const trimmed = reason.trim()
    if (!trimmed || trimmed.length > 300) throw new Error('reason must be 1-300 characters')
    const record = this.get(scope.projectId, targetId)
    record.superseded = { by, at: new Date(this.now()).toISOString(), reason: trimmed, recordedBy: scope.owner ? 'owner' : scope.agentSessionId }
    this.save(scope.projectId, record)
    return this.status(scope.projectId, targetId)
  }
}
