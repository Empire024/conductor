import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  CONTROL_IDS,
  type Adapters, type AuditRequest, type AuditRun, type AuditTrigger, type BrowserAvailability, type ChangeClass, type ControlCheck, type ControlRegistry,
  type CredentialRef, type DriftSettings, type Finding, type GateState, type NetworkPolicy, type ProductionEnvironment, type ProductionProfile,
  type ControlResult, type ProductionProjectSnapshot, type ProductionQueueEntry, type ProductionRunSummary, type ProfileUpdate, type ReviewAnswer, type ReviewAnswerRecord, type SandboxWriteAuthorization,
  type SourceTree, type TargetFingerprint, type Waiver, type WaiverRequest, type WriteAuthorizationRequest,
} from '../../shared/production'
import { createCapturedMailAdapter } from './adapters/mailpit'
import { createCustomCommandAdapter, killTree } from './adapters/custom-command'
import { createStorageAdapter } from './adapters/storage'
import { createWooCommerceAdapter } from './adapters/woocommerce'
import { AuthUnavailable, createAuditBrowser, resolveEngine } from './browser'
import { createLoginStatePreparer } from './login-refresh'
import { CHECKS } from './checks/index'
import type { CommandRunner } from './checks/engineering-smokes'
import type { PublicReader } from './checks/legal-sources'
import { recordsAdapter } from './checks/commerce-support'
import { createFsSourceTree } from './discovery'
import { runDrift, type DriftOutcome, type DriftPorts } from './drift'
import { classifyChange, computeFingerprint, hashFiles, normalisePolicyText, type FingerprintFile } from './fingerprint'
import { applyReviewAnswers, computeGate } from './gate'
import type { InterpreterPorts } from './interpret'
import {
  answerQuestion as answerProfileQuestion, applyProfileUpdate, authorizeWrites as addWriteAuthorization, designate as designateProfile,
  dismissQuestion as dismissProfileQuestion, revokeWrites as removeWriteAuthorization,
} from './profile'
import { REGISTRY } from './registry'
import { ProductionRunner, guestStateAccount, type BrowserFactoryOptions, type FingerprintRequest, type RunnerDeps } from './runner'
import { ACTIVE_RUN_STATUSES, OWNER, type ProductionStore, type ReconcileRunOutcome } from './store'
import { ensureFixTasks, type FixTaskBoard, type FixTaskOutcome } from './tasks'
import { CONDUCTOR_ACTOR, requestRun, trigger, type RunRequestOutcome } from './triggers'

/**
 * createProductionService (docs/production-agent.md section 2): one instance per app, built in
 * src/main/index.ts by M8 with real ports, handed to AgentControl (production.* methods), the IPC
 * handlers (ProductionBridge) and the `production-drift` schedule executor. Everything here acts
 * in the caller's project scope; the control layer (M8) decides who may call what (sovereign
 * methods: designation, answers, waivers, write authorizations, drift).
 */

export interface ProductionDeps {
  store: ProductionStore
  /** userData: artifacts under production-audits/, the credential file production-secrets.json. */
  userData: string
  interpreter: InterpreterPorts
  /** The orchestration board (OrchestrationStore adapted); null disables fix tasks. */
  board: FixTaskBoard | null
  projectRoot(projectId: string): string | null
  projectName?(projectId: string): string
  /** Git HEAD of the project; default reads .git without spawning git. */
  gitHead?(projectId: string): Promise<string | null>
  /** Keeps the drift schedule of a project in step with its settings (created disabled). */
  schedules?: { ensure(projectId: string, settings: DriftSettings): void } | null
  /** Watches a project's source tree; the service turns relevant changes into `change` triggers. */
  watch?(projectId: string, root: string, onChange: (paths: string[]) => void): () => void
  clock?: () => Date
  ownerId?: string
  checks?: readonly ControlCheck[]
  browserFactory?: RunnerDeps['browserFactory']
  browserAvailability?(): Promise<BrowserAvailability>
  fingerprint?: RunnerDeps['fingerprint']
  adapters?: RunnerDeps['adapters']
  resolveCredential?(ref: CredentialRef): string | null
  runCommand?: CommandRunner | null
  readPublic?: PublicReader | null
  discovery?: boolean
  leaseTtlMs?: number
  checkTimeoutMs?: number
  /** Delay between a watched file change and the change trigger (default 30 s). */
  changeDebounceMs?: number
  log?(line: string): void
}

export interface Actor { kind: 'owner' | 'wizard' | 'agent' | 'conductor'; agentSessionId: string | null; title: string | null }
export const OWNER_ACTOR: Actor = { kind: 'owner', agentSessionId: null, title: 'Owner' }

export type ProductionService = ReturnType<typeof createProductionService>

const LOCK_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt', 'go.sum', 'Cargo.lock']
const MAX_FILE_BYTES = 512 * 1024

