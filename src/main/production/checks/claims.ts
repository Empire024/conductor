import type { AuditPage, CheckContext, CheckOutcome, ControlCheck, FindingDraft, HumanReviewItem } from '../../../shared/production'
import {
  browserProblem, draft, fold, markTested, normalise, outcome, planRoutes, review, throwIfAborted, visit, withPage,
} from './document-support'

/**
 * C12 Claims, reviews and dark patterns (docs/production-agent.md, M5). Every tested route is
 * inventoried for countdowns, stock and viewer counts, testimonials, marketing claims, badges,
 * preselected paid extras and confirm-shaming copy. Findings are decided by observation only: a
 * countdown that starts again after a reload, a stock count that changes without a purchase, the
 * same testimonial under different names, a paid extra ticked in advance, a decline option that
 * shames. Claims Conductor cannot verify (best, #1, guaranteed, award-winning, badges) become
 * review items for a person; they are never findings and never deleted.
 */

const CHECK_ID = 'claims'
/** Time for page scripts to render a countdown or count before it is read. */
const SETTLE_MS = 400
/** Long enough for a live countdown to fall by at least one second. */
const TICK_MS = 1_100

interface Inventory {
  countdowns: Array<{ index: number; text: string; seconds: number }>
  stock: Array<{ text: string; count: number }>
  viewers: Array<{ text: string; count: number }>
  testimonials: Array<{ text: string; author: string | null }>
  claims: string[]
  badges: string[]
  preselected: Array<{ label: string; name: string }>
  shaming: string[]
}

