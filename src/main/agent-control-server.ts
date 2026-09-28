import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentControlScope } from '../shared/agent-control'
import type { AgentSpec } from '../shared/models'
import type { AgentControl } from './agent-control'
import { controlMethodClass, controlMethodFamily } from './control-method-classes'
import { registerSecretCheck } from './structured-store'

/** Where the owner's own credential is written, and what a process that reads it may claim. */
export interface OwnerCredentialOptions { path: string; appVersion: string; packaged: boolean }

/** What `control-owner.json` holds. A process on this machine that can read the file has the
 *  owner's authority over this Conductor: it is written under the user profile with owner-only
 *  permissions on every launch and removed when the control server closes, so a supervisor
 *  outside the app (docs/overseer.md) sees whether an app is there. With a stable endpoint
 *  (below) it names the same endpoint and token after a restart. */
export interface OwnerCredentialFile { version: 1; endpoint: string; token: string; pid: number; startedAt: string; appVersion: string; packaged: boolean }

/** Keeps the control endpoint the same across restarts (FX33): one port and one set of
 *  credentials per profile, so a conversation the runtime host kept running through a restart,
 *  and every script it wrote, still reach app control with what it was given. */
export interface StableEndpointOptions {
  /** `control-endpoint.json` beside control-owner.json; owner-only, like it. */
  path: string
  /** Asks whoever holds the port for this profile (the runtime host keeps it answering while no
   *  app is there, docs/runtime-host.md) to let go of it; true when it did. */
  reclaim?(port: number): Promise<boolean>
  /** How long a taken port is retried before falling back to another (default 5 s). */
  bindWaitMs?: number
  log?(message: string): void
}

/** What `control-endpoint.json` holds. Rotated only when the owner asks (rotate()) or when the
 *  file is gone; a credential's scope is still checked on every call (AgentControl.authorize). */
export interface ControlEndpointFile {
  version: 1
  port: number
  ownerToken: string
  credentials: Record<string, { token: string; projectId: string; sessionId: string; issuedAt: string }>
}

const OWNER_KEY = '\0owner'
const MAX_IN_FLIGHT_PER_SESSION = 8
const BUSY = `This session already has ${MAX_IN_FLIGHT_PER_SESSION} control requests in progress; wait for one of them to answer. Do not resend a mutation that timed out: check agents.list or git.ship.status first`
/** A credential the server does not know (G22). */
export const UNAUTHORIZED_CONTROL = 'This app-control credential is not (or no longer) valid, for example because the conversation moved workspace or Conductor restarted; nothing was done. Use the conductor MCP tools if you have them; otherwise say so in your final message and the owner restarts this conversation.'
const NO_METHOD = 'Provide a method and args object, e.g. {"method":"tools.list","args":{"brief":true}}'
/** Conversations whose credential is remembered across launches; the oldest go first. */
const MAX_KEPT_CREDENTIALS = 2000

/** Loopback-only internal protocol, independent of third-party MCP configuration. */
export class AgentControlServer {
  private server?: Server
  private endpoint = ''
  private credentials = new Map<string, { token: string; scope: AgentControlScope }>()
  private inFlight = new Map<string, number>()
  private mutationTails = new Map<string, Promise<void>>()
  private ownerToken?: string
  /** What control-endpoint.json holds for this launch; absent without a stable endpoint. */
  private kept?: ControlEndpointFile
  private changed = true
  /** The journal masks any of this server's tokens wherever one lands in a stored string (H17). */
  private unregisterSecretCheck?: () => void
  constructor(private readonly control: Pick<AgentControl, 'authorize' | 'call' | 'ownerScope'> & Partial<Pick<AgentControl, 'recordActivity' | 'prepareActivity'>>, private readonly disabled = process.env.CONDUCTOR_LIVE_TESTS === '1', private readonly machineNote?: (spec: AgentSpec) => string, private readonly owner?: OwnerCredentialOptions, private readonly stable?: StableEndpointOptions) {}

