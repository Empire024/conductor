/**
 * Production agent and Production Verifier (docs/production-agent.md). The shared contract between
 * the main-process audit engine (src/main/production/), the control protocol (`production.*`),
 * IPC and the renderer Production panel. Every implementation module builds against this file;
 * only the wizard edits it after the initial version, and a worker who needs a change proposes it
 * in its report.
 *
 * Vocabulary: a *profile* is what the owner and discovery know about one project (facts, environments,
 * scope); the *registry* is the fixed list of sixteen controls with applicability predicates and
 * provenance; a *run* is one bounded, checkpointed audit (or re-test, or verification) of one
 * environment at one target fingerprint; *findings* are stable across runs; the *gate* is the
 * derived project audit state, always kept apart from the owner's production-ready designation.
 */

// ---------------------------------------------------------------------------------------------
// Controls and source coverage
// ---------------------------------------------------------------------------------------------

export const CONTROL_IDS = [
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08',
  'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16',
] as const
export type ControlId = (typeof CONTROL_IDS)[number]

/** The 26 source items: V1 = the earlier video's six risk areas, V2 = the new video's 20 checks. */
export const SOURCE_ITEM_IDS = [
  'V1-01', 'V1-02', 'V1-03', 'V1-04', 'V1-05', 'V1-06',
  'V2-01', 'V2-02', 'V2-03', 'V2-04', 'V2-05', 'V2-06', 'V2-07', 'V2-08', 'V2-09', 'V2-10',
  'V2-11', 'V2-12', 'V2-13', 'V2-14', 'V2-15', 'V2-16', 'V2-17', 'V2-18', 'V2-19', 'V2-20',
] as const
export type SourceItemId = (typeof SOURCE_ITEM_IDS)[number]

/**
 * Coverage map: every source item names exactly one control. registry.test.ts asserts that the
 * map covers SOURCE_ITEM_IDS completely and that every ControlDefinition.sources agrees with it.
 */
export const SOURCE_COVERAGE: Readonly<Record<SourceItemId, ControlId>> = {
  'V1-01': 'C14', 'V1-02': 'C05', 'V1-03': 'C06', 'V1-04': 'C08', 'V1-05': 'C10', 'V1-06': 'C15',
  'V2-01': 'C03', 'V2-02': 'C13', 'V2-03': 'C12', 'V2-04': 'C01', 'V2-05': 'C12', 'V2-06': 'C05',
  'V2-07': 'C09', 'V2-08': 'C11', 'V2-09': 'C02', 'V2-10': 'C05', 'V2-11': 'C13', 'V2-12': 'C04',
  'V2-13': 'C07', 'V2-14': 'C10', 'V2-15': 'C13', 'V2-16': 'C01', 'V2-17': 'C12', 'V2-18': 'C14',
  'V2-19': 'C04', 'V2-20': 'C16',
}

export const CONTROL_TITLES: Readonly<Record<ControlId, string>> = {
  C01: 'Privacy policy and terms',
  C02: 'Business identity',
  C03: 'Cookies and consent behavior',
  C04: 'Forms and data minimization',
  C05: 'Vendors, external fonts and AI',
  C06: 'Session replay',
  C07: 'Data rights and deletion',
  C08: 'Marketing email',
  C09: 'Pricing and hidden fees',
  C10: 'Subscriptions and cancellation',
  C11: 'Refunds and withdrawal',
  C12: 'Claims, reviews and dark patterns',
  C13: 'Accessibility',
  C14: 'Children and age-restricted use',
  C15: 'Uploads and copyright',
  C16: 'Storage exposure',
}

/** Legal findings are kept apart from technical observations and internal quality requirements. */
export const CONTROL_CLASSIFICATIONS = ['legal', 'internal-policy', 'engineering'] as const
export type ControlClassification = (typeof CONTROL_CLASSIFICATIONS)[number]

export const CONTROL_OWNERS = ['engineering', 'legal', 'content', 'operations'] as const
export type ControlOwner = (typeof CONTROL_OWNERS)[number]

export const PROVENANCE_KINDS = ['primary-law', 'regulator-guidance', 'standard', 'internal-policy', 'video-source'] as const
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number]

/** Where a control or a legal finding comes from. Primary sources carry retrieval and review dates. */
export interface Provenance {
  kind: ProvenanceKind
  title: string
  /** ISO 3166-1 alpha-2 country, `EU`, or a country-region such as `US-CA`; null for internal or video sources. */
  jurisdiction: string | null
  url: string | null
  effectiveDate: string | null
  /** When the source text was last retrieved and compared; null means never checked by Conductor. */
  retrievedAt: string | null
  /** When a human should re-verify the source (amendments, new effective dates). */
  reviewBy: string | null
  note?: string
}

// ---------------------------------------------------------------------------------------------
// Project profile: facts, environments, scope, questions
// ---------------------------------------------------------------------------------------------

export const FACT_STATUSES = ['evidenced', 'assumed', 'unknown'] as const
export type FactStatus = (typeof FACT_STATUSES)[number]

/** One recorded fact. `unknown` facts with a null value become owner questions; the agent never fills them. */
export interface ProfileFact<T> {
  value: T | null
  status: FactStatus
  /** Who established it: the owner's answer, discovery (file or page path), or an agent's assumption. */
  source: 'owner' | 'discovery' | 'assumption' | null
  at: string | null
  note?: string
}

export const BUSINESS_MODELS = ['b2b', 'b2c', 'both'] as const
export type BusinessModel = (typeof BUSINESS_MODELS)[number]

