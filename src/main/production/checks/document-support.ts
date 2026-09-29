import { navigationOutcomeText } from '../../../shared/production'
import {
  type AuditPage, type CheckContext, type CheckOutcome, type DeviceClass, type FindingDraft, type HumanReviewItem,
  type NavigationResult, type ObservedRequest, type RouteCoverage, type RouteEntry,
} from '../../../shared/production'
import { factIsUnknown } from '../registry'
import { draft, review, statusOf, notRun, emptyCoverage, throwIfAborted, pathOf, browserProblem, isAllowed, normalise, fold } from './check-support'

/**
 * Shared machinery of the document and claims checks (docs/production-agent.md module M5: C01
 * policies, C02 identity, C12 claims, C14 children, C15 uploads). Everything here is
 * deterministic: pages are read through the audit browser with GET only, text is matched by
 * rules, and a status is derived from findings and the reasons a check could not conclude. A
 * model never decides anything in these checks.
 */

/** At most this many routes are opened per check; the rest are listed as not tested. */
export const MAX_ROUTES = 12
/** Linked documents (policies, identity pages) followed per check. */
export const MAX_DOCUMENTS = 8

export interface RoutePlan {
  routes: RouteEntry[]
  coverage: RouteCoverage
}

/**
 * The routes a check opens: `full` ones first, then one per `sampled` group, bounded by
 * MAX_ROUTES; excluded routes are listed with their reason and never claimed. With no route list
 * the home page stands in, and coverage says so.
 */
export function planRoutes(context: CheckContext, filter?: { tags?: string[] }, max = MAX_ROUTES): RoutePlan {
  const all = context.routes(filter)
  const coverage: RouteCoverage = { tested: [], sampled: [], excluded: [], unobservable: [] }
  for (const route of all) if (route.coverage === 'excluded') coverage.excluded.push({ path: route.path, reason: route.excludedReason ?? 'excluded by scope' })
  const full = all.filter(route => route.coverage === 'full')
  const sampledGroups = new Map<string, RouteEntry>()
  for (const route of all) if (route.coverage === 'sampled') {
    const group = route.tags[0] ?? route.path
    if (!sampledGroups.has(group)) sampledGroups.set(group, route)
  }
  let routes = [...full, ...sampledGroups.values()]
  if (!routes.length && !filter?.tags?.length) {
    routes = [{ path: '/', source: 'owner', tags: [], coverage: 'full' }]
    coverage.unobservable.push('No route list in the profile scope: only the home page was opened.')
  }
  if (routes.length > max) {
    for (const route of routes.slice(max)) coverage.excluded.push({ path: route.path, reason: `beyond the ${max}-route bound of this check` })
    routes = routes.slice(0, max)
  }
  for (const [group, route] of sampledGroups) if (routes.includes(route)) coverage.sampled.push({ path: route.path, standsFor: group })
  return { routes, coverage }
}

/** Records a route as tested on a device (merging devices for the same path). */
export function markTested(coverage: RouteCoverage, path: string, device: DeviceClass): void {
  const entry = coverage.tested.find(item => item.path === path)
  if (entry) { if (!entry.devices.includes(device)) entry.devices.push(device); return }
  coverage.tested.push({ path, devices: [device], consentStates: ['clean'], authStates: ['guest'] })
}

export function mergeCoverage(into: RouteCoverage, from: RouteCoverage): RouteCoverage {
  for (const item of from.tested) for (const device of item.devices) markTested(into, item.path, device)
  for (const item of from.sampled) if (!into.sampled.some(entry => entry.path === item.path)) into.sampled.push(item)
  for (const item of from.excluded) if (!into.excluded.some(entry => entry.path === item.path)) into.excluded.push(item)
  for (const item of from.unobservable) if (!into.unobservable.includes(item)) into.unobservable.push(item)
  return into
}

