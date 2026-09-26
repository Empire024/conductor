import { createServer, request as upstreamRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface ControlHoldOptions {
  /** How long a held request waits for the next app to take the port back (default 5 min). */
  waitMs?: number
  /** How long the host keeps trying to bind a port the leaving app still holds (default 60 s). */
  bindMs?: number
  maxBody?: number
  maxHeld?: number
  log?(message: string): void
}

/** Hop headers the host does not pass on; everything else, Authorization included, goes to the
 *  app unchanged, so the app's own control server still decides every call. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length'])
class Unreachable extends Error {}

/**
 * The app-control port while no app is there (FX33, docs/runtime-host.md). A conversation the
 * runtime host keeps running through a restart holds the app's control endpoint, which keeps its
 * port across launches (AgentControlServer's stable endpoint). Between the old app letting go of
 * the port and the new one taking it, the host listens on it instead and holds each request
 * unanswered; when the new app asks for the port back (release) the host stops listening and
 * hands every held request to it once, exactly as it was sent. A request that was never
 * delivered is never delivered twice, so the caller sees one answer, just later.
 */
export class ControlHold {
  private server?: Server
  private port = 0
  private binding?: NodeJS.Timeout
  private released = false
  private held = new Set<() => void>()
  private readonly waitMs: number
  private readonly bindMs: number
  private readonly maxBody: number
  private readonly maxHeld: number
  constructor(private options: ControlHoldOptions = {}) {
    this.waitMs = options.waitMs ?? 5 * 60_000
    this.bindMs = options.bindMs ?? 60_000
    this.maxBody = options.maxBody ?? 3 * 1024 * 1024
    this.maxHeld = options.maxHeld ?? 64
  }

  /** The port being held, or being waited for; 0 when none. */
  get holding(): number { return this.server || this.binding ? this.port : 0 }
  get heldRequests(): number { return this.held.size }

  /** Takes `port` as soon as the leaving app lets go of it. */
  hold(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid control port')
    if (this.holding === port) return
    this.stopListening()
    this.port = port
    this.released = false
    const deadline = Date.now() + this.bindMs
    const attempt = (): void => {
      this.binding = undefined
      const server = createServer((request, response) => { void this.handle(request, response) })
      server.headersTimeout = 10_000
      server.maxHeadersCount = 50
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (this.port !== port || this.released) return
        if (error.code === 'EADDRINUSE' && Date.now() < deadline) { this.binding = setTimeout(attempt, 100); this.binding.unref?.(); return }
        this.options.log?.(`control port ${port} could not be held: ${error.code ?? error.message}`)
      })
      server.listen(port, '127.0.0.1', () => {
        if (this.port !== port || this.released) { server.close(); return }
        server.on('error', error => this.options.log?.(`control hold error: ${error.message}`))
        this.server = server
        this.options.log?.(`holding control port ${port} until the next app takes it`)
      })
    }
    attempt()
  }

  /** The new app wants the port: the host stops listening and hands it the requests it held. */
  release(port: number): { released: boolean; held: number } {
    if (!port || port !== this.port) return { released: false, held: 0 }
    const listening = Boolean(this.server), held = this.held.size
    this.released = true
    this.stopListening()
    for (const wake of [...this.held]) wake()
    if (listening) this.options.log?.(`released control port ${port}; handing ${held} held request(s) to the app`)
    return { released: listening, held }
  }

  close(): void {
    this.stopListening()
    this.port = 0
    this.released = true
    for (const wake of [...this.held]) wake()
  }

  private stopListening(): void {
    if (this.binding) clearTimeout(this.binding)
    this.binding = undefined
    this.server?.close()
    this.server = undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const port = this.port
    // The same gate as the app's own server (agent-control-server.ts): only a local JSON call.
    if (request.method !== 'POST' || request.url !== '/control' || request.headers.origin || request.headers.host !== `127.0.0.1:${port}` || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { request.resume(); return this.reply(response, 403, { error: 'Only local JSON control requests are accepted' }) }
    if (this.held.size >= this.maxHeld) { request.resume(); return this.reply(response, 503, { error: 'Conductor is restarting and already holds too many control requests; this one was not delivered, so it is safe to send again.' }) }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > this.maxBody) { request.destroy(); return this.reply(response, 413, { error: 'Control request exceeds 3 MiB' }) }
      chunks.push(chunk as Buffer)
    }
    const body = Buffer.concat(chunks)
    const started = Date.now(), deadline = started + this.waitMs
    let gone = false, wake = (): void => {}
    response.on('close', () => { gone = true; wake() })
    try {
      for (;;) {
        if (gone) return
        if (this.released && this.port === port) {
          try { return await this.forward(port, request, body, response) } catch (error) {
            if (!(error instanceof Unreachable)) throw error
            // Released, but the new app is not listening yet: try again in a moment.
          }
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0 || (this.released && this.port !== port)) return this.reply(response, 503, { error: `Conductor is restarting and did not take this control request back within ${Math.round((Date.now() - started) / 1000)} s. It was never delivered, so it is safe to send again.` })
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, Math.min(remaining, this.released ? 250 : remaining))
          const held = this.held
          function done(): void { clearTimeout(timer); held.delete(done); resolve() }
          wake = done
          held.add(done)
        })
      }
    } catch (error) {
      this.options.log?.(`held control request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) this.reply(response, 502, { error: 'Conductor restarted while this control request waited, and passing it on failed.' })
      else response.destroy()
    }
  }

  private forward(port: number, request: IncomingMessage, body: Buffer, response: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !HOP.has(name)) headers[name] = value
    headers['content-length'] = String(body.length)
    return new Promise((resolve, reject) => {
      let answered = false
      const closed = (): void => { outgoing.destroy(); resolve() }
      const outgoing = upstreamRequest({ hostname: '127.0.0.1', port, path: '/control', method: 'POST', headers }, incoming => {
        answered = true
        const back: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !HOP.has(name)) back[name] = value
        // Each held call on its own connection: a kept-alive one could be closed under the next call.
        back.connection = 'close'
        if (!response.destroyed) response.writeHead(incoming.statusCode ?? 502, back)
        incoming.pipe(response)
        incoming.on('end', () => { response.off('close', closed); resolve() })
        incoming.on('error', () => { response.destroy(); resolve() })
      })
      outgoing.on('error', error => {
        response.off('close', closed)
        if (answered) { response.destroy(); resolve(); return }
        // Refused: no app took the connection, so nothing was delivered and it may be sent again.
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ECONNREFUSED') reject(new Unreachable(error.message))
        else reject(error)
      })
      response.on('close', closed)
      outgoing.end(body)
    })
  }

  private reply(response: ServerResponse, status: number, body: unknown): void {
    if (response.headersSent || response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' })
    response.end(JSON.stringify(body))
  }
}
