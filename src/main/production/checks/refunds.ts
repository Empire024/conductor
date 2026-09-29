import type { CheckContext, CheckOutcome, CommerceOrder, ControlCheck } from '../../../shared/production'
import { decideApplicability, EU_MEMBER_STATES } from '../registry'
import {
  browserProblem, draft, excerpt, isAllowed, linkMatches, markTested, mutate, mutationBlocked, newParts, normalise, notRun, outcome, pathOf,
  REFUND_MUTATION, review, routesTagged, throwIfAborted, unobservable, visit, withPage, type OutcomeParts,
} from './commerce-support'

/**
 * C11 Refunds and withdrawal (docs/production-agent.md, M6). Read-only: a refund/withdrawal policy
 * exists and is linked from the checkout (before purchase); the periods stated on the policy,
 * product and checkout pages agree; for EU consumers the withdrawal period is not shorter than 14
 * days. A blanket "no refunds" statement is a human-review item, never decided here. With a
 * sandbox write authorization naming `refund-request` and a commerce adapter, one refund is
 * requested for the newest sandbox order (recorded only, never a gateway refund) and its outcome
 * compared with the policy. Legal adequacy is always a human's call (humanReviewAlways).
 */

const CHECK_ID = 'refunds'

export const refundsCheck: ControlCheck = {
  controlId: 'C11',
  checkId: CHECK_ID,
  title: 'Refunds and withdrawal: policy before purchase, consistent periods, blanket refusals reviewed, sandbox refund request',
  requires: ['browser', 'sandbox-writes', 'commerce-sandbox'],
  run: runRefunds,
}

const REFUND_LINK = /refund|returns?\b|withdraw|money[- ]back|vr[aá]ten|odst[úu]pen|reklamac|vr[aá]cen|odstoupen/i
const REFUND_TOPIC = /refund|return|withdraw|money[- ]back|vr[aá]t|odst[úu]p|odstoup/i
const PERIOD = /(\d{1,3})\s*(?:-\s*)?(?:calendar |working |business )?(?:days?|dn[ií]|dni|d[ňn]a|dn[uů])\b/gi
const BLANKET = /no refunds?|all sales (?:are )?final|non-?refundable|(?:do|will) not (?:accept returns|offer (?:any )?refunds|refund)|nevraciame|bez mo[žz]nosti vr[aá]tenia|nevrac[ií]me|vr[aá]tenie nie je mo[žz]n/i
const EU_TARGETS = new Set(['EU', ...EU_MEMBER_STATES])

interface PageRead { route: string; kind: 'policy' | 'product' | 'checkout'; text: string; links: Array<{ text: string; href: string }> }

