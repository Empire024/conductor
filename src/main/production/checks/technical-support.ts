import {
  type AuditPage, type CheckContext, type CheckOutcome, type ConsentState, type CookieRecord, type DeviceClass,
  type FindingDraft, type HumanReviewItem, type NavigationResult, type ObservedRequest, type RouteCoverage, type RouteEntry, type StorageRecord,
} from '../../../shared/production'
import { CMP, CONSENT_TEXT } from '../browser'
import { decideApplicability } from '../registry'
import { draft, review, statusOf, notRun, emptyCoverage, throwIfAborted, pathOf, browserProblem } from './check-support'

/**
 * Shared machinery of the technical and accessibility checks (docs/production-agent.md module M4:
 * C03 consent, C04 forms, C05 vendors, C06 replay, C13 accessibility, C16 storage). The route,
 * finding and status helpers have the same shapes as M5's document-support.ts and are folded
 * together after wave 2. Everything is deterministic: pages are driven through the audit browser
 * under the network policy, and a status comes from findings and from the reasons a part could
 * not conclude. A model never decides anything here.
 */

export const MAX_ROUTES = 12

// ---------------------------------------------------------------------------------------------
// Routes, coverage, pages
// ---------------------------------------------------------------------------------------------

export interface RoutePlan {
  routes: RouteEntry[]
  coverage: RouteCoverage
}

/**
 * The routes a check opens: `full` ones first, then one per `sampled` group, bounded by `max`;
 * excluded routes are listed with their reason and never claimed. With no route list the home page
 * stands in, and coverage says so.
 */
export function planRoutes(context: CheckContext, filter?: { tags?: string[] }, max = MAX_ROUTES): RoutePlan {
  const all = context.routes(filter).filter(route => route.source !== 'component')
  const coverage = emptyCoverage()
  for (const route of all) if (route.coverage === 'excluded') coverage.excluded.push({ path: route.path, reason: route.excludedReason ?? 'excluded by scope' })
  const full = all.filter(route => route.coverage === 'full')
  const sampled = new Map<string, RouteEntry>()
  for (const route of all) if (route.coverage === 'sampled') {
    const group = route.tags.find(tag => tag.startsWith('group:')) ?? route.path
    if (!sampled.has(group)) sampled.set(group, route)
  }
  let routes = [...full, ...sampled.values()]
  if (!routes.length && !filter?.tags?.length) {
    routes = [{ path: '/', source: 'owner', tags: ['home'], coverage: 'full' }]
    coverage.unobservable.push('No route list in the profile scope: only the home page was opened.')
  }
  if (routes.length > max) {
    for (const route of routes.slice(max)) coverage.excluded.push({ path: route.path, reason: `beyond the ${max}-route bound of this check` })
    routes = routes.slice(0, max)
  }
  for (const [group, route] of sampled) if (routes.includes(route)) coverage.sampled.push({ path: route.path, standsFor: group })
  return { routes, coverage }
}

/** Records a route as tested on a device in a consent state (merging with what is already there). */
export function markTested(coverage: RouteCoverage, path: string, device: DeviceClass, consent: ConsentState = 'clean'): void {
  const entry = coverage.tested.find(item => item.path === path)
  if (!entry) { coverage.tested.push({ path, devices: [device], consentStates: [consent], authStates: ['guest'] }); return }
  if (!entry.devices.includes(device)) entry.devices.push(device)
  if (!entry.consentStates.includes(consent)) entry.consentStates.push(consent)
}

export function mergeCoverage(into: RouteCoverage, from: RouteCoverage): RouteCoverage {
  for (const item of from.tested) for (const device of item.devices) for (const consent of item.consentStates) markTested(into, item.path, device, consent)
  for (const item of from.sampled) if (!into.sampled.some(entry => entry.path === item.path)) into.sampled.push(item)
  for (const item of from.excluded) if (!into.excluded.some(entry => entry.path === item.path)) into.excluded.push(item)
  for (const item of from.unobservable) if (!into.unobservable.includes(item)) into.unobservable.push(item)
  return into
}

/** The devices the profile scope asks for (both when it names none). */
export const scopeDevices = (context: CheckContext): DeviceClass[] => context.profile.scope.devices.length ? [...context.profile.scope.devices] : ['desktop', 'mobile']

