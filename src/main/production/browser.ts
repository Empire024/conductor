import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, Frame, Page, Request, Route } from 'playwright-core'
import type {
  AuditBrowser, AuditPage, AxeResult, BrowserAvailability, ConsentAction, ConsentOutcome, ConsentState, CookieRecord, DeviceClass, DomSnapshot,
  EvidenceRef, EvidenceSink, MutationKind, NavigationResult, NetworkPolicy, ObservedRequest, OpenPageOptions, StorageRecord,
  StoredLoginStateRef, SyntheticValue, TestAccountRef,
} from '../../shared/production'
import type { ProductionEvidenceSink } from './evidence'
import { maskSecrets } from '../structured-store'
import { MAX_REDIRECT_HOPS, MutationRefused, NetworkGate, assertMutationAllowed, originOf, walkRedirects, type GateDecision, type NetworkGateOptions } from './netpolicy'
import { createTlsTrust, type TlsTrust, type TlsTrustOptions } from './tls-trust'

/**
 * The audit browser (docs/production-agent.md sections 1 and 4): Playwright over the bundled
 * Playwright Chromium, else system Edge, else Chrome, always headless, so no audit ever puts a
 * window on the owner's screen. Every `open` is a fresh browser context (no cookies, storage or
 * service workers carried over), and the network policy is attached to the context before the
 * first navigation.
 *
 * Top-level documents are fetched by the route handler itself with redirects off: Playwright only
 * routes the first URL of a redirect chain, so a hop that left the allowlist would otherwise be
 * followed unseen. An allowed hop is served as a tiny document that replaces itself with the
 * target, which comes back through the handler and is checked like any other navigation. A blocked
 * top-level navigation is answered `204 No Content`, which leaves the page where it was instead of
 * committing an error page. Subresources are fetched by the handler the same way, hop by hop
 * (`walkRedirects`), and the final response is handed to the page; only media and event streams,
 * which cannot be buffered, go to the network as the browser makes them. Service workers are blocked
 * so no request can bypass the handler, and popups are closed on sight.
 *
 * The handler's fetches go out over HTTP/1.1 from Node, where Playwright opens a new keep-alive socket
 * for every request in flight; a page with 40 assets opened 40 connections to one origin at once. A
 * browser keeps six per origin (or one HTTP/2 connection), and hosts that throttle a client over its
 * connection limit (LiteSpeed's per-client throttling) hold every new connection for a while after
 * such a burst, so the next page's document never answered and checks timed out at 20 s. Subresource
 * fetches therefore take one of `maxConnectionsPerOrigin` slots per origin, run-wide; a top-level
 * document never waits for one.
 *
 * The authenticated state comes from a login state the owner recorded by hand (`storageState`),
 * never from a login POST on production; see `loadLoginState`.
 */

export type EngineName = NonNullable<BrowserAvailability['engine']>

/** Loaded on first use, so the main process does not pay for Playwright at app start. */
const loadChromium = async (): Promise<BrowserType> => (await import('playwright-core')).chromium

export interface EngineResolution extends BrowserAvailability {
  executablePath: string | null
}

export interface ResolveEngineOptions {
  /** Force one engine; it still has to exist. */
  engine?: EngineName
  exists?: (path: string) => boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Where Playwright's bundled Chromium lives; default `chromium.executablePath()`. */
  bundledPath?: () => string | null
}

function systemCandidates(engine: 'msedge' | 'chrome', env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'], env.PROGRAMFILES ?? env.ProgramFiles, env.LOCALAPPDATA].filter((root): root is string => !!root)
    return roots.map(root => engine === 'msedge' ? join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  if (platform === 'darwin') return [engine === 'msedge' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  return engine === 'msedge' ? ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'] : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome']
}

/** Which executable an audit would use, without launching it. BLOCKED (available:false) names what is missing. */
export async function resolveEngine(options: ResolveEngineOptions = {}): Promise<EngineResolution> {
  const exists = options.exists ?? existsSync
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const chromium = options.bundledPath ? null : await loadChromium()
  const bundled = options.bundledPath ?? (() => { try { return chromium!.executablePath() } catch { return null } })
  const order: EngineName[] = options.engine ? [options.engine] : ['playwright-chromium', 'msedge', 'chrome']
  for (const engine of order) {
    const paths = engine === 'playwright-chromium' ? [bundled()].filter((path): path is string => !!path) : systemCandidates(engine, env, platform)
    const found = paths.find(path => exists(path))
    if (found) return { available: true, engine, reason: null, executablePath: found }
  }
  const wanted = options.engine ? `the ${options.engine} engine` : 'Playwright Chromium, Microsoft Edge or Google Chrome'
  return { available: false, engine: null, reason: `No audit browser: ${wanted} was not found on this machine`, executablePath: null }
}

export interface AuditBrowserOptions {
  /** Downloads and scratch files of this browser; every page still gets a fresh, empty context. */
  userDataDir: string
  engine?: EngineName
  /** Where `screenshot` writes; required for screenshots. */
  evidence?: EvidenceSink
  /**
   * Logs a test account in on a sandbox or local environment, for an account without a recorded
   * login state. Its `submit` needs a write authorization of an existing mutation kind; it is never
   * used on production, where only `TestAccountRef.storageState` reaches the authenticated state.
   */
  login?: (page: AuditPage, account: TestAccountRef) => Promise<void>
  /**
   * The environment's guest account whose recorded state (for example only a site-gate cookie) every
   * unauthenticated page loads; without it an unauthenticated page opens with nothing stored.
   */
  guest?: TestAccountRef | null
  /** Makes an account's recorded state usable before it is read (the unattended refresh); a rejection refuses the open. */
  prepareLogin?: (account: TestAccountRef) => Promise<void>
  /** Receives the cookie and storage values of a loaded login state, for redaction. Default: the evidence sink's `addSecrets`. */
  registerSecrets?: (values: string[]) => void
  navigationTimeoutMs?: number
  signal?: AbortSignal
  gate?: NetworkGateOptions
  /** For tests: resolve against a fake filesystem. */
  resolve?: ResolveEngineOptions
  /** For tests: how the environment's extra certificate trust (policy.tls) handshakes and reads CA files. */
  tlsTrust?: TlsTrustOptions
  /** Subresource fetches in flight per origin across the run (default six, a browser's HTTP/1.1 limit; 0 is no limit). */
  maxConnectionsPerOrigin?: number
}

export interface ProductionAuditBrowser extends AuditBrowser {
  readonly gate: NetworkGate
}

/** An authenticated open that cannot be served: no recorded login state, or one that is unusable. */
export class AuthUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthUnavailable'
  }
}

type LoginState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>
export const MAX_LOGIN_STATE_BYTES = 1024 * 1024

/**
 * Reads an owner-recorded Playwright storage state. Only cookies whose domain matches an allowed
 * origin and storage of allowed origins are kept; their values come back as secrets to redact. The
 * file is read in place and never copied.
 */
