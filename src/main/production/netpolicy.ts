import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { AuditBudget, MutationKind, NetworkPolicy, ObservedRequest, ProductionEnvironment, SandboxWriteAuthorization } from '../../shared/production'

/**
 * The audit browser's outbound policy (docs/production-agent.md section 4, G3), enforced in code by
 * the route handler in browser.ts; nothing a page or a model says can change it.
 *
 * - Top-level navigations stay on `allowedOrigins`; one that leaves them (including a redirect hop)
 *   is stopped as `off-allowlist`. Third-party subresources are allowed and observed: they are the
 *   evidence for consent, vendor and replay checks.
 * - Private and loopback addresses are refused unless the environment kind is `local`.
 * - Under `readOnly` (every production environment, and any environment without a live write
 *   authorization) every non-GET/HEAD request to a first-party origin is aborted as
 *   `blocked-by-policy`. Outside read-only, a first-party mutation is let through only while the
 *   browser has armed an authorized mutation kind for a `submit` or `click({mutation})`.
 * - A GET that looks state-changing (a `/delete` or `/logout` path segment, `?action=delete`,
 *   `add-to-cart`, a WordPress nonce) is a mutation in disguise: refused under read-only.
 * - Every request counts against `maxRequests`. Top-level navigations and the audit's own requests
 *   are spaced per origin to `requestsPerSecondPerOrigin`; a page's own subresources are not.
 */

export class MutationRefused extends Error {
  constructor(readonly mutation: MutationKind | null, reason: string) {
    super(reason)
    this.name = 'MutationRefused'
  }
}

export const READ_METHODS = new Set(['GET', 'HEAD'])

/** Normalised `scheme://host[:port]`, or null for anything that is not http(s). */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** Loopback, private (RFC 1918), link-local, CGNAT/Tailscale, unique-local IPv6 and `localhost` names. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' ) return true
  const kind = isIP(host)
  if (kind === 4) return isPrivateIPv4(host)
  if (kind === 6) {
    if (host === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)
    if (mapped) return isPrivateIPv4(mapped[1]!)
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
    if (mappedHex) {
      const high = parseInt(mappedHex[1]!, 16), low = parseInt(mappedHex[2]!, 16)
      return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
  }
  return false
}

function isPrivateIPv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number) as [number, number]
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

const STATE_CHANGING_SEGMENTS = new Set([
  'delete', 'remove', 'destroy', 'logout', 'log-out', 'signout', 'sign-out', 'unsubscribe', 'cancel',
  'empty-cart', 'customer-logout',
])
const STATE_CHANGING_PARAMS = new Set(['add-to-cart', 'remove_item', 'remove-item', 'empty-cart', 'empty_cart', 'undo_item', '_wpnonce', 'delete', 'confirm', 'unsubscribe', 'cancel_order'])
const STATE_CHANGING_ACTIONS = /^(delete|remove|trash|destroy|logout|log-out|cancel|unsubscribe|empty-cart|purge|reset)/i

/**
 * A GET that is really a mutation on many sites (WordPress/WooCommerce action links, confirm links).
 * Refused under read-only and never crawled. A page such as `/my-account/delete-account/` that only
 * shows a form is not matched: only an exact state-changing path segment or an action parameter is.
 */
export function isStateChangingUrl(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  const segments = parsed.pathname.split('/').filter(Boolean).map(segment => decodeSafe(segment).toLowerCase())
  if (segments.some(segment => STATE_CHANGING_SEGMENTS.has(segment))) return true
  for (const [key, value] of parsed.searchParams) {
    const name = key.toLowerCase()
    if (STATE_CHANGING_PARAMS.has(name)) return true
    if ((name === 'action' || name === 'do' || name === 'task') && STATE_CHANGING_ACTIONS.test(value)) return true
  }
  return false
}

const decodeSafe = (text: string): string => { try { return decodeURIComponent(text) } catch { return text } }

