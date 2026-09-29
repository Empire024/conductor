import {
  AUDIENCES, AUTH_STATES, BUSINESS_MODELS, CONSENT_STATES, CONTROL_IDS, DEFAULT_AUDIT_BUDGET, DEFAULT_DRIFT_MINUTES, DEVICE_CLASSES,
  ENVIRONMENT_KINDS, MUTATION_KINDS, MUTATION_POLICIES, REGION_SELECTIONS,
  type AuditBudget, type AuditScope, type ControlId, type ControlRegistry, type DriftSettings, type FactKey, type OwnerQuestion,
  type ProductionDesignation, type ProductionEnvironment, type ProductionProfile, type ProfileFact, type ProfileFacts, type ProfileUpdate,
  type LoginStateRefresh, type SandboxWriteAuthorization, type StoredLoginStateRef, type WriteAuthorizationRequest
} from '../../shared/production'
import { isAbsolute } from 'node:path'
import { makeId } from '../../shared/models'
import { factIsUnknown, REGISTRY } from './registry'

/**
 * The per-project production profile (docs/production-agent.md section 3): defaults, the fact
 * merge (owner beats wizard beats discovery beats assumption), owner questions for unknown facts, and the pure
 * profile mutations the store versions. Every function here returns a new profile and never
 * changes its input; the store assigns the version, so every mutation is a version bump.
 */

export const FACT_KEYS: readonly FactKey[] = [
  'legalEntity', 'targetCountries', 'businessModel', 'products', 'accountFeatures', 'subscriptions', 'userUploads',
  'aiRuntime', 'analytics', 'sessionReplay', 'emailMarketing', 'marketingSender', 'transactionalSender', 'dataCategories', 'audience', 'ageRestrictedProducts',
  'paymentProviders', 'processors', 'safeHarborReliance',
]

type FactType = 'text' | 'email' | 'list' | 'boolean' | { oneOf: readonly string[] }
/** Facts a profile stored before they existed may lack; no control's applicability requires them. */
export const OPTIONAL_FACT_KEYS: readonly FactKey[] = ['marketingSender', 'transactionalSender']
export const FACT_TYPES: Readonly<Record<FactKey, FactType>> = {
  legalEntity: 'text', targetCountries: 'list', businessModel: { oneOf: BUSINESS_MODELS }, products: 'list',
  accountFeatures: 'boolean', subscriptions: 'boolean', userUploads: 'boolean', aiRuntime: 'boolean', analytics: 'boolean',
  sessionReplay: 'boolean', emailMarketing: 'boolean', marketingSender: 'email', transactionalSender: 'email', dataCategories: 'list', audience: { oneOf: AUDIENCES },
  ageRestrictedProducts: 'boolean', paymentProviders: 'list', processors: 'list', safeHarborReliance: 'boolean',
}

