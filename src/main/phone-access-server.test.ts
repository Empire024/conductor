import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID } from '../shared/remote-control'
import { PhoneAccessService } from './phone-access'
import { PhoneAccessServer } from './phone-access-server'
import { MemoryVault, type SecretKeyValueStore } from './secret-store'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function serviceFixture(): { service: PhoneAccessService; store: MapStore; ui: ReturnType<typeof vi.fn> } {
  const store = new MapStore()
  const ui = vi.fn(async () => ({}))
  const service = new PhoneAccessService({
    store, vault: new MemoryVault(),
    database: { listProjects: () => [], getProject: () => null, listSessions: () => [], listDetachedWindows: () => [], listProcesses: () => [], listAgentActivity: () => [], structured: { snapshot: () => null, spec: () => null, history: () => [], update: () => undefined } },
    sessions: { ensure: () => ({ id: 'x', available: false, status: 'unavailable', transcript: '' }), connectSession: async () => undefined, submit: async () => undefined, steer: async () => undefined, queue: async () => undefined, respond: async () => undefined, interrupt: async () => undefined, resume: async () => undefined },
    providers: () => [], machines: () => [{ id: LOCAL_MACHINE_ID, name: 'MAIN', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION }],
    machineName: () => 'MAIN', version: '0.1.3', ui,
    metrics: async () => ({ sampledAt: 'now', cpuPercent: 1, cpuCores: 4, memoryUsedBytes: 1, memoryTotalBytes: 2, gpus: [], processes: [], localServers: [], unavailable: [] }),
    push: vi.fn(async () => ({ status: 201, gone: false, retryAfter: null, body: '' })), log: () => undefined
  })
  return { service, store, ui }
}

interface Reply { status: number; headers: IncomingMessage['headers']; body: string; raw: Buffer }

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string; ca: string; servername?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = { host: '127.0.0.1', port, path, method: options.method ?? 'GET', ca: options.ca, rejectUnauthorized: true, headers: { host: `127.0.0.1:${port}`, ...options.headers }, ...(options.servername ? { servername: options.servername } : {}) }
    const req = httpsRequest(requestOptions, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: raw.toString('utf8'), raw }) })
    })
    req.once('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function listening(): Promise<{ service: PhoneAccessService; server: PhoneAccessServer; port: number; ca: string; ui: ReturnType<typeof vi.fn> }> {
  const { service, ui } = serviceFixture()
  service.updateSettings({ enabled: true, port: 0 })
  const server = new PhoneAccessServer({ service, localAddresses: () => ['127.0.0.1'], hostname: () => 'main-pc', assets: { 'index.html': '<!doctype html><script src="/app.js"></script>', 'app.js': 'console.log(1)', 'app.css': 'body{}', 'sw.js': 'self.x=1', 'manifest.webmanifest': '{}', 'icon.svg': '<svg/>' }, log: () => undefined })
  cleanup.push(() => server.dispose())
  const status = await server.apply()
  if (!status.listening) throw new Error('listener did not start: ' + status.message)
  const port = Number(new URL(status.endpoints[0]!).port)
  return { service, server, port, ca: service.certificateAuthority().certificatePem, ui }
}

async function pair(service: PhoneAccessService, port: number, ca: string): Promise<string> {
  const offer = service.createPairing()
  const reply = await call(port, '/api/pair', { method: 'POST', ca, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: offer.code, name: 'iPhone' }) })
  expect(reply.status).toBe(200)
  return (JSON.parse(reply.body) as { token: string }).token
}

