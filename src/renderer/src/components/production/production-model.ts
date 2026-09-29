import {
  CONTROL_RESULT_SEVERITY, ENVIRONMENT_KINDS, MUTATION_KINDS, RUN_TRANSITIONS, SEVERITIES,
  type ControlResultStatus, type EnvironmentKind, type Finding, type GateState, type MutationKind, type ProductionBridge,
  type ProductionEnvironment, type ProductionProjectSnapshot, type ProductionQueueEntry, type ProductionRunSummary, type ProjectAuditState,
  type RunStatus, type TargetFingerprint, type WaiverRequest, type WriteAuthorizationRequest
} from '../../../../shared/production'

/**
 * Pure helpers for the Production panel and queue (docs/production-agent.md section 9). The panel
 * never shows a percentage: the gate is a state with its reasons, and progress is steps done of
 * steps planned.
 */

export type Tone = 'good' | 'warn' | 'bad' | 'busy' | 'quiet'

export const GATE_LABELS: Readonly<Record<ProjectAuditState, { label: string; tone: Tone }>> = {
  NOT_AUDITED: { label: 'Not audited', tone: 'quiet' },
  AUDITING: { label: 'Auditing', tone: 'busy' },
  BLOCKED: { label: 'Blocked', tone: 'bad' },
  NEEDS_REVIEW: { label: 'Needs review', tone: 'bad' },
  STALE: { label: 'Stale', tone: 'warn' },
  VERIFIED_WITH_WAIVERS: { label: 'Verified with waivers', tone: 'good' },
  VERIFIED: { label: 'Verified', tone: 'good' },
}

export const shortCommit = (commit: string | null): string => commit ? commit.slice(0, 10) : 'no commit'

/** "commit 0123456789 · build 42 · computed <time>", the line the header shows under the gate. */
export function fingerprintLine(fingerprint: TargetFingerprint | null): string {
  if (!fingerprint) return 'No fingerprint yet'
  return [`commit ${shortCommit(fingerprint.commit)}`, fingerprint.build ? `build ${fingerprint.build}` : 'no build id', `computed ${formatTime(fingerprint.computedAt)}`].join(' · ')
}

/** What the gate means in one sentence; VERIFIED names the scope and fingerprint, never a certification. */
export function gateSummary(gate: GateState): string {
  const at = gate.fingerprint ? ` at ${shortCommit(gate.fingerprint.commit)}` : ''
  switch (gate.state) {
    case 'VERIFIED': return `Passed the configured audit scope${at}.`
    case 'VERIFIED_WITH_WAIVERS': return `Passed the configured audit scope${at}, with ${gate.activeWaivers} waived finding${gate.activeWaivers === 1 ? '' : 's'}.`
    case 'NOT_AUDITED': return 'No completed audit for this environment.'
    case 'AUDITING': return 'An audit is running for this environment.'
    case 'BLOCKED': return 'The last run could not finish; see the reasons.'
    case 'STALE': return `The target changed since the last audit${gate.staleControls.length ? `; ${gate.staleControls.length} control${gate.staleControls.length === 1 ? '' : 's'} need a re-test` : ''}.`
    case 'NEEDS_REVIEW': return 'Open findings, questions or unverified controls need attention.'
  }
}

/** Queue order: the states that need the owner first (BLOCKED, NEEDS_REVIEW, STALE), settled ones last. */
export const QUEUE_STATE_ORDER: Readonly<Record<ProjectAuditState, number>> = {
  BLOCKED: 0, NEEDS_REVIEW: 1, STALE: 2, AUDITING: 3, NOT_AUDITED: 4, VERIFIED_WITH_WAIVERS: 5, VERIFIED: 6,
}

export function orderQueue(entries: readonly ProductionQueueEntry[]): ProductionQueueEntry[] {
  return [...entries].sort((a, b) =>
    QUEUE_STATE_ORDER[a.gate.state] - QUEUE_STATE_ORDER[b.gate.state]
    || (b.openFindings.critical - a.openFindings.critical)
    || (b.openFindings.high - a.openFindings.high)
    || (b.openQuestions - a.openQuestions)
    || a.projectName.localeCompare(b.projectName))
}