/** The question Conductor asks for each fact; only the owner answers these, the agent never fills them. */
export const FACT_QUESTIONS: Readonly<Record<FactKey, { question: string; why: string }>> = {
  legalEntity: { question: 'What is the legal entity (name, registered address, registration number) that must appear on the site?', why: 'Policies, identity pages, checkout and receipts are compared with it; Conductor never invents one.' },
  targetCountries: { question: 'Which countries does the project sell to or target? (ISO codes, for example SK, CZ, EU, US, US-CA)', why: 'Decides which jurisdictions\' rules apply; a rule is never applied because another project operates somewhere.' },
  businessModel: { question: 'Does the project sell to businesses, consumers, or both? (b2b, b2c, both)', why: 'Consumer pricing, withdrawal and review rules apply only to consumer sales.' },
  products: { question: 'What does the project offer? (for example physical goods, digital content, services)', why: 'Pricing, refund and withdrawal rules depend on the kind of product.' },
  accountFeatures: { question: 'Can customers create accounts? (yes/no)', why: 'Decides whether authenticated journeys and account deletion are tested.' },
  subscriptions: { question: 'Does the project sell subscriptions or anything that renews automatically? (yes/no)', why: 'Renewal disclosure and cancellation checks apply only to recurring billing.' },
  userUploads: { question: 'Can users upload or publish content (reviews with images, files, posts)? (yes/no)', why: 'Copyright notice-and-takedown checks apply only to hosted user content.' },
  aiRuntime: { question: 'Does the site offer AI features to customers at runtime (chat, generated content)? (yes/no)', why: 'AI interaction and content disclosures apply to runtime AI, not to AI used to write the code.' },
  analytics: { question: 'Are analytics, advertising pixels or other tracking intended on the site? (yes/no)', why: 'Decides whether consent is required before tracking or the site must be essential-only.' },
  sessionReplay: { question: 'Is session replay or input recording (for example Hotjar, Clarity, FullStory) intended? (yes/no)', why: 'Replay masking is tested with synthetic markers; undeclared replay is a finding.' },
  emailMarketing: { question: 'Does the project send marketing email (newsletters, promotions)? (yes/no)', why: 'Marketing email rules (identity, opt-out, suppression) apply only to commercial messages.' },
  marketingSender: { question: 'Which address must marketing email come from?', why: 'A captured campaign from another address is flagged.' },
  transactionalSender: { question: 'Which address must transactional email (orders, accounts) come from?', why: 'A captured order or account email from another address is flagged.' },
  dataCategories: { question: 'Which categories of personal data does the project collect? (for example contact, address, payment, health, none)', why: 'Forms and data-rights checks compare what is collected with what is needed and declared.' },
  audience: { question: 'Who is the intended audience? (general, child-directed, mixed, adult-only)', why: 'Child-data and age-restriction rules depend on it.' },
  ageRestrictedProducts: { question: 'Does the project sell age-restricted products (alcohol, tobacco, CBD, adult content)? (yes/no)', why: 'Age-restricted sales need a jurisdiction-specific eligibility review.' },
  paymentProviders: { question: 'Which payment providers does checkout use?', why: 'Pricing and refund checks use the project\'s actual providers, not an assumed one.' },
  processors: { question: 'Which processors receive personal data (hosting, email, payments, analytics, support)?', why: 'Observed third-party requests are reconciled with the approved vendors.' },
  safeHarborReliance: { question: 'Does the project rely on a DMCA-style hosting safe harbor for user content? (yes/no)', why: 'Decides whether a designated agent listing and its renewal are checked.' },
}

const PRECEDENCE: Record<NonNullable<ProfileFact<unknown>['source']>, number> = { owner: 4, wizard: 3, discovery: 2, assumption: 1 }

export const unknownFact = <T>(): ProfileFact<T> => ({ value: null, status: 'unknown', source: null, at: null })
export const ownerFact = <T>(value: T, at: string, note?: string): ProfileFact<T> => ({ value, status: 'evidenced', source: 'owner', at, ...(note ? { note } : {}) })
/** A fact a wizard tab set: evidenced (owner authority, repo-proven) but never the owner's own word. */
export const wizardFact = <T>(value: T, at: string, by: string, note?: string): ProfileFact<T> => ({ value, status: 'evidenced', source: 'wizard', at, by, ...(note ? { note } : {}) })
export const discoveredFact = <T>(value: T, at: string, note: string): ProfileFact<T> => ({ value, status: 'evidenced', source: 'discovery', at, note })
export const assumedFact = <T>(value: T, at: string, note: string): ProfileFact<T> => ({ value, status: 'assumed', source: 'assumption', at, note })

export function emptyFacts(): ProfileFacts {
  return Object.fromEntries(FACT_KEYS.map(key => [key, unknownFact()])) as unknown as ProfileFacts
}

export function defaultScope(): AuditScope {
  return { routes: [], journeys: [], devices: [...DEVICE_CLASSES], locales: [], regionSelection: 'none', authStates: ['guest'], consentStates: [...CONSENT_STATES], disabledControls: [] }
}

export const defaultDrift = (): DriftSettings => ({ enabled: false, everyMinutes: DEFAULT_DRIFT_MINUTES, onChange: 'mark-stale' })
const defaultDesignation = (): ProductionDesignation => ({ productionReady: false, by: null, at: null, note: '', environmentId: null })

/**
 * A fresh profile: every fact unknown (each becomes an owner question), not designated, drift off
 * (nothing recurring is enabled silently), the default audit budget. Version 1 is what the store
 * writes when a project's profile is first created.
 */