export function createProductionService(deps: ProductionDeps) {
  const { store } = deps
  const clock = deps.clock ?? (() => new Date())
  const ownerId = deps.ownerId ?? `conductor-${process.pid}-${Date.now().toString(36)}`
  const checks = deps.checks ?? CHECKS
  const resolveCredential = deps.resolveCredential ?? defaultCredentialResolver(deps.userData)
  const runCommand = deps.runCommand === undefined ? defaultCommandRunner : deps.runCommand
  const gitHead = deps.gitHead ?? (async (projectId: string) => { const root = deps.projectRoot(projectId); return root ? readGitHead(root) : null })
  const sourceTree = (projectId: string): SourceTree | null => { const root = deps.projectRoot(projectId); return root && existsSync(root) ? createFsSourceTree(root) : null }
  const baseFingerprint = deps.fingerprint ?? ((request: FingerprintRequest) => computeTargetFingerprint(request, { gitHead, runCommand, projectRoot: deps.projectRoot }))
  const auditVersion = auditVersionReader(store)
  const fingerprint = async (request: FingerprintRequest): Promise<TargetFingerprint> => ({ ...(await baseFingerprint(request)), profileVersion: auditVersion(request.profile) })
  /** The target as last seen by a fingerprint step, drift check or change detection, per project and environment. */
  const current = new Map<string, TargetFingerprint>()
  const key = (projectId: string, environmentId: string): string => `${projectId}\u0000${environmentId}`
  let availability: BrowserAvailability | null = null

  const runner = new ProductionRunner({
    store, ownerId, clock, checks, board: deps.board, interpreter: deps.interpreter, sourceTree, projectRoot: deps.projectRoot, fingerprint,
    browserFactory: deps.browserFactory ?? ((policy: NetworkPolicy, options: BrowserFactoryOptions) => createAuditBrowser(policy, { userDataDir: options.userDataDir, evidence: options.evidence, signal: options.signal, guest: options.guest, prepareLogin: options.prepareLogin })),
    adapters: deps.adapters ?? ((environment, policy, projectId) => defaultAdapters(environment, policy, { resolveCredential, projectRoot: deps.projectRoot(projectId) })),
    runCommand, readPublic: deps.readPublic ?? null, discovery: deps.discovery, leaseTtlMs: deps.leaseTtlMs, checkTimeoutMs: deps.checkTimeoutMs, log: deps.log,
    gateAfter: run => gateFor(run.projectId, run.environmentId, run),
    onFinished: run => finished(run),
  })

  const environmentOf = (profile: ProductionProfile | null, environmentId?: string | null): ProductionEnvironment | null => {
    if (!profile) return null
    const wanted = environmentId ?? profile.designation.environmentId
    return profile.environments.find(environment => environment.id === wanted) ?? (environmentId ? null : profile.environments[0] ?? null)
  }
  const requireEnvironment = (projectId: string, environmentId?: string | null): { profile: ProductionProfile; environment: ProductionEnvironment } => {
    const profile = store.profile(projectId)
    const environment = environmentOf(profile, environmentId)
    if (!profile || !environment) throw new Error(environmentId ? `No environment ${environmentId} in the production profile of this project` : 'This project has no production environment yet; add one to the profile first')
    return { profile, environment }
  }

  /** A fingerprint without the network: the last seen one with today's profile and registry versions and git HEAD. */
  const cheapFingerprint = async (projectId: string, environment: ProductionEnvironment, profile: ProductionProfile): Promise<TargetFingerprint> => {
    const base = current.get(key(projectId, environment.id)) ?? store.lastCompletedRun(projectId, environment.id)?.fingerprint ?? null
    const commit = environment.buildInfoCommand ? base?.commit ?? null : await gitHead(projectId).catch(() => null)
    if (!base) return computeFingerprint({ environmentId: environment.id, commit, build: null, configFiles: [], policyPages: [], dependencyFiles: [], routes: profile.scope.routes.map(route => route.path), profileVersion: auditVersion(profile), registryVersion: REGISTRY.version, now: clock })
    return { ...base, commit: commit ?? base.commit, profileVersion: auditVersion(profile), registryVersion: REGISTRY.version, computedAt: clock().toISOString() }
  }

  /** A run's results with the owner's human-review answers laid over them (gate.ts applyReviewAnswers). */
  const answeredResults = (run: AuditRun): ControlResult[] => applyReviewAnswers(store.results(run.id), store.reviewAnswers(run.projectId, run.environmentId), run.fingerprint)

  const gateFor = (projectId: string, environmentId: string | null, after?: AuditRun): GateState => {
    const profile = store.profile(projectId)
    const envId = environmentId ?? environmentOf(profile)?.id ?? null
    const runs = envId ? store.runs(projectId, { environmentId: envId, limit: 10 }).map(run => after && run.id === after.id ? { ...after, status: 'completed' as const, finishedAt: after.finishedAt ?? clock().toISOString() } : run) : []
    const completed = runs.find(run => run.status === 'completed')
    let fp = envId ? current.get(key(projectId, envId)) ?? null : null
    if (profile && completed && fp) fp = { ...fp, profileVersion: auditVersion(profile), registryVersion: REGISTRY.version }
    else if (profile && completed) fp = { ...completed.fingerprint, profileVersion: auditVersion(profile), registryVersion: REGISTRY.version }
    return computeGate({
      projectId, environmentId: envId, runs, results: completed ? answeredResults(completed) : [],
      findings: envId ? store.findings(projectId, { environmentId: envId, status: ['open', 'reopened', 'disputed', 'waived'], limit: 2_000 }) : [],
      waivers: store.waivers(projectId, { limit: 500 }), questions: profile?.questions ?? [], currentFingerprint: fp, now: clock(),
    })
  }

  const finished = (run: AuditRun): void => {
    if (run.status === 'completed') current.set(key(run.projectId, run.environmentId), run.fingerprint)
    if (run.status === 'cancelled') { store.takeRerun(run.id); return }
    void followUp(run.id)
  }

  /**
   * Starts the follow-up a finished run's rerunRequested asks for. The flag is cleared only once the
   * follow-up exists, so a crash or a failed fingerprint in between leaves it for start() to retry.
   */
  const following = new Set<string>()
  const followUp = async (runId: string): Promise<void> => {
    const run = store.findRun(runId)
    const rerun = run?.rerunRequested
    if (!run || !rerun || following.has(runId)) return
    following.add(runId)
    try {
      // Whatever triggered the rerun, it re-audits: a change or drift trigger only what its changes invalidate.
      await startRun(run.projectId, run.environmentId, rerun.kind === 'drift' ? 'drift' : 'audit', rerun, { full: rerun.kind !== 'change' && rerun.kind !== 'drift' })
      store.takeRerun(runId)
    } catch (error) {
      deps.log?.(`production rerun of ${runId} not started: ${String(error)}`)
      store.event(runId, OWNER, 'note', `Follow-up run not started (${String(error).slice(0, 300)}); the rerun request is kept and retried when Conductor starts`)
    } finally { following.delete(runId) }
  }

  const startRun = async (projectId: string, environmentId: string, kind: AuditRun['kind'], by: AuditTrigger, options: { controls?: AuditRequest['controls']; full?: boolean; findingIds?: string[] } = {}): Promise<RunRequestOutcome> => {
    const { profile, environment } = requireEnvironment(projectId, environmentId)
    const fp = await cheapFingerprint(projectId, environment, profile)
    const outcome = requestRun({ store, userData: deps.userData, now: clock }, { projectId, environmentId: environment.id, kind, trigger: by, controls: options.controls, full: options.full, findingIds: options.findingIds, fingerprint: fp })
    runner.pump()
    return outcome
  }

  const actorTrigger = (kind: AuditTrigger['kind'], actor: Actor, detail: string, changes: ChangeClass[] = []): AuditTrigger => trigger(kind, actor, clock(), detail, changes)

  const summary = (run: AuditRun): ProductionRunSummary => {
    const done = run.steps.filter(step => step.status === 'done' || step.status === 'skipped').length
    const currentStep = run.steps.find(step => step.status === 'running') ?? null
    return {
      id: run.id, kind: run.kind, environmentId: run.environmentId, status: run.status, statusReason: run.statusReason, trigger: run.trigger, fingerprint: run.fingerprint,
      progress: { done, total: run.steps.length, currentStep: currentStep ? `${currentStep.kind}${currentStep.controlId ? ` ${currentStep.controlId}` : ''}` : null },
      ledger: run.ledger, createdAt: run.createdAt, finishedAt: run.finishedAt, reportPaths: run.reportPaths,
    }
  }

  const projectRun = (projectId: string, runId: string): AuditRun => {
    const run = store.findRun(runId)
    if (!run || run.projectId !== projectId) throw new Error(`Run ${runId} is not a run of this project`)
    return run
  }

  // ---- change detection from the file watcher ---------------------------------------------------
  const watchers = new Map<string, () => void>()
  const pendingChange = new Map<string, NodeJS.Timeout>()
  const watchProject = (projectId: string): void => {
    if (!deps.watch || watchers.has(projectId)) return
    const root = deps.projectRoot(projectId)
    if (!root) return
    watchers.set(projectId, deps.watch(projectId, root, paths => {
      const profile = store.profile(projectId)
      if (!profile?.designation.productionReady) return
      const relevant = paths.some(path => isRelevantChange(path, root, profile))
      if (!relevant) return
      clearTimeout(pendingChange.get(projectId))
      pendingChange.set(projectId, setTimeout(() => { pendingChange.delete(projectId); void service.detectChange(projectId).catch(error => deps.log?.(`production change detection failed: ${String(error)}`)) }, deps.changeDebounceMs ?? 30_000))
    }))
  }

  const driftPorts: DriftPorts = {
    profile: projectId => store.profile(projectId),
    environment: profile => environmentOf(profile),
    lastCompleted: (projectId, environmentId) => store.lastCompletedRun(projectId, environmentId),
    fingerprint: async (projectId, environment, signal) => {
      const profile = store.profile(projectId)!
      const last = store.lastCompletedRun(projectId, environment.id)
      const policy = { ...policyFor(profile, environment), readOnly: true, writeAuthorization: null }
      const browser = (deps.browserFactory ?? ((p: NetworkPolicy, o: BrowserFactoryOptions) => createAuditBrowser(p, { userDataDir: o.userDataDir, evidence: o.evidence, signal: o.signal, guest: o.guest, prepareLogin: o.prepareLogin })))(policy, {
        userDataDir: join(deps.userData, 'production-audits', 'drift-browser'), evidence: NULL_EVIDENCE, signal, guest: guestStateAccount(environment),
        prepareLogin: createLoginStatePreparer({ runCommand, evidence: NULL_EVIDENCE, allowedOrigins: policy.allowedOrigins, signal, now: clock }),
      })
      try {
        return await fingerprint({ run: last ?? ({ id: 'drift', projectId, environmentId: environment.id } as AuditRun), profile, environment, browser, source: sourceTree(projectId), signal })
      } finally { await browser.close().catch(() => undefined) }
    },
    setCurrent: (projectId, environmentId, fp) => { current.set(key(projectId, environmentId), fp) },
    requestChangeRun: (projectId, environmentId, changes, fp) => {
      const outcome = requestRun({ store, userData: deps.userData, now: clock }, { projectId, environmentId, kind: 'drift', trigger: trigger('drift', CONDUCTOR_ACTOR, clock(), `Drift check: ${changes.join(', ')}`, changes), fingerprint: fp, full: false })
      runner.pump()
      return outcome.outcome === 'dropped' ? { runId: null, detail: outcome.reason } : { runId: outcome.run.id, detail: outcome.outcome === 'created' ? `run ${outcome.run.id} queued` : `run ${outcome.run.id} will rerun` }
    },
  }

  const policyFor = (profile: ProductionProfile, environment: ProductionEnvironment): NetworkPolicy => ({
    environmentId: environment.id, environmentKind: environment.kind,
    allowedOrigins: [...new Set([environment.baseUrl, ...environment.allowedOrigins].map(url => { try { return new URL(url).origin } catch { return null } }).filter((origin): origin is string => !!origin))],
    readOnly: true, writeAuthorization: null, maxRequests: profile.budget.maxRequests, requestsPerSecondPerOrigin: profile.budget.requestsPerSecondPerOrigin, allowPrivateAddresses: environment.kind === 'local',
  })

  const service = {
    runner,
    /** A run as the panel and the control methods show it (progress, ledger, report paths). */
    summary: (run: AuditRun): ProductionRunSummary => summary(run),
    registry: (): ControlRegistry => REGISTRY,

    start(): ReconcileRunOutcome[] {
      const outcomes = runner.start()
      for (const run of store.pendingReruns()) void followUp(run.id)
      for (const profile of store.latestProfiles({ designatedOnly: true, limit: 200 })) watchProject(profile.projectId)
      void (deps.browserAvailability ?? (async () => { const engine = await resolveEngine(); return { available: engine.available, engine: engine.engine, reason: engine.reason } }))()
        .then(result => { availability = result }, () => undefined)
      return outcomes
    },
    async stop(): Promise<void> {
      for (const stop of watchers.values()) stop()
      watchers.clear()
      for (const timer of pendingChange.values()) clearTimeout(timer)
      pendingChange.clear()
      await runner.stop()
    },
    onChanged: (listener: (projectId: string) => void): (() => void) => store.onChange(listener),

    gate: (projectId: string, environmentId?: string | null): GateState => gateFor(projectId, environmentId ?? null),

    snapshot(projectId: string): ProductionProjectSnapshot {
      const profile = store.profile(projectId)
      const environment = environmentOf(profile)
      const runs = environment ? store.runs(projectId, { environmentId: environment.id, limit: 20 }) : store.runs(projectId, { limit: 20 })
      const active = runs.find(run => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null
      const completed = runs.find(run => run.status === 'completed') ?? null
      return {
        projectId, profile, gate: gateFor(projectId, environment?.id ?? null), activeRun: active ? summary(active) : null, runs: runs.map(summary),
        findings: environment ? store.findings(projectId, { environmentId: environment.id, limit: 500 }) : [], waivers: store.waivers(projectId, { limit: 200 }),
        results: completed ? answeredResults(completed) : [], registryVersion: REGISTRY.version, browser: availability,
      }
    },

    queue(): ProductionQueueEntry[] {
      return store.latestProfiles({ designatedOnly: true, limit: 500 }).map(profile => {
        const environment = environmentOf(profile)
        const counts = store.findingCounts(profile.projectId, environment?.id)
        const open = counts.filter(entry => entry.status === 'open' || entry.status === 'reopened' || entry.status === 'disputed')
        const runs = environment ? store.runs(profile.projectId, { environmentId: environment.id, limit: 10 }) : []
        const active = runs.find(run => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null
        return {
          projectId: profile.projectId, projectName: deps.projectName?.(profile.projectId) ?? profile.projectId, designation: profile.designation,
          gate: gateFor(profile.projectId, environment?.id ?? null), activeRun: active ? summary(active) : null,
          openFindings: { critical: sum(open, 'critical'), high: sum(open, 'high'), other: open.filter(entry => entry.severity !== 'critical' && entry.severity !== 'high').reduce((total, entry) => total + entry.count, 0) },
          openQuestions: profile.questions.filter(question => question.status === 'open').length,
          lastCompletedAt: runs.find(run => run.status === 'completed')?.finishedAt ?? null,
        }
      })
    },

    profile: (projectId: string): ProductionProfile => store.ensureProfile(projectId),

    async designate(projectId: string, request: { productionReady: boolean; environmentId: string | null; note: string }, actor: Actor = OWNER_ACTOR): Promise<ProductionProfile> {
      const profile = store.mutateProfile(projectId, actorName(actor), current => designateProfile(current, request, actorName(actor), clock()))
      deps.schedules?.ensure(projectId, profile.drift)
      if (profile.designation.productionReady && profile.designation.environmentId) {
        watchProject(projectId)
        await startRun(projectId, profile.designation.environmentId, 'audit', actorTrigger('designation', actor, `Designated production-ready: ${request.note}`)).catch(error => deps.log?.(`designation audit not started: ${String(error)}`))
      }
      return profile
    },

    updateProfile: (projectId: string, update: ProfileUpdate, actor: Actor = OWNER_ACTOR): ProductionProfile =>
      store.mutateProfile(projectId, actorName(actor), current => applyProfileUpdate(current, update, { by: factBy(actor), source: actor.kind === 'owner' ? 'owner' : actor.kind === 'wizard' ? 'wizard' : 'assumption', now: clock() })),

    answerQuestion: (projectId: string, questionId: string, answer: string, actor: Actor = OWNER_ACTOR): ProductionProfile =>
      store.mutateProfile(projectId, actorName(actor), current => answerProfileQuestion(current, questionId, answer, factBy(actor), clock(), undefined, actor.kind === 'wizard' ? 'wizard' : 'owner')),

    dismissQuestion: (projectId: string, questionId: string, reason: string, actor: Actor = OWNER_ACTOR): ProductionProfile =>
      store.mutateProfile(projectId, actorName(actor), current => dismissProfileQuestion(current, questionId, reason, actorName(actor), clock())),

    /**
     * Answers one human-review item of the environment's last completed run (the owner or a wizard;
     * the control layer checks who). The answer is kept per item id and carried to later runs until
     * a change invalidates the control; results and findings are never edited.
     */
    answerReview(projectId: string, request: { itemId: string; answer: ReviewAnswer; note?: string | null; environmentId?: string | null }, actor: Actor = OWNER_ACTOR): ReviewAnswerRecord {
      if (request.answer !== 'confirmed' && request.answer !== 'rejected') throw new Error('answer must be confirmed or rejected')
      const { environment } = requireEnvironment(projectId, request.environmentId)
      const completed = store.lastCompletedRun(projectId, environment.id)
      if (!completed) throw new Error(`Environment ${environment.id} has no completed audit; human-review items come from a completed run`)
      const item = store.results(completed.id).flatMap(result => result.humanReview).find(entry => entry.id === request.itemId)
      if (!item) throw new Error(`No human-review item ${request.itemId} in run ${completed.id}; production.status lists the items under results[].humanReview`)
      return store.answerReview({
        projectId, environmentId: environment.id, itemId: item.id, controlId: item.controlId, answer: request.answer, note: request.note?.trim() ? request.note.trim() : null,
        answeredBy: actorName(actor), answeredAt: clock().toISOString(), runId: completed.id, fingerprint: completed.fingerprint,
      })
    },

    async audit(projectId: string, request: AuditRequest = {}, actor: Actor = OWNER_ACTOR): Promise<RunRequestOutcome> {
      const unknown = (request.controls ?? []).filter(id => !CONTROL_IDS.includes(id))
      if (unknown.length) throw new Error(`Unknown control ids: ${unknown.join(', ')}`)
      const { environment } = requireEnvironment(projectId, request.environmentId)
      return startRun(projectId, environment.id, 'audit', actorTrigger('manual', actor, request.controls?.length ? `Audit of ${request.controls.join(', ')}` : 'Audit'), { controls: request.controls, full: request.full })
    },

    async retest(projectId: string, findingIds: string[], actor: Actor = OWNER_ACTOR): Promise<RunRequestOutcome> {
      const findings = requireFindings(projectId, findingIds)
      requireIdle(projectId, findings[0]!.environmentId, 'A re-test')
      return startRun(projectId, findings[0]!.environmentId, 'retest', actorTrigger('retest', actor, `Re-test of ${findings.length} finding(s)`), { findingIds: findings.map(finding => finding.id) })
    },

    async verify(projectId: string, findingIds: string[], actor: Actor = OWNER_ACTOR): Promise<RunRequestOutcome> {
      const findings = requireFindings(projectId, findingIds)
      requireIdle(projectId, findings[0]!.environmentId, 'Verification')
      return startRun(projectId, findings[0]!.environmentId, 'verify', actorTrigger('verify', actor, `Independent verification of ${findings.length} finding(s)`), { findingIds: findings.map(finding => finding.id) })
    },

    pause: (projectId: string, runId: string, reason = 'paused by the owner'): AuditRun => { projectRun(projectId, runId); return runner.pause(runId, reason) },
    resume: (projectId: string, runId: string): void => { projectRun(projectId, runId); runner.resume(runId) },
    cancel: (projectId: string, runId: string, reason: string): AuditRun => { projectRun(projectId, runId); if (!reason.trim()) throw new Error('Cancelling a run needs a reason'); return runner.cancel(runId, reason) },
    run: (projectId: string, runId: string): AuditRun => projectRun(projectId, runId),
    runs: (projectId: string, limit = 20): ProductionRunSummary[] => store.runs(projectId, { limit }).map(summary),
    findings: (projectId: string, filter: Parameters<ProductionStore['findings']>[1] = {}): Finding[] => store.findings(projectId, filter),
    findingsByIds: (projectId: string, findingIds: string[]): Finding[] => store.findingsByIds(projectId, findingIds),
    /** The run's newest journal entries, oldest first. */
    events: (projectId: string, runId: string, limit = 50) => { projectRun(projectId, runId); return store.latestEvents(runId, limit) },

    createFixTasks(projectId: string, findingIds: string[]): FixTaskOutcome[] {
      if (!deps.board) throw new Error('The orchestration board is not available')
      return ensureFixTasks(store, deps.board, projectId, requireFindings(projectId, findingIds))
    },

    waive: (projectId: string, request: WaiverRequest, grantedBy: Waiver['grantedBy']): Waiver => store.createWaiver(projectId, request, grantedBy),
    revokeWaiver: (projectId: string, waiverId: string, reason: string): Waiver => store.revokeWaiver(projectId, waiverId, reason),

    authorizeWrites(projectId: string, request: WriteAuthorizationRequest, grantedBy: SandboxWriteAuthorization['grantedBy']): SandboxWriteAuthorization {
      let created: SandboxWriteAuthorization | null = null
      store.mutateProfile(projectId, grantedBy.kind, current => { const next = addWriteAuthorization(current, request, grantedBy, clock()); created = next.authorization; return next.profile })
      return created!
    },
    revokeWrites: (projectId: string, authorizationId: string, by = 'owner'): ProductionProfile => store.mutateProfile(projectId, by, current => removeWriteAuthorization(current, authorizationId)),

    setDrift(projectId: string, settings: Partial<DriftSettings>, actor: Actor = OWNER_ACTOR): ProductionProfile {
      const profile = store.mutateProfile(projectId, actorName(actor), current => applyProfileUpdate(current, { drift: settings }, { by: actorName(actor), source: 'owner', now: clock() }))
      deps.schedules?.ensure(projectId, profile.drift)
      return profile
    },
    runDrift: (projectId: string, signal: AbortSignal = new AbortController().signal): Promise<DriftOutcome> => runDrift(driftPorts, projectId, signal),
    driftPorts,

    /** Recomputes the target without the network and starts a change run when a component moved. */
    async detectChange(projectId: string): Promise<{ changes: ChangeClass[]; outcome: RunRequestOutcome | null }> {
      const { profile, environment } = requireEnvironment(projectId)
      const last = store.lastCompletedRun(projectId, environment.id)
      if (!last) return { changes: [], outcome: null }
      const fp = await cheapFingerprint(projectId, environment, profile)
      // The cheap recompute only sees git HEAD and versions; config and lock files are read here too.
      const source = sourceTree(projectId)
      const [configHash, dependencyHash] = source ? await Promise.all([hashFilesFrom(source, profile.stack?.infrastructureFiles ?? []), hashFilesFrom(source, LOCK_FILES, profile.stack?.plugins)]) : [fp.configHash, fp.dependencyHash]
      const next = { ...fp, configHash, dependencyHash }
      current.set(key(projectId, environment.id), next)
      const changes = classifyChange(last.fingerprint, next)
      if (!changes.length) return { changes, outcome: null }
      const outcome = await startRun(projectId, environment.id, 'audit', trigger('change', CONDUCTOR_ACTOR, clock(), `The project changed: ${changes.join(', ')}`, changes))
      return { changes, outcome }
    },

    /** Absolute path of an evidence file (bounded to the run's artifacts), or of the reports. */
    evidencePath(projectId: string, runId: string, evidenceId: string): string {
      const run = projectRun(projectId, runId)
      const index = join(run.artifactsDir, 'evidence.json')
      const refs = existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')) as Array<{ id: string; path: string }> : []
      const ref = refs.find(entry => entry.id === evidenceId)
      if (!ref) throw new Error(`No evidence ${evidenceId} in run ${runId}`)
      const path = resolve(run.artifactsDir, ref.path)
      if (!path.startsWith(resolve(run.artifactsDir) + sep)) throw new Error('Evidence path outside the run artifacts')
      return path
    },
    reportPaths: (projectId: string, runId: string): { markdown: string; json: string } | null => projectRun(projectId, runId).reportPaths,
  }
  return service

  /** A re-test or verification names findings; coalesced into an active run it would come back as a plain audit, so it waits instead. */
  function requireIdle(projectId: string, environmentId: string, what: string): void {
    const active = store.activeRun(projectId, environmentId)
    if (active) throw new Error(`${what} needs its own run, and run ${active.id} (${active.kind}) is ${active.status} for this environment; ask again when it has finished (production.status shows its progress)`)
  }

  function requireFindings(projectId: string, findingIds: string[]): Finding[] {
    if (!findingIds.length) throw new Error('Name at least one finding')
    const findings = store.findingsByIds(projectId, findingIds)
    const missing = findingIds.filter(id => !findings.some(finding => finding.id === id))
    if (missing.length) throw new Error(`Not findings of this project: ${missing.join(', ')}`)
    const environments = new Set(findings.map(finding => finding.environmentId))
    if (environments.size > 1) throw new Error('The findings belong to different environments; verify or re-test one environment at a time')
    return findings
  }
}

/** The parts of a profile that change what an audit tests: facts, environments, write authorizations, scope, budget, stack. */
export function auditRelevantProfile(profile: ProductionProfile): string {
  const stack = profile.stack ? { ...profile.stack, discoveredAt: null } : null
  const facts = Object.fromEntries(Object.entries(profile.facts).map(([name, fact]) => [name, fact.value]))
  return JSON.stringify({ facts, environments: profile.environments, writeAuthorizations: profile.writeAuthorizations, scope: profile.scope, budget: profile.budget, stack })
}

/**
 * The profile version a fingerprint records: the oldest recent version whose audit-relevant content
 * equals the current one. Designating the project, toggling drift checks or dismissing a question
 * bumps the profile but does not change what is tested, so it must not mark every result STALE.
 */
export function auditVersionReader(store: ProductionStore, lookBack = 50): (profile: ProductionProfile) => number {
  const memo = new Map<string, number>()
  return profile => {
    const cacheKey = `${profile.projectId}:${profile.version}`
    const cached = memo.get(cacheKey)
    if (cached !== undefined) return cached
    const target = auditRelevantProfile(profile)
    let version = profile.version
    for (let prior = profile.version - 1; prior >= Math.max(1, profile.version - lookBack); prior--) {
      const older = store.profileAt(profile.projectId, prior)
      if (!older || auditRelevantProfile(older) !== target) break
      version = prior
    }
    if (memo.size > 1_000) memo.clear()
    memo.set(cacheKey, version)
    return version
  }
}

const sum = (entries: Array<{ severity: string; count: number }>, severity: string): number => entries.filter(entry => entry.severity === severity).reduce((total, entry) => total + entry.count, 0)
const actorName = (actor: Actor): string => actor.kind === 'owner' ? 'owner' : `${actor.kind}${actor.agentSessionId ? `:${actor.agentSessionId}` : ''}`
/** Who set a profile fact: the actor, plus a wizard's tab title so the panel and report can name it. */
const factBy = (actor: Actor): string => actor.kind === 'wizard' && actor.title ? `${actorName(actor)} (${actor.title})` : actorName(actor)

const NULL_EVIDENCE: BrowserFactoryOptions['evidence'] = {
  async writeText() { throw new Error('no evidence is written by a drift fingerprint') },
  async writeJson() { throw new Error('no evidence is written by a drift fingerprint') },
  async writeBinary() { throw new Error('no evidence is written by a drift fingerprint') },
  addSecrets() { /* nothing is written */ },
}

/** A watched path that can change an audit result: git HEAD, lock files, the stack's config files, email templates. */
export function isRelevantChange(path: string, root: string, profile: ProductionProfile): boolean {
  const rel = (isAbsolute(path) ? relative(root, path) : path).split(sep).join('/')
  if (rel.startsWith('..')) return false
  if (rel === '.git/HEAD' || rel.startsWith('.git/refs/heads/') || rel === '.git/packed-refs') return true
  if (rel.startsWith('.git/') || rel.startsWith('node_modules/')) return false
  if (LOCK_FILES.includes(rel)) return true
  return (profile.stack?.infrastructureFiles ?? []).includes(rel) || (profile.stack?.emailTemplates ?? []).includes(rel)
}

// ---------------------------------------------------------------------------------------------
// Default ports
// ---------------------------------------------------------------------------------------------

/** Adapters from the environment's configuration; each checks the run's policy before a mutation. */
export function defaultAdapters(environment: ProductionEnvironment, policy: NetworkPolicy, options: { resolveCredential: (ref: CredentialRef) => string | null; projectRoot: string | null }): Adapters {
  const adapters: Adapters = { mail: null, commerce: null, storage: null }
  if (environment.capturedMail) adapters.mail = createCapturedMailAdapter(environment.capturedMail)
  const commerce = environment.commerce
  if (commerce?.kind === 'woocommerce') adapters.commerce = createWooCommerceAdapter({ endpoint: commerce.endpoint, policy, credentialRef: commerce.credentialRef, resolveCredential: options.resolveCredential })
  else if (commerce?.kind === 'custom-command') adapters.commerce = createCustomCommandAdapter({ command: commerce.endpoint, cwd: options.projectRoot ?? undefined, policy, credentialRef: commerce.credentialRef, resolveCredential: options.resolveCredential })
  if (environment.storage) adapters.storage = createStorageAdapter(environment.storage, { policy, resolveCredential: options.resolveCredential })
  const records = recordsAdapter(adapters.commerce)
  if (records) adapters.records = records
  return adapters
}

/** `env` credentials from the process environment; `secret-file` ones from userData/production-secrets.json (a flat key → value object). */
export function defaultCredentialResolver(userData: string): (ref: CredentialRef) => string | null {
  return ref => {
    if (ref.source === 'env') return process.env[ref.key] ?? null
    try {
      const path = join(userData, 'production-secrets.json')
      if (!existsSync(path) || statSync(path).size > 256 * 1024) return null
      const value = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)[ref.key]
      return typeof value === 'string' ? value : null
    } catch { return null }
  }
}

/** Runs a shell command with bounded time and output; the exit code is returned, not thrown. */
export const defaultCommandRunner: CommandRunner = (command, options) => new Promise(resolve => {
  const child = spawn(command, { cwd: options.cwd ?? undefined, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let settled = false
  const append = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-MAX_FILE_BYTES * 2) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const done = (result: { exitCode: number | null; timedOut: boolean; note?: string }): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    options.signal.removeEventListener('abort', stop)
    resolve({ exitCode: result.exitCode, output: result.note ? `${output}\n${result.note}` : output, timedOut: result.timedOut })
  }
  // A timeout or abort settles at once: the whole tree is killed, and its pipes may close later.
  const stop = (): void => { killTree(child); done({ exitCode: null, timedOut: false, note: 'stopped' }) }
  const timer = setTimeout(() => { killTree(child); done({ exitCode: null, timedOut: true }) }, options.timeoutMs)
  options.signal.addEventListener('abort', stop, { once: true })
  child.on('error', error => done({ exitCode: null, timedOut: false, note: error.message }))
  child.on('close', code => done({ exitCode: code, timedOut: false }))
})

/** The checked-out commit, read from .git (worktrees and packed refs included); null when there is none. */
export function readGitHead(root: string): string | null {
  try {
    let gitDir = join(root, '.git')
    if (existsSync(gitDir) && statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]?.trim()
      if (!pointer) return null
      gitDir = resolve(root, pointer)
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]
    if (!ref) return /^[0-9a-f]{40}$/i.test(head) ? head : null
    const common = existsSync(join(gitDir, 'commondir')) ? resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()) : gitDir
    for (const dir of [gitDir, common]) {
      const loose = join(dir, ref)
      if (existsSync(loose)) return readFileSync(loose, 'utf8').trim()
    }
    const packed = join(common, 'packed-refs')
    if (existsSync(packed)) {
      const line = readFileSync(packed, 'utf8').split('\n').find(entry => entry.endsWith(` ${ref}`))
      if (line) return line.split(' ')[0]!
    }
    return null
  } catch { return null }
}

