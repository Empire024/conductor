import {
  CONTROL_RESULT_SEVERITY,
  type CheckContext, type CheckOutcome, type ControlResultStatus, type FindingDraft, type HumanReviewItem, type RouteCoverage,
} from '../../../shared/production'
import { provenanceFor } from '../registry'

/**
 * Helpers every control check shares (M4 technical, M5 document, M6 commerce), folded from the
 * three support modules, which re-export them beside their own domain helpers: finding drafts with
 * the provenance that applies, human-review items, the status rule, the not-run outcome, and a few
 * small text and URL utilities.
 */

export const emptyCoverage = (): RouteCoverage => ({ tested: [], sampled: [], excluded: [], unobservable: [] })

export function throwIfAborted(context: CheckContext): void {
  if (context.signal.aborted) throw new Error(`${context.control.id} check cancelled`)
}

/** Pathname and query of a URL, for finding routes and coverage. */
export function pathOf(url: string): string {
  try { const parsed = new URL(url); return parsed.pathname + parsed.search } catch { return url }
}

export const isAllowed = (context: CheckContext, url: string): boolean => {
  try { return context.policy.allowedOrigins.includes(new URL(url).origin) } catch { return false }
}

/** Browser availability as an unconcluded reason, or null when a browser is there. */
export async function browserProblem(context: CheckContext): Promise<string | null> {
  const availability = await context.browser.availability()
  return availability.available ? null : `no audit browser: ${availability.reason ?? 'unavailable'}`
}

export type DraftInput = Pick<FindingDraft, 'key' | 'title' | 'expected' | 'observed' | 'severity' | 'confidence' | 'proposedFix'>
  & Partial<Pick<FindingDraft, 'route' | 'component' | 'scope' | 'category' | 'reproduction' | 'evidence' | 'owner'>>

/** A finding of this check with the control's owner and, for legal findings, the provenance that applies to the project. */
export function draft(context: CheckContext, checkId: string, input: DraftInput): FindingDraft {
  const category = input.category ?? (context.control.classification === 'legal' ? 'legal' : 'technical')
  const sources = category === 'legal' ? provenanceFor(context.control, context.profile.facts).filter(source => source.kind !== 'video-source') : []
  const reviewBy = sources.map(source => source.reviewBy).filter((date): date is string => !!date).sort()[0] ?? null
  return {
    controlId: context.control.id,
    checkId,
    key: input.key,
    route: input.route ?? null,
    component: input.component ?? null,
    scope: input.scope ?? (input.route ? 'page' : 'site'),
    category,
    severity: input.severity,
    confidence: input.confidence,
    title: input.title,
    expected: input.expected,
    observed: input.observed,
    reproduction: input.reproduction ?? [],
    evidence: input.evidence ?? [],
    proposedFix: input.proposedFix,
    owner: input.owner ?? context.control.owner,
    legal: category === 'legal' ? { sources, effectiveDate: null, reviewBy } : null,
  }
}

export function review(context: CheckContext, key: string, question: string, why: string, route: string | null = null, evidence: string[] = []): HumanReviewItem {
  return { id: `${context.control.id}:${key}`, controlId: context.control.id, question, why, route, evidence }
}

/**
 * The check's status: FAIL for a critical or high finding, WARN for a lesser one, UNVERIFIED when
 * a part could not conclude, worst of these; PASS (or the given floor, such as NEEDS_HUMAN_REVIEW
 * for a statement only a human can judge) only when everything concluded clean. Human-review items
 * do not lower the status here; the gate caps controls that always need review.
 */
export function statusOf(findings: readonly FindingDraft[], unconcluded: readonly string[], floor: ControlResultStatus = 'PASS'): ControlResultStatus {
  const statuses: ControlResultStatus[] = [floor]
  for (const finding of findings) statuses.push(finding.severity === 'critical' || finding.severity === 'high' ? 'FAIL' : 'WARN')
  if (unconcluded.length) statuses.push('UNVERIFIED')
  return statuses.sort((a, b) => CONTROL_RESULT_SEVERITY[b] - CONTROL_RESULT_SEVERITY[a])[0]!
}

/** The outcome of a check that decided not to run: not applicable, or applicability unknown. */
export function notRun(checkId: string, status: 'NOT_APPLICABLE' | 'UNVERIFIED', reason: string): CheckOutcome {
  return { checkId, status, reason, findings: [], evidence: [], humanReview: [], coverage: emptyCoverage(), observations: [reason] }
}

export const normalise = (text: string): string => text.normalize('NFKC').replace(/\s+/g, ' ').trim()

/** Lower-case, accents and punctuation removed: for name and label comparison. */
export const fold = (text: string): string => normalise(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