/** Opens one fresh page, runs `use`, and always closes it. */
export async function withPage<T>(context: CheckContext, device: DeviceClass, use: (page: AuditPage) => Promise<T>): Promise<T> {
  throwIfAborted(context)
  const page = await context.browser.open({ device, locale: context.profile.scope.locales[0] ?? null, auth: null, consent: 'clean', regionSelection: context.profile.scope.regionSelection })
  try { return await use(page) } finally { await page.close().catch(() => undefined) }
}

export interface Visit {
  navigation: NavigationResult
  /** Loaded with a 2xx/3xx final status on an allowed origin. */
  ok: boolean
  /** Why the page could not be read, when it could not. */
  problem: string | null
}

/** Navigates and classifies the outcome; an HTTP error is a readable failure, a policy stop or timeout is not. */
export async function visit(page: AuditPage, url: string): Promise<Visit> {
  const navigation = await page.goto(url)
  if (navigation.outcome !== 'ok') return { navigation, ok: false, problem: `${url}: ${navigationOutcomeText(navigation)}` }
  if (navigation.status !== null && navigation.status >= 400) return { navigation, ok: false, problem: `${url}: HTTP ${navigation.status}` }
  return { navigation, ok: true, problem: null }
}

// ---------------------------------------------------------------------------------------------
// Findings, human review and status
// ---------------------------------------------------------------------------------------------

export function outcome(checkId: string, parts: {
  findings: FindingDraft[]; unconcluded: string[]; evidence: string[]; humanReview: HumanReviewItem[]; coverage: RouteCoverage; observations: string[]
}): CheckOutcome {
  const status = statusOf(parts.findings, parts.unconcluded)
  return {
    checkId,
    status,
    reason: parts.unconcluded.length ? parts.unconcluded.join('; ') : null,
    findings: parts.findings,
    evidence: [...new Set(parts.evidence)],
    humanReview: parts.humanReview,
    coverage: parts.coverage,
    observations: parts.observations,
  }
}

// ---------------------------------------------------------------------------------------------
// Text rules (English, Slovak and Czech)
// ---------------------------------------------------------------------------------------------

/** Link text or URL patterns for the documents the checks follow. */
export const LINK_PATTERNS = {
  privacy: /privacy|data protection|personal data|gdpr|ochran[ay] osobn|spracovani[ea]? osobn|zpracov[aá]n[ií] osobn|z[aá]sady ochrany|os(o|ô)bn[ée] [uú]daje/i,
  terms: /terms|conditions|general terms|obchodn[ée] podmienky|obchodn[ií] podm[ií]nky|všeobecn[ée] (obchodn|podm)|\bvop\b|podmienky pou[žz]|podm[ií]nky u[žz]/i,
  identity: /contact|about|imprint|impressum|legal notice|company (info|details)|kontakt|o n[aá]s|prev[aá]dzkovate[lľ]|provozovatel|údaje o spolo[čc]nosti|[uú]daje o firm/i,
  uploads: /copyright|dmca|content policy|community guidelines|report( content| abuse| infringement)?|notice and takedown|takedown|intellectual property|autorsk|nahl[aá]si[tť]|obsah pou[žz]ív/i,
} as const

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|január|február|marec|apríl|máj|jún|júl|august|september|október|november|december|januára|februára|marca|apríla|mája|júna|júla|augusta|septembra|októbra|novembra|decembra|leden|únor|březen|duben|květen|červen|červenec|srpen|září|říjen|listopad|prosinec|ledna|února|března|dubna|května|června|července|srpna|října|listopadu|prosince'
const DATE = new RegExp(String.raw`\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\s?\d{1,2}\.\s?\d{4}|\d{1,2}/\d{1,2}/\d{4}|\d{1,2}\.?\s+(${MONTHS})\s+\d{4}|(${MONTHS})\s+\d{1,2},?\s+\d{4})\b`, 'i')
const DATE_LABEL = /(last (updated|modified|revised)|effective (date|from|as of)|updated on|version|valid from|in force from|platn[ée] od|[uú][cč]inn[ée] od|posledn[aá] (aktualiz[aá]cia|zmena|zm[eě]na)|aktualizov[aá]no|verzia|verze|dátum [uú][cč]innosti|datum [uú][cč]innosti)/i

