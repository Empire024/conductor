import {
  CONTROL_IDS, CONTROL_TITLES, DEFAULT_AUDIT_BUDGET, DEFAULT_DRIFT_MINUTES, RUN_TRANSITIONS,
  type AuditRequest, type AuditRun, type AuditTrigger, type BudgetLedger, type ControlId, type ControlRegistry, type ControlResult,
  type FactKey, type Finding, type GateState, type OwnerQuestion, type ProductionBridge, type ProductionEnvironment,
  type ProductionProfile, type ProductionProjectSnapshot, type ProductionQueueEntry, type ProductionRunSummary, type ProfileFacts,
  type ProfileUpdate, type RouteCoverage, type RunKind, type RunStatus, type SandboxWriteAuthorization, type TargetFingerprint,
  type Waiver, type WaiverRequest, type WriteAuthorizationRequest
} from './production'

/**
 * An in-memory ProductionBridge for renderer tests and stories (docs/production-agent.md M3), in the
 * spirit of durable-jobs-fake.ts. It keeps the contract rules the panel depends on (unknown ids
 * throw, run moves follow RUN_TRANSITIONS, a waiver needs reason/scope/owner and a future expiry, a
 * production environment is never write-authorized, every change fires onChanged with the project
 * id) and nothing else: no browser, no model, no disk. The gate is whatever the test seeded; the
 * fake never recomputes the state (that is gate.ts), only the counters the panel shows beside it.
 */

const FACT_KEYS = [
  'legalEntity', 'targetCountries', 'businessModel', 'products', 'accountFeatures', 'subscriptions', 'userUploads',
  'aiRuntime', 'analytics', 'sessionReplay', 'emailMarketing', 'dataCategories', 'audience', 'ageRestrictedProducts',
  'paymentProviders', 'processors', 'safeHarborReliance',
] as const satisfies readonly FactKey[]
const BOOLEAN_FACTS = new Set<FactKey>(['accountFeatures', 'subscriptions', 'userUploads', 'aiRuntime', 'analytics', 'sessionReplay', 'emailMarketing', 'ageRestrictedProducts', 'safeHarborReliance'])
const LIST_FACTS = new Set<FactKey>(['targetCountries', 'products', 'dataCategories', 'paymentProviders', 'processors'])

const T0 = '2026-09-29T08:00:00.000Z'

export const fakeFingerprint = (overrides: Partial<TargetFingerprint> = {}): TargetFingerprint => ({
  environmentId: 'env-prod', commit: '0123456789abcdef0123456789abcdef01234567', build: 'build-42',
  configHash: 'cfg', policyHash: 'pol', dependencyHash: 'dep', routesHash: 'routes',
  profileVersion: 3, registryVersion: 1, computedAt: T0, ...overrides
})

export const emptyLedger = (): BudgetLedger => ({
  tokens: 0, modelCalls: 0, requests: 0, elapsedMs: 0,
  byRole: { classify: { calls: 0, tokens: 0 }, interpret: { calls: 0, tokens: 0 }, 'verify-review': { calls: 0, tokens: 0 } },
  exhausted: null
})

export const emptyCoverage = (): RouteCoverage => ({ tested: [], sampled: [], excluded: [], unobservable: [] })

export const fakeTrigger = (overrides: Partial<AuditTrigger> = {}): AuditTrigger => ({
  kind: 'manual', by: { kind: 'owner', agentSessionId: null, title: null }, at: T0, changes: [], detail: 'Audit from the Production panel', ...overrides
})

export const fakeGate = (overrides: Partial<GateState> = {}): GateState => ({
  projectId: 'p1', environmentId: 'env-prod', state: 'NOT_AUDITED', reasons: ['No completed audit for this environment'],
  runId: null, fingerprint: null, staleControls: [], openCriticalOrHigh: 0, unverifiedControls: [], humanReviewPending: 0,
  openQuestions: 0, activeWaivers: 0, results: [], computedAt: T0, ...overrides
})

