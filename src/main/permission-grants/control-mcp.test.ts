import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { CONDUCTOR_MCP_TOOLS, CONDUCTOR_TOOL_TIMEOUT_SEC, ConductorMcpServer } from './control-mcp'
import { codexConductorThreadConfig, codexLocalAssistThreadConfig, mergeCodexMcpConfigs } from '../local-assist/mcp-config'

const servers: ConductorMcpServer[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

async function serve() {
  const calls: Array<{ scope: unknown; method: string; args: unknown; generic: boolean }> = []
  const server = new ConductorMcpServer(async (scope, method, args, options) => { calls.push({ scope, method, args, generic: Boolean(options?.generic) }); return { ok: true } }, false)
  servers.push(server)
  await server.start()
  return { server, calls }
}
const spec = (provider: 'claude' | 'codex' | 'grok' | 'local', id = `agent_${provider}`) => ({ id, projectId: 'project', sessionId: 'workspace', provider })
type Rpc = { result?: { tools?: Array<{ name: string }>; instructions?: string; isError?: boolean; content?: Array<{ text: string }> }; error?: { message: string } }

describe('the conductor MCP server for Codex (H14)', () => {
  it('mints a Codex thread config in Codex\'s own form, which the adapter\'s validator accepts', async () => {
    const { server } = await serve()
    const file = server.configure(spec('codex'))
    const config = JSON.parse(readFileSync(file, 'utf8'))
    expect(config).toEqual({ mcp_servers: { conductor: { url: server.url, http_headers: { Authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) }, tool_timeout_sec: CONDUCTOR_TOOL_TIMEOUT_SEC } } })
    expect(codexConductorThreadConfig(file)).toEqual(config)
    // A Claude conversation keeps Claude Code's form; providers without MCP config get nothing.
    expect(JSON.parse(readFileSync(server.configure(spec('claude')), 'utf8')).mcpServers.conductor.type).toBe('http')
    expect(server.configure(spec('grok'))).toBe('')
    expect(server.configure(spec('local'))).toBe('')
  })

  it('offers Codex every tool except the Claude-only permission requests, and refuses those by name', async () => {
    const { server, calls } = await serve()
    const configOf = (provider: 'claude' | 'codex') => {
      const entry = JSON.parse(readFileSync(server.configure(spec(provider)), 'utf8'))
      return provider === 'claude' ? { url: entry.mcpServers.conductor.url, authorization: entry.mcpServers.conductor.headers.Authorization } : { url: entry.mcp_servers.conductor.url, authorization: entry.mcp_servers.conductor.http_headers.Authorization }
    }
    const rpc = async (provider: 'claude' | 'codex', body: Record<string, unknown>): Promise<Rpc> => {
      const { url, authorization } = configOf(provider)
      return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })).json() as Rpc
    }
    const codexTools = (await rpc('codex', { method: 'tools/list' })).result!.tools!.map(tool => tool.name)
    expect(codexTools).toEqual(['control', 'send_message', 'submit_task', 'report', 'handoff'])
    expect((await rpc('claude', { method: 'tools/list' })).result!.tools!.map(tool => tool.name)).toEqual(CONDUCTOR_MCP_TOOLS.map(tool => tool.name))
    expect((await rpc('codex', { method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result!.instructions).not.toContain('request_permission')
    expect((await rpc('claude', { method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result!.instructions).toContain('request_permission')

    const refused = await rpc('codex', { method: 'tools/call', params: { name: 'request_permission', arguments: { command: 'git push', reason: 'ship' } } })
    expect(refused.result).toMatchObject({ isError: true })
    expect(refused.result!.content![0]!.text).toContain('its own approval card')
    expect(refused.result!.content![0]!.text).toContain('Tools here: control, send_message')
    expect((await rpc('codex', { method: 'tools/call', params: { name: 'send_mesage', arguments: {} } })).error!.message).toBe('Unknown Conductor tool "send_mesage"; the tools here are control, send_message, submit_task, report, handoff. control({method,args}) calls any app-control method.')
    expect(calls).toEqual([])

    await rpc('codex', { method: 'tools/call', params: { name: 'report', arguments: { text: 'done' } } })
    await rpc('codex', { method: 'tools/call', params: { name: 'control', arguments: { method: 'agents.status', args: { agentSessionId: 'agent_x' } } } })
    const scope = { projectId: 'project', sessionId: 'workspace', agentSessionId: 'agent_codex' }
    expect(calls).toEqual([
      { scope, method: 'agents.report', args: { text: 'done' }, generic: false },
      { scope, method: 'agents.status', args: { agentSessionId: 'agent_x' }, generic: true }
    ])
  })

  it('keeps one credential per conversation and replaces it when the provider changes', async () => {
    const { server } = await serve()
    const tokenOf = (file: string) => JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))).match(/Bearer ([a-f0-9]{64})/)![1]
    const first = tokenOf(server.configure(spec('codex', 'agent_same')))
    expect(tokenOf(server.configure(spec('codex', 'agent_same')))).toBe(first)
    expect(tokenOf(server.configure(spec('claude', 'agent_same')))).not.toBe(first)
  })
})