/** Runs in the page: reads everything the claims check looks at, without clicking anything. */
const INVENTORY_SCRIPT = `(() => {
  const norm = text => (text || '').replace(/\\s+/g, ' ').trim()
  const seconds = text => {
    const clock = /(\\d+):(\\d{2})(?::(\\d{2}))?/.exec(text)
    if (clock) return clock[3] !== undefined ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(clock[1]) * 60 + Number(clock[2])
    const units = /(?:(\\d+)\\s*d)?\\s*(?:(\\d+)\\s*h)?\\s*(?:(\\d+)\\s*m(?:in)?)?\\s*(?:(\\d+)\\s*s)?/i.exec(text)
    if (!units || !units[0].trim()) return null
    return (Number(units[1] || 0) * 86400) + (Number(units[2] || 0) * 3600) + (Number(units[3] || 0) * 60) + Number(units[4] || 0)
  }
  const visible = node => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
  const timers = [...new Set([
    ...document.querySelectorAll('[data-countdown], [class*="countdown" i], [id*="countdown" i], [class*="timer" i], [id*="timer" i]'),
    ...[...document.querySelectorAll('body *')].filter(node => node.children.length === 0 && /^\\s*\\d{1,}:\\d{2}(:\\d{2})?\\s*$/.test(node.textContent || '')),
  ])].filter(visible).slice(0, 10)
  const countdowns = timers.map((node, index) => ({ index, text: norm(node.textContent), seconds: seconds(norm(node.textContent)) })).filter(entry => entry.seconds !== null)
  const text = norm(document.body.innerText)
  const counts = (pattern) => [...text.matchAll(pattern)].slice(0, 10).map(match => ({ text: match[0], count: Number(match.slice(1).find(Boolean)) }))
  const stock = counts(/\\bonly (\\d+) (?:items? )?(?:left|remaining)|\\b(\\d+) (?:items? )?left in stock|posledn[ée] (\\d+) (?:ks|kusy)|zost[aá]va(?:j[uú])? (?:u[žz] )?(?:len )?(\\d+)|zb[ýy]v[aá] (?:u[žz] )?(?:jen )?(\\d+)/gi)
  const viewers = counts(/\\b(\\d+) (?:other )?(?:people|shoppers|customers|visitors) (?:are )?(?:viewing|looking at|watching|bought)|pr[aá]ve (?:si )?(?:to )?(?:pozer[aá]|prohl[ií][žz][ií]) (\\d+)/gi)
  const testimonials = [...document.querySelectorAll('blockquote, [class*="testimonial" i], [class*="review" i], [itemprop="review"]')]
    // The innermost match: a "testimonials" section holding several quotes is not itself one.
    .filter(node => !node.querySelector('blockquote, [class*="testimonial" i], [class*="review" i], [itemprop="review"]'))
    .slice(0, 50).map(node => {
      const authorNode = node.querySelector('cite, [class*="author" i], [itemprop="author"]')
      const author = authorNode ? norm(authorNode.textContent) : null
      const clone = node.cloneNode(true)
      clone.querySelectorAll('cite, [class*="author" i], [itemprop="author"]').forEach(child => child.remove())
      return { text: norm(clone.textContent).slice(0, 500), author }
    }).filter(entry => entry.text.length > 10)
  const claimPatterns = [/\\b(?:#1|number one|no\\.? ?1)\\b[^.!?]{0,80}/gi, /\\bthe best\\b[^.!?]{0,60}/gi, /\\bclinically (?:proven|tested)\\b[^.!?]{0,60}/gi,
    /\\b100 ?% (?:natural|organic|satisfaction|guaranteed|pure)\\b[^.!?]{0,40}/gi, /\\b(?:money[- ]back )?guarantee[d]?\\b[^.!?]{0,60}/gi, /\\baward[- ]winning\\b[^.!?]{0,60}/gi,
    /\\btrusted by [\\d,. ]+\\+?[^.!?]{0,40}/gi, /\\b[\\d,. ]+\\+? (?:happy|satisfied) customers\\b/gi, /\\bnajlep[šs][ií][^.!?]{0,60}/gi, /\\bnejlep[šs][ií][^.!?]{0,60}/gi, /\\b[čc][ií]slo 1\\b[^.!?]{0,60}/gi]
  const claims = [...new Set(claimPatterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => norm(match[0]).slice(0, 160))))].slice(0, 20)
  const badges = [...document.images].filter(image => /badge|award|certif|trust|seal|verified|guarantee/i.test((image.alt || '') + ' ' + image.src)).map(image => norm(image.alt) || image.src).slice(0, 10)
  const labelOf = input => norm((input.labels && input.labels[0] && input.labels[0].innerText) || input.getAttribute('aria-label') || input.name)
  const paid = /(?:\\+|€|\\$|£|kč|czk|eur)\\s?\\d|\\d\\s?(?:€|\\$|£|kč)|insurance|warranty|protection|donation|priority|express|extended|premium|poisten|z[aá]ruk|poji[šs]t[eě]n|pr[ií]platok|p[řr][ií]platek|dar\\b/i
  const consentLike = /newsletter|marketing|consent|terms|conditions|privacy|podmienk|podm[ií]nk|s[uú]hlas|souhlas|remember|zapam/i
  const preselected = [...document.querySelectorAll('input[type="checkbox"], input[type="radio"]')].filter(input => input.defaultChecked || input.hasAttribute('checked'))
    .map(input => ({ label: labelOf(input).slice(0, 200), name: input.name || input.id || '' }))
    .filter(entry => paid.test(entry.label) && !consentLike.test(entry.label))
  const shamingPatterns = [/\\bno,? thanks?,? i (?:don['’]t|do not) (?:want|like|need|care)[^.!?]{0,60}/i, /\\bi (?:don['’]t|do not) (?:want|like) (?:to )?(?:save|saving|discounts?|deals?)[^.!?]{0,40}/i,
    /\\bi (?:prefer|like) (?:to )?pay(?:ing)? full price/i, /\\bi['’]?(?:ll| will) pass on [^.!?]{0,40}/i, /\\bnie,? (?:[ďd]akujem,? )?nechcem (?:u[šs]etri[tť]|z[ľl]avu|[^.!?]{0,40})/i, /\\bne,? (?:d[eě]kuji,? )?nechci (?:u[šs]et[řr]it|slevu|[^.!?]{0,40})/i]
  const shaming = [...document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]')]
    .map(node => norm(node.innerText || node.value || node.getAttribute('aria-label'))).filter(label => shamingPatterns.some(pattern => pattern.test(label))).slice(0, 10)
  return { countdowns, stock, viewers, testimonials, claims, badges, preselected, shaming }
})()`

