import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, type SecureContext } from 'node:tls'
import { X509Certificate } from 'node:crypto'
import indexHtml from '../phone/index.html?raw'
import bootJs from '../phone/boot.js?raw'
import appJs from '../phone/app.js?raw'
import appCss from '../phone/app.css?raw'
import swJs from '../phone/sw.js?raw'
import manifestJson from '../phone/manifest.webmanifest?raw'
import iconSvg from '../phone/icon.svg?raw'
import { isPhoneOs, type PhoneDevice, type PhoneHealth } from '../shared/phone-access'
import type { TailscaleState } from '../shared/remote-control'
import { localAddresses } from './network-addresses'
import { PhoneAccessError, type PhoneAccessService, type PhoneListenerStatus, type PhoneTailnetDetail } from './phone-access'
import { PHONE_ICON_SIZES, renderPhoneIcon } from './phone-icon'
import { resolveBindHost } from './remote-control-server'
import { INSTALL_TAILSCALE_MESSAGE, isTailscaleAddress, isTailscaleIpv4, type TailscaleReader } from './tailscale'

const MAX_BODY = 1024 * 1024
const MAX_SOCKETS = 64
const MAX_STREAMS = 16
const MAX_STREAMS_PER_DEVICE = 4
const STREAM_PING_MS = 25_000
/** Renew a Tailscale certificate this long before it lapses; Let's Encrypt issues 90-day ones. */
const TAILSCALE_RENEW_BEFORE_MS = 14 * 86400000
const TAILSCALE_CHECK_MS = 12 * 3600 * 1000

export interface TailscaleCertificate { certificatePem: string; privateKeyPem: string; notAfter: string }

/** A feature module's own /api/<prefix> routes (the Ideas screen, src/main/ideas/register.ts).
 *  They run after the device is authenticated, exactly like the routes in PhoneAccessServer.route. */
export type PhoneApiRoute = (method: string, path: string, body: Record<string, unknown>, query: URLSearchParams, device: PhoneDevice) => Promise<unknown>
const phoneApiRoutes = new Map<string, PhoneApiRoute>()
export function registerPhoneApiRoute(prefix: string, route: PhoneApiRoute): () => void {
  phoneApiRoutes.set(prefix, route)
  return () => { if (phoneApiRoutes.get(prefix) === route) phoneApiRoutes.delete(prefix) }
}

export interface PhoneAccessServerDependencies {
  service: PhoneAccessService
  tailscale?: TailscaleReader
  /** Where `tailscale cert` may write its files; unset means the certificate cannot be requested. */
  tailscaleCert?(dnsName: string): Promise<TailscaleCertificate>
  localAddresses?(): string[]
  hostname?(): string
  /** Test seam: the files served at /, /app.js and so on. */
  assets?: Partial<Record<'index.html' | 'boot.js' | 'app.js' | 'app.css' | 'sw.js' | 'manifest.webmanifest' | 'icon.svg', string>>
  log?(message: string, error?: unknown): void
}

interface Asset { body: Buffer; type: string; headers?: Record<string, string> }

/**
 * Runs `tailscale cert` for the MagicDNS name. Tailscale talks to Let's Encrypt on this machine's
 * behalf and writes the pair to disk; it needs HTTPS enabled for the tailnet, which the CLI's own
 * error explains when it is not.
 */
export async function requestTailscaleCertificate(executable: string, dnsName: string, directory: string): Promise<TailscaleCertificate> {
  await mkdir(directory, { recursive: true })
  const certFile = join(directory, 'tailscale.crt'), keyFile = join(directory, 'tailscale.key')
  await new Promise<void>((resolve, reject) => {
    execFile(executable, ['cert', '--cert-file', certFile, '--key-file', keyFile, dnsName], { windowsHide: true, timeout: 90_000, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) { resolve(); return }
      const detail = String(stderr ?? '').trim().split('\n').at(-1) ?? ''
      reject(new Error(detail || error.message))
    })
  })
  const certificatePem = await readFile(certFile, 'utf8'), privateKeyPem = await readFile(keyFile, 'utf8')
  return { certificatePem, privateKeyPem, notAfter: new X509Certificate(certificatePem).validTo }
}

