import type { AuditPage, CheckContext, CheckOutcome, ControlCheck, DomForm, DomSnapshot } from '../../../shared/production'
import { decideApplicability } from '../registry'
import {
  browserProblem, draft, excerpt, isAllowed, linkMatches, markTested, mutate, mutationBlocked, newParts, notRun, outcome, pathOf, recordsFor, review,
  routesTagged, sleep, throwIfAborted, unobservable, visit, withPage, type DataRecord, type OutcomeParts,
} from './commerce-support'

/**
 * C07 Data rights and deletion (docs/production-agent.md, M6). Read-only: the privacy notice
 * describes the rights (erasure included) and offers a way to exercise them; the request form
 * asks only for what identity verification needs (no identity-document copies by default); the
 * retention exceptions are documented. With a sandbox write authorization for `deletion-request`
 * and a records reader (`Adapters.records`, or `records()` on the woocommerce / custom-command
 * adapter), a synthetic deletion request is submitted and traced: every record the system still
 * holds for the synthetic subject afterwards must carry a retention reason the notice documents.
 */

const CHECK_ID = 'data-rights'

const PRIVACY_LINK = /privacy|data protection|personal data|gdpr|ochrana osobn|spracovani|zpracov[aá]n[ií] osobn|os(?:o|ô)bn[ée] [uú]daje/i
const RIGHTS = /right (?:of|to) (?:access|erasure|deletion|rectification|be forgotten|(?:data )?portability|object)|pr[aá]vo na (?:v[ýy]maz|pr[ií]stup|opravu|prenosnos|p[řr]enositelnost)|data subject rights|your rights/i
const ERASURE = /erasure|deletion|delete (?:your|my)|be forgotten|v[ýy]maz|vymaza|smaz[aá]n/i
const REQUEST_LINK = /(?:data|privacy|gdpr|subject)[- ]?(?:access |rights? )?request|exercise (?:your|these) rights|delete (?:my |your )?(?:account|data)|request (?:access|deletion|erasure)|close (?:my |your )?account|account[- ]deletion|privacy[- ]request|[žz][ií]ados[tť]|uplatn/i
const DISPROPORTIONATE = /passport|id[ _-]?card|identity (?:card|document)|id[ _-]?document|scan of your|ob[čc]iansk|ob[čc]ansk|birth[ _-]?number|rodn[ée] [čc][ií]slo|social security|\bssn\b|national id/i
const VERIFICATION = /verif|confirm(?:ation)? (?:link|email|your identity)|over[ií]me|ov[eě][řr][ií]me|potvrdenie/i
const RETENTION = /retain|retention|kept for|keep [^.]{0,60} for|stored for|overwritten|uchov[aá]v|archiv|z[aá]loh/i

/** Retention categories a notice can document, and the words that name them in a notice or in a record's reason. */
const RETENTION_CATEGORIES: Array<{ id: string; pattern: RegExp }> = [
  { id: 'accounting', pattern: /accounting|tax|invoice|bookkeeping|[úu][čc]tov|da[ňn]|fakt[úu]r/i },
  { id: 'backups', pattern: /backup|z[aá]loh/i },
  { id: 'legal-claims', pattern: /legal claim|dispute|litigation|spor|pr[aá]vn[ey]ch n[aá]rok/i },
  { id: 'fraud', pattern: /fraud|abuse|podvod/i },
  { id: 'warranty', pattern: /warranty|guarantee|z[aá]ruk|reklam/i },
]

export interface DataRightsOptions {
  /** How long the trace waits for the deletion to show in the records (default 30 s). */
  traceWaitMs?: number
  pollMs?: number
}

export function createDataRightsCheck(options: DataRightsOptions = {}): ControlCheck {
  return {
    controlId: 'C07',
    checkId: CHECK_ID,
    title: 'Data rights: rights described, request route reachable, proportionate identity check, synthetic deletion traced and exceptions reconciled',
    requires: ['browser', 'sandbox-writes', 'commerce-sandbox'],
    run: context => runDataRights(context, { traceWaitMs: options.traceWaitMs ?? 30_000, pollMs: options.pollMs ?? 1_000 }),
  }
}

export const dataRightsCheck = createDataRightsCheck()

interface RequestRoute { path: string; form: DomForm | null; text: string }