export function defaultProfile(projectId: string, now: Date = new Date(), registry: ControlRegistry = REGISTRY): ProductionProfile {
  const at = now.toISOString()
  const profile: ProductionProfile = {
    projectId, version: 1, updatedAt: at, updatedBy: 'conductor',
    designation: defaultDesignation(), facts: emptyFacts(), environments: [], writeAuthorizations: [],
    scope: defaultScope(), stack: null, budget: { ...DEFAULT_AUDIT_BUDGET }, drift: defaultDrift(), questions: []
  }
  return { ...profile, questions: questionsFor(profile, registry, now) }
}

/**
 * Merges incoming facts over the current ones. A fact from a lower-precedence source never
 * replaces one from a higher source (owner > wizard > discovery > assumption); the same source
 * replaces its own earlier value. An owner or wizard fact is always `evidenced`, an assumption
 * always `assumed`. A null
 * or unknown incoming value is ignored: nothing becomes unknown again by merging. An owner or wizard
 * re-recording the same value rewrites the source, `by`, time and note (a wizard re-recording an
 * owner-sourced value marks it as the wizard's); an assumption or discovery never demotes a higher fact.
 */
export function mergeFacts(current: ProfileFacts, incoming: Partial<Record<FactKey, ProfileFact<unknown>>>): ProfileFacts {
  const next = { ...current } as Record<FactKey, ProfileFact<unknown>>
  for (const [key, fact] of Object.entries(incoming) as Array<[FactKey, ProfileFact<unknown> | undefined]>) {
    if (!FACT_KEYS.includes(key)) throw new Error(`Unknown profile fact: ${key}`)
    if (!fact || fact.source === null || fact.value === null || fact.value === undefined || fact.status === 'unknown') continue
    const existing = next[key]
    const value = normaliseFactValue(key, fact.value)
    const restated = (fact.source === 'owner' || fact.source === 'wizard') && !factIsUnknown(existing) && JSON.stringify(existing.value) === JSON.stringify(value)
    if (!restated && !factIsUnknown(existing) && existing.source && PRECEDENCE[existing.source] > PRECEDENCE[fact.source]) continue
    const status = fact.source === 'assumption' ? 'assumed' : 'evidenced'
    next[key] = { ...fact, value, status }
  }
  return next as unknown as ProfileFacts
}