/** The write authorization that is live for an environment right now, if any; never one for production. */
export function liveAuthorization(authorizations: readonly SandboxWriteAuthorization[], environment: ProductionEnvironment, now: Date = new Date()): SandboxWriteAuthorization | null {
  if (environment.kind === 'production') return null
  return authorizations.find(auth => auth.environmentId === environment.id && Date.parse(auth.expiresAt) > now.getTime()) ?? null
}

/** Derives the run's policy from the environment, the profile's authorizations and the budget. */
export function policyForEnvironment(environment: ProductionEnvironment, options: { authorizations?: readonly SandboxWriteAuthorization[]; budget: Pick<AuditBudget, 'maxRequests' | 'requestsPerSecondPerOrigin'>; now?: Date }): NetworkPolicy {
  const writeAuthorization = liveAuthorization(options.authorizations ?? [], environment, options.now)
  const allowedOrigins = [...new Set([environment.baseUrl, ...environment.allowedOrigins].map(originOf).filter((origin): origin is string => origin !== null))]
  return {
    environmentId: environment.id,
    environmentKind: environment.kind,
    allowedOrigins,
    readOnly: environment.kind === 'production' || writeAuthorization === null,
    writeAuthorization,
    maxRequests: options.budget.maxRequests,
    requestsPerSecondPerOrigin: options.budget.requestsPerSecondPerOrigin,
    allowPrivateAddresses: environment.kind === 'local',
    tls: tlsPolicyOf(environment),
  }
}

/** The environment's extra certificate trust as the audit browser takes it; production never has any. */
export function tlsPolicyOf(environment: Pick<ProductionEnvironment, 'kind' | 'tls'>): NetworkPolicy['tls'] {
  const tls = environment.tls
  if (!tls || environment.kind === 'production') return null
  const trustedCaPaths = [...(tls.trustedCaPaths ?? [])]
  return tls.allowSystemTrust || trustedCaPaths.length ? { allowSystemTrust: tls.allowSystemTrust === true, trustedCaPaths } : null
}

/** Throws MutationRefused unless the policy's live authorization names this mutation kind. Runs before any network. */
export function assertMutationAllowed(policy: NetworkPolicy, mutation: MutationKind, now: Date = new Date()): void {
  if (policy.environmentKind === 'production') throw new MutationRefused(mutation, `${mutation} refused: environment ${policy.environmentId} is production and read-only`)
  if (policy.readOnly || !policy.writeAuthorization) throw new MutationRefused(mutation, `${mutation} refused: sandbox write authorization required for ${mutation}`)
  const auth = policy.writeAuthorization
  if (auth.environmentId !== policy.environmentId) throw new MutationRefused(mutation, `${mutation} refused: the write authorization names environment ${auth.environmentId}, not ${policy.environmentId}`)
  if (Date.parse(auth.expiresAt) <= now.getTime()) throw new MutationRefused(mutation, `${mutation} refused: the write authorization expired at ${auth.expiresAt}`)
  if (!auth.mutations.includes(mutation)) throw new MutationRefused(mutation, `${mutation} refused: sandbox write authorization required for ${mutation} (authorized: ${auth.mutations.join(', ') || 'none'})`)
}

export interface RequestDescriptor {
  url: string
  method: string
  resourceType: string
  /** A document request for the page's main frame (a top-level navigation or a redirect hop of one). */
  mainFrameNavigation: boolean
  /** `agent` for the check's own goto/reload (and hops of it), `navigation` for hops of a page-initiated navigation, `page` otherwise. */
  initiator: ObservedRequest['initiator']
}

export type GateDecision =
  | { action: 'allow'; party: ObservedRequest['party']; delayMs: number }
  | { action: 'block'; party: ObservedRequest['party']; outcome: 'off-allowlist' | 'blocked-by-policy'; reason: string }

export interface NetworkGateOptions {
  /** Monotonic milliseconds; injectable for tests. */
  clock?: () => number
  /** Resolves a hostname's addresses (DNS); injectable for tests. Names that resolve to a private address are private. */
  resolve?: (hostname: string) => Promise<string[]>
}