export const fakeEnvironment = (overrides: Partial<ProductionEnvironment> = {}): ProductionEnvironment => ({
  id: 'env-prod', kind: 'production', label: 'Production', baseUrl: 'https://shop.example.com', allowedOrigins: ['https://shop.example.com'],
  accounts: [], capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null, ...overrides
})

export const fakeQuestion = (overrides: Partial<OwnerQuestion> = {}): OwnerQuestion => ({
  id: 'q-analytics', factKey: 'analytics', question: 'Are analytics, advertising pixels or other tracking intended on the site? (yes/no)',
  why: 'Decides whether consent is required before tracking or the site must be essential-only.', blocksControls: ['C03', 'C05'],
  status: 'open', answer: null, answeredAt: null, answeredBy: null, createdAt: T0, ...overrides
})

export function fakeProfile(projectId = 'p1', overrides: Partial<ProductionProfile> = {}): ProductionProfile {
  const facts = Object.fromEntries(FACT_KEYS.map(key => [key, { value: null, status: 'unknown', source: null, at: null }])) as unknown as ProfileFacts
  return {
    projectId, version: 1, updatedAt: T0, updatedBy: 'conductor',
    designation: { productionReady: false, by: null, at: null, note: '', environmentId: null },
    facts, environments: [fakeEnvironment()], writeAuthorizations: [],
    scope: { routes: [], journeys: [], devices: ['desktop', 'mobile'], locales: [], regionSelection: 'none', authStates: ['guest'], consentStates: ['clean', 'rejected', 'accepted'], disabledControls: [] },
    stack: null, budget: { ...DEFAULT_AUDIT_BUDGET }, drift: { enabled: false, everyMinutes: DEFAULT_DRIFT_MINUTES, onChange: 'mark-stale' }, questions: [],
    ...overrides
  }
}

export const fakeRun = (overrides: Partial<ProductionRunSummary> = {}): ProductionRunSummary => ({
  id: 'run-1', kind: 'audit', environmentId: 'env-prod', status: 'completed', statusReason: null, trigger: fakeTrigger(),
  fingerprint: fakeFingerprint(), progress: { done: 21, total: 21, currentStep: null }, ledger: emptyLedger(),
  createdAt: T0, finishedAt: '2026-09-29T08:20:00.000Z', reportPaths: { markdown: 'report.md', json: 'report.json' }, ...overrides
})

export const fakeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'f-tracker', projectId: 'p1', environmentId: 'env-prod', controlId: 'C03', checkId: 'consent-before-interaction',
  key: 'tracker-before-consent:ga4', route: '/', component: null, scope: 'page', category: 'legal', severity: 'high', confidence: 'confirmed',
  title: 'Google Analytics fires before consent', expected: 'No analytics request before the visitor chooses', observed: 'GET https://www.google-analytics.com/g/collect on first load',
  reproduction: ['Open / in a clean profile', 'Do not interact with the banner', 'Observe the collect request'], evidence: ['ev-requests-1'],
  proposedFix: 'Load gtag only after the consent callback grants analytics.', owner: 'engineering',
  legal: { sources: [{ kind: 'primary-law', title: 'ePrivacy Directive art. 5(3)', jurisdiction: 'EU', url: 'https://eur-lex.europa.eu/eli/dir/2002/58/oj', effectiveDate: '2002-07-31', retrievedAt: null, reviewBy: '2027-01-01' }], effectiveDate: '2002-07-31', reviewBy: '2027-01-01' },
  sources: ['V2-01'], applicability: { status: 'applicable', rationale: 'Analytics is intended', factsUsed: [], ruleIndex: 0 },
  status: 'open', verification: null, firstSeenRunId: 'run-1', lastSeenRunId: 'run-1', lastSeenFingerprint: fakeFingerprint(), occurrences: 1,
  taskId: null, waiverId: null, createdAt: T0, updatedAt: T0, ...overrides
})

