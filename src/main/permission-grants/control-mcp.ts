import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../shared/models'

/** Tools reach an agent as `mcp__conductor__<tool>`. */
export const CONDUCTOR_MCP_SERVER_NAME = 'conductor'
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const MAX_BODY = 256 * 1024
/** Codex stops waiting for an MCP tool after 60 s by default; git.ship.status({waitSeconds:100})
 *  and agents.finish({waitSeconds}) legitimately take longer, so it gets the server's own limit. */
export const CONDUCTOR_TOOL_TIMEOUT_SEC = 180

export interface ControlScope { projectId: string; sessionId: string; agentSessionId: string }
/** AgentControl.call with the conversation's own scope: the same authority rules as over HTTP.
 *  `generic` marks a call from the `control` tool, which index.ts runs through the HTTP endpoint's
 *  own pipeline (AgentControlServer.invoke: in-flight cap, per-family order, timeline activity). */
export type ControlCall = (scope: ControlScope, method: string, args: Record<string, unknown>, options?: { generic?: boolean }) => Promise<unknown>

/** claudeOnly: a permission request becomes a rule for Claude Code's classifier; Codex asks the owner
 *  through its own approval cards, so those tools are neither listed for nor callable by it. */
interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; method: string; args(input: Record<string, unknown>): Record<string, unknown>; generic?: true; claudeOnly?: true }
const pick = (input: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]))

/**
 * Tab-to-tab messages and permission requests as first-party tools. Before this, a controller
 * reached another tab by posting to app control from a shell command, with its bearer token on the
 * command line; the runtime saw an HTTP call from Bash and judged it by what the message talked
 * about. Here the call is a named Conductor tool that only delivers text (or files a request the
 * owner answers), runs as the calling conversation, and never exposes a credential to a shell.
 * Whether the claude CLI's classifier still reviews MCP calls is recorded in
 * docs/permissions-classifier.md.
 */
/** A message names one conversation, or another project whose wizard receives it (agent-control handIn). */
const addressee = (input: Record<string, unknown>): Record<string, unknown> =>
  input.agentSessionId === undefined && input.projectId !== undefined ? { projectId: input.projectId } : { agentSessionId: input.agentSessionId }

/** The `control` tool's method, checked as the HTTP endpoint checks it. */
const controlMethod = (input: Record<string, unknown>): string => {
  if (typeof input.method !== 'string' || !input.method || input.method.length > 100) throw new Error('control needs method, an app-control method name such as "tools.list" or "agents.status", and args, an object: control({method:"agents.status",args:{agentSessionId:"agent_..."}})')
  return input.method
}
/** Its args: an object, or the same object sent as a JSON string, which models often do. */
const controlArgs = (input: Record<string, unknown>): Record<string, unknown> => {
  let args = input.args
  if (typeof args === 'string') { try { args = args.trim() ? JSON.parse(args) : {} } catch { /* refused below */ } }
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error(`control args must be a JSON object of ${String(input.method)}'s arguments, e.g. {"agentSessionId":"agent_..."}; tools.list({prefix:"${String(input.method).split('.')[0]}."}) gives its signature`)
  return args as Record<string, unknown>
}