/** Validates and normalises a fact value for its key; throws with the expected shape. */
export function normaliseFactValue(key: FactKey, value: unknown): unknown {
  const type = FACT_TYPES[key]
  if (type === 'text') {
    if (typeof value !== 'string' || !value.trim() || value.length > 2_000) throw new Error(`${key} must be non-empty text of up to 2,000 characters`)
    return value.trim()
  }
  if (type === 'email') {
    const address = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (address.length > 254 || !/^[^\s@<>",;]+@[^\s@<>",;]+\.[a-z0-9-]{2,}$/.test(address)) throw new Error(`${key} must be one email address, for example shop@example.com`)
    return address
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`)
    return value
  }
  if (type === 'list') {
    if (!Array.isArray(value) || value.length > 200 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) throw new Error(`${key} must be a list of up to 200 short texts`)
    const items = value.map(item => String(item).trim())
    return [...new Set(key === 'targetCountries' ? items.map(item => item.toUpperCase()) : items)]
  }
  if (typeof value !== 'string' || !type.oneOf.includes(value)) throw new Error(`${key} must be one of ${type.oneOf.join(', ')}`)
  return value
}

/** Parses a free-text owner answer (panel or control method) into the fact's value. */
export function parseFactAnswer(key: FactKey, answer: string): unknown {
  const text = answer.trim()
  if (!text) throw new Error(`The answer for ${key} is empty`)
  const type = FACT_TYPES[key]
  if (type === 'boolean') {
    if (/^(yes|y|true|ano|áno|1)$/i.test(text)) return true
    if (/^(no|n|false|nie|ne|0)$/i.test(text)) return false
    throw new Error(`Answer ${key} with yes or no`)
  }
  if (type === 'list') {
    if (/^(none|no|nothing|-)$/i.test(text)) return []
    return normaliseFactValue(key, text.split(/[,;\n]/).map(item => item.trim()).filter(Boolean))
  }
  if (type === 'text' || type === 'email') return normaliseFactValue(key, text)
  return normaliseFactValue(key, text.toLowerCase())
}

/** Which controls need a fact before their applicability can be decided (disabled controls excluded). */
export function controlsBlockedBy(fact: FactKey, registry: ControlRegistry, scope: Pick<AuditScope, 'disabledControls'>): ControlId[] {
  const disabled = new Set(scope.disabledControls.map(entry => entry.controlId))
  return registry.controls.filter(definition => !disabled.has(definition.id) && definition.applicability.requiredFacts.includes(fact)).map(definition => definition.id)
}

export const questionId = (fact: FactKey): string => `pq_${fact}`

/**
 * The owner questions for a profile: one per unknown fact that some enabled control requires, each
 * naming the controls it blocks, with a stable id per fact so an answer, a dismissal and history
 * survive recomputation. An existing question keeps its id, text, status and answer (a dismissed
 * question is not reopened); an open question whose fact became known by other means is dropped;
 * answered and dismissed questions are kept as history.
 */
export function questionsFor(profile: Pick<ProductionProfile, 'facts' | 'scope' | 'questions'>, registry: ControlRegistry = REGISTRY, now: Date = new Date()): OwnerQuestion[] {
  const at = now.toISOString()
  const byFact = new Map(profile.questions.map(question => [question.factKey, question]))
  const needed = new Map<FactKey, ControlId[]>()
  for (const fact of FACT_KEYS) {
    if (!factIsUnknown(profile.facts[fact])) continue
    const blocks = controlsBlockedBy(fact, registry, profile.scope)
    if (blocks.length) needed.set(fact, blocks)
  }
  const out: OwnerQuestion[] = []
  for (const fact of FACT_KEYS) {
    const existing = byFact.get(fact)
    const blocks = needed.get(fact)
    if (blocks) {
      out.push(existing
        ? { ...existing, blocksControls: existing.status === 'open' ? blocks : existing.blocksControls }
        : { id: questionId(fact), factKey: fact, ...FACT_QUESTIONS[fact], blocksControls: blocks, status: 'open', answer: null, answeredAt: null, answeredBy: null, createdAt: at })
    } else if (existing && existing.status !== 'open') out.push(existing)
    else if (existing && profile.facts[fact]?.source === 'wizard') {
      // A wizard may close an owner question, but the history says a wizard set it, not the owner.
      const set = profile.facts[fact]
      out.push({ ...existing, status: 'answered', answer: formatFactValue(set.value).slice(0, 2_000), answeredAt: set.at ?? at, answeredBy: set.by ?? 'wizard' })
    }
  }
  return out
}

export const openQuestions = (profile: Pick<ProductionProfile, 'questions'>): OwnerQuestion[] => profile.questions.filter(question => question.status === 'open')

// ---- pure mutations (the store versions the result) -------------------------------------------

const refresh = (profile: ProductionProfile, registry: ControlRegistry, now: Date): ProductionProfile => ({ ...profile, questions: questionsFor(profile, registry, now) })

/** A fact value as one line of text (report, question history). */
export const formatFactValue = (value: unknown): string => Array.isArray(value) ? (value.length ? value.join(', ') : 'none') : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value ?? '')

/**
 * Answers an owner question: the fact is written with source `owner` (evidenced), or `wizard` when a
 * wizard tab answers, so a wizard's answer never reads as the owner's own evidence.
 */
export function answerQuestion(profile: ProductionProfile, questionIdValue: string, answer: string, by: string, now: Date = new Date(), registry: ControlRegistry = REGISTRY, source: 'owner' | 'wizard' = 'owner'): ProductionProfile {
  const question = profile.questions.find(candidate => candidate.id === questionIdValue)
  if (!question) throw new Error(`No owner question ${questionIdValue} in this project's production profile; list them with production.profile.get`)
  const value = parseFactAnswer(question.factKey, answer)
  const at = now.toISOString()
  const fact = source === 'wizard' ? wizardFact(value, at, by, `Answered by ${by}`) : ownerFact(value, at, `Answered by ${by}`)
  const facts = mergeFacts(profile.facts, { [question.factKey]: fact })
  const questions = profile.questions.map(candidate => candidate.id === question.id ? { ...candidate, status: 'answered' as const, answer: answer.trim().slice(0, 2_000), answeredAt: at, answeredBy: by } : candidate)
  return refresh({ ...profile, facts, questions }, registry, now)
}

/** Dismisses a question: its fact stays unknown and the controls it blocks stay UNVERIFIED. */
export function dismissQuestion(profile: ProductionProfile, questionIdValue: string, reason: string, by: string, now: Date = new Date()): ProductionProfile {
  const question = profile.questions.find(candidate => candidate.id === questionIdValue)
  if (!question) throw new Error(`No owner question ${questionIdValue} in this project's production profile`)
  if (!reason.trim()) throw new Error('Dismissing a question needs a reason')
  const at = now.toISOString()
  return { ...profile, questions: profile.questions.map(candidate => candidate.id === question.id ? { ...candidate, status: 'dismissed' as const, answer: `Dismissed: ${reason.trim().slice(0, 2_000)}`, answeredAt: at, answeredBy: by } : candidate) }
}

export function originOf(url: string): string {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`Not a URL: ${url}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Only http and https origins can be audited: ${url}`)
  return parsed.origin
}

