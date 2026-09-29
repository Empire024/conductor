import type { AuditRun, ChangeClass, ProductionEnvironment, ProductionProfile, TargetFingerprint } from '../../shared/production'
import type { ScheduleExecutionContext, ScheduleExecutionResult } from '../schedule-executor'
import { classifyChange } from './fingerprint'

/**
 * The opt-in drift check (docs/production-agent.md sections 1 and 6): schedule kind
 * `production-drift`, host code under the schedule gate, created disabled and enabled from the
 * panel. It recomputes the target fingerprint and compares it with the last completed run's. When
 * nothing moved it returns `unchanged` and nothing else happens — no model is asked anything, no
 * run is queued. When something moved it records the current fingerprint (the gate then reads
 * STALE for the controls the change invalidates) and, with `onChange: 'audit'`, queues a change
 * run that re-tests only those controls.
 */

export interface DriftPorts {
  profile(projectId: string): ProductionProfile | null
  /** The environment the designation names (else the first). */
  environment(profile: ProductionProfile): ProductionEnvironment | null
  lastCompleted(projectId: string, environmentId: string): AuditRun | null
  /** The target as it is now: a full recompute (commit, config, policy pages, dependencies, routes, versions). */
  fingerprint(projectId: string, environment: ProductionEnvironment, signal: AbortSignal): Promise<TargetFingerprint>
  setCurrent(projectId: string, environmentId: string, fingerprint: TargetFingerprint): void
  requestChangeRun(projectId: string, environmentId: string, changes: ChangeClass[], fingerprint: TargetFingerprint): { runId: string | null; detail: string }
}

export interface DriftOutcome {
  outcome: 'unchanged' | 'changed' | 'dispatched' | 'skipped' | 'failed'
  detail: string
  changes: ChangeClass[]
  runId: string | null
}

export async function runDrift(ports: DriftPorts, projectId: string, signal: AbortSignal): Promise<DriftOutcome> {
  const skipped = (detail: string): DriftOutcome => ({ outcome: 'skipped', detail, changes: [], runId: null })
  const profile = ports.profile(projectId)
  if (!profile?.designation.productionReady) return skipped('The project is not designated production-ready.')
  if (!profile.drift.enabled) return skipped('Drift checks are off for this project.')
  const environment = ports.environment(profile)
  if (!environment) return skipped('No environment is designated.')
  const last = ports.lastCompleted(projectId, environment.id)
  if (!last) return skipped(`Environment ${environment.id} has no completed audit to compare with; run an audit first.`)
  let current: TargetFingerprint
  try { current = await ports.fingerprint(projectId, environment, signal) } catch (error) {
    return { outcome: 'failed', detail: `The fingerprint could not be computed: ${error instanceof Error ? error.message : String(error)}`, changes: [], runId: null }
  }
  ports.setCurrent(projectId, environment.id, current)
  const changes = classifyChange(last.fingerprint, current)
  if (!changes.length) return { outcome: 'unchanged', detail: `Nothing moved since run ${last.id} (${current.commit ?? 'no commit'}).`, changes, runId: null }
  if (profile.drift.onChange === 'mark-stale') return { outcome: 'changed', detail: `Changed since run ${last.id} (${changes.join(', ')}): marked stale.`, changes, runId: null }
  const queued = ports.requestChangeRun(projectId, environment.id, changes, current)
  return { outcome: queued.runId ? 'dispatched' : 'changed', detail: `Changed since run ${last.id} (${changes.join(', ')}): ${queued.detail}`, changes, runId: queued.runId }
}

/** The schedule executor for `production-drift` (registered by M8 with registerScheduleKindExecutor). */
export function productionDriftExecutor(ports: DriftPorts): (context: ScheduleExecutionContext) => Promise<ScheduleExecutionResult> {
  return async context => {
    const result = await runDrift(ports, context.schedule.projectId, context.signal)
    return { outcome: result.outcome, detail: result.detail }
  }
}
