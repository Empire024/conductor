import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GrokAdapter, GROK_BASELINE, grokApprovalPolicy, grokBrowserMcpServers, grokChanges, grokLaunchArguments, grokPrompt } from './grok'
import { JsonLineTransport } from './transport'
import type { AdapterEvent, Json, SessionSettings } from '../../shared/structured-agent'

const fixture = path.resolve('scripts/fixtures/fake-grok.mjs')
const ask: SessionSettings = { permission: 'default', plan: false }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean() })

function create(settings: SessionSettings = ask, options: { nativeSessionId?: string; environment?: NodeJS.ProcessEnv; mcpConfig?: string; approvalReviewer?: boolean } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'conductor-grok-'))
  const events: AdapterEvent[] = []
  const sent: Json[] = []
  let closed = true
  const adapter = new GrokAdapter({ executable: 'not-a-real-provider', cwd, runtimeId: 'runtime-1', settings, nativeSessionId: options.nativeSessionId, mcpConfig: options.mcpConfig, approvalReviewer: options.approvalReviewer, environment: { ...process.env, ...options.environment }, emit: event => events.push(event) }, {
    version: async () => `grok ${GROK_BASELINE} (4220f3b224a6)`,
    requestTimeoutMs: 3000,
    transport: transportOptions => {
      closed = false
      const transport = new JsonLineTransport({ ...transportOptions, executable: process.execPath, args: [fixture, ...transportOptions.args], onExit: (code, signal) => { closed = true; transportOptions.onExit?.(code, signal) } })
      return { start: () => transport.start(), send: message => { sent.push(message); transport.send(message) }, close: () => transport.close(), get connected() { return transport.connected } }
    }
  })
  cleanup.push(async () => { adapter.dispose(); await waitFor(() => closed); rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }) })
  return { adapter, events, sent, cwd }
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 4000
  while (!predicate()) { if (Date.now() > until) throw new Error('Synthetic protocol condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
const phase = (events: AdapterEvent[], value: string) => events.some(event => event.data.type === 'session' && event.data.phase === value)
const methods = (sent: Json[]) => sent.map(message => (message as { method?: string }).method).filter(Boolean)
const pending = (events: AdapterEvent[]) => events.filter(event => event.data.type === 'interaction' && event.data.interaction.status === 'pending').at(-1)
const notices = (events: AdapterEvent[]) => events.flatMap(event => event.data.type === 'notice' ? [event.data.message] : [])

describe('Grok ACP adapter against the scripted fixture (zero inference)', () => {
  it('launches one private agent process and connects a session with the runtime catalog', async () => {
    expect(grokLaunchArguments()).toEqual(['agent', '--no-leader', 'stdio'])
    const { adapter, events, sent } = create()
    await adapter.start()
    expect(methods(sent)).toEqual(['initialize', 'session/new'])
    expect(adapter.capabilities.runtimeVersion).toBe(GROK_BASELINE)
    expect(adapter.capabilities.permissions).toEqual(['default', 'accept-edits', 'auto'])
    expect(adapter.capabilities.models.map(model => model.id)).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.5'])
    expect(adapter.capabilities.models[0]).toMatchObject({ isDefault: true, defaultEffort: 'high', effort: ['xhigh', 'high', 'medium', 'low'] })
    const idle = events.find(event => event.data.type === 'session' && event.data.phase === 'idle')
    expect(idle?.data.type === 'session' && idle.data.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/)
    // Grok's own setup notifications are process chatter, never conversation notices.
    expect(notices(events)).toEqual([])
  })

  it('streams a turn: thought as status, reply as assistant text, spend and context usage', async () => {
    const { adapter, events } = create()
    await adapter.submit('hello', ask)
    await waitFor(() => phase(events, 'completed'))
    const text = (role: string) => events.flatMap(event => event.data.type === 'text' && event.data.role === role ? [event.data.text] : []).join('')
    expect(text('status')).toBe('Thinking about it.')
    expect(text('assistant')).toBe('Synthetic Grok reply.')
    const usage = events.filter(event => event.data.type === 'usage').map(event => event.data)
    expect(usage).toContainEqual(expect.objectContaining({ scope: 'turn', inputTokens: 19421, outputTokens: 27, cachedTokens: 1792, reasoningTokens: 26, costUsd: 0.01234744 }))
    expect(usage).toContainEqual(expect.objectContaining({ scope: 'session', limits: { contextCapacityTokens: 500000, modelContextWindow: 500000, contextUsedTokens: 19457 } }))
  })

  // G8: Grok 1.0.41 takes a plain-string value id and rejects `{ value }` with -32602 (the fixture
  // answers exactly as the installed CLI did in the zero-turn probe, docs/autopilot-evidence/g8-grok-config.md).
  const configCalls = (sent: Json[]) => sent.filter(message => (message as { method?: string }).method === 'session/set_config_option').map(message => (message as { params: { configId: string; value: unknown } }).params)

  it('applies model and effort as plain-string session config values and adopts what Grok confirms, never set_mode', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('hello', { ...ask, model: 'grok-4.5', effort: 'low' })
    await waitFor(() => phase(events, 'completed'))
    expect(configCalls(sent)).toEqual([expect.objectContaining({ configId: 'model', value: 'grok-4.5' }), expect.objectContaining({ configId: 'reasoning_effort', value: 'low' })])
    expect(adapter.capabilities.effectiveSettings).toMatchObject({ model: 'grok-4.5', effort: 'low' })
    expect(methods(sent)).not.toContain('session/set_mode')
    // High to medium on the same session, the owner's failing change.
    await adapter.submit('hello', { ...ask, model: 'grok-4.5', effort: 'medium' })
    await waitFor(() => events.filter(event => event.data.type === 'session' && event.data.phase === 'completed').length === 2)
    expect(configCalls(sent).at(-1)).toMatchObject({ configId: 'reasoning_effort', value: 'medium' })
    expect(adapter.capabilities.effectiveSettings).toMatchObject({ model: 'grok-4.5', effort: 'medium' })
    await expect(adapter.submit('hello', { ...ask, model: 'grok-9' })).rejects.toThrow(/does not offer the model grok-9/)
  })

  it('opens Grok Fast at medium effort as a new session and as a resumed one', async () => {
    const fast: SessionSettings = { ...ask, model: 'grok-4.7-build-fast', effort: 'medium' }
    for (const nativeSessionId of [undefined, '01a0d07c-046f-7402-8f63-5411cc054ae9']) {
      const { adapter, events, sent } = create(fast, { nativeSessionId })
      await adapter.start()
      expect(configCalls(sent)).toEqual([expect.objectContaining({ configId: 'model', value: 'grok-4.7-build-fast' }), expect.objectContaining({ configId: 'reasoning_effort', value: 'medium' })])
      expect(adapter.capabilities.effectiveSettings).toMatchObject({ model: 'grok-4.7-build-fast', effort: 'medium' })
      expect(phase(events, 'disconnected')).toBe(false)
    }
  })

  it('a refused setting on resume keeps the conversation on Grok\'s confirmed settings instead of failing to connect', async () => {
    const { adapter, events } = create({ ...ask, model: 'grok-9' }, { nativeSessionId: '01a0d07c-046f-7402-8f63-5411cc054ae9' })
    await adapter.start()
    expect(phase(events, 'idle')).toBe(true)
    expect(phase(events, 'disconnected')).toBe(false)
    expect(notices(events).some(message => /kept model grok-4\.7 with high effort: .*does not offer the model grok-9/.test(message))).toBe(true)
    await expect(adapter.submit('hello', { ...ask, model: 'grok-9' })).rejects.toThrow(/does not offer the model grok-9/)
    await adapter.submit('hello', ask)
    await waitFor(() => phase(events, 'completed'))
  })

  it('Ask holds an edit for the owner, with Grok\'s options, and forwards the chosen option', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:edit', ask)
    await waitFor(() => Boolean(pending(events)))
    const card = pending(events)!
    expect(card.data.type === 'interaction' && card.data.interaction.choices.map(choice => choice.id)).toEqual(['allow-edits-session', 'allow-once', 'reject-once', 'cancel'])
    expect(phase(events, 'waiting_approval')).toBe(true)
    expect(events.some(event => event.data.type === 'tool' && event.data.name === 'Edit' && event.data.status === 'awaiting_approval')).toBe(true)
    await adapter.respond({ sessionId: 's', runtimeId: 'runtime-1', requestId: card.requestId!, decision: 'allow-once' })
    await waitFor(() => phase(events, 'completed'))
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
    const changes = events.flatMap(event => event.data.type === 'changes' ? event.data.changes : [])
    expect(changes.at(-1)).toMatchObject({ kind: 'update', status: 'applied', additions: 2, deletions: 1 })
  })

  it('Edit allows in-workspace edits itself but leaves commands to the owner', async () => {
    const edit: SessionSettings = { permission: 'accept-edits', plan: false }
    const { adapter, events } = create(edit)
    await adapter.submit('synthetic:edit', edit)
    await waitFor(() => phase(events, 'completed'))
    expect(pending(events)).toBeUndefined()
    expect(notices(events).some(message => message.startsWith('Edit mode allowed'))).toBe(true)
    await adapter.submit('synthetic:command npm test', edit)
    await waitFor(() => Boolean(pending(events)))
  })

  it('Auto opens Grok\'s own auto mode, allows escalations once, and holds owner-only boundaries', async () => {
    const auto: SessionSettings = { permission: 'auto', plan: false }
    const { adapter, events, sent } = create(auto)
    await adapter.start()
    expect(sent).toContainEqual(expect.objectContaining({ method: 'session/new', params: expect.objectContaining({ _meta: { autoMode: true } }) }))
    await adapter.submit('synthetic:command npm test', auto)
    await waitFor(() => phase(events, 'completed'))
    expect(notices(events).some(message => message.startsWith('Auto allowed'))).toBe(true)
    await adapter.submit('synthetic:command reg add HKLM\\Software\\Example /v x /d 1', auto)
    await waitFor(() => Boolean(pending(events)))
    const card = pending(events)!
    expect(card.data.type === 'interaction' && card.data.interaction.choices.map(choice => choice.id)).toEqual(['allow-once', 'reject-once', 'cancel'])
    expect(notices(events).some(message => /left .* to you: it reaches the registry/.test(message))).toBe(true)
  })

  it('Plan declines every escalation and tells Grok to plan only', async () => {
    const plan: SessionSettings = { permission: 'default', plan: true }
    const { adapter, events, sent } = create(plan)
    await adapter.submit('synthetic:edit', plan)
    await waitFor(() => phase(events, 'completed'))
    expect(pending(events)).toBeUndefined()
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } })
    const prompt = sent.find(message => (message as { method?: string }).method === 'session/prompt') as { params: { prompt: Array<{ text: string }> } }
    expect(prompt.params.prompt[0]!.text).toMatch(/^\[Conductor plan mode/)
    expect(grokApprovalPolicy(ask, true)).toBe('refuse')
    expect(grokApprovalPolicy({ permission: 'read-only', plan: false })).toBe('refuse')
  })

  it('switches Grok\'s own auto mode by re-attaching the live session', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('hello', { permission: 'auto', plan: false })
    await waitFor(() => phase(events, 'completed'))
    expect(sent).toContainEqual(expect.objectContaining({ method: 'session/resume', params: expect.objectContaining({ _meta: { autoMode: true } }) }))
  })

  it('interrupts with session/cancel and settles as interrupted', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:hang', ask)
    await waitFor(() => sent.some(message => (message as { method?: string }).method === 'session/prompt'))
    await adapter.interrupt()
    await waitFor(() => phase(events, 'interrupted'))
    expect(methods(sent)).toContain('session/cancel')
    expect(phase(events, 'interrupting')).toBe(true)
  })

  it('interrupting while an approval waits answers it cancelled', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:edit', ask)
    await waitFor(() => Boolean(pending(events)))
    await adapter.interrupt()
    await waitFor(() => phase(events, 'interrupted'))
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'cancelled' } } })
  })

  it('resumes a native session, and starts a new one when Grok no longer has it', async () => {
    const resumed = create(ask, { nativeSessionId: '01a0d07c-046f-7402-8f63-5411cc054ae9' })
    await resumed.adapter.start()
    expect(methods(resumed.sent)).toEqual(['initialize', 'session/resume'])
    const missing = create(ask, { nativeSessionId: 'missing-01a0d07c' })
    await missing.adapter.start()
    expect(methods(missing.sent)).toEqual(['initialize', 'session/resume', 'session/new'])
    expect(notices(missing.events).some(message => message.includes('no saved history'))).toBe(true)
  })

  it('follows the account catalog Grok announces after connecting, and marks compaction for a briefing restatement', async () => {
    const { adapter, events } = create()
    await adapter.submit('synthetic:models synthetic:compact', ask)
    await waitFor(() => phase(events, 'completed'))
    expect(adapter.capabilities.models.map(model => model.id)).toContain('grok-4.8')
    expect(events.some(event => event.data.type === 'notice' && (event.data.payload as { contextReset?: boolean } | undefined)?.contextReset === true)).toBe(true)
  })

  it('reports a signed-out CLI with the sign-in step', async () => {
    const { adapter, events } = create(ask, { environment: { FAKE_GROK_UNAUTHENTICATED: '1' } })
    await expect(adapter.start()).rejects.toThrow(/Authentication required/)
    expect(events.some(event => event.data.type === 'session' && event.data.phase === 'disconnected' && /grok login/.test(event.data.message ?? ''))).toBe(true)
  })

  it('hands Conductor\'s browser MCP to session/new as an ACP http server', async () => {
    const token = 'a'.repeat(64)
    const config = JSON.stringify({ mcpServers: { 'conductor-browser': { type: 'http', url: 'http://127.0.0.1:40123/mcp', headers: { Authorization: `Bearer ${token}` } } } })
    expect(grokBrowserMcpServers(config)).toEqual([{ type: 'http', name: 'conductor-browser', url: 'http://127.0.0.1:40123/mcp', headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }])
    expect(() => grokBrowserMcpServers(JSON.stringify({ mcpServers: { 'conductor-browser': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: `Bearer ${token}` } } } }))).toThrow(/scoped loopback/)
    const { adapter, sent } = create(ask, { mcpConfig: config })
    await adapter.start()
    expect(sent).toContainEqual(expect.objectContaining({ method: 'session/new', params: expect.objectContaining({ mcpServers: grokBrowserMcpServers(config) }) }))
  })
})

describe('Grok content helpers', () => {
  it('labels attachments and refuses images', () => {
    expect(grokPrompt('look', [{ id: '1', kind: 'file', name: 'a.ts', path: 'src/a.ts', content: 'x', startLine: 2, endLine: 3 }])).toEqual([{ type: 'text', text: 'look' }, { type: 'text', text: '[Attached file: src/a.ts:2-3]\nx' }])
    expect(() => grokPrompt('look', [{ id: '1', kind: 'image', name: 'a.png', path: 'a.png' }])).toThrow(/image/)
  })
  it('turns ACP diff blocks into file changes', () => {
    expect(grokChanges([{ type: 'diff', path: 'new.txt', oldText: null, newText: 'a\nb' }], 'applied')).toMatchObject([{ path: 'new.txt', kind: 'add', additions: 2, deletions: 0, status: 'applied' }])
    expect(grokChanges([{ type: 'content', content: { type: 'text', text: 'x' } }], 'applied')).toEqual([])
  })
})
