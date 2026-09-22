import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexBrowserMcpThreadConfig, codexMcpToolApproval } from './codex'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const valid = JSON.stringify({ mcp_servers: { 'conductor-browser': { url: 'http://127.0.0.1:43123/mcp', http_headers: { Authorization: `Bearer ${'a'.repeat(64)}` } } } })

describe('Codex Conductor-browser thread configuration', () => {
  it('accepts the bounded inline fallback and the private-file form', () => {
    expect(codexBrowserMcpThreadConfig(valid)).toEqual(JSON.parse(valid))
    const root = mkdtempSync(join(tmpdir(), 'conductor-codex-browser-')); roots.push(root)
    const file = join(root, 'agent.json'); writeFileSync(file, valid)
    expect(codexBrowserMcpThreadConfig(file)).toEqual(JSON.parse(valid))
    expect(codexBrowserMcpThreadConfig('')).toBeUndefined()
  })

  it.each([
    '{}',
    JSON.stringify({ mcp_servers: {} }),
    JSON.stringify({ mcp_servers: { other: JSON.parse(valid).mcp_servers['conductor-browser'] } }),
    JSON.stringify({ mcp_servers: { 'conductor-browser': { url: 'http://evil.test/mcp', http_headers: { Authorization: `Bearer ${'a'.repeat(64)}` } } } }),
    JSON.stringify({ mcp_servers: { 'conductor-browser': { url: 'http://127.0.0.1:43123/mcp', http_headers: { Authorization: 'Bearer guessable' } } } })
  ])('rejects anything other than one scoped loopback browser credential', configuration => {
    expect(() => codexBrowserMcpThreadConfig(configuration)).toThrow(/invalid|scoped/)
  })
})

describe('Codex MCP tool approval elicitations', () => {
  const approval = { threadId: 't', turnId: 'u', serverName: 'conductor-browser', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] }, message: 'Allow the conductor-browser MCP server to run tool "browser_snapshot"?', requestedSchema: { type: 'object', properties: {} } }
  it('recognises exactly the approval-kind form elicitation and reads the tool and persist scopes', () => {
    expect(codexMcpToolApproval(approval)).toEqual({ serverName: 'conductor-browser', tool: 'browser_snapshot', message: approval.message, persist: ['session', 'always'] })
    expect(codexMcpToolApproval({ ...approval, _meta: { codex_approval_kind: 'mcp_tool_call' } })?.persist).toEqual([])
  })
  it('leaves every other elicitation unsupported', () => {
    expect(codexMcpToolApproval({ ...approval, mode: 'url' })).toBeUndefined()
    expect(codexMcpToolApproval({ ...approval, _meta: null })).toBeUndefined()
    expect(codexMcpToolApproval({ ...approval, _meta: { codex_approval_kind: 'something_else' } })).toBeUndefined()
    expect(codexMcpToolApproval('junk')).toBeUndefined()
  })
})
