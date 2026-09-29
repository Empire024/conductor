import type { CheckContext, CheckOutcome, ControlCheck, FindingDraft, HumanReviewItem } from '../../../shared/production'
import { decideApplicability, factIsUnknown, jurisdictionsFor } from '../registry'
import {
  browserProblem, draft, footerLinks, LINK_PATTERNS, markTested, matchesLink, notRun, normalise, outcome, pathOf, planRoutes, review,
  throwIfAborted, visit, withPage,
} from './document-support'

/**
 * C15 Uploads and copyright (docs/production-agent.md, M5). Driven by applicability (userUploads).
 * When users can upload: a rights notice and a route to report content are always required; a
 * counter-notice route when US law applies or the project relies on a hosting safe harbor; a
 * designated agent and a repeat-infringer policy when it relies on the DMCA safe harbor. The
 * U.S. Copyright Office directory listing is never fetched: it is an owner question with an
 * evidence request.
 */

const CHECK_ID = 'uploads'

type UploadElement = 'rights-notice' | 'report-route' | 'counter-notice' | 'repeat-infringer' | 'designated-agent'
const PATTERNS: Record<UploadElement, RegExp> = {
  'rights-notice': /copyright|intellectual property|autorsk|pr[aá]va du[šs]evn|licen[cs]e to (?:show|use|display)|©/i,
  'report-route': /report (?:content|abuse|infringement|illegal|a photo|a post)|notice and (?:takedown|action)|takedown notice|nahl[aá]si[tť] (?:obsah|poru[šs]enie)|nahl[aá]sit (?:obsah|poru[šs]en[ií])/i,
  'counter-notice': /counter[- ]?notice|counter[- ]notification|protiozn[aá]men|n[aá]mietk|appeal (?:a|the) (?:removal|decision)|odvol[aá]n[ií]/i,
  'repeat-infringer': /repeat(?:ed)? infringers?|opakovan[ée]ho? poru[šs]/i,
  'designated-agent': /designated (?:dmca |copyright )?agent|dmca agent|copyright agent/i,
}
const LABELS: Record<UploadElement, string> = {
  'rights-notice': 'a copyright or rights notice for uploaded content',
  'report-route': 'a way to report illegal or infringing content (notice and action)',
  'counter-notice': 'a counter-notice or appeal route for removed content',
  'repeat-infringer': 'a repeat-infringer policy',
  'designated-agent': 'the contact of a designated DMCA agent',
}

export const uploadsCheck: ControlCheck = {
  controlId: 'C15',
  checkId: CHECK_ID,
  title: 'Uploads and copyright: rights notice, reporting route, counter-notice, repeat-infringer policy, designated agent',
  requires: ['browser'],
  run: runUploads,
}

/** Which elements the facts require, with why; `unknown` lists what could not be decided. */
export function requiredUploadElements(context: CheckContext): { required: Map<UploadElement, string>; unknown: string[] } {
  const facts = context.profile.facts
  const targets = jurisdictionsFor(facts.targetCountries)
  const safeHarbor = factIsUnknown(facts.safeHarborReliance) ? null : facts.safeHarborReliance.value === true
  const required = new Map<UploadElement, string>([
    ['rights-notice', 'hosting user content'],
    ['report-route', targets?.has('EU') ? 'Regulation (EU) 2022/2065 (DSA) Art. 16 notice and action' : 'hosting user content'],
  ])
  const unknown: string[] = []
  if (!targets) unknown.push('target countries unknown: jurisdiction-specific upload duties were not decided (owner question targetCountries)')
  if (targets?.has('US') || safeHarbor) required.set('counter-notice', safeHarbor ? '17 U.S.C. § 512(g) counter-notification' : 'US users: removal decisions need a counter-notice route')
  if (safeHarbor) {
    required.set('designated-agent', '17 U.S.C. § 512(c)(2) designated agent')
    required.set('repeat-infringer', '17 U.S.C. § 512(i) repeat-infringer policy')
  }
  if (safeHarbor === null && targets?.has('US')) unknown.push('safe-harbor reliance unknown: the DMCA agent and repeat-infringer duties were not decided (owner question safeHarborReliance)')
  return { required, unknown }
}

