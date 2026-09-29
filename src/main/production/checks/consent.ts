import { CONSENT_STATES, type AuditPage, type CheckContext, type HumanReviewItem, type ConsentOutcome, type ConsentState, type ControlCheck, type CookieRecord, type DeviceClass, type RouteEntry, type StorageRecord } from '../../../shared/production'
import {
  FindingSet, activityEmpty, applicabilityGuard, browserProblem, budgetProblem, consentActivity, consentKeyboardReach, consentUi, describeActivity, draft,
  emptyCoverage, markTested, mergeCoverage, notRun, outcome, planRoutes, review, scopeDevices, throwIfAborted, vendorOf, visit, withPage,
  type ConsentActivity, type ConsentUi,
} from './technical-support'

/**
 * C03 Cookies and consent behaviour (docs/production-agent.md module M4). A matrix over the consent
 * states the scope names (all six by default) x devices x routes, each on a fresh browser context:
 *
 * - `clean`: nothing that needs consent may run before a choice (tracker requests, tracking cookies
 *   or storage), including scripts that load late (the page is held `settleMs` after load);
 * - `no-interaction`: navigating and reloading without answering the banner is not consent;
 * - `rejected`, `selected` (necessary/functional/preferences only), `withdrawn` (accept, then
 *   withdraw): nothing consent-requiring may run after the choice, across a reload and a navigation,
 *   and the choice must persist (the banner does not come back);
 * - `accepted` is the positive control: it shows the detection sees this site's tools.
 *
 * Reject, a granular choice and withdrawal must exist when analytics is declared, and keyboard focus
 * must reach accept and reject. With `analytics: false` the control is the essential-only negative
 * control: no banner is needed and any consent-requiring activity in any state is a finding.
 */

export interface ConsentCheckOptions {
  /** Routes per device; the first also gets the reload and navigation persistence pass. */
  maxRoutes?: number
  /** How long a page is held after load so delayed scripts (tag managers, lazy trackers) can start. */
  settleMs?: number
  maxTabs?: number
}

const CHECK_ID = 'consent'
const CHOICE_STATES: readonly ConsentState[] = ['rejected', 'selected', 'withdrawn']

interface StateRun {
  state: ConsentState
  device: DeviceClass
  route: RouteEntry
  ui: ConsentUi
  consent: ConsentOutcome | null
  /** Activity before any choice (all activity for clean and no-interaction). */
  before: ConsentActivity
  /** Activity after the choice was made, across reload and navigation (choice states and accepted). */
  after: ConsentActivity | null
  uiAfterReload: ConsentUi | null
  evidence: string
}

