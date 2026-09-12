import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../shared/models'
import { BROWSER_MCP_SERVER_NAME, BROWSER_TOOLS, type BrowserMcpHost, type BrowserMcpScope, type BrowserToolResult } from '../shared/browser-mcp'

/** MCP revisions Claude Code 2.1.x negotiates with this bridge. An unknown revision is answered
 *  with the newest one we speak, which is what the specification asks an older server to do. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const MAX_BODY = 1024 * 1024
/** A backstop for the reply path. The guest truncates a page value before it crosses IPC
 *  (browser-views.ts); this catches anything that reaches the response another way, because
 *  JSON.stringify of an over-long string throws, and a throw here is an unhandled rejection. */
const MAX_RESULT_CHARS = 400_000
interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Browser tool failed'
/** Constant time so a token cannot be recovered by timing the rejection. */
const sameToken = (offered: string, expected: string): boolean => {
  const a = Buffer.from(offered), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** A loopback MCP endpoint that gives one agent session — and only that session — tools for the
 *  browser view in its own workspace.
 *
 *  It is a sibling of AgentControlServer rather than a method on it: the control protocol's
 *  bearer token unlocks project files, coworker dispatch and task edits, while an MCP server's
 *  credential is handed to the CLI at launch and read back by an MCP client we do not own. Those
 *  two secrets must never be the same value. */
export class BrowserMcpServer {
  private server?: Server
  private endpoint = ''
  /** The one Host header this endpoint answers to, resolved once so no request has to parse it. */
  private authority = ''
  /** Where per-session --mcp-config files live, created on first use and removed on close. */
  private configDirectory = ''
  private credentials = new Map<string, { token: string; scope: BrowserMcpScope; file?: string }>()
  constructor(private readonly host: BrowserMcpHost, private readonly disabled = process.env.CONDUCTOR_LIVE_TESTS === '1') {}

  async start(): Promise<void> {
    if (this.disabled || this.server) return
    // A rejection out of handle() would be unhandled, and an unhandled rejection in the main
    // process ends the app: every conversation, terminal and unsaved editor goes with it.
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        console.warn('Browser MCP request failed', error)
        try {
          if (response.headersSent || response.destroyed || response.writableEnded) response.destroy()
          else { response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); response.end('{"error":"Browser bridge failed"}') }
        } catch { /* the socket is already gone */ }
      })
    })
    server.requestTimeout = 120_000
    server.headersTimeout = 10_000
    server.maxHeadersCount = 30
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    // Past listen there is no promise left to reject into, and an 'error' event with no listener
    // is an uncaught exception that would take the whole app down.
    server.on('error', error => console.warn('Browser MCP server error', error))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Browser MCP server failed to bind')
    this.authority = `127.0.0.1:${address.port}`
    this.endpoint = `http://${this.authority}/mcp`
  }

  /** The `--mcp-config` argument for one session, or '' when the bridge is not running. The token
   *  is minted per agent session and re-minted whenever that session's project or workspace
   *  changes, so a credential can never address a workspace it was not issued for.
   *
   *  What comes back is a path, not the JSON: `--mcp-config` takes either, and a command line is
   *  world-readable to every process the owner runs. `Get-CimInstance Win32_Process` prints the
   *  bearer token of every live session in one line, and this bridge grants whoever holds a token
   *  that session's whole browser view — so the secret does not travel in argv. */
  configure(spec: Pick<AgentSpec, 'id' | 'projectId' | 'sessionId' | 'provider'>): string {
    if (!this.endpoint || this.disabled || !['claude', 'codex'].includes(spec.provider)) return ''
    let credential = this.credentials.get(spec.id)
    if (!credential || credential.scope.projectId !== spec.projectId || credential.scope.sessionId !== spec.sessionId) {
      this.discard(credential)
      credential = { token: randomBytes(32).toString('hex'), scope: { projectId: spec.projectId, sessionId: spec.sessionId, agentSessionId: spec.id } }
      this.credentials.set(spec.id, credential)
    }
    // Claude consumes this file through --mcp-config. Codex reads the snake_case shape into its
    // thread/start or thread/resume config; neither token is put on the process command line.
    const configuration = JSON.stringify(spec.provider === 'claude'
      ? { mcpServers: { [BROWSER_MCP_SERVER_NAME]: { type: 'http', url: this.endpoint, headers: { Authorization: `Bearer ${credential.token}` } } } }
      : { mcp_servers: { [BROWSER_MCP_SERVER_NAME]: { url: this.endpoint, http_headers: { Authorization: `Bearer ${credential.token}` } } } })
    // Automation-profile evidence hook: a smoke run has to hold the very credential the CLI was
    // handed to prove an agent-side call drives the real view. Never reachable in a packaged app.
    const capture = process.env.CONDUCTOR_TEST_BROWSER_MCP_CAPTURE
    if (capture && process.env.CONDUCTOR_TEST_USER_DATA) { try { writeFileSync(capture, configuration) } catch { /* evidence only */ } }
    // The inline form is the fallback: a session that cannot get a file is still better off with
    // the browser tools than without them, and the exposure is what it was before.
    return this.credentialFile(spec.id, credential, configuration) ?? configuration
  }

  /** The per-session config file, in the owner's own temp directory. */
  private credentialFile(id: string, credential: { file?: string }, configuration: string): string | undefined {
    try {
      if (!this.configDirectory) this.configDirectory = mkdtempSync(join(tmpdir(), 'conductor-browser-mcp-'))
      const file = join(this.configDirectory, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
      writeFileSync(file, configuration, { mode: 0o600 })
      credential.file = file
      return file
    } catch (error) { console.warn('Browser MCP configuration file unavailable', error); return undefined }
  }

  private discard(credential?: { file?: string }): void {
    if (credential?.file) { try { rmSync(credential.file, { force: true }) } catch { /* the file is already gone */ } }
  }

  release(agentSessionId: string): void {
    this.discard(this.credentials.get(agentSessionId))
    this.credentials.delete(agentSessionId)
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      if (response.destroyed || response.writableEnded) return
      // Serialized before the head goes out: a body that cannot be encoded then fails while the
      // response is still answerable, and the caller gets a status instead of a dropped socket.
      const payload = body === undefined ? undefined : JSON.stringify(body)
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
      response.end(payload)
    }
    if (request.url !== '/mcp') { reply(404, { error: 'Unknown endpoint' }); request.resume(); return }
    // The CLI opens a GET listening stream when a server offers one. This bridge only answers
    // request/response, so it declines rather than leaving that socket open forever. DELETE is the
    // MCP session-teardown verb and goes through every check below with the rest of them: an
    // unauthenticated caller has no business getting a 200 out of this endpoint for anything.
    if (request.method !== 'POST' && request.method !== 'DELETE') { reply(405, { error: 'Only JSON-RPC POST is accepted' }, { Allow: 'POST, DELETE' }); request.resume(); return }
    // An Origin header means a web page made the call, and a Host that is not ours means a name
    // was rebound to 127.0.0.1 from outside. Neither is ever the CLI running on this machine.
    // A DELETE carries no body, so the JSON content type is only required of a POST.
    if (request.headers.origin || request.headers.host !== this.authority || (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))) { reply(403, { error: 'Only local JSON-RPC requests are accepted' }); request.resume(); return }
    if (Number(request.headers['content-length']) > MAX_BODY) { reply(413, { error: 'Request too large' }); request.resume(); return }
    const offered = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const credential = offered ? [...this.credentials.values()].find(candidate => sameToken(offered, candidate.token)) : undefined
    if (!credential) { reply(401, { error: 'Unauthorized browser session' }); request.resume(); return }
    if (request.method === 'DELETE') { reply(200, {}); request.resume(); return }
    let message: Rpc
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk)
        if (size > MAX_BODY) { reply(413, { error: 'Request too large' }); request.destroy(); return }
        chunks.push(Buffer.from(chunk))
      }
      message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Rpc
    } catch { reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Malformed JSON-RPC request' } }); return }
    // A notification carries no id and, per JSON-RPC, must not be answered with a body.
    if (message === null || typeof message !== 'object' || message.id === undefined || message.id === null) { reply(202, undefined); return }
    reply(200, await this.dispatch(credential, message), { 'Mcp-Session-Id': credential.scope.agentSessionId })
  }

  private async dispatch(credential: { token: string; scope: BrowserMcpScope }, message: Rpc): Promise<unknown> {
    const scope = credential.scope
    const envelope = { jsonrpc: '2.0', id: message.id ?? null }
    const params = message.params && typeof message.params === 'object' ? message.params : {}
    try {
      if (message.method === 'initialize') {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return { ...envelope, result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BROWSER_MCP_SERVER_NAME, title: 'Conductor browser', version: '1' },
          instructions: 'These tools drive this project\'s isolated Conductor browser. It may be visible, detached, or running in the background; use browser_present when presentation matters.'
        } }
      }
      if (message.method === 'ping') return { ...envelope, result: {} }
      if (message.method === 'tools/list') return { ...envelope, result: { tools: BROWSER_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } }
      if (message.method === 'tools/call') {
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = BROWSER_TOOLS.find(candidate => candidate.name === name)
        if (!tool) return { ...envelope, error: { code: -32602, message: `Unknown browser tool: ${name || '(none)'}` } }
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {}
        // A failed tool is reported as a result, not a protocol error, so the agent reads the
        // reason and adapts instead of the CLI tearing the connection down.
        try {
          const guardedHost: BrowserMcpHost = { view: async requestedScope => {
            const view = await this.host.view(requestedScope)
            if (this.credentials.get(scope.agentSessionId) !== credential) throw new Error('Browser access was revoked before the view was ready')
            return view
          } }
          const result = await tool.run(guardedHost, scope, args)
          if (this.credentials.get(scope.agentSessionId) !== credential) throw new Error('Browser access was revoked while the tool was running')
          return { ...envelope, result: this.content(result) }
        }
        catch (error) { return { ...envelope, result: { isError: true, content: [{ type: 'text', text: errorMessage(error) }] } } }
      }
      return { ...envelope, error: { code: -32601, message: `Method not found: ${message.method ?? '(none)'}` } }
    } catch (error) { return { ...envelope, error: { code: -32603, message: errorMessage(error) } } }
  }

  private content(result: BrowserToolResult): unknown {
    const text = result.text.length > MAX_RESULT_CHARS
      ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n… truncated: the page produced ${result.text.length} characters and only ${MAX_RESULT_CHARS} are returned.`
      : result.text
    const content: unknown[] = [{ type: 'text', text }]
    if (result.image) content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType })
    // Structured content repeats the same page value a second time; a truncated result drops it
    // rather than sending the megabytes the text was just trimmed of.
    return { content, ...(result.structured && text === result.text ? { structuredContent: result.structured } : {}) }
  }

  close(): void {
    this.endpoint = ''; this.authority = ''
    for (const credential of this.credentials.values()) this.discard(credential)
    this.credentials.clear()
    if (this.configDirectory) { try { rmSync(this.configDirectory, { recursive: true, force: true }) } catch { /* the directory is already gone */ } }
    this.configDirectory = ''
    this.server?.closeAllConnections(); this.server?.close(); this.server = undefined
  }
}
