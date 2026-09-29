import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'

/**
 * Local fixture sites for the Production agent's tests and the fixture suite
 * (docs/production-agent.md section 11). Every site gets its own server on 127.0.0.1 and port 0,
 * so each is its own origin and root-relative paths (`/delete`) mean what they say. No test touches
 * the external network.
 *
 * Each site is a directory of static files plus an optional `site.json`:
 *
 * ```json
 * {
 *   "setCookie": { "/": ["sid=abc; Path=/"] },        // Set-Cookie headers per exact path
 *   "delayMs": { "/js/tracker.js": 1500 },              // response delay per exact path (delayed scripts)
 *   "headers": { "/": { "cache-control": "no-store" } },
 *   "status": { "/gone": 410 },
 *   "mutationPaths": ["/delete"]                         // any method, GET included, is a recorded mutation
 * }
 * ```
 *
 * Built-in endpoints on every site:
 * - any POST/PUT/PATCH/DELETE is recorded in the mutation log and answered 200 (`{"recorded":true}`);
 * - `/__redirect?to=<url>&status=302` redirects;
 * - `/__collect` accepts any method (a tracker endpoint when the site plays a third party);
 * - `/__mutations` returns this site's mutation log as JSON (read-back for smokes).
 *
 * Text files may use placeholders filled at serve time: `{{origin}}` (this site), `{{origin:<site>}}`
 * (a sibling site served by the same call) and `{{alias:<site>}}` (the same server as
 * `http://localhost:<port>`, a different origin from `127.0.0.1:<port>`, for off-allowlist tests).
 */

export const FIXTURE_SITES_DIR = join(__dirname, 'sites')

export interface SiteDirectives {
  setCookie?: Record<string, string[]>
  delayMs?: Record<string, number>
  headers?: Record<string, Record<string, string>>
  status?: Record<string, number>
  mutationPaths?: string[]
}

export interface FixtureRequestRecord {
  site: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
  at: number
}

export interface FixtureSite {
  name: string
  origin: string
  /** Same server under `localhost`: a different origin, for off-allowlist tests. */
  aliasOrigin: string
  port: number
  url(path?: string): string
}

export interface FixtureServer {
  sites: Record<string, FixtureSite>
  site(name: string): FixtureSite
  /** Mutations (non-GET/HEAD requests and any request to a `mutationPaths` entry), optionally for one site. */
  mutations(site?: string): FixtureRequestRecord[]
  /** Every request received, optionally for one site. */
  requests(site?: string): FixtureRequestRecord[]
  /** Requests to `/__collect`, optionally for one site. */
  collected(site?: string): FixtureRequestRecord[]
  reset(): void
  close(): Promise<void>
}

export interface FixtureServerOptions {
  /** Site names under `root` (default the bundled sites directory), or absolute directories. */
  sites: string[]
  root?: string
  /** Keep request and mutation logs (default true). */
  record?: boolean
  /** Extra placeholder values, `{{name}}` → value. */
  placeholders?: Record<string, string>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.php': 'text/plain; charset=utf-8',
}
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.svg'])
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const MAX_BODY = 64 * 1024

