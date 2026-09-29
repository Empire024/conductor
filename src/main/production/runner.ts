import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIDENCES, SEVERITIES,
  type Adapters, type AuditBrowser, type AuditRun, type CheckContext, type CheckOutcome, type ControlCheck, type ControlId, type ControlResult,
  type EvidenceKind, type EvidenceRef, type EvidenceSink, type Finding, type GateState, type NetworkPolicy, type ProductionEnvironment,
  type ProductionProfile, type RouteCoverage, type RouteEntry, type RunStep, type SourceTree, type TargetFingerprint, type VerificationRecord,
} from '../../shared/production'
import { discoverStack } from './discovery'
import { createEvidenceSink } from './evidence'
import { controlStatus } from './gate'
import { createRunInterpreter, type InterpreterPorts } from './interpret'
import { assertMutationAllowed, MutationRefused, policyForEnvironment } from './netpolicy'
import { controlDefinition, decideApplicability, provenanceFor } from './registry'
import { buildReport, writeReport, type EngineeringSmokeOutcome } from './report'
import { OWNER, StaleEpochError, WriteNotAuthorizedError, emptyCoverage, reconcileRuns, type ProductionStore, type ReconcileRunOutcome, type WriteGuard } from './store'
import { createSyntheticFactory } from './synthetic'
import { autoTaskFindings, claimedFixed, closeFixedTask, ensureFixTasks, type FixTaskBoard } from './tasks'
import { recheckSpec, reviewDisagreement, verdict } from './verifier'
import { checkLegalSources, sourcesFor, type LegalSourceCheck, type PublicReader } from './checks/legal-sources'
import { runEngineeringSmoke, type CommandRunner } from './checks/engineering-smokes'

/**
 * The audit run engine (docs/production-agent.md sections 2, 4 and 6). One run at a time on this
 * machine (MAX_CONCURRENT_RUNS). A run is a list of steps — discovery, fingerprint, legal-sources,
 * one step per control, engineering-smokes, interpretation, report — executed under a lease epoch;
 * every finished step writes the checkpoint, so a restart resumes exactly at `nextStepIndex` with a
 * fresh browser and never repeats a done step. Everything a later step needs from an earlier one is
 * kept in the run's artifacts (`state/`), not in memory.
 *
 * Mutations: a check mutates only through `context.operation`, which refuses before the network
 * without a live write authorization naming the kind (never on production), journals the operation
 * as `intended`, runs it and settles it. A restart with an intended operation blocks the run
 * (store.reconcileRuns); nothing is replayed.
 *
 * Budget: model calls pre-charge and reconcile through the interpreter; requests and elapsed time
 * are charged after every step. Once any ceiling is reached the remaining controls are UNVERIFIED
 * ("budget exhausted"), interpretation stops, and the report still runs: a budget stop is never a
 * PASS. A run that exhausts its budget before any control concluded is blocked for the owner.
 */

export const DEFAULT_LEASE_TTL_MS = 60_000
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000
/** Controls the interpretation step explains per run at most (each is one model call). */
export const MAX_INTERPRETED_CONTROLS = 12

export interface BrowserFactoryOptions {
  userDataDir: string
  evidence: EvidenceSink & { addSecrets?(values: Iterable<string>): void }
  signal: AbortSignal
}

export interface FingerprintRequest {
  run: AuditRun
  profile: ProductionProfile
  environment: ProductionEnvironment
  /** The run's audit browser, for reading policy pages (read-only); null for a cheap recompute. */
  browser: AuditBrowser | null
  source: SourceTree | null
  signal: AbortSignal
}

export interface RunnerDeps {
  store: ProductionStore
  /** This launch's lease owner id. */
  ownerId: string
  clock?: () => Date
  checks: readonly ControlCheck[]
  browserFactory(policy: NetworkPolicy, options: BrowserFactoryOptions): AuditBrowser
  interpreter: InterpreterPorts
  sourceTree(projectId: string): SourceTree | null
  projectRoot(projectId: string): string | null
  adapters(environment: ProductionEnvironment, policy: NetworkPolicy, projectId: string): Adapters
  fingerprint(request: FingerprintRequest): Promise<TargetFingerprint>
  board: FixTaskBoard | null
  runCommand?: CommandRunner | null
  readPublic?: PublicReader | null
  /** Crawl for routes when the profile lists none (default true). */
  discovery?: boolean
  /** The gate as it will read after this run, for the report's statement. */
  gateAfter?(run: AuditRun): GateState | null
  /** Called once a run reached a terminal status (reruns, notifications). */
  onFinished?(run: AuditRun): void
  leaseTtlMs?: number
  checkTimeoutMs?: number
  log?(line: string): void
}

class RunStopped extends Error { constructor(reason: string) { super(reason); this.name = 'RunStopped' } }

interface Active { runId: string; controller: AbortController; done: Promise<void>; halted: boolean }