/** Everything a phone downloads is fixed at build time, so its ETag can be too. */
function asset(body: string | Buffer, type: string, headers?: Record<string, string>): Asset {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  return { body: bytes, type, headers: { ETag: '"' + createHash('sha256').update(bytes).digest('base64url').slice(0, 20) + '"', ...headers } }
}

/**
 * The tailnet as the setup steps need it, from one `tailscale status` reading. Peers are reduced
 * to the phone-shaped ones: the step "install Tailscale on your phone" is done the moment such a
 * peer exists, whether or not it has opened the app yet. No reading at all (no Tailscale service
 * wired, a test) reads as "not installed" with nothing known, never as a healthy empty tailnet.
 */
export function tailnetDetail(state: TailscaleState | undefined, now = (): number => Date.now()): PhoneTailnetDetail {
  if (!state) return { installed: false, backendState: null, loginName: null, httpsEnabled: null, phones: [], checkedAt: null }
  return {
    installed: state.installed,
    backendState: state.backendState,
    loginName: state.self?.loginName ?? null,
    httpsEnabled: state.certDomains ? state.certDomains.length > 0 : null,
    phones: state.peers
      .filter(peer => isPhoneOs(peer.os ?? ''))
      .map(peer => ({ hostName: peer.hostName || peer.dnsName.split('.')[0] || 'phone', os: (peer.os ?? '').toLowerCase(), online: peer.online, addresses: [...peer.addresses] })),
    checkedAt: state.checkedAt ?? new Date(now()).toISOString()
  }
}

const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

/**
 * The HTTPS door for phones. It serves the app shell and the JSON API on one port, over the
 * certificate chain the phone was taught to trust, and it is the only place a request's device is
 * decided: every API call below the pairing endpoint carries a bearer token that names one paired
 * phone, and a browser page from anywhere else cannot forge that header.
 */
export class PhoneAccessServer {
  private server?: Server
  private intent = 0
  private bound: { exposure: 'network' | 'tailscale'; host: string } | null = null
  private assets = new Map<string, Asset>()
  private tailscaleCertificate: TailscaleCertificate | null = null
  private tailscaleContext: SecureContext | null = null
  private tailscaleDnsName = ''
  private renewTimer: ReturnType<typeof setInterval> | null = null
  private status: PhoneListenerStatus = { listening: false, endpoints: [], message: null, tailscaleCertificate: 'off', tailscaleMessage: null, tailscaleAddress: null, tailscaleDnsName: null }