export function loadLoginState(ref: StoredLoginStateRef, allowedOrigins: readonly string[], label: string, now: number = Date.now()): { state: LoginState; secrets: string[]; dropped: number } {
  if (!ref.path || !isAbsolute(ref.path)) throw new AuthUnavailable(`The login state for ${label} must be an absolute path to a recorded storage-state file`)
  let text: string
  try {
    const size = statSync(ref.path).size
    if (size > MAX_LOGIN_STATE_BYTES) throw new AuthUnavailable(`The login state for ${label} is ${size} bytes, over the ${MAX_LOGIN_STATE_BYTES}-byte limit`)
    text = readFileSync(ref.path, 'utf8')
  } catch (error) {
    if (error instanceof AuthUnavailable) throw error
    throw new AuthUnavailable(`The login state for ${label} could not be read; record it again`)
  }
  let parsed: { cookies?: unknown; origins?: unknown }
  try { parsed = JSON.parse(text) } catch { throw new AuthUnavailable(`The login state for ${label} is not a storage-state JSON file`) }
  const hosts = allowedOrigins.map(origin => safeHost(origin)).filter((host): host is string => !!host)
  const cookies = (Array.isArray(parsed.cookies) ? parsed.cookies : []) as LoginState['cookies']
  const origins = (Array.isArray(parsed.origins) ? parsed.origins : []) as LoginState['origins']
  const keptCookies = cookies.filter(cookie => {
    const domain = String(cookie?.domain ?? '').replace(/^\./, '').toLowerCase()
    const live = typeof cookie?.expires !== 'number' || cookie.expires <= 0 || cookie.expires * 1000 > now
    return !!domain && live && typeof cookie.value === 'string' && hosts.some(host => host === domain || host.endsWith(`.${domain}`))
  })
  const keptOrigins = origins.filter(entry => allowedOrigins.includes(originOf(String(entry?.origin ?? '')) ?? '')).map(entry => ({
    origin: entry.origin,
    localStorage: (Array.isArray(entry.localStorage) ? entry.localStorage : []).filter(item => typeof item?.name === 'string' && typeof item.value === 'string'),
  }))
  if (!keptCookies.length && !keptOrigins.some(entry => entry.localStorage.length)) {
    throw new AuthUnavailable(`The login state for ${label} holds no cookies or storage for ${allowedOrigins.join(', ')} (expired cookies do not count)`)
  }
  const secrets = [...keptCookies.map(cookie => cookie.value), ...keptOrigins.flatMap(entry => entry.localStorage.map(item => item.value))]
    .filter(value => value.length >= 8)
  return { state: { cookies: keptCookies, origins: keptOrigins }, secrets, dropped: cookies.length - keptCookies.length + origins.length - keptOrigins.length }
}

export const DEVICE_PRESETS: Readonly<Record<DeviceClass, { viewport: { width: number; height: number }; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean }>> = {
  desktop: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
}

/** Fields whose value never appears in a screenshot. */
export const SENSITIVE_FIELDS = [
  'input[type="password"]', 'input[autocomplete^="cc-"]', 'input[autocomplete="one-time-code"]', 'input[name*="card" i]',
  'input[id*="card" i]', 'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[name*="iban" i]',
].join(', ')
const MASK_CSS = `${SENSITIVE_FIELDS} { -webkit-text-security: disc !important; color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }`
export const MASK_COLOR = '#000000'

const EXCERPT_CHARS = 4096
const DEFAULT_NAVIGATION_TIMEOUT = 20_000
const QUIET_MS = 500
/** Before the one retry of a navigation that timed out. */
const RETRY_PAUSE_MS = 2_000
/** How long a field may take to become visible before `fill` gives up on it (hidden, collapsed, a honeypot). */
const FIELD_VISIBLE_MS = 1_500
const FIELD_FILL_MS = 5_000
const SETTLE_REASON_MS = 1_000
/** Streams cannot be buffered here; they go to the network as the browser makes them (see fetchThroughHops). */
const STREAMING_TYPES = new Set(['media', 'eventsource'])
const READ_ONLY_METHODS = new Set(['GET', 'HEAD'])
const HOP_DROPPED_HEADERS = /^(host|content-length|cookie|connection|transfer-encoding)$/i
export const MAX_CONNECTIONS_PER_ORIGIN = 6

/** Per-origin slots for the handler's own fetches: at most `limit` in flight per origin, the rest wait in order. */
export class OriginLimiter {
  private readonly active = new Map<string, number>()
  private readonly waiting = new Map<string, Array<() => void>>()

  constructor(readonly limit: number = MAX_CONNECTIONS_PER_ORIGIN) {}

  inFlight(origin: string): number { return this.active.get(origin) ?? 0 }

  /** Resolves with the release function once a slot is free; release exactly once, in a `finally`. */
  async acquire(origin: string): Promise<() => void> {
    if (this.limit > 0 && this.inFlight(origin) >= this.limit) {
      await new Promise<void>(granted => {
        const queue = this.waiting.get(origin) ?? []
        queue.push(granted)
        this.waiting.set(origin, queue)
      })
    } else {
      this.active.set(origin, this.inFlight(origin) + 1)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.get(origin)?.shift()
      // A waiter inherits the slot, so the count stays where it is.
      if (next) return next()
      this.waiting.delete(origin)
      const left = this.inFlight(origin) - 1
      if (left > 0) this.active.set(origin, left); else this.active.delete(origin)
    }
  }
}