  async start(): Promise<void> {
    if (this.disabled || this.server) return
    this.unregisterSecretCheck ??= registerSecretCheck(candidate => candidate === this.ownerToken || candidate === this.kept?.ownerToken || [...this.credentials.values()].some(entry => entry.token === candidate))
    const kept = this.stable ? this.readKept() : undefined
    const { server, port } = await this.bind(kept?.port)
    this.server = server
    // After listen there is no promise left to reject into, and an 'error' event with no listener
    // is an uncaught exception that would take the whole app down.
    server.on('error', error => console.warn('Agent control server error', error))
    this.endpoint = `http://127.0.0.1:${port}/control`
    if (this.stable) {
      this.changed = !kept || kept.port !== port
      this.kept = { version: 1, port, ownerToken: kept?.ownerToken ?? randomBytes(32).toString('hex'), credentials: kept?.credentials ?? {} }
      for (const [id, entry] of Object.entries(this.kept.credentials)) this.credentials.set(id, { token: entry.token, scope: { projectId: entry.projectId, sessionId: entry.sessionId, agentSessionId: id } })
      this.saveKept()
    }
    this.writeOwnerCredential()
  }

  /** The port app control answers on. */
  get port(): number { return this.endpoint ? Number(new URL(this.endpoint).port) : 0 }

  /** Whether a conversation briefed by an earlier launch holds another endpoint or credential than
   *  this one answers to: always without a stable endpoint, else only when control-endpoint.json
   *  was missing or its port was taken by another process. */
  get endpointChanged(): boolean { return this.changed }

  /** A new owner token and new conversation credentials, on the owner's explicit word. Every
   *  conversation is briefed afresh at its next turn; one in the middle of a turn loses access. */
  rotate(): void {
    if (!this.kept) return
    this.kept = { ...this.kept, ownerToken: randomBytes(32).toString('hex'), credentials: {} }
    this.credentials.clear()
    this.saveKept()
    this.writeOwnerCredential()
  }