async function runRefunds(context: CheckContext): Promise<CheckOutcome> {
  const decision = decideApplicability(context.control, context.profile.facts, context.profile.scope)
  if (decision.status === 'not-applicable') return notRun(CHECK_ID, 'NOT_APPLICABLE', decision.rationale)
  if (decision.status === 'unknown') return notRun(CHECK_ID, 'UNVERIFIED', decision.rationale)

  const parts = newParts()
  parts.observations.push(decision.rationale)
  parts.humanReview.push(review(context, 'legal-adequacy', 'Do the refund and withdrawal terms meet the consumer law of every target country (period, model form, refund deadline, exceptions)?', 'C11 always needs a human to confirm legal adequacy; the audit only checks presence, placement and consistency.'))
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { ...parts, unconcluded: [noBrowser] })

  const pages: PageRead[] = []
  const read = async (route: string, kind: PageRead['kind']): Promise<PageRead | null> => {
    throwIfAborted(context)
    return await withPage(context, async page => {
      const loaded = await visit(page, context.url(route))
      if (!loaded.ok) { parts.unconcluded.push(`${kind} route ${route} could not be read (${loaded.problem})`); return null }
      markTested(parts.coverage, route, 'desktop')
      const snapshot = await page.snapshot()
      const entry = { route, kind, text: normalise(snapshot.text), links: snapshot.links }
      pages.push(entry)
      return entry
    })
  }

  // The policy: a tagged route, else a link from the home page.
  let policyRoute = routesTagged(context, ['refunds'], parts.coverage, 1)[0]?.path ?? null
  if (!policyRoute) {
    const home = await read('/', 'product')
    const link = home?.links.find(item => linkMatches(item, REFUND_LINK) && isAllowed(context, item.href))
    if (link) policyRoute = pathOf(link.href)
    if (home) pages.splice(pages.indexOf(home), 1)
  }
  const policy = policyRoute ? await read(policyRoute, 'policy') : null
  if (!policyRoute) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'no-refund-policy', title: 'No refund or withdrawal policy found',
      expected: 'A returns, refunds or withdrawal page linked from the site', observed: 'No route tagged `refunds` and no such link on the home page',
      severity: 'high', confidence: 'likely', reproduction: ['Open the home page', 'Look for a returns/refunds/withdrawal link'],
      proposedFix: 'Publish a returns and withdrawal policy and link it from the footer, product pages and checkout.',
    }))
  }
  for (const route of routesTagged(context, ['product'], parts.coverage, 2)) await read(route.path, 'product')
  const checkoutRoute = routesTagged(context, ['checkout'], parts.coverage, 1)[0]?.path ?? null
  const checkout = checkoutRoute ? await read(checkoutRoute, 'checkout') : null

  // Before purchase: the checkout links to the policy.
  if (!checkoutRoute) parts.unconcluded.push('no checkout route in scope (tag `checkout`): whether the policy is shown before purchase was not checked')
  else if (checkout && policyRoute) {
    const linked = checkout.links.some(item => isAllowed(context, item.href) && (pathOf(item.href) === policyRoute || linkMatches(item, REFUND_LINK)))
    if (!linked) {
      parts.findings.push(draft(context, CHECK_ID, {
        key: 'refund-policy-not-before-purchase', route: checkoutRoute, title: 'The checkout does not link to the refund and withdrawal policy',
        expected: `A link to ${policyRoute} on ${checkoutRoute}, before the order is placed`, observed: `${checkoutRoute} links to ${checkout.links.map(item => pathOf(item.href)).slice(0, 12).join(', ') || 'nothing'}`,
        severity: 'high', confidence: 'confirmed', reproduction: [`Open ${checkoutRoute}`, 'Look for the returns/withdrawal policy before "Place order"'],
        proposedFix: 'Link the returns and withdrawal policy next to the order button.',
      }))
    }
  }

  const blanket = blanketStatement(context, parts, pages)
  periods(context, parts, pages, blanket)
  await refundJourney(context, parts, policy, blanket)
  return outcome(CHECK_ID, { ...parts, floor: blanket ? 'NEEDS_HUMAN_REVIEW' : 'PASS' })
}

function blanketStatement(context: CheckContext, parts: OutcomeParts, pages: PageRead[]): boolean {
  const hits = pages.map(page => ({ page, text: excerpt(page.text, BLANKET) })).filter((hit): hit is { page: PageRead; text: string } => !!hit.text)
  if (!hits.length) return false
  parts.humanReview.push(review(context, 'blanket-no-refunds',
    `The site says refunds are never given ("${hits[0]!.text}"). Is that lawful for every product and target country (statutory withdrawal right, defective goods)?`,
    'A blanket refusal can conflict with mandatory consumer rights; only a human can judge the exceptions that may apply.',
    hits[0]!.page.route))
  parts.observations.push(`Blanket no-refund statement on ${hits.map(hit => hit.page.route).join(', ')}`)
  return true
}