async function readFiles(source: SourceTree, paths: readonly string[], limit = 50): Promise<FingerprintFile[]> {
  const out: FingerprintFile[] = []
  for (const path of paths.slice(0, limit)) {
    const content = await source.read(path, MAX_FILE_BYTES).catch(() => null)
    if (content !== null) out.push({ path, content })
  }
  return out
}

async function hashFilesFrom(source: SourceTree, paths: readonly string[], extra?: readonly string[]): Promise<string> {
  const files = await readFiles(source, paths)
  if (extra?.length) files.push({ path: '#plugins', content: [...extra].sort().join('\n') })
  return hashFiles(files)
}

/**
 * The full target fingerprint: deployed commit and build (the environment's build-info command, or
 * git HEAD), the stack's configuration files, the policy pages read through the audit browser
 * (read-only), lock files and plugin versions, the route list, and the profile and registry versions.
 */
export async function computeTargetFingerprint(request: FingerprintRequest, ports: { gitHead(projectId: string): Promise<string | null>; runCommand: CommandRunner | null; projectRoot(projectId: string): string | null }): Promise<TargetFingerprint> {
  const { profile, environment, source, browser, signal } = request
  let commit: string | null = null, build: string | null = null
  if (environment.buildInfoCommand && ports.runCommand) {
    const result = await ports.runCommand(environment.buildInfoCommand, { cwd: ports.projectRoot(profile.projectId), timeoutMs: 60_000, signal })
    const text = result.output.trim()
    try { const parsed = JSON.parse(text) as { commit?: unknown; build?: unknown }; commit = typeof parsed.commit === 'string' ? parsed.commit : null; build = typeof parsed.build === 'string' ? parsed.build : null } catch { commit = text.split('\n')[0]?.trim() || null }
  }
  commit ??= await ports.gitHead(profile.projectId)
  const configFiles = source ? await readFiles(source, profile.stack?.infrastructureFiles ?? []) : []
  const dependencyFiles = source ? await readFiles(source, LOCK_FILES) : []
  if (profile.stack?.plugins.length) dependencyFiles.push({ path: '#plugins', content: [...profile.stack.plugins].sort().join('\n') })
  const policyPages: FingerprintFile[] = []
  if (browser) {
    const policyRoutes = profile.scope.routes.filter(route => route.tags.includes('policy') && route.coverage !== 'excluded').slice(0, 8)
    for (const route of policyRoutes) {
      if (signal.aborted) break
      let page
      try { page = await browser.open({ device: 'desktop', locale: profile.scope.locales[0] ?? null, auth: null, consent: 'clean', regionSelection: profile.scope.regionSelection }) } catch (error) {
        // An unusable site-gate state leaves the policy pages unread, not the run failed.
        if (!(error instanceof AuthUnavailable)) throw error
        policyPages.push({ path: route.path, content: 'unreadable:login-state-unavailable' })
        continue
      }
      try {
        const navigation = await page.goto(new URL(route.path, environment.baseUrl).href)
        policyPages.push({ path: route.path, content: navigation.outcome === 'ok' ? normalisePolicyText((await page.snapshot()).text) : `unreadable:${navigation.outcome}:${navigation.status ?? ''}` })
      } finally { await page.close().catch(() => undefined) }
    }
  }
  return computeFingerprint({
    environmentId: environment.id, commit, build, configFiles, policyPages, dependencyFiles,
    routes: profile.scope.routes.filter(route => route.coverage !== 'excluded').map(route => route.path),
    profileVersion: profile.version, registryVersion: REGISTRY.version,
  })
}

export { OWNER }
