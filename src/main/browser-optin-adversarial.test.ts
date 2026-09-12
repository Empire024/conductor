import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { BrowserMcpServer } from './browser-mcp'
import type { BrowserMcpHost } from '../shared/browser-mcp'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { ProviderCapabilities } from '../shared/structured-agent'

describe('browser opt-out revokes already-issued access', () => {
  it('does not navigate after release while browser lookup is still pending', async () => {
    let deliverView!: (value: unknown) => void
    const delayedView = new Promise<unknown>(resolve => { deliverView = resolve })
    const lookup = vi.fn(() => delayedView)
    const navigate = vi.fn(async () => ({ url: 'https://example.com/', title: 'Late navigation' }))
    const bridge = new BrowserMcpServer({ view: lookup } as unknown as BrowserMcpHost, false)
    let response: Promise<Response> | undefined
    try {
      await bridge.start()
      const configuration = bridge.configure({ id: 'agent-browser-race', projectId: 'project-review', sessionId: 'workspace-review', provider: 'claude' })
      const entry = JSON.parse(configuration.startsWith('{') ? configuration : readFileSync(configuration, 'utf8')).mcpServers['conductor-browser']
      response = fetch(entry.url, { method: 'POST', headers: { ...entry.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com/' } } }) })
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce())
      bridge.release('agent-browser-race')
      deliverView({ navigate })
      await (await response).text()
      expect(navigate).not.toHaveBeenCalled()
    } finally {
      deliverView({ navigate })
      if (response) await response.catch(() => {})
      bridge.close()
    }
  })

  it('refuses the same real HTTP credential immediately after the owner disables browser tools', async () => {
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
    const directory = mkdtempSync(join(tmpdir(), 'conductor-browser-optout-review-'))
    const database = new ConductorDatabase(join(directory, 'state.db'))
    const project = database.upsertProject(directory, 'Browser opt-out review')
    const workspace = database.listSessions(project.id)[0]!
    const bridge = new BrowserMcpServer({ view: vi.fn() } as unknown as BrowserMcpHost, false)
    let configuration = ''
    let finishTurn = (): void => {}
    let submissions = 0
    const capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: false, plans: true, permissions: ['default'], effort: [], models: [], limitations: [] }
    const factory = (_provider: unknown, options: AdapterOptions): ProviderAdapter => ({
      provider: 'claude', capabilities,
      async start() { configuration = options.mcpConfig ?? ''; finishTurn = () => options.emit({ data: { type: 'session', phase: 'completed' } }); options.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-browser-review' } }) },
      async submit() { submissions++ }, async respond() {}, async interrupt() {}, dispose() {}
    })
    const manager = new StructuredSessions(database, () => 'unused', () => {}, factory, undefined, undefined, bridge)
    const spec = { id: 'agent-browser-review', projectId: project.id, sessionId: workspace.id, provider: 'claude' as const, title: 'Browser review', cwd: directory }
    const settings = { permission: 'default' as const, plan: false, browserMcp: true }
    try {
      await bridge.start()
      manager.ensure(spec)
      manager.saveSettings(spec.id, settings)
      await manager.submit(spec.id, 'Use browser', settings)
      const parsed = JSON.parse(configuration.startsWith('{') ? configuration : readFileSync(configuration, 'utf8'))
      const entry = parsed.mcpServers['conductor-browser']
      const request = () => fetch(entry.url, { method: 'POST', headers: { ...entry.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(async response => { await response.text(); return response.status })
      expect(await request()).toBe(200)
      await manager.queue(spec.id, 'Previously queued while browser was on', settings)
      manager.saveSettings(spec.id, { ...settings, browserMcp: false })
      expect(await request()).toBe(401)
      finishTurn()
      await vi.waitFor(() => expect(submissions).toBe(2))
      expect(database.structured.snapshot(spec.id)?.settings.browserMcp).toBe(false)
    } finally {
      manager.dispose(); bridge.close(); database.close(); vi.unstubAllEnvs()
      const actual = realpathSync(directory)
      expect(actual.toLowerCase().startsWith(join(realpathSync(tmpdir()), 'conductor-browser-optout-review-').toLowerCase())).toBe(true)
      rmSync(actual, { recursive: true, force: true })
    }
  })
})