export const STATUS_TONE: Readonly<Record<ControlResultStatus, Tone>> = {
  PASS: 'good', FAIL: 'bad', WARN: 'warn', NOT_APPLICABLE: 'quiet', UNVERIFIED: 'warn', NEEDS_HUMAN_REVIEW: 'warn',
}
export const STATUS_LABEL: Readonly<Record<ControlResultStatus, string>> = {
  PASS: 'Pass', FAIL: 'Fail', WARN: 'Warn', NOT_APPLICABLE: 'Not applicable', UNVERIFIED: 'Unverified', NEEDS_HUMAN_REVIEW: 'Needs human review',
}

/** Worst first, then control id: the table reads from what needs work to what passed. */
export const sortResults = <T extends { controlId: string; status: ControlResultStatus }>(results: readonly T[]): T[] =>
  [...results].sort((a, b) => CONTROL_RESULT_SEVERITY[b.status] - CONTROL_RESULT_SEVERITY[a.status] || a.controlId.localeCompare(b.controlId))

const FINDING_STATUS_ORDER: Readonly<Record<Finding['status'], number>> = { reopened: 0, open: 1, disputed: 2, waived: 3, fixed: 4 }
export const sortFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => FINDING_STATUS_ORDER[a.status] - FINDING_STATUS_ORDER[b.status]
    || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || a.controlId.localeCompare(b.controlId) || a.title.localeCompare(b.title))

export const isOpenFinding = (finding: Finding): boolean => finding.status === 'open' || finding.status === 'reopened'

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'paused', 'recovering', 'blocked']

/** Which run controls the transition table allows from a status. */
export const runControls = (status: RunStatus): { pause: boolean; resume: boolean; cancel: boolean } => ({
  pause: RUN_TRANSITIONS[status].includes('paused'),
  resume: (status === 'paused' || status === 'blocked') && RUN_TRANSITIONS[status].includes('running'),
  cancel: RUN_TRANSITIONS[status].includes('cancelled'),
})

/** Steps done of planned, and the current step; never a percentage. */
export function progressText(run: ProductionRunSummary): string {
  const steps = `${run.progress.done} of ${run.progress.total} steps`
  return run.progress.currentStep ? `${steps} · ${run.progress.currentStep}` : steps
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export function ledgerText(run: ProductionRunSummary): string {
  const { ledger } = run
  const parts = [`${ledger.tokens.toLocaleString('en-US')} tokens`, `${ledger.modelCalls} model call${ledger.modelCalls === 1 ? '' : 's'}`, `${ledger.requests.toLocaleString('en-US')} requests`, formatDuration(ledger.elapsedMs)]
  return ledger.exhausted ? `${parts.join(' · ')} · stopped: ${ledger.exhausted} reached` : parts.join(' · ')
}

export function formatTime(iso: string | null): string {
  if (!iso) return 'never'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return iso
  return new Date(time).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/** The environment the panel shows: the owner's choice, else the designated one, else the first. */
export function chosenEnvironment(snapshot: ProductionProjectSnapshot, preferred: string | null): ProductionEnvironment | null {
  const environments = snapshot.profile?.environments ?? []
  return environments.find(environment => environment.id === preferred)
    ?? environments.find(environment => environment.id === snapshot.profile?.designation.environmentId)
    ?? environments[0] ?? null
}

/** The newest completed run with a report for an environment (what "Open report" opens). */
export const reportRun = (runs: readonly ProductionRunSummary[], environmentId: string | null): ProductionRunSummary | null =>
  runs.filter(run => run.reportPaths && (!environmentId || run.environmentId === environmentId))
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))[0] ?? null

// ---------------------------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------------------------

export interface WaiverDraft { reason: string; scope: string; owner: string; expiresOn: string }
export type WaiverErrors = Partial<Record<keyof WaiverDraft, string>>

/** Validates the waiver form. Every field is required; the expiry is a date after today. */
export function validateWaiver(findingId: string, draft: WaiverDraft, now: number): { request: WaiverRequest | null; errors: WaiverErrors } {
  const errors: WaiverErrors = {}
  if (!draft.reason.trim()) errors.reason = 'Say why this finding is accepted.'
  if (!draft.scope.trim()) errors.scope = 'Say what the waiver covers (route, component or journey).'
  if (!draft.owner.trim()) errors.owner = 'Name who owns the accepted risk.'
  const expiry = draft.expiresOn.trim()
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? Date.parse(`${expiry}T23:59:59.000Z`) : Number.NaN
  if (!expiry) errors.expiresOn = 'An expiry date is required; waivers never last forever.'
  else if (!Number.isFinite(expiresAt)) errors.expiresOn = 'Use a date (YYYY-MM-DD).'
  else if (expiresAt <= now) errors.expiresOn = 'The expiry must be in the future.'
  if (Object.keys(errors).length) return { request: null, errors }
  return { request: { findingId, reason: draft.reason.trim(), scope: draft.scope.trim(), owner: draft.owner.trim(), expiresAt: new Date(expiresAt).toISOString() }, errors }
}

