import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as upstreamRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { RelayRoute, RelayServer } from './protocol'

export interface McpRelayOptions {
  /** How long a request waits for an app to take over a route whose app went away. */
  waitMs?: number
  maxBody?: number
  maxRoutes?: number
  log?(message: string): void
}

interface Route { id: string; key: string; name: string; token: string; upstream?: URL; authorization?: string; owner?: object; touched: number; waiters: Set<() => void> }

/** Headers that belong to one hop, or that the relay sets itself. */
const HOP = new Set(['host', 'authorization', 'origin', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'])
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\w./-]*$/
const sameToken = (offered: string, expected: string): boolean => {
  const a = Buffer.from(offered), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
class UpstreamUnreachable extends Error {}

/**
 * The loopback MCP endpoint a hosted provider process is given instead of the app's own
 * (docs/runtime-host.md). The app's MCP servers listen on a port and take bearer tokens that
 * are new every launch, so a CLI that outlives the app would keep calling a dead address. This
 * relay keeps one address and one token per server for as long as the host runs: the app that
 * owns the conversation registers where its server is now, and a request that arrives while no
 * app is there waits for the next one instead of failing. It moves bytes; the app's server still
 * decides every call.
 */
export class McpRelay {
  private server?: Server
  private starting?: Promise<void>
  private authority = ''
  private routes = new Map<string, Route>()
  private readonly waitMs: number
  private readonly maxBody: number
  private readonly maxRoutes: number
  constructor(private options: McpRelayOptions = {}) {
    this.waitMs = options.waitMs ?? 10 * 60_000
    this.maxBody = options.maxBody ?? 8 * 1024 * 1024
    this.maxRoutes = options.maxRoutes ?? 512
  }

  get url(): string { return this.authority ? `http://${this.authority}/mcp` : '' }

  /** Points `key`'s servers at where the app that owns them serves them now. A server of `key`
   *  the app no longer lists is dropped, and requests waiting on it are refused. */
  async register(owner: object, key: string, servers: RelayServer[]): Promise<RelayRoute[]> {
    if (!/^[\w.:-]{1,160}$/.test(String(key))) throw new Error('Invalid relay key')
    if (!Array.isArray(servers) || servers.length > 16) throw new Error('Invalid relay server list')
    for (const server of servers) {
      if (!server || typeof server.name !== 'string' || !/^[\w.-]{1,80}$/.test(server.name)) throw new Error('Invalid relay server name')
      if (typeof server.upstream !== 'string' || !LOOPBACK.test(server.upstream)) throw new Error('A relayed MCP server must be a 127.0.0.1 HTTP endpoint')
      if (typeof server.authorization !== 'string' || server.authorization.length > 4096) throw new Error('Invalid relay authorization')
    }
    await this.start()
    const named = new Set(servers.map(server => server.name))
    for (const route of [...this.routes.values()]) if (route.key === key && !named.has(route.name)) this.drop(route)
    const routes = servers.map(server => {
      const id = `${key}\n${server.name}`
      let route = this.routes.get(id)
      if (!route) {
        route = { id, key, name: server.name, token: randomBytes(32).toString('hex'), touched: 0, waiters: new Set() }
        this.routes.set(id, route)
      }
      route.upstream = new URL(server.upstream)
      route.authorization = server.authorization
      route.owner = owner
      route.touched = Date.now()
      this.wake(route)
      return { name: route.name, url: this.url, token: route.token }
    })
    this.evict()
    return routes
  }

  /** The app that registered these routes is gone; their requests wait for the next one. */
  release(owner: object): void {
    for (const route of this.routes.values()) if (route.owner === owner) route.owner = undefined
  }

  async close(): Promise<void> {
    for (const route of [...this.routes.values()]) this.drop(route)
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections?.() })
  }

  private start(): Promise<void> {
    if (this.server) return Promise.resolve()
    return this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch(error => {
          this.options.log?.(`relay request failed: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent && !response.destroyed) this.reply(response, 502, { error: 'The Conductor MCP relay failed' })
          else response.destroy()
        })
      })
      server.headersTimeout = 10_000
      server.maxHeadersCount = 50
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', error => this.options.log?.(`relay server error: ${error.message}`))
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('The MCP relay failed to bind')); return }
        this.authority = `127.0.0.1:${address.port}`
        this.server = server
        this.options.log?.(`MCP relay listening on ${this.authority}`)
        resolve()
      })
    }).finally(() => { this.starting = undefined })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A web page (Origin) or a name rebound to 127.0.0.1 (Host) is never the CLI on this machine.
    if (request.headers.origin || request.headers.host !== this.authority) { request.resume(); return this.reply(response, 403, { error: 'Only local MCP requests are accepted' }) }
    if ((request.url ?? '').split('?')[0] !== '/mcp') { request.resume(); return this.reply(response, 404, { error: 'Unknown endpoint' }) }
    const offered = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const found = offered ? [...this.routes.values()].find(candidate => sameToken(offered, candidate.token)) : undefined
    if (!found) { request.resume(); return this.reply(response, 401, { error: 'Unknown MCP relay credential' }) }
    const route: Route = found
    if (Number(request.headers['content-length']) > this.maxBody) { request.resume(); return this.reply(response, 413, { error: 'Request too large' }) }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > this.maxBody) { request.destroy(); return this.reply(response, 413, { error: 'Request too large' }) }
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks)
    route.touched = Date.now()
    const deadline = Date.now() + this.waitMs
    let gone = false
    response.on('close', () => { gone = true; this.wake(route) })
    for (;;) {
      if (gone) return
      if (this.routes.get(route.id) !== route) return this.reply(response, 404, { error: `The ${route.name} MCP server is no longer given to this conversation` })
      if (route.owner && route.upstream) {
        try { return await this.forward(route, request, body, response) } catch (error) {
          if (!(error instanceof UpstreamUnreachable)) throw error
          // The app that registered this route is quitting or has just quit: wait for the next.
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return this.reply(response, 503, { error: 'Conductor is not running, so its MCP server cannot answer. The request waited for it to come back.' })
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.min(remaining, route.owner ? 1000 : remaining))
        function done(): void { clearTimeout(timer); route.waiters.delete(done); resolve() }
        route.waiters.add(done)
      })
    }
  }

  private forward(route: Route, request: IncomingMessage, body: Buffer, response: ServerResponse): Promise<void> {
    const upstream = route.upstream!
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !HOP.has(name)) headers[name] = value
    headers.host = upstream.host
    headers.authorization = route.authorization
    if (body.length || request.method === 'POST') headers['content-length'] = String(body.length)
    return new Promise((resolve, reject) => {
      let answered = false
      const closed = (): void => { outgoing.destroy(); finish() }
      const finish = (): void => { response.off('close', closed); resolve() }
      const outgoing = upstreamRequest({ hostname: upstream.hostname, port: upstream.port, path: upstream.pathname + upstream.search, method: request.method, headers }, incoming => {
        answered = true
        const back: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !HOP.has(name)) back[name] = value
        if (!response.destroyed) response.writeHead(incoming.statusCode ?? 502, back)
        incoming.pipe(response)
        incoming.on('end', finish)
        incoming.on('error', () => { response.destroy(); finish() })
      })
      outgoing.on('error', error => {
        if (answered) { response.destroy(); finish(); return }
        response.off('close', closed)
        reject(new UpstreamUnreachable(error.message))
      })
      // The CLI gave up (or the relay closed): nothing is waiting for the upstream's answer.
      response.on('close', closed)
      outgoing.end(body)
    })
  }

  private reply(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(body))
  }

  private wake(route: Route): void { for (const waiter of [...route.waiters]) waiter() }

  private drop(route: Route): void {
    this.routes.delete(route.id)
    this.wake(route)
  }

  /** Routes of conversations long gone: the oldest untouched ones nobody owns are forgotten. */
  private evict(): void {
    if (this.routes.size <= this.maxRoutes) return
    const idle = [...this.routes.values()].filter(route => !route.owner && !route.waiters.size).sort((a, b) => a.touched - b.touched)
    for (const route of idle.slice(0, this.routes.size - this.maxRoutes)) this.drop(route)
  }
}
