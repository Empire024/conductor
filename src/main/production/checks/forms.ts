import type { AuditPage, CheckContext, ControlCheck, DomForm, HumanReviewItem, SyntheticValue } from '../../../shared/production'
import {
  FindingSet, applicabilityGuard, browserProblem, budgetProblem, draft, emptyCoverage, hostOf, markTested, markersInPageStorage, mergeCoverage, notRun,
  outcome, pathOf, planRoutes, requestsCarrying, review, throwIfAborted, vendorOf, visit, withPage,
} from './technical-support'

/**
 * C04 Forms and data minimisation (docs/production-agent.md module M4). Per tested route:
 *
 * - inventory every form from the DOM snapshot (fields, purpose, required flags, defaults);
 * - a pre-ticked consent or marketing box is a finding (consent must be an affirmative act);
 * - personal data in a GET form lands in URLs, logs and referrers;
 * - special or sensitive fields the profile's data categories do not declare need a reason;
 * - synthetic values are typed into the fields (never submitted) and every request, cookie and web
 *   storage entry is searched for their markers: typed data that leaves the page before the visitor
 *   submits is a leak;
 * - a submission happens only through `operation('form-submit')` under a sandbox write
 *   authorization; otherwise it is declared unobservable. Production is never submitted.
 *
 * Consent is accepted first where a banner allows it, so the tools that would capture form data are
 * running while the check types.
 */

export interface FormsCheckOptions {
  maxRoutes?: number
  maxFormsPerRoute?: number
  settleMs?: number
}

const CHECK_ID = 'forms'
const CONSENT_FIELD = /newsletter|offers?|marketing|subscribe|promo|consent|partners?|third.?part|advertis|novink|z[lľ]av|ponuk|souhlas|s[uú]hlas|obchodn[eéí] (ozn|sd[eě]l)|werbung|einwillig/i
const FUNCTIONAL_CHECKBOX = /remember|zapam[aä]t|keep me|terms|podmienk|podm[ií]nk|agb|i agree to the terms/i
const PERSONAL_TYPES = new Set(['email', 'tel', 'password'])
const PERSONAL_NAME = /e-?mail|phone|tel(efon)?|mobile|password|heslo|first.?name|last.?name|surname|full.?name|meno|priezvisko|jm[eé]no|p[rř][ií]jmen[ií]|address|adresa|street|ulica|ulice|zip|postcode|psc|birth/i
const SEARCH_FIELD = /^(q|s|search|query|keyword|hladat|hledat)$/i
/** Special-category (GDPR art. 9) and other sensitive identifiers, with the data category that would justify each. */
const SENSITIVE: Array<{ pattern: RegExp; label: string; category: string }> = [
  { pattern: /birth|dob|date.?of.?birth|d[aá]tum.?narod|narozen|geburt/i, label: 'date of birth', category: 'date-of-birth' },
  { pattern: /national.?id|rodne.?cislo|rodn[eé]_?[cč][ií]slo|\bssn\b|social.?security|personal.?number|birth.?number/i, label: 'national identification number', category: 'national-id' },
  { pattern: /passport|id.?card|ob[cč]iansk|ob[cč]ansk|identity.?document/i, label: 'identity document number', category: 'identity-document' },
  { pattern: /gender|sex\b|pohlavie|pohlav[ií]/i, label: 'gender', category: 'gender' },
  { pattern: /health|medical|diagnos|zdrav|allerg/i, label: 'health data', category: 'health' },
  { pattern: /religio|n[aá]bo[zž]enst|faith/i, label: 'religion', category: 'religion' },
  { pattern: /ethnic|race|n[aá]rodnost/i, label: 'ethnic origin', category: 'ethnic-origin' },
  { pattern: /income|salary|pr[ií]jem|mzda|plat\b/i, label: 'income', category: 'financial' },
]
const FILLABLE_TYPES = new Set(['text', 'email', 'tel', 'password', 'textarea', 'search', 'url', 'number'])