export function createAuditBrowser(policy: NetworkPolicy, options: AuditBrowserOptions): ProductionAuditBrowser {
  const frozen = deepFreeze(structuredClone(policy))
  const gate = new NetworkGate(frozen, options.gate)
  const tlsTrust = createTlsTrust(frozen, options.tlsTrust)
  const connections = new OriginLimiter(options.maxConnectionsPerOrigin ?? MAX_CONNECTIONS_PER_ORIGIN)
  let launched: Promise<Browser> | null = null
  let resolution: Promise<EngineResolution> | null = null
  const pages = new Set<AuditPageImpl>()
  let closed = false

  const availability = (): Promise<EngineResolution> => resolution ??= resolveEngine({ ...options.resolve, engine: options.engine ?? options.resolve?.engine })
  const launch = (): Promise<Browser> => launched ??= (async () => {
    const engine = await availability()
    if (!engine.available || !engine.executablePath) throw new Error(engine.reason ?? 'No audit browser available')
    mkdirSync(join(options.userDataDir, 'downloads'), { recursive: true })
    return (await loadChromium()).launch({
      executablePath: engine.executablePath,
      headless: true,
      downloadsPath: join(options.userDataDir, 'downloads'),
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      timeout: 30_000,
    })
  })()

  const close = async (): Promise<void> => {
    closed = true
    await Promise.all([...pages].map(page => page.close().catch(() => undefined)))
    if (launched) await launched.then(browser => browser.close(), () => undefined).catch(() => undefined)
  }
  options.signal?.addEventListener('abort', () => { void close() }, { once: true })

  return {
    gate,
    budget: () => ({ requests: gate.requestCount, exhausted: gate.exhausted }),
    async availability() {
      const { available, engine, reason } = await availability()
      return { available, engine, reason }
    },
    async open(openOptions: OpenPageOptions) {
      if (closed || options.signal?.aborted) throw new Error('The audit browser is closed')
      const account = openOptions.auth
      // An unauthenticated page still carries the guest account's state (a site gate), never a login.
      const stateAccount = account?.storageState ? account : !account && options.guest?.storageState ? options.guest : null
      let loginState: LoginState | undefined
      let secrets: string[] = []
      if (stateAccount) {
        if (options.prepareLogin) {
          try { await options.prepareLogin(stateAccount) } catch (error) { throw new AuthUnavailable(error instanceof Error ? error.message : String(error)) }
        }
        const loaded = loadLoginState(stateAccount.storageState!, frozen.allowedOrigins, stateAccount.label)
        loginState = loaded.state
        secrets = loaded.secrets
        const sink = options.evidence as Partial<ProductionEvidenceSink> | undefined
        const register = options.registerSecrets ?? (sink?.addSecrets ? (values: string[]) => sink.addSecrets!(values) : null)
        register?.(secrets)
      } else if (account && frozen.environmentKind === 'production') {
        throw new AuthUnavailable(`An authenticated audit of ${account.label} on production needs a login state the owner recorded by hand (storageState); the audit never logs in by POST`)
      } else if (account && !options.login) {
        throw new AuthUnavailable(`An authenticated audit of ${account.label} needs a recorded login state (storageState), or a login step whose submit a write authorization covers`)
      }
      const browser = await launch()
      const preset = DEVICE_PRESETS[openOptions.device]
      const locale = openOptions.locale ?? undefined
      const headers: Record<string, string> = {}
      if (openOptions.locale && (openOptions.regionSelection === 'accept-language' || openOptions.regionSelection === 'none')) headers['accept-language'] = `${openOptions.locale},${openOptions.locale.split('-')[0]};q=0.9`
      const contextOptions: BrowserContextOptions = {
        ...preset,
        userAgent: openOptions.device === 'mobile' ? `Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Mobile Safari/537.36` : undefined,
        locale,
        extraHTTPHeaders: headers,
        serviceWorkers: 'block',
        acceptDownloads: false,
        // A document served through the route handler has no known address space, so Chromium's local
        // network access checks would treat it as public and refuse its loopback subresources. The gate
        // already decides private addresses; a `local` environment grants them.
        permissions: frozen.allowPrivateAddresses ? ['local-network-access'] : [],
        storageState: loginState,
        // With extra trust, the page's own checks (Chromium's and route.fetch's, which cannot take a CA)
        // step aside: every HTTPS origin is verified by tlsTrust before its first request goes out.
        ignoreHTTPSErrors: !!tlsTrust,
      }
      // A system browser that does not know the permission refuses it; it has no such check to satisfy either.
      const context = await browser.newContext(contextOptions).catch(() => browser.newContext({ ...contextOptions, permissions: [] }))
      const page = new AuditPageImpl(context, gate, frozen, openOptions, options, secrets, tlsTrust, connections)
      await page.attach()
      pages.add(page)
      page.onClose(() => pages.delete(page))
      if (account && !account.storageState && options.login) await options.login(page, account)
      return page
    },
    close,
  }
}

interface NavigationState {
  settled: Promise<void>
  settle: () => void
  blocked: { outcome: 'off-allowlist' | 'blocked-by-policy'; url: string; reason: string } | null
  status: number | null
  finalUrl: string | null
  hops: number
  error: string | null
}

/**
 * One line of a navigation failure for evidence and reasons. Playwright appends a call log that lists
 * the request headers, cookies included, so only the first line is kept, its API prefix dropped and
 * the login state's values masked.
 */
export function failureDetail(failure: unknown, secrets: readonly string[] = []): string | null {
  if (failure === null || failure === undefined || failure === '') return null
  let line = (failure instanceof Error ? failure.message : String(failure)).split('\n')[0]!.trim()
  line = line.replace(/^(?:route\.fetch|page\.(?:goto|reload|waitForURL)|apiRequestContext\.fetch|Error):\s*/i, '')
  for (const secret of secrets) if (secret) line = line.split(secret).join('[REDACTED]')
  return maskSecrets(line).slice(0, 300) || null
}

const normaliseUrl = (url: string): string =>{ try { const parsed = new URL(url); parsed.hash = ''; return parsed.href } catch { return url } }
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

export class AuditPageImpl implements AuditPage {
  private page!: Page
  private readonly observed: ObservedRequest[] = []
  private readonly byRequest = new Map<Request, ObservedRequest>()
  /** URLs the check itself is navigating to, and the initiator each redirect hop inherits. */
  private readonly expected = new Map<string, ObservedRequest['initiator']>()
  private navigation: NavigationState | null = null
  private consentPending: ConsentState | null
  private consentResult: ConsentOutcome | null = null
  private readonly closeListeners: Array<() => void> = []
  private readonly inflight = new Set<Request>()
  private lastActivity = Date.now()
  private readonly timeout: number
  private closed = false

  constructor(
    private readonly context: BrowserContext,
    private readonly gate: NetworkGate,
    private readonly policy: NetworkPolicy,
    readonly options: OpenPageOptions,
    private readonly browserOptions: AuditBrowserOptions,
    private readonly secrets: readonly string[] = [],
    private readonly tlsTrust: TlsTrust | null = null,
    private readonly connections: OriginLimiter = new OriginLimiter(),
  ) {
    this.timeout = browserOptions.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT
    this.consentPending = ['rejected', 'accepted', 'selected', 'withdrawn'].includes(options.consent) ? options.consent : null
    if (!this.consentPending) this.consentResult = { state: options.consent, applied: options.consent === 'clean' || options.consent === 'no-interaction', mechanism: null }
  }

  async attach(): Promise<void> {
    // Bundlers that keep function names wrap page functions in `__name(...)`; give pages a no-op one.
    await this.context.addInitScript('globalThis.__name ??= (target) => target')
    await this.context.route('**/*', route => this.handle(route))
    await this.context.routeWebSocket(() => true, async ws => {
      const url = ws.url()
      const httpUrl = url.replace(/^ws/, 'http')
      const decision = this.gate.decide({ url: httpUrl, method: 'GET', resourceType: 'websocket', mainFrameNavigation: false, initiator: 'page' })
      const untrusted = decision.action === 'allow' && this.tlsTrust ? await this.tlsTrust.verify(url) : null
      const refused = decision.action === 'block' ? decision.reason : untrusted ?? (decision.party === 'first-party' && this.policy.readOnly ? 'read-only: first-party websocket refused' : null)
      this.record({ url, method: 'GET', resourceType: 'websocket', party: decision.party, initiator: 'page', blocked: refused, status: null, excerpt: excerptOf(url, null, this.secrets), at: new Date().toISOString() })
      if (refused) void ws.close({ code: 1008, reason: 'blocked by audit policy' }).catch(() => undefined)
      else ws.connectToServer()
    })
    this.page = await this.context.newPage()
    // Popups (window.open, target=_blank) are closed on sight; their navigation was already gated.
    this.context.on('page', popup => {
      if (popup !== this.page) void popup.close().catch(() => undefined)
    })
    this.page.setDefaultTimeout(this.timeout)
    this.page.on('dialog', dialog => { void dialog.dismiss().catch(() => undefined) })
    const settleRequest = (request: Request) => { this.inflight.delete(request); this.lastActivity = Date.now() }
    this.page.on('requestfinished', settleRequest)
    this.page.on('requestfailed', settleRequest)
    this.page.on('response', response => {
      const entry = this.byRequest.get(response.request())
      if (entry && entry.status === null) entry.status = response.status()
    })
    this.page.on('request', request => {
      this.inflight.add(request)
      this.lastActivity = Date.now()
      // Redirect hops of subresources are not routed (Playwright routes the first URL only); observe them.
      const from = request.redirectedFrom()
      if (!from || this.byRequest.has(request)) return
      this.track(request, this.describe(request, 'page'), null)
    })
    this.page.on('requestfailed', request => {
      const entry = this.byRequest.get(request)
      if (entry && entry.status === null && !entry.blocked) entry.status = 0
    })
  }