  /** Listens on the port this profile always uses. A port the runtime host holds for the gap of a
   *  restart is asked back; one another process holds is retried briefly, then given up loudly. */
  private async bind(preferred?: number): Promise<{ server: Server; port: number }> {
    const listen = (port: number): Promise<{ server: Server; port: number }> => new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response) })
      // No header or request deadline: Node measures them from when a connection was accepted and
      // checks them on a timer, which after a main-thread stall runs before the request is read,
      // so a call that arrived in time was answered 408 or reset (FX33). A loopback server behind
      // bearer tokens only has local callers; the connection cap bounds what a stuck one can hold.
      server.requestTimeout = 0
      server.headersTimeout = 0
      server.maxConnections = 256
      server.maxHeadersCount = 20
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') { server.close(); reject(new Error('Control server failed to bind')); return }
        resolve({ server, port: address.port })
      })
    })
    if (!preferred) return listen(0)
    const deadline = Date.now() + (this.stable?.bindWaitMs ?? 5000)
    let reclaimed = false, reason = ''
    for (;;) {
      try { return await listen(preferred) } catch (error) {
        reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))
        if (reason !== 'EADDRINUSE' || Date.now() >= deadline) break
        if (!reclaimed && this.stable?.reclaim) {
          reclaimed = true
          try { if (await this.stable.reclaim(preferred)) continue } catch { /* nobody we know holds it */ }
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    const fallback = await listen(0)
    const message = `App control could not keep port ${preferred} (${reason}): another process holds it. It answers on port ${fallback.port} from now on; conversations kept running through this restart are told the new endpoint, and every other one gets it with its next turn.`
    console.error(`[app control] ${message}`)
    this.stable?.log?.(message)
    return fallback
  }

  private readKept(): ControlEndpointFile | undefined {
    try {
      const file = JSON.parse(readFileSync(this.stable!.path, 'utf8')) as Partial<ControlEndpointFile>
      if (file.version !== 1 || !Number.isInteger(file.port) || file.port! <= 0 || file.port! > 65535 || typeof file.ownerToken !== 'string' || !/^[a-f0-9]{64}$/.test(file.ownerToken)) return undefined
      const credentials: ControlEndpointFile['credentials'] = {}
      for (const [id, entry] of Object.entries(file.credentials ?? {})) {
        if (entry && typeof entry.token === 'string' && /^[a-f0-9]{64}$/.test(entry.token) && typeof entry.projectId === 'string' && typeof entry.sessionId === 'string') credentials[id] = { token: entry.token, projectId: entry.projectId, sessionId: entry.sessionId, issuedAt: String(entry.issuedAt ?? '') }
      }
      return { version: 1, port: file.port!, ownerToken: file.ownerToken, credentials }
    } catch { return undefined }
  }

  private saveKept(): void {
    if (!this.kept || !this.stable) return
    const entries = Object.entries(this.kept.credentials)
    if (entries.length > MAX_KEPT_CREDENTIALS) {
      entries.sort((a, b) => a[1].issuedAt.localeCompare(b[1].issuedAt))
      for (const [id] of entries.slice(0, entries.length - MAX_KEPT_CREDENTIALS)) { delete this.kept.credentials[id]; this.credentials.delete(id) }
    }
    const temporary = `${this.stable.path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.stable.path), { recursive: true })
      writeFileSync(temporary, JSON.stringify(this.kept) + '\n', { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.stable.path)
    } catch (error) {
      // App control still works for this launch; the next one mints new credentials.
      try { rmSync(temporary, { force: true }) } catch { /* nothing written */ }
      console.warn('App control endpoint could not be saved for the next launch', error)
    }
  }

  /** The file a process outside the app reads to drive this Conductor as the owner; absent when
   *  no owner credential was configured or the server is off. */
  get ownerCredentialPath(): string | null { return this.owner && this.ownerToken ? this.owner.path : null }

  private writeOwnerCredential(): void {
    if (!this.owner) return
    this.ownerToken = this.kept?.ownerToken ?? randomBytes(32).toString('hex')
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
      if (this.kept) {
        this.kept.credentials[spec.id] = { token: credential.token, projectId: spec.projectId, sessionId: spec.sessionId, issuedAt: new Date().toISOString() }
        this.saveKept()
      }
    }
    // Claude tabs get the conductor MCP server (permission-grants/control-mcp.ts): its `control`
    // tool is the same call without a shell, quoting or a token on a command line.
    const mcp = spec.provider === 'claude' || spec.provider === 'codex' ? 'Call it with the conductor MCP tool control({method,args}), e.g. control({method:"tools.list",args:{brief:true}}): same scope and rules, no shell and no token on a command line, and a refusal comes back as text that says what to do next. For scripts, or if that tool is missing: ' : ''
    return `Conductor app control: a first-party local JSON protocol is available for this project/workspace. ${mcp}POST ${this.endpoint} with Authorization: Bearer ${credential.token}, Content-Type: application/json, body {"method":"tools.list","args":{"brief":true}} to list methods; tools.list({prefix:"agents."}) gives full signatures for one family. From a shell use curl.exe -s; a refused call is HTTP 400 whose JSON body {"error":"..."} says what to do next, and Invoke-RestMethod hides it unless you catch it: try { Invoke-RestMethod ... } catch { $_.ErrorDetails.Message }. Do not expose the authorization value or copy it to another tab. app.state gives stable tab/file URIs, models.list gives actual choices, router.start({prompt}) opens a visible router; router.dispatch({tasks:[{title,prompt,provider,model}]}) opens visible coworkers. Use these visible native tabs when delegating to another provider; do not launch nested codex or claude CLI processes. Native turns and approvals remain visible in their tabs. git.ship({message,paths?}) runs tests, build and a local commit on the host (publish:true, only when asked, also pushes and builds the release); never escalate the sandbox for git; files.write compares expectedContent and streams disk changes to the UI; tasks.update preserves checklist markers. Your control scope is your registered project and workspace. You cannot control yourself or your ancestors; to reach your controller use report (agents.report) or send_message. projects.list names the other projects the owner has open in this window: you may read one with files.list/files.read({projectId}) and hand work to it with tabs.open({projectId}) or router.dispatch, then steer that tab; you cannot write into another project's files directly. Destructive actions ask the owner; never blindly retry a mutation after a transport timeout. Use these tools only for the user's requested work.${this.machineNote?.(spec) ? ' ' + this.machineNote(spec) : ''}`
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      if (response.destroyed || response.writableEnded) return
      // Connection: close once the call was read in full - a kept-alive socket is closed by a server
      // timer that, after a main-thread stall, runs before the next call already sent on it is read
      // (FX33). A refusal before the body was read keeps Node's default, which drains the upload.
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(request.complete ? { Connection: 'close' } : {}) })
      response.end(JSON.stringify(body))
    }
    if (request.method !== 'POST' || request.url !== '/control' || request.headers.origin || request.headers.host !== new URL(this.endpoint).host || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) { reply(403, { error: 'Only local JSON control requests are accepted' }); request.resume(); return }
    if (Number(request.headers['content-length']) > 3 * 1024 * 1024) { reply(413, { error: 'Control request exceeds 3 MiB' }); request.resume(); return }
    const authorization = request.headers.authorization
    const credential = [...this.credentials.values()].find(credential => authorization === 'Bearer ' + credential.token)
    const owner = Boolean(this.ownerToken) && authorization === 'Bearer ' + this.ownerToken
    if (!credential && !owner) { reply(401, { error: UNAUTHORIZED_CONTROL }); request.resume(); return }
    // Reads and waits may overlap a caller's mutation. Mutations keep their order per session and
    // method family (control-method-classes.ts), so a long git.ship never holds up tabs.open,
    // while the bounded request count prevents one credential from monopolising the server.
    const key = owner ? OWNER_KEY : credential!.scope.agentSessionId
    if (!this.enter(key)) { reply(429, { error: BUSY }); request.resume(); return }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > 3 * 1024 * 1024) { reply(413, { error: 'Control request exceeds 3 MiB' }); request.destroy(); return }
        chunks.push(Buffer.from(chunk))
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: unknown; args?: unknown; scope?: unknown }
      if (!input || typeof input.method !== 'string' || input.method.length > 100) throw new Error(NO_METHOD)
      // The owner names the project and workspace per call; a conversation's scope is fixed
      // when its credential is issued and nothing in the body can move it.
      const scope = owner ? this.control.ownerScope(input.scope) : credential!.scope
      reply(200, { result: await this.run(key, scope, input.method, input.args ?? {}) })
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Control request failed' }) }
    finally { this.leave(key) }
  }

  /** One call exactly as a conversation's credential makes it over HTTP: the same in-flight cap,
   *  scope check, per-family mutation order and timeline activity. The conductor MCP `control`
   *  tool calls this (permission-grants/control-mcp.ts), so moving a call off the shell changes
   *  nothing about what it may do; a refusal throws the text HTTP answers as `{error}`. */
  async invoke(scope: AgentControlScope, method: string, args: unknown = {}): Promise<unknown> {
    if (typeof method !== 'string' || !method || method.length > 100) throw new Error(NO_METHOD)
    const key = scope.owner ? OWNER_KEY : scope.agentSessionId
    if (!this.enter(key)) throw new Error(BUSY)
    try { return await this.run(key, scope, method, args) } finally { this.leave(key) }
  }

  private enter(key: string): boolean {
    const inFlight = this.inFlight.get(key) ?? 0
    if (inFlight >= MAX_IN_FLIGHT_PER_SESSION) return false
    this.inFlight.set(key, inFlight + 1)
    return true
  }

  private leave(key: string): void {
    const remaining = (this.inFlight.get(key) ?? 1) - 1
    if (remaining > 0) this.inFlight.set(key, remaining)
    else this.inFlight.delete(key)
  }

  private async run(key: string, scope: AgentControlScope, method: string, args: unknown): Promise<unknown> {
    // Every answered call is shown in the timelines it concerns (control-activity.ts), on the
    // Conductor side only: nothing is added to any prompt.
    const call = async (): Promise<unknown> => {
      this.control.authorize(scope, method)
      // Resolved before the call: a close leaves no tab to name afterwards.
      const prepared = this.control.prepareActivity?.(scope, method, args)
      try {
        const result = await this.control.call(scope, method, args)
        this.control.recordActivity?.(scope, method, args, { result, prepared })
        return result
      } catch (error) {
        this.control.recordActivity?.(scope, method, args, { error: error instanceof Error ? error.message : String(error), prepared })
        throw error
      }
    }
    const result = controlMethodClass(method) === 'read'
      ? await call()
      : await this.withMutationLock(`${key}\0${controlMethodFamily(method) ?? 'other'}`, call)
    if (method === 'tools.list' && result && typeof result === 'object' && !Array.isArray(result)) {
      const unclassified = Object.keys(result).filter(name => !controlMethodClass(name))
      if (unclassified.length) throw new Error(`Unclassified control methods: ${unclassified.join(', ')}`)
    }
    return result
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
    this.unregisterSecretCheck?.(); this.unregisterSecretCheck = undefined
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined
  }
}
