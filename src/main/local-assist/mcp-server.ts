import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../shared/models'
import { LOCAL_ASSIST_MCP_SERVER_NAME } from './contract.ts'
import { LOCAL_ASSIST_TOOLS, type LocalAssistTools } from './tools.ts'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']
const MAX_BODY = 256 * 1024
/** A test run may take many minutes; Codex is told the same through tool_timeout_sec. */
export const LOCAL_ASSIST_TOOL_TIMEOUT_SEC = 1900
interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
interface Credential { token: string; agentSessionId: string; projectId: string; sessionId: string; file?: string }

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Local assist failed'
const sameToken = (offered: string, expected: string): boolean => {
  const a = Buffer.from(offered), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The loopback `conductor-local` MCP endpoint: bounded jobs a Claude or Codex conversation
 *  hands the local model and gets back in the same turn. Built the way BrowserMcpServer is — a
 *  per-session bearer token handed over in a 0600 config file, never in argv, and a credential
 *  that names only its own conversation — because the same threats apply: another local process
 *  reading command lines, a web page posting to 127.0.0.1, a rebound DNS name. What a call may
 *  do is decided from the conversation's live settings (tools.ts), not from the credential. */
export class LocalAssistMcpServer {
  private server?: Server
  private endpoint = ''
  private authority = ''
  private configDirectory = ''
  private credentials = new Map<string, Credential>()
  constructor(private readonly tools: LocalAssistTools, private readonly disabled = process.env.CONDUCTOR_LIVE_TESTS === '1') {}

  get url(): string { return this.endpoint }

  async start(): Promise<void> {
    if (this.disabled || this.server) return
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(error => {
        console.warn('Local assist MCP request failed', error)
        try {
          if (response.headersSent || response.destroyed || response.writableEnded) response.destroy()
          else { response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); response.end('{"error":"Local assist failed"}') }
        } catch { /* the socket is already gone */ }
      })
    })
    server.requestTimeout = (LOCAL_ASSIST_TOOL_TIMEOUT_SEC + 60) * 1000
    server.headersTimeout = 10_000
    server.maxHeadersCount = 30
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    server.on('error', error => console.warn('Local assist MCP server error', error))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local assist MCP server failed to bind')
    this.authority = `127.0.0.1:${address.port}`
    this.endpoint = `http://${this.authority}/mcp`
  }

  /** A config file path for one Claude or Codex session, or '' when unavailable. */
  configure(spec: Pick<AgentSpec, 'id' | 'projectId' | 'sessionId' | 'provider'>): string {
    if (!this.endpoint || this.disabled || !['claude', 'codex'].includes(spec.provider)) return ''
    let credential = this.credentials.get(spec.id)
    if (!credential || credential.projectId !== spec.projectId || credential.sessionId !== spec.sessionId) {
      this.discard(credential)
      credential = { token: randomBytes(32).toString('hex'), agentSessionId: spec.id, projectId: spec.projectId, sessionId: spec.sessionId }
      this.credentials.set(spec.id, credential)
    }
    const authorization = `Bearer ${credential.token}`
    const configuration = JSON.stringify(spec.provider === 'claude'
      ? { mcpServers: { [LOCAL_ASSIST_MCP_SERVER_NAME]: { type: 'http', url: this.endpoint, headers: { Authorization: authorization } } } }
      : { mcp_servers: { [LOCAL_ASSIST_MCP_SERVER_NAME]: { url: this.endpoint, http_headers: { Authorization: authorization }, tool_timeout_sec: LOCAL_ASSIST_TOOL_TIMEOUT_SEC } } })
    return this.credentialFile(credential, configuration) ?? configuration
  }

  private credentialFile(credential: Credential, configuration: string): string | undefined {
    try {
      if (!this.configDirectory) this.configDirectory = mkdtempSync(join(tmpdir(), 'conductor-local-mcp-'))
      const file = join(this.configDirectory, `${credential.agentSessionId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
      writeFileSync(file, configuration, { mode: 0o600 })
      credential.file = file
      return file
    } catch (error) { console.warn('Local assist MCP configuration file unavailable', error); return undefined }
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
      const payload = body === undefined ? undefined : JSON.stringify(body)
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers })
      response.end(payload)
    }
    if (request.url !== '/mcp') { reply(404, { error: 'Unknown endpoint' }); request.resume(); return }
    if (request.method !== 'POST' && request.method !== 'DELETE') { reply(405, { error: 'Only JSON-RPC POST is accepted' }, { Allow: 'POST, DELETE' }); request.resume(); return }
    if (request.headers.origin || request.headers.host !== this.authority || (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))) { reply(403, { error: 'Only local JSON-RPC requests are accepted' }); request.resume(); return }
    if (Number(request.headers['content-length']) > MAX_BODY) { reply(413, { error: 'Request too large' }); request.resume(); return }
    const offered = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const credential = offered ? [...this.credentials.values()].find(candidate => sameToken(offered, candidate.token)) : undefined
    if (!credential) { reply(401, { error: 'Unauthorized session' }); request.resume(); return }
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
    if (message === null || typeof message !== 'object' || message.id === undefined || message.id === null) { reply(202, undefined); return }
    // A client that gives up on a call (the agent's turn was interrupted) closes the socket; the
    // command it started is killed rather than left running on the owner's machine.
    const cancelled = new AbortController()
    response.on('close', () => { if (!response.writableEnded) cancelled.abort() })
    reply(200, await this.dispatch(credential, message, cancelled.signal), { 'Mcp-Session-Id': credential.agentSessionId })
  }

  private async dispatch(credential: Credential, message: Rpc, signal: AbortSignal): Promise<unknown> {
    const envelope = { jsonrpc: '2.0', id: message.id ?? null }
    const params = message.params && typeof message.params === 'object' ? message.params : {}
    try {
      if (message.method === 'initialize') {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return { ...envelope, result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: LOCAL_ASSIST_MCP_SERVER_NAME, title: 'Conductor local assist', version: '1' },
          instructions: 'Hand bounded reading jobs to the local model on this machine to save your context: run_and_summarize for tests, builds and long logs; local_ask or summarize_file for large files.'
        } }
      }
      if (message.method === 'ping') return { ...envelope, result: {} }
      if (message.method === 'tools/list') return { ...envelope, result: { tools: LOCAL_ASSIST_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}) })) } }
      if (message.method === 'tools/call') {
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = LOCAL_ASSIST_TOOLS.find(candidate => candidate.name === name)
        if (!tool) return { ...envelope, error: { code: -32602, message: `Unknown local assist tool: ${name || '(none)'}` } }
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments as Record<string, unknown> : {}
        try {
          const result = await tool.call(this.tools, credential.agentSessionId, args, signal)
          if (this.credentials.get(credential.agentSessionId) !== credential) throw new Error('Local assist access was revoked while the tool was running')
          return { ...envelope, result: { content: [{ type: 'text', text: result.text }], structuredContent: result.structured } }
        } catch (error) { return { ...envelope, result: { isError: true, content: [{ type: 'text', text: errorMessage(error) }] } } }
      }
      return { ...envelope, error: { code: -32601, message: `Method not found: ${message.method ?? '(none)'}` } }
    } catch (error) { return { ...envelope, error: { code: -32603, message: errorMessage(error) } } }
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