  onClose(listener: () => void): void { this.closeListeners.push(listener) }

  consentOutcome(): ConsentOutcome | null { return this.consentResult ? { ...this.consentResult } : null }

  private describe(request: Request, initiator: ObservedRequest['initiator']): ObservedRequest {
    return {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      party: this.gate.partyOf(request.url()),
      initiator,
      blocked: null,
      status: null,
      excerpt: excerptOf(request.url(), request.postData(), this.secrets),
      at: new Date().toISOString(),
    }
  }

  private record(entry: ObservedRequest): ObservedRequest {
    this.observed.push(entry)
    return entry
  }

  private track(request: Request, entry: ObservedRequest, blocked: string | null): ObservedRequest {
    entry.blocked = blocked
    this.byRequest.set(request, entry)
    return this.record(entry)
  }

  private isMainFrameNavigation(request: Request): boolean {
    try {
      return request.isNavigationRequest() && request.frame().parentFrame() === null
    } catch {
      return false
    }
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    try {
      if (this.isMainFrameNavigation(request)) return await this.handleNavigation(route, request)
      const entry = this.describe(request, 'page')
      const decision = await this.decide(request.url(), request.method(), request.resourceType(), false, 'page')
      if (decision.action === 'block') {
        this.track(request, entry, decision.reason)
        return await route.abort('blockedbyclient')
      }
      this.track(request, entry, null)
      if (decision.delayMs) await sleep(decision.delayMs)
      if (STREAMING_TYPES.has(request.resourceType())) return await route.continue()
      await this.fetchThroughHops(route, request, entry)
    } catch {
      // The context closed mid-request, or the request was already handled.
      await route.abort('failed').catch(() => undefined)
    }
  }