export function createConsentCheck(options: ConsentCheckOptions = {}): ControlCheck {
  const maxRoutes = options.maxRoutes ?? 3
  const settleMs = options.settleMs ?? 2500
  const maxTabs = options.maxTabs ?? 60
  return {
    controlId: 'C03',
    checkId: CHECK_ID,
    title: 'Consent-requiring requests, cookies and storage in every consent state',
    requires: ['browser'],
    async run(context) {
      const guard = applicabilityGuard(context, CHECK_ID)
      if (guard) return guard
      const missingBrowser = await browserProblem(context)
      if (missingBrowser) return notRun(CHECK_ID, 'UNVERIFIED', missingBrowser)

      const analytics = context.profile.facts.analytics.value === true
      const states = (context.profile.scope.consentStates.length ? context.profile.scope.consentStates : [...CONSENT_STATES]).filter(state => CONSENT_STATES.includes(state))
      const plan = planRoutes(context, undefined, maxRoutes)
      const coverage = mergeCoverage(emptyCoverage(), plan.coverage)
      const findings = new FindingSet()
      const unconcluded: string[] = []
      const evidence: string[] = []
      const humanReview: HumanReviewItem[] = []
      const observations: string[] = []
      const runs: StateRun[] = []

      for (const device of scopeDevices(context)) {
        for (const [index, route] of plan.routes.entries()) {
          const next = plan.routes[(index + 1) % plan.routes.length] ?? route
          for (const state of states) {
            throwIfAborted(context)
            try {
              const result = await runState(context, { state, device, route, next, persistence: index === 0, settleMs })
              if (typeof result === 'string') { unconcluded.push(result); continue }
              runs.push(result)
              evidence.push(result.evidence)
              markTested(coverage, route.path, device, state)
            } catch (error) {
              unconcluded.push(`${state} on ${device} ${route.path}: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      }

      // Keyboard access to the choices, on the first route per device, from a clean page.
      const bannerSeen = runs.some(run => run.ui.visible)
      if (bannerSeen) {
        for (const device of scopeDevices(context)) {
          const route = plan.routes[0]!
          try {
            await withPage(context, device, 'clean', async page => {
              const loaded = await visit(page, context.url(route.path))
              if (!loaded.ok) { unconcluded.push(`keyboard pass: ${loaded.problem}`); return }
              if (!(await consentUi(page)).visible) return
              const reach = await consentKeyboardReach(page, maxTabs)
              const ref = await context.evidence.writeJson('log', `C03 keyboard trace to the consent choices on ${device} ${route.path}`, reach)
              evidence.push(ref.id)
              for (const choice of ['accept', 'reject'] as const) {
                if (reach.reached[choice]) continue
                findings.add(draft(context, CHECK_ID, {
                  key: `choice-not-keyboard-reachable:${choice}`, route: route.path, component: 'cookie banner', scope: 'component',
                  severity: choice === 'reject' ? 'high' : 'medium', confidence: 'confirmed',
                  title: `The cookie ${choice} choice cannot be reached with the keyboard`,
                  expected: 'Every consent choice is reachable and operable with the keyboard, as easily as with a pointer.',
                  observed: `${reach.trace.length} Tab presses on ${device} never focused the ${choice} control.`,
                  reproduction: [`Open ${route.path} in a fresh browser`, 'Press Tab repeatedly', `The ${choice} control never receives focus`],
                  evidence: [ref.id],
                  proposedFix: `Make the ${choice} control a native <button> (or give it tabindex="0" and key handlers) inside the banner.`,
                }))
              }
              if (reach.invisibleFocus.length) {
                findings.add(draft(context, CHECK_ID, {
                  key: 'choice-focus-not-visible', route: route.path, component: 'cookie banner', scope: 'component', category: 'technical',
                  severity: 'low', confidence: 'likely', title: 'Keyboard focus on the consent choices is not visible',
                  expected: 'A visible focus indicator on each consent control.', observed: reach.invisibleFocus.join('; '),
                  evidence: [ref.id], proposedFix: 'Add a :focus-visible outline to the banner buttons.',
                }))
              }
            })
          } catch (error) {
            unconcluded.push(`keyboard pass on ${device}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }

      judge(context, runs, { analytics, bannerSeen, findings, humanReview, observations })
      const budget = budgetProblem(context)
      if (budget) unconcluded.push(budget)
      if (!runs.length && !unconcluded.length) unconcluded.push('no consent state could be tested')
      observations.push(...runs.map(run => `${run.state} / ${run.device} / ${run.route.path}: ${summary(run)}`))
      return outcome(CHECK_ID, { findings: findings.list(), unconcluded, evidence, humanReview, coverage, observations })
    },
  }
}

export const consentCheck = createConsentCheck()

function summary(run: StateRun): string {
  const before = describeActivity(run.before)
  const after = run.after ? describeActivity(run.after) : []
  return [
    run.ui.visible ? 'banner shown' : 'no banner',
    run.consent && run.state !== 'clean' && run.state !== 'no-interaction' ? `choice ${run.consent.applied ? `applied via ${run.consent.mechanism}` : 'not applied'}` : null,
    before.length ? `before choice: ${before.join(', ')}` : 'nothing consent-requiring before a choice',
    run.after ? (after.length ? `after choice: ${after.join(', ')}` : 'nothing consent-requiring after the choice') : null,
  ].filter(Boolean).join('; ')
}

async function snapshotStores(page: AuditPage): Promise<{ cookies: CookieRecord[]; storage: StorageRecord[] }> {
  return { cookies: await page.cookies().catch(() => []), storage: await page.storage().catch(() => []) }
}

/**
 * One consent state on one device and route, on a fresh context. The check makes the choice itself
 * (the page opens clean), so the request log can be cut exactly where the visitor clicked: what ran
 * before the click is "before consent", what ran from the click on is "after the choice". A string
 * is a reason the state could not conclude.
 */
async function runState(context: CheckContext, input: { state: ConsentState; device: DeviceClass; route: RouteEntry; next: RouteEntry; persistence: boolean; settleMs: number }): Promise<StateRun | string> {
  const { state, device, route, next, persistence, settleMs } = input
  return withPage(context, device, 'clean', async page => {
    const loaded = await visit(page, context.url(route.path), settleMs)
    if (!loaded.ok) return `${state} on ${device}: ${loaded.problem}`
    const ui = await consentUi(page)
    const beforeStores = await snapshotStores(page)
    const before = consentActivity(page.requests(), beforeStores.cookies, beforeStores.storage)
    let consent: ConsentOutcome | null = { state, applied: state === 'clean' || state === 'no-interaction', mechanism: null }
    let after: ConsentActivity | null = null
    let uiAfterReload: ConsentUi | null = null

    const persist = async (): Promise<string | null> => {
      const reloaded = await page.reload()
      if (reloaded.outcome !== 'ok') return `${state} on ${device}: reload ${reloaded.outcome}`
      await page.waitFor(settleMs)
      const again = await consentUi(page)
      if (state !== 'no-interaction' && again.visible) uiAfterReload = again
      const moved = await visit(page, context.url(next.path), settleMs)
      return moved.ok ? null : `${state} on ${device}: ${moved.problem}`
    }

    if (state === 'no-interaction') {
      if (persistence) { const problem = await persist(); if (problem) return problem }
    } else if (state !== 'clean') {
      let mark = page.requests().length
      let known = beforeStores
      let result: { applied: boolean; mechanism: string | null }
      if (state === 'withdrawn') {
        const accepted = await page.consent({ action: 'accept' })
        if (!accepted.applied) result = { applied: false, mechanism: null }
        else {
          // Let what acceptance started finish first (a delayed tag, its beacon), so it is not
          // mistaken for activity after the withdrawal.
          await page.waitFor(settleMs)
          mark = page.requests().length
          known = await snapshotStores(page)
          const withdrawn = await page.consent({ action: 'withdraw' })
          result = withdrawn.applied ? { applied: true, mechanism: `${accepted.mechanism} → ${withdrawn.mechanism}` } : { applied: false, mechanism: accepted.mechanism }
        }
      } else {
        result = await page.consent(state === 'rejected' ? { action: 'reject' } : state === 'accepted' ? { action: 'accept' } : { action: 'select', categories: ['necessary', 'functional', 'preferences'] })
      }
      consent = { state, ...result }
      if (result.applied) {
        if (persistence) { const problem = await persist(); if (problem) return problem }
        else await page.waitFor(settleMs)
        const now = await snapshotStores(page)
        // Cookies and storage are judged on what the choice added, so a tracker that ran before the
        // choice is reported once, as "before consent".
        const seen = new Set([...known.cookies.map(cookie => `c:${cookie.name}`), ...known.storage.map(record => `s:${record.area}:${record.key}`)])
        after = consentActivity(
          page.requests().slice(mark),
          now.cookies.filter(cookie => !seen.has(`c:${cookie.name}`)),
          now.storage.filter(record => !seen.has(`s:${record.area}:${record.key}`)),
        )
      }
    }
    const stores = await snapshotStores(page)
    const logged = page.requests().filter(request => request.party === 'third-party' || request.blocked)
    const ref = await context.evidence.writeJson('requests', `C03 ${state} on ${device} ${route.path}: requests, cookies and storage`, {
      state, device, route: route.path, consent, ui, uiAfterReload,
      before: describeActivity(before), after: after ? describeActivity(after) : null,
      requests: logged.map(request => ({ url: request.url, method: request.method, type: request.resourceType, vendor: vendorOf(request.url).name, blocked: request.blocked, status: request.status, at: request.at })),
      cookies: stores.cookies, storage: stores.storage,
    })
    return { state, device, route, ui, consent, before, after, uiAfterReload, evidence: ref.id }
  })
}

function judge(context: CheckContext, runs: readonly StateRun[], parts: {
  analytics: boolean; bannerSeen: boolean; findings: FindingSet; humanReview: ReturnType<typeof review>[]; observations: string[]
}): void {
  const { analytics, bannerSeen, findings } = parts
  const declared = analytics ? 'Analytics is declared, so it may only start after consent.' : 'The profile declares no analytics: the site should be essential-only.'
  const beforeKeys = new Set<string>()

  for (const run of runs) {
    const where = `${run.device}, ${run.route.path}`
    const activityFinding = (phase: 'before-consent' | 'without-interaction' | 'after-reject' | 'after-selection' | 'after-withdrawal' | 'after-acceptance', activity: ConsentActivity) => {
      const vendors = new Map<string, string[]>()
      for (const request of activity.requests) { const vendor = vendorOf(request.url); vendors.set(vendor.key, [...(vendors.get(vendor.key) ?? []), `${request.method} ${request.url}`]) }
      for (const cookie of activity.cookies) vendors.set(`cookie-${cookie.name.replace(/[^a-z0-9_]+/gi, '').toLowerCase()}`, [`cookie ${cookie.name} on ${cookie.domain}`])
      for (const record of activity.storage) vendors.set(`storage-${record.key.replace(/[^a-z0-9_]+/gi, '').toLowerCase()}`, [`${record.area} key ${record.key}`])
      for (const [vendorKey, items] of vendors) {
        const key = `tracker-${phase}:${vendorKey}`
        if (phase === 'without-interaction' && beforeKeys.has(`${run.route.path}|${vendorKey}`)) continue
        if (phase === 'before-consent') beforeKeys.add(`${run.route.path}|${vendorKey}`)
        const severity = phase === 'before-consent' || phase === 'without-interaction' || phase === 'after-acceptance' ? 'high' : 'critical'
        const label = {
          'before-consent': 'before any consent choice',
          'without-interaction': 'while the visitor navigated without answering the banner',
          'after-reject': 'after the visitor rejected',
          'after-selection': 'after the visitor kept only necessary, functional and preference categories',
          'after-withdrawal': 'after the visitor withdrew consent',
          'after-acceptance': 'although the profile declares no analytics',
        }[phase]
        parts.findings.add(draft(context, CHECK_ID, {
          key, route: run.route.path, scope: 'route', severity, confidence: 'confirmed',
          title: `Consent-requiring activity ${label}: ${items[0]!.startsWith('cookie') || items[0]!.includes(' key ') ? items[0]! : vendorKey.replace(/^host-/, '')}`,
          expected: phase === 'after-acceptance' ? declared : 'No tracking requests, cookies or storage until the visitor consents, and none after a refusal or withdrawal.',
          observed: `${items.slice(0, 5).join('; ')} (${where}, state ${run.state})`,
          reproduction: [`Open ${run.route.path} in a fresh browser on ${run.device}`, run.state === 'clean' ? 'Do not interact' : `Reach the ${run.state} consent state`, 'Watch the network, cookies and storage'],
          evidence: [run.evidence],
          proposedFix: phase === 'after-acceptance'
            ? 'Either remove the tracking or record analytics as used in the profile and put it behind consent.'
            : 'Load the tool only from the consent manager\'s callback for its category, and remove its cookies and storage when consent is refused or withdrawn.',
        }))
      }
    }

    activityFinding(run.state === 'no-interaction' ? 'without-interaction' : 'before-consent', run.before)

    if (run.after) {
      if (run.state === 'rejected') activityFinding('after-reject', run.after)
      if (run.state === 'selected') activityFinding('after-selection', run.after)
      if (run.state === 'withdrawn') activityFinding('after-withdrawal', run.after)
      if (run.state === 'accepted' && !analytics) activityFinding('after-acceptance', run.after)
    }

    if (analytics && CHOICE_STATES.includes(run.state) && run.consent && !run.consent.applied && bannerSeen) {
      const missing = run.state === 'rejected' ? 'reject' : run.state === 'selected' ? 'granular' : 'withdrawal'
      findings.add(draft(context, CHECK_ID, {
        key: `no-${missing}-choice`, route: run.route.path, component: 'cookie banner', scope: 'component',
        severity: missing === 'granular' ? 'medium' : 'high', confidence: 'likely',
        title: missing === 'reject' ? 'No way to reject as easily as to accept' : missing === 'granular' ? 'No granular choice per purpose' : 'No way to withdraw consent',
        expected: missing === 'withdrawal'
          ? 'Withdrawing consent is as easy as giving it, for example a persistent "Cookie settings" control.'
          : missing === 'reject' ? 'A reject control on the first layer, as prominent as accept.' : 'A settings layer where each purpose can be chosen separately.',
        observed: `The audit browser found no ${missing === 'withdrawal' ? 'reopen-and-reject' : missing === 'granular' ? 'settings-and-save' : 'reject'} control (${where}).`,
        evidence: [run.evidence],
        proposedFix: 'Use a consent manager configuration with reject-all on the first layer, per-purpose settings and a persistent settings link.',
      }))
    }

    if (run.uiAfterReload?.visible) {
      findings.add(draft(context, CHECK_ID, {
        key: `choice-not-persisted:${run.state}`, route: run.route.path, component: 'cookie banner', scope: 'component', category: 'technical',
        severity: 'medium', confidence: 'confirmed', title: 'The consent choice is not remembered across a reload',
        expected: 'After a choice, the banner does not come back on reload or navigation.',
        observed: `The banner was visible again after reloading in the ${run.state} state (${where}).`,
        evidence: [run.evidence], proposedFix: 'Store the choice (first-party, essential) and read it before rendering the banner.',
      }))
    }
  }

  const anyActivity = runs.some(run => !activityEmpty(run.before) || (run.after && !activityEmpty(run.after)))
  if (analytics && !bannerSeen && anyActivity) {
    findings.add(draft(context, CHECK_ID, {
      key: 'no-consent-choice', scope: 'site', severity: 'high', confidence: 'confirmed',
      title: 'Tracking runs but no consent choice is offered',
      expected: 'A consent banner with accept and reject before any consent-requiring tool runs.',
      observed: 'No accept, reject or settings control was found on any tested route, yet consent-requiring activity was observed.',
      evidence: runs.map(run => run.evidence), proposedFix: 'Install a consent manager and load analytics only after consent.',
    }))
  }
  const accepted = runs.filter(run => run.state === 'accepted')
  if (analytics && accepted.length && accepted.every(run => activityEmpty(run.before) && (!run.after || activityEmpty(run.after)))) {
    parts.humanReview.push(review(context, 'no-activity-after-acceptance',
      'Analytics is declared, but no consent-requiring activity was observed even after accepting. Is the tool loaded on routes not tested, server-side, or by a vendor the detection does not know?',
      'Without seeing the tool run after acceptance, the absence of activity in the other states proves less.'))
  }
  if (!analytics && !anyActivity) parts.observations.push('Essential-only: no consent-requiring requests, cookies or storage in any tested consent state; no banner is required for that.')
}