export class ProductionRunner {
  private active: Active | null = null
  private readonly resumes: string[] = []
  private readonly waiters: Array<() => void> = []
  private stopped = false
  private readonly clock: () => Date

  constructor(private readonly deps: RunnerDeps) {
    this.clock = deps.clock ?? (() => new Date())
  }

  /** Reconciles runs a previous launch left behind, then starts the queue. */
  start(): ReconcileRunOutcome[] {
    this.stopped = false
    const outcomes = reconcileRuns({ store: this.deps.store, ownerId: this.deps.ownerId, leaseTtlMs: this.leaseTtl })
    this.pump()
    return outcomes
  }

  /** Stops taking runs and aborts the one in flight; its lease is released by the abort path. */
  async stop(): Promise<void> {
    this.stopped = true
    const active = this.active
    if (active) { active.controller.abort(); await active.done }
  }

  /** Tests only: the process dies mid-run. No further write, no lease release, no cleanup. */
  async abandon(): Promise<void> {
    this.stopped = true
    const active = this.active
    if (active) { active.halted = true; active.controller.abort(); await active.done.catch(() => undefined) }
  }

  get activeRunId(): string | null { return this.active?.runId ?? null }

  /** Resolves when nothing is running and nothing is waiting. */
  idle(): Promise<void> {
    if (!this.active && !this.nextRun()) return Promise.resolve()
    return new Promise(resolve => this.waiters.push(resolve))
  }

  /** Starts the next queued (or recovering) run when none is active. */
  pump(): void {
    if (this.stopped || this.active) return
    const next = this.nextRun()
    if (!next) { for (const resolve of this.waiters.splice(0)) resolve(); return }
    this.launch(next)
  }

  /** The owner resumes a paused or blocked run (it starts when no other run is active). */
  resume(runId: string): void {
    const run = this.deps.store.run(runId)
    if (run.status !== 'paused' && run.status !== 'blocked') throw new Error(`Run ${runId} is ${run.status}; only a paused or blocked run resumes`)
    if (!this.resumes.includes(runId)) this.resumes.push(runId)
    this.pump()
  }

  /** The owner pauses: the lease is superseded, so the runner's next write fails and it stops. */
  pause(runId: string, reason: string): AuditRun {
    this.deps.store.supersede(runId, `paused: ${reason}`)
    const run = this.deps.store.transition(runId, 'paused', reason, OWNER)
    if (this.active?.runId === runId) this.active.controller.abort()
    return run
  }

  cancel(runId: string, reason: string): AuditRun {
    const store = this.deps.store
    store.supersede(runId, `cancelled: ${reason}`)
    for (const operation of store.operations(runId, 'intended')) store.settle(runId, OWNER, operation.id, 'unknown', `Run cancelled by the owner while this ${operation.mutation} was in flight; it is not replayed.`)
    const run = store.transition(runId, 'cancelled', reason, OWNER)
    if (this.active?.runId === runId) this.active.controller.abort()
    else { this.deps.onFinished?.(run); this.pump() }
    return run
  }

  private get leaseTtl(): number { return this.deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS }

  private nextRun(): string | null {
    while (this.resumes.length) {
      const id = this.resumes[0]!
      const status = this.deps.store.findRun(id)?.status
      if (status === 'paused' || status === 'blocked') return id
      this.resumes.shift()
    }
    const candidates = this.deps.store.runsByStatus(['recovering', 'queued'], 50)
    return (candidates.find(run => run.status === 'recovering') ?? candidates[0])?.id ?? null
  }

