import type { AuditPage, CheckContext, ControlCheck, HumanReviewItem, ObservedRequest, SyntheticValue } from '../../../shared/production'
import {
  FindingSet, applicabilityGuard, browserProblem, budgetProblem, draft, emptyCoverage, hostOf, markTested, mergeCoverage, notRun, outcome, planRoutes, review,
  requestsCarrying, throwIfAborted, vendorOf, visit, withPage,
} from './technical-support'

/**
 * C06 Session replay (docs/production-agent.md module M4). With consent accepted (the worst case,
 * when every recorder runs), each tested route is searched for replay SDKs: known vendors by request
 * and script URL, and the globals the common recorders define. Synthetic values are then typed into
 * password, email, card-like and message fields, the page is left (a real pagehide, which makes the
 * recorders flush), and every outbound request is searched for the markers. A typed password or card
 * number leaving the page is critical; an email or message is high. A recorder the profile does not
 * declare is a finding on its own. Payloads the audit cannot read (compressed or binary) leave the
 * masking question UNVERIFIED, never PASS.
 */

export interface ReplayCheckOptions {
  maxRoutes?: number
  /** How long typed input is left for recorders to batch before the page is left. */
  settleMs?: number
}

const CHECK_ID = 'replay'
/** Globals the common recorders define; `rrweb` covers self-hosted recorders built on it. */
const REPLAY_GLOBALS: Array<[string, string]> = [
  ['hj', 'Hotjar'], ['clarity', 'Microsoft Clarity'], ['FS', 'FullStory'], ['LogRocket', 'LogRocket'], ['_mfq', 'Mouseflow'], ['mouseflow', 'Mouseflow'],
  ['smartlook', 'Smartlook'], ['__insp', 'Inspectlet'], ['_lo', 'Lucky Orange'], ['_uxa', 'Contentsquare'], ['DD_RUM', 'Datadog RUM'],
  ['ym', 'Yandex Metrica'], ['rrweb', 'rrweb'], ['__rrweb', 'rrweb'], ['OpenReplay', 'OpenReplay'],
]
const INPUT_SCRIPT = `(() => {
  const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' }
  const out = []
  let index = 0
  for (const element of document.querySelectorAll('input, textarea')) {
    if (!visible(element) || element.disabled || element.readOnly) continue
    const type = (element.getAttribute('type') || (element.tagName === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase()
    const text = [element.name, element.id, element.getAttribute('autocomplete'), element.getAttribute('placeholder'), element.labels && element.labels[0] ? element.labels[0].innerText : ''].join(' ').toLowerCase()
    let kind = null
    if (type === 'password') kind = 'password'
    else if (/cc-number|card|kart|cvc|cvv/.test(text)) kind = 'card'
    else if (type === 'email' || /mail/.test(text)) kind = 'email'
    else if (type === 'textarea' || /message|comment|note|spr[aá]v/.test(text)) kind = 'message'
    if (!kind) continue
    element.setAttribute('data-conductor-replay-field', String(index))
    out.push({ selector: '[data-conductor-replay-field="' + index + '"]', kind })
    index++
    if (out.length >= 12) break
  }
  return out
})()`

interface Detection { vendor: string; via: string }