  constructor(private readonly deps: PhoneAccessServerDependencies) {
    const files = { 'index.html': indexHtml, 'boot.js': bootJs, 'app.js': appJs, 'app.css': appCss, 'sw.js': swJs, 'manifest.webmanifest': manifestJson, 'icon.svg': iconSvg, ...deps.assets }
    this.assets.set('/', asset(files['index.html'], 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' }))
    this.assets.set('/index.html', this.assets.get('/')!)
    // The boot guard is what shows an error when app.js cannot; it is small and cached like it.
    this.assets.set('/boot.js', asset(files['boot.js'], 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache' }))
    this.assets.set('/app.js', asset(files['app.js'], 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache' }))
    this.assets.set('/app.css', asset(files['app.css'], 'text/css; charset=utf-8', { 'Cache-Control': 'no-cache' }))
    this.assets.set('/sw.js', asset(files['sw.js'], 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }))
    this.assets.set('/manifest.webmanifest', asset(files['manifest.webmanifest'], 'application/manifest+json; charset=utf-8', { 'Cache-Control': 'no-cache' }))
    this.assets.set('/icon.svg', asset(files['icon.svg'], 'image/svg+xml; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' }))
    for (const size of PHONE_ICON_SIZES) this.assets.set(`/icon-${size}.png`, asset(renderPhoneIcon(size), 'image/png', { 'Cache-Control': 'public, max-age=86400' }))
  }

  private log(message: string, error?: unknown): void { (this.deps.log ?? ((text: string, reason?: unknown) => console.warn(text, reason ?? '')))(message, error) }

  getStatus(): PhoneListenerStatus { return { ...this.status, endpoints: [...this.status.endpoints] } }

  boundHost(): string | null { return this.bound?.host ?? null }

  private publish(status: PhoneListenerStatus): void {
    this.status = status
    this.deps.service.setListenerStatus(this.getStatus())
  }

  /** Starts, restarts or stops the listener so it matches the settings; safe to call repeatedly. */
  async apply(): Promise<PhoneListenerStatus> {
    const intent = ++this.intent
    const settings = this.deps.service.getSettings()
    await this.stopSocket()
    if (intent !== this.intent) return this.getStatus()
    // The last tailnet reading is good enough for a listener that is not starting; a fresh one is
    // taken below for one that is, and the setup steps' "Check again" takes its own.
    let detail = tailnetDetail(this.deps.tailscale?.last())
    const stopped = (message: string | null, extra: Partial<PhoneListenerStatus> = {}): PhoneListenerStatus => ({ listening: false, endpoints: [], message, tailscaleCertificate: 'off', tailscaleMessage: null, tailscaleAddress: null, tailscaleDnsName: null, tailnet: detail, ...extra })
    if (!settings.enabled) { this.publish(stopped(null)); return this.getStatus() }
    if (!(await this.vaultAvailable())) { this.publish(stopped('The OS credential store is unavailable, so the certificate key cannot be protected.')); return this.getStatus() }
    // The tailnet is read for both exposures: a phone on the tailnet reaches a 'network' listener
    // by the Tailscale address too, so the certificate should name it whenever it exists.
    const tailnet = await this.deps.tailscale?.state().catch(() => undefined)
    if (intent !== this.intent) return this.getStatus()
    detail = tailnetDetail(tailnet)
    const tailscaleAddress = tailnet?.self?.addresses.find(isTailscaleIpv4) ?? null
    const tailscaleIpv6 = tailnet?.self?.addresses.find(address => isTailscaleAddress(address) && !address.includes('.')) ?? null
    const dnsName = (tailnet?.self?.dnsName ?? '').replace(/\.$/, '')
    if (settings.exposure === 'tailscale' && !tailscaleAddress) {
      this.publish(stopped(tailnet?.message ?? (tailnet ? 'Tailscale has no address for this machine, so nothing is listening.' : INSTALL_TAILSCALE_MESSAGE), { tailscaleAddress, tailscaleDnsName: dnsName || null }))
      return this.getStatus()
    }
    // The tailnet adapter looks like any other interface to the OS, so it is taken out of the LAN
    // group here: under network exposure a phone on the Wi-Fi is the common case, and the code it
    // scans must name an address that phone can reach without Tailscale. Link-local addresses are
    // adapters with no network at all and are never worth naming.
    const lan = (this.deps.localAddresses ?? localAddresses)().filter(address => !isTailscaleAddress(address) && !address.startsWith('169.254.'))
    const hostName = (this.deps.hostname ?? osHostname)()
    const hosts = [...lan, ...(tailscaleAddress ? [tailscaleAddress] : []), ...(tailscaleIpv6 ? [tailscaleIpv6] : []), ...(dnsName ? [dnsName] : []), ...(hostName ? [hostName] : [])]
    let candidate: Server | undefined
    try {
      const identity = this.deps.service.serverIdentity(hosts)
      let certificateState: PhoneListenerStatus['tailscaleCertificate'] = 'off', certificateMessage: string | null = null
      if (settings.tailscaleCertificate && dnsName) {
        const result = await this.ensureTailscaleCertificate(dnsName)
        if (intent !== this.intent) return this.getStatus()
        certificateState = result.state; certificateMessage = result.message
      } else if (settings.tailscaleCertificate) certificateMessage = 'This machine has no MagicDNS name yet, so no certificate can be requested.'
      else { this.tailscaleCertificate = null; this.tailscaleContext = null; this.tailscaleDnsName = '' }
      const server = createServer({
        cert: identity.certificatePem, key: identity.privateKeyPem, minVersion: 'TLSv1.2',
        // The MagicDNS name is answered with the publicly trusted certificate when there is one;
        // every other name and every address gets the chain the phone installed.
        SNICallback: (servername, callback) => callback(null, this.tailscaleContext && servername.toLowerCase() === this.tailscaleDnsName ? this.tailscaleContext : undefined)
      }, (request, response) => { void this.handle(request, response) })
      candidate = server
      server.requestTimeout = 120_000
      server.headersTimeout = 10_000
      server.maxHeadersCount = 40
      server.maxConnections = MAX_SOCKETS
      // A phone keeps one idle keep-alive socket around between taps; that is fine, but a socket
      // that upgrades to anything is not one of ours.
      server.on('upgrade', (_request, socket) => { socket.destroy() })
      const bindHost = resolveBindHost({ exposure: settings.exposure }, tailscaleAddress)
      if (!bindHost) throw new Error('There is no address to listen on for this exposure.')
      await this.listen(server, settings.port, bindHost)
      if (intent !== this.intent) { await this.close(server); return this.getStatus() }
      server.on('error', error => {
        if (this.server !== server) return
        this.publish({ ...this.status, message: error instanceof Error ? error.message : String(error) })
      })
      this.server = server
      this.bound = { exposure: settings.exposure, host: bindHost }
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : settings.port
      const origin = (host: string): string => `https://${host.includes(':') ? `[${host}]` : host}:${port}`
      const endpoints = settings.exposure === 'tailscale'
        ? [...(certificateState === 'active' ? [origin(dnsName)] : []), origin(tailscaleAddress!), ...(certificateState !== 'active' && dnsName ? [origin(dnsName)] : [])]
        : [...(certificateState === 'active' && dnsName ? [origin(dnsName)] : []), ...lan.map(origin), ...(tailscaleAddress ? [origin(tailscaleAddress)] : []), ...(certificateState !== 'active' && dnsName ? [origin(dnsName)] : [])]
      this.publish({
        listening: true, endpoints: [...new Set(endpoints)],
        message: settings.exposure === 'tailscale'
          ? `Reachable over Tailscale at ${tailscaleAddress} and nowhere else. Only paired phones can use it.`
          : 'Reachable from this network. Only paired phones can use it.',
        tailscaleCertificate: certificateState, tailscaleMessage: certificateMessage, tailscaleAddress, tailscaleDnsName: dnsName || null, tailnet: detail
      })
      this.deps.service.ensurePushKeys()
      this.deps.service.seed()
      if (!this.renewTimer) this.renewTimer = setInterval(() => { void this.renew() }, TAILSCALE_CHECK_MS)
    } catch (error) {
      if (candidate) await this.close(candidate)
      if (intent !== this.intent) return this.getStatus()
      this.bound = null
      const detail = error instanceof Error ? error.message : String(error)
      const code = (error as { code?: string }).code
      this.publish(stopped(code === 'EADDRINUSE' ? `Port ${settings.port} is already in use on this machine. Choose another port.` : detail, { tailscaleAddress, tailscaleDnsName: dnsName || null }))
    }
    return this.getStatus()
  }

  private async vaultAvailable(): Promise<boolean> {
    try { return this.deps.service.desktopState().secureStorage } catch { return false }
  }

  private async ensureTailscaleCertificate(dnsName: string): Promise<{ state: PhoneListenerStatus['tailscaleCertificate']; message: string | null }> {
    const current = this.tailscaleCertificate
    if (current && this.tailscaleDnsName === dnsName.toLowerCase() && Date.parse(current.notAfter) - Date.now() > TAILSCALE_RENEW_BEFORE_MS) return { state: 'active', message: null }
    if (!this.deps.tailscaleCert) return { state: 'failed', message: 'Tailscale certificates are unavailable in this Conductor.' }
    try {
      const issued = await this.deps.tailscaleCert(dnsName)
      this.tailscaleCertificate = issued
      this.tailscaleContext = createSecureContext({ cert: issued.certificatePem, key: issued.privateKeyPem, minVersion: 'TLSv1.2' })
      this.tailscaleDnsName = dnsName.toLowerCase()
      return { state: 'active', message: null }
    } catch (error) {
      this.tailscaleCertificate = null; this.tailscaleContext = null; this.tailscaleDnsName = ''
      const detail = error instanceof Error ? error.message : String(error)
      return { state: 'failed', message: `Tailscale did not issue a certificate: ${detail} Enable HTTPS certificates for your tailnet at https://login.tailscale.com/admin/dns, or install the Conductor certificate on the phone instead.` }
    }
  }

  /**
   * A fresh tailnet reading for the setup steps: peers (a phone that just signed in), the HTTPS
   * switch, the login name. The socket is left alone unless the tailnet address it depends on
   * moved, appeared or vanished, in which case only a restart can follow it.
   */
  async check(): Promise<PhoneListenerStatus> {
    const tailnet = await this.deps.tailscale?.state(true).catch(() => undefined)
    const address = tailnet?.self?.addresses.find(isTailscaleIpv4) ?? null
    const settings = this.deps.service.getSettings()
    const moved = this.bound?.exposure === 'tailscale' ? this.bound.host !== address : address !== this.status.tailscaleAddress
    if (settings.enabled && moved) return this.apply()
    this.publish({ ...this.status, tailnet: tailnetDetail(tailnet) })
    return this.getStatus()
  }

  /** Renews the Tailscale certificate in place; nothing else about the listener changes. */
  private async renew(): Promise<void> {
    if (!this.server || !this.tailscaleCertificate || !this.tailscaleDnsName) return
    if (Date.parse(this.tailscaleCertificate.notAfter) - Date.now() > TAILSCALE_RENEW_BEFORE_MS) return
    const result = await this.ensureTailscaleCertificate(this.tailscaleDnsName)
    this.publish({ ...this.status, tailscaleCertificate: result.state, tailscaleMessage: result.message })
  }

  private listen(server: Server, port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { server.off('error', failed); server.off('listening', listening) }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const listening = (): void => { cleanup(); resolve() }
      server.once('error', failed)
      server.once('listening', listening)
      try { server.listen(port, host) } catch (error) { cleanup(); reject(error) }
    })
  }

  private close(server: Server): Promise<void> {
    return new Promise<void>(resolve => {
      let settled = false
      const done = (): void => { if (!settled) { settled = true; resolve() } }
      try { server.closeAllConnections() } catch { /* never listened */ }
      try { server.close(() => done()) } catch { done() }
      setTimeout(done, 2000).unref()
    })
  }

  private async stopSocket(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.bound = null
    if (server) await this.close(server)
    if (this.status.listening) this.publish({ ...this.status, listening: false, endpoints: [] })
  }

  async stop(): Promise<void> {
    ++this.intent
    await this.stopSocket()
    this.publish({ listening: false, endpoints: [], message: null, tailscaleCertificate: 'off', tailscaleMessage: null, tailscaleAddress: null, tailscaleDnsName: null })
  }

  async dispose(): Promise<void> {
    if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = null }
    await this.stop()
  }

  /* ----------------------------------------------------------------------- *
   * Requests
   * ----------------------------------------------------------------------- */

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      if (response.destroyed || response.writableEnded || response.headersSent) return
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers })
      response.end(JSON.stringify(body))
    }
    try {
      if (this.bound?.exposure === 'tailscale' && !isTailscaleAddress(request.socket.remoteAddress ?? '')) throw new PhoneAccessError('This machine only accepts phones over Tailscale.', 403)
      const url = new URL(request.url ?? '/', 'https://phone.invalid')
      const method = (request.method ?? 'GET').toUpperCase()
      // The one answer a phone gets before it is paired: proof it reached Conductor at all. A
      // failure before this point is the network, the address or the certificate, never pairing.
      if (url.pathname === '/api/health') {
        if (method !== 'GET' && method !== 'HEAD') throw new PhoneAccessError('Method not allowed', 405)
        const health: PhoneHealth = { ok: true, version: this.deps.service.version(), exposure: this.bound?.exposure ?? this.deps.service.getSettings().exposure, at: new Date().toISOString(), viaTailscale: isTailscaleAddress(request.socket.remoteAddress ?? '') }
        reply(200, health)
        return
      }
      if (!url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') { reply(405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' }); request.resume(); return }
        if (url.pathname === '/ca.crt') {
          const authority = this.deps.service.certificateAuthority()
          response.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="conductor-phone-ca.crt"', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
          response.end(method === 'HEAD' ? undefined : authority.certificatePem)
          return
        }
        const file = this.assets.get(url.pathname)
        if (!file) { reply(404, { error: 'Not found' }); request.resume(); return }
        if (file.headers?.ETag && request.headers['if-none-match'] === file.headers.ETag) { response.writeHead(304, { ETag: file.headers.ETag }); response.end(); return }
        response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': String(file.body.length), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...file.headers })
        response.end(method === 'HEAD' ? undefined : file.body)
        return
      }
      if (method !== 'GET' && method !== 'POST') throw new PhoneAccessError('Method not allowed', 405)
      if (method === 'POST') {
        // The bearer header already stops a foreign page from calling in, since no CORS grant is
        // ever issued; the origin check is the belt to that brace.
        const origin = request.headers.origin
        const host = request.headers.host ?? ''
        if (origin && origin.toLowerCase() !== `https://${host.toLowerCase()}`) throw new PhoneAccessError('Requests must come from the phone app itself.', 403)
        const site = String(request.headers['sec-fetch-site'] ?? '')
        if (site && site !== 'same-origin' && site !== 'none') throw new PhoneAccessError('Requests must come from the phone app itself.', 403)
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new PhoneAccessError('Send JSON.', 415)
      }
      const body = method === 'POST' ? await this.body(request) : {}
      const address = request.socket.remoteAddress ?? 'unknown'
      if (url.pathname === '/api/pair') {
        if (method !== 'POST') throw new PhoneAccessError('Method not allowed', 405)
        reply(200, this.deps.service.redeemPairing({ code: body.code, name: body.name, userAgent: request.headers['user-agent'], address }))
        return
      }
      const header = request.headers.authorization ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      const device = this.deps.service.authenticate(token)
      if (!device) { reply(401, { error: 'This phone is not paired, or its access was revoked.' }); request.resume(); return }
      if (url.pathname === '/api/stream') { if (method !== 'GET') throw new PhoneAccessError('Method not allowed', 405); this.stream(device, request, response); return }
      reply(200, await this.route(method, url.pathname, body, device, url.searchParams))
    } catch (error) {
      request.resume()
      const status = error instanceof PhoneAccessError ? error.status : 400
      reply(status, { error: error instanceof Error ? error.message : 'Request failed' })
    }
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (Number(request.headers['content-length']) > MAX_BODY) throw new PhoneAccessError('Request exceeds 1 MiB.', 413)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk as Buffer)
      if (size > MAX_BODY) throw new PhoneAccessError('Request exceeds 1 MiB.', 413)
      chunks.push(Buffer.from(chunk as Buffer))
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return {}
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new PhoneAccessError('Malformed JSON body.', 400) }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }

  private async route(method: string, path: string, body: Record<string, unknown>, device: PhoneDevice, query:URLSearchParams): Promise<unknown> {
    const { service } = this.deps
    const get = method === 'GET', post = method === 'POST'
    if (path === '/api/me' && get) return service.self(device.id)
    if (path === '/api/me' && post) return service.rename(device.id, body.name)
    if (path === '/api/unpair' && post) { service.revoke(device.id); return { ok: true } }
    if (path === '/api/state' && get) return service.phoneState()
    if (path === '/api/metrics' && get) return service.metrics()
    if (path === '/api/tabs/open' && post) return service.openTab(body as never)
    const projectTasks = path.match(/^\/api\/projects\/([^/]+)\/tasks$/)
    if (projectTasks && get) return service.listProjectTasks(decodeURIComponent(projectTasks[1]!), { offset: query.get('offset') ?? undefined, limit: query.get('limit') ?? undefined })
    if (projectTasks && post) return service.createProjectTask(decodeURIComponent(projectTasks[1]!), body as never)
    if (path === '/api/push/subscribe' && post) { service.setSubscription(device.id, body.subscription); return { ok: true } }
    if (path === '/api/push/unsubscribe' && post) { service.setSubscription(device.id, null); return { ok: true } }
    if (path === '/api/push/test' && post) return { ok: true, ...await service.testNotification(device.id) }
    if (path === '/api/notifications' && post) return service.setNotificationPrefs(device.id, body.prefs)
    const session = path.match(/^\/api\/sessions\/([^/]+)(?:\/(message|respond|interrupt|resume))?$/)
    if (session) {
      const id = decodeURIComponent(session[1]!), action = session[2]
      if (!action && get) return service.conversation(id)
      if (action && post) {
        if (action === 'message') return service.sendMessage(id, { text: body.text, mode: body.mode })
        if (action === 'respond') return service.respond(id, { requestId: body.requestId, decision: body.decision, answers: body.answers })
        if (action === 'interrupt') return service.interrupt(id)
        return service.resume(id)
      }
    }
    for (const [prefix, extension] of phoneApiRoutes) if (path === prefix || path.startsWith(prefix + '/')) return extension(method, path, body, query, device)
    throw new PhoneAccessError('Unknown route.', 404)
  }

  /** One long-lived response per open app; the service writes events into it until it closes. */
  private stream(device: PhoneDevice, request: IncomingMessage, response: ServerResponse): void {
    const { service } = this.deps
    if (service.streamCount() >= MAX_STREAMS) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Too many open phone streams.' })); return }
    if (service.streamCount(device.id) >= MAX_STREAMS_PER_DEVICE) { response.writeHead(429, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'This phone has too many open streams; close other tabs.' })); return }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' })
    response.write('retry: 3000\n\n')
    request.socket.setNoDelay(true)
    request.socket.setKeepAlive(true, 30_000)
    const write = (event: string, data: unknown): void => {
      if (response.destroyed || response.writableEnded) throw new Error('stream closed')
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    let unsubscribe: (() => void) | null = null
    const ping = setInterval(() => { try { write('ping', { at: new Date().toISOString() }) } catch { cleanup() } }, STREAM_PING_MS)
    const cleanup = (): void => {
      clearInterval(ping)
      unsubscribe?.(); unsubscribe = null
      if (!response.writableEnded) try { response.end() } catch { /* already gone */ }
    }
    request.on('close', cleanup)
    response.on('close', cleanup)
    response.on('error', cleanup)
    try { unsubscribe = service.subscribe(device.id, write) } catch (error) { this.log('Phone stream refused', error); cleanup() }
  }
}