export const fakeControlResult = (controlId: ControlId, overrides: Partial<ControlResult> = {}): ControlResult => ({
  runId: 'run-1', controlId, status: 'PASS', applicability: { status: 'applicable', rationale: 'Always applies to a public site', factsUsed: [], ruleIndex: null },
  rationale: '', evidence: [], findingIds: [], humanReview: [], checks: [], coverage: emptyCoverage(), provenance: [], ...overrides
})

export const fakeRegistry = (): ControlRegistry => ({
  version: 1,
  controls: CONTROL_IDS.map(id => ({
    id, title: CONTROL_TITLES[id], sources: [], classification: 'legal', owner: 'engineering',
    applicability: { requiredFacts: [], rules: [], otherwise: 'applicable' }, provenance: [], evidenceRequirements: [], checks: [],
    humanReviewAlways: false, invalidatedBy: []
  }))
})

export function emptySnapshot(projectId: string, now = T0): ProductionProjectSnapshot {
  return {
    projectId, profile: null, gate: fakeGate({ projectId, environmentId: null, computedAt: now }), activeRun: null, runs: [], findings: [],
    waivers: [], results: [], registryVersion: 1, browser: null
  }
}

const TERMINAL: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

export class FakeProductionBridge implements ProductionBridge {
  private readonly snapshots = new Map<string, ProductionProjectSnapshot>()
  private readonly names = new Map<string, string>()
  private readonly listeners = new Set<(projectId: string) => void>()
  private sequence = 0
  /** Every bridge call in order, for tests that assert what the panel asked for. */
  readonly calls: Array<{ method: keyof ProductionBridge; args: unknown[] }> = []

  constructor(private readonly options: { now?: () => number } = {}) {}

  private now(): string { return new Date(this.options.now?.() ?? Date.parse(T0)).toISOString() }
  private id(prefix: string): string { this.sequence += 1; return `${prefix}-${this.sequence}` }
  private log(method: keyof ProductionBridge, args: unknown[]): void { this.calls.push({ method, args: structuredClone(args) }) }
  private emit(projectId: string): void { for (const listener of this.listeners) listener(projectId) }

  /** Test helper: puts a project's snapshot (and its display name for the queue) in place. */
  seed(projectId: string, snapshot: Partial<ProductionProjectSnapshot> = {}, name = projectId): ProductionProjectSnapshot {
    const next = { ...emptySnapshot(projectId, this.now()), ...structuredClone(snapshot), projectId }
    this.snapshots.set(projectId, next)
    this.names.set(projectId, name)
    this.recount(next)
    return structuredClone(next)
  }

  /** Test helper: changes a seeded snapshot the way the engine would, then notifies listeners. */
  update(projectId: string, change: (snapshot: ProductionProjectSnapshot) => void): void {
    const snapshot = this.require(projectId)
    change(snapshot)
    this.recount(snapshot)
    this.emit(projectId)
  }

  private ensure(projectId: string): ProductionProjectSnapshot {
    if (!this.snapshots.has(projectId)) this.seed(projectId)
    return this.require(projectId)
  }

  private require(projectId: string): ProductionProjectSnapshot {
    const snapshot = this.snapshots.get(projectId)
    if (!snapshot) throw new Error(`No production profile for project ${projectId}`)
    return snapshot
  }

  private profile(snapshot: ProductionProjectSnapshot): ProductionProfile {
    if (!snapshot.profile) snapshot.profile = fakeProfile(snapshot.projectId, { environments: [], updatedAt: this.now() })
    return snapshot.profile
  }

  private bump(profile: ProductionProfile): ProductionProfile {
    profile.version += 1
    profile.updatedAt = this.now()
    profile.updatedBy = 'owner'
    return structuredClone(profile)
  }