async function runUploads(context: CheckContext): Promise<CheckOutcome> {
  const decision = decideApplicability(context.control, context.profile.facts, context.profile.scope)
  if (decision.status === 'not-applicable') return notRun(CHECK_ID, 'NOT_APPLICABLE', decision.rationale)
  if (decision.status === 'unknown') return notRun(CHECK_ID, 'UNVERIFIED', decision.rationale)

  const findings: FindingDraft[] = []
  const evidence: string[] = []
  const humanReview: HumanReviewItem[] = []
  const observations: string[] = [decision.rationale]
  const { required, unknown } = requiredUploadElements(context)
  const unconcluded = [...unknown]
  const { routes, coverage } = planRoutes(context, undefined, 3)
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { findings, unconcluded: [noBrowser, ...unconcluded], evidence, humanReview, coverage, observations })

  const documents: Array<{ where: string; text: string; evidence: string }> = []
  const toFollow = new Set<string>()
  for (const route of routes) {
    throwIfAborted(context)
    await withPage(context, 'desktop', async page => {
      const loaded = await visit(page, context.url(route.path))
      if (!loaded.ok) { unconcluded.push(`route ${route.path} could not be read (${loaded.problem})`); return }
      markTested(coverage, route.path, 'desktop')
      const snapshot = await page.snapshot()
      const linkText = snapshot.links.map(link => link.text).join(' · ')
      const ref = await context.evidence.writeText('dom', `Upload and reporting text on ${route.path}`, `${snapshot.text}\n\nLinks: ${linkText}`)
      evidence.push(ref.id)
      documents.push({ where: route.path, text: `${snapshot.text}\n${linkText}`, evidence: ref.id })
      for (const link of [...(await footerLinks(page)).links, ...snapshot.links]) {
        if (!context.policy.allowedOrigins.includes(new URL(link.href).origin)) continue
        if (matchesLink(link, LINK_PATTERNS.uploads) || matchesLink(link, LINK_PATTERNS.terms)) toFollow.add(link.href.split('#')[0]!)
      }
    })
  }
  for (const url of [...toFollow].filter(url => !documents.some(document => context.url(document.where) === url)).slice(0, 4)) {
    throwIfAborted(context)
    await withPage(context, 'desktop', async page => {
      const loaded = await visit(page, url)
      if (!loaded.ok) { unconcluded.push(`${pathOf(url)} could not be read (${loaded.problem})`); return }
      markTested(coverage, pathOf(url), 'desktop')
      const text = (await page.snapshot()).text
      const ref = await context.evidence.writeText('dom', `Upload policy text at ${pathOf(url)}`, text)
      evidence.push(ref.id)
      documents.push({ where: pathOf(url), text, evidence: ref.id })
    })
  }

  const found = new Map<UploadElement, string[]>()
  for (const document of documents) for (const [element, pattern] of Object.entries(PATTERNS) as Array<[UploadElement, RegExp]>) {
    if (pattern.test(document.text)) found.set(element, [...(found.get(element) ?? []), document.where])
  }
  evidence.push((await context.evidence.writeJson('note', 'Upload duties required and where each was found', [...required].map(([element, why]) => ({ element, why, foundOn: found.get(element) ?? [] })))).id)
  for (const [element, why] of required) {
    if (found.get(element)?.length) continue
    findings.push(draft(context, CHECK_ID, {
      key: `missing:${element}`, severity: element === 'rights-notice' ? 'medium' : 'high', confidence: 'likely', evidence: documents.map(document => document.evidence),
      title: `No ${LABELS[element]}`,
      expected: `The site offers ${LABELS[element]} (${why})`,
      observed: `Not found on ${documents.map(document => document.where).join(', ')}`,
      reproduction: documents.map(document => `Open ${document.where}`),
      proposedFix: `Publish ${LABELS[element]} and link it from the footer next to the terms.`,
    }))
  }

  if (required.has('designated-agent')) {
    // The labelled statement ("Designated DMCA agent: name, address") before a passing mention of the agent.
    const find = (pattern: RegExp) => documents.map(document => ({ document, match: pattern.exec(document.text) })).find(item => item.match)
    const agent = find(/designated (?:dmca |copyright )?agent\s*:[^\n]{0,200}/i) ?? find(/designated (?:dmca |copyright )?agent[^.\n]{0,200}/i)
    if (agent) observations.push(`designated agent on the site (${agent.document.where}): ${normalise(agent.match![0]).slice(0, 200)}`)
    humanReview.push(review(context, 'dmca-directory-listing',
      `Provide the U.S. Copyright Office DMCA Designated Agent Directory entry for this service (registered entity, the domains it lists, and the renewal date) so it can be matched with ${agent ? `the agent named on ${agent.document.where}` : 'the site'}.`,
      'Safe-harbor protection depends on a current directory registration that names this service; Conductor never fetches registration data, so the owner supplies the listing as evidence.',
      agent?.document.where ?? null, agent ? [agent.document.evidence] : []))
  }
  humanReview.push(review(context, 'legal-adequacy',
    'Are the notice-and-action, counter-notice and copyright policies adequate for the uploads this service hosts?',
    'Conductor checks that the routes and statements exist; how they work in practice and whether they satisfy the law is a human decision.', null, documents.map(document => document.evidence)))
  return outcome(CHECK_ID, { findings, unconcluded, evidence, humanReview, coverage, observations })
}