/** Validates one environment and normalises its origins (baseUrl's origin is always allowed). */
export function validateEnvironment(environment: ProductionEnvironment): ProductionEnvironment {
  if (!environment || typeof environment !== 'object') throw new Error('An environment must be an object')
  if (typeof environment.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(environment.id)) throw new Error('An environment id is 1-64 letters, digits, dots, dashes or underscores')
  if (!ENVIRONMENT_KINDS.includes(environment.kind)) throw new Error(`Environment ${environment.id}: kind must be one of ${ENVIRONMENT_KINDS.join(', ')}`)
  if (typeof environment.label !== 'string' || !environment.label.trim()) throw new Error(`Environment ${environment.id} needs a label`)
  const base = originOf(environment.baseUrl)
  const origins = [...new Set([base, ...(environment.allowedOrigins ?? []).map(originOf)])]
  const accounts = (environment.accounts ?? []).map(account => {
    if (environment.kind === 'production' && account.role !== 'guest') throw new Error(`Environment ${environment.id} is production: test accounts belong to staging, sandbox or local environments`)
    const gateOnly = account.role === 'guest' && !!account.storageState
    for (const ref of [account.usernameRef ?? null, account.passwordRef ?? null]) {
      if (ref === null && gateOnly) continue
      if (!ref || !['env', 'secret-file'].includes(ref.source) || !ref.key) throw new Error(`Account ${account.id}: credentials are references (env or secret-file with a key), never values; only a guest account with a storageState may leave them null`)
    }
    return { ...account, usernameRef: account.usernameRef ?? null, passwordRef: account.passwordRef ?? null, ...(account.storageState ? { storageState: validateLoginState(account.storageState, account.id) } : {}) }
  })
  if (environment.mutationPolicy !== undefined && environment.mutationPolicy !== null && !MUTATION_POLICIES.includes(environment.mutationPolicy)) throw new Error(`Environment ${environment.id}: mutationPolicy must be one of ${MUTATION_POLICIES.join(', ')} (or null)`)
  return { ...environment, label: environment.label.trim(), baseUrl: environment.baseUrl, allowedOrigins: origins, accounts, capturedMail: environment.capturedMail ?? null, commerce: environment.commerce ?? null, storage: environment.storage ?? null, buildInfoCommand: environment.buildInfoCommand ?? null, smokeCommand: environment.smokeCommand ?? null, mutationPolicy: environment.mutationPolicy ?? null }
}

export const MAX_REFRESH_TIMEOUT_MS = 600_000