export function createReplayCheck(options: ReplayCheckOptions = {}): ControlCheck {
  const maxRoutes = options.maxRoutes ?? 4
  const settleMs = options.settleMs ?? 3000
  return {
    controlId: 'C06',
    checkId: CHECK_ID,
    title: 'Replay SDKs and synthetic-marker capture from sensitive fields',
    requires: ['browser'],
    async run(context) {
      const guard = applicabilityGuard(context, CHECK_ID)
      if (guard) return guard
      const missingBrowser = await browserProblem(context)
      if (missingBrowser) return notRun(CHECK_ID, 'UNVERIFIED', missingBrowser)

      const declared = context.profile.facts.sessionReplay.value === true
      const tagged = planRoutes(context, { tags: ['form'] }, maxRoutes)
      const plan = tagged.routes.length ? tagged : planRoutes(context, undefined, maxRoutes)
      const coverage = mergeCoverage(emptyCoverage(), plan.coverage)
      const findings = new FindingSet()
      const unconcluded: string[] = []
      const evidence: string[] = []
      const humanReview: HumanReviewItem[] = []
      const observations: string[] = []
      const detections = new Map<string, Detection>()
      let typedAnywhere = 0
      let replayRequests: ObservedRequest[] = []

      for (const [index, route] of plan.routes.entries()) {
        throwIfAborted(context)
        const leave = plan.routes[(index + 1) % plan.routes.length]!
        try {
          await withPage(context, 'desktop', 'clean', async page => {
            const loaded = await visit(page, context.url(route.path))
            if (!loaded.ok) { unconcluded.push(loaded.problem!); return }
            const consent = await page.consent({ action: 'accept' }).catch(() => ({ applied: false, mechanism: null }))
            await page.waitFor(Math.min(settleMs, 1500))
            for (const detection of await detect(page)) detections.set(detection.vendor, detection)

            const fields = await page.evaluate<Array<{ selector: string; kind: SyntheticValue['kind'] }>>(INPUT_SCRIPT).catch(() => [])
            const typed: SyntheticValue[] = []
            for (const field of fields) {
              const value = context.synthetic(field.kind)
              try { await page.fill(field.selector, value); typed.push(value) } catch { /* not fillable in practice */ }
            }
            typedAnywhere += typed.length
            if (typed.length) {
              await page.keyboard(['Tab']).catch(() => [])
              await page.waitFor(settleMs)
              // Leaving the page is a real pagehide: recorders flush their buffers on it.
              const target = leave.path === route.path ? context.url('/') : context.url(leave.path)
              await page.goto(target, { waitMs: Math.min(settleMs, 1000) })
            }
            for (const detection of await detect(page)) detections.set(detection.vendor, detection)
            const sent = page.requests().filter(request => !request.blocked && !(request.resourceType === 'document' && request.initiator !== 'page'))
            replayRequests = replayRequests.concat(sent.filter(request => vendorOf(request.url).category === 'replay' || request.party === 'third-party'))
            const leaked: Array<{ value: SyntheticValue; request: ObservedRequest }> = []
            for (const value of typed) for (const request of requestsCarrying(sent, value.marker)) leaked.push({ value, request })
            const ref = await context.evidence.writeJson('requests', `C06 requests after typing into sensitive fields on ${route.path}`, {
              route: route.path, consent, fields: fields.map(field => field.kind), typed: typed.map(value => value.kind),
              detections: [...detections.values()],
              requests: sent.filter(request => request.party === 'third-party').map(request => ({ url: request.url, method: request.method, type: request.resourceType, excerpt: request.excerpt })),
              leaked: leaked.map(item => ({ kind: item.value.kind, url: item.request.url, method: item.request.method })),
            })
            evidence.push(ref.id)
            markTested(coverage, route.path, 'desktop', consent.applied ? 'accepted' : 'clean')
            // A leak to a host that also served a recorder belongs to that recorder (its collector often has a generic path).
            const recorderOnHost = new Map<string, ReturnType<typeof vendorOf>>()
            for (const request of page.requests()) { const vendor = vendorOf(request.url); if (vendor.category === 'replay') recorderOnHost.set(hostOf(request.url), vendor) }
            for (const { value, request } of leaked) {
              const vendor = recorderOnHost.get(hostOf(request.url)) ?? vendorOf(request.url)
              const sensitive = value.kind === 'password' || value.kind === 'card'
              findings.add(draft(context, CHECK_ID, {
                key: `captures-${value.kind}:${vendor.key}`, route: route.path, scope: 'route',
                severity: sensitive ? 'critical' : 'high', confidence: 'confirmed',
                title: `Typed ${value.kind} is recorded and sent to ${request.party === 'third-party' ? vendor.name : 'a first-party collector'}`,
                expected: 'Recorders mask every input by default: passwords, card numbers, emails and free text never leave the page.',
                observed: `${request.method} ${request.url.split('?')[0]} carried the synthetic ${value.kind} typed on ${route.path}.`,
                reproduction: [`Open ${route.path} and accept cookies`, `Type into the ${value.kind} field`, 'Leave the page and inspect the recorder\'s requests'],
                evidence: [ref.id],
                proposedFix: 'Turn on input masking in the recorder (mask all inputs; block the fields outright), or remove the recorder from these pages.',
              }))
            }
          })
        } catch (error) {
          unconcluded.push(`${route.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (detections.size && !declared) {
        for (const detection of detections.values()) {
          findings.add(draft(context, CHECK_ID, {
            key: `undeclared-replay:${detection.vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, scope: 'site', severity: 'high', confidence: 'confirmed',
            title: `A session recorder runs although the profile declares none: ${detection.vendor}`,
            expected: 'Session replay is declared, disclosed, consented to and masked, or absent.',
            observed: `Detected via ${detection.via}.`, evidence,
            proposedFix: 'Remove the recorder, or declare it (profile, privacy notice, consent category) and configure masking.',
          }))
        }
      }
      if (detections.size) {
        const readable = replayRequests.filter(request => request.method !== 'GET' ? /[a-z]{3,}/i.test(request.excerpt) : request.url.includes('?'))
        if (!readable.length && typedAnywhere) {
          unconcluded.push(`the recorder's payloads (${[...detections.keys()].join(', ')}) are not readable (compressed or binary): masking could not be verified`)
          humanReview.push(review(context, 'replay-masking', 'Confirm in the recorder\'s dashboard that a recorded session shows masked inputs (password, email, card, free text).',
            'The recorder sends compressed or binary payloads the audit cannot search for its markers.'))
        }
        if (!typedAnywhere) unconcluded.push('a recorder is present but no password, email, card or message field was found on the tested routes to test its masking')
      } else if (declared) {
        humanReview.push(review(context, 'declared-replay-not-observed',
          'Session replay is declared, but no recorder was seen on the tested routes with consent accepted. Which pages load it, and under which consent category?',
          'Masking cannot be tested on routes where the recorder does not run.'))
      }
      if (!typedAnywhere) coverage.unobservable.push('No password, email, card or message fields on the tested routes: masking was not exercised.')

      observations.push(detections.size ? `Recorders: ${[...detections.values()].map(item => `${item.vendor} (${item.via})`).join('; ')}.` : 'No session recorder detected.')
      observations.push(`${typedAnywhere} synthetic value(s) typed into sensitive fields.`)
      const budget = budgetProblem(context)
      if (budget) unconcluded.push(budget)
      return outcome(CHECK_ID, { findings: findings.list(), unconcluded, evidence, humanReview, coverage, observations })
    },
  }
}

export const replayCheck = createReplayCheck()

async function detect(page: AuditPage): Promise<Detection[]> {
  const found: Detection[] = []
  for (const request of page.requests()) {
    if (request.blocked) continue
    const vendor = vendorOf(request.url)
    if (vendor.category === 'replay') found.push({ vendor: vendor.name, via: `request ${request.url.split('?')[0]}` })
  }
  const globals = await page.evaluate<string[]>(`(${JSON.stringify(REPLAY_GLOBALS.map(([name]) => name))}).filter(name => typeof window[name] !== 'undefined')`).catch(() => [] as string[])
  for (const name of globals) found.push({ vendor: REPLAY_GLOBALS.find(([global]) => global === name)![1], via: `global window.${name}` })
  const unique = new Map<string, Detection>()
  for (const item of found) if (!unique.has(item.vendor)) unique.set(item.vendor, item)
  return [...unique.values()]
}