export async function openPage(context: CheckContext, device: DeviceClass, consent: ConsentState = 'clean'): Promise<AuditPage> {
  throwIfAborted(context)
  return context.browser.open({ device, locale: context.profile.scope.locales[0] ?? null, auth: null, consent, regionSelection: context.profile.scope.regionSelection })
}

/** Opens one fresh page, runs `use`, and always closes it. */
export async function withPage<T>(context: CheckContext, device: DeviceClass, consent: ConsentState, use: (page: AuditPage) => Promise<T>): Promise<T> {
  const page = await openPage(context, device, consent)
  try { return await use(page) } finally { await page.close().catch(() => undefined) }
}

export interface Visit {
  navigation: NavigationResult
  ok: boolean
  problem: string | null
}

/** Navigates and classifies the outcome; an HTTP error is a readable failure, a policy stop or timeout is not. */
export async function visit(page: AuditPage, url: string, waitMs = 0): Promise<Visit> {
  const navigation = await page.goto(url, { waitMs })
  if (navigation.outcome !== 'ok') return { navigation, ok: false, problem: `${pathOf(url)}: ${navigation.outcome}` }
  if (navigation.status !== null && navigation.status >= 400) return { navigation, ok: false, problem: `${pathOf(url)}: HTTP ${navigation.status}` }
  return { navigation, ok: true, problem: null }
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

export function originOfUrl(url: string): string {
  try { return new URL(url).origin } catch { return '' }
}

// ---------------------------------------------------------------------------------------------
// Findings, human review and status
// ---------------------------------------------------------------------------------------------

/** Collects findings by (key, route): a defect seen on several devices or states is one finding with merged evidence. */
export class FindingSet {
  private readonly byKey = new Map<string, FindingDraft>()
  add(finding: FindingDraft): void {
    const id = `${finding.key}\u0000${finding.route ?? ''}`
    const existing = this.byKey.get(id)
    if (!existing) { this.byKey.set(id, finding); return }
    for (const item of finding.evidence) if (!existing.evidence.includes(item)) existing.evidence.push(item)
    for (const step of finding.reproduction) if (!existing.reproduction.includes(step)) existing.reproduction.push(step)
    if (!existing.observed.includes(finding.observed) && existing.observed.length < 2000) existing.observed = `${existing.observed}; ${finding.observed}`
  }
  list(): FindingDraft[] { return [...this.byKey.values()] }
}

export function outcome(checkId: string, parts: {
  findings: FindingDraft[]; unconcluded: string[]; evidence: string[]; humanReview: HumanReviewItem[]; coverage: RouteCoverage; observations: string[]
}): CheckOutcome {
  return {
    checkId,
    status: statusOf(parts.findings, parts.unconcluded),
    reason: parts.unconcluded.length ? parts.unconcluded.join('; ') : null,
    findings: parts.findings,
    evidence: [...new Set(parts.evidence)],
    humanReview: parts.humanReview,
    coverage: parts.coverage,
    observations: parts.observations,
  }
}

/**
 * The check's own applicability guard: a disabled or not-applicable control does not run, and an
 * unknown required fact makes it UNVERIFIED (the owner question is raised by the profile), never PASS.
 */
export function applicabilityGuard(context: CheckContext, checkId: string): CheckOutcome | null {
  const decision = decideApplicability(context.control, context.profile.facts, context.profile.scope)
  if (decision.status === 'not-applicable') return notRun(checkId, 'NOT_APPLICABLE', decision.rationale)
  if (decision.status === 'unknown') return notRun(checkId, 'UNVERIFIED', `applicability unknown: ${decision.rationale}`)
  return null
}

/** An unconcluded reason when the run's request budget refused a request (a budget stop is never PASS). */
export function budgetProblem(context: CheckContext): string | null {
  return context.browser.budget().exhausted ? `request budget of ${context.policy.maxRequests} exhausted before the check finished` : null
}

// ---------------------------------------------------------------------------------------------
// Vendors, trackers and consent-requiring activity
// ---------------------------------------------------------------------------------------------

export const VENDOR_CATEGORIES = ['analytics', 'advertising', 'replay', 'social', 'tag-manager', 'consent', 'fonts', 'cdn', 'payments', 'video', 'chat', 'ai', 'captcha', 'maps', 'monitoring', 'email'] as const
export type VendorCategory = (typeof VENDOR_CATEGORIES)[number]

export interface VendorSignature {
  name: string
  category: VendorCategory
  /** Needs prior consent under ePrivacy/GDPR when it runs in the browser (reads or writes identifiers, profiles the visitor). */
  consent: boolean
  /** Matched against the request host. */
  host?: RegExp
  /** Matched against the whole URL on any third-party host (script names, collection paths). */
  url?: RegExp
}

/** Known vendors by host and URL shape. The fixtures use the URL shapes, real sites mostly the hosts. */
export const VENDOR_SIGNATURES: readonly VendorSignature[] = [
  { name: 'Google Analytics', category: 'analytics', consent: true, host: /(^|\.)google-analytics\.com$|(^|\.)analytics\.google\.com$/ },
  { name: 'Google Tag Manager', category: 'tag-manager', consent: false, host: /(^|\.)googletagmanager\.com$/ },
  { name: 'Google Ads / DoubleClick', category: 'advertising', consent: true, host: /(^|\.)(doubleclick\.net|googleadservices\.com|googlesyndication\.com|adservice\.google\.[a-z.]+)$/ },
  { name: 'Meta Pixel', category: 'advertising', consent: true, host: /(^|\.)(connect\.facebook\.net|facebook\.com)$/, url: /fbevents\.js|facebook\.com\/tr\b/ },
  { name: 'TikTok Pixel', category: 'advertising', consent: true, host: /(^|\.)(analytics\.tiktok\.com|tiktok\.com)$/ },
  { name: 'LinkedIn Insight', category: 'advertising', consent: true, host: /(^|\.)(snap\.licdn\.com|px\.ads\.linkedin\.com)$/ },
  { name: 'Microsoft Advertising', category: 'advertising', consent: true, host: /(^|\.)bat\.bing\.com$/ },
  { name: 'Pinterest Tag', category: 'advertising', consent: true, host: /(^|\.)(ct\.pinterest\.com|s\.pinimg\.com)$/ },
  { name: 'Heureka', category: 'advertising', consent: true, host: /(^|\.)heureka\.(sk|cz)$/ },
  { name: 'Seznam Sklik', category: 'advertising', consent: true, host: /(^|\.)(c\.seznam\.cz|imedia\.cz)$/ },
  { name: 'Hotjar', category: 'replay', consent: true, host: /(^|\.)hotjar\.(com|io)$/, url: /hotjar/i },
  { name: 'Microsoft Clarity', category: 'replay', consent: true, host: /(^|\.)clarity\.ms$/, url: /clarity\.js|\/clarity\//i },
  { name: 'FullStory', category: 'replay', consent: true, host: /(^|\.)(fullstory\.com|fullstory\.io)$/, url: /fullstory/i },
  { name: 'LogRocket', category: 'replay', consent: true, host: /(^|\.)(logrocket\.(com|io)|lr-ingest\.io|lr-in\.com)$/, url: /logrocket/i },
  { name: 'Mouseflow', category: 'replay', consent: true, host: /(^|\.)mouseflow\.com$/, url: /mouseflow/i },
  { name: 'Smartlook', category: 'replay', consent: true, host: /(^|\.)smartlook\.(com|cloud)$/, url: /smartlook/i },
  { name: 'Inspectlet', category: 'replay', consent: true, host: /(^|\.)inspectlet\.com$/ },
  { name: 'Lucky Orange', category: 'replay', consent: true, host: /(^|\.)luckyorange\.(com|net)$/ },
  { name: 'Contentsquare', category: 'replay', consent: true, host: /(^|\.)(contentsquare\.net|contentsquare\.com)$/ },
  { name: 'OpenReplay', category: 'replay', consent: true, host: /(^|\.)openreplay\.com$/, url: /openreplay/i },
  { name: 'Yandex Metrica', category: 'replay', consent: true, host: /(^|\.)mc\.yandex\.(ru|com)$/ },
  { name: 'Matomo', category: 'analytics', consent: true, url: /matomo\.(js|php)|piwik\.(js|php)/i },
  { name: 'Mixpanel', category: 'analytics', consent: true, host: /(^|\.)mixpanel\.com$/ },
  { name: 'Segment', category: 'analytics', consent: true, host: /(^|\.)(segment\.(com|io)|segmentapis\.com)$/ },
  { name: 'Amplitude', category: 'analytics', consent: true, host: /(^|\.)amplitude\.com$/ },
  { name: 'PostHog', category: 'analytics', consent: true, host: /(^|\.)posthog\.com$/ },
  { name: 'HubSpot', category: 'analytics', consent: true, host: /(^|\.)(hs-scripts\.com|hs-analytics\.net|hubspot\.com|hsforms\.(com|net))$/ },
  { name: 'Plausible', category: 'analytics', consent: false, host: /(^|\.)plausible\.io$/ },
  { name: 'Sentry', category: 'monitoring', consent: false, host: /(^|\.)(sentry\.io|sentry-cdn\.com)$/ },
  { name: 'Datadog RUM', category: 'monitoring', consent: true, host: /(^|\.)(datadoghq\.(com|eu)|browser-intake-datadoghq\.(com|eu))$/ },
  { name: 'Cookiebot', category: 'consent', consent: false, host: /(^|\.)(cookiebot\.com|consentcdn\.cookiebot\.com)$/ },
  { name: 'OneTrust', category: 'consent', consent: false, host: /(^|\.)(onetrust\.com|cookielaw\.org)$/ },
  { name: 'Google Fonts', category: 'fonts', consent: false, host: /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/ },
  { name: 'Adobe Fonts', category: 'fonts', consent: false, host: /(^|\.)use\.typekit\.net$|(^|\.)p\.typekit\.net$/ },
  { name: 'Font Awesome CDN', category: 'fonts', consent: false, host: /(^|\.)(use\.fontawesome\.com|kit\.fontawesome\.com)$/ },
  { name: 'jsDelivr', category: 'cdn', consent: false, host: /(^|\.)cdn\.jsdelivr\.net$/ },
  { name: 'cdnjs', category: 'cdn', consent: false, host: /(^|\.)cdnjs\.cloudflare\.com$/ },
  { name: 'unpkg', category: 'cdn', consent: false, host: /(^|\.)unpkg\.com$/ },
  { name: 'Google Hosted Libraries', category: 'cdn', consent: false, host: /(^|\.)ajax\.googleapis\.com$/ },
  { name: 'Stripe', category: 'payments', consent: false, host: /(^|\.)(stripe\.com|stripe\.network)$/ },
  { name: 'PayPal', category: 'payments', consent: false, host: /(^|\.)(paypal\.com|paypalobjects\.com)$/ },
  { name: 'GoPay', category: 'payments', consent: false, host: /(^|\.)gopay\.(com|cz|sk)$/ },
  { name: 'YouTube', category: 'video', consent: true, host: /(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)$/ },
  { name: 'Vimeo', category: 'video', consent: true, host: /(^|\.)(vimeo\.com|vimeocdn\.com)$/ },
  { name: 'Intercom', category: 'chat', consent: true, host: /(^|\.)(intercom\.io|intercomcdn\.com)$/ },
  { name: 'Tawk.to', category: 'chat', consent: true, host: /(^|\.)tawk\.to$/ },
  { name: 'Crisp', category: 'chat', consent: true, host: /(^|\.)crisp\.chat$/ },
  { name: 'Smartsupp', category: 'chat', consent: true, host: /(^|\.)smartsupp(chat)?\.com$/ },
  { name: 'OpenAI', category: 'ai', consent: false, host: /(^|\.)(openai\.com|chatgpt\.com)$/ },
  { name: 'Anthropic', category: 'ai', consent: false, host: /(^|\.)anthropic\.com$/ },
  { name: 'Google reCAPTCHA', category: 'captcha', consent: false, host: /(^|\.)(recaptcha\.net)$/, url: /google\.com\/recaptcha|gstatic\.com\/recaptcha/ },
  { name: 'hCaptcha', category: 'captcha', consent: false, host: /(^|\.)hcaptcha\.com$/ },
  { name: 'Google Maps', category: 'maps', consent: true, host: /(^|\.)maps\.(googleapis|gstatic)\.com$/ },
  { name: 'Mailchimp', category: 'email', consent: false, host: /(^|\.)(list-manage\.com|chimpstatic\.com|mailchimp\.com)$/ },
]

/** Generic URL shapes of analytics collection on a host no signature names. */
const GENERIC_TRACKER = /\/(g\/|j\/)?collect(\?|$|\/)|\/tr\/?\?|\/pixel(\.gif)?(\?|$|\/)|\/beacon(\?|$|\/)|\/track(ing)?(\?|$|\/)|\/(gtag|analytics|ga|gtm)\.js(\?|$)/i

export interface VendorMatch { name: string; category: VendorCategory; consent: boolean; key: string; generic: boolean }

/** The vendor a third-party URL belongs to; an unrecognised host is its own vendor, keyed by host. */
export function vendorOf(url: string): VendorMatch {
  const host = hostOf(url)
  for (const signature of VENDOR_SIGNATURES) {
    if ((signature.host && signature.host.test(host)) || (signature.url && signature.url.test(url))) {
      return { name: signature.name, category: signature.category, consent: signature.consent, key: signature.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), generic: false }
    }
  }
  if (GENERIC_TRACKER.test(url)) return { name: `tracker at ${host}`, category: 'analytics', consent: true, key: `host-${host}`, generic: true }
  return { name: host, category: 'cdn', consent: false, key: `host-${host}`, generic: true }
}

/** Cookie and storage names that analytics, advertising and replay tools set. */
export const TRACKING_NAMES = /^(_ga|_gid|_gat|_gcl_|_gac_|_fbp|_fbc|_hj|_clck|_clsk|_uet|_pk_|_pin_|_tt_|_ttp|IDE$|test_cookie$|ajs_|mp_|amplitude|_hs|hubspotutk|__hs|_scid|_sctr|li_|bcookie|_derived_epik|_lr_|_fs_|fs_uid|ph_|__ph|_dd_s|_mkto_trk|__utm|_ym_|yandexuid|MUID$|ANONCHK|_ttp|_rdt_)/i

export interface ConsentActivity {
  requests: ObservedRequest[]
  cookies: CookieRecord[]
  storage: StorageRecord[]
}

/** The part of a page's activity that needs prior consent: tracker requests (blocked ones never left), tracking cookies and storage. */
export function consentActivity(requests: readonly ObservedRequest[], cookies: readonly CookieRecord[], storage: readonly StorageRecord[]): ConsentActivity {
  return {
    requests: requests.filter(request => request.party === 'third-party' && !request.blocked && vendorOf(request.url).consent),
    cookies: cookies.filter(cookie => TRACKING_NAMES.test(cookie.name) || (cookie.party === 'third-party' && vendorOf(`https://${cookie.domain.replace(/^\./, '')}/`).consent)),
    storage: storage.filter(record => TRACKING_NAMES.test(record.key)),
  }
}

export const activityEmpty = (activity: ConsentActivity): boolean => !activity.requests.length && !activity.cookies.length && !activity.storage.length

/** One line per piece of consent-requiring activity, for `observed` text and evidence descriptions. */
export function describeActivity(activity: ConsentActivity): string[] {
  const vendors = new Map<string, number>()
  for (const request of activity.requests) { const name = vendorOf(request.url).name; vendors.set(name, (vendors.get(name) ?? 0) + 1) }
  return [
    ...[...vendors].map(([name, count]) => `${count} request(s) to ${name}`),
    ...activity.cookies.map(cookie => `cookie ${cookie.name} (${cookie.domain})`),
    ...activity.storage.map(record => `${record.area} ${record.key}`),
  ]
}

// ---------------------------------------------------------------------------------------------
// Synthetic markers
// ---------------------------------------------------------------------------------------------

export function containsMarker(text: string, marker: string): boolean {
  if (!text || !marker) return false
  const lower = text.toLowerCase()
  const needle = marker.toLowerCase()
  return lower.includes(needle) || lower.includes(encodeURIComponent(marker).toLowerCase()) || lower.includes(Buffer.from(marker).toString('base64').toLowerCase().replace(/=+$/, ''))
}

/** Requests whose URL or excerpt carries the marker. */
export function requestsCarrying(requests: readonly ObservedRequest[], marker: string): ObservedRequest[] {
  return requests.filter(request => containsMarker(request.url, marker) || containsMarker(request.excerpt, marker))
}

/** Page-side search of cookies and web storage for markers: returns where each was found, never the values. */
export async function markersInPageStorage(page: AuditPage, markers: readonly string[]): Promise<Array<{ marker: string; where: string }>> {
  const script = `(() => {
    const markers = ${JSON.stringify(markers.map(marker => marker.toLowerCase()))}
    const found = []
    const scan = (where, value) => { const text = String(value ?? '').toLowerCase(); for (const marker of markers) if (text.includes(marker) || text.includes(encodeURIComponent(marker))) found.push({ marker, where }) }
    scan('document.cookie', document.cookie)
    for (const area of ['localStorage', 'sessionStorage']) {
      try { const storage = window[area]; for (let i = 0; i < storage.length; i++) { const key = storage.key(i); scan(area + ':' + key, storage.getItem(key)) } } catch (error) {}
    }
    return found
  })()`
  try { return await page.evaluate(script) } catch { return [] }
}

// ---------------------------------------------------------------------------------------------
// Consent UI and keyboard reach
// ---------------------------------------------------------------------------------------------

export interface ConsentUi {
  /** A visible first-layer choice (accept or reject); a persistent "cookie settings" link alone is not a banner. */
  visible: boolean
  accept: boolean
  reject: boolean
  settings: boolean
}

const consentUiScript = (): string => `(() => {
  const selectors = ${JSON.stringify(CMP)}
  const text = { accept: new RegExp(${JSON.stringify(CONSENT_TEXT.accept.source)}, 'i'), reject: new RegExp(${JSON.stringify(CONSENT_TEXT.reject.source)}, 'i'), settings: new RegExp(${JSON.stringify(CONSENT_TEXT.settings.source)}, 'i'), reopen: new RegExp(${JSON.stringify(CONSENT_TEXT.reopen.source)}, 'i') }
  const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0 }
  const labelOf = element => ((element.tagName === 'INPUT' ? element.value : element.innerText || element.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim()
  const kindOf = element => {
    for (const selector of selectors.reopen) { try { if (element.matches(selector)) return 'reopen' } catch (error) {} }
    if (text.reopen.test(labelOf(element))) return 'reopen'
    for (const kind of ['accept', 'reject', 'settings']) {
      for (const selector of selectors[kind]) { try { if (element.matches(selector)) return kind } catch (error) {} }
    }
    const label = labelOf(element)
    for (const kind of ['accept', 'reject', 'settings']) if (label && text[kind].test(label)) return kind
    return null
  }
  window.__conductorConsentKind = kindOf
  const found = { accept: false, reject: false, settings: false }
  for (const element of document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')) {
    if (!visible(element)) continue
    const kind = kindOf(element)
    if (kind && kind !== 'reopen') found[kind] = true
  }
  return { visible: found.accept || found.reject, ...found }
})()`

export async function consentUi(page: AuditPage): Promise<ConsentUi> {
  try { return await page.evaluate<ConsentUi>(consentUiScript()) } catch { return { visible: false, accept: false, reject: false, settings: false } }
}

export interface KeyboardReach {
  reached: { accept: boolean; reject: boolean; settings: boolean }
  /** Focus stops that had no visible indicator. */
  invisibleFocus: string[]
  trace: Array<{ key: string; focusedSelector: string | null; focusVisible: boolean }>
}

/** Tabs through the page (bounded) and records which consent choices keyboard focus reaches, and whether focus was visible there. */
export async function consentKeyboardReach(page: AuditPage, maxTabs = 60): Promise<KeyboardReach> {
  await consentUi(page)
  const reached = { accept: false, reject: false, settings: false }
  const invisibleFocus: string[] = []
  const trace: KeyboardReach['trace'] = []
  for (let index = 0; index < maxTabs; index++) {
    const [step] = await page.keyboard(['Tab'])
    if (!step) break
    trace.push(step)
    const kind = await page.evaluate<string | null>('(() => { const kindOf = window.__conductorConsentKind; const element = document.activeElement; return kindOf && element && element !== document.body ? kindOf(element) : null })()').catch(() => null)
    if (kind === 'accept' || kind === 'reject' || kind === 'settings') {
      reached[kind] = true
      if (!step.focusVisible && step.focusedSelector) invisibleFocus.push(`${kind}: ${step.focusedSelector}`)
    }
    if (reached.accept && reached.reject) break
  }
  return { reached, invisibleFocus, trace }
}

export { draft, review, statusOf, notRun, emptyCoverage, throwIfAborted, pathOf, browserProblem }