  /**
   * Makes a subresource request here, one redirect hop at a time, so every hop meets the gate the
   * way a first request does (Playwright routes only the first URL of a chain, and the browser would
   * follow the rest unseen). Hops after the first go through the context's request client, which
   * shares the browser's cookie jar; the final response is handed to the page as the answer to the
   * original request.
   */
  private async fetchThroughHops(route: Route, request: Request, entry: ObservedRequest): Promise<void> {
    const resourceType = request.resourceType()
    const originalMethod = request.method().toUpperCase()
    const body = request.postDataBuffer()
    const release = await this.connections.acquire(originOf(request.url()) ?? request.url())
    let walk
    try {
      walk = await walkRedirects(
        { url: request.url(), method: originalMethod },
        async ({ url, method, index }) => {
          if (index === 0) {
            const response = await route.fetch({ maxRedirects: 0, timeout: this.timeout })
            entry.status = response.status()
            return response
          }
          const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => !HOP_DROPPED_HEADERS.test(name) && !(method === 'GET' && /^content-type$/i.test(name))))
          return this.context.request.fetch(url, {
            method, headers, maxRedirects: 0, timeout: this.timeout, failOnStatusCode: false,
            data: method === originalMethod && body && !READ_ONLY_METHODS.has(method) ? body : undefined,
          })
        },
        (url, method) => this.decide(url, method, resourceType, false, 'page'),
      )
    } finally {
      release()
    }
    for (const hop of walk.hops) {
      this.record({ url: hop.url, method: hop.method, resourceType, party: this.gate.partyOf(hop.url), initiator: 'page', blocked: hop.blocked, status: hop.status, excerpt: excerptOf(hop.url, null, this.secrets), at: new Date().toISOString() })
    }
    if (!walk.response) return route.abort('blockedbyclient')
    return route.fulfill({ response: walk.response })
  }

  private async decide(url: string, method: string, resourceType: string, mainFrameNavigation: boolean, initiator: ObservedRequest['initiator'], consume = true): Promise<GateDecision> {
    const decision = this.gate.decide({ url, method, resourceType, mainFrameNavigation, initiator }, consume)
    if (decision.action === 'allow') {
      const host = safeHost(url)
      if (host && await this.gate.refusesHost(host)) {
        return { action: 'block', party: decision.party, outcome: 'blocked-by-policy', reason: `${host} resolves to a private address, refused for a ${this.policy.environmentKind} environment` }
      }
      const untrusted = this.tlsTrust ? await this.tlsTrust.verify(url) : null
      if (untrusted) return { action: 'block', party: decision.party, outcome: 'blocked-by-policy', reason: untrusted }
    }
    return decision
  }

  private async handleNavigation(route: Route, request: Request): Promise<void> {
    const url = request.url()
    const key = normaliseUrl(url)
    const initiator = this.expected.get(key) ?? 'navigation'
    this.expected.delete(key)
    const ownsNavigation = initiator === 'agent' ? this.navigation : null
    const entry = this.describe(request, initiator)
    const decision = await this.decide(url, request.method(), 'document', true, initiator)
    if (decision.action === 'block') {
      this.track(request, entry, decision.reason)
      if (ownsNavigation) { ownsNavigation.blocked = { outcome: decision.outcome, url, reason: decision.reason }; ownsNavigation.settle() }
      return route.fulfill({ status: 204, body: '' })
    }
    this.track(request, entry, null)
    if (decision.delayMs) await sleep(decision.delayMs)
    let response
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: this.timeout })
    } catch (error) {
      entry.status = 0
      if (ownsNavigation) { ownsNavigation.error = error instanceof Error ? error.message : String(error); ownsNavigation.settle() }
      return route.abort('failed')
    }
    const status = response.status()
    entry.status = status
    const location = response.headers()['location']
    if (status >= 300 && status < 400 && location) {
      const target = new URL(location, url).href
      const hop = await this.decide(target, 'GET', 'document', true, initiator, false)
      if (hop.action === 'block' || (ownsNavigation && ownsNavigation.hops >= MAX_REDIRECT_HOPS)) {
        const reason = hop.action === 'block' ? `redirect to ${target}: ${hop.reason}` : `more than ${MAX_REDIRECT_HOPS} redirects`
        this.record({ url: target, method: 'GET', resourceType: 'document', party: hop.party, initiator, blocked: reason, status: null, excerpt: excerptOf(target, null, this.secrets), at: new Date().toISOString() })
        if (ownsNavigation) { ownsNavigation.blocked = { outcome: hop.action === 'block' ? hop.outcome : 'blocked-by-policy', url: target, reason }; ownsNavigation.status = status; ownsNavigation.settle() }
        return route.fulfill({ status: 204, body: '' })
      }
      this.expected.set(normaliseUrl(target), initiator)
      if (ownsNavigation) ownsNavigation.hops++
      const headers = Object.fromEntries(response.headersArray().filter(header => !/^(location|content-length|content-encoding|content-type|transfer-encoding|content-security-policy)$/i.test(header.name)).reduce((map, header) => {
        const name = header.name.toLowerCase()
        map.set(name, map.has(name) ? `${map.get(name)}\n${header.value}` : header.value)
        return map
      }, new Map<string, string>()))
      return route.fulfill({
        status: 200,
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        body: `<!doctype html><meta charset="utf-8"><title>redirect</title><script>location.replace(${JSON.stringify(target)})</script>`,
      })
    }
    if (ownsNavigation) { ownsNavigation.status = status; ownsNavigation.finalUrl = key; ownsNavigation.settle() }
    return route.fulfill({ response })
  }

  private beginNavigation(url: string): NavigationState {
    let settle!: () => void
    const settled = new Promise<void>(done => { settle = done })
    const state: NavigationState = { settled, settle, blocked: null, status: null, finalUrl: null, hops: 0, error: null }
    this.navigation = state
    this.expected.set(normaliseUrl(url), 'agent')
    return state
  }

  private async navigate(requestedUrl: string, act: () => Promise<unknown>, waitMs = 0): Promise<NavigationResult> {
    const started = Date.now()
    const result = (finalUrl: string, status: number | null, outcome: NavigationResult['outcome'], detail: unknown = null): NavigationResult =>
      ({ requestedUrl, finalUrl, status, outcome, durationMs: Date.now() - started, ...(outcome === 'ok' ? {} : { detail: failureDetail(detail, this.secrets) }) })
    let target: string
    try { target = new URL(requestedUrl).href } catch { return result(requestedUrl, null, 'error', `not a URL: ${requestedUrl}`) }
    // Schemes and origins the route handler would never see (file:, javascript:, data:) or would refuse anyway.
    const pre = await this.decide(target, 'GET', 'document', true, 'agent', false)
    if (pre.action === 'block') {
      this.record({ url: target, method: 'GET', resourceType: 'document', party: pre.party, initiator: 'agent', blocked: pre.reason, status: null, excerpt: excerptOf(target, null, this.secrets), at: new Date().toISOString() })
      return result(target, null, pre.outcome, pre.reason)
    }
    const state = this.beginNavigation(target)
    let failure: unknown = null
    // Playwright's own promise follows whatever navigation the page starts next, and a page whose
    // self-submitting form the policy refuses never reaches DOMContentLoaded or load. The navigation
    // is also done once the document the handler served has committed; `loaded` covers the rest.
    const committed = new Promise<void>(resolve => {
      const onCommit = (frame: Frame) => { if (frame === this.page.mainFrame()) { this.page.off('framenavigated', onCommit); resolve() } }
      this.page.on('framenavigated', onCommit)
    })
    const acting = act().then(() => undefined, error => { failure = error })
    const served = state.settled.then(() => state.blocked || state.error || state.hops > 0 ? undefined : committed)
    const timedOut = await Promise.race([acting.then(() => false), served.then(() => false), sleep(this.timeout).then(() => true)])
    this.expected.delete(normaliseUrl(target))
    if (state.blocked) return result(state.blocked.url, state.status, state.blocked.outcome, state.blocked.reason)
    if (state.hops > 0 && state.finalUrl) {
      const finalUrl = state.finalUrl
      await this.page.waitForURL(url => normaliseUrl(url.href) === finalUrl, { waitUntil: 'domcontentloaded', timeout: this.timeout }).catch(error => { failure ??= error })
    }
    if (!timedOut && !failure) await this.loaded()
    if (waitMs > 0) await this.page.waitForTimeout(waitMs)
    // Leaving an error page, Chromium aborts the navigation before the handler's own fetch has failed; wait for its reason.
    if (failure && !timedOut && state.status === null && !state.error && !state.blocked) await Promise.race([state.settled, sleep(SETTLE_REASON_MS)])
    const late = state.blocked as NavigationState['blocked']
    if (late) return result(late.url, state.status, late.outcome, late.reason)
    if (timedOut || (failure && /timeout/i.test(String(failure)))) return result(this.page.url(), state.status, 'timeout', timedOut ? `no response within ${this.timeout} ms` : failure)
    // The handler's own fetch error (TLS, DNS, refused connection) says more than the page's net::ERR_FAILED.
    if (state.error || (failure && state.status === null)) return result(this.page.url(), state.status, 'error', state.error ?? failure)
    await this.reachConsent()
    return result(this.page.url(), state.status, 'ok')
  }

  /**
   * The load event, or the network going quiet: a page that starts another navigation while it
   * loads (a self-submitting form the policy then refuses) never fires `load`, and must not hold
   * the audit for the whole navigation timeout.
   */
  private async loaded(quietMs = QUIET_MS): Promise<void> {
    const deadline = Date.now() + this.timeout
    const quiet = (async () => {
      while (Date.now() < deadline) {
        if (this.inflight.size === 0 && Date.now() - this.lastActivity >= quietMs) return
        await sleep(50)
      }
    })()
    await Promise.race([this.page.waitForLoadState('load', { timeout: this.timeout }).catch(() => undefined), quiet])
  }

  /**
   * A navigation that times out is retried once, after a short pause, as a visitor would reload: a
   * host that throttles or briefly stalls one answer (haftheme's LiteSpeed, about one route in 30)
   * otherwise left a whole control UNVERIFIED on a single 20 s stall.
   */
  async goto(url: string, options: { waitMs?: number } = {}): Promise<NavigationResult> {
    const attempt = (): Promise<NavigationResult> => this.navigate(url, () => this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout }), options.waitMs)
    const first = await attempt()
    if (first.outcome !== 'timeout' || this.closed) return first
    await sleep(RETRY_PAUSE_MS)
    if (this.closed) return first
    const second = await attempt()
    const durationMs = first.durationMs + RETRY_PAUSE_MS + second.durationMs
    return second.outcome === 'timeout' ? { ...second, durationMs, detail: `${second.detail ?? 'timeout'} (twice: retried once)` } : { ...second, durationMs }
  }

  reload(): Promise<NavigationResult> {
    return this.navigate(this.page.url(), () => this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.timeout }))
  }

  /** Reaches the consent state requested in `open` after the first successful navigation. */
  private async reachConsent(): Promise<void> {
    const target = this.consentPending
    if (!target) return
    this.consentPending = null
    let outcome: { applied: boolean; mechanism: string | null }
    if (target === 'withdrawn') {
      const accepted = await this.consent({ action: 'accept' })
      outcome = accepted.applied ? await this.consent({ action: 'withdraw' }) : accepted
    } else {
      outcome = await this.consent(target === 'rejected' ? { action: 'reject' } : target === 'accepted' ? { action: 'accept' } : { action: 'select', categories: ['necessary', 'functional', 'preferences'] })
    }
    this.consentResult = { state: target, ...outcome }
  }

  async snapshot(): Promise<DomSnapshot> {
    const snapshot = await this.page.evaluate(SNAPSHOT_SCRIPT) as Omit<DomSnapshot, 'accessibilityTree'>
    let accessibilityTree = ''
    try { accessibilityTree = (await this.page.locator('body').ariaSnapshot({ timeout: 5000 })).slice(0, 50_000) } catch { /* no body or too slow: leave empty */ }
    return { ...snapshot, accessibilityTree }
  }

  requests(): ObservedRequest[] { return this.observed.map(entry => ({ ...entry })) }

  async cookies(): Promise<CookieRecord[]> {
    const hosts = this.policy.allowedOrigins.map(origin => safeHost(origin)).filter((host): host is string => !!host)
    return (await this.context.cookies()).map(cookie => {
      const domain = cookie.domain.replace(/^\./, '')
      const firstParty = hosts.some(host => host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`))
      return {
        name: cookie.name, domain: cookie.domain, path: cookie.path, expires: cookie.expires > 0 ? cookie.expires : null,
        secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite ?? null, party: firstParty ? 'first-party' : 'third-party',
      }
    })
  }

  async storage(): Promise<StorageRecord[]> {
    const records: StorageRecord[] = []
    for (const frame of this.page.frames()) {
      try { records.push(...await frame.evaluate(STORAGE_SCRIPT) as StorageRecord[]) } catch { /* detached or opaque frame */ }
    }
    return records
  }

  async screenshot(description: string): Promise<EvidenceRef> {
    const sink = this.browserOptions.evidence
    if (!sink) throw new Error('This audit browser has no evidence sink for screenshots')
    const bytes = await this.page.screenshot({
      type: 'png', animations: 'disabled', caret: 'hide',
      mask: [this.page.locator(SENSITIVE_FIELDS)], maskColor: MASK_COLOR, style: MASK_CSS,
    })
    return sink.writeBinary('screenshot', description, bytes, 'png')
  }

  evaluate<T>(expression: string): Promise<T> { return this.page.evaluate(expression) as Promise<T> }

  async consent(action: ConsentAction): Promise<{ applied: boolean; mechanism: string | null }> {
    if (action.action === 'withdraw') {
      const opened = await this.clickFirst(CMP.reopen, CONSENT_TEXT.reopen)
      if (opened) {
        await this.settle()
        const rejected = await this.clickFirst(CMP.reject, CONSENT_TEXT.reject)
        if (rejected) { await this.settle(); return { applied: true, mechanism: `${opened} → ${rejected}` } }
      }
      const api = await this.page.evaluate(CMP_API_SCRIPT, 'withdraw').catch(() => null) as string | null
      if (api) { await this.settle(); return { applied: true, mechanism: api } }
      return { applied: false, mechanism: null }
    }
    if (action.action === 'select') {
      const opened = await this.clickFirst(CMP.settings, CONSENT_TEXT.settings)
      if (!opened) return { applied: false, mechanism: null }
      await this.settle()
      const wanted = (action.categories ?? []).map(category => category.toLowerCase())
      await this.page.evaluate(SELECT_CATEGORIES_SCRIPT, wanted).catch(() => 0)
      const saved = await this.clickFirst(CMP.save, CONSENT_TEXT.save)
      if (!saved) return { applied: false, mechanism: opened }
      await this.settle()
      return { applied: true, mechanism: `${opened} → ${saved}` }
    }
    const clicked = await this.clickFirst(action.action === 'accept' ? CMP.accept : CMP.reject, action.action === 'accept' ? CONSENT_TEXT.accept : CONSENT_TEXT.reject)
    if (clicked) { await this.settle(); return { applied: true, mechanism: clicked } }
    const api = await this.page.evaluate(CMP_API_SCRIPT, action.action).catch(() => null) as string | null
    if (api) { await this.settle(); return { applied: true, mechanism: api } }
    return { applied: false, mechanism: null }
  }

  /**
   * Clicks the first visible control matching a known CMP selector, else the first visible button
   * whose text matches. A link that would navigate to another page is never clicked (a link
   * labelled "Accept cookies" can point anywhere); only buttons and same-page links qualify.
   */
  private async clickFirst(selectors: readonly string[], text: RegExp): Promise<string | null> {
    const candidate = await this.page.evaluate(FIND_CONTROL_SCRIPT, { selectors: [...selectors], text: text.source, flags: text.flags }).catch(() => null) as { index: number; mechanism: string } | null
    if (!candidate) return null
    const locator = this.page.locator('[data-conductor-consent-target]')
    try {
      await locator.first().click({ timeout: 3000, noWaitAfter: false })
    } catch {
      return null
    } finally {
      await this.page.evaluate(() => document.querySelectorAll('[data-conductor-consent-target]').forEach(element => element.removeAttribute('data-conductor-consent-target'))).catch(() => undefined)
    }
    return candidate.mechanism
  }

  private async settle(): Promise<void> {
    await this.page.waitForTimeout(100)
    await this.loaded(250)
  }

  /**
   * Types into the first matching field. A field that is not visible within FIELD_VISIBLE_MS is
   * refused at once: `page.fill` waits out the whole navigation timeout for a hidden field (a
   * collapsed search box, a honeypot), which made C04 take ~80 s a route and hit its 600 s cap.
   */
  async fill(selector: string, value: SyntheticValue): Promise<void> {
    const field = this.page.locator(selector).first()
    await field.waitFor({ state: 'visible', timeout: FIELD_VISIBLE_MS })
    await field.fill(value.value, { timeout: FIELD_FILL_MS })
  }

  async click(selector: string, options: { mutation?: MutationKind } = {}): Promise<void> {
    if (options.mutation) {
      assertMutationAllowed(this.policy, options.mutation)
      const disarm = this.gate.arm(options.mutation)
      try { await this.page.click(selector) ; await this.settle() } finally { disarm() }
      return
    }
    const submits = await this.page.evaluate(SUBMITS_FORM_SCRIPT, selector).catch(() => null) as string | null
    if (submits) throw new MutationRefused(null, `Clicking ${selector} would submit a ${submits} form; pass the mutation kind so it is checked against the write authorization`)
    await this.page.click(selector)
  }

  async submit(formSelector: string, mutation: MutationKind): Promise<NavigationResult> {
    assertMutationAllowed(this.policy, mutation)
    const disarm = this.gate.arm(mutation)
    const started = Date.now()
    try {
      const before = this.page.url()
      const navigation = this.page.waitForNavigation({ waitUntil: 'load', timeout: this.timeout }).catch(() => null)
      await this.page.$eval(formSelector, form => { (form as HTMLFormElement).requestSubmit() })
      const response = await navigation
      return { requestedUrl: before, finalUrl: this.page.url(), status: response?.status() ?? null, outcome: 'ok', durationMs: Date.now() - started }
    } finally {
      disarm()
    }
  }

  async keyboard(keys: string[]): Promise<Array<{ key: string; focusedSelector: string | null; focusVisible: boolean }>> {
    const trace: Array<{ key: string; focusedSelector: string | null; focusVisible: boolean }> = []
    for (const key of keys) {
      await this.page.keyboard.press(key)
      const focus = await this.page.evaluate(FOCUS_SCRIPT) as { focusedSelector: string | null; focusVisible: boolean }
      trace.push({ key, ...focus })
    }
    return trace
  }

  /** Zoom is emulated the way browser zoom affects layout: the CSS viewport shrinks by the zoom factor. */
  async setViewport(width: number, height: number, zoomPercent = 100): Promise<void> {
    const factor = zoomPercent > 0 ? zoomPercent / 100 : 1
    await this.page.setViewportSize({ width: Math.max(1, Math.round(width / factor)), height: Math.max(1, Math.round(height / factor)) })
  }

  async waitFor(ms: number): Promise<void> { await this.page.waitForTimeout(Math.max(0, Math.min(ms, 60_000))) }

  async axe(): Promise<AxeResult> {
    const axe = await import('axe-core')
    const source = (axe as unknown as { source: string; default?: { source: string } }).source ?? (axe as unknown as { default: { source: string } }).default.source
    await this.page.evaluate(source)
    return await this.page.evaluate(AXE_RUN_SCRIPT) as AxeResult
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.context.close().catch(() => undefined)
    for (const listener of this.closeListeners) listener()
  }
}

function safeHost(url: string): string | null {
  try { return new URL(url).hostname } catch { return null }
}

/** The query and body of a request, with secrets and a loaded login state's values masked; markers stay for leak searches. */
export function excerptOf(url: string, postData: string | null, secrets: readonly string[] = []): string {
  let query = ''
  try { query = new URL(url).search } catch { /* not a URL */ }
  let text = maskSecrets([query, postData ?? ''].filter(Boolean).join('\n'))
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]')
  return text.slice(0, EXCERPT_CHARS)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

// ---------------------------------------------------------------------------------------------
// Consent management platforms: selectors per action, then button text in the languages we audit.
// `data-consent-action` is the convention of the fixture sites.
// ---------------------------------------------------------------------------------------------

export const CMP = {
  accept: [
    '[data-consent-action="accept"]', '#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept', '.cmplz-accept', '.cky-btn-accept', '#didomi-notice-agree-button', '.iubenda-cs-accept-btn',
    '#cn-accept-cookie', '#cookie_action_close_header', '[data-cookie-accept-all]', '[data-testid="uc-accept-all-button"]', '.cm-btn-accept-all',
  ],
  reject: [
    '[data-consent-action="reject"]', '#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler', '#CybotCookiebotDialogBodyButtonDecline',
    '.cmplz-deny', '.cky-btn-reject', '#didomi-notice-disagree-button', '.iubenda-cs-reject-btn', '#cn-refuse-cookie',
    '#cookie_action_close_header_reject', '[data-cookie-refuse]', '[data-testid="uc-deny-all-button"]', '.cm-btn-decline',
  ],
  settings: [
    '[data-consent-action="settings"]', '#onetrust-pc-btn-handler', '#CybotCookiebotDialogBodyLevelButtonCustomize', '.cmplz-view-preferences',
    '.cky-btn-customize', '#didomi-notice-learn-more-button', '[data-testid="uc-more-button"]',
  ],
  save: [
    '[data-consent-action="save"]', '.save-preference-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection',
    '.cmplz-save-preferences', '.cky-btn-preferences', '[data-testid="uc-save-button"]',
  ],
  reopen: [
    '[data-consent-action="open"]', '[data-consent-action="withdraw"]', '#ot-sdk-btn', '.ot-sdk-show-settings', '.cmplz-manage-consent',
    '.cky-btn-revisit', '.iubenda-cs-preferences-link', '#CookiebotWidget .CookiebotWidget-logo',
  ],
} as const

export const CONSENT_TEXT = {
  accept: /^(accept|allow|agree|i agree|ok|got it|accept all|allow all|accept cookies|allow cookies|accept all cookies|súhlasím|prijať|prijať všetko|povoliť všetko|přijmout|přijmout vše|souhlasím|akzeptieren|alle akzeptieren|zustimmen)$/i,
  reject: /^(reject|decline|deny|refuse|reject all|decline all|deny all|only necessary|necessary only|use necessary cookies only|reject cookies|odmietnuť|odmietnuť všetko|odmítnout|odmítnout vše|ablehnen|alle ablehnen|nur notwendige)$/i,
  settings: /^(settings|preferences|customi[sz]e|manage|manage cookies|cookie settings|more options|nastavenia|nastavení|einstellungen)$/i,
  save: /^(save|save choices|save preferences|save settings|confirm my choices|allow selection|uložiť|uložit|speichern|auswahl speichern)$/i,
  reopen: /^(cookie settings|cookie preferences|manage cookies|manage consent|privacy settings|withdraw consent|change consent|nastavenia cookies|nastavení cookies|cookie-einstellungen)$/i,
}

// ---------------------------------------------------------------------------------------------
// Page scripts (run in the page, so they are plain functions without closures over this module).
// ---------------------------------------------------------------------------------------------

const FIND_CONTROL_SCRIPT = ({ selectors, text, flags }: { selectors: string[]; text: string; flags: string }): { index: number; mechanism: string } | null => {
  const visible = (element: Element): boolean => {
    const box = (element as HTMLElement).getBoundingClientRect()
    const style = getComputedStyle(element)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0
  }
  const navigatesAway = (element: Element): boolean => {
    const anchor = element.closest('a[href]') as HTMLAnchorElement | null
    if (!anchor) return false
    const raw = anchor.getAttribute('href') ?? ''
    if (raw === '' || raw.startsWith('#') || raw.toLowerCase().startsWith('javascript:')) return false
    const here = new URL(location.href); here.hash = ''
    const there = new URL(anchor.href, location.href); there.hash = ''
    return here.href !== there.href
  }
  const mark = (element: Element, mechanism: string, index: number) => {
    element.setAttribute('data-conductor-consent-target', '1')
    return { index, mechanism }
  }
  for (const [index, selector] of selectors.entries()) {
    let found: Element[] = []
    try { found = [...document.querySelectorAll(selector)] } catch { continue }
    const element = found.find(item => visible(item) && !navigatesAway(item))
    if (element) return mark(element, `selector:${selector}`, index)
  }
  const pattern = new RegExp(text, flags)
  const controls = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a')]
  for (const [index, element] of controls.entries()) {
    const label = ((element as HTMLInputElement).value && element.tagName === 'INPUT' ? (element as HTMLInputElement).value : (element as HTMLElement).innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()
    if (!label || !pattern.test(label) || !visible(element) || navigatesAway(element)) continue
    if (element.closest('form') && ((element as HTMLButtonElement).type === 'submit') && (element.closest('form')!.getAttribute('method') ?? 'get').toLowerCase() !== 'get') continue
    return mark(element, `text:${label}`, selectors.length + index)
  }
  return null
}

const CMP_API_SCRIPT = (action: string): string | null => {
  const w = window as unknown as Record<string, any>
  try {
    if (w.Cookiebot) {
      if (action === 'withdraw' && typeof w.Cookiebot.withdraw === 'function') { w.Cookiebot.withdraw(); return 'api:Cookiebot.withdraw' }
      if (typeof w.Cookiebot.submitCustomConsent === 'function') { const all = action === 'accept'; w.Cookiebot.submitCustomConsent(all, all, all); return `api:Cookiebot.submitCustomConsent(${all})` }
    }
    if (w.OneTrust) {
      if (action === 'accept' && typeof w.OneTrust.AllowAll === 'function') { w.OneTrust.AllowAll(); return 'api:OneTrust.AllowAll' }
      if (typeof w.OneTrust.RejectAll === 'function') { w.OneTrust.RejectAll(); return 'api:OneTrust.RejectAll' }
    }
    if (w.Didomi) {
      if (action === 'accept' && typeof w.Didomi.setUserAgreeToAll === 'function') { w.Didomi.setUserAgreeToAll(); return 'api:Didomi.setUserAgreeToAll' }
      if (typeof w.Didomi.setUserDisagreeToAll === 'function') { w.Didomi.setUserDisagreeToAll(); return 'api:Didomi.setUserDisagreeToAll' }
    }
  } catch { /* a CMP API threw: report not applied */ }
  return null
}

const SELECT_CATEGORIES_SCRIPT = (wanted: string[]): number => {
  let changed = 0
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
  for (const box of boxes) {
    if (box.disabled) continue
    const category = (box.getAttribute('data-consent-category') ?? box.name ?? box.id ?? '').toLowerCase()
    const label = ((box.labels?.[0]?.innerText ?? '') + ' ' + category).toLowerCase()
    const isCategory = box.hasAttribute('data-consent-category') || /cookie|consent|analytic|marketing|statistic|preference|functional|necessary|advertis/.test(label)
    if (!isCategory) continue
    const keep = wanted.some(item => label.includes(item))
    if (box.checked !== keep) { box.click(); changed++ }
  }
  return changed
}

const SUBMITS_FORM_SCRIPT = (selector: string): string | null => {
  const element = document.querySelector(selector) as HTMLButtonElement | HTMLInputElement | null
  if (!element) return null
  const form = element.closest('form')
  const isSubmit = (element.tagName === 'BUTTON' && (element.getAttribute('type') ?? 'submit').toLowerCase() === 'submit') ||
    (element.tagName === 'INPUT' && ['submit', 'image'].includes((element as HTMLInputElement).type))
  if (!form || !isSubmit) return null
  const method = (element.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
  return method === 'get' || method === 'dialog' ? null : method.toUpperCase()
}

const FOCUS_SCRIPT = (): { focusedSelector: string | null; focusVisible: boolean } => {
  const element = document.activeElement
  if (!element || element === document.body || element === document.documentElement) return { focusedSelector: null, focusVisible: false }
  const selectorOf = (node: Element): string => {
    if (node.id) return `#${CSS.escape(node.id)}`
    const parts: string[] = []
    let current: Element | null = node
    while (current && current !== document.body && parts.length < 12) {
      if (current.id) { parts.unshift(`#${CSS.escape(current.id)}`); break }
      const parent: Element | null = current.parentElement
      const tag = current.tagName.toLowerCase()
      const siblings = parent ? [...parent.children].filter(child => child.tagName === current!.tagName) : []
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag)
      current = parent
    }
    return parts.join(' > ')
  }
  const style = getComputedStyle(element)
  const indicator = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || (style.boxShadow !== 'none' && style.boxShadow !== '')
  return { focusedSelector: selectorOf(element), focusVisible: element.matches(':focus-visible') && indicator }
}

const STORAGE_SCRIPT = async (): Promise<Array<{ area: 'localStorage' | 'sessionStorage' | 'indexedDB'; origin: string; key: string; bytes: number }>> => {
  const out: Array<{ area: 'localStorage' | 'sessionStorage' | 'indexedDB'; origin: string; key: string; bytes: number }> = []
  for (const area of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[area]
      for (let index = 0; index < storage.length && index < 500; index++) {
        const key = storage.key(index)!
        out.push({ area, origin: location.origin, key, bytes: (key.length + (storage.getItem(key)?.length ?? 0)) * 2 })
      }
    } catch { /* storage disabled for this origin */ }
  }
  try {
    const databases = await (indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string }>> }).databases?.() ?? []
    for (const database of databases.slice(0, 100)) if (database.name) out.push({ area: 'indexedDB', origin: location.origin, key: database.name, bytes: 0 })
  } catch { /* not supported */ }
  return out
}