describe('the report tool (H08)', () => {
  it('takes a long report whole and hands it to agents.report, which keeps the rest as an artifact', async () => {
    const report = CONDUCTOR_MCP_TOOLS.find(tool => tool.name === 'report')!
    expect((report.inputSchema as { properties: { text: { maxLength: number } } }).properties.text.maxLength).toBe(20000)
    expect(report.description).toContain('never refuses')
    expect(report.description).toContain('artifact')
    const { server, calls } = await serve()
    const entry = JSON.parse(readFileSync(server.configure(spec('codex')), 'utf8')).mcp_servers.conductor
    const text = 'x'.repeat(5000)
    const reply = await (await fetch(entry.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: entry.http_headers.Authorization }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report', arguments: { text } } }) })).json() as Rpc
    expect(reply.result!.isError).toBeUndefined()
    expect(calls).toEqual([{ scope: { projectId: 'project', sessionId: 'workspace', agentSessionId: 'agent_codex' }, method: 'agents.report', args: { text }, generic: false }])
  })
})

describe('Codex thread config for the conductor server', () => {
  const conductor = { mcp_servers: { conductor: { url: 'http://127.0.0.1:4002/mcp', http_headers: { Authorization: `Bearer ${'c'.repeat(64)}` }, tool_timeout_sec: 180 } } }
  const local = { mcp_servers: { 'conductor-local': { url: 'http://127.0.0.1:4000/mcp', http_headers: { Authorization: `Bearer ${'a'.repeat(64)}` }, tool_timeout_sec: 1900 } } }

  it('merges into one mcp_servers table with conductor-local (probed on codex-cli 0.155.1: both start ready beside the CLI\'s own servers)', () => {
    expect(mergeCodexMcpConfigs(codexLocalAssistThreadConfig(JSON.stringify(local)), codexConductorThreadConfig(JSON.stringify(conductor)))).toEqual({ mcp_servers: { ...local.mcp_servers, ...conductor.mcp_servers } })
    expect(codexConductorThreadConfig('')).toBeUndefined()
  })

  it.each([
    JSON.stringify(local),
    JSON.stringify({ mcp_servers: { ...conductor.mcp_servers, other: {} } }),
    JSON.stringify({ mcp_servers: { conductor: { ...conductor.mcp_servers.conductor, url: 'http://evil.test/mcp' } } }),
    JSON.stringify({ mcp_servers: { conductor: { ...conductor.mcp_servers.conductor, http_headers: { Authorization: 'Bearer guessable' } } } })
  ])('rejects anything other than one scoped loopback conductor credential', configuration => {
    expect(() => codexConductorThreadConfig(configuration)).toThrow(/Conductor control MCP configuration (has an invalid server set|is not a scoped loopback credential)/)
  })
})