  /** The counters the panel shows beside the gate; the state itself stays what was seeded. */
  private recount(snapshot: ProductionProjectSnapshot): void {
    const open = snapshot.findings.filter(finding => finding.status === 'open' || finding.status === 'reopened')
    snapshot.gate.openCriticalOrHigh = open.filter(finding => finding.severity === 'critical' || finding.severity === 'high').length
    snapshot.gate.openQuestions = snapshot.profile?.questions.filter(question => question.status === 'open').length ?? 0
    snapshot.gate.activeWaivers = snapshot.waivers.filter(waiver => !waiver.revokedAt && Date.parse(waiver.expiresAt) > Date.parse(this.now())).length
  }

  private finding(snapshot: ProductionProjectSnapshot, findingId: string): Finding {
    const finding = snapshot.findings.find(item => item.id === findingId)
    if (!finding) throw new Error(`No finding ${findingId} in project ${snapshot.projectId}`)
    return finding
  }

  private startRun(snapshot: ProductionProjectSnapshot, kind: RunKind, environmentId: string, detail: string, total: number): ProductionRunSummary {
    if (snapshot.activeRun) {
      const active = snapshot.runs.find(run => run.id === snapshot.activeRun!.id)
      return structuredClone(active ?? snapshot.activeRun)
    }
    const at = this.now()
    const run: ProductionRunSummary = {
      id: this.id('run'), kind, environmentId, status: 'queued', statusReason: null,
      trigger: fakeTrigger({ kind: kind === 'audit' ? 'manual' : kind === 'retest' ? 'retest' : kind === 'verify' ? 'verify' : 'drift', at, detail }),
      fingerprint: fakeFingerprint({ environmentId, computedAt: at, profileVersion: snapshot.profile?.version ?? 1 }),
      progress: { done: 0, total, currentStep: null }, ledger: emptyLedger(), createdAt: at, finishedAt: null, reportPaths: null
    }
    snapshot.runs.unshift(run)
    snapshot.activeRun = structuredClone(run)
    snapshot.gate.state = 'AUDITING'
    return structuredClone(run)
  }

  private environmentFor(snapshot: ProductionProjectSnapshot, environmentId: string | undefined): string {
    const environments = snapshot.profile?.environments ?? []
    const chosen = environmentId ?? snapshot.profile?.designation.environmentId ?? environments[0]?.id
    if (!chosen || !environments.some(environment => environment.id === chosen)) throw new Error('Add an environment before starting an audit')
    return chosen
  }

  private moveRun(snapshot: ProductionProjectSnapshot, runId: string, status: RunStatus, reason: string | null): void {
    const run = snapshot.runs.find(item => item.id === runId)
    if (!run) throw new Error(`No run ${runId} in project ${snapshot.projectId}`)
    if (!RUN_TRANSITIONS[run.status].includes(status)) throw new Error(`A ${run.status} run cannot become ${status}`)
    run.status = status
    run.statusReason = reason
    if (TERMINAL.includes(status)) { run.finishedAt = this.now(); snapshot.activeRun = null }
    else snapshot.activeRun = structuredClone(run)
  }

  async snapshot(projectId: string): Promise<ProductionProjectSnapshot> {
    this.log('snapshot', [projectId])
    return structuredClone(this.snapshots.get(projectId) ?? emptySnapshot(projectId, this.now()))
  }

  async queue(): Promise<ProductionQueueEntry[]> {
    this.log('queue', [])
    return [...this.snapshots.values()].filter(snapshot => snapshot.profile?.designation.productionReady).map(snapshot => {
      const open = snapshot.findings.filter(finding => finding.status === 'open' || finding.status === 'reopened')
      const completed = snapshot.runs.filter(run => run.status === 'completed' && run.finishedAt).map(run => run.finishedAt!).sort()
      return {
        projectId: snapshot.projectId, projectName: this.names.get(snapshot.projectId) ?? snapshot.projectId,
        designation: structuredClone(snapshot.profile!.designation), gate: structuredClone(snapshot.gate), activeRun: structuredClone(snapshot.activeRun),
        openFindings: {
          critical: open.filter(finding => finding.severity === 'critical').length,
          high: open.filter(finding => finding.severity === 'high').length,
          other: open.filter(finding => finding.severity !== 'critical' && finding.severity !== 'high').length
        },
        openQuestions: snapshot.profile!.questions.filter(question => question.status === 'open').length,
        lastCompletedAt: completed.at(-1) ?? null
      }
    })
  }

