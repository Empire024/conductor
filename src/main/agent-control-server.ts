import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentControlScope } from '../shared/agent-control'
import type { AgentSpec } from '../shared/models'
import type { AgentControl } from './agent-control'

/** Loopback-only internal protocol, independent of third-party MCP configuration. */
export class AgentControlServer {
  private server?: Server
  private endpoint = ''
  private credentials = new Map<string, { token: string; scope: AgentControlScope }>()
  private busy = new Set<string>()
  constructor(private readonly control: Pick<AgentControl, 'authorize' | 'call'>, private readonly disabled = process.env.CONDUCTOR_LIVE_TESTS === '1', private readonly machineNote?: (spec: AgentSpec) => string) {}

  async start(): Promise<void> {
    if (this.disabled || this.server) return
    const server = createServer((request, response) => { void this.handle(request, response) })
    server.requestTimeout = 120000
    server.headersTimeout = 10000
    server.maxHeadersCount = 20
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    // After listen there is no promise left to reject into, and an 'error' event with no listener
    // is an uncaught exception that would take the whole app down.
    server.on('error', error => console.warn('Agent control server error', error))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Control server failed to bind')
    this.endpoint = `http://127.0.0.1:${address.port}/control`
  }

  briefing(spec: AgentSpec): string {
    if (!this.endpoint || this.disabled || !['codex', 'claude'].includes(spec.provider)) return ''
    let credential = this.credentials.get(spec.id)
    if (!credential || credential.scope.projectId !== spec.projectId || credential.scope.sessionId !== spec.sessionId) {
      credential = { token: randomBytes(32).toString('hex'), scope: { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id } }
      this.credentials.set(spec.id, credential)
    }
    return `Conductor app control: a first-party local JSON protocol is available for this project/workspace. POST ${this.endpoint} with Authorization: Bearer ${credential.token}, Content-Type: application/json, body {"method":"tools.list","args":{}} to discover methods. Use the native shell's HTTP client (PowerShell Invoke-RestMethod or curl.exe); do not expose the authorization value or copy it to another tab. app.state gives stable tab/file URIs, models.list gives actual choices, router.start({prompt}) opens a visible router; router.dispatch({tasks:[{title,prompt,provider,model}]}) opens visible coworkers. Use these visible native tabs when delegating to another provider; do not launch nested codex or claude CLI processes. Native turns and approvals remain visible in their tabs. files.write compares expectedContent and streams disk changes to the UI; tasks.update preserves checklist markers. Your control scope is your registered project and workspace; you cannot drive yourself or your ancestors. projects.list names the other projects the owner has open in this window: you may read one with files.list/files.read({projectId}) and hand work to it with tabs.open({projectId}) or router.dispatch, then steer that tab; you cannot write into another project's files directly. Destructive actions ask the owner; never blindly retry a mutation after a transport timeout. Use these tools only for the user's requested work.${this.machineNote?.(spec) ? ' ' + this.machineNote(spec) : ''}`
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'POST' || request.url !== '/control' || request.headers.origin || request.headers.host !== new URL(this.endpoint).host || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { reply(403, { error: 'Only local JSON control requests are accepted' }); request.resume(); return }
    if (Number(request.headers['content-length']) > 3 * 1024 * 1024) { reply(413, { error: 'Control request exceeds 3 MiB' }); request.resume(); return }
    const authorization = request.headers.authorization
    const credential = [...this.credentials.values()].find(credential => authorization === 'Bearer ' + credential.token)
    if (!credential) { reply(401, { error: 'Unauthorized control session' }); request.resume(); return }
    const id = credential.scope.agentSessionId
    if (this.busy.has(id)) { reply(409, { error: 'This session already has a control request in progress' }); request.resume(); return }
    this.busy.add(id)
    try {
      this.control.authorize(credential.scope)
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > 3 * 1024 * 1024) { reply(413, { error: 'Control request exceeds 3 MiB' }); request.destroy(); return }
        chunks.push(Buffer.from(chunk))
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: unknown; args?: unknown }
      if (!input || typeof input.method !== 'string' || input.method.length > 100) throw new Error('Provide a method and args object')
      const result = await this.control.call(credential.scope, input.method, input.args ?? {})
      reply(200, { result })
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Control request failed' }) }
    finally { this.busy.delete(id) }
  }

  close(): void {
    this.endpoint = ''; this.credentials.clear(); this.busy.clear()
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined
  }
}
