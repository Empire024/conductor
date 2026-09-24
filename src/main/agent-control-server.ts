import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentControlScope } from '../shared/agent-control'
import type { AgentSpec } from '../shared/models'
import type { AgentControl } from './agent-control'
import { controlMethodClass } from './control-method-classes'

/** Where the owner's own credential is written, and what a process that reads it may claim. */
export interface OwnerCredentialOptions { path: string; appVersion: string; packaged: boolean }

/** What `control-owner.json` holds. A process on this machine that can read the file has the
 *  owner's authority over this Conductor: it is written under the user profile with owner-only
 *  permissions, regenerated on every launch, and removed when the control server closes, so a
 *  supervisor outside the app (docs/overseer.md) finds a fresh endpoint after every restart. */
export interface OwnerCredentialFile { version: 1; endpoint: string; token: string; pid: number; startedAt: string; appVersion: string; packaged: boolean }

const OWNER_KEY = '\0owner'
const MAX_IN_FLIGHT_PER_SESSION = 8

/** Loopback-only internal protocol, independent of third-party MCP configuration. */
export class AgentControlServer {
  private server?: Server
  private endpoint = ''
  private credentials = new Map<string, { token: string; scope: AgentControlScope }>()
  private inFlight = new Map<string, number>()
  private mutationTails = new Map<string, Promise<void>>()
  private ownerToken?: string
  constructor(private readonly control: Pick<AgentControl, 'authorize' | 'call' | 'ownerScope'>, private readonly disabled = process.env.CONDUCTOR_LIVE_TESTS === '1', private readonly machineNote?: (spec: AgentSpec) => string, private readonly owner?: OwnerCredentialOptions) {}

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
    this.writeOwnerCredential()
  }

  /** The file a process outside the app reads to drive this Conductor as the owner; absent when
   *  no owner credential was configured or the server is off. */
  get ownerCredentialPath(): string | null { return this.owner && this.ownerToken ? this.owner.path : null }

  private writeOwnerCredential(): void {
    if (!this.owner) return
    this.ownerToken = randomBytes(32).toString('hex')
    const file: OwnerCredentialFile = { version: 1, endpoint: this.endpoint, token: this.ownerToken, pid: process.pid, startedAt: new Date().toISOString(), appVersion: this.owner.appVersion, packaged: this.owner.packaged }
    try {
      mkdirSync(dirname(this.owner.path), { recursive: true })
      writeFileSync(this.owner.path, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      // The app still runs and every conversation keeps its own credential; only an outside
      // supervisor is left without one, and the log says why.
      this.ownerToken = undefined
      console.warn('Owner control credential could not be written', error)
    }
  }

  briefing(spec: AgentSpec): string {
    if (!this.endpoint || this.disabled || !['codex', 'claude', 'grok'].includes(spec.provider)) return ''
    let credential = this.credentials.get(spec.id)
    if (!credential || credential.scope.projectId !== spec.projectId || credential.scope.sessionId !== spec.sessionId) {
      credential = { token: randomBytes(32).toString('hex'), scope: { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id } }
      this.credentials.set(spec.id, credential)
    }
    return `Conductor app control: a first-party local JSON protocol is available for this project/workspace. POST ${this.endpoint} with Authorization: Bearer ${credential.token}, Content-Type: application/json, body {"method":"tools.list","args":{}} to discover methods. Use the native shell's HTTP client (PowerShell Invoke-RestMethod or curl.exe); do not expose the authorization value or copy it to another tab. app.state gives stable tab/file URIs, models.list gives actual choices, router.start({prompt}) opens a visible router; router.dispatch({tasks:[{title,prompt,provider,model}]}) opens visible coworkers. Use these visible native tabs when delegating to another provider; do not launch nested codex or claude CLI processes. Native turns and approvals remain visible in their tabs. git.ship({message,paths?}) delivers finished work on the host with the owner's Git credentials (tests, build, commit, push, release check), so never escalate the sandbox for git; files.write compares expectedContent and streams disk changes to the UI; tasks.update preserves checklist markers. Your control scope is your registered project and workspace; you cannot drive yourself or your ancestors. projects.list names the other projects the owner has open in this window: you may read one with files.list/files.read({projectId}) and hand work to it with tabs.open({projectId}) or router.dispatch, then steer that tab; you cannot write into another project's files directly. Destructive actions ask the owner; never blindly retry a mutation after a transport timeout. Use these tools only for the user's requested work.${this.machineNote?.(spec) ? ' ' + this.machineNote(spec) : ''}`
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
    const owner = Boolean(this.ownerToken) && authorization === 'Bearer ' + this.ownerToken
    if (!credential && !owner) { reply(401, { error: 'Unauthorized control session' }); request.resume(); return }
    // Reads and waits may overlap a caller's mutation. Mutations keep their per-session order,
    // while the bounded request count prevents one credential from monopolising the server.
    const key = owner ? OWNER_KEY : credential!.scope.agentSessionId
    const inFlight = this.inFlight.get(key) ?? 0
    if (inFlight >= MAX_IN_FLIGHT_PER_SESSION) { reply(429, { error: `This session already has ${MAX_IN_FLIGHT_PER_SESSION} control requests in progress` }); request.resume(); return }
    this.inFlight.set(key, inFlight + 1)
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > 3 * 1024 * 1024) { reply(413, { error: 'Control request exceeds 3 MiB' }); request.destroy(); return }
        chunks.push(Buffer.from(chunk))
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: unknown; args?: unknown; scope?: unknown }
      if (!input || typeof input.method !== 'string' || input.method.length > 100) throw new Error('Provide a method and args object')
      // The owner names the project and workspace per call; a conversation's scope is fixed
      // when its credential is issued and nothing in the body can move it.
      const scope = owner ? this.control.ownerScope(input.scope) : credential!.scope
      const call = async (): Promise<unknown> => {
        this.control.authorize(scope)
        return this.control.call(scope, input.method as string, input.args ?? {})
      }
      const result = controlMethodClass(input.method) === 'read'
        ? await call()
        : await this.withMutationLock(key, call)
      if (input.method === 'tools.list' && result && typeof result === 'object' && !Array.isArray(result)) {
        const unclassified = Object.keys(result).filter(method => !controlMethodClass(method))
        if (unclassified.length) throw new Error(`Unclassified control methods: ${unclassified.join(', ')}`)
      }
      reply(200, { result })
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Control request failed' }) }
    finally {
      const remaining = (this.inFlight.get(key) ?? 1) - 1
      if (remaining > 0) this.inFlight.set(key, remaining)
      else this.inFlight.delete(key)
    }
  }

  private async withMutationLock<T>(key: string, call: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    this.mutationTails.set(key, tail)
    await previous
    try { return await call() }
    finally {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }
  }

  close(): void {
    if (this.owner && this.ownerToken) { try { rmSync(this.owner.path, { force: true }) } catch { /* the token dies with the process either way */ } }
    this.ownerToken = undefined
    this.endpoint = ''; this.credentials.clear(); this.inFlight.clear(); this.mutationTails.clear()
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined
  }
}