/** The document's date or version statement, or null: a label near a date, or `Version n`. */
export function documentDate(text: string): string | null {
  const labelled = new RegExp(`${DATE_LABEL.source}[^.\\n]{0,40}?(${DATE.source.slice(2, -2)})`, 'i').exec(text)
  if (labelled) return normalise(labelled[0]).slice(0, 120)
  const version = /\b(version|verzia|verze)\s*:?\s*v?\d+(\.\d+)*/i.exec(text)
  return version ? normalise(version[0]) : null
}

/** Template placeholders left in published text. */
const PLACEHOLDERS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'lorem-ipsum', pattern: /\blorem ipsum\b/i },
  { id: 'bracket-field', pattern: /\[(?:your |the )?(?:company|business|site|website|shop|store|owner|name|address|email|phone|date|country|entity|jurisdiction|city)(?: name| address| email)?\]/i },
  { id: 'brace-field', pattern: /\{\{?\s*(?:company|business|site|shop|name|address|email|date)[\w ]*\}?\}/i },
  { id: 'todo', pattern: /\b(TODO|TBD|FIXME|XXX)\b/ },
  { id: 'insert-here', pattern: /\binsert (?:your|the) [a-z ]{3,30}\bhere\b|\b(?:your|the) company name\b|\bcompany name here\b/i },
  { id: 'sk-cz-placeholder', pattern: /\b(n[aá]zov (?:spolo[čc]nosti|firmy)|n[aá]zev (?:spole[čc]nosti|firmy)|dopl[ňn]te|dopl[ňn]it)\b/i },
]

export function placeholdersIn(text: string): Array<{ id: string; excerpt: string }> {
  const found: Array<{ id: string; excerpt: string }> = []
  for (const { id, pattern } of PLACEHOLDERS) {
    const match = pattern.exec(text)
    if (match) found.push({ id, excerpt: normalise(text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40)) })
  }
  return found
}

/** The entity name part of the owner's legal-entity fact (before the first comma or newline). */
export function entityName(value: string): string {
  return normalise(value.split(/[,\n;]/)[0] ?? value)
}

/** Registration numbers (Slovak/Czech IČO: 8 digits) written in a text. */
export function registrationNumbers(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/\b(?:I[ČC]O|I[ČC]|ID|Company (?:No|number)|Reg(?:istration)?\.? ?(?:No|number)|registra[čc]n[ée] [čc][ií]slo)\.?\s*:?\s*(\d[\d ]{5,10}\d)\b/gi)) {
    const digits = match[1]!.replace(/\s/g, '')
    if (digits.length >= 6 && digits.length <= 10) found.add(digits)
  }
  return [...found]
}

/** Whether a text names the entity: every significant word of the name, legal form folded (s.r.o. ≈ sro). */
export function namesEntity(text: string, name: string): boolean {
  const haystack = ` ${fold(text)} `
  const words = fold(name).split(' ').filter(word => word.length > 1 || /\d/.test(word))
  if (!words.length) return false
  const phrase = ` ${words.join(' ')} `
  if (haystack.includes(phrase)) return true
  // Legal forms are written many ways: "s. r. o.", "s.r.o.", "spol. s r.o."; compare without them.
  const forms = new Set(['s', 'r', 'o', 'sro', 'spol', 'a', 'as', 'gmbh', 'ltd', 'llc', 'inc', 'limited'])
  const core = words.filter(word => !forms.has(word))
  return core.length > 0 && haystack.includes(` ${core.join(' ')} `)
}