function validateLoginState(state: StoredLoginStateRef, accountId: string): StoredLoginStateRef {
  if (typeof state.path !== 'string' || !isAbsolute(state.path)) throw new Error(`Account ${accountId}: storageState.path must be an absolute path to a Playwright storage-state file`)
  const refresh = state.refresh
  if (refresh === undefined || refresh === null) return state
  if (typeof refresh.command !== 'string' || !refresh.command.trim() || refresh.command.length > 2_000) throw new Error(`Account ${accountId}: storageState.refresh.command must be a command line of up to 2,000 characters`)
  if (typeof refresh.cwd !== 'string' || !isAbsolute(refresh.cwd)) throw new Error(`Account ${accountId}: storageState.refresh.cwd must be an absolute directory (the owner's repository)`)
  if (typeof refresh.maxAgeHours !== 'number' || !(refresh.maxAgeHours > 0) || refresh.maxAgeHours > 24 * 90) throw new Error(`Account ${accountId}: storageState.refresh.maxAgeHours must be a number of hours from above 0 to 2,160`)
  if (refresh.timeoutMs !== undefined && (!Number.isInteger(refresh.timeoutMs) || refresh.timeoutMs < 1_000 || refresh.timeoutMs > MAX_REFRESH_TIMEOUT_MS)) throw new Error(`Account ${accountId}: storageState.refresh.timeoutMs must be 1,000 to ${MAX_REFRESH_TIMEOUT_MS} ms`)
  if (refresh.maskEnv !== undefined && (!Array.isArray(refresh.maskEnv) || refresh.maskEnv.length > 20 || refresh.maskEnv.some(name => typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)))) throw new Error(`Account ${accountId}: storageState.refresh.maskEnv must be a list of environment variable names`)
  return { ...state, refresh: { ...refresh, command: refresh.command.trim() } }
}

const refreshKey = (refresh: LoginStateRefresh | null | undefined): string => refresh ? JSON.stringify({ command: refresh.command, cwd: refresh.cwd, maxAgeHours: refresh.maxAgeHours, timeoutMs: refresh.timeoutMs ?? null, maskEnv: refresh.maskEnv ?? [] }) : ''

/**
 * A login-state refresh runs a command on the host, so only the owner or a wizard tab sets or changes one;
 * Conductor stamps who did. An unchanged refresh keeps its stamp.
 */
function stampRefreshes(before: readonly ProductionEnvironment[], after: ProductionEnvironment[], options: { by: string; source: 'owner' | 'wizard' | 'assumption'; at: string }): ProductionEnvironment[] {
  const prior = new Map<string, LoginStateRefresh>()
  for (const environment of before) for (const account of environment.accounts) if (account.storageState?.refresh) prior.set(`${environment.id}\u0000${account.id}`, account.storageState.refresh)
  return after.map(environment => ({
    ...environment,
    accounts: environment.accounts.map(account => {
      const refresh = account.storageState?.refresh
      if (!refresh) return account
      const old = prior.get(`${environment.id}\u0000${account.id}`)
      if (old && refreshKey(old) === refreshKey(refresh)) return { ...account, storageState: { ...account.storageState!, refresh: { ...refresh, setBy: old.setBy ?? null } } }
      if (options.source === 'assumption') throw new Error(`Account ${account.id}: a login-state refresh runs a command on this machine, so only the owner or a wizard tab may set or change it`)
      return { ...account, storageState: { ...account.storageState!, refresh: { ...refresh, setBy: { source: options.source, by: options.by, at: options.at } } } }
    }),
  }))
}

function validateScope(scope: AuditScope): AuditScope {
  if (scope.devices.some(device => !DEVICE_CLASSES.includes(device)) || !scope.devices.length) throw new Error(`scope.devices must be a non-empty list of ${DEVICE_CLASSES.join(', ')}`)
  if (scope.consentStates.some(state => !CONSENT_STATES.includes(state))) throw new Error(`scope.consentStates accepts ${CONSENT_STATES.join(', ')}`)
  if (scope.authStates.some(state => !AUTH_STATES.includes(state)) || !scope.authStates.length) throw new Error(`scope.authStates must be a non-empty list of ${AUTH_STATES.join(', ')}`)
  if (!REGION_SELECTIONS.includes(scope.regionSelection)) throw new Error(`scope.regionSelection must be one of ${REGION_SELECTIONS.join(', ')}`)
  for (const entry of scope.disabledControls) {
    if (!CONTROL_IDS.includes(entry.controlId)) throw new Error(`scope.disabledControls: unknown control ${entry.controlId}`)
    if (!entry.reason?.trim()) throw new Error(`Disabling ${entry.controlId} needs a reason; it is shown as the NOT_APPLICABLE rationale`)
  }
  if (scope.routes.length > 5_000) throw new Error('scope.routes is limited to 5,000 entries')
  for (const route of scope.routes) if (route.coverage === 'excluded' && !route.excludedReason?.trim()) throw new Error(`Excluded route ${route.path} needs a reason`)
  return scope
}