  private launch(runId: string): void {
    const index = this.resumes.indexOf(runId)
    if (index >= 0) this.resumes.splice(index, 1)
    const controller = new AbortController()
    const active: Active = { runId, controller, halted: false, done: Promise.resolve() }
    this.active = active
    active.done = this.execute(runId, active).catch(error => {
      if (!active.halted) this.deps.log?.(`production run ${runId} stopped: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      if (this.active === active) this.active = null
      if (!active.halted) this.pump()
    })
  }

  // ---- one run ------------------------------------------------------------------------------------

  private async execute(runId: string, active: Active): Promise<void> {
    const { store } = this.deps
    const signal = active.controller.signal
    const initial = store.run(runId)
    const lease = store.acquire(runId, this.deps.ownerId, this.leaseTtl)
    const guard: WriteGuard = { epoch: lease.epoch }
    const alive = (): void => { if (active.halted || signal.aborted) throw new RunStopped(signal.reason ? String(signal.reason) : 'stopped') }
    const renew = setInterval(() => {
      try { store.renew(runId, lease.epoch, this.leaseTtl) } catch { active.controller.abort('lease lost') }
    }, Math.max(1_000, Math.floor(this.leaseTtl / 3)))
    renew.unref?.()
    let browser: AuditBrowser | null = null
    let finished: AuditRun | null = null
    try {
      const profile = store.profile(initial.projectId)
      const environment = profile?.environments.find(entry => entry.id === initial.environmentId) ?? null
      if (!profile || !environment) {
        if (initial.status === 'queued' || initial.status === 'recovering' || initial.status === 'blocked') store.transition(runId, initial.status === 'queued' ? 'cancelled' : 'failed', `Environment ${initial.environmentId} is no longer in the production profile`, guard)
        return
      }
      store.transition(runId, 'running', initial.status === 'queued' ? 'started' : `resumed from ${initial.status} at step ${initial.checkpoint.nextStepIndex + 1}`, guard)
      const run = (): AuditRun => store.run(runId)
      const state = new RunState(initial.artifactsDir)
      const evidence = createRunEvidence(initial.artifactsDir, lease.epoch)
      const synthetic = createSyntheticFactory()
      evidence.setMarkers(() => synthetic.markers())
      const policy0 = policyForEnvironment(environment, { authorizations: profile.writeAuthorizations, budget: initial.budget, now: this.clock() })
      // A resumed run's browser may only spend what the ledger has left.
      const policy: NetworkPolicy = { ...policy0, maxRequests: Math.max(0, initial.budget.maxRequests - initial.ledger.requests) }
      browser = this.deps.browserFactory(policy, { userDataDir: join(initial.artifactsDir, `attempt-${lease.epoch}`, 'browser'), evidence, signal })
      const availability = await browser.availability()
      alive()
      if (!availability.available && initial.steps.some(step => step.kind === 'control' && step.status !== 'done' && step.status !== 'skipped')) {
        finished = store.transition(runId, 'blocked', `No audit browser on this machine: ${availability.reason ?? 'unavailable'}. Install Microsoft Edge or Google Chrome (or Playwright Chromium), then resume.`, guard)
        return
      }
      const source = this.deps.sourceTree(initial.projectId)
      const adapters = this.deps.adapters(environment, policy, initial.projectId)
      const interpreter = createRunInterpreter({ ports: this.deps.interpreter, store, run: initial, guard, clock: this.clock })
      const scope: StepScope = { runId, guard, profile, environment, policy, browser, source, adapters, evidence, synthetic, interpreter, state, signal, alive, run }

      let requestsCharged = browser.budget().requests
      for (const step of store.steps(runId)) {
        if (step.status === 'done' || step.status === 'skipped') continue
        alive()
        const started = Date.now()
        store.startStep(runId, guard, step.id)
        try {
          await this.step(step, scope)
          alive()
          store.finishStep(runId, guard, step.id, 'done')
        } catch (error) {
          if (error instanceof RunStopped || error instanceof StaleEpochError || active.halted) throw error
          const message = error instanceof Error ? error.message : String(error)
          store.finishStep(runId, guard, step.id, 'failed', message)
          finished = store.transition(runId, 'failed', `Step ${step.index + 1} (${step.kind}${step.controlId ? ` ${step.controlId}` : ''}) failed: ${message}`, guard)
          return
        } finally {
          if (!active.halted && !signal.aborted) {
            const used = browser.budget().requests
            try { store.charge(runId, guard, { requests: Math.max(0, used - requestsCharged), elapsedMs: Date.now() - started }) } catch { /* the run moved on (paused/cancelled) */ }
            requestsCharged = used
          }
        }
        const current = run()
        if (current.ledger.exhausted && !store.results(runId).some(result => result.status !== 'UNVERIFIED' && result.status !== 'NOT_APPLICABLE') && current.steps.some(entry => entry.kind === 'control' && entry.status === 'pending')) {
          finished = store.transition(runId, 'blocked', `Budget ${current.ledger.exhausted} was reached before any control concluded. Raise the budget in the profile and start a new audit (cancel this run).`, guard)
          return
        }
      }
      alive()
      finished = store.transition(runId, 'completed', summary(store.results(runId), run()), guard)
    } catch (error) {
      if (active.halted) return
      if (error instanceof RunStopped || error instanceof StaleEpochError) {
        // Paused or cancelled by the owner (the epoch moved), or stopped with the app.
        const current = store.findRun(runId)
        if (current?.status === 'running' && !this.stopped) {
          try { finished = store.transition(runId, 'failed', `Stopped: ${error.message}`, guard) } catch { /* superseded */ }
        } else if (current?.status === 'running' && this.stopped) {
          try { store.transition(runId, 'recovering', 'Conductor is closing; the run resumes at its checkpoint on the next launch', guard); store.release(runId, guard) } catch { /* superseded */ }
        }
        if (current && ['cancelled', 'failed', 'completed'].includes(current.status)) finished = current
        return
      }
      throw error
    } finally {
      clearInterval(renew)
      if (!active.halted) await browser?.close().catch(() => undefined)
      if (finished && !active.halted) this.afterRun(finished)
    }
  }

  private afterRun(run: AuditRun): void {
    const { store } = this.deps
    if (run.status === 'completed' || run.status === 'failed') {
      for (const removed of store.pruneRuns(run.projectId, run.environmentId)) {
        try { if (removed.artifactsDir) rmSync(removed.artifactsDir, { recursive: true, force: true }) } catch { /* leave it */ }
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) this.deps.onFinished?.(run)
  }

  private async step(step: RunStep, scope: StepScope): Promise<void> {
    switch (step.kind) {
      case 'discovery': return this.discovery(scope)
      case 'fingerprint': return this.fingerprintStep(scope)
      case 'legal-sources': return this.legalSources(scope)
      case 'control': return this.control(step, scope)
      case 'engineering-smokes': return this.smoke(scope)
      case 'interpretation': return this.interpretation(scope)
      case 'report': return this.report(scope)
    }
  }

  /**
   * Stack discovery and the route matrix (M2 discoverStack). The result is written to the profile —
   * the stack, and the discovered routes beside the owner's own — only when it differs from what the
   * profile holds, so an unchanged site never bumps the profile version (which would mark
   * everything stale). The fingerprint step runs after this and records the resulting version.
   */
  private async discovery(scope: StepScope): Promise<void> {
    const owned = scope.profile.scope.routes.filter(route => route.source === 'owner' || route.source === 'journey')
    if (this.deps.discovery === false || (owned.length && owned.length === scope.profile.scope.routes.length)) {
      scope.state.write('discovery', { skipped: this.deps.discovery === false ? 'discovery disabled' : 'the owner lists every route' })
      return
    }
    const page = await scope.browser.open({ device: 'desktop', locale: scope.profile.scope.locales[0] ?? null, auth: null, consent: 'clean', regionSelection: scope.profile.scope.regionSelection })
    let found: Awaited<ReturnType<typeof discoverStack>>
    try { found = await discoverStack(scope.source, scope.environment, page) } finally { await page.close().catch(() => undefined) }
    scope.alive()
    await scope.evidence.writeJson('log', 'stack discovery and route matrix', { stack: found.stack, routes: found.routes, visited: found.visited })
    const ownedPaths = new Set(owned.map(route => route.path))
    const routes = [...owned, ...found.routes.filter(route => !ownedPaths.has(route.path))]
    const { discoveredAt: _at, ...stack } = found.stack
    const before = scope.profile.stack ? (({ discoveredAt: _prior, ...rest }) => rest)(scope.profile.stack) : null
    if (JSON.stringify(before) !== JSON.stringify(stack) || JSON.stringify(scope.profile.scope.routes) !== JSON.stringify(routes)) {
      scope.profile = this.deps.store.mutateProfile(scope.profile.projectId, 'discovery', current => ({ ...current, stack: found.stack, scope: { ...current.scope, routes } }))
    }
    scope.state.write('discovery', { routes: routes.length, visited: found.visited.length, profileVersion: scope.profile.version })
  }

  private async fingerprintStep(scope: StepScope): Promise<void> {
    const fingerprint = await this.deps.fingerprint({ run: scope.run(), profile: scope.profile, environment: scope.environment, browser: scope.browser, source: scope.source, signal: scope.signal })
    scope.alive()
    this.deps.store.updateRun(scope.runId, scope.guard, { fingerprint })
  }

  private async legalSources(scope: StepScope): Promise<void> {
    const checks = await checkLegalSources(sourcesFor(scope.run().controls, scope.profile), this.deps.readPublic ?? null, scope.signal, this.clock)
    scope.state.write('legal-sources', checks)
  }

  private async smoke(scope: StepScope): Promise<void> {
    const outcome = await runEngineeringSmoke(scope.environment.smokeCommand, this.deps.runCommand ?? null, { cwd: this.deps.projectRoot(scope.profile.projectId), evidence: scope.evidence, signal: scope.signal })
    scope.state.write('smoke', outcome)
  }

  // ---- control steps ------------------------------------------------------------------------------

  private async control(step: RunStep, scope: StepScope): Promise<void> {
    const { store } = this.deps
    const controlId = step.controlId as ControlId
    const run = scope.run()
    const definition = controlDefinition(controlId)
    const decision = decideApplicability(definition, scope.profile.facts, scope.profile.scope)
    const checks = this.deps.checks.filter(check => check.controlId === controlId)
    const outcomes: CheckOutcome[] = []
    const exhaustedBefore = run.ledger.exhausted
    const requestsBefore = scope.browser.budget()
    const verifying = run.kind === 'verify' ? store.findingsByIds(run.projectId, run.verifies).filter(finding => finding.controlId === controlId) : []
    const skipUnchanged = verifying.length > 0 && verifying.every(finding => claimedFixed(this.deps.board, finding) && sameTargetSafe(finding.lastSeenFingerprint, run.fingerprint))

    if (decision.status === 'applicable' && !skipUnchanged) {
      if (exhaustedBefore) {
        for (const check of checks) outcomes.push(unverified(check.checkId, `budget exhausted (${exhaustedBefore}) before this control ran`))
      } else {
        for (const check of checks) {
          scope.alive()
          outcomes.push(await this.runCheck(check, step, scope, definition))
        }
      }
    }
    const exhaustedDuring = scope.browser.budget().exhausted && !requestsBefore.exhausted
    const status = !checks.length && decision.status === 'applicable'
      ? 'NEEDS_HUMAN_REVIEW'
      : controlStatus(definition, decision, outcomes, { budgetExhausted: !!exhaustedBefore || exhaustedDuring })
    const drafts = outcomes.flatMap(outcome => outcome.findings.filter(draft => draft.controlId === controlId))
    const findings = drafts.length ? store.upsertFindings(scope.runId, scope.guard, drafts.map(draft => ({ draft, applicability: decision }))) : []
    const coverage = outcomes.reduce((into, outcome) => mergeCoverage(into, outcome.coverage), emptyCoverage())
    const humanReview = outcomes.flatMap(outcome => outcome.humanReview)
    if (!checks.length && decision.status === 'applicable') humanReview.push({ id: `${controlId}:no-automated-check`, controlId, question: `Review ${definition.title} by hand: no automated check is registered for it.`, why: 'A control without a check can only report NEEDS_HUMAN_REVIEW.', route: null, evidence: [] })
    const result: ControlResult = {
      runId: scope.runId, controlId, status, applicability: decision,
      rationale: rationale(decision, outcomes, status, !!exhaustedBefore || exhaustedDuring, checks.length),
      evidence: [...new Set(outcomes.flatMap(outcome => outcome.evidence))], findingIds: [...new Set(findings.map(finding => finding.id))], humanReview,
      checks: outcomes.map(outcome => ({ checkId: outcome.checkId, status: outcome.status, reason: outcome.reason, durationMs: (outcome as CheckOutcome & { durationMs?: number }).durationMs ?? 0 })),
      coverage, provenance: provenanceFor(definition, scope.profile.facts),
    }
    store.saveResult(scope.runId, scope.guard, result)
    scope.state.write(`observations-${controlId}`, outcomes.flatMap(outcome => outcome.observations).slice(0, 200))

    if (run.kind === 'verify' && verifying.length) {
      const records: VerificationRecord[] = []
      const current = scope.run()
      for (const finding of verifying) {
        const claimed = claimedFixed(this.deps.board, finding)
        let record = verdict({
          spec: recheckSpec(finding, claimed), projectId: run.projectId, environmentId: run.environmentId, verifierRunId: run.id, fingerprint: current.fingerprint,
          lastSeenFingerprint: finding.lastSeenFingerprint, outcomes: decision.status === 'applicable' && !skipUnchanged && !exhaustedBefore ? outcomes : null,
          reason: decision.status !== 'applicable' ? `the control is ${decision.status} now: ${decision.rationale}` : exhaustedBefore ? `budget exhausted (${exhaustedBefore})` : null,
          evidence: result.evidence, at: this.clock().toISOString(),
        })
        if (record.disagreement && record.status === 'verified-open') record = await reviewDisagreement(record, finding, scope.interpreter, scope.signal)
        scope.alive()
        const saved = store.recordVerification(record)
        if (this.deps.board) closeFixedTask(this.deps.board, saved)
        records.push(record)
      }
      scope.state.write(`verifications-${controlId}`, records)
    }
  }

  private async runCheck(check: ControlCheck, step: RunStep, scope: StepScope, definition: ReturnType<typeof controlDefinition>): Promise<CheckOutcome> {
    const { store } = this.deps
    const started = Date.now()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(scope.signal.reason)
    scope.signal.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = this.deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    let timer: NodeJS.Timeout | undefined
    const routes: RouteEntry[] = scope.profile.scope.routes
    const run = scope.run()
    const context: CheckContext = {
      run: { id: run.id, projectId: run.projectId, kind: run.kind, environmentId: run.environmentId, fingerprint: run.fingerprint, budget: run.budget },
      profile: scope.profile, environment: scope.environment, control: definition, policy: scope.policy, browser: scope.browser,
      source: scope.source ?? EMPTY_SOURCE, adapters: scope.adapters, evidence: scope.evidence, interpreter: scope.interpreter,
      synthetic: kind => scope.synthetic.next(kind),
      async operation(mutation, target, act) {
        assertMutationAllowed(scope.policy, mutation)
        let operation
        try { operation = store.intend(scope.runId, scope.guard, { stepId: step.id, mutation, target }) } catch (error) {
          if (error instanceof WriteNotAuthorizedError) throw new MutationRefused(mutation, `${mutation} refused: sandbox write authorization required for ${mutation}`)
          throw error
        }
        try {
          const value = await act()
          store.settle(scope.runId, scope.guard, operation.id, 'done')
          return value
        } catch (error) {
          store.settle(scope.runId, scope.guard, operation.id, 'failed', error instanceof Error ? error.message : String(error))
          throw error
        }
      },
      routes: filter => routes.filter(route => !filter?.tags?.length || filter.tags.some(tag => route.tags.includes(tag))),
      url: path => new URL(path, scope.environment.baseUrl).href,
      log: line => { try { store.event(scope.runId, scope.guard, 'note', `${check.checkId}: ${line}`.slice(0, 1_000)) } catch { /* superseded */ } },
      signal: controller.signal,
      now: () => this.clock().toISOString(),
    }
    try {
      const outcome = await Promise.race([
        check.run(context),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort('timeout'); reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs) }),
        // A check that ignores its signal must not hold a paused, cancelled or closing run.
        new Promise<never>((_, reject) => { if (scope.signal.aborted) reject(new RunStopped('stopped')); else scope.signal.addEventListener('abort', () => reject(new RunStopped('stopped during a check')), { once: true }) }),
      ])
      return { ...outcome, checkId: check.checkId, durationMs: Date.now() - started } as CheckOutcome
    } catch (error) {
      if (error instanceof StaleEpochError || scope.signal.aborted) throw error instanceof StaleEpochError ? error : new RunStopped('stopped during a check')
      return { ...unverified(check.checkId, `check failed: ${error instanceof Error ? error.message : String(error)}`), durationMs: Date.now() - started } as CheckOutcome
    } finally {
      clearTimeout(timer)
      scope.signal.removeEventListener('abort', onAbort)
    }
  }

  // ---- interpretation -----------------------------------------------------------------------------

  private async interpretation(scope: StepScope): Promise<void> {
    const { store } = this.deps
    const results = store.results(scope.runId)
    const candidates = results.filter(result => result.status === 'FAIL' || result.status === 'WARN' || result.status === 'NEEDS_HUMAN_REVIEW' || result.findingIds.length).slice(0, MAX_INTERPRETED_CONTROLS)
    for (const result of candidates) {
      scope.alive()
      const findings = store.findingsByIds(scope.profile.projectId, result.findingIds)
      const observations = scope.state.read<string[]>(`observations-${result.controlId}`) ?? []
      const answer = await scope.interpreter.ask({
        role: 'interpret', controlId: result.controlId, purpose: 'control-rationale',
        system: 'You explain one control of a production audit to the site owner. The status was decided by deterministic checks and you cannot change it, add or remove findings, or change the scope. Give a short rationale, optional severity/confidence suggestions and fix proposals for the listed findings, and questions only a human can decide.',
        user: JSON.stringify({
          control: result.controlId, title: controlDefinition(result.controlId).title, status: result.status, rationale: result.rationale.slice(0, 2_000),
          checks: result.checks, observations: observations.slice(0, 40).map(line => line.slice(0, 400)),
          findings: findings.map(finding => ({ id: finding.id, title: finding.title, severity: finding.severity, confidence: finding.confidence, route: finding.route, expected: finding.expected.slice(0, 600), observed: finding.observed.slice(0, 1_500) })),
        }),
        schema: INTERPRETATION_SCHEMA,
        maxTokens: 900,
      }, scope.signal)
      scope.alive()
      const next = applyInterpretation(result, findings, answer.ok ? answer.json : null, answer.ok ? `${answer.record.provider}/${answer.record.model}` : null, answer.refused)
      store.saveResult(scope.runId, scope.guard, next.result)
      if (next.findings.length) store.upsertFindings(scope.runId, scope.guard, next.findings.map(finding => ({ draft: finding, applicability: finding.applicability })))
    }
  }

  // ---- report -------------------------------------------------------------------------------------

  private async report(scope: StepScope): Promise<void> {
    const { store } = this.deps
    const run = scope.run()
    // A change run re-tests only what the change invalidated; the rest carries over unchanged.
    if (run.kind === 'audit' || run.kind === 'drift') {
      const previous = store.runs(run.projectId, { environmentId: run.environmentId, status: ['completed'], limit: 1 })[0]
      if (previous) {
        const mine = new Set(store.results(run.id).map(result => result.controlId))
        for (const prior of store.results(previous.id)) {
          if (mine.has(prior.controlId)) continue
          store.saveResult(run.id, scope.guard, { ...prior, runId: run.id, rationale: `Carried over from run ${previous.id}: the change that triggered this run (${run.trigger.changes.join(', ') || run.trigger.kind}) does not invalidate it.\n${prior.rationale}` })
        }
      }
    }
    const results = store.results(run.id)
    const coverage = results.reduce((into, result) => mergeCoverage(into, result.coverage), emptyCoverage())
    store.updateRun(run.id, scope.guard, { coverage })
    const ids = [...new Set([...results.flatMap(result => result.findingIds), ...run.verifies])]
    let findings = store.findingsByIds(run.projectId, ids)
    if (this.deps.board && run.kind !== 'verify') {
      ensureFixTasks(store, this.deps.board, run.projectId, autoTaskFindings(findings.filter(finding => finding.lastSeenRunId === run.id)))
      findings = store.findingsByIds(run.projectId, ids)
    }
    const verifications = findings.map(finding => finding.verification).filter((record): record is VerificationRecord => !!record && record.verifierRunId === run.id)
    const current = store.run(run.id)
    const report = buildReport({
      run: current, results, findings, verifications, evidence: scope.evidence.list(), modelCalls: store.modelCalls(run.id),
      smoke: scope.state.read<EngineeringSmokeOutcome | null>('smoke') ?? null,
      legalSources: scope.state.read<LegalSourceCheck[]>('legal-sources') ?? [],
      gate: this.deps.gateAfter?.(current) ?? null, facts: scope.profile.facts, generatedAt: this.clock().toISOString(),
    })
    scope.alive()
    const paths = writeReport(run.artifactsDir, report)
    store.updateRun(run.id, scope.guard, { reportPaths: paths })
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

interface StepScope {
  runId: string
  guard: WriteGuard
  /** Refreshed when discovery writes the stack and routes. */
  profile: ProductionProfile
  environment: ProductionEnvironment
  policy: NetworkPolicy
  browser: AuditBrowser
  source: SourceTree | null
  adapters: Adapters
  evidence: RunEvidence
  synthetic: ReturnType<typeof createSyntheticFactory>
  interpreter: ReturnType<typeof createRunInterpreter>
  state: RunState
  signal: AbortSignal
  alive(): void
  run(): AuditRun
}

const EMPTY_SOURCE: SourceTree = { root: '', read: async () => null, list: async () => [], exists: async () => false }

const sameTargetSafe = (a: TargetFingerprint, b: TargetFingerprint): boolean => {
  const keys: Array<keyof TargetFingerprint> = ['environmentId', 'commit', 'build', 'configHash', 'policyHash', 'dependencyHash', 'routesHash', 'profileVersion', 'registryVersion']
  return keys.every(key => a[key] === b[key])
}

function unverified(checkId: string, reason: string): CheckOutcome {
  return { checkId, status: 'UNVERIFIED', reason, findings: [], evidence: [], humanReview: [], coverage: emptyCoverage(), observations: [reason] }
}

export function mergeCoverage(into: RouteCoverage, from: RouteCoverage): RouteCoverage {
  for (const item of from.tested) {
    const entry = into.tested.find(existing => existing.path === item.path)
    if (!entry) { into.tested.push({ path: item.path, devices: [...item.devices], consentStates: [...item.consentStates], authStates: [...item.authStates] }); continue }
    for (const device of item.devices) if (!entry.devices.includes(device)) entry.devices.push(device)
    for (const state of item.consentStates) if (!entry.consentStates.includes(state)) entry.consentStates.push(state)
    for (const state of item.authStates) if (!entry.authStates.includes(state)) entry.authStates.push(state)
  }
  for (const item of from.sampled) if (!into.sampled.some(entry => entry.path === item.path)) into.sampled.push(item)
  for (const item of from.excluded) if (!into.excluded.some(entry => entry.path === item.path)) into.excluded.push(item)
  for (const line of from.unobservable) if (!into.unobservable.includes(line)) into.unobservable.push(line)
  return into
}

function rationale(decision: ControlResult['applicability'], outcomes: readonly CheckOutcome[], status: ControlResult['status'], exhausted: boolean, checkCount: number): string {
  if (decision.status !== 'applicable') return decision.rationale
  const lines: string[] = []
  if (!checkCount) lines.push('No automated check is registered for this control; it needs a human review.')
  for (const outcome of outcomes) lines.push(`${outcome.checkId}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}${outcome.findings.length ? `, ${outcome.findings.length} finding(s)` : ''}`)
  if (exhausted) lines.push('The run budget was exhausted: whatever did not conclude is UNVERIFIED, never PASS.')
  if (status === 'NEEDS_HUMAN_REVIEW' && outcomes.every(outcome => outcome.status !== 'NEEDS_HUMAN_REVIEW')) lines.push('This control always needs a human to confirm its adequacy.')
  return lines.join('\n') || decision.rationale
}

function summary(results: readonly ControlResult[], run: AuditRun): string {
  const counts = new Map<string, number>()
  for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1)
  const parts = [...counts].map(([status, count]) => `${count} ${status}`)
  return `${results.length} control(s): ${parts.join(', ') || 'none'}${run.ledger.exhausted ? `; budget ${run.ledger.exhausted} exhausted` : ''}`
}

export const INTERPRETATION_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['rationale'],
  properties: {
    rationale: { type: 'string', maxLength: 2_000 },
    suggestions: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['findingId'],
        properties: { findingId: { type: 'string', maxLength: 80 }, severity: { enum: [...SEVERITIES] }, confidence: { enum: [...CONFIDENCES] }, proposedFix: { type: 'string', maxLength: 1_000 } },
      },
    },
    humanReview: {
      type: 'array', maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['question', 'why'], properties: { question: { type: 'string', maxLength: 300 }, why: { type: 'string', maxLength: 300 } } },
    },
  },
}

/**
 * What an interpretation may change: the rationale (added), severity/confidence suggestions
 * (recorded as text next to the deterministic values), proposed-fix text on the control's own
 * findings, and human-review items. Never the status, the findings' severity or confidence, the
 * finding set, or anything outside this control. A refusal adds "not interpreted: <reason>".
 */
export function applyInterpretation(result: ControlResult, findings: readonly Finding[], json: unknown, model: string | null, refused: string | null): { result: ControlResult; findings: Finding[] } {
  if (!json || typeof json !== 'object') return { result: { ...result, rationale: `${result.rationale}\nNot interpreted: ${refused ?? 'no answer'}` }, findings: [] }
  const answer = json as { rationale: string; suggestions?: Array<{ findingId: string; severity?: string; confidence?: string; proposedFix?: string }>; humanReview?: Array<{ question: string; why: string }> }
  const lines = [`Interpretation (${model ?? 'model'}, advisory; the status above is the checks'): ${answer.rationale}`]
  const changed: Finding[] = []
  for (const suggestion of answer.suggestions ?? []) {
    const finding = findings.find(entry => entry.id === suggestion.findingId)
    if (!finding || !result.findingIds.includes(finding.id)) continue
    if (suggestion.severity && suggestion.severity !== finding.severity) lines.push(`Suggested severity for "${finding.title}": ${suggestion.severity} (recorded: ${finding.severity}).`)
    if (suggestion.confidence && suggestion.confidence !== finding.confidence) lines.push(`Suggested confidence for "${finding.title}": ${suggestion.confidence} (recorded: ${finding.confidence}).`)
    if (suggestion.proposedFix && !finding.proposedFix.includes(suggestion.proposedFix)) changed.push({ ...finding, proposedFix: `${finding.proposedFix}\nModel suggestion: ${suggestion.proposedFix}`.trim() })
  }
  const humanReview = [...result.humanReview]
  ;(answer.humanReview ?? []).forEach((item, index) => humanReview.push({ id: `${result.controlId}:interpretation-${index + 1}`, controlId: result.controlId, question: item.question, why: `${item.why} (raised by the interpretation step)`, route: null, evidence: [] }))
  return { result: { ...result, rationale: `${result.rationale}\n${lines.join('\n')}`, humanReview }, findings: changed }
}

/** Step outputs a later step (or a resumed run) needs, kept in the run's artifacts. */
export class RunState {
  private readonly dir: string
  constructor(artifactsDir: string) { this.dir = join(artifactsDir, 'state') }
  read<T>(name: string): T | null {
    const path = join(this.dir, `${name}.json`)
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null } catch { return null }
  }
  write(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true })
    const path = join(this.dir, `${name}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify(value ?? null))
    renameSync(`${path}.tmp`, path)
  }
}

export interface RunEvidence extends EvidenceSink {
  list(): EvidenceRef[]
  addSecrets(values: Iterable<string>): void
  setMarkers(markers: () => Iterable<string>): void
  readonly dir: string
}

/**
 * The run's evidence across attempts: each attempt (lease epoch) writes through its own sink in
 * `attempt-<epoch>/`, so a resumed run never overwrites what an earlier attempt wrote, and one
 * merged index `evidence.json` at the run root lists every file with a path relative to it.
 */
export function createRunEvidence(artifactsDir: string, epoch: number): RunEvidence {
  let markers: () => Iterable<string> = () => []
  const inner = createEvidenceSink(join(artifactsDir, `attempt-${epoch}`), () => markers())
  const indexPath = join(artifactsDir, 'evidence.json')
  mkdirSync(artifactsDir, { recursive: true })
  let merged: EvidenceRef[] = []
  try { merged = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) as EvidenceRef[] : [] } catch { merged = [] }
  const wrap = (ref: EvidenceRef): EvidenceRef => {
    const out: EvidenceRef = { ...ref, id: `a${epoch}-${ref.id}`, path: `attempt-${epoch}/${ref.path}` }
    merged.push(out)
    writeFileSync(`${indexPath}.tmp`, JSON.stringify(merged, null, 2))
    renameSync(`${indexPath}.tmp`, indexPath)
    return out
  }
  return {
    dir: artifactsDir,
    setMarkers(next) { markers = next },
    list: () => [...merged],
    addSecrets: values => inner.addSecrets(values),
    writeText: async (kind: EvidenceKind, description: string, text: string, ext?: string) => wrap(await inner.writeText(kind, description, text, ext)),
    writeJson: async (kind: EvidenceKind, description: string, value: unknown) => wrap(await inner.writeJson(kind, description, value)),
    writeBinary: async (kind: EvidenceKind, description: string, bytes: Uint8Array, ext: string) => wrap(await inner.writeBinary(kind, description, bytes, ext)),
  }
}