export const AUDIENCES = ['general', 'child-directed', 'mixed', 'adult-only'] as const
export type Audience = (typeof AUDIENCES)[number]

/** Facts the registry predicates read. Keys are stable: they are referenced by name in predicates and questions. */
export interface ProfileFacts {
  legalEntity: ProfileFact<string>
  /** ISO 3166-1 alpha-2 codes of the countries the project sells to or targets, plus `EU` where relevant. */
  targetCountries: ProfileFact<string[]>
  businessModel: ProfileFact<BusinessModel>
  products: ProfileFact<string[]>
  accountFeatures: ProfileFact<boolean>
  subscriptions: ProfileFact<boolean>
  userUploads: ProfileFact<boolean>
  /** Runtime AI features shown to customers (chat, generation), not AI used to write the code. */
  aiRuntime: ProfileFact<boolean>
  analytics: ProfileFact<boolean>
  sessionReplay: ProfileFact<boolean>
  emailMarketing: ProfileFact<boolean>
  dataCategories: ProfileFact<string[]>
  audience: ProfileFact<Audience>
  ageRestrictedProducts: ProfileFact<boolean>
  paymentProviders: ProfileFact<string[]>
  processors: ProfileFact<string[]>
  /** Relies on a DMCA-style hosting safe harbour (US) or equivalent; drives C15 registration checks. */
  safeHarborReliance: ProfileFact<boolean>
}
export type FactKey = keyof ProfileFacts

export const ENVIRONMENT_KINDS = ['production', 'staging', 'sandbox', 'local'] as const
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number]

/** Kinds of mutation a check may perform, each needing an explicit sandbox write authorization. */
export const MUTATION_KINDS = [
  'form-submit', 'account-create', 'checkout', 'subscription-cancel', 'deletion-request',
  'upload', 'email-optout', 'storage-probe-write',
] as const
export type MutationKind = (typeof MUTATION_KINDS)[number]

/**
 * A standing authorization to perform named mutations in one non-production environment. The store
 * refuses one whose environment is `production`; a check that would mutate without a matching
 * authorization is refused by the tool runner, never by the prompt.
 */
export interface SandboxWriteAuthorization {
  id: string
  environmentId: string
  mutations: MutationKind[]
  grantedBy: { kind: 'owner' | 'wizard'; agentSessionId: string | null }
  grantedAt: string
  expiresAt: string
  note: string
}

/** Reference to a credential the runner resolves at run time; the value is never stored in the profile. */
export interface CredentialRef {
  id: string
  /** Where the runner reads the value: an environment variable or a userData secret file entry. */
  source: 'env' | 'secret-file'
  key: string
  purpose: string
}

/** A synthetic test account in a non-production environment. */
export interface TestAccountRef {
  id: string
  label: string
  role: 'guest' | 'customer' | 'subscriber' | 'admin'
  usernameRef: CredentialRef
  passwordRef: CredentialRef
}

export interface CapturedMailConfig {
  kind: 'mailpit' | 'maildir'
  /** Mailpit HTTP API base URL, or the maildir path. */
  location: string
}

export interface CommerceSandboxConfig {
  kind: 'woocommerce' | 'stripe-test' | 'custom-command'
  /** REST base URL for woocommerce/stripe-test; the command line for custom-command (prints JSON). */
  endpoint: string
  credentialRef: CredentialRef | null
}

export interface StorageConfig {
  kind: 's3' | 'wordpress-uploads' | 'local-dir' | 'custom-command'
  location: string
  credentialRef: CredentialRef | null
  /** Path prefixes the owner declares intentionally public (product images); everything else is private. */
  publicPrefixes: string[]
}

export interface ProductionEnvironment {
  id: string
  kind: EnvironmentKind
  label: string
  baseUrl: string
  /** Origins the audit browser may navigate to (scheme + host + port). Third-party subresources are observed, never navigated. */
  allowedOrigins: string[]
  accounts: TestAccountRef[]
  capturedMail: CapturedMailConfig | null
  commerce: CommerceSandboxConfig | null
  storage: StorageConfig | null
  /** Optional command that prints the deployed commit/build (for the fingerprint); null means "use the project HEAD". */
  buildInfoCommand: string | null
  /** The project's own release smoke command, run as an additional engineering check when set. */
  smokeCommand: string | null
}

export const DEVICE_CLASSES = ['desktop', 'mobile'] as const
export type DeviceClass = (typeof DEVICE_CLASSES)[number]

export const CONSENT_STATES = ['clean', 'no-interaction', 'rejected', 'selected', 'accepted', 'withdrawn'] as const
export type ConsentState = (typeof CONSENT_STATES)[number]

export const AUTH_STATES = ['guest', 'authenticated'] as const
export type AuthState = (typeof AUTH_STATES)[number]

/** How regional behaviour was selected for a run; a language switch alone is not geographic evidence. */
export const REGION_SELECTIONS = ['none', 'accept-language', 'query-param', 'geo-override', 'account-country'] as const
export type RegionSelection = (typeof REGION_SELECTIONS)[number]

export interface RouteEntry {
  path: string
  /** Where the route came from: sitemap, crawl, owner list, journey definition, or a shared component. */
  source: 'sitemap' | 'crawl' | 'owner' | 'journey' | 'component'
  tags: string[]
  /** `sampled` routes stand for a group (for example product pages); `excluded` ones are listed, never claimed. */
  coverage: 'full' | 'sampled' | 'excluded'
  excludedReason?: string
}