describe('the phone listener', () => {
  it('stays off until enabled, then serves the app shell over the CA-signed chain with the right headers', { timeout: 20_000 }, async () => {
    const { service } = serviceFixture()
    const idle = new PhoneAccessServer({ service, localAddresses: () => ['127.0.0.1'], assets: { 'index.html': 'x' }, log: () => undefined })
    cleanup.push(() => idle.dispose())
    expect((await idle.apply()).listening).toBe(false)
    const { port, ca, service: live } = await listening()
    expect(live.desktopState()).toMatchObject({ listening: true, primaryEndpoint: `https://127.0.0.1:${port}`, pushConfigured: true })
    const index = await call(port, '/', { ca })
    expect(index.status).toBe(200)
    expect(index.headers['content-type']).toContain('text/html')
    expect(index.headers['content-security-policy']).toContain("script-src 'self'")
    expect(index.body).toContain('/app.js')
    const worker = await call(port, '/sw.js', { ca })
    expect(worker.headers['service-worker-allowed']).toBe('/')
    expect((await call(port, '/manifest.webmanifest', { ca })).headers['content-type']).toContain('application/manifest+json')
    const icon = await call(port, '/icon-192.png', { ca })
    expect(icon.status).toBe(200)
    expect(icon.raw.subarray(1, 4).toString('ascii')).toBe('PNG')
    const cached = await call(port, '/app.js', { ca, headers: { 'if-none-match': String(index.headers.etag ?? '') } })
    expect(cached.status).toBe(200)
    const same = await call(port, '/app.js', { ca, headers: { 'if-none-match': String(cached.headers.etag) } })
    expect(same.status).toBe(304)
    const certificate = await call(port, '/ca.crt', { ca })
    expect(certificate.headers['content-type']).toBe('application/x-x509-ca-cert')
    expect(certificate.body).toBe(ca)
    expect((await call(port, '/nope', { ca })).status).toBe(404)
    expect((await call(port, '/', { ca, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(405)
    const head = await call(port, '/', { ca, method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
  })

  it('pairs a phone, then answers only bearer-authenticated JSON from the app itself', { timeout: 20_000 }, async () => {
    const { service, port, ca } = await listening()
    const wrong = await call(port, '/api/pair', { method: 'POST', ca, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA', name: 'x' }) })
    expect(wrong.status).toBe(403)
    const token = await pair(service, port, ca)
    expect((await call(port, '/api/state', { ca })).status).toBe(401)
    expect((await call(port, '/api/state', { ca, headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    const state = await call(port, '/api/state', { ca, headers: { authorization: `Bearer ${token}` } })
    expect(state.status).toBe(200)
    expect(JSON.parse(state.body)).toMatchObject({ machineName: 'MAIN', sessions: [], counts: { attention: 0, working: 0 } })
    const me = await call(port, '/api/me', { ca, headers: { authorization: `Bearer ${token}` } })
    expect(JSON.parse(me.body)).toMatchObject({ name: 'iPhone', machineName: 'MAIN', notificationsAllowed: true })
    expect(JSON.parse(me.body).vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    const renamed = await call(port, '/api/me', { ca, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pixel' }) })
    expect(JSON.parse(renamed.body).name).toBe('Pixel')
    // Cross-site attempts are refused before anything is read, even with a valid token.
    const foreign = await call(port, '/api/me', { ca, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
    expect(foreign.status).toBe(403)
    const crossSite = await call(port, '/api/me', { ca, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' })
    expect(crossSite.status).toBe(403)
    const own = await call(port, '/api/me', { ca, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: `https://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ name: 'Own' }) })
    expect(own.status).toBe(200)
    expect((await call(port, '/api/me', { ca, method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(415)
    expect((await call(port, '/api/me', { ca, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{not json' })).status).toBe(400)
    expect((await call(port, '/api/me', { ca, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 100) }) })).status).toBe(413)
    expect((await call(port, '/api/sessions/missing', { ca, headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    expect((await call(port, '/api/whatever', { ca, headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    const metrics = await call(port, '/api/metrics', { ca, headers: { authorization: `Bearer ${token}` } })
    expect(JSON.parse(metrics.body)).toMatchObject({ system: { cpuCores: 4 }, runtimes: [] })
    const unpaired = await call(port, '/api/unpair', { ca, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })
    expect(unpaired.status).toBe(200)
    expect((await call(port, '/api/me', { ca, headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
  })

  it('streams the state to a paired phone and pushes a fresh one when something changes', { timeout: 20_000 }, async () => {
    const { service, port, ca } = await listening()
    const token = await pair(service, port, ca)
    const received: string[] = []
    const stream = await new Promise<{ response: IncomingMessage; done: Promise<void> }>((resolve, reject) => {
      const req = httpsRequest({ host: '127.0.0.1', port, path: '/api/stream', ca, rejectUnauthorized: true, headers: { authorization: `Bearer ${token}`, host: `127.0.0.1:${port}` } }, response => {
        const done = new Promise<void>(finish => { response.on('data', chunk => received.push(String(chunk))); response.on('end', finish); response.on('close', finish) })
        resolve({ response, done })
      })
      req.once('error', reject)
      req.end()
    })
    expect(stream.response.statusCode).toBe(200)
    expect(stream.response.headers['content-type']).toContain('text/event-stream')
    await vi.waitFor(() => { expect(received.join('')).toContain('event: state') }, { timeout: 10_000 })
    expect(received.join('')).toMatch(/^retry: 3000\n\n/)
    expect(service.desktopState().devices[0]?.connected).toBe(true)
    const before = received.join('').split('event: state').length
    service.refresh()
    await vi.waitFor(() => { expect(received.join('').split('event: state').length).toBeGreaterThan(before) }, { timeout: 10_000 })
    stream.response.destroy()
    await stream.done
    await vi.waitFor(() => { expect(service.streamCount()).toBe(0) }, { timeout: 10_000 })
    expect(service.desktopState().devices[0]?.connected).toBe(false)
  })

  it('refuses to start in Tailscale exposure without a tailnet address, and names the port when it is taken', { timeout: 20_000 }, async () => {
    const first = await listening()
    const { service } = serviceFixture()
    service.updateSettings({ enabled: true, exposure: 'tailscale', port: 0 })
    const server = new PhoneAccessServer({ service, localAddresses: () => ['127.0.0.1'], assets: { 'index.html': 'x' }, tailscale: { state: async () => ({ installed: true, backendState: 'NeedsLogin', self: null, peers: [], message: 'Tailscale is installed here but not signed in.', checkedAt: null }), last: () => ({ installed: true, backendState: null, self: null, peers: [], message: null, checkedAt: null }), selfAddress: async () => null }, log: () => undefined })
    cleanup.push(() => server.dispose())
    const status = await server.apply()
    expect(status).toMatchObject({ listening: false, message: 'Tailscale is installed here but not signed in.' })
    expect(service.desktopState().listening).toBe(false)
    service.updateSettings({ exposure: 'network', port: first.port })
    const clash = await server.apply()
    expect(clash.listening).toBe(false)
    expect(clash.message).toContain(`Port ${first.port} is already in use`)
  })
})
