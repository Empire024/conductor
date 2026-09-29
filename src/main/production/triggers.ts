import { join } from 'node:path'
import {
  CONTROL_IDS, PRODUCTION_ARTIFACTS_DIR,
  type AuditRun, type AuditTrigger, type ChangeClass, type ControlId, type Finding, type RunKind, type StepKind, type TargetFingerprint,
} from '../../shared/production'
import { makeId } from '../../shared/models'
import { classifyChange, sameTarget } from './fingerprint'
import { controlsInvalidatedBy } from './registry'
import { ActiveRunError, type ProductionStore } from './store'

/**
 * Run triggers, dedup and change detection (docs/production-agent.md section 6).
 *
 * - One active run per (project, environment): a trigger while one is active sets its
 *   `rerunRequested` (the latest trigger wins, change classes merge), so any number of triggers
 *   coalesce into exactly one follow-up run, which the service starts when the active run ends.
 * - An automatic trigger (change, drift, schedule, designation) whose fingerprint equals the last
 *   completed run's, within DUPLICATE_WINDOW_MS of it, is dropped as a duplicate. The owner's own
 *   Audit/Re-test/Verify is never dropped.
 * - A `change` run carries only the controls its change classes invalidate, unless `full`; a
 *   profile or registry change invalidates everything.
 */

export const DUPLICATE_WINDOW_MS = 10 * 60_000
const AUTOMATIC: readonly AuditTrigger['kind'][] = ['change', 'drift', 'schedule', 'designation']

export interface RunRequest {
  projectId: string
  environmentId: string
  kind: RunKind
  trigger: AuditTrigger
  /** Explicit control subset (the owner's request, or a retest's findings). */
  controls?: ControlId[]
  full?: boolean
  /** Findings a verify run verifies (or a retest re-tests). */
  findingIds?: string[]
  /** The fingerprint the trigger saw (cheap recompute), for dedup and the queued run. */
  fingerprint: TargetFingerprint
}

export type RunRequestOutcome =
  | { outcome: 'created'; run: AuditRun }
  | { outcome: 'coalesced'; run: AuditRun }
  | { outcome: 'dropped'; reason: string; run: AuditRun | null }

export interface TriggerDeps {
  store: ProductionStore
  /** userData; run artifacts live under userData/production-audits/<projectId>/<runId>/. */
  userData: string
  now: () => Date
}

/** The step list of a run kind. */
export function stepsFor(kind: RunKind, controls: readonly ControlId[]): Array<{ kind: StepKind; controlId?: ControlId | null }> {
  const controlSteps = controls.map(controlId => ({ kind: 'control' as const, controlId }))
  if (kind === 'verify') return [{ kind: 'discovery' }, { kind: 'fingerprint' }, ...controlSteps, { kind: 'report' }]
  if (kind === 'retest') return [{ kind: 'discovery' }, { kind: 'fingerprint' }, ...controlSteps, { kind: 'interpretation' }, { kind: 'report' }]
  return [{ kind: 'discovery' }, { kind: 'fingerprint' }, { kind: 'legal-sources' }, ...controlSteps, { kind: 'engineering-smokes' }, { kind: 'interpretation' }, { kind: 'report' }]
}

/** Which controls a run carries. */
export function controlsFor(request: Pick<RunRequest, 'kind' | 'trigger' | 'controls' | 'full'>, findings: readonly Pick<Finding, 'controlId'>[] = []): ControlId[] {
  const order = (ids: Iterable<ControlId>): ControlId[] => { const set = new Set(ids); return CONTROL_IDS.filter(id => set.has(id)) }
  if (request.kind === 'verify' || request.kind === 'retest') return order(findings.map(finding => finding.controlId))
  if (request.controls?.length) return order(request.controls)
  if ((request.trigger.kind === 'change' || request.trigger.kind === 'drift') && !request.full && request.trigger.changes.length) return order(controlsInvalidatedBy(request.trigger.changes))
  return [...CONTROL_IDS]
}

export function requestRun(deps: TriggerDeps, request: RunRequest): RunRequestOutcome {
  const { store } = deps
  const active = store.activeRun(request.projectId, request.environmentId)
  if (active) return coalesce(store, active, request.trigger)
  if (AUTOMATIC.includes(request.trigger.kind)) {
    const last = store.lastCompletedRun(request.projectId, request.environmentId)
    if (last?.finishedAt && deps.now().getTime() - Date.parse(last.finishedAt) < DUPLICATE_WINDOW_MS && sameTarget(last.fingerprint, request.fingerprint)) {
      return { outcome: 'dropped', reason: `The target is unchanged since run ${last.id} finished at ${last.finishedAt}; the ${request.trigger.kind} trigger was dropped as a duplicate.`, run: last }
    }
  }
  const findings = request.findingIds?.length ? store.findingsByIds(request.projectId, request.findingIds) : []
  if ((request.kind === 'verify' || request.kind === 'retest') && !findings.length) throw new Error(`A ${request.kind} run needs findings of this project`)
  const foreign = findings.filter(finding => finding.environmentId !== request.environmentId)
  if (foreign.length) throw new Error(`Findings ${foreign.map(finding => finding.id).join(', ')} belong to another environment; results never carry across environments`)
  const controls = controlsFor(request, findings)
  if (!controls.length) return { outcome: 'dropped', reason: `The change (${request.trigger.changes.join(', ')}) invalidates no control.`, run: null }
  const id = makeId('prun')
  try {
    const run = store.createRun({
      id, projectId: request.projectId, kind: request.kind, environmentId: request.environmentId, trigger: request.trigger,
      parentRunId: store.lastCompletedRun(request.projectId, request.environmentId)?.id ?? null,
      verifies: request.kind === 'verify' ? findings.map(finding => finding.id) : [],
      fingerprint: request.fingerprint, controls, steps: stepsFor(request.kind, controls),
      artifactsDir: join(deps.userData, PRODUCTION_ARTIFACTS_DIR, safe(request.projectId), id),
    })
    return { outcome: 'created', run }
  } catch (error) {
    // Two triggers raced: the loser coalesces into the winner.
    if (error instanceof ActiveRunError) return coalesce(store, store.run(error.activeRunId), request.trigger)
    throw error
  }
}

function coalesce(store: ProductionStore, active: AuditRun, trigger: AuditTrigger): RunRequestOutcome {
  const updated = store.requestRerun(active.id, trigger)
  return updated ? { outcome: 'coalesced', run: updated } : { outcome: 'dropped', reason: `Run ${active.id} already ended`, run: active }
}

/** The change classes between the last completed run and the target as it is now. */
export function detectChanges(last: AuditRun | null, current: TargetFingerprint): ChangeClass[] {
  return last ? classifyChange(last.fingerprint, current) : []
}

export function trigger(kind: AuditTrigger['kind'], by: AuditTrigger['by'], at: Date, detail: string, changes: ChangeClass[] = []): AuditTrigger {
  return { kind, by, at: at.toISOString(), changes, detail }
}

export const CONDUCTOR_ACTOR: AuditTrigger['by'] = { kind: 'conductor', agentSessionId: null, title: 'Conductor' }

const safe = (id: string): string => id.replace(/[^A-Za-z0-9_.-]/g, '_')
