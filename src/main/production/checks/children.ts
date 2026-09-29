import type { CheckContext, CheckOutcome, ControlCheck, FindingDraft, HumanReviewItem, ObservedRequest } from '../../../shared/production'
import { decideApplicability } from '../registry'
import {
  browserProblem, draft, footerLinks, LINK_PATTERNS, markTested, matchesLink, notRun, outcome, pathOf, planRoutes, review, throwIfAborted,
  trackerRequests, visit, withPage,
} from './document-support'

/**
 * C14 Children and age-restricted use (docs/production-agent.md, M5). Driven by applicability:
 * nothing is opened when the control does not apply, and an unknown audience is UNVERIFIED.
 * For a child-directed or mixed audience: a notice for parents in the privacy policy, no tracking
 * requests and no personal-data forms on the child routes, and (mixed) some age screening. For
 * age-restricted products or an adult-only service: an age gate on the tested routes, plus the
 * owner's eligibility evidence as a review item. Legal adequacy is always a human's call.
 */

const CHECK_ID = 'children'

const PARENTAL_NOTICE = /parent(?:al)? (?:consent|notice|permission)|parents? (?:or|and) (?:legal )?guardians?|verifiable parental consent|notice for parents|children['’]?s (?:privacy|data)|rodi[čc]|z[aá]konn[ýy] z[aá]stupc|ochrana (?:osobn[ýy]ch [uú]dajov )?det[ií]|ochrana (?:osobn[ií]ch [uú]daj[uů] )?d[eě]t[ií]/i
const AGE_SCREENING = /how old are you|your age|date of birth|birth ?date|year of birth|are you (?:over|under|at least) \d{1,2}|v[eě]k|d[aá]tum narodenia|datum narozen[ií]|rok narodenia|rok narozen[ií]/i
const AGE_GATE = /\b(?:1[6-9]|21)\+|(?:are you|you must be|must be) (?:at least )?(?:1[6-9]|21|of legal (?:drinking )?age)|(?:1[6-9]|21) (?:years old )?or older|(?:over|older than) (?:1[6-9]|21)\b|age (?:verification|check|gate)|overenie veku|ov[eě][řr]en[ií] v[eě]ku|m[aá]te (?:viac|v[ií]ce) ako (?:1[6-9]|21)|je v[aá]m (?:v[ií]ce|v[íi]c) ne[žz] (?:1[6-9]|21)/i
const PERSONAL_FIELD = /name|meno|jm[eé]no|e-?mail|phone|tel|mobil|address|adresa|birth|narod|school|[šs]kol/i

export const childrenCheck: ControlCheck = {
  controlId: 'C14',
  checkId: CHECK_ID,
  title: 'Children and age-restricted use: parental notice, child-route data flows, age screening and age gates',
  requires: ['browser'],
  run: runChildren,
}

async function runChildren(context: CheckContext): Promise<CheckOutcome> {
  const decision = decideApplicability(context.control, context.profile.facts, context.profile.scope)
  if (decision.status === 'not-applicable') return notRun(CHECK_ID, 'NOT_APPLICABLE', decision.rationale)
  if (decision.status === 'unknown') return notRun(CHECK_ID, 'UNVERIFIED', decision.rationale)

  const findings: FindingDraft[] = []
  const unconcluded: string[] = []
  const evidence: string[] = []
  const humanReview: HumanReviewItem[] = []
  const observations: string[] = [decision.rationale]
  const facts = context.profile.facts
  const audience = facts.audience.value
  const childFacing = audience === 'child-directed' || audience === 'mixed'
  const ageRestricted = facts.ageRestrictedProducts.value === true || audience === 'adult-only'
  // On a mixed site the child routes are the ones tagged for children; a child-directed site is all child routes.
  const tagged = planRoutes(context, { tags: ['children', 'kids', 'child'] })
  const { routes, coverage } = audience === 'mixed' && tagged.routes.length ? tagged : planRoutes(context)
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { findings, unconcluded: [noBrowser], evidence, humanReview, coverage, observations })

  const pages: Array<{ route: string; text: string; requests: ObservedRequest[]; personalForms: string[]; hasAgeGate: boolean; evidence: string }> = []
  let privacyUrl: string | null = null
  for (const route of routes) {
    throwIfAborted(context)
    await withPage(context, 'desktop', async page => {
      const loaded = await visit(page, context.url(route.path))
      if (!loaded.ok) { unconcluded.push(`route ${route.path} could not be read (${loaded.problem})`); return }
      markTested(coverage, route.path, 'desktop')
      const snapshot = await page.snapshot()
      if (!privacyUrl) privacyUrl = (await footerLinks(page)).links.find(link => matchesLink(link, LINK_PATTERNS.privacy))?.href.split('#')[0] ?? null
      const personalForms = snapshot.forms.filter(form => form.fields.some(field => field.type !== 'hidden' && field.type !== 'submit' && PERSONAL_FIELD.test(`${field.name} ${field.label ?? ''} ${field.autocomplete ?? ''}`)))
        .map(form => `${form.selector} (${form.fields.map(field => field.label ?? field.name).filter(Boolean).join(', ')})`)
      const hasAgeGate = AGE_GATE.test(snapshot.text) || /\bage\b/i.test(snapshot.accessibilityTree.match(/dialog[^\n]*/g)?.join(' ') ?? '')
      const ref = await context.evidence.writeJson('dom', `Children and age checks on ${route.path}`, { text: snapshot.text.slice(0, 20_000), forms: snapshot.forms, requests: page.requests().map(request => ({ url: request.url, method: request.method, party: request.party })) })
      evidence.push(ref.id)
      pages.push({ route: route.path, text: snapshot.text, requests: page.requests(), personalForms, hasAgeGate, evidence: ref.id })
    })
  }

  if (childFacing) {
    let privacyText: string | null = null
    if (privacyUrl) {
      await withPage(context, 'desktop', async page => {
        const loaded = await visit(page, privacyUrl!)
        if (!loaded.ok) { unconcluded.push(`privacy policy could not be read (${loaded.problem})`); return }
        markTested(coverage, pathOf(privacyUrl!), 'desktop')
        privacyText = (await page.snapshot()).text
        evidence.push((await context.evidence.writeText('dom', `Privacy policy read for the parental notice (${pathOf(privacyUrl!)})`, privacyText)).id)
      })
    }
    const noticeSources = [privacyText ?? '', ...pages.map(entry => entry.text)]
    if (!noticeSources.some(text => PARENTAL_NOTICE.test(text))) findings.push(draft(context, CHECK_ID, {
      key: 'missing-parental-notice', route: privacyUrl ? pathOf(privacyUrl) : null, severity: 'high', confidence: 'likely', evidence: evidence.slice(),
      title: 'No notice for parents about children\'s data',
      expected: 'A site for children explains to parents what is collected from children and how parental consent is obtained',
      observed: privacyUrl ? `The privacy policy at ${pathOf(privacyUrl)} and the tested pages say nothing about parents, guardians or children's data` : 'No privacy policy link was found, and the tested pages say nothing about parents or children\'s data',
      reproduction: [privacyUrl ? `Open ${pathOf(privacyUrl)}` : 'Open the home page', 'Look for a section for parents or about children\'s privacy'],
      proposedFix: 'Add a children\'s privacy section addressed to parents (what is collected, why, parental consent, how to review or delete it).',
    }))
    const tracked = pages.map(entry => ({ entry, trackers: trackerRequests(context, entry.requests) })).filter(item => item.trackers.length)
    if (tracked.length) findings.push(draft(context, CHECK_ID, {
      key: 'child-route-tracking', route: tracked[0]!.entry.route, severity: 'high', confidence: 'confirmed', evidence: tracked.map(item => item.entry.evidence),
      title: 'Pages for children send tracking requests',
      expected: 'No analytics, advertising or profiling requests on pages directed at children without verifiable parental consent',
      observed: tracked.map(item => `${item.entry.route}: ${item.trackers.map(request => request.url).slice(0, 3).join(', ')}`).join('; '),
      reproduction: [`Open ${tracked[0]!.entry.route}`, `Watch the network for ${new URL(tracked[0]!.trackers[0]!.url).host}`],
      proposedFix: 'Remove tracking from the children\'s pages, or obtain verifiable parental consent before it runs.',
    }))
    for (const entry of pages) if (entry.personalForms.length && !PARENTAL_NOTICE.test(entry.text)) findings.push(draft(context, CHECK_ID, {
      key: 'child-data-form', route: entry.route, severity: 'medium', confidence: 'likely', evidence: [entry.evidence],
      title: 'A page for children asks for personal data without mentioning parents',
      expected: 'Personal data is collected from children only with a parental notice and consent on the page',
      observed: `${entry.route} has ${entry.personalForms.join('; ')}`,
      reproduction: [`Open ${entry.route}`, 'Look at the form fields'],
      proposedFix: 'Remove the personal fields, or add the parental notice and consent step before submission.',
    }))
    if (audience === 'mixed' && !pages.some(entry => AGE_SCREENING.test(entry.text))) findings.push(draft(context, CHECK_ID, {
      key: 'missing-age-screening', severity: 'medium', confidence: 'likely', evidence: pages.map(entry => entry.evidence),
      title: 'No age screening on a site with a mixed audience',
      expected: 'A mixed-audience site asks for age (neutrally) before collecting data from users who may be children',
      observed: `None of ${pages.map(entry => entry.route).join(', ')} asks for an age or date of birth`,
      reproduction: pages.map(entry => `Open ${entry.route}`),
      proposedFix: 'Add a neutral age screen before sign-up or data collection, and route children to a parental consent flow.',
    }))
  }

  if (ageRestricted) {
    const gated = pages.filter(entry => entry.hasAgeGate)
    if (!gated.length && pages.length) findings.push(draft(context, CHECK_ID, {
      key: 'missing-age-gate', route: pages[0]!.route, severity: 'high', confidence: 'likely', evidence: pages.map(entry => entry.evidence),
      title: 'No age gate where age-restricted products are sold',
      expected: 'Buyers confirm their age before seeing or buying age-restricted products, and the site says how eligibility is checked',
      observed: `No age check was found on ${pages.map(entry => entry.route).join(', ')}`,
      reproduction: pages.map(entry => `Open ${entry.route}`),
      proposedFix: 'Add an age gate to the age-restricted pages and an age check at checkout or delivery as the jurisdiction requires.',
    }))
    else if (gated.length) observations.push(`age gate found on ${gated.map(entry => entry.route).join(', ')}`)
    humanReview.push(review(context, 'eligibility-evidence',
      'Provide the eligibility evidence for the age-restricted products in each target country (how age is verified at checkout or delivery, and any licence required).',
      'An age gate on the page is not age verification; only the owner can evidence the actual eligibility process.', null, gated.map(entry => entry.evidence)))
  }
  humanReview.push(review(context, 'legal-adequacy',
    `Is the handling of ${childFacing ? 'children\'s data and parental consent' : 'minors and age-restricted sales'} adequate for the target countries?`,
    'Conductor checks notices, age gates and data flows it can observe; legal adequacy is always a human decision.', null, evidence.slice()))
  return outcome(CHECK_ID, { findings, unconcluded, evidence, humanReview, coverage, observations })
}
