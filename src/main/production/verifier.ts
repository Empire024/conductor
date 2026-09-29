import type { CheckOutcome, ControlId, Finding, FindingStatus, Interpreter, TargetFingerprint, VerificationRecord } from '../../shared/production'
import { findingId, sameTarget } from './fingerprint'

/**
 * The Production Verifier (docs/production-agent.md section 8). A `verify` run gets only recheck
 * specs built from the findings — id, control, check, key, route, what was expected, and the status
 * the builder claims — never the prior run's evidence, observed text or report. The runner opens a
 * fresh audit browser (fresh user-data directory), computes the fingerprint first, reruns each
 * finding's whole control on the current target (a regression pass as well), and this module turns
 * the fresh outcome into a verdict:
 *
 * - fix claimed on an unchanged fingerprint → `could-not-verify: artifact unchanged`, nothing rerun;
 * - the defect reproduces (the same stable finding id comes out again) → `verified-open`, with a
 *   `disagreement` when the builder claimed it fixed;
 * - the check concluded and the defect is gone → `verified-fixed`;
 * - the check did not conclude → `could-not-verify` with its reason.
 *
 * Only on disagreement is the `verify-review` role asked, and its answer can only add text to the
 * disagreement; it never flips a verdict.
 */

export interface FindingRecheckSpec {
  id: string
  controlId: ControlId
  checkId: string
  key: string
  route: string | null
  expected: string
  claimed: FindingStatus | 'claimed-fixed'
}

export function recheckSpec(finding: Finding, claimedFixed: boolean): FindingRecheckSpec {
  return { id: finding.id, controlId: finding.controlId, checkId: finding.checkId, key: finding.key, route: finding.route, expected: finding.expected, claimed: claimedFixed ? 'claimed-fixed' : finding.status }
}

/** Findings whose fix claim meets an unchanged artifact: no rerun can show a fix, so they end could-not-verify. */
export function unchangedClaims(specs: readonly FindingRecheckSpec[], lastSeen: ReadonlyMap<string, TargetFingerprint>, current: TargetFingerprint): Set<string> {
  return new Set(specs.filter(spec => spec.claimed === 'claimed-fixed' && sameTarget(lastSeen.get(spec.id) ?? null, current)).map(spec => spec.id))
}

export interface VerdictInput {
  spec: FindingRecheckSpec
  projectId: string
  environmentId: string
  verifierRunId: string
  fingerprint: TargetFingerprint
  /** The finding's last-seen fingerprint (for the unchanged-artifact rule). */
  lastSeenFingerprint: TargetFingerprint
  /** The fresh outcomes of the finding's control; null when the control was not rerun. */
  outcomes: readonly CheckOutcome[] | null
  /** Why the control was not rerun or could not conclude, when it did not. */
  reason: string | null
  evidence: string[]
  at: string
}

export function verdict(input: VerdictInput): VerificationRecord {
  const base = { findingId: input.spec.id, verifierRunId: input.verifierRunId, fingerprint: input.fingerprint, evidence: input.evidence, at: input.at }
  const unchanged = sameTarget(input.lastSeenFingerprint, input.fingerprint)
  if (input.spec.claimed === 'claimed-fixed' && unchanged) return { ...base, status: 'could-not-verify', disagreement: 'could-not-verify: artifact unchanged since the finding was last seen, so no fix can have been deployed' }
  if (!input.outcomes) return { ...base, status: 'could-not-verify', disagreement: input.reason ?? 'the control was not rerun' }
  const produced = new Set(input.outcomes.flatMap(outcome => outcome.findings).map(draft => findingId({ projectId: input.projectId, environmentId: input.environmentId, controlId: draft.controlId, checkId: draft.checkId, key: draft.key, route: draft.route })))
  if (produced.has(input.spec.id)) {
    const disagreement = input.spec.claimed === 'claimed-fixed' || input.spec.claimed === 'fixed'
      ? `The builder claimed this fixed, but a fresh session on the current target still reproduces it (${input.spec.checkId}, ${input.spec.route ?? 'site-wide'}).`
      : null
    return { ...base, status: 'verified-open', disagreement }
  }
  const check = input.outcomes.find(outcome => outcome.checkId === input.spec.checkId)
  if (!check) return { ...base, status: 'could-not-verify', disagreement: `check ${input.spec.checkId} did not run` }
  if (check.status === 'UNVERIFIED' || check.status === 'NOT_APPLICABLE') return { ...base, status: 'could-not-verify', disagreement: check.reason ?? `check ${input.spec.checkId} did not conclude (${check.status})` }
  if (unchanged) return { ...base, status: 'could-not-verify', disagreement: 'the defect did not reproduce, but the artifact is unchanged since it was last seen; a fix cannot be verified' }
  return { ...base, status: 'verified-fixed', disagreement: null }
}

/** Asks the verify-review role about a disagreement; its note is appended, the verdict never changes. */
export async function reviewDisagreement(record: VerificationRecord, finding: Finding, interpreter: Interpreter, signal: AbortSignal): Promise<VerificationRecord> {
  if (!record.disagreement || record.status !== 'verified-open') return record
  const answer = await interpreter.ask({
    role: 'verify-review', controlId: finding.controlId, purpose: 'verifier-disagreement',
    system: 'A fix was claimed for an audit finding, but an independent recheck still reproduces it. Write a short note for the owner on what to look at. You cannot change the verdict.',
    user: JSON.stringify({ title: finding.title, controlId: finding.controlId, route: finding.route, expected: finding.expected, disagreement: record.disagreement }),
    schema: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: { type: 'string', maxLength: 800 } } },
    maxTokens: 400,
  }, signal)
  const note = answer.ok && answer.json && typeof (answer.json as { note?: unknown }).note === 'string' ? (answer.json as { note: string }).note : null
  return { ...record, disagreement: note ? `${record.disagreement} Reviewer note: ${note}` : `${record.disagreement} (review not available: ${answer.refused ?? 'no answer'})` }
}
