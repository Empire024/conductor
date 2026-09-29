import {
  type AuditPage, type CheckContext, type CheckOutcome, type CommerceSandboxAdapter, type ControlResultStatus, type DataRecordsAdapter, type DeviceClass,
  type FindingDraft, type HumanReviewItem, type MutationKind, type NavigationResult, type RouteCoverage, type RouteEntry, type TestAccountRef,
} from '../../../shared/production'
import { draft, review, statusOf, notRun, emptyCoverage, throwIfAborted, pathOf, browserProblem, isAllowed, normalise, fold } from './check-support'

/**
 * Shared machinery of the commerce and lifecycle checks (docs/production-agent.md module M6: C07
 * data rights, C08 marketing email, C09 pricing, C10 subscriptions, C11 refunds). Pages are read
 * through the audit browser; every mutation goes through `context.operation`, and a journey whose
 * mutation is not authorized stops before its first mutation and reports UNVERIFIED with
 * "sandbox write authorization required for <mutation>". A model never decides a status here.
 */

/** At most this many routes are opened per check; the rest are listed as not tested. */
export const MAX_ROUTES = 8

/** The mutation kind a sandbox refund request needs; no other authorization covers one. */
export const REFUND_MUTATION: MutationKind = 'refund-request'

/** Routes carrying any of the tags (full first, one per sampled group), bounded; excluded ones are listed, never opened. */
export function routesTagged(context: CheckContext, tags: string[], coverage: RouteCoverage, max = MAX_ROUTES): RouteEntry[] {
  const all = context.routes({ tags })
  for (const route of all) if (route.coverage === 'excluded' && !coverage.excluded.some(item => item.path === route.path)) {
    coverage.excluded.push({ path: route.path, reason: route.excludedReason ?? 'excluded by scope' })
  }
  const groups = new Set<string>()
  const picked: RouteEntry[] = []
  for (const route of [...all.filter(entry => entry.coverage === 'full'), ...all.filter(entry => entry.coverage === 'sampled')]) {
    if (route.coverage === 'sampled') {
      const group = route.tags.find(tag => tag.startsWith('group:')) ?? route.path
      if (groups.has(group)) continue
      groups.add(group)
      if (!coverage.sampled.some(item => item.path === route.path)) coverage.sampled.push({ path: route.path, standsFor: group })
    }
    picked.push(route)
  }
  for (const route of picked.slice(max)) coverage.excluded.push({ path: route.path, reason: `beyond the ${max}-route bound of this check` })
  return picked.slice(0, max)
}

/** Records a route as tested (merging devices and auth states for the same path). */
export function markTested(coverage: RouteCoverage, path: string, device: DeviceClass, auth: 'guest' | 'authenticated' = 'guest'): void {
  const entry = coverage.tested.find(item => item.path === path)
  if (entry) {
    if (!entry.devices.includes(device)) entry.devices.push(device)
    if (!entry.authStates.includes(auth)) entry.authStates.push(auth)
    return
  }
  coverage.tested.push({ path, devices: [device], consentStates: ['clean'], authStates: [auth] })
}

export function unobservable(coverage: RouteCoverage, line: string): void {
  if (!coverage.unobservable.includes(line)) coverage.unobservable.push(line)
}

/** Opens one fresh page (guest unless an account is given), runs `use`, and always closes it. */
export async function withPage<T>(context: CheckContext, use: (page: AuditPage) => Promise<T>, options: { device?: DeviceClass; account?: TestAccountRef | null } = {}): Promise<T> {
  throwIfAborted(context)
  const page = await context.browser.open({
    device: options.device ?? 'desktop', locale: context.profile.scope.locales[0] ?? null, auth: options.account ?? null,
    consent: 'clean', regionSelection: context.profile.scope.regionSelection,
  })
  try { return await use(page) } finally { await page.close().catch(() => undefined) }
}

export interface Visit {
  navigation: NavigationResult
  ok: boolean
  problem: string | null
}