function periods(context: CheckContext, parts: OutcomeParts, pages: PageRead[], blanket: boolean): void {
  const stated: Array<{ route: string; days: number; sentence: string }> = []
  for (const page of pages) {
    for (const sentence of page.text.split(/(?<=[.!?])\s+/)) {
      if (!REFUND_TOPIC.test(sentence)) continue
      for (const match of sentence.matchAll(PERIOD)) stated.push({ route: page.route, days: Number(match[1]), sentence: sentence.slice(0, 240) })
    }
  }
  // The period a page states for returns is its smallest number of days (refund deadlines are usually equal or longer).
  const byRoute = new Map<string, { days: number; sentence: string }>()
  for (const entry of stated) {
    const current = byRoute.get(entry.route)
    if (!current || entry.days < current.days) byRoute.set(entry.route, { days: entry.days, sentence: entry.sentence })
  }
  if (!byRoute.size) {
    if (!blanket) parts.unconcluded.push('no refund or withdrawal period is stated on the pages read')
    return
  }
  parts.observations.push(`Stated periods: ${[...byRoute].map(([route, item]) => `${route} ${item.days} days`).join('; ')}`)
  const distinct = [...new Set([...byRoute.values()].map(item => item.days))]
  if (distinct.length > 1) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'inconsistent-refund-periods', title: 'Pages state different refund or return periods',
      expected: 'One period, stated the same way on the policy, product pages and checkout',
      observed: [...byRoute].map(([route, item]) => `${route}: "${item.sentence}"`).join(' | '),
      severity: 'high', confidence: 'confirmed', reproduction: [...byRoute.keys()].map(route => `Open ${route}`),
      proposedFix: 'State one return/withdrawal period everywhere, matching the policy.',
    }))
  }
  const targets = context.profile.facts.targetCountries.value ?? []
  const consumer = context.profile.facts.businessModel.value !== 'b2b'
  const shortest = Math.min(...distinct)
  if (consumer && targets.some(code => EU_TARGETS.has(code.toUpperCase())) && shortest < 14) {
    const where = [...byRoute].find(([, item]) => item.days === shortest)!
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'withdrawal-period-below-14-days', route: where[0], title: 'Withdrawal period shorter than 14 days for EU consumers',
      expected: 'At least 14 days to withdraw from a distance contract (EU consumers)', observed: `"${where[1].sentence}"`,
      severity: 'high', confidence: 'likely', reproduction: [`Open ${where[0]}`],
      proposedFix: 'Give EU consumers at least 14 days from delivery to withdraw, and say so consistently.',
    }))
  }
}

async function refundJourney(context: CheckContext, parts: OutcomeParts, policy: PageRead | null, blanket: boolean): Promise<void> {
  const blocked = mutationBlocked(context, REFUND_MUTATION, 'the sandbox refund request')
  const adapter = context.adapters.commerce
  const missing = blocked ?? (!adapter ? 'no commerce sandbox adapter: the sandbox refund request was not made' : null)
  if (missing) {
    parts.unconcluded.push(missing)
    unobservable(parts.coverage, 'sandbox refund request outcome not observed')
    return
  }
  let order: CommerceOrder | undefined
  try { order = (await adapter!.orders(null)).find(item => /^(completed|processing|wc-completed|wc-processing)$/i.test(item.status)) } catch (error) {
    parts.unconcluded.push(`commerce adapter could not list orders: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!order) { parts.unconcluded.push('no completed or processing sandbox order to request a refund for'); return }
  const done = await mutate(context, REFUND_MUTATION, `refund request for sandbox order ${order.id}`,
    () => adapter!.requestRefund(order!.id, 'Conductor production audit: sandbox refund request (recorded only, no payment is refunded)'))
  if (!done.ok) { parts.unconcluded.push(done.reason); return }
  parts.evidence.push((await context.evidence.writeJson('log', `sandbox refund request for order ${order.id}`, { order: order.id, total: order.total, ...done.value })).id)
  parts.observations.push(`Sandbox refund request for order ${order.id}: ${done.value.accepted ? 'accepted' : 'refused'} (${done.value.detail})`)
  if (!done.value.accepted && !blanket && policy) {
    parts.findings.push(draft(context, CHECK_ID, {
      key: 'refund-request-refused', scope: 'journey', route: policy.route, title: 'The shop refused a refund its policy promises',
      expected: `A refund request within the policy on ${policy.route} is accepted`, observed: `Sandbox order ${order.id}: ${done.value.detail}`,
      severity: 'high', confidence: 'confirmed', reproduction: [`Request a refund for sandbox order ${order.id}`],
      proposedFix: 'Make the refund process honour the published policy.',
    }))
  }
}
