import type { DurableJobOperation } from '../../shared/durable-jobs'
import { operationKindForTool } from './controller'
import type { StageRuntime } from './ports'
import type { DurableJobStore, StoredJob, WriteGuard } from './store'
import type { WorktreeOps } from './worktree'

/**
 * Reconciliation on app start.
 *
 * Process semantics. A durable job outlives the process that ran it; its stage conversation does
 * not. When Conductor quits (normally, by crash, by an update restart or by a reboot) the
 * controller writes nothing on the way out, so a job that was running stays `running` in the
 * database with the dead process's lease (pid + launch id). Conductor holds a single-instance
 * lock, so on the next launch any lease owned by a different launch id belongs to a process that
 * no longer exists, whatever its expiry says. For every job in `running` or `recovering` this
 * pass therefore:
 *   1. takes the lease over (new epoch: anything the old process might still flush is refused),
 *   2. moves the job to `recovering` and counts a recovery,
 *   3. settles every operation still `intended` in the ledger to done, failed or unknown with the
 *      reason it decided that, reading only durable evidence (the structured session projection,
 *      the local task checkpoint, git history, snapshot manifests),
 *   4. leaves the job `recovering` for the controller to resume from its last valid checkpoint and
 *      handoff, or moves it to `blocked` with a practical next action when any side effect is
 *      unknown. Shell commands, file writes, git and tests are never replayed blindly; the local
 *      session checkpoint already refuses to replay its own pending tool call (agent.ts).
 * Jobs that were queued or paused need nothing: they hold no conversation. A blocked job holds no
 * loop, but its stage may still be `running` (blocked on an approval or a question in its
 * conversation, or blocked by an earlier pass on an unknown side effect); see reconcileBlocked.
 */

export interface ReconcileOptions {
  store: DurableJobStore
  runtime: StageRuntime
  worktrees: WorktreeOps
  ownerId: string
  leaseTtlMs: number
}

export interface ReconcileOutcome {
  jobId: string
  /** 'resume': ready for controller.start; 'blocked': waits for the owner. */
  decision: 'resume' | 'blocked'
  /** Stage conversations the restart cut off (their projection may still read active). */
  lostSessions: string[]
  operations: Array<Pick<DurableJobOperation, 'id' | 'kind' | 'status' | 'reconciliation'>>
}

type Verdict = { status: 'done' | 'failed' | 'unknown'; reason: string }

async function decide(options: ReconcileOptions, job: StoredJob, guard: WriteGuard, op: DurableJobOperation, lost: string[]): Promise<Verdict> {
  if (op.kind === 'model-call') {
    const stage = options.store.stages(job.id).find(candidate => candidate.id === op.stageId)
    const id = stage?.agentSessionId
    if (!id) return { status: 'failed', reason: 'The conversation was never opened before Conductor stopped; the stage starts a fresh one from the last handoff.' }
    const observation = options.runtime.observe(id)
    const pending = observation.execution?.pending
    if (pending) {
      // Recorded as its own ledger entry so the report names the command, not just the stage.
      const record = options.store.intend(job.id, guard, { stageId: op.stageId, kind: operationKindForTool(pending.name), description: `${pending.name} ${pending.arguments.slice(0, 600)}` })
      options.store.settle(job.id, guard, record.id, 'unknown', 'Found pending in the local task checkpoint after a restart: it was cut off before its result was saved and is not replayed.')
      lost.push(id)
      return { status: 'unknown', reason: `The conversation stopped inside ${pending.name} (${pending.id}); its side effect is unknown and it is not replayed.` }
    }
    if (observation.phase === 'completed' && observation.stopSequence > 0) return { status: 'done', reason: 'The conversation finished before Conductor stopped; its result is read from the persisted timeline.' }
    lost.push(id)
    return { status: 'failed', reason: `The conversation was cut off by the restart (last phase ${observation.phase}) with no tool call pending; the stage restarts in a fresh conversation from the last handoff.` }
  }
  if (op.kind === 'git') {
    if (!job.worktree) return { status: 'unknown', reason: 'A git operation was recorded but the job has no worktree to inspect.' }
    const commit = await options.worktrees.findCommit(job.worktree.path, op.id).catch(() => undefined)
    return commit
      ? { status: 'done', reason: `Commit ${commit} carries this operation id.` }
      : { status: 'failed', reason: 'No commit carries this operation id; not replayed. The next checkpoint commits the same tree.' }
  }
  if (op.kind === 'file-write') {
    const directory = /into (.+)$/.exec(op.description)?.[1]
    if (directory && op.description.startsWith('Snapshot ')) {
      return options.worktrees.snapshotComplete(directory)
        ? { status: 'done', reason: 'The snapshot manifest exists.' }
        : { status: 'failed', reason: 'The snapshot has no manifest and is incomplete; the next checkpoint writes a new one.' }
    }
  }
  return { status: 'unknown', reason: `A ${op.kind} operation was in flight and its outcome cannot be verified; it is not replayed.` }
}

/** A stage conversation that had not finished before the restart died with the process. */
const cutOff = (options: ReconcileOptions, agentSessionId: string): boolean => {
  const observation = options.runtime.observe(agentSessionId)
  return !(observation.phase === 'completed' && observation.stopSequence > 0)
}

/**
 * A blocked job whose stage is still `running`. Its conversation was opened by the process that
 * died, so it is reported lost: the owner's resume then retries the stage in a fresh conversation
 * instead of re-attaching to the dead one and blocking on the same approval after every restart.
 * A model call it left in flight is settled here; an unknown effect updates the next action. The
 * job stays blocked for the owner, and a later launch with nothing left to settle writes nothing.
 */
