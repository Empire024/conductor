import type { AuditPage, CheckContext, ControlCheck, HumanReviewItem, ObservedRequest, Severity } from '../../../shared/production'
import {
  FindingSet, applicabilityGuard, browserProblem, budgetProblem, draft, emptyCoverage, hostOf, markTested, mergeCoverage, notRun, outcome, planRoutes,
  review, throwIfAborted, vendorOf, visit, withPage, type VendorCategory, type VendorMatch,
} from './technical-support'

/**
 * C05 Vendors, external fonts and AI (docs/production-agent.md module M4). Every tested route is
 * opened with consent accepted (so every vendor that can load does), and every third-party request is
 * grouped by vendor: known vendors by signature, anything else by host. Each vendor is reconciled
 * with the profile's processors and the privacy and cookie notices the site links to; one named in
 * neither is a finding. Remote fonts are an internal-quality WARN (a self-hosting preference, never a
 * legal finding by itself). When runtime AI is declared, the tested pages must tell visitors they are
 * dealing with AI; a human confirms placement. An AI vendor seen while none is declared is a finding.
 */

export interface VendorsCheckOptions {
  maxRoutes?: number
  maxNotices?: number
  settleMs?: number
}

const CHECK_ID = 'vendors'
const NOTICE_LINK = /privacy|cookie|gdpr|data.?protection|ochrana.?osobn|osobn[yý]ch.?[uú]daj|z[aá]sady|datenschutz|processors|subprocessors/i
const AI_DISCLOSURE = /\b(ai|a\.i\.)[- ](assistant|chat|chatbot|generated|powered|model)|artificial intelligence|you are (chatting|talking) (with|to) (an? )?(ai|bot|virtual)|chatbot|um[eě]l(a|á) inteligenci|generovan[eéý] (pomocou|pomoc[ií]) (ai|um[eě]l)|k[uü]nstliche intelligenz/i
const NOT_A_PROCESSOR: readonly VendorCategory[] = ['fonts']

interface VendorEntry {
  match: VendorMatch
  hosts: Set<string>
  types: Set<string>
  routes: Set<string>
  requests: number
  sample: string
}