export function createFormsCheck(options: FormsCheckOptions = {}): ControlCheck {
  const maxRoutes = options.maxRoutes ?? 8
  const maxForms = options.maxFormsPerRoute ?? 5
  const settleMs = options.settleMs ?? 1500
  return {
    controlId: 'C04',
    checkId: CHECK_ID,
    title: 'Form inventory, defaults, minimisation and synthetic-marker leaks',
    requires: ['browser'],
    async run(context) {
      const guard = applicabilityGuard(context, CHECK_ID)
      if (guard) return guard
      const missingBrowser = await browserProblem(context)
      if (missingBrowser) return notRun(CHECK_ID, 'UNVERIFIED', missingBrowser)

      const plan = planRoutes(context, undefined, maxRoutes)
      const coverage = mergeCoverage(emptyCoverage(), plan.coverage)
      const findings = new FindingSet()
      const unconcluded: string[] = []
      const evidence: string[] = []
      const humanReview: HumanReviewItem[] = []
      const observations: string[] = []
      const declared = (context.profile.facts.dataCategories.value ?? []).map(category => category.toLowerCase())
      const canSubmit = context.environment.kind !== 'production' && !context.policy.readOnly && !!context.policy.writeAuthorization?.mutations.includes('form-submit')
      let formsSeen = 0

      for (const route of plan.routes) {
        throwIfAborted(context)
        try {
          await withPage(context, 'desktop', 'clean', async page => {
            const loaded = await visit(page, context.url(route.path))
            if (!loaded.ok) { unconcluded.push(loaded.problem!); return }
            await page.consent({ action: 'accept' }).catch(() => ({ applied: false }))
            const snapshot = await page.snapshot()
            const forms = snapshot.forms.slice(0, maxForms)
            formsSeen += snapshot.forms.length
            markTested(coverage, route.path, 'desktop', 'accepted')
            if (!forms.length) return
            const inventory = await context.evidence.writeJson('dom', `C04 form inventory on ${route.path}`, { route: route.path, forms: snapshot.forms })
            evidence.push(inventory.id)
            for (const form of forms) inspectForm(context, route.path, form, declared, inventory.id, findings, humanReview)

            // Type synthetic values and search everything that left the page.
            const start = page.requests().length
            const typed: SyntheticValue[] = []
            for (const form of forms) typed.push(...await fillForm(context, page, form))
            if (!typed.length) return
            await page.keyboard(['Tab']).catch(() => [])
            await page.waitFor(settleMs)
            const sent = page.requests().slice(start)
            const stored = await markersInPageStorage(page, typed.map(value => value.marker))
            const leaks = await context.evidence.writeJson('requests', `C04 requests after typing synthetic values on ${route.path}`, {
              route: route.path, typed: typed.map(value => ({ kind: value.kind, marker: value.marker })),
              requests: sent.map(request => ({ url: request.url, method: request.method, party: request.party, blocked: request.blocked, excerpt: request.excerpt })),
              storage: stored,
            })
            evidence.push(leaks.id)
            reportLeaks(context, route.path, typed, sent, stored, leaks.id, findings, 'typing')

            if (canSubmit) {
              const target = forms.find(form => form.method === 'post' && !isLoginForm(form))
              if (target) {
                const before = page.requests().length
                const result = await context.operation('form-submit', `${route.path} ${target.selector}`, () => page.submit(target.selector, 'form-submit'))
                await page.waitFor(settleMs)
                const after = page.requests().slice(before)
                const submitted = await context.evidence.writeJson('requests', `C04 submission of ${target.selector} on ${route.path}`, {
                  navigation: result, requests: after.map(request => ({ url: request.url, method: request.method, party: request.party, blocked: request.blocked, excerpt: request.excerpt })),
                })
                evidence.push(submitted.id)
                reportLeaks(context, route.path, typed, after.filter(request => request.party === 'third-party' || request.method === 'GET'), [], submitted.id, findings, 'submission')
                if (typed.some(value => result.finalUrl.toLowerCase().includes(value.marker.toLowerCase()))) {
                  findings.add(draft(context, CHECK_ID, {
                    key: `marker-in-url-after-submit:${formKey(target)}`, route: route.path, component: target.selector, scope: 'component',
                    severity: 'high', confidence: 'confirmed', title: 'Submitted personal data appears in the resulting URL',
                    expected: 'Personal data is sent in a POST body and the confirmation URL carries none of it.',
                    observed: `After submitting ${target.selector}, the page URL contained a typed synthetic value.`,
                    evidence: [submitted.id], proposedFix: 'Redirect to a confirmation URL without the submitted values.',
                  }))
                }
                observations.push(`Submitted ${target.selector} on ${route.path} under the sandbox write authorization.`)
              }
            }
          })
        } catch (error) {
          unconcluded.push(`${route.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (!canSubmit) coverage.unobservable.push(context.environment.kind === 'production'
        ? 'Form submission is not tested on production: the audit never submits there.'
        : 'Form submission not tested: sandbox write authorization required for form-submit.')
      observations.push(`${formsSeen} form(s) found on ${plan.routes.length} route(s).`)
      if (!formsSeen) observations.push('No forms on the tested routes: nothing collects data there.')
      const budget = budgetProblem(context)
      if (budget) unconcluded.push(budget)
      return outcome(CHECK_ID, { findings: findings.list(), unconcluded, evidence, humanReview, coverage, observations })
    },
  }
}

export const formsCheck = createFormsCheck()

const formKey = (form: DomForm): string => `${form.method}:${form.action ? pathOf(form.action) : 'self'}`
const isLoginForm = (form: DomForm): boolean => form.fields.some(field => field.type === 'password')
const fieldText = (field: DomForm['fields'][number]): string => `${field.name} ${field.label ?? ''} ${field.autocomplete ?? ''}`

function inspectForm(context: CheckContext, route: string, form: DomForm, declared: string[], evidenceId: string, findings: FindingSet, humanReview: HumanReviewItem[]): void {
  const key = formKey(form)
  for (const field of form.fields) {
    if (field.type === 'checkbox' && field.defaultChecked && CONSENT_FIELD.test(fieldText(field)) && !FUNCTIONAL_CHECKBOX.test(fieldText(field))) {
      findings.add(draft(context, CHECK_ID, {
        key: `prechecked-consent:${key}:${field.name}`, route, component: form.selector, scope: 'component',
        severity: 'high', confidence: 'confirmed', title: `A consent box is ticked in advance: ${field.label ?? field.name}`,
        expected: 'Consent (marketing, newsletter, partners) is an affirmative act: the box starts unticked.',
        observed: `Checkbox "${field.name}" (${field.label ?? 'no label'}) in ${form.selector} is checked by default.`,
        reproduction: [`Open ${route}`, `Look at ${form.selector}`], evidence: [evidenceId],
        proposedFix: 'Remove the checked attribute; record consent only when the visitor ticks the box.',
      }))
    }
  }
  const personal = form.fields.filter(field => (PERSONAL_TYPES.has(field.type) || PERSONAL_NAME.test(fieldText(field))) && !SEARCH_FIELD.test(field.name))
  if (form.method === 'get' && personal.length) {
    findings.add(draft(context, CHECK_ID, {
      key: `personal-data-in-get-form:${key}`, route, component: form.selector, scope: 'component',
      severity: 'medium', confidence: 'confirmed', title: 'A form sends personal data with GET',
      expected: 'Personal data is submitted with POST, so it never lands in URLs, server logs, history or referrers.',
      observed: `${form.selector} uses GET for ${personal.map(field => field.name).join(', ')}.`,
      evidence: [evidenceId], proposedFix: 'Change the form method to POST.',
    }))
  }
  for (const field of form.fields) {
    const sensitive = SENSITIVE.find(item => item.pattern.test(fieldText(field)))
    if (!sensitive || declared.some(category => category.includes(sensitive.category) || sensitive.category.includes(category))) continue
    findings.add(draft(context, CHECK_ID, {
      key: `sensitive-field:${key}:${field.name}`, route, component: form.selector, scope: 'component',
      severity: 'medium', confidence: 'likely', title: `The form asks for ${sensitive.label}, which the profile does not declare`,
      expected: 'Only data needed for the form\'s purpose is collected, and every category is declared in the profile and the privacy notice.',
      observed: `Field "${field.name}" (${field.label ?? 'no label'})${field.required ? ', required,' : ''} in ${form.selector}.`,
      evidence: [evidenceId], proposedFix: `Remove the field, make it optional with a stated purpose, or declare "${sensitive.category}" in the profile's data categories and the privacy notice.`,
    }))
  }
  const visibleFields = form.fields.filter(field => !['hidden', 'submit', 'button', 'reset', 'image'].includes(field.type))
  if (visibleFields.length > 8) {
    humanReview.push(review(context, `minimisation:${route}:${key}`,
      `Is every field of ${form.selector} on ${route} necessary for its purpose? (${visibleFields.map(field => field.name).join(', ')})`,
      'Data minimisation depends on the purpose, which the audit cannot know.', route, [evidenceId]))
  }
}

/** Fills each fillable, visible field with a synthetic value of the matching kind; returns what was typed. */
async function fillForm(context: CheckContext, page: AuditPage, form: DomForm): Promise<SyntheticValue[]> {
  const typed: SyntheticValue[] = []
  for (const field of form.fields.slice(0, 20)) {
    if (!field.name || !FILLABLE_TYPES.has(field.type)) continue
    const text = fieldText(field)
    const kind: SyntheticValue['kind'] = field.type === 'email' || /mail/i.test(text) ? 'email'
      : field.type === 'tel' || /phone|tel|mobil/i.test(text) ? 'phone'
      : field.type === 'password' ? 'password'
      : field.type === 'textarea' || /message|comment|spr[aá]v|note/i.test(text) ? 'message'
      : /address|street|adres|ulic/i.test(text) ? 'address'
      : /name|meno|jm[eé]no|priezv|p[rř][ií]jmen/i.test(text) ? 'name'
      : 'marker'
    const value = context.synthetic(kind)
    const selector = `${form.selector} [name="${field.name.replace(/["\\]/g, '\\$&')}"]`
    try {
      await page.fill(selector, value)
      typed.push(value)
    } catch {
      // Hidden, disabled or read-only in practice: nothing to type there.
    }
  }
  return typed
}

function reportLeaks(context: CheckContext, route: string, typed: readonly SyntheticValue[], sent: ReturnType<AuditPage['requests']>, stored: Array<{ marker: string; where: string }>, evidenceId: string, findings: FindingSet, phase: 'typing' | 'submission'): void {
  const when = phase === 'typing' ? 'before the visitor submitted anything' : 'when the form was submitted'
  for (const value of typed) {
    for (const request of requestsCarrying(sent, value.marker)) {
      if (request.blocked) continue
      const thirdParty = request.party === 'third-party'
      if (!thirdParty && phase === 'submission' && request.method !== 'GET') continue
      const vendor = vendorOf(request.url)
      findings.add(draft(context, CHECK_ID, {
        key: thirdParty ? `marker-leak-${phase}:${vendor.key}` : `marker-in-url-${phase}:${hostOf(request.url)}`, route, scope: 'route',
        severity: thirdParty || value.kind === 'password' || value.kind === 'card' ? 'high' : 'medium', confidence: 'confirmed',
        title: thirdParty ? `Typed ${value.kind} is sent to ${vendor.name} ${when}` : `Typed ${value.kind} appears in a first-party URL ${when}`,
        expected: 'Form input stays in the page until the visitor submits it, and is never sent to third parties or put in URLs.',
        observed: `${request.method} ${request.url.split('?')[0]} carried the synthetic ${value.kind} value.`,
        reproduction: [`Open ${route}`, `Type into the ${value.kind} field`, 'Watch outgoing requests'], evidence: [evidenceId],
        proposedFix: thirdParty ? `Stop ${vendor.name} from reading form fields (mask inputs, remove input listeners) or remove it.` : 'Keep typed values out of URLs; send them only in a POST body on submit.',
      }))
    }
  }
  for (const item of stored) {
    const value = typed.find(entry => entry.marker.toLowerCase() === item.marker)
    findings.add(draft(context, CHECK_ID, {
      key: `marker-in-storage:${item.where.split(':')[0]}`, route, scope: 'route', severity: 'medium', confidence: 'confirmed',
      title: `Typed ${value?.kind ?? 'form data'} is kept in ${item.where.split(':')[0]}`,
      expected: 'Personal data typed into a form is not persisted in cookies or web storage on the device.',
      observed: `The synthetic ${value?.kind ?? 'value'} was found in ${item.where}.`, evidence: [evidenceId],
      proposedFix: 'Do not autosave personal fields to web storage, or clear the draft on submit and exclude passwords, cards and identifiers.',
    }))
  }
}