async function reconcileBlocked(options: ReconcileOptions, listed: StoredJob): Promise<ReconcileOutcome | undefined> {
  const running = options.store.stages(listed.id).filter(stage => stage.status === 'running' && stage.agentSessionId)
  if (!running.length) return undefined
  const lost: string[] = []
  const settled: ReconcileOutcome['operations'] = []
  const intended = options.store.operations(listed.id, 'intended')
  if (intended.length) {
    const lease = options.store.acquire(listed.id, options.ownerId, options.leaseTtlMs, { takeover: true, reason: 'reconciliation of a blocked job after Conductor restarted' })
    const guard: WriteGuard = { epoch: lease.epoch }
    const job = options.store.get(listed.id)
    for (const op of intended) {
      const verdict = await decide(options, job, guard, op, lost)
      const record = options.store.settle(job.id, guard, op.id, verdict.status, verdict.reason)
      options.store.event(job.id, guard, 'recovery', `${op.kind} "${op.description}": ${verdict.status}. ${verdict.reason}`, { operationId: op.id, status: verdict.status })
      settled.push({ id: record.id, kind: record.kind, status: record.status, reconciliation: record.reconciliation })
    }
    if (settled.some(op => op.status === 'unknown')) {
      const described = options.store.operations(job.id, 'unknown').slice(-3).map(op => op.description).join('; ')
      const nextAction = `Inspect the workspace (${job.cwd}) for the effect of: ${described}. Nothing was replayed. Resume the job once the files are in the state you want, or cancel it.`
      options.store.update(job.id, guard, { handoff: { ...job.handoff, nextAction, updatedAt: new Date().toISOString() } })
    }
    options.store.release(job.id, guard)
  }
  for (const stage of running) if (!lost.includes(stage.agentSessionId!) && cutOff(options, stage.agentSessionId!)) lost.push(stage.agentSessionId!)
  return { jobId: listed.id, decision: 'blocked', lostSessions: lost, operations: settled }
}

export async function reconcileJobs(options: ReconcileOptions): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = []
  for (const listed of options.store.list({ status: ['running', 'recovering', 'blocked'] })) {
    if (listed.status === 'blocked') {
      const outcome = await reconcileBlocked(options, listed)
      if (outcome) outcomes.push(outcome)
      continue
    }
    const previous = listed.lease
    // A job this very process already started (created in the seconds before this pass ran) is
    // live, not left over: taking it over would supersede its own loop and strand it.
    if (previous?.ownerId === options.ownerId) continue
    // Active time ends where the dead process was last seen (its last event or lease renewal),
    // not at this launch: the downtime was not work.
    const lastSeen = Math.max(Date.parse(options.store.lastEvent(listed.id)?.at ?? '') || 0, previous ? Date.parse(previous.expiresAt) - options.leaseTtlMs || 0 : 0)
    const lease = options.store.acquire(listed.id, options.ownerId, options.leaseTtlMs, { takeover: true, reason: 'reconciliation after Conductor restarted' })
    const guard: WriteGuard = { epoch: lease.epoch }
    if (listed.status === 'running') options.store.transition(listed.id, 'recovering', 'Conductor restarted while this job was running', guard, {}, undefined, lastSeen || undefined)
    options.store.count(listed.id, guard, { recoveries: 1 })
    options.store.event(listed.id, guard, 'recovery', `Reconciling after restart; previous owner ${previous?.ownerId ?? 'unknown'} (epoch ${previous?.epoch ?? 0})`, { previousOwner: previous?.ownerId ?? null, epoch: lease.epoch })
    const job = options.store.get(listed.id)
    const lost: string[] = []
    const settled: ReconcileOutcome['operations'] = []
    for (const op of options.store.operations(job.id, 'intended')) {
      const verdict = await decide(options, job, guard, op, lost)
      const record = options.store.settle(job.id, guard, op.id, verdict.status, verdict.reason)
      options.store.event(job.id, guard, 'recovery', `${op.kind} "${op.description}": ${verdict.status}. ${verdict.reason}`, { operationId: op.id, status: verdict.status })
      settled.push({ id: record.id, kind: record.kind, status: record.status, reconciliation: record.reconciliation })
    }
    // A running stage whose conversation is not accounted for above (no op in flight) is lost too.
    for (const stage of options.store.stages(job.id)) if (stage.status === 'running' && stage.agentSessionId && !lost.includes(stage.agentSessionId) && cutOff(options, stage.agentSessionId)) lost.push(stage.agentSessionId)
    if (settled.some(op => op.status === 'unknown')) {
      const described = options.store.operations(job.id, 'unknown').slice(-3).map(op => op.description).join('; ')
      const nextAction = `Inspect the workspace (${job.cwd}) for the effect of: ${described}. Nothing was replayed. Resume the job once the files are in the state you want, or cancel it.`
      options.store.transition(job.id, 'blocked', 'A side effect was in flight when Conductor stopped and its outcome is unknown', guard, { handoff: { ...job.handoff, nextAction, updatedAt: new Date().toISOString() } }, { nextAction })
      options.store.release(job.id, guard)
      outcomes.push({ jobId: job.id, decision: 'blocked', lostSessions: lost, operations: settled })
      continue
    }
    // Released so the controller's start takes the job with its own (next) epoch.
    options.store.release(job.id, guard)
    outcomes.push({ jobId: job.id, decision: 'resume', lostSessions: lost, operations: settled })
  }
  return outcomes
}