export interface JourneyDefinition {
  id: string
  title: string
  steps: string[]
  /** Mutations the journey would need beyond navigation; on production the journey stops before the first one. */
  mutations: MutationKind[]
}

export interface AuditScope {
  routes: RouteEntry[]
  journeys: JourneyDefinition[]
  devices: DeviceClass[]
  locales: string[]
  regionSelection: RegionSelection
  authStates: AuthState[]
  consentStates: ConsentState[]
  /** Controls the owner switched off for this project, each with a reason; they report NOT_APPLICABLE with that rationale. */
  disabledControls: Array<{ controlId: ControlId; reason: string }>
}

export interface StackDiscovery {
  platform: 'wordpress' | 'woocommerce' | 'custom' | 'unknown'
  frontend: string[]
  backend: string[]
  plugins: string[]
  integrations: string[]
  emailTemplates: string[]
  infrastructureFiles: string[]
  sitemapUrl: string | null
  discoveredAt: string
  /** Files or pages the discovery could not read (permissions, size), listed rather than silently skipped. */
  unread: string[]
}

export const QUESTION_STATUSES = ['open', 'answered', 'dismissed'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

/** A fact only the owner can give. Answering it writes the fact with source `owner` and bumps the profile version. */
export interface OwnerQuestion {
  id: string
  factKey: FactKey
  question: string
  why: string
  /** Controls that stay UNVERIFIED (or cannot decide applicability) while the question is open. */
  blocksControls: ControlId[]
  status: QuestionStatus
  answer: string | null
  answeredAt: string | null
  answeredBy: string | null
  createdAt: string
}

export interface AuditBudget {
  maxTokens: number
  maxModelCalls: number
  maxRequests: number
  maxDurationMs: number
  /** Requests per second per origin the network policy enforces. */
  requestsPerSecondPerOrigin: number
  /** USD ceiling passed to routing for every cloud interpretation call. */
  maxCostUsdPerCall: number
}

export const DEFAULT_AUDIT_BUDGET: Readonly<AuditBudget> = {
  maxTokens: 120_000,
  maxModelCalls: 40,
  maxRequests: 2_000,
  maxDurationMs: 45 * 60_000,
  requestsPerSecondPerOrigin: 4,
  maxCostUsdPerCall: 0.5,
}

export interface DriftSettings {
  enabled: boolean
  everyMinutes: number
  /** When a drift run finds the fingerprint changed: mark STALE only, or also queue an audit. */
  onChange: 'mark-stale' | 'audit'
}

export interface ProductionDesignation {
  productionReady: boolean
  by: string | null
  at: string | null
  note: string
  /** The environment the designation refers to; readiness always names an environment. */
  environmentId: string | null
}

/** Versioned per-project profile. Every mutation writes a new version; runs record the version they used. */
export interface ProductionProfile {
  projectId: string
  version: number
  updatedAt: string
  updatedBy: string
  designation: ProductionDesignation
  facts: ProfileFacts
  environments: ProductionEnvironment[]
  writeAuthorizations: SandboxWriteAuthorization[]
  scope: AuditScope
  stack: StackDiscovery | null
  budget: AuditBudget
  drift: DriftSettings
  questions: OwnerQuestion[]
}

// ---------------------------------------------------------------------------------------------
// Control registry: applicability predicates with provenance
// ---------------------------------------------------------------------------------------------

export interface FactCondition {
  fact: FactKey
  /** `true`/`false` for booleans, `known`/`unknown` for any fact, `includesAny` for string lists, `equals` for enums. */
  is?: 'true' | 'false' | 'known' | 'unknown'
  equals?: string
  includesAny?: string[]
}

export interface ApplicabilityRule {
  /** Every condition must hold. */
  when: FactCondition[]
  then: 'applicable' | 'not-applicable'
  rationale: string
}

/**
 * Data, not code, so the registry can be listed, versioned and tested. Rules are tried in order and the
 * first match wins; `otherwise` applies when none matches. A required fact that is `unknown` makes the
 * decision `unknown`, which is UNVERIFIED plus an owner question, never PASS or NOT_APPLICABLE.
 */
export interface ApplicabilityPredicate {
  requiredFacts: FactKey[]
  rules: ApplicabilityRule[]
  otherwise: 'applicable' | 'not-applicable' | 'unknown'
}

export const APPLICABILITY_STATUSES = ['applicable', 'not-applicable', 'unknown'] as const
export type ApplicabilityStatus = (typeof APPLICABILITY_STATUSES)[number]

export interface ApplicabilityDecision {
  status: ApplicabilityStatus
  rationale: string
  factsUsed: Array<{ fact: FactKey; value: unknown; status: FactStatus }>
  /** Rule index that decided, or null for `otherwise`. */
  ruleIndex: number | null
}

export interface ControlDefinition {
  id: ControlId
  title: string
  sources: SourceItemId[]
  classification: ControlClassification
  owner: ControlOwner
  applicability: ApplicabilityPredicate
  provenance: Provenance[]
  /** What must exist for a PASS: named artefacts, not prose. */
  evidenceRequirements: string[]
  /** Which check ids implement it; a control without any check can only report NEEDS_HUMAN_REVIEW or NOT_APPLICABLE. */
  checks: string[]
  /** True for controls whose legal adequacy a human must always confirm (C01, C02, C11, C14, C15). */
  humanReviewAlways: boolean
  /** Which change classes invalidate this control's last result. */
  invalidatedBy: ChangeClass[]
}

export interface ControlRegistry {
  version: number
  controls: ControlDefinition[]
}

// ---------------------------------------------------------------------------------------------
// Runs, steps, checkpoints, fingerprints, triggers
// ---------------------------------------------------------------------------------------------

export const CHANGE_CLASSES = ['code', 'content', 'dependency', 'policy', 'deployment', 'configuration', 'profile', 'registry'] as const
export type ChangeClass = (typeof CHANGE_CLASSES)[number]

/** What exactly was tested. Two runs with different fingerprints never share results. */
export interface TargetFingerprint {
  environmentId: string
  commit: string | null
  build: string | null
  /** sha256 over the environment's configuration files discovery lists (infrastructureFiles). */
  configHash: string
  /** sha256 over the fetched policy pages (privacy, terms, refunds) after whitespace normalisation. */
  policyHash: string
  /** sha256 over lock files / plugin versions. */
  dependencyHash: string
  /** sha256 over the sitemap or route list. */
  routesHash: string
  profileVersion: number
  registryVersion: number
  computedAt: string
}

export const RUN_KINDS = ['audit', 'retest', 'verify', 'drift'] as const
export type RunKind = (typeof RUN_KINDS)[number]

export const TRIGGER_KINDS = ['designation', 'manual', 'change', 'drift', 'retest', 'verify', 'schedule'] as const
export type TriggerKind = (typeof TRIGGER_KINDS)[number]

export interface AuditTrigger {
  kind: TriggerKind
  by: { kind: 'owner' | 'wizard' | 'agent' | 'conductor'; agentSessionId: string | null; title: string | null }
  at: string
  /** Change classes that fired a `change` trigger; the run re-tests only the controls they invalidate unless `full`. */
  changes: ChangeClass[]
  detail: string
}

export const RUN_STATUSES = ['queued', 'running', 'paused', 'recovering', 'blocked', 'completed', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled']

/** Same shape of table as durable jobs: the store refuses any move not listed here. */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled', 'paused'],
  running: ['paused', 'recovering', 'blocked', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  recovering: ['running', 'blocked', 'failed', 'cancelled'],
  blocked: ['running', 'recovering', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}

export const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

export const STEP_KINDS = ['discovery', 'fingerprint', 'legal-sources', 'control', 'engineering-smokes', 'interpretation', 'report'] as const
export type StepKind = (typeof STEP_KINDS)[number]

export interface RunStep {
  id: string
  index: number
  kind: StepKind
  /** Set for `control` steps. */
  controlId: ControlId | null
  status: StepStatus
  attempts: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

/** Written after every finished step; a restart resumes at `nextStepIndex` and never repeats a done step. */
export interface RunCheckpoint {
  nextStepIndex: number
  doneStepIds: string[]
  at: string
}

/** The side-effect ledger, as in durable jobs: every intended mutation is journaled before it happens. */
export interface RunOperation {
  id: string
  runId: string
  stepId: string
  mutation: MutationKind
  target: string
  status: 'intended' | 'done' | 'failed' | 'unknown'
  at: string
  reconciliation?: string
}

export const MODEL_ROLES = ['classify', 'interpret', 'verify-review'] as const
export type ModelRole = (typeof MODEL_ROLES)[number]

export interface ModelCallRecord {
  id: string
  runId: string
  role: ModelRole
  provider: string
  model: string
  decisionId: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  durationMs: number
  at: string
  /** A refusal (no local model, budget, weekly stop) costs nothing and is recorded with its reason. */
  refused: string | null
}

export interface BudgetLedger {
  tokens: number
  modelCalls: number
  requests: number
  elapsedMs: number
  byRole: Record<ModelRole, { calls: number; tokens: number }>
  /** Set when the run stopped because a ceiling was reached. */
  exhausted: keyof AuditBudget | null
}

export interface RouteCoverage {
  tested: Array<{ path: string; devices: DeviceClass[]; consentStates: ConsentState[]; authStates: AuthState[] }>
  sampled: Array<{ path: string; standsFor: string }>
  excluded: Array<{ path: string; reason: string }>
  /** Declared gaps: missing authentication, third-party checkout, blocked APIs, unobservable backend or vendor behaviour. */
  unobservable: string[]
}

export interface AuditRun {
  id: string
  projectId: string
  kind: RunKind
  environmentId: string
  trigger: AuditTrigger
  /** The run this one re-tests or verifies. */
  parentRunId: string | null
  /** For `verify` runs: the finding ids under verification. */
  verifies: string[]
  fingerprint: TargetFingerprint
  status: RunStatus
  statusReason: string | null
  /** Controls in scope for this run (a change-triggered run may carry a subset). */
  controls: ControlId[]
  steps: RunStep[]
  checkpoint: RunCheckpoint
  budget: AuditBudget
  ledger: BudgetLedger
  coverage: RouteCoverage
  /** Directory under userData/production-audits/<projectId>/<runId>/ holding evidence and reports. */
  artifactsDir: string
  reportPaths: { markdown: string; json: string } | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Set when a trigger arrived while this run was active; the runner starts one more run when it finishes. */
  rerunRequested: AuditTrigger | null
}

// ---------------------------------------------------------------------------------------------
// Results, findings, evidence, waivers, gate
// ---------------------------------------------------------------------------------------------

export const CONTROL_RESULT_STATUSES = ['PASS', 'FAIL', 'WARN', 'NOT_APPLICABLE', 'UNVERIFIED', 'NEEDS_HUMAN_REVIEW'] as const
export type ControlResultStatus = (typeof CONTROL_RESULT_STATUSES)[number]

/** Worst-of order used when several checks feed one control. */
export const CONTROL_RESULT_SEVERITY: Readonly<Record<ControlResultStatus, number>> = {
  FAIL: 5, UNVERIFIED: 4, NEEDS_HUMAN_REVIEW: 3, WARN: 2, PASS: 1, NOT_APPLICABLE: 0,
}

export const EVIDENCE_KINDS = ['screenshot', 'requests', 'dom', 'storage', 'cookies', 'email', 'log', 'config', 'source', 'axe', 'command', 'note'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** A file under the run's artifactsDir. Written through the evidence sink, which redacts before it writes. */
export interface EvidenceRef {
  id: string
  kind: EvidenceKind
  /** Relative to artifactsDir. */
  path: string
  sha256: string
  description: string
  capturedAt: string
  redacted: boolean
}

export interface HumanReviewItem {
  id: string
  controlId: ControlId
  question: string
  why: string
  route: string | null
  evidence: string[]
}

export interface ControlResult {
  runId: string
  controlId: ControlId
  status: ControlResultStatus
  applicability: ApplicabilityDecision
  /** Required for NOT_APPLICABLE and for every non-PASS; a PASS names the evidence instead. */
  rationale: string
  evidence: string[]
  findingIds: string[]
  humanReview: HumanReviewItem[]
  checks: CheckOutcomeSummary[]
  coverage: RouteCoverage
  /** For legal controls: the provenance that applied, with dates, never a certification. */
  provenance: Provenance[]
}

export interface CheckOutcomeSummary {
  checkId: string
  status: ControlResultStatus
  /** Why a check did not run or could not conclude (timeout, missing credential, failed tool, unavailable model). */
  reason: string | null
  durationMs: number
}

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const
export type Severity = (typeof SEVERITIES)[number]

export const CONFIDENCES = ['confirmed', 'likely', 'suspected'] as const
export type Confidence = (typeof CONFIDENCES)[number]

export const FINDING_CATEGORIES = ['legal', 'technical', 'internal-quality'] as const
export type FindingCategory = (typeof FINDING_CATEGORIES)[number]

export const FINDING_SCOPES = ['page', 'route', 'component', 'journey', 'site', 'config', 'email'] as const
export type FindingScope = (typeof FINDING_SCOPES)[number]

export const FINDING_STATUSES = ['open', 'fixed', 'reopened', 'waived', 'disputed'] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

export const VERIFICATION_STATUSES = ['unverified', 'verified-open', 'verified-fixed', 'could-not-verify', 'disputed'] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

/** What a check emits; the runner assigns the stable id, history and status. */
export interface FindingDraft {
  controlId: ControlId
  checkId: string
  /** Stable within a check for the same defect at the same place (for example `tracker-before-consent:ga4`). */
  key: string
  route: string | null
  component: string | null
  scope: FindingScope
  category: FindingCategory
  severity: Severity
  confidence: Confidence
  title: string
  expected: string
  observed: string
  reproduction: string[]
  evidence: string[]
  proposedFix: string
  owner: ControlOwner
  legal: { sources: Provenance[]; effectiveDate: string | null; reviewBy: string | null } | null
}

export interface VerificationRecord {
  findingId: string
  verifierRunId: string
  fingerprint: TargetFingerprint
  status: VerificationStatus
  /** Set when the verifier's own recheck disagrees with the claimed status (builder said fixed, still reproduces). */
  disagreement: string | null
  evidence: string[]
  at: string
}

export interface Finding extends FindingDraft {
  /** sha256-derived: projectId + environmentId + controlId + checkId + key + route. */
  id: string
  projectId: string
  environmentId: string
  sources: SourceItemId[]
  applicability: ApplicabilityDecision
  status: FindingStatus
  verification: VerificationRecord | null
  firstSeenRunId: string
  lastSeenRunId: string
  lastSeenFingerprint: TargetFingerprint
  occurrences: number
  /** Orchestration board task created for it, if any. */
  taskId: string | null
  waiverId: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A waiver preserves the finding and needs an authorized human (owner credential or wizard tab). The
 * store refuses a waiver whose grantor is the run's own trigger agent or any non-sovereign caller.
 */
export interface Waiver {
  id: string
  projectId: string
  findingId: string
  reason: string
  scope: string
  owner: string
  grantedBy: { kind: 'owner' | 'wizard'; agentSessionId: string | null; title: string | null }
  grantedAt: string
  expiresAt: string
  revokedAt: string | null
  revokedReason: string | null
}

export const PROJECT_AUDIT_STATES = ['NOT_AUDITED', 'AUDITING', 'BLOCKED', 'NEEDS_REVIEW', 'VERIFIED', 'VERIFIED_WITH_WAIVERS', 'STALE'] as const
export type ProjectAuditState = (typeof PROJECT_AUDIT_STATES)[number]

/** Derived, never stored as truth: computeGate() recomputes it from results, findings, waivers and the current fingerprint. */
export interface GateState {
  projectId: string
  environmentId: string | null
  state: ProjectAuditState
  /** One line per reason the state is not VERIFIED; shown in the panel instead of a percentage. */
  reasons: string[]
  runId: string | null
  fingerprint: TargetFingerprint | null
  /** Controls whose results a later change invalidated (STALE lists them; a change run re-tests them). */
  staleControls: ControlId[]
  openCriticalOrHigh: number
  unverifiedControls: ControlId[]
  humanReviewPending: number
  openQuestions: number
  activeWaivers: number
  results: Array<{ controlId: ControlId; status: ControlResultStatus }>
  computedAt: string
}

// ---------------------------------------------------------------------------------------------
// Check extension contract (what each control module implements)
// ---------------------------------------------------------------------------------------------

export const CHECK_REQUIREMENTS = [
  'browser', 'source-tree', 'sandbox-writes', 'captured-mail', 'commerce-sandbox', 'storage-config', 'test-account', 'axe',
] as const
export type CheckRequirement = (typeof CHECK_REQUIREMENTS)[number]

export interface CheckOutcome {
  checkId: string
  status: ControlResultStatus
  reason: string | null
  findings: FindingDraft[]
  evidence: string[]
  humanReview: HumanReviewItem[]
  coverage: RouteCoverage
  /** Free-form observations the interpretation step may summarise (already redacted). */
  observations: string[]
}

/** Placeholders every mutating check must use; real customer data is never typed into a form. */
export interface SyntheticValue {
  kind: 'email' | 'name' | 'password' | 'card' | 'message' | 'address' | 'phone' | 'marker'
  value: string
  /** Unique marker embedded in the value so leaks (replay, logs, analytics) can be searched for. */
  marker: string
}

export interface NavigationResult {
  requestedUrl: string
  finalUrl: string
  status: number | null
  /** `off-allowlist` when a redirect left the allowed origins and navigation was stopped there. */
  outcome: 'ok' | 'error' | 'timeout' | 'off-allowlist' | 'blocked-by-policy'
  durationMs: number
}

export interface ObservedRequest {
  url: string
  method: string
  resourceType: string
  /** `first-party` for an allowed origin, `third-party` otherwise. */
  party: 'first-party' | 'third-party'
  initiator: 'navigation' | 'page' | 'agent'
  /** Set when the network policy stopped it: reason text. */
  blocked: string | null
  status: number | null
  /** Bounded, redacted body/query excerpt used by leak searches. */
  excerpt: string
  at: string
}

export interface CookieRecord { name: string; domain: string; path: string; expires: number | null; secure: boolean; httpOnly: boolean; sameSite: string | null; party: 'first-party' | 'third-party' }
export interface StorageRecord { area: 'localStorage' | 'sessionStorage' | 'indexedDB'; origin: string; key: string; bytes: number }

export interface DomForm {
  selector: string
  action: string | null
  method: string
  fields: Array<{ name: string; type: string; label: string | null; required: boolean; defaultChecked: boolean | null; autocomplete: string | null }>
}

export interface DomSnapshot {
  url: string
  title: string
  lang: string | null
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; href: string }>
  forms: DomForm[]
  /** Text content, whitespace-normalised and bounded. */
  text: string
  /** Serialized accessibility tree (bounded) for name/role checks. */
  accessibilityTree: string
  images: Array<{ src: string; alt: string | null; decorative: boolean }>
  scripts: string[]
}

export interface AxeResult {
  violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string; html: string }> }>
  incomplete: Array<{ id: string; help: string; count: number }>
  passes: number
  engine: string
}

export interface ConsentAction {
  action: 'reject' | 'accept' | 'select' | 'withdraw'
  /** Categories to keep for `select`. */
  categories?: string[]
}

export interface OpenPageOptions {
  device: DeviceClass
  locale: string | null
  auth: TestAccountRef | null
  /** Consent state to reach before the check reads anything; `clean` opens a fresh profile with nothing stored. */
  consent: ConsentState
  regionSelection: RegionSelection
}

/**
 * The audit browser (src/main/production/browser.ts, Playwright over a system or bundled Chromium). Every
 * page comes from a fresh browser context; the network policy is attached in code before the first
 * navigation. `submit` and any click that would mutate refuse without a matching write authorization.
 */
export interface AuditPage {
  goto(url: string, options?: { waitMs?: number }): Promise<NavigationResult>
  reload(): Promise<NavigationResult>
  snapshot(): Promise<DomSnapshot>
  requests(): ObservedRequest[]
  cookies(): Promise<CookieRecord[]>
  storage(): Promise<StorageRecord[]>
  screenshot(description: string): Promise<EvidenceRef>
  evaluate<T>(expression: string): Promise<T>
  consent(action: ConsentAction): Promise<{ applied: boolean; mechanism: string | null }>
  fill(selector: string, value: SyntheticValue): Promise<void>
  click(selector: string, options?: { mutation?: MutationKind }): Promise<void>
  submit(formSelector: string, mutation: MutationKind): Promise<NavigationResult>
  keyboard(keys: string[]): Promise<Array<{ key: string; focusedSelector: string | null; focusVisible: boolean }>>
  setViewport(width: number, height: number, zoomPercent?: number): Promise<void>
  waitFor(ms: number): Promise<void>
  axe(): Promise<AxeResult>
  close(): Promise<void>
}

export interface BrowserAvailability {
  available: boolean
  /** Which executable will be used: bundled Playwright Chromium, system Edge or Chrome. */
  engine: 'playwright-chromium' | 'msedge' | 'chrome' | null
  reason: string | null
}

export interface AuditBrowser {
  availability(): Promise<BrowserAvailability>
  open(options: OpenPageOptions): Promise<AuditPage>
  close(): Promise<void>
}

/** Network policy the runner derives from the environment and attaches to every page; enforced in browser.ts. */
export interface NetworkPolicy {
  environmentId: string
  environmentKind: EnvironmentKind
  allowedOrigins: string[]
  /** GET and HEAD only on production; mutations elsewhere need an authorization listing the kind. */
  readOnly: boolean
  writeAuthorization: SandboxWriteAuthorization | null
  maxRequests: number
  requestsPerSecondPerOrigin: number
  /** Private and loopback addresses are refused unless the environment kind is `local`. */
  allowPrivateAddresses: boolean
}

export interface CapturedMessage {
  id: string
  from: string
  to: string[]
  subject: string
  receivedAt: string
  text: string
  html: string | null
  headers: Record<string, string>
}

export interface CapturedMailAdapter {
  list(since: string | null): Promise<CapturedMessage[]>
}

export interface CommerceOrder { id: string; total: string; currency: string; lines: Array<{ label: string; amount: string }>; fees: Array<{ label: string; amount: string }>; status: string }
export interface CommerceSubscription { id: string; status: string; nextPaymentAt: string | null; amount: string; interval: string; cancelledAt: string | null }

/** Sandbox-only commerce reads plus the two mutations that need authorization; a live refund is never issued. */
export interface CommerceSandboxAdapter {
  orders(since: string | null): Promise<CommerceOrder[]>
  subscriptions(accountRef: TestAccountRef): Promise<CommerceSubscription[]>
  cancelSubscription(id: string): Promise<CommerceSubscription>
  requestRefund(orderId: string, reason: string): Promise<{ accepted: boolean; detail: string }>
}

export interface StorageObject { key: string; bytes: number; public: boolean; lastModified: string | null }
export interface StorageAdapter {
  inventory(prefix: string | null, limit: number): Promise<StorageObject[]>
  /** Anonymous GET/HEAD from outside the tenant; returns the status only, never the content. */
  probeAnonymous(key: string): Promise<{ status: number; listing: boolean }>
}

export interface Adapters {
  mail: CapturedMailAdapter | null
  commerce: CommerceSandboxAdapter | null
  storage: StorageAdapter | null
}

/** Bounded, redacted model call. Output is JSON validated against `schema`; anything else is dropped as a refusal. */
export interface InterpretationRequest {
  role: ModelRole
  controlId: ControlId | null
  purpose: string
  system: string
  user: string
  /** JSON schema (draft-07 subset) the answer must satisfy. */
  schema: Record<string, unknown>
  maxTokens: number
}

export interface InterpretationResult {
  ok: boolean
  json: unknown
  record: ModelCallRecord
  /** Why the call was not made or its answer rejected. */
  refused: string | null
}

export interface Interpreter {
  ask(request: InterpretationRequest, signal: AbortSignal): Promise<InterpretationResult>
}

export interface EvidenceSink {
  writeText(kind: EvidenceKind, description: string, text: string, ext?: string): Promise<EvidenceRef>
  writeJson(kind: EvidenceKind, description: string, value: unknown): Promise<EvidenceRef>
  writeBinary(kind: EvidenceKind, description: string, bytes: Uint8Array, ext: string): Promise<EvidenceRef>
}

export interface SourceTree {
  /** Project root; reads are bounded and refuse paths outside it. */
  root: string
  read(relativePath: string, maxBytes?: number): Promise<string | null>
  list(glob: string, limit?: number): Promise<string[]>
  exists(relativePath: string): Promise<boolean>
}

export interface CheckContext {
  run: Pick<AuditRun, 'id' | 'projectId' | 'kind' | 'environmentId' | 'fingerprint' | 'budget'>
  profile: ProductionProfile
  environment: ProductionEnvironment
  control: ControlDefinition
  policy: NetworkPolicy
  browser: AuditBrowser
  source: SourceTree
  adapters: Adapters
  evidence: EvidenceSink
  interpreter: Interpreter
  synthetic(kind: SyntheticValue['kind']): SyntheticValue
  /** Journals an intended mutation before it happens and settles it afterwards; refused without authorization. */
  operation<T>(mutation: MutationKind, target: string, act: () => Promise<T>): Promise<T>
  routes(filter?: { tags?: string[] }): RouteEntry[]
  url(path: string): string
  log(line: string): void
  signal: AbortSignal
  now(): string
}

export interface ControlCheck {
  controlId: ControlId
  checkId: string
  title: string
  requires: CheckRequirement[]
  run(context: CheckContext): Promise<CheckOutcome>
}

// ---------------------------------------------------------------------------------------------
// Renderer bridge and control-method inputs
// ---------------------------------------------------------------------------------------------

export interface ProductionRunSummary {
  id: string
  kind: RunKind
  environmentId: string
  status: RunStatus
  statusReason: string | null
  trigger: AuditTrigger
  fingerprint: TargetFingerprint
  progress: { done: number; total: number; currentStep: string | null }
  ledger: BudgetLedger
  createdAt: string
  finishedAt: string | null
  reportPaths: { markdown: string; json: string } | null
}

export interface ProductionProjectSnapshot {
  projectId: string
  profile: ProductionProfile | null
  gate: GateState
  activeRun: ProductionRunSummary | null
  runs: ProductionRunSummary[]
  findings: Finding[]
  waivers: Waiver[]
  results: ControlResult[]
  registryVersion: number
  browser: BrowserAvailability | null
}

export interface ProductionQueueEntry {
  projectId: string
  projectName: string
  designation: ProductionDesignation
  gate: GateState
  activeRun: ProductionRunSummary | null
  openFindings: { critical: number; high: number; other: number }
  openQuestions: number
  lastCompletedAt: string | null
}

export interface ProfileUpdate {
  facts?: Partial<{ [K in FactKey]: ProfileFacts[K]['value'] }>
  environments?: ProductionEnvironment[]
  scope?: Partial<AuditScope>
  budget?: Partial<AuditBudget>
  drift?: Partial<DriftSettings>
}

export interface AuditRequest {
  environmentId?: string
  /** Subset of controls; default all applicable. */
  controls?: ControlId[]
  /** `full` ignores the change-class subset and re-tests everything. */
  full?: boolean
}

export interface WaiverRequest {
  findingId: string
  reason: string
  scope: string
  owner: string
  expiresAt: string
}

export interface WriteAuthorizationRequest {
  environmentId: string
  mutations: MutationKind[]
  expiresAt: string
  note: string
}

export interface ProductionBridge {
  snapshot(projectId: string): Promise<ProductionProjectSnapshot>
  queue(): Promise<ProductionQueueEntry[]>
  registry(): Promise<ControlRegistry>
  designate(projectId: string, designation: { productionReady: boolean; environmentId: string | null; note: string }): Promise<ProductionProfile>
  updateProfile(projectId: string, update: ProfileUpdate): Promise<ProductionProfile>
  answerQuestion(projectId: string, questionId: string, answer: string): Promise<ProductionProfile>
  dismissQuestion(projectId: string, questionId: string, reason: string): Promise<ProductionProfile>
  audit(projectId: string, request: AuditRequest): Promise<ProductionRunSummary>
  retest(projectId: string, findingIds: string[]): Promise<ProductionRunSummary>
  verify(projectId: string, findingIds: string[]): Promise<ProductionRunSummary>
  pause(projectId: string, runId: string): Promise<void>
  resume(projectId: string, runId: string): Promise<void>
  cancel(projectId: string, runId: string, reason: string): Promise<void>
  run(projectId: string, runId: string): Promise<AuditRun>
  createFixTasks(projectId: string, findingIds: string[]): Promise<Array<{ findingId: string; taskId: string; created: boolean }>>
  waive(projectId: string, request: WaiverRequest): Promise<Waiver>
  revokeWaiver(projectId: string, waiverId: string, reason: string): Promise<Waiver>
  authorizeWrites(projectId: string, request: WriteAuthorizationRequest): Promise<SandboxWriteAuthorization>
  revokeWrites(projectId: string, authorizationId: string): Promise<void>
  openEvidence(projectId: string, runId: string, evidenceId: string): Promise<void>
  openReport(projectId: string, runId: string): Promise<void>
  onChanged(callback: (projectId: string) => void): () => void
}

export const PRODUCTION_IPC = {
  snapshot: 'production:snapshot',
  queue: 'production:queue',
  registry: 'production:registry',
  designate: 'production:designate',
  updateProfile: 'production:update-profile',
  answerQuestion: 'production:answer-question',
  dismissQuestion: 'production:dismiss-question',
  audit: 'production:audit',
  retest: 'production:retest',
  verify: 'production:verify',
  pause: 'production:pause',
  resume: 'production:resume',
  cancel: 'production:cancel',
  run: 'production:run',
  createFixTasks: 'production:create-fix-tasks',
  waive: 'production:waive',
  revokeWaiver: 'production:revoke-waiver',
  authorizeWrites: 'production:authorize-writes',
  revokeWrites: 'production:revoke-writes',
  openEvidence: 'production:open-evidence',
  openReport: 'production:open-report',
  changed: 'production:changed',
} as const

/** Control-method names (registered in src/main/production/control.ts, classified in control-method-classes.ts). */
export const PRODUCTION_CONTROL_METHODS = [
  'production.status', 'production.queue', 'production.registry', 'production.runs', 'production.run',
  'production.findings', 'production.report', 'production.evidence', 'production.profile.get',
  'production.profile.update', 'production.designate', 'production.answer', 'production.audit',
  'production.retest', 'production.verify', 'production.pause', 'production.resume', 'production.cancel',
  'production.tasks.create', 'production.waive', 'production.waivers.revoke', 'production.writes.authorize',
  'production.writes.revoke', 'production.drift',
] as const
export type ProductionControlMethod = (typeof PRODUCTION_CONTROL_METHODS)[number]

/** Methods that need the owner credential or a wizard tab; a coworker or local model is refused with the route. */
export const PRODUCTION_SOVEREIGN_METHODS: readonly ProductionControlMethod[] = [
  'production.designate', 'production.answer', 'production.waive', 'production.waivers.revoke',
  'production.writes.authorize', 'production.writes.revoke', 'production.drift',
]

/** Read methods a local model may call; it can never start, waive or authorize anything. */
export const PRODUCTION_LOCAL_METHODS: readonly ProductionControlMethod[] = [
  'production.status', 'production.findings', 'production.registry',
]

// ---------------------------------------------------------------------------------------------
// Persistence and limits
// ---------------------------------------------------------------------------------------------

/** Table names in conductor.db (src/main/production/store.ts owns the schema and migration). */
export const PRODUCTION_TABLES = {
  profiles: 'production_profiles',
  runs: 'production_runs',
  steps: 'production_run_steps',
  operations: 'production_run_operations',
  results: 'production_control_results',
  findings: 'production_findings',
  waivers: 'production_waivers',
  modelCalls: 'production_model_calls',
  events: 'production_run_events',
} as const

export const PRODUCTION_ARTIFACTS_DIR = 'production-audits'
/** Newest completed runs kept per project and environment; older evidence directories are removed. */
export const PRODUCTION_RUN_RETENTION = 30
export const PRODUCTION_SCHEDULE_KIND = 'production-drift'
export const DEFAULT_DRIFT_MINUTES = 24 * 60
export const MAX_EVIDENCE_TEXT_BYTES = 512 * 1024
export const MAX_INTERPRETATION_USER_CHARS = 24_000
/** One audit browser at a time on this machine (docs/machine-profile.md). */
export const MAX_CONCURRENT_RUNS = 1
