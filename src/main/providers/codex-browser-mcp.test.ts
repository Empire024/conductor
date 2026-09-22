import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexBrowserMcpThreadConfig, codexMcpApprovalOverrides } from './codex'
import type { Json } from '../../shared/structured-agent'

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

describe('Codex MCP approval overrides for the mode that never asks', () => {
  const browser = JSON.parse(valid) as Json
  const browserServer = (JSON.parse(valid) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers['conductor-browser']!
  const cleared = { ...browserServer, default_tools_approval_mode: 'auto' }
  it('clears every enabled server the owner left unset, keeps their explicit choices, and always clears the Conductor browser', () => {
    const configured = {
      'chrome-devtools': { command: 'node', enabled: true, default_tools_approval_mode: null },
      node_repl: { command: 'node', enabled: true },
      strict: { command: 'node', enabled: true, default_tools_approval_mode: 'prompt' },
      off: { command: 'node', enabled: false },
      'bad name!': { command: 'node' },
      junk: 'not a server'
    }
    expect(codexMcpApprovalOverrides(configured, browser)).toEqual({ mcp_servers: { 'chrome-devtools': { default_tools_approval_mode: 'auto' }, node_repl: { default_tools_approval_mode: 'auto' }, 'conductor-browser': cleared } })
    // The owner's configuration object is never mutated; only this thread's overrides carry the change.
    expect(configured.node_repl).toEqual({ command: 'node', enabled: true })
    expect(browser).toEqual(JSON.parse(valid))
  })
  it('falls back to the browser alone when the configuration is unreadable, and to nothing without either', () => {
    expect(codexMcpApprovalOverrides(undefined, undefined)).toBeUndefined()
    expect(codexMcpApprovalOverrides('junk', undefined)).toBeUndefined()
    expect(codexMcpApprovalOverrides({}, undefined)).toBeUndefined()
    expect(codexMcpApprovalOverrides(undefined, browser)).toEqual({ mcp_servers: { 'conductor-browser': cleared } })
    expect(codexMcpApprovalOverrides({ strict: { enabled: true, default_tools_approval_mode: 'writes' } }, browser)).toEqual({ mcp_servers: { 'conductor-browser': cleared } })
  })
})