async function runDataRights(context: CheckContext, options: Required<DataRightsOptions>): Promise<CheckOutcome> {
  const decision = decideApplicability(context.control, context.profile.facts, context.profile.scope)
  if (decision.status === 'not-applicable') return notRun(CHECK_ID, 'NOT_APPLICABLE', decision.rationale)
  if (decision.status === 'unknown') return notRun(CHECK_ID, 'UNVERIFIED', decision.rationale)

  const parts = newParts()
  parts.observations.push(decision.rationale)
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { ...parts, unconcluded: [noBrowser] })

  const read = async (path: string): Promise<DomSnapshot | null> => {
    throwIfAborted(context)
    return await withPage(context, async page => {
      const loaded = await visit(page, context.url(path))
      if (!loaded.ok) { parts.unconcluded.push(`${path} could not be read (${loaded.problem})`); return null }
      markTested(parts.coverage, path, 'desktop')
      return await page.snapshot()
    })
  }

  // The privacy notice.
  let privacyPath = routesTagged(context, ['privacy'], parts.coverage, 1)[0]?.path ?? null
  if (!privacyPath) {
    const home = await read('/')
    const link = home?.links.find(item => linkMatches(item, PRIVACY_LINK) && isAllowed(context, item.href))
    privacyPath = link ? pathOf(link.href) : null
  }
  const privacy = privacyPath ? await read(privacyPath) : null
  if (!privacyPath) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'no-privacy-notice', title: 'No privacy notice found to describe data rights', expected: 'A privacy notice linked from the site',
      observed: 'No route tagged `privacy` and no privacy link on the home page', severity: 'high', confidence: 'likely',
      proposedFix: 'Publish a privacy notice that lists the data subject rights and how to exercise them.',
    }))
    return outcome(CHECK_ID, parts)
  }
  if (!privacy) return outcome(CHECK_ID, parts)

  const retention = retentionOf(privacy.text)
  if (retention.categories.length) parts.observations.push(`Documented retention exceptions: ${retention.categories.join(', ')} ("${retention.excerpt}")`)
  if (!RIGHTS.test(privacy.text) || !ERASURE.test(privacy.text)) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'no-deletion-right-described', route: privacyPath, title: 'The privacy notice does not describe the right to erasure',
      expected: 'The notice lists the data subject rights, erasure included, and how to exercise them',
      observed: excerpt(privacy.text, RIGHTS) ?? `${privacyPath} names no data subject rights`,
      severity: 'high', confidence: 'confirmed', reproduction: [`Open ${privacyPath}`],
      proposedFix: 'List the rights of access, rectification, erasure, portability and objection, with the way to exercise them.',
    }))
  }

  // Request channels: links from the notice, routes the owner tagged, mailto addresses, a form on the notice.
  const candidates = new Set<string>()
  for (const route of routesTagged(context, ['data-rights'], parts.coverage, 2)) candidates.add(route.path)
  for (const link of privacy.links) if (linkMatches(link, REQUEST_LINK) && isAllowed(context, link.href) && pathOf(link.href) !== privacyPath) candidates.add(pathOf(link.href))
  const mailto = privacy.links.filter(link => /^mailto:/i.test(link.href)).map(link => link.href.slice(7).split('?')[0]!)
  const routes: RequestRoute[] = []
  if (privacy.forms.length) routes.push({ path: privacyPath, form: privacy.forms[0]!, text: privacy.text })
  for (const path of [...candidates].slice(0, 3)) {
    const snapshot = await read(path)
    if (snapshot) routes.push({ path, form: snapshot.forms.find(form => form.method.toLowerCase() !== 'get') ?? snapshot.forms[0] ?? null, text: snapshot.text })
  }
  if (!routes.length && !mailto.length) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'no-request-route', route: privacyPath, title: 'No way to submit a data rights request',
      expected: 'A request form, a request page or a contact address for data requests, reachable from the privacy notice',
      observed: `${privacyPath} links to ${privacy.links.map(link => pathOf(link.href)).slice(0, 12).join(', ') || 'nothing'}; no request page, form or address`,
      severity: 'high', confidence: 'confirmed', reproduction: [`Open ${privacyPath}`, 'Look for how to request access or deletion'],
      proposedFix: 'Link a data request form (or a dedicated address) from the privacy notice.',
    }))
  }
  if (mailto.length) {
    parts.observations.push(`Email channel for requests: ${mailto.join(', ')}`)
    if (!routes.some(route => route.form)) unobservable(parts.coverage, 'requests go by email: the identity check and the deletion cannot be traced automatically')
  }
  for (const route of routes) identityCheck(context, parts, route)

  // The synthetic deletion request.
  const target = routes.find(route => route.form)
  const blocked = mutationBlocked(context, 'deletion-request', 'the synthetic deletion request')
  const reader = recordsFor(context)
  const missing = blocked ?? (!target ? 'no request form on the site: the synthetic deletion request was not made'
    : !reader ? 'no records reader (Adapters.records, or the woocommerce/custom-command adapter): the deletion request could not be traced, so it was not made' : null)
  if (missing) {
    parts.unconcluded.push(missing)
    unobservable(parts.coverage, 'synthetic deletion request not traced through the backend')
    return outcome(CHECK_ID, parts)
  }
  await deletionJourney(context, parts, target!, reader!, retention.categories, options)
  return outcome(CHECK_ID, parts)
}