/** Navigates and classifies the outcome: an HTTP error, a policy stop or a timeout is a page that could not be read. */
export async function visit(page: AuditPage, url: string): Promise<Visit> {
  const navigation = await page.goto(url)
  if (navigation.outcome !== 'ok') return { navigation, ok: false, problem: `${pathOf(url)}: ${navigation.outcome}` }
  if (navigation.status !== null && navigation.status >= 400) return { navigation, ok: false, problem: `${pathOf(url)}: HTTP ${navigation.status}` }
  return { navigation, ok: true, problem: null }
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

/** Why this run may not perform the mutation, or null when the policy's live authorization names it. Not the authority: `operation` is. */
export function mutationBlocked(context: CheckContext, mutation: MutationKind, what = 'this journey'): string | null {
  const policy = context.policy
  if (policy.environmentKind === 'production') return `sandbox write authorization required for ${mutation}: ${what} stopped before its first mutation because environment ${policy.environmentId} is production, where nothing is ever submitted`
  const auth = policy.writeAuthorization
  if (policy.readOnly || !auth || auth.environmentId !== policy.environmentId || Date.parse(auth.expiresAt) <= Date.now() || !auth.mutations.includes(mutation)) {
    return `sandbox write authorization required for ${mutation}: ${what} stopped before its first mutation`
  }
  return null
}

export const isMutationRefused = (error: unknown): boolean => error instanceof Error && error.name === 'MutationRefused'

/**
 * Runs one journeyed mutation through `context.operation`. A refusal (the authority said no) comes
 * back as the unconcluded reason; any other failure as `failed`.
 */
export async function mutate<T>(context: CheckContext, mutation: MutationKind, target: string, act: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; refused: boolean; reason: string }> {
  try {
    return { ok: true, value: await context.operation(mutation, target, act) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isMutationRefused(error)) return { ok: false, refused: true, reason: /mutation policy/.test(message) ? message : `sandbox write authorization required for ${mutation}: ${message}` }
    return { ok: false, refused: false, reason: `${mutation} on ${target} failed: ${message}` }
  }
}

/** The environment's test account for a role (first match in the order given), or null. */
export function accountFor(context: CheckContext, roles: Array<TestAccountRef['role']>): TestAccountRef | null {
  for (const role of roles) {
    const account = context.environment.accounts.find(entry => entry.role === role)
    if (account) return account
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Data-records reads (`Adapters.records`, or `records()` on a commerce adapter that has it)
// ---------------------------------------------------------------------------------------------

/** One record a store still holds for a data subject; `retainedBecause` is why it is kept after a deletion request, when the system says. */
export type DataRecord = Awaited<ReturnType<DataRecordsAdapter['records']>>[number]

export function recordsAdapter(adapter: CommerceSandboxAdapter | null | undefined | object): DataRecordsAdapter | null {
  const candidate = adapter as Partial<DataRecordsAdapter> | null | undefined
  return candidate && typeof candidate.records === 'function' ? candidate as DataRecordsAdapter : null
}

/** The run's data-records reader: `adapters.records`, else the commerce adapter's `records` (woocommerce and custom-command have one). */
export function recordsFor(context: CheckContext): DataRecordsAdapter | null {
  return context.adapters.records ?? recordsAdapter(context.adapters.commerce)
}

// ---------------------------------------------------------------------------------------------
// Findings, human review and status
// ---------------------------------------------------------------------------------------------

export interface OutcomeParts {
  findings: FindingDraft[]
  unconcluded: string[]
  evidence: string[]
  humanReview: HumanReviewItem[]
  coverage: RouteCoverage
  observations: string[]
  /** Lowest status the check reports when everything concluded (NEEDS_HUMAN_REVIEW for a statement only a human can judge). */
  floor?: ControlResultStatus
}

export function outcome(checkId: string, parts: OutcomeParts): CheckOutcome {
  return {
    checkId,
    status: statusOf(parts.findings, parts.unconcluded, parts.floor),
    reason: parts.unconcluded.length ? [...new Set(parts.unconcluded)].join('; ') : null,
    findings: parts.findings,
    evidence: [...new Set(parts.evidence)],
    humanReview: parts.humanReview,
    coverage: parts.coverage,
    observations: parts.observations,
  }
}

export const newParts = (): OutcomeParts => ({ findings: [], unconcluded: [], evidence: [], humanReview: [], coverage: emptyCoverage(), observations: [] })

// ---------------------------------------------------------------------------------------------
// Text and money
// ---------------------------------------------------------------------------------------------

export interface Money {
  /** Minor units (cents). */
  cents: number
  currency: string | null
}

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', 'kč': 'CZK', 'kc': 'CZK', 'eur': 'EUR', 'usd': 'USD', 'czk': 'CZK', 'gbp': 'GBP', 'huf': 'HUF', 'pln': 'PLN', 'zł': 'PLN', 'ft': 'HUF' }
const CURRENCY = String.raw`(€|\$|£|Kč|Kc|zł|EUR|USD|CZK|GBP|HUF|PLN|Ft)`
const AMOUNT = String.raw`(\d{1,3}(?:[   .,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`
const MONEY_PATTERN = new RegExp(String.raw`${CURRENCY}\s?${AMOUNT}|${AMOUNT}\s?${CURRENCY}`, 'i')

/** Parses the first amount of money in a text: "19,90 €", "€19.90", "1 234,50 Kč", "19.90 EUR". */
export function parseMoney(text: string | null | undefined): Money | null {
  if (!text) return null
  const match = MONEY_PATTERN.exec(normalise(text))
  if (!match) {
    const bare = /^\s*-?\d+(?:[.,]\d{1,2})?\s*$/.exec(text)
    return bare ? { cents: toCents(bare[0].trim()), currency: null } : null
  }
  const symbol = (match[1] ?? match[4] ?? '').toLowerCase()
  const amount = match[2] ?? match[3] ?? ''
  return { cents: toCents(amount), currency: CURRENCY_SYMBOLS[symbol] ?? symbol.toUpperCase() }
}

function toCents(amount: string): number {
  let text = amount.replace(/[   ]/g, '')
  const lastSep = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','))
  if (lastSep >= 0 && text.length - lastSep - 1 <= 2) {
    const whole = text.slice(0, lastSep).replace(/[.,]/g, '')
    const fraction = text.slice(lastSep + 1).padEnd(2, '0')
    return Number(whole) * 100 + Number(fraction)
  }
  text = text.replace(/[.,]/g, '')
  return Number(text) * 100
}

export const formatMoney = (money: Money | null): string => money ? `${(money.cents / 100).toFixed(2)}${money.currency ? ` ${money.currency}` : ''}` : 'unknown'

export const sameMoney = (a: Money, b: Money): boolean => a.cents === b.cents && (a.currency === null || b.currency === null || a.currency === b.currency)

/** Text of a page region around a match, for excerpts in findings. */
export function excerpt(text: string, pattern: RegExp, radius = 80): string | null {
  const match = pattern.exec(text)
  if (!match) return null
  return normalise(text.slice(Math.max(0, match.index - radius), match.index + match[0].length + radius))
}

/** Links on the current page, bounded. */
export async function pageLinks(page: AuditPage): Promise<Array<{ text: string; href: string }>> {
  return (await page.snapshot()).links
}

export const linkMatches = (link: { text: string; href: string }, pattern: RegExp): boolean => {
  if (pattern.test(link.text)) return true
  try { return pattern.test(decodeURIComponent(pathOf(link.href))) } catch { return pattern.test(link.href) }
}

export const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

export { draft, review, statusOf, notRun, emptyCoverage, throwIfAborted, pathOf, browserProblem, isAllowed, normalise, fold }