function validateBudget(budget: AuditBudget): AuditBudget {
  for (const [key, value] of Object.entries(budget)) if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`budget.${key} must be a non-negative number`)
  if (budget.requestsPerSecondPerOrigin <= 0 || budget.requestsPerSecondPerOrigin > 50) throw new Error('budget.requestsPerSecondPerOrigin must be between 0 and 50')
  return budget
}

/**
 * Applies a profile update. Facts in the update are recorded with `source`: `owner` for the owner
 * (panel or the owner's credential), `wizard` for a wizard tab, `assumption` for any other caller,
 * so an agent can never overwrite an owner's answer. A wizard that would change a fact the owner
 * set is refused, naming the facts, rather than silently ignored; the owner may overwrite a wizard
 * fact. Drift and designation are not in this path for non-owners: the control layer gates
 * `production.drift`; this function only validates.
 */
export function applyProfileUpdate(profile: ProductionProfile, update: ProfileUpdate, options: { by: string; source: 'owner' | 'wizard' | 'assumption'; now?: Date; registry?: ControlRegistry }): ProductionProfile {
  const now = options.now ?? new Date(), at = now.toISOString()
  let next: ProductionProfile = { ...profile }
  if (update.facts) {
    const incoming: Partial<Record<FactKey, ProfileFact<unknown>>> = {}
    const ownerHeld: string[] = []
    for (const [key, value] of Object.entries(update.facts)) {
      if (!FACT_KEYS.includes(key as FactKey)) throw new Error(`Unknown profile fact: ${key}`)
      if (value === null || value === undefined) continue
      const normalised = normaliseFactValue(key as FactKey, value)
      const existing = (profile.facts[key as FactKey] ?? unknownFact()) as ProfileFact<unknown>
      if (options.source === 'wizard' && existing.source === 'owner' && !factIsUnknown(existing) && JSON.stringify(existing.value) !== JSON.stringify(normalised)) ownerHeld.push(`${key} (owner: ${formatFactValue(existing.value)})`)
      incoming[key as FactKey] = options.source === 'owner' ? ownerFact(normalised, at, `Set by ${options.by}`)
        : options.source === 'wizard' ? wizardFact(normalised, at, options.by, `Set by ${options.by}`)
          : assumedFact(normalised, at, `Assumed by ${options.by}; the owner confirms or corrects it`)
    }
    if (ownerHeld.length) throw new Error(`The owner set ${ownerHeld.join(', ')}; a wizard does not overwrite the owner's own answer. Leave these facts out of the update, or ask the owner to change them in the Production panel`)
    next.facts = mergeFacts(next.facts, incoming)
  }
  if (update.environments) {
    const environments = stampRefreshes(profile.environments, update.environments.map(validateEnvironment), { by: options.by, source: options.source, at })
    const ids = environments.map(environment => environment.id)
    if (new Set(ids).size !== ids.length) throw new Error('Environment ids must be unique')
    next.environments = environments
    if (next.designation.environmentId && !ids.includes(next.designation.environmentId)) throw new Error(`Environment ${next.designation.environmentId} is designated production-ready; change the designation before removing it`)
  }
  if (update.scope) next.scope = validateScope({ ...next.scope, ...update.scope })
  if (update.budget) next.budget = validateBudget({ ...next.budget, ...update.budget })
  if (update.drift) {
    const drift = { ...next.drift, ...update.drift }
    if (typeof drift.enabled !== 'boolean' || !Number.isInteger(drift.everyMinutes) || drift.everyMinutes < 60 || drift.everyMinutes > 60 * 24 * 31 || !['mark-stale', 'audit'].includes(drift.onChange)) throw new Error('drift needs enabled (boolean), everyMinutes (60 to 44,640) and onChange (mark-stale or audit)')
    next.drift = drift
  }
  next = refresh(next, options.registry ?? REGISTRY, now)
  return next
}

/** The owner's production-ready designation; always names an environment when set. */
export function designate(profile: ProductionProfile, request: { productionReady: boolean; environmentId: string | null; note: string }, by: string, now: Date = new Date()): ProductionProfile {
  if (request.productionReady) {
    if (!request.environmentId) throw new Error('A production-ready designation names the environment it refers to')
    if (!profile.environments.some(environment => environment.id === request.environmentId)) throw new Error(`No environment ${request.environmentId} in the profile; add it with production.profile.update first`)
  }
  return { ...profile, designation: { productionReady: request.productionReady, environmentId: request.productionReady ? request.environmentId : request.environmentId ?? null, note: String(request.note ?? '').slice(0, 2_000), by, at: now.toISOString() } }
}