export const claimsCheck: ControlCheck = {
  controlId: 'C12',
  checkId: CHECK_ID,
  title: 'Claims, reviews and dark patterns: fake urgency, fake scarcity, duplicated testimonials, preselected extras, confirm-shaming',
  requires: ['browser'],
  run: runClaims,
}

const slug = (text: string): string => fold(text).split(' ').slice(0, 8).join('-').slice(0, 60) || 'item'
const inventoryOf = (page: AuditPage): Promise<Inventory> => page.evaluate<Inventory>(INVENTORY_SCRIPT)

async function runClaims(context: CheckContext): Promise<CheckOutcome> {
  const findings: FindingDraft[] = []
  const unconcluded: string[] = []
  const evidence: string[] = []
  const humanReview: HumanReviewItem[] = []
  const observations: string[] = []
  const { routes, coverage } = planRoutes(context)
  const noBrowser = await browserProblem(context)
  if (noBrowser) return outcome(CHECK_ID, { findings, unconcluded: [noBrowser], evidence, humanReview, coverage, observations })

  const testimonials: Array<{ route: string; text: string; author: string | null }> = []
  const reviewed = new Set<string>()
  const addReview = (key: string, question: string, why: string, route: string, refs: string[]): void => {
    if (reviewed.has(key) || humanReview.length >= 15) return
    reviewed.add(key)
    humanReview.push(review(context, key, question, why, route, refs))
  }

  for (const route of routes) {
    throwIfAborted(context)
    await withPage(context, 'desktop', async page => {
      const loaded = await visit(page, context.url(route.path))
      if (!loaded.ok) { unconcluded.push(`route ${route.path} could not be read (${loaded.problem})`); return }
      markTested(coverage, route.path, 'desktop')
      await page.waitFor(SETTLE_MS)
      const first = await inventoryOf(page)
      let second: Inventory | null = null
      let afterReload: Inventory | null = null
      if (first.countdowns.length || first.stock.length || first.viewers.length) {
        await page.waitFor(TICK_MS)
        second = await inventoryOf(page)
        const reloaded = await page.reload()
        if (reloaded.outcome === 'ok') { await page.waitFor(SETTLE_MS); afterReload = await inventoryOf(page) }
        else unconcluded.push(`route ${route.path} could not be reloaded (${reloaded.outcome}) to compare countdowns and counts`)
      }
      const ref = await context.evidence.writeJson('dom', `Claims inventory of ${route.path}`, { first, second, afterReload })
      evidence.push(ref.id)
      const refs = [ref.id]

      // Countdowns: live (they fell while watched) and restarting after a reload.
      for (const countdown of first.countdowns) {
        const later = second?.countdowns.find(entry => entry.index === countdown.index)
        const again = afterReload?.countdowns.find(entry => entry.index === countdown.index)
        if (!later || later.seconds >= countdown.seconds) { observations.push(`${route.path}: "${countdown.text}" did not count down while watched`); continue }
        // A real deadline never moves away: after a reload the countdown can only be lower (or the same second).
        if (again && again.seconds > later.seconds) findings.push(draft(context, CHECK_ID, {
          key: `countdown-reset:${countdown.index}`, route: route.path, component: 'countdown', severity: 'high', confidence: 'confirmed', evidence: refs,
          title: 'A countdown starts again when the page is reloaded',
          expected: 'A deadline shown as a countdown is real: after a reload it keeps counting down from where it was',
          observed: `It read ${countdown.text}, then ${later.text} ${Math.round(TICK_MS / 1000)} s later, and ${again.text} after a reload`,
          reproduction: [`Open ${route.path}`, 'Note the countdown', 'Reload the page', 'The countdown has gone back up'],
          proposedFix: 'Count down to a real, fixed deadline stored on the server, or remove the countdown.',
        }))
      }
      // Stock and viewer counts that change without a purchase.
      for (const [kind, before, after] of [['stock', first.stock, afterReload?.stock], ['viewers', first.viewers, afterReload?.viewers]] as const) {
        if (!after) continue
        before.forEach((entry, index) => {
          const next = after[index]
          if (next && next.count !== entry.count) findings.push(draft(context, CHECK_ID, {
            key: `${kind === 'stock' ? 'scarcity' : 'viewers'}-changes:${index}`, route: route.path, severity: 'medium', confidence: 'likely', evidence: refs,
            title: kind === 'stock' ? 'The "only N left" count changes on a reload without any purchase' : 'The "N people are viewing" count changes on a reload',
            expected: kind === 'stock' ? 'A stock figure shown to buyers reflects real stock' : 'A live-activity figure reflects real activity',
            observed: `"${entry.text}" became "${next.text}" after a reload, with no purchase made by the audit`,
            reproduction: [`Open ${route.path}`, `Note "${entry.text}"`, 'Reload the page'],
            proposedFix: kind === 'stock' ? 'Show stock from the inventory system, or remove the message.' : 'Show real activity data, or remove the message.',
          }))
          else if (kind === 'stock') addReview(`stock:${route.path}:${index}`, `Is "${entry.text}" on ${route.path} the real stock level?`, 'Scarcity messages must be true; Conductor can only see whether they change.', route.path, refs)
        })
      }
      // Paid extras ticked in advance, and decline options that shame.
      for (const extra of first.preselected) findings.push(draft(context, CHECK_ID, {
        key: `preselected-extra:${extra.name || slug(extra.label)}`, route: route.path, component: extra.name || null, severity: 'high', confidence: 'confirmed', evidence: refs,
        title: `A paid extra is selected in advance: "${extra.label}"`,
        expected: 'Extra paid options start unselected; the buyer opts in',
        observed: `"${extra.label}" is already ticked when ${route.path} loads`,
        reproduction: [`Open ${route.path}`, `Look at "${extra.label}" before touching anything`],
        proposedFix: 'Leave optional paid extras unticked by default.',
      }))
      for (const label of first.shaming) findings.push(draft(context, CHECK_ID, {
        key: `confirm-shaming:${slug(label)}`, route: route.path, severity: 'medium', confidence: 'likely', evidence: refs,
        title: 'A decline option shames the visitor',
        expected: 'Declining an offer is worded neutrally ("No, thanks")',
        observed: `The decline option reads "${label}"`,
        reproduction: [`Open ${route.path}`, `Find "${label}"`],
        proposedFix: 'Word the decline option neutrally.',
      }))
      for (const claim of first.claims) addReview(`claim:${slug(claim)}`, `Can the claim "${claim}" on ${route.path} be substantiated?`, 'Superlatives, guarantees and awards need evidence Conductor cannot see; they are never removed automatically.', route.path, refs)
      for (const badge of first.badges) addReview(`badge:${slug(badge)}`, `Is the badge "${badge}" on ${route.path} genuine and current?`, 'Trust badges and awards must be earned and current.', route.path, refs)
      for (const entry of first.testimonials) testimonials.push({ route: route.path, ...entry })
    })
  }

  // The same testimonial text under different names, or on several products as if from different people.
  const groups = new Map<string, typeof testimonials>()
  for (const entry of testimonials) {
    const key = fold(entry.text)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  for (const entries of groups.values()) {
    const authors = new Set(entries.map(entry => entry.author ?? '(anonymous)'))
    if (entries.length < 2 || authors.size < 2) continue
    findings.push(draft(context, CHECK_ID, {
      key: `duplicate-testimonial:${slug(entries[0]!.text)}`, scope: 'site', severity: 'medium', confidence: 'likely', evidence: evidence.slice(),
      title: 'The same testimonial appears under different names',
      expected: 'Each testimonial is a real customer\'s own words',
      observed: `"${normalise(entries[0]!.text).slice(0, 120)}" is attributed to ${[...authors].join(', ')} on ${[...new Set(entries.map(entry => entry.route))].join(', ')}`,
      reproduction: entries.map(entry => `Open ${entry.route} and read the testimonial by ${entry.author ?? 'an anonymous customer'}`),
      proposedFix: 'Show only genuine reviews with their real author, and remove templated ones.',
    }))
  }
  if (testimonials.length) observations.push(`${testimonials.length} testimonial(s) read on ${new Set(testimonials.map(entry => entry.route)).size} route(s)`)
  if (context.profile.facts.businessModel.value === 'b2b') observations.push('B2B-only: judged as misleading advertising; consumer review rules do not apply')
  return outcome(CHECK_ID, { findings, unconcluded, evidence, humanReview, coverage, observations })
}