const SNAPSHOT_SCRIPT = (): Omit<DomSnapshot, 'accessibilityTree'> => {
  const norm = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()
  const selectorOf = (node: Element): string => {
    if (node.id) return `#${CSS.escape(node.id)}`
    const parent = node.parentElement
    const tag = node.tagName.toLowerCase()
    if (!parent) return tag
    const same = [...parent.children].filter(child => child.tagName === node.tagName)
    return `${parent === document.body ? 'body' : selectorOf(parent)} > ${same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag}`
  }
  const labelOf = (field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string | null => {
    const aria = field.getAttribute('aria-label')
    if (aria) return norm(aria)
    const labelledBy = field.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ')
      if (norm(text)) return norm(text)
    }
    const label = field.labels?.[0]
    if (label && norm(label.innerText)) return norm(label.innerText).slice(0, 200)
    const placeholder = field.getAttribute('placeholder')
    return placeholder ? norm(placeholder) : null
  }
  const forms = [...document.forms].slice(0, 50).map(form => ({
    selector: selectorOf(form),
    action: form.getAttribute('action') !== null ? form.action : null,
    method: (form.getAttribute('method') ?? 'get').toLowerCase(),
    fields: ([...form.elements] as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>)
      .filter(field => ['INPUT', 'SELECT', 'TEXTAREA'].includes(field.tagName))
      .slice(0, 100)
      .map(field => {
        const type = field.tagName === 'INPUT' ? (field as HTMLInputElement).type : field.tagName.toLowerCase()
        return {
          name: field.name || field.id || '',
          type,
          label: labelOf(field),
          required: field.required,
          defaultChecked: type === 'checkbox' || type === 'radio' ? (field as HTMLInputElement).defaultChecked : null,
          autocomplete: field.getAttribute('autocomplete'),
        }
      }),
  }))
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.getAttribute('lang'),
    headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].slice(0, 200).map(heading => ({ level: Number(heading.tagName[1]), text: norm((heading as HTMLElement).innerText).slice(0, 300) })),
    links: [...document.querySelectorAll('a[href]')].slice(0, 1000).map(anchor => ({ text: norm((anchor as HTMLElement).innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title')).slice(0, 200), href: (anchor as HTMLAnchorElement).href })),
    forms,
    text: norm(document.body?.innerText).slice(0, 100_000),
    images: [...document.images].slice(0, 500).map(image => ({
      src: image.currentSrc || image.src,
      alt: image.getAttribute('alt'),
      decorative: image.getAttribute('alt') === '' || ['presentation', 'none'].includes(image.getAttribute('role') ?? '') || image.getAttribute('aria-hidden') === 'true',
    })),
    scripts: [...document.scripts].slice(0, 300).map(script => script.src || 'inline'),
  }
}

const AXE_RUN_SCRIPT = async (): Promise<AxeResult> => {
  const axe = (window as unknown as { axe: any }).axe
  const result = await axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    resultTypes: ['violations', 'incomplete'],
  })
  return {
    violations: result.violations.slice(0, 200).map((violation: any) => ({
      id: violation.id, impact: violation.impact ?? null, help: violation.help,
      nodes: violation.nodes.slice(0, 50).map((node: any) => ({ target: [].concat(node.target).join(' '), html: String(node.html).slice(0, 300) })),
    })),
    incomplete: result.incomplete.slice(0, 200).map((item: any) => ({ id: item.id, help: item.help, count: item.nodes.length })),
    passes: result.passes.length,
    engine: `axe-core ${axe.version}`,
  }
}