export function createVendorsCheck(options: VendorsCheckOptions = {}): ControlCheck {
  const maxRoutes = options.maxRoutes ?? 6
  const maxNotices = options.maxNotices ?? 3
  const settleMs = options.settleMs ?? 2000
  return {
    controlId: 'C05',
    checkId: CHECK_ID,
    title: 'Third-party vendors against processors and notices, remote fonts and AI disclosures',
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
      const vendors = new Map<string, VendorEntry>()
      const noticeLinks = new Set<string>()
      const pageTexts: Array<{ route: string; text: string }> = []

      for (const route of plan.routes) {
        throwIfAborted(context)
        try {
          await withPage(context, 'desktop', 'clean', async page => {
            const loaded = await visit(page, context.url(route.path))
            if (!loaded.ok) { unconcluded.push(loaded.problem!); return }
            const consent = await page.consent({ action: 'accept' }).catch(() => ({ applied: false, mechanism: null }))
            await page.waitFor(settleMs)
            const snapshot = await page.snapshot()
            pageTexts.push({ route: route.path, text: snapshot.text })
            for (const link of snapshot.links) if (NOTICE_LINK.test(`${link.text} ${link.href}`) && isAllowed(context, link.href)) noticeLinks.add(link.href.split('#')[0]!)
            collect(vendors, page.requests(), route.path)
            markTested(coverage, route.path, 'desktop', consent.applied ? 'accepted' : 'clean')
          })
        } catch (error) {
          unconcluded.push(`${route.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // The notices the site links to, plus policy routes the profile names.
      for (const route of context.routes({ tags: ['privacy', 'cookies', 'policy'] })) if (route.coverage !== 'excluded') noticeLinks.add(context.url(route.path))
      const notices: Array<{ url: string; text: string }> = []
      for (const url of [...noticeLinks].slice(0, maxNotices)) {
        try {
          await withPage(context, 'desktop', 'clean', async page => {
            const loaded = await visit(page, url)
            if (loaded.ok) notices.push({ url, text: (await page.snapshot()).text })
          })
        } catch { /* an unreadable notice counts as not naming anyone */ }
      }
      if (!notices.length) observations.push('No privacy or cookie notice was found to reconcile vendors against; only the profile processors were used.')

      const processors = (context.profile.facts.processors.value ?? []).map(fold)
      const noticeText = fold(notices.map(notice => notice.text).join(' '))
      const inventory = [...vendors.values()].map(entry => ({
        vendor: entry.match.name, category: entry.match.category, needsConsent: entry.match.consent, hosts: [...entry.hosts], types: [...entry.types],
        routes: [...entry.routes], requests: entry.requests, disclosed: disclosure(entry, processors, noticeText),
      }))
      const inventoryRef = await context.evidence.writeJson('requests', 'C05 third-party vendor inventory with disclosure reconciliation', {
        notices: notices.map(notice => notice.url), processors: context.profile.facts.processors.value, vendors: inventory,
      })
      evidence.push(inventoryRef.id)

      for (const entry of vendors.values()) {
        const where = [...entry.routes][0] ?? null
        if (entry.match.category === 'fonts' || entry.types.has('font')) {
          findings.add(draft(context, CHECK_ID, {
            key: `remote-font:${entry.match.key}`, route: where, scope: 'site', category: 'internal-quality', severity: 'low', confidence: 'confirmed',
            title: `Fonts load from ${entry.match.name}`, expected: 'Web fonts are self-hosted, so no visitor IP address reaches a font vendor.',
            observed: `${[...entry.hosts].join(', ')} served ${entry.requests} request(s) (${[...entry.types].join(', ')}) on ${[...entry.routes].join(', ')}.`,
            evidence: [inventoryRef.id], proposedFix: 'Download the font files and serve them from the site itself.',
          }))
          if (NOT_A_PROCESSOR.includes(entry.match.category)) continue
        }
        if (entry.match.category === 'ai' && context.profile.facts.aiRuntime.value === false) {
          findings.add(draft(context, CHECK_ID, {
            key: `undeclared-ai-vendor:${entry.match.key}`, route: where, severity: 'medium', confidence: 'confirmed',
            title: `The pages call ${entry.match.name} although no runtime AI is declared`,
            expected: 'Runtime AI features are declared in the profile and disclosed to visitors.', observed: entry.sample,
            evidence: [inventoryRef.id], proposedFix: 'Record the AI feature in the profile (aiRuntime) and add the disclosure, or remove the call.',
          }))
        }
        if (disclosure(entry, processors, noticeText) !== 'none') continue
        findings.add(draft(context, CHECK_ID, {
          key: `undisclosed-vendor:${entry.match.key}`, route: where, scope: 'site', severity: severityFor(entry.match), confidence: entry.match.generic ? 'likely' : 'confirmed',
          title: `${entry.match.name} receives visitor data but is named neither in the processors nor in the notices`,
          expected: 'Every third party that receives visitor data (at least the IP address) is listed as a processor or recipient in the privacy notice.',
          observed: `${entry.requests} request(s) to ${[...entry.hosts].join(', ')} (${entry.match.category}; ${[...entry.types].join(', ')}) on ${[...entry.routes].join(', ')}; not found in ${notices.length} notice(s) or the ${processors.length} processor(s) of the profile.`,
          reproduction: [`Open ${where ?? '/'} and accept cookies`, `Watch requests to ${[...entry.hosts][0]}`],
          evidence: [inventoryRef.id],
          proposedFix: `Name ${entry.match.name} (purpose, legal basis, transfer safeguards) in the privacy notice and the profile's processors, or remove it.`,
        }))
      }

      if (context.profile.facts.aiRuntime.value === true) {
        const disclosed = pageTexts.filter(item => AI_DISCLOSURE.test(item.text))
        if (!disclosed.length) {
          findings.add(draft(context, CHECK_ID, {
            key: 'ai-disclosure-missing', scope: 'site', severity: 'medium', confidence: 'likely',
            title: 'Runtime AI is declared, but no tested page tells visitors they are dealing with AI',
            expected: 'Where people interact with an AI system or see AI-generated content, they are told so (AI Act art. 50).',
            observed: `None of ${pageTexts.length} tested page(s) contains an AI disclosure.`, evidence: [inventoryRef.id],
            proposedFix: 'Label each AI feature ("You are chatting with an AI assistant", "AI-generated") where the visitor meets it.',
          }))
        } else {
          observations.push(`AI disclosure text found on ${disclosed.map(item => item.route).join(', ')}.`)
        }
        humanReview.push(review(context, 'ai-disclosure-placement',
          'Is every AI feature (chat, generated text or images) labelled where the visitor meets it, before or at first interaction?',
          'The audit finds disclosure text on a page but cannot tell whether it sits at the feature.'))
      }

      observations.push(...inventory.map(item => `${item.vendor} (${item.category}${item.needsConsent ? ', needs consent' : ''}): ${item.requests} request(s), disclosed: ${item.disclosed}`))
      if (!inventory.length) observations.push('No third-party requests on the tested routes.')
      const budget = budgetProblem(context)
      if (budget) unconcluded.push(budget)
      return outcome(CHECK_ID, { findings: findings.list(), unconcluded, evidence, humanReview, coverage, observations })
    },
  }
}

export const vendorsCheck = createVendorsCheck()

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const isAllowed = (context: CheckContext, url: string): boolean => { try { return context.policy.allowedOrigins.includes(new URL(url).origin) } catch { return false } }

function collect(vendors: Map<string, VendorEntry>, requests: ReturnType<AuditPage['requests']>, route: string): void {
  for (const request of requests as ObservedRequest[]) {
    if (request.party !== 'third-party' || request.blocked || request.resourceType === 'document' && request.initiator !== 'page') continue
    const match = vendorOf(request.url)
    const entry = vendors.get(match.key) ?? { match, hosts: new Set<string>(), types: new Set<string>(), routes: new Set<string>(), requests: 0, sample: `${request.method} ${request.url.split('?')[0]}` }
    entry.hosts.add(hostOf(request.url))
    entry.types.add(request.resourceType)
    entry.routes.add(route)
    entry.requests++
    vendors.set(match.key, entry)
  }
}

/** Registrable-looking part of a host: the last two labels (enough to match "google-analytics.com" in a notice). */
const registrable = (host: string): string => host.split('.').slice(-2).join('.')

function disclosure(entry: VendorEntry, processors: readonly string[], noticeText: string): 'processors' | 'notice' | 'none' {
  const needles = [fold(entry.match.generic ? '' : entry.match.name), ...[...entry.hosts].flatMap(host => [host, registrable(host)])].filter(needle => needle.length >= 3)
  if (processors.some(processor => needles.some(needle => processor.includes(needle) || (needle.length >= 5 && needle.includes(processor))))) return 'processors'
  if (needles.some(needle => noticeText.includes(needle))) return 'notice'
  return 'none'
}

function severityFor(match: VendorMatch): Severity {
  return ['analytics', 'advertising', 'replay', 'social', 'video', 'chat', 'maps', 'ai'].includes(match.category) ? 'medium' : 'low'
}