export interface EnvironmentDraft { label: string; kind: EnvironmentKind; baseUrl: string; extraOrigins: string }
export type EnvironmentErrors = Partial<Record<keyof EnvironmentDraft, string>>

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'environment'

/** Builds a new environment from the form; the base URL's origin is always allowed. */
export function validateEnvironment(draft: EnvironmentDraft, existing: readonly ProductionEnvironment[]): { environment: ProductionEnvironment | null; errors: EnvironmentErrors } {
  const errors: EnvironmentErrors = {}
  const label = draft.label.trim()
  if (!label) errors.label = 'Name the environment.'
  if (!ENVIRONMENT_KINDS.includes(draft.kind)) errors.kind = 'Choose a kind.'
  let origin = ''
  try {
    const url = new URL(draft.baseUrl.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
    origin = url.origin
  } catch { errors.baseUrl = 'Use an http(s) URL, for example https://shop.example.com.' }
  const extras: string[] = []
  for (const item of draft.extraOrigins.split(/[\s,]+/).map(value => value.trim()).filter(Boolean)) {
    try {
      const url = new URL(item)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme')
      extras.push(url.origin)
    } catch { errors.extraOrigins = `${item} is not an http(s) origin.` }
  }
  if (Object.keys(errors).length) return { environment: null, errors }
  let id = `env-${slug(label)}`
  for (let n = 2; existing.some(environment => environment.id === id); n += 1) id = `env-${slug(label)}-${n}`
  return {
    environment: {
      id, kind: draft.kind, label, baseUrl: draft.baseUrl.trim(), allowedOrigins: [...new Set([origin, ...extras])],
      accounts: [], capturedMail: null, commerce: null, storage: null, buildInfoCommand: null, smokeCommand: null
    },
    errors
  }
}

export interface WritesDraft { environmentId: string; mutations: MutationKind[]; expiresOn: string; note: string }

export function validateWrites(draft: WritesDraft, environments: readonly ProductionEnvironment[], now: number): { request: WriteAuthorizationRequest | null; error: string } {
  const environment = environments.find(item => item.id === draft.environmentId)
  if (!environment) return { request: null, error: 'Choose a non-production environment.' }
  if (environment.kind === 'production') return { request: null, error: 'A production environment is never authorized for writes.' }
  if (!draft.mutations.length) return { request: null, error: 'Name at least one kind of mutation.' }
  if (draft.mutations.some(mutation => !MUTATION_KINDS.includes(mutation))) return { request: null, error: 'Unknown mutation kind.' }
  const expiresAt = /^\d{4}-\d{2}-\d{2}$/.test(draft.expiresOn) ? Date.parse(`${draft.expiresOn}T23:59:59.000Z`) : Number.NaN
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { request: null, error: 'Set an expiry date in the future.' }
  return { request: { environmentId: environment.id, mutations: [...draft.mutations], expiresAt: new Date(expiresAt).toISOString(), note: draft.note.trim() }, error: '' }
}

// ---------------------------------------------------------------------------------------------
// Actions the panel runs (kept here so tests drive them over the fake bridge)
// ---------------------------------------------------------------------------------------------

export async function answerQuestion(bridge: Pick<ProductionBridge, 'answerQuestion'>, projectId: string, questionId: string, answer: string): Promise<void> {
  if (!answer.trim()) throw new Error('Type an answer first.')
  await bridge.answerQuestion(projectId, questionId, answer.trim())
}

export async function waiveFinding(bridge: Pick<ProductionBridge, 'waive'>, projectId: string, findingId: string, draft: WaiverDraft, now: number): Promise<WaiverErrors> {
  const { request, errors } = validateWaiver(findingId, draft, now)
  if (request) await bridge.waive(projectId, request)
  return errors
}

export const errorText = (reason: unknown): string =>
  reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(reason)