/**
 * Per-run gate shared by every page of one audit browser: request budget and per-origin spacing
 * are run-wide. `decide` is synchronous and pure apart from the counters; `checkHost` adds the DNS
 * view of the private-address rule.
 */
export class NetworkGate {
  private count = 0
  private readonly nextSlot = new Map<string, number>()
  private readonly armed = new Map<MutationKind, number>()
  private readonly hostCache = new Map<string, Promise<boolean>>()
  private readonly allowed: Set<string>
  private readonly clock: () => number
  private readonly resolve: (hostname: string) => Promise<string[]>
  exhausted = false

  constructor(readonly policy: NetworkPolicy, options: NetworkGateOptions = {}) {
    this.allowed = new Set(policy.allowedOrigins.map(originOf).filter((origin): origin is string => origin !== null))
    this.clock = options.clock ?? (() => performance.now())
    this.resolve = options.resolve ?? (async hostname => (await lookup(hostname, { all: true })).map(entry => entry.address))
  }

  get requestCount(): number { return this.count }

  partyOf(url: string): ObservedRequest['party'] {
    const origin = originOf(url)
    return origin && this.allowed.has(origin) ? 'first-party' : 'third-party'
  }

  isAllowedOrigin(url: string): boolean { return this.partyOf(url) === 'first-party' }

  /** Lets first-party mutations of an authorized kind through until the returned function is called. */
  arm(mutation: MutationKind): () => void {
    assertMutationAllowed(this.policy, mutation)
    this.armed.set(mutation, (this.armed.get(mutation) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (this.armed.get(mutation) ?? 1) - 1
      if (left > 0) this.armed.set(mutation, left); else this.armed.delete(mutation)
    }
  }

  get armedMutations(): MutationKind[] { return [...this.armed.keys()] }

  /** True when the hostname (literal or resolved) is a private address the policy refuses. */
  async refusesHost(hostname: string): Promise<boolean> {
    if (this.policy.allowPrivateAddresses) return false
    if (isPrivateHost(hostname)) return true
    if (isIP(hostname.replace(/^\[|\]$/g, ''))) return false
    let cached = this.hostCache.get(hostname)
    if (!cached) {
      cached = this.resolve(hostname).then(addresses => addresses.some(isPrivateHost), () => false)
      this.hostCache.set(hostname, cached)
    }
    return cached
  }

  /** `consume: false` answers without counting the request or reserving a rate slot (pre-checks). */
  decide(request: RequestDescriptor, consume = true): GateDecision {
    const party = this.partyOf(request.url)
    let parsed: URL
    try { parsed = new URL(request.url) } catch { return { action: 'block', party, outcome: 'blocked-by-policy', reason: 'not a URL' } }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { action: 'block', party, outcome: 'blocked-by-policy', reason: `${parsed.protocol} ${request.mainFrameNavigation ? 'navigation' : 'request'} refused` }
    }
    if (!this.policy.allowPrivateAddresses && isPrivateHost(parsed.hostname)) {
      return { action: 'block', party, outcome: 'blocked-by-policy', reason: `private address ${parsed.hostname} refused for a ${this.policy.environmentKind} environment` }
    }
    if (request.mainFrameNavigation && party === 'third-party') {
      return { action: 'block', party, outcome: 'off-allowlist', reason: `navigation to ${parsed.origin} is off the allowlist` }
    }
    if (party === 'first-party') {
      const method = request.method.toUpperCase()
      if (!READ_METHODS.has(method)) {
        if (this.policy.readOnly) return { action: 'block', party, outcome: 'blocked-by-policy', reason: `read-only: ${method} to first-party ${parsed.origin} refused` }
        if (this.armed.size === 0) return { action: 'block', party, outcome: 'blocked-by-policy', reason: `${method} to first-party ${parsed.origin} refused: no authorized mutation in progress` }
      } else if (this.policy.readOnly && isStateChangingUrl(request.url)) {
        return { action: 'block', party, outcome: 'blocked-by-policy', reason: `read-only: state-changing GET ${parsed.pathname}${parsed.search} refused` }
      }
    }
    if (!consume) return { action: 'allow', party, delayMs: 0 }
    if (this.count >= this.policy.maxRequests) {
      this.exhausted = true
      return { action: 'block', party, outcome: 'blocked-by-policy', reason: `request budget of ${this.policy.maxRequests} reached` }
    }
    this.count++
    // Only navigations and the audit's own requests are spaced: they are what the crawl adds. A
    // page's subresources load as they would for one visitor; spacing them at a few per second made
    // an asset-heavy page miss its navigation timeout.
    const paced = request.mainFrameNavigation || request.initiator !== 'page'
    return { action: 'allow', party, delayMs: paced ? this.slot(parsed.origin) : 0 }
  }