const LEGAL_FORM = String.raw`(?:s\.\s?r\.\s?o\.|spol\.\s?s\s?r\.\s?o\.|a\.\s?s\.|k\.\s?s\.|v\.\s?o\.\s?s\.|GmbH|AG|Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|SE)`
/** Company names with a legal form written in a text ("Flowers Trading s.r.o."). */
export function companyNames(text: string): string[] {
  const found = new Set<string>()
  const pattern = new RegExp(String.raw`((?:[A-ZÀ-Ž0-9][\wÀ-ž&'\-]*\.?\s){1,5}${LEGAL_FORM})(?![\wÀ-ž])`, 'g')
  for (const match of normalise(text).matchAll(pattern)) {
    const name = match[1]!.replace(/^(?:The|Operator|Seller|Provider|Prevádzkovateľ|Provozovatel|Predávajúci|Prodávající|Company|Spoločnosť|Společnost)\s*:?\s+/i, '').trim()
    found.add(name)
  }
  return [...found]
}

export function entityProblem(context: CheckContext): string | null {
  return factIsUnknown(context.profile.facts.legalEntity) ? 'legal entity unknown: the owner question legalEntity blocks this comparison' : null
}

/** Footer (or contentinfo) links of the current page; falls back to every link when the page has no footer. */
export async function footerLinks(page: AuditPage): Promise<{ links: Array<{ text: string; href: string }>; hasFooter: boolean }> {
  return await page.evaluate<{ links: Array<{ text: string; href: string }>; hasFooter: boolean }>(`(() => {
    const norm = text => (text || '').replace(/\\s+/g, ' ').trim()
    const footers = [...document.querySelectorAll('footer, [role="contentinfo"]')]
    const anchors = footers.length ? footers.flatMap(footer => [...footer.querySelectorAll('a[href]')]) : [...document.querySelectorAll('a[href]')]
    return { hasFooter: footers.length > 0, links: anchors.slice(0, 300).map(a => ({ text: norm(a.innerText || a.getAttribute('aria-label') || a.title).slice(0, 200), href: a.href })) }
  })()`)
}

export const matchesLink = (link: { text: string; href: string }, pattern: RegExp): boolean => pattern.test(link.text) || pattern.test(decodeURIComponent(pathOf(link.href)))

// ---------------------------------------------------------------------------------------------
// Observed data flows
// ---------------------------------------------------------------------------------------------

/** Hosts of widely used analytics, advertising and replay services. */
export const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'facebook.net', 'facebook.com', 'connect.facebook.net', 'hotjar.com', 'hotjar.io', 'clarity.ms', 'bing.com', 'tiktok.com',
  'analytics.tiktok.com', 'segment.io', 'segment.com', 'mixpanel.com', 'amplitude.com', 'heap.io', 'fullstory.com',
  'mouseflow.com', 'smartlook.com', 'linkedin.com', 'licdn.com', 'snapchat.com', 'pinterest.com', 'plausible.io', 'matomo.cloud',
  'criteo.com', 'taboola.com', 'outbrain.com', 'yandex.ru', 'mc.yandex.ru', 'sklik.cz', 'seznam.cz',
]
const TRACKER_PATH = /(?:^|\/)_*(?:g\/collect|collect|gtag\/js|gtm\.js|analytics\.js|fbevents\.js|pixel|beacon|track(?:ing)?|events?|hit)(?:[/?.]|$)/i

/** Third-party requests that look like analytics or tracking: a known host, or a collector-shaped path. */
export function trackerRequests(context: CheckContext, requests: readonly ObservedRequest[]): ObservedRequest[] {
  return requests.filter(request => {
    if (isAllowed(context, request.url)) return false
    let host = '', path = ''
    try { const url = new URL(request.url); host = url.hostname.toLowerCase(); path = url.pathname } catch { return false }
    return TRACKER_HOSTS.some(known => host === known || host.endsWith(`.${known}`)) || TRACKER_PATH.test(path)
  })
}

export { draft, review, statusOf, notRun, emptyCoverage, throwIfAborted, pathOf, browserProblem, isAllowed, normalise, fold }