  async registry(): Promise<ControlRegistry> { this.log('registry', []); return fakeRegistry() }

  async designate(projectId: string, designation: { productionReady: boolean; environmentId: string | null; note: string }): Promise<ProductionProfile> {
    this.log('designate', [projectId, designation])
    const snapshot = this.ensure(projectId)
    const profile = this.profile(snapshot)
    if (designation.productionReady && !profile.environments.some(environment => environment.id === designation.environmentId)) throw new Error('Production readiness must name one of the project environments')
    profile.designation = { productionReady: designation.productionReady, environmentId: designation.environmentId, note: designation.note, by: 'owner', at: this.now() }
    const result = this.bump(profile)
    this.emit(projectId)
    return result
  }

  async updateProfile(projectId: string, update: ProfileUpdate): Promise<ProductionProfile> {
    this.log('updateProfile', [projectId, update])
    const snapshot = this.ensure(projectId)
    const profile = this.profile(snapshot)
    for (const [key, value] of Object.entries(update.facts ?? {}) as Array<[FactKey, unknown]>) {
      (profile.facts as unknown as Record<FactKey, unknown>)[key] = { value, status: 'evidenced', source: 'owner', at: this.now() }
    }
    if (update.environments) {
      for (const environment of update.environments) {
        if (!/^https?:\/\//.test(environment.baseUrl)) throw new Error(`Environment ${environment.label} needs an http(s) base URL`)
      }
      profile.environments = structuredClone(update.environments)
    }
    if (update.scope) profile.scope = { ...profile.scope, ...structuredClone(update.scope) }
    if (update.budget) profile.budget = { ...profile.budget, ...update.budget }
    if (update.drift) {
      const drift = { ...profile.drift, ...update.drift }
      if (!Number.isFinite(drift.everyMinutes) || drift.everyMinutes < 60) throw new Error('Drift checks run at most once an hour')
      profile.drift = drift
    }
    const result = this.bump(profile)
    this.emit(projectId)
    return result
  }

  async answerQuestion(projectId: string, questionId: string, answer: string): Promise<ProductionProfile> {
    this.log('answerQuestion', [projectId, questionId, answer])
    const snapshot = this.require(projectId)
    const profile = this.profile(snapshot)
    const question = profile.questions.find(item => item.id === questionId)
    if (!question) throw new Error(`No owner question ${questionId}`)
    if (question.status !== 'open') throw new Error('This question is already settled')
    const text = answer.trim()
    if (!text) throw new Error(`The answer for ${question.factKey} is empty`)
    let value: unknown = text
    if (BOOLEAN_FACTS.has(question.factKey)) {
      if (/^(yes|y|true)$/i.test(text)) value = true
      else if (/^(no|n|false)$/i.test(text)) value = false
      else throw new Error(`Answer ${question.factKey} with yes or no`)
    } else if (LIST_FACTS.has(question.factKey)) value = /^(none|no)$/i.test(text) ? [] : text.split(/[,;\n]/).map(item => item.trim()).filter(Boolean)
    const at = this.now()
    Object.assign(question, { status: 'answered', answer: text, answeredAt: at, answeredBy: 'owner' })
    ;(profile.facts as unknown as Record<FactKey, unknown>)[question.factKey] = { value, status: 'evidenced', source: 'owner', at }
    const result = this.bump(profile)
    this.recount(snapshot)
    this.emit(projectId)
    return result
  }

  async dismissQuestion(projectId: string, questionId: string, reason: string): Promise<ProductionProfile> {
    this.log('dismissQuestion', [projectId, questionId, reason])
    const snapshot = this.require(projectId)
    const profile = this.profile(snapshot)
    const question = profile.questions.find(item => item.id === questionId)
    if (!question) throw new Error(`No owner question ${questionId}`)
    Object.assign(question, { status: 'dismissed', answer: reason.trim() || null, answeredAt: this.now(), answeredBy: 'owner' })
    const result = this.bump(profile)
    this.recount(snapshot)
    this.emit(projectId)
    return result
  }

  async audit(projectId: string, request: AuditRequest): Promise<ProductionRunSummary> {
    this.log('audit', [projectId, request])
    const snapshot = this.require(projectId)
    const run = this.startRun(snapshot, 'audit', this.environmentFor(snapshot, request.environmentId), 'Audit from the Production panel', 4 + (request.controls?.length ?? CONTROL_IDS.length))
    this.emit(projectId)
    return run
  }

  async retest(projectId: string, findingIds: string[]): Promise<ProductionRunSummary> {
    this.log('retest', [projectId, findingIds])
    const snapshot = this.require(projectId)
    if (!findingIds.length) throw new Error('Select the findings to re-test')
    const findings = findingIds.map(id => this.finding(snapshot, id))
    const run = this.startRun(snapshot, 'retest', findings[0]!.environmentId, `Re-test ${findings.length} finding(s)`, 2 + findings.length)
    this.emit(projectId)
    return run
  }

  async verify(projectId: string, findingIds: string[]): Promise<ProductionRunSummary> {
    this.log('verify', [projectId, findingIds])
    const snapshot = this.require(projectId)
    if (!findingIds.length) throw new Error('Select the findings to verify')
    const findings = findingIds.map(id => this.finding(snapshot, id))
    const run = this.startRun(snapshot, 'verify', findings[0]!.environmentId, `Verify ${findings.length} finding(s)`, 2 + findings.length)
    this.emit(projectId)
    return run
  }

  async pause(projectId: string, runId: string): Promise<void> {
    this.log('pause', [projectId, runId])
    this.moveRun(this.require(projectId), runId, 'paused', 'Paused by the owner')
    this.emit(projectId)
  }

  async resume(projectId: string, runId: string): Promise<void> {
    this.log('resume', [projectId, runId])
    this.moveRun(this.require(projectId), runId, 'running', null)
    this.emit(projectId)
  }

  async cancel(projectId: string, runId: string, reason: string): Promise<void> {
    this.log('cancel', [projectId, runId, reason])
    this.moveRun(this.require(projectId), runId, 'cancelled', reason)
    this.emit(projectId)
  }

  async run(projectId: string, runId: string): Promise<AuditRun> {
    this.log('run', [projectId, runId])
    const snapshot = this.require(projectId)
    const summary = snapshot.runs.find(item => item.id === runId)
    if (!summary) throw new Error(`No run ${runId} in project ${projectId}`)
    return {
      id: summary.id, projectId, kind: summary.kind, environmentId: summary.environmentId, trigger: summary.trigger, parentRunId: null, verifies: [],
      fingerprint: summary.fingerprint, status: summary.status, statusReason: summary.statusReason, controls: [...CONTROL_IDS], steps: [],
      checkpoint: { nextStepIndex: summary.progress.done, doneStepIds: [], at: summary.createdAt }, budget: snapshot.profile?.budget ?? { ...DEFAULT_AUDIT_BUDGET },
      ledger: summary.ledger, coverage: emptyCoverage(), artifactsDir: `/fake/production-audits/${projectId}/${runId}`, reportPaths: summary.reportPaths,
      createdAt: summary.createdAt, startedAt: summary.createdAt, finishedAt: summary.finishedAt, rerunRequested: null
    }
  }

  async createFixTasks(projectId: string, findingIds: string[]): Promise<Array<{ findingId: string; taskId: string; created: boolean }>> {
    this.log('createFixTasks', [projectId, findingIds])
    const snapshot = this.require(projectId)
    const result = findingIds.map(findingId => {
      const finding = this.finding(snapshot, findingId)
      if (finding.taskId) return { findingId, taskId: finding.taskId, created: false }
      finding.taskId = this.id('task')
      return { findingId, taskId: finding.taskId, created: true }
    })
    this.emit(projectId)
    return result
  }

  async waive(projectId: string, request: WaiverRequest): Promise<Waiver> {
    this.log('waive', [projectId, request])
    const snapshot = this.require(projectId)
    const finding = this.finding(snapshot, request.findingId)
    for (const field of ['reason', 'scope', 'owner'] as const) if (!request[field]?.trim()) throw new Error(`A waiver needs a ${field}`)
    const expires = Date.parse(request.expiresAt)
    if (!request.expiresAt || !Number.isFinite(expires)) throw new Error('A waiver needs an expiry date')
    if (expires <= Date.parse(this.now())) throw new Error('A waiver expiry must be in the future')
    const waiver: Waiver = {
      id: this.id('waiver'), projectId, findingId: finding.id, reason: request.reason.trim(), scope: request.scope.trim(), owner: request.owner.trim(),
      grantedBy: { kind: 'owner', agentSessionId: null, title: null }, grantedAt: this.now(), expiresAt: new Date(expires).toISOString(), revokedAt: null, revokedReason: null
    }
    snapshot.waivers.unshift(waiver)
    finding.status = 'waived'
    finding.waiverId = waiver.id
    this.recount(snapshot)
    this.emit(projectId)
    return structuredClone(waiver)
  }

  async revokeWaiver(projectId: string, waiverId: string, reason: string): Promise<Waiver> {
    this.log('revokeWaiver', [projectId, waiverId, reason])
    const snapshot = this.require(projectId)
    const waiver = snapshot.waivers.find(item => item.id === waiverId)
    if (!waiver) throw new Error(`No waiver ${waiverId}`)
    waiver.revokedAt = this.now()
    waiver.revokedReason = reason
    const finding = snapshot.findings.find(item => item.id === waiver.findingId)
    if (finding && finding.waiverId === waiverId) { finding.status = 'open'; finding.waiverId = null }
    this.recount(snapshot)
    this.emit(projectId)
    return structuredClone(waiver)
  }

  async authorizeWrites(projectId: string, request: WriteAuthorizationRequest): Promise<SandboxWriteAuthorization> {
    this.log('authorizeWrites', [projectId, request])
    const profile = this.profile(this.require(projectId))
    const environment = profile.environments.find(item => item.id === request.environmentId)
    if (!environment) throw new Error(`No environment ${request.environmentId}`)
    if (environment.kind === 'production') throw new Error('A production environment is never authorized for writes')
    if (!request.mutations.length) throw new Error('Name at least one mutation')
    if (!(Date.parse(request.expiresAt) > Date.parse(this.now()))) throw new Error('A write authorization needs a future expiry')
    const authorization: SandboxWriteAuthorization = {
      id: this.id('writes'), environmentId: environment.id, mutations: [...request.mutations], grantedBy: { kind: 'owner', agentSessionId: null },
      grantedAt: this.now(), expiresAt: new Date(Date.parse(request.expiresAt)).toISOString(), note: request.note
    }
    profile.writeAuthorizations.push(authorization)
    this.bump(profile)
    this.emit(projectId)
    return structuredClone(authorization)
  }

  async revokeWrites(projectId: string, authorizationId: string): Promise<void> {
    this.log('revokeWrites', [projectId, authorizationId])
    const profile = this.profile(this.require(projectId))
    if (!profile.writeAuthorizations.some(item => item.id === authorizationId)) throw new Error(`No write authorization ${authorizationId}`)
    profile.writeAuthorizations = profile.writeAuthorizations.filter(item => item.id !== authorizationId)
    this.bump(profile)
    this.emit(projectId)
  }

  async openEvidence(projectId: string, runId: string, evidenceId: string): Promise<void> { this.log('openEvidence', [projectId, runId, evidenceId]) }
  async openReport(projectId: string, runId: string): Promise<void> { this.log('openReport', [projectId, runId]) }

  onChanged(callback: (projectId: string) => void): () => void {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }
}