export const CONDUCTOR_MCP_TOOLS: Tool[] = [
  { name: 'control', method: '', generic: true, args: controlArgs,
    description: 'Call any Conductor app-control method (tools.list, agents.*, tabs.*, git.ship, ...) without a shell; same scope and rules as the HTTP protocol. Refusals come back as text that says what to do next. tools.list({brief:true}) lists every method with its arguments; tools.list({prefix:"agents."}) gives one family\'s full signatures.',
    inputSchema: { type: 'object', properties: { method: { type: 'string', maxLength: 100, description: 'App-control method, e.g. "agents.status"' }, args: { type: 'object', description: 'The method\'s arguments', additionalProperties: true } }, required: ['method'], additionalProperties: false } },
  { name: 'send_message', method: 'agents.steer', args: input => ({ ...addressee(input), prompt: input.text }),
    description: 'Send a text message to another Conductor tab you control or coordinate with, including your own controller (agents.steer): steered into its running turn, or starting one if it is idle. To your controller or an ancestor it is delivered as a report. Address another project instead with projectId (from projects.list) and no agentSessionId: the message goes to that project\'s active wizard, which replies to you, and the result names it. Only delivers text; changes no setting and runs nothing.',
    inputSchema: { type: 'object', properties: { agentSessionId: { type: 'string' }, projectId: { type: 'string' }, text: { type: 'string', maxLength: 20000 } }, required: ['text'], additionalProperties: false } },
  { name: 'submit_task', method: 'agents.submit', args: input => ({ ...addressee(input), prompt: input.text }),
    description: 'Start a new turn in a coworker tab you control with this prompt (agents.submit), with that tab\'s own settings. With projectId (another project, from projects.list) and no agentSessionId it goes to that project\'s active wizard as a message, or opens a tab there when it has none.',
    inputSchema: { type: 'object', properties: { agentSessionId: { type: 'string' }, projectId: { type: 'string' }, text: { type: 'string', maxLength: 20000 } }, required: ['text'], additionalProperties: false } },
  { name: 'report', method: 'agents.report', args: input => pick(input, ['text']),
    description: 'Report to the conversation that opened this tab (your controller), as agents.report does. It never refuses a long report: up to 2000 characters go inline and the rest is kept as an artifact the controller can read, so send it once rather than shortening and resending it.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 20000 } }, required: ['text'], additionalProperties: false } },
  { name: 'handoff', method: 'agents.handoff', args: input => pick(input, ['handoff', 'title', 'successor', 'provider', 'model', 'effort']),
    description: 'Hand your own remaining work to a fresh tab (agents.handoff): handoff holds the six sections of docs/token-thrift-policy.md; successor:true for a wizard or controller continuing itself; provider/model/effort from models.list continue on another model.',
    inputSchema: { type: 'object', properties: { handoff: { type: 'string' }, title: { type: 'string' }, successor: { type: 'boolean' }, provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' } }, required: ['handoff'], additionalProperties: false } },
  { name: 'request_permission', method: 'permissions.request', claudeOnly: true, args: input => pick(input, ['tool', 'command', 'path', 'url', 'reason', 'rollback']),
    description: 'Ask the owner for exactly one call the auto-mode classifier refused or would refuse (permissions.request). Give command (Bash; tool "PowerShell" for PowerShell), path (Write; tool "Edit" for Edit) or url (WebFetch), the reason, and a rollback if it changes something. The owner answers one card; you are then told "[Conductor] approved: <rule>; retry it now" and run exactly that call, or that it was denied.',
    inputSchema: { type: 'object', properties: { tool: { type: 'string', enum: ['Bash', 'PowerShell', 'Write', 'Edit', 'WebFetch'] }, command: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' }, reason: { type: 'string' }, rollback: { type: 'string' } }, required: ['reason'], additionalProperties: false } },
  { name: 'list_permissions', method: 'permissions.list', claudeOnly: true, args: () => ({}),
    description: 'Your open permission requests and live grants.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
]

type McpProvider = 'claude' | 'codex'
interface Credential { token: string; scope: ControlScope; provider: McpProvider; file?: string }
const offered = (provider: McpProvider): Tool[] => provider === 'claude' ? CONDUCTOR_MCP_TOOLS : CONDUCTOR_MCP_TOOLS.filter(tool => !tool.claudeOnly)
const sameToken = (offered: string, expected: string): boolean => {
  const a = Buffer.from(offered), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class ConductorMcpServer {
  private server?: Server
  private endpoint = ''
  private authority = ''
  private configDirectory = ''
  private credentials = new Map<string, Credential>()
  constructor(private readonly call: ControlCall, private readonly disabled = process.env.CONDUCTOR_LIVE_TESTS === '1') {}

  get url(): string { return this.endpoint }

  async start(): Promise<void> {
    if (this.disabled || this.server) return
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        console.warn('Conductor MCP request failed', error)
        try {
          if (response.headersSent || response.destroyed || response.writableEnded) response.destroy()
          else { response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); response.end('{"error":"Conductor MCP failed"}') }
        } catch { /* the socket is already gone */ }
      })
    })
    server.requestTimeout = 180_000
    server.headersTimeout = 10_000
    server.maxHeadersCount = 30
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    server.on('error', error => console.warn('Conductor MCP server error', error))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Conductor MCP server failed to bind')
    this.authority = `127.0.0.1:${address.port}`
    this.endpoint = `http://${this.authority}/mcp`
  }

  /** A config file path for one Claude or Codex conversation (each in its provider's own form), or
   *  '' when unavailable. Codex takes it as a thread config next to conductor-local and the browser
   *  (providers/codex.ts; its merge with the CLI's own servers was probed on codex-cli 0.155.1). */
  configure(spec: Pick<AgentSpec, 'id' | 'projectId' | 'sessionId' | 'provider'>): string {
    if (!this.endpoint || this.disabled || (spec.provider !== 'claude' && spec.provider !== 'codex')) return ''
    let credential = this.credentials.get(spec.id)
    if (!credential || credential.scope.projectId !== spec.projectId || credential.scope.sessionId !== spec.sessionId || credential.provider !== spec.provider) {
      this.discard(credential)
      credential = { token: randomBytes(32).toString('hex'), scope: { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id }, provider: spec.provider }
      this.credentials.set(spec.id, credential)
    }
    const authorization = `Bearer ${credential.token}`
    const configuration = JSON.stringify(spec.provider === 'claude'
      ? { mcpServers: { [CONDUCTOR_MCP_SERVER_NAME]: { type: 'http', url: this.endpoint, headers: { Authorization: authorization } } } }
      : { mcp_servers: { [CONDUCTOR_MCP_SERVER_NAME]: { url: this.endpoint, http_headers: { Authorization: authorization }, tool_timeout_sec: CONDUCTOR_TOOL_TIMEOUT_SEC } } })
    try {
      if (!this.configDirectory) this.configDirectory = mkdtempSync(join(tmpdir(), 'conductor-control-mcp-'))
      const file = join(this.configDirectory, `${spec.id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
      writeFileSync(file, configuration, { mode: 0o600 })
      credential.file = file
      return file
    } catch (error) { console.warn('Conductor MCP configuration file unavailable', error); return configuration }
  }

  private discard(credential?: Credential): void {
    if (credential?.file) { try { rmSync(credential.file, { force: true }) } catch { /* already gone */ } }
  }

  release(agentSessionId: string): void {
    this.discard(this.credentials.get(agentSessionId))
    this.credentials.delete(agentSessionId)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
      response.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (request.url !== '/mcp') { reply(404, { error: 'Unknown endpoint' }); request.resume(); return }
    if (request.method !== 'POST' && request.method !== 'DELETE') { reply(405, { error: 'Only JSON-RPC POST is accepted' }, { Allow: 'POST, DELETE' }); request.resume(); return }
    if (request.headers.origin || request.headers.host !== this.authority || (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))) { reply(403, { error: 'Only local JSON-RPC requests are accepted' }); request.resume(); return }
    if (Number(request.headers['content-length']) > MAX_BODY) { reply(413, { error: 'Request too large' }); request.resume(); return }
    const offered = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const credential = offered ? [...this.credentials.values()].find(candidate => sameToken(offered, candidate.token)) : undefined
    if (!credential) { reply(401, { error: 'Unauthorized session' }); request.resume(); return }
    if (request.method === 'DELETE') { reply(200, {}); request.resume(); return }
    let message: { id?: string | number | null; method?: string; params?: Record<string, unknown> }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > MAX_BODY) { reply(413, { error: 'Request too large' }); request.destroy(); return }
        chunks.push(Buffer.from(chunk))
      }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Malformed JSON-RPC request' } }); return }
    if (message === null || typeof message !== 'object' || message.id === undefined || message.id === null) { reply(202, undefined); return }
    reply(200, await this.dispatch(credential, message), { 'Mcp-Session-Id': credential.scope.agentSessionId })
  }

  async dispatch(credential: Credential, message: { id?: string | number | null; method?: string; params?: Record<string, unknown> }): Promise<unknown> {
    const envelope = { jsonrpc: '2.0', id: message.id ?? null }
    const params = message.params && typeof message.params === 'object' ? message.params : {}
    if (message.method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return { ...envelope, result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CONDUCTOR_MCP_SERVER_NAME, title: 'Conductor', version: '1' },
        instructions: 'Call any Conductor app-control method with control({method,args}) instead of posting to app control from a shell. Message other Conductor tabs with send_message, submit_task, report and handoff' + (credential.provider === 'claude' ? ', and ask the owner for one refused call with request_permission.' : '.')
      } }
    }
    if (message.method === 'ping') return { ...envelope, result: {} }
    if (message.method === 'tools/list') return { ...envelope, result: { tools: offered(credential.provider).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } }
    if (message.method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : ''
      const tool = CONDUCTOR_MCP_TOOLS.find(candidate => candidate.name === name)
      if (!tool) return { ...envelope, error: { code: -32602, message: `Unknown Conductor tool: ${name || '(none)'}` } }
      if (tool.claudeOnly && credential.provider !== 'claude') return { ...envelope, result: { isError: true, content: [{ type: 'text', text: `${name} is for Claude conversations, whose auto-mode classifier refuses calls; a ${credential.provider} command that needs the owner raises its own approval card in this tab, so run the call itself. Tools here: ${offered(credential.provider).map(candidate => candidate.name).join(', ')}.` }] } }
      const input = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {}
      try {
        const result = tool.generic
          ? await this.call(credential.scope, controlMethod(input), tool.args(input), { generic: true })
          : await this.call(credential.scope, tool.method, tool.args(input))
        if (this.credentials.get(credential.scope.agentSessionId) !== credential) throw new Error('Conductor access was revoked while the tool was running')
        // Any method's result as its JSON text alone: a tools.list is tens of KB, so it is not
        // sent a second time as structuredContent.
        if (tool.generic) return { ...envelope, result: { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] } }
        const structured = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { result }
        return { ...envelope, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } }
      } catch (error) { return { ...envelope, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Conductor tool failed' }] } } }
    }
    return { ...envelope, error: { code: -32601, message: `Method not found: ${message.method ?? '(none)'}` } }
  }

  close(): void {
    this.endpoint = ''; this.authority = ''
    for (const credential of this.credentials.values()) this.discard(credential)
    this.credentials.clear()
    if (this.configDirectory) { try { rmSync(this.configDirectory, { recursive: true, force: true }) } catch { /* already gone */ } }
    this.configDirectory = ''
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined
  }
}