function retentionOf(text: string): { categories: string[]; excerpt: string | null } {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(sentence => RETENTION.test(sentence))
  const joined = sentences.join(' ')
  return { categories: RETENTION_CATEGORIES.filter(category => category.pattern.test(joined)).map(category => category.id), excerpt: joined.slice(0, 300) || null }
}

function identityCheck(context: CheckContext, parts: OutcomeParts, route: RequestRoute): void {
  if (!route.form) return
  const excessive = route.form.fields.filter(field => field.type === 'file' || DISPROPORTIONATE.test(`${field.name} ${field.label ?? ''}`))
  if (excessive.length) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'disproportionate-identity-check', route: route.path, component: route.form.selector,
      title: 'The data request asks for more identification than needed',
      expected: 'Identity verified proportionately (a confirmation link to the account email, or logging in); identity documents only when there is a specific doubt',
      observed: `The form requires ${excessive.map(field => `${field.label ?? field.name} (${field.type})`).join(', ')}`,
      severity: 'medium', confidence: 'confirmed', reproduction: [`Open ${route.path}`],
      proposedFix: 'Verify requests through the account or a confirmation email; drop default identity-document uploads and national identifiers.',
    }))
  }
  const hasEmail = route.form.fields.some(field => field.type === 'email' || /mail/i.test(field.name))
  const described = excerpt(route.text, VERIFICATION)
  if (described) parts.observations.push(`Identity verification on ${route.path}: "${described}"`)
  else if (!hasEmail) parts.humanReview.push(review(context, 'identity-verification', `How is the requester's identity verified on ${route.path}?`, 'The form collects no email and describes no verification step.', route.path))
}

const FORM_SCRIPT = (action: string | null): string => `(() => {
  const forms = [...document.querySelectorAll('form')]
  const form = forms.find(f => ${JSON.stringify(action)} && f.getAttribute('action') === ${JSON.stringify(action)}) || forms.find(f => (f.method || 'get').toLowerCase() !== 'get') || forms[0]
  if (!form) return null
  form.setAttribute('data-conductor-target', 'rights-form')
  for (const select of form.querySelectorAll('select')) {
    const option = [...select.options].find(o => /delet|erasure|v[ýy]maz|smaz/i.test(o.textContent + ' ' + o.value))
    if (option) select.value = option.value
  }
  return { fields: [...form.querySelectorAll('input, textarea')].filter(el => !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(el.type)).map(el => ({ name: el.name, type: el.type || el.tagName.toLowerCase() })) }
})()`