/**
 * Adds a sandbox write authorization. Refused for a production environment whatever the caller
 * (the store refuses it again on save), for an unknown environment, an expiry that is not in the
 * future, or an empty or unknown mutation list.
 */
export function authorizeWrites(profile: ProductionProfile, request: WriteAuthorizationRequest, grantedBy: SandboxWriteAuthorization['grantedBy'], now: Date = new Date()): { profile: ProductionProfile; authorization: SandboxWriteAuthorization } {
  const environment = profile.environments.find(candidate => candidate.id === request.environmentId)
  if (!environment) throw new Error(`No environment ${request.environmentId} in the profile`)
  if (environment.kind === 'production') throw new Error(`Environment ${environment.id} is production: Conductor never authorizes writes there. Add a staging or sandbox environment and authorize that.`)
  if (!Array.isArray(request.mutations) || !request.mutations.length || request.mutations.some(kind => !MUTATION_KINDS.includes(kind))) throw new Error(`Name at least one mutation kind: ${MUTATION_KINDS.join(', ')}`)
  const expires = Date.parse(request.expiresAt)
  if (!Number.isFinite(expires) || expires <= now.getTime()) throw new Error('A write authorization needs an expiresAt in the future')
  if (grantedBy.kind !== 'owner' && grantedBy.kind !== 'wizard') throw new Error('Only the owner or a wizard tab can authorize writes')
  const authorization: SandboxWriteAuthorization = {
    id: makeId('pwa'), environmentId: environment.id, mutations: [...new Set(request.mutations)], grantedBy,
    grantedAt: now.toISOString(), expiresAt: new Date(expires).toISOString(), note: String(request.note ?? '').slice(0, 2_000)
  }
  return { profile: { ...profile, writeAuthorizations: [...profile.writeAuthorizations, authorization] }, authorization }
}

export function revokeWrites(profile: ProductionProfile, authorizationId: string): ProductionProfile {
  if (!profile.writeAuthorizations.some(entry => entry.id === authorizationId)) throw new Error(`No write authorization ${authorizationId}`)
  return { ...profile, writeAuthorizations: profile.writeAuthorizations.filter(entry => entry.id !== authorizationId) }
}

/** The live authorization for an environment and mutation, or null (expired ones never count). */
export function liveWriteAuthorization(profile: Pick<ProductionProfile, 'environments' | 'writeAuthorizations'>, environmentId: string, mutation: SandboxWriteAuthorization['mutations'][number] | null, now: Date = new Date()): SandboxWriteAuthorization | null {
  const environment = profile.environments.find(candidate => candidate.id === environmentId)
  if (!environment || environment.kind === 'production') return null
  return profile.writeAuthorizations.find(entry => entry.environmentId === environmentId && Date.parse(entry.expiresAt) > now.getTime() && (mutation === null || entry.mutations.includes(mutation))) ?? null
}

/**
 * Invariants the store enforces on every save, whatever the caller: no write authorization on a
 * production environment or on an environment that is not in the profile, designation names a
 * known environment, environment ids unique.
 */
export function profileProblems(profile: ProductionProfile): string[] {
  const problems: string[] = []
  const ids = profile.environments.map(environment => environment.id)
  if (new Set(ids).size !== ids.length) problems.push('Environment ids must be unique')
  for (const authorization of profile.writeAuthorizations) {
    const environment = profile.environments.find(candidate => candidate.id === authorization.environmentId)
    if (!environment) problems.push(`Write authorization ${authorization.id} names environment ${authorization.environmentId}, which is not in the profile`)
    else if (environment.kind === 'production') problems.push(`Write authorization ${authorization.id} names ${environment.id}, a production environment; revoke it (writes are never authorized on production)`)
  }
  if (profile.designation.productionReady && !ids.includes(profile.designation.environmentId ?? '')) problems.push('The production-ready designation must name an environment in the profile')
  for (const key of FACT_KEYS) if (!profile.facts[key] && !OPTIONAL_FACT_KEYS.includes(key)) problems.push(`Fact ${key} is missing`)
  return problems
}
