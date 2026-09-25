import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexLocalAssistThreadConfig, mergeCodexMcpConfigs } from './mcp-config'
import { LocalAssistMcpServer } from './mcp-server'
import type { LocalAssistTools } from './tools'

const spec = (provider: string, id = 'a1') => ({ id, projectId: 'p1', sessionId: 's1', provider }) as never
const servers: LocalAssistMcpServer[] = []
afterEach(() => { for (const server of servers.splice(0)) server.close() })

async function started(tools: Partial<LocalAssistTools> = {}) {
  const server = new LocalAssistMcpServer(tools as LocalAssistTools, false)
  servers.push(server)
  await server.start()
  return server
}
const claudeCredential = (file: string): { url: string; token: string } => {
  const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers['conductor-local']
  return { url: entry.url, token: entry.headers.Authorization }
}
const rpc = (url: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token, ...headers }, body: JSON.stringify(body) })

describe('LocalAssistMcpServer', () => {
  it('mints a per-session config file for Claude and Codex only', async () => {
    const server = await started()
    const claude = server.configure(spec('claude'))
    expect(claude).not.toContain('Bearer')
    const { url, token } = claudeCredential(claude)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(token).toMatch(/^Bearer [a-f0-9]{64}$/)
    const codex = server.configure(spec('codex', 'a2'))
    const thread = codexLocalAssistThreadConfig(codex) as { mcp_servers: Record<string, { tool_timeout_sec: number }> }
    expect(thread.mcp_servers['conductor-local']!.tool_timeout_sec).toBeGreaterThan(600)
    expect(server.configure(spec('local', 'a3'))).toBe('')
    expect(server.configure(spec('grok', 'a4'))).toBe('')
  })

  it('lists the three tools and routes a call to the credential\'s own conversation', async () => {
    const runAndSummarize = vi.fn(async (id: string) => ({ text: `ran for ${id}`, structured: { exitCode: 0 } }))
    const server = await started({ runAndSummarize } as never)
    const { url, token } = claudeCredential(server.configure(spec('claude', 'mine')))
    const listed = await (await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['run_and_summarize', 'local_ask', 'summarize_file'])
    const called = await (await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_and_summarize', arguments: { command: 'npm test' } } })).json()
    expect(called.result.content[0].text).toBe('ran for mine')
    expect(runAndSummarize).toHaveBeenCalledWith('mine', { command: 'npm test' }, expect.any(AbortSignal))
  })

  it('puts the answer where Claude Code and Codex read it: inside structuredContent (VR3 A5)', async () => {
    const answer = 'NEEDLE-ALPHA is 48213-KESTREL (s7.log:1365)\n— local'
    const ask = vi.fn(async () => ({ text: answer, structured: { answered: true, files: [{ path: 's7.log', bytes: 10, truncated: false }] } }))
    const server = await started({ ask } as never)
    const { url, token } = claudeCredential(server.configure(spec('claude')))
    const called = await (await rpc(url, token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'local_ask', arguments: { prompt: 'x', files: ['s7.log'] } } })).json()
    // What Claude Code hands the model: the structuredContent JSON when there is one, text blocks
    // dropped (Codex does the same); the content text only when there is none.
    const surfaced = (result: { content: Array<{ type: string; text?: string }>; structuredContent?: unknown }): string =>
      result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
    expect(JSON.parse(surfaced(called.result)).text).toBe(answer)
    expect(called.result.structuredContent).toMatchObject({ answered: true, files: [{ path: 's7.log' }] })
    expect(called.result.content).toEqual([{ type: 'text', text: answer }])
  })

  it('reports a tool failure as a result the agent can read', async () => {
    const server = await started({ runAndSummarize: async () => { throw new Error('only available to a conversation in Auto') } } as never)
    const { url, token } = claudeCredential(server.configure(spec('claude')))
    const called = await (await rpc(url, token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_and_summarize', arguments: {} } })).json()
    expect(called.result).toEqual({ isError: true, content: [{ type: 'text', text: 'only available to a conversation in Auto' }] })
  })

  it('refuses unknown tokens, released sessions, browsers and foreign hosts', async () => {
    const server = await started()
    const { url, token } = claudeCredential(server.configure(spec('claude')))
    expect((await rpc(url, `Bearer ${'0'.repeat(64)}`, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401)
    expect((await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200)
    server.release('a1')
    expect((await rpc(url, token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401)
  })

  it('stays off under live tests', async () => {
    const server = new LocalAssistMcpServer({} as LocalAssistTools, true)
    await server.start()
    expect(server.configure(spec('claude'))).toBe('')
  })
})

describe('Codex thread config', () => {
  it('accepts only the scoped loopback credential and merges with the browser server', () => {
    const local = { mcp_servers: { 'conductor-local': { url: 'http://127.0.0.1:4000/mcp', http_headers: { Authorization: `Bearer ${'a'.repeat(64)}` }, tool_timeout_sec: 1900 } } }
    const browser = { mcp_servers: { 'conductor-browser': { url: 'http://127.0.0.1:4001/mcp', http_headers: { Authorization: `Bearer ${'b'.repeat(64)}` } } } }
    const parsed = codexLocalAssistThreadConfig(JSON.stringify(local))
    expect(parsed).toEqual(local)
    expect(mergeCodexMcpConfigs(browser, parsed)).toEqual({ mcp_servers: { ...browser.mcp_servers, ...local.mcp_servers } })
    expect(mergeCodexMcpConfigs(undefined, undefined)).toBeUndefined()
    expect(mergeCodexMcpConfigs(browser, undefined)).toEqual(browser)
    expect(codexLocalAssistThreadConfig('')).toBeUndefined()
    expect(() => codexLocalAssistThreadConfig(JSON.stringify({ mcp_servers: { 'conductor-local': { ...local.mcp_servers['conductor-local'], url: 'https://example.com/mcp' } } }))).toThrow(/scoped loopback/)
    expect(() => codexLocalAssistThreadConfig(JSON.stringify({ mcp_servers: { ...local.mcp_servers, other: {} } }))).toThrow(/invalid server set/)
  })
})