async function deletionJourney(context: CheckContext, parts: OutcomeParts, route: RequestRoute, reader: { records(subject: string): Promise<DataRecord[]> }, documented: string[], options: Required<DataRightsOptions>): Promise<void> {
  const email = context.synthetic('email')
  let before: DataRecord[]
  try { before = await reader.records(email.value) } catch (error) {
    parts.unconcluded.push(`records reader failed before the request: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const submitted = await withPage(context, async page => {
    const loaded = await visit(page, context.url(route.path))
    if (!loaded.ok) { parts.unconcluded.push(`${route.path} could not be read (${loaded.problem})`); return false }
    const form = await page.evaluate<{ fields: Array<{ name: string; type: string }> } | null>(FORM_SCRIPT(route.form?.action ? new URL(route.form.action, context.url(route.path)).pathname : null))
    if (!form) { parts.unconcluded.push(`the request form on ${route.path} disappeared`); return false }
    await fillRequest(context, page, form.fields, email)
    if (!(await page.evaluate<boolean>(`document.querySelector('form[data-conductor-target="rights-form"]').checkValidity()`))) {
      parts.unconcluded.push(`the request form on ${route.path} requires fields a synthetic request cannot provide (documents, identifiers): the deletion request was not submitted`)
      return false
    }
    const done = await mutate(context, 'deletion-request', `synthetic deletion request on ${route.path}`, () => page.submit('form[data-conductor-target="rights-form"]', 'deletion-request'))
    if (!done.ok) { parts.unconcluded.push(done.reason); return false }
    if (done.value.outcome !== 'ok' || (done.value.status ?? 200) >= 400) { parts.unconcluded.push(`the deletion request on ${route.path} ended ${done.value.outcome} (HTTP ${done.value.status ?? 'none'})`); return false }
    return true
  })
  if (!submitted) return

  // Trace: wait until nothing without a retention reason remains, or the wait ends.
  const deadline = Date.now() + options.traceWaitMs
  let after: DataRecord[] = before
  for (;;) {
    throwIfAborted(context)
    try { after = await reader.records(email.value) } catch (error) {
      parts.unconcluded.push(`records reader failed after the request: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (after.every(record => record.retainedBecause) || Date.now() >= deadline) break
    await sleep(options.pollMs)
  }
  parts.evidence.push((await context.evidence.writeJson('command', `records of the synthetic subject before and after the deletion request on ${route.path}`, { subject: email.value, before, after })).id)
  parts.observations.push(`Deletion request traced: ${before.length} record(s) before, ${after.length} after (${after.map(record => `${record.store}/${record.kind}${record.retainedBecause ? ` kept: ${record.retainedBecause}` : ''}`).join('; ') || 'none'})`)
  if (!before.length) unobservable(parts.coverage, 'the synthetic subject had no records before the request, so the deletion itself was not demonstrated')

  const seen = new Set<string>()
  for (const record of after) {
    const key = `${record.store}:${record.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!record.retainedBecause) {
      parts.findings.push(draft(context, CHECK_ID, {
        key: `records-remain:${key}`, route: route.path, scope: 'journey', component: key,
        title: `Records remain after a deletion request (${record.store} ${record.kind})`,
        expected: `Within ${Math.round(options.traceWaitMs / 1000)} s of the request the subject's ${record.kind} record is deleted, or kept for a documented reason`,
        observed: `${record.store} still holds ${record.kind} ${record.id} for the synthetic subject, with no retention reason`,
        severity: 'high', confidence: 'confirmed',
        reproduction: [`Submit a deletion request on ${route.path} for a test subject`, `Read the subject's records from ${record.store}`],
        proposedFix: 'Delete (or anonymise) the subject in every store when an erasure request is accepted, or document why the record is kept.',
      }))
      continue
    }
    const category = RETENTION_CATEGORIES.find(entry => entry.pattern.test(record.retainedBecause!))?.id ?? null
    if (category && documented.includes(category)) {
      parts.observations.push(`Reconciled: ${key} kept for ${category}, as the privacy notice documents`)
    } else {
      parts.findings.push(draft(context, CHECK_ID, {
        key: `retention-not-documented:${key}`, route: route.path, scope: 'journey', component: key,
        title: `A record kept after deletion is not covered by a documented exception (${record.store} ${record.kind})`,
        expected: 'Every retention exception the system applies is stated in the privacy notice',
        observed: `${record.store} keeps ${record.kind} ${record.id} because "${record.retainedBecause}"; the notice documents ${documented.join(', ') || 'no exceptions'}`,
        severity: 'medium', confidence: 'confirmed', reproduction: [`Submit a deletion request on ${route.path}`, `Read the subject's records from ${record.store}`],
        proposedFix: 'Document this retention reason and period in the privacy notice, or delete the record.',
      }))
    }
  }
}

async function fillRequest(context: CheckContext, page: AuditPage, fields: Array<{ name: string; type: string }>, email: ReturnType<CheckContext['synthetic']>): Promise<void> {
  for (const field of fields.slice(0, 20)) {
    if (!field.name) continue
    const value = field.type === 'email' || /mail/i.test(field.name) ? email
      : /name/i.test(field.name) ? context.synthetic('name')
      : field.type === 'textarea' || /message|detail|comment/i.test(field.name) ? context.synthetic('message') : null
    if (value) await page.fill(`form[data-conductor-target="rights-form"] [name="${field.name.replace(/"/g, '\\"')}"]`, value)
  }
}