export async function createFixtureServer(options: FixtureServerOptions): Promise<FixtureServer> {
  const root = options.root ?? FIXTURE_SITES_DIR
  const record = options.record ?? true
  const log: FixtureRequestRecord[] = []
  const servers: Server[] = []
  const sites: Record<string, FixtureSite> = {}
  const directories: Record<string, string> = {}
  const directives: Record<string, SiteDirectives> = {}

  for (const entry of options.sites) {
    const directory = resolve(entry.includes(':') || entry.startsWith('/') ? entry : join(root, entry))
    const name = directory.split(sep).pop()!
    if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(`Fixture site ${entry} not found at ${directory}`)
    directories[name] = directory
    const siteJson = join(directory, 'site.json')
    directives[name] = existsSync(siteJson) ? JSON.parse(readFileSync(siteJson, 'utf8')) as SiteDirectives : {}
  }

  const fill = (text: string, site: string): string => text.replace(/\{\{\s*(origin|alias)(?::([\w-]+))?\s*\}\}|\{\{\s*([\w-]+)\s*\}\}/g, (match, kind: string | undefined, target: string | undefined, custom: string | undefined) => {
    if (custom !== undefined) return options.placeholders?.[custom] ?? match
    const other = sites[target ?? site]
    if (!other) return match
    return kind === 'alias' ? other.aliasOrigin : other.origin
  })

  const handle = (name: string) => async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    const method = (request.method ?? 'GET').toUpperCase()
    const body = await readBody(request)
    const site = directives[name]!
    const entry: FixtureRequestRecord = {
      site: name, method, path: url.pathname + url.search,
      headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value ?? ''])),
      body, at: Date.now(),
    }
    if (record) log.push(entry)

    const delay = site.delayMs?.[url.pathname]
    if (delay) await new Promise(done => setTimeout(done, delay))
    const headers: Record<string, string | string[]> = { 'cache-control': 'no-store', ...site.headers?.[url.pathname] }
    const cookies = site.setCookie?.[url.pathname]
    if (cookies?.length) headers['set-cookie'] = cookies

    if (url.pathname === '/__mutations') {
      return send(response, 200, { ...headers, 'content-type': CONTENT_TYPES['.json']! }, JSON.stringify(log.filter(item => item.site === name && isMutation(item, directives[name]!))))
    }
    if (url.pathname === '/__redirect') {
      const to = url.searchParams.get('to') ?? '/'
      const status = Number(url.searchParams.get('status') ?? 302)
      return send(response, [301, 302, 303, 307, 308].includes(status) ? status : 302, { ...headers, location: fill(to, name) }, '')
    }
    if (url.pathname === '/__collect') {
      return send(response, 204, { ...headers, 'access-control-allow-origin': '*' }, '')
    }
    if (MUTATING.has(method) || site.mutationPaths?.includes(url.pathname)) {
      return send(response, 200, { ...headers, 'content-type': CONTENT_TYPES['.json']! }, JSON.stringify({ recorded: true, method, path: url.pathname }))
    }
    if (method !== 'GET' && method !== 'HEAD') return send(response, 405, headers, '')

    const status = site.status?.[url.pathname]
    const file = resolveFile(directories[name]!, url.pathname)
    if (!file) return send(response, status ?? 404, { ...headers, 'content-type': CONTENT_TYPES['.html']! }, '<!doctype html><title>Not found</title><h1>Not found</h1>')
    const ext = extname(file).toLowerCase()
    const raw = readFileSync(file)
    const content = TEXT_EXTENSIONS.has(ext) ? Buffer.from(fill(raw.toString('utf8'), name)) : raw
    return send(response, status ?? 200, { ...headers, 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' }, method === 'HEAD' ? '' : content)
  }

  for (const name of Object.keys(directories)) {
    const server = createServer((request, response) => { void handle(name)(request, response).catch(() => { if (!response.headersSent) send(response, 500, {}, '') }) })
    server.keepAliveTimeout = 1000
    await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => done()) })
    const port = (server.address() as AddressInfo).port
    servers.push(server)
    sites[name] = {
      name, port,
      origin: `http://127.0.0.1:${port}`,
      aliasOrigin: `http://localhost:${port}`,
      url: (path = '/') => `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`,
    }
  }

  const bySite = (site?: string) => (item: FixtureRequestRecord) => site === undefined || item.site === site
  return {
    sites,
    site(name) {
      const site = sites[name]
      if (!site) throw new Error(`Fixture site ${name} is not served here`)
      return site
    },
    mutations: site => log.filter(bySite(site)).filter(item => isMutation(item, directives[item.site]!)),
    requests: site => log.filter(bySite(site)),
    collected: site => log.filter(bySite(site)).filter(item => item.path.split('?')[0] === '/__collect'),
    reset: () => { log.length = 0 },
    close: async () => {
      await Promise.all(servers.map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) })))
    },
  }
}

function isMutation(item: FixtureRequestRecord, site: SiteDirectives): boolean {
  const path = item.path.split('?')[0]!
  if (path === '/__collect' || path === '/__mutations' || path === '/__redirect') return false
  return MUTATING.has(item.method) || (site.mutationPaths?.includes(path) ?? false)
}

function resolveFile(directory: string, pathname: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  const target = resolve(directory, `.${decoded}`)
  if (target !== directory && !target.startsWith(directory + sep)) return null
  for (const candidate of [target, join(target, 'index.html'), `${target}.html`]) {
    if (candidate.endsWith('site.json')) continue
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise(done => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= MAX_BODY) chunks.push(chunk) })
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => done(''))
  })
}

function send(response: ServerResponse, status: number, headers: Record<string, string | string[]>, body: string | Buffer): void {
  response.writeHead(status, headers)
  response.end(body)
}