  /** Reserves the next request slot for an origin and returns how long to wait for it. */
  private slot(origin: string): number {
    const rate = this.policy.requestsPerSecondPerOrigin
    if (!(rate > 0)) return 0
    const now = this.clock()
    const start = Math.max(now, this.nextSlot.get(origin) ?? now)
    this.nextSlot.set(origin, start + 1000 / rate)
    return Math.max(0, start - now)
  }
}

export const MAX_REDIRECT_HOPS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface RedirectHop {
  url: string
  method: string
  /** The gate's reason when it refused this hop; null when the hop was fetched. */
  blocked: string | null
  status: number | null
}

export interface RedirectWalk<R> {
  /** The first non-redirect response, or null when a hop was refused or the chain was too long. */
  response: R | null
  /** Every hop after the first request, in order, including the refused one. */
  hops: RedirectHop[]
  blocked: { url: string; outcome: 'off-allowlist' | 'blocked-by-policy'; reason: string } | null
}

/** The method a redirect hop is made with: 303 turns anything but HEAD into GET, 301/302 turn POST into GET, 307/308 keep it (and the body). */
export function redirectMethod(status: number, method: string): string {
  const upper = method.toUpperCase()
  if (status === 303 && upper !== 'HEAD') return 'GET'
  if ((status === 301 || status === 302) && upper === 'POST') return 'GET'
  return upper
}

/**
 * Follows a redirect chain one hop at a time, asking the gate about every hop before it is made, so
 * a hop is held to exactly the rules a first request is: a 307 that carries a POST from a third party
 * to the first party is a first-party POST, and a redirect to a private address or a state-changing
 * URL is refused before anything is sent to it. `fetchHop` is called with redirects off.
 */
export async function walkRedirects<R extends { status(): number; headers(): Record<string, string> }>(
  first: { url: string; method: string },
  fetchHop: (hop: { url: string; method: string; index: number }) => Promise<R>,
  decide: (url: string, method: string) => Promise<GateDecision>,
  options: { maxHops?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RedirectWalk<R>> {
  const maxHops = options.maxHops ?? MAX_REDIRECT_HOPS
  const wait = options.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)))
  const hops: RedirectHop[] = []
  let url = first.url
  let method = first.method.toUpperCase()
  let response = await fetchHop({ url, method, index: 0 })
  for (let index = 1; ; index++) {
    const status = response.status()
    const location = response.headers()['location']
    if (!REDIRECT_STATUSES.has(status) || !location) return { response, hops, blocked: null }
    let target: string
    try { target = new URL(location, url).href } catch { return { response, hops, blocked: null } }
    method = redirectMethod(status, method)
    if (index > maxHops) {
      const reason = `more than ${maxHops} redirects`
      hops.push({ url: target, method, blocked: reason, status: null })
      return { response: null, hops, blocked: { url: target, outcome: 'blocked-by-policy', reason } }
    }
    const decision = await decide(target, method)
    if (decision.action === 'block') {
      const reason = `redirect from ${url}: ${decision.reason}`
      hops.push({ url: target, method, blocked: reason, status: null })
      return { response: null, hops, blocked: { url: target, outcome: decision.outcome, reason } }
    }
    if (decision.delayMs) await wait(decision.delayMs)
    url = target
    response = await fetchHop({ url, method, index })
    hops.push({ url, method, blocked: null, status: response.status() })
  }
}
