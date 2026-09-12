import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE, codexChanges, codexDiffCounts, codexInput, codexLaunchArguments, validateCodexLiveConfiguration, codexLiveSkillOverrides } from './codex'
import { JsonLineTransport } from './transport'
import { SteeringUnavailableError } from './adapter'
import type { AdapterEvent, Json, SessionSettings } from '../../shared/structured-agent'
import type { ConfigReadResponse } from './generated/codex/v2/ConfigReadResponse'
import type { SkillsListResponse } from './generated/codex/v2/SkillsListResponse'

const fixture = path.resolve('scripts/fixtures/codex-app-server.mjs')
const baseline = "export function updatePanel(el, pinned) {\n  var wasOpen = el.classList.contains('is-open');\n  var wasPinned = pinned;\n  el.classList.add('is-loading');\n}\n"
const settings: SessionSettings = { permission: 'default', plan: false }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean() })

function create(extraEnvironment: NodeJS.ProcessEnv = {}, nativeSessionId?: string, requestTimeoutMs = 3000) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'conductor-codex-'))
  const events: AdapterEvent[] = []
  const sent: Json[] = []
  let closed = true
  const adapter = new CodexAdapter({ executable: 'not-a-real-provider', cwd, runtimeId: 'runtime-1', settings, nativeSessionId, environment: { ...process.env, ...extraEnvironment }, emit: event => events.push(event) }, {
    version: async () => `codex-cli ${CODEX_PROTOCOL_BASELINE}`,
    requestTimeoutMs,
    transport: options => {
      closed = false
      const transport = new JsonLineTransport({ ...options, executable: process.execPath, args: [fixture], onExit: (code, signal) => { closed = true; options.onExit?.(code, signal) } })
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
const completed = (events: AdapterEvent[]) => events.some(event => event.data.type === 'session' && event.data.phase === 'completed')
const pendingId = (events: AdapterEvent[]) => events.filter(event => event.data.type === 'interaction' && event.data.interaction.status === 'pending').at(-1)?.requestId

describe('Codex App Server raw synthetic process contract (zero inference)', () => {
  it('awaits initialize, emits initialized, starts one thread, and discovers supported models', async () => {
    const { adapter, sent } = create()
    await Promise.all([adapter.start(), adapter.start()])
    expect(sent.map(message => (message as { method: string }).method)).toEqual(['initialize', 'initialized', 'thread/start', 'model/list'])
    expect(adapter.capabilities.models).toEqual([{ id: 'synthetic-model', label: 'Synthetic model', effort: ['low'], defaultEffort: 'low', isDefault: true }])
    expect(adapter.capabilities.plans).toBe(false)
    expect(adapter.capabilities.runtimeVersion).toBe('0.153.4')
  })

  it('keeps real tool results and child activity while excluding root self-status noise', async () => {
    const { adapter, events } = create()
    await adapter.submit('synthetic:activity-groups', settings)
    await waitFor(() => completed(events))
    expect(events.filter(event => event.data.type === 'tool')).toHaveLength(9)
    expect(events.filter(event => event.data.type === 'subagent')).toHaveLength(8)
    expect(events.some(event => event.data.type === 'subagent' && event.data.name === '/root')).toBe(false)
    expect(events.some(event => event.data.type === 'tool' && event.data.status === 'failed' && event.data.exitCode === 2)).toBe(true)
    expect(events.filter(event => event.data.type === 'text' && event.data.role === 'assistant')).toHaveLength(2)
  })
  it('reports the model, effort and model provider Codex assigns to a spawned subagent thread', async () => {
    const { adapter, events } = create()
    await adapter.submit('synthetic:subagent-model', settings)
    await waitFor(() => completed(events))
    const subagents = events.filter(event => event.data.type === 'subagent').map(event => event.data)
    expect(subagents[0]).toMatchObject({ name: 'Codex agent', status: 'running', model: 'gpt-5-high', effort: 'high' })
    expect(subagents[1]).toMatchObject({ name: 'Researcher', status: 'running', model: 'gpt-5-high', effort: 'high', modelProvider: 'openai' })
  })

  it('decodes fragmented Unicode, preserves repeated chunks, correlates concurrent tools, and uses final snapshots', async () => {
    const { adapter, events } = create()
    await adapter.submit('synthetic:stream', settings)
    await waitFor(() => completed(events))
    const text = events.filter(event => event.itemId === 'message-1' && event.data.type === 'text').map(event => event.data)
    expect(text).toContainEqual({ type: 'text', role: 'assistant', text: 'café 🧪 ', mode: 'delta' })
    expect(text.filter(event => event.type === 'text' && event.text === 'again ')).toHaveLength(2)
    expect(text.at(-1)).toMatchObject({ text: 'café 🧪 again again ', mode: 'snapshot' })
    const commands = events.filter(event => event.data.type === 'tool')
    expect(commands.filter(event => event.itemId === 'command-1').at(-1)?.data).toMatchObject({ name: 'PowerShell', status: 'completed', output: 'one\none\n', outputMode: 'snapshot', exitCode: 0 })
    expect(commands.filter(event => event.itemId === 'command-2').at(-1)?.data).toMatchObject({ name: 'PowerShell', status: 'failed', exitCode: 2 })
    expect(events.some(event => event.native?.method === 'process/stderr')).toBe(true)
    expect(events.find(event => event.native?.method === 'synthetic/futureEvent')?.data).toMatchObject({ type: 'notice', payload: { payload: { inspectable: true } } })
    const applied = events.filter(event => event.itemId === 'edit-1' && event.data.type === 'changes').at(-1)
    expect(applied?.data).toMatchObject({ changes: [{ path: 'panel.mjs', status: 'applied', additions: 0, deletions: 2 }] })
    expect(events.find(event => event.native?.method === 'turn/diff/updated')?.data.type).toBe('notice')
  })

  it('uses real response IDs, rejects duplicate multi-view responses, and honors command decision lists', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:approval', settings)
    await waitFor(() => Boolean(pendingId(events)))
    const requestId = pendingId(events)!
    const pending = events.filter(event => event.data.type === 'interaction').at(-1)!.data
    expect(pending).toMatchObject({ interaction: { choices: [{ id: 'accept' }, { id: 'decline' }, { id: 'cancel' }] } })
    await expect(adapter.respond({ sessionId: 's', runtimeId: 'old-runtime', requestId, decision: 'accept' })).rejects.toThrow('stale runtime')
    await expect(adapter.respond({ sessionId: 's', runtimeId: 'runtime-1', requestId, decision: 'acceptForSession' })).rejects.toThrow('not offered')
    const response = { sessionId: 's', runtimeId: 'runtime-1', requestId, decision: 'accept' }
    await adapter.respond(response)
    await expect(adapter.respond(response)).rejects.toThrow('already answered')
    await waitFor(() => completed(events))
    expect(sent.filter(message => (message as { id: number }).id === 500)).toEqual([{ id: 500, result: { decision: 'accept' } }])
  })

  it.each(['decline', 'accept'] as const)('%s pending edits through the actual protocol and never executes the tool in the host', async decision => {
    const { adapter, events, cwd } = create()
    const file = path.join(cwd, 'panel.mjs')
    writeFileSync(file, baseline)
    await adapter.submit('synthetic:approval:edit', settings)
    await waitFor(() => Boolean(pendingId(events)))
    expect(readFileSync(file, 'utf8')).toBe(baseline)
    await adapter.respond({ sessionId: 's', runtimeId: 'runtime-1', requestId: pendingId(events)!, decision })
    await waitFor(() => completed(events))
    expect(readFileSync(file, 'utf8')).toBe(decision === 'accept' ? baseline.replace("  var wasOpen = el.classList.contains('is-open');\n  var wasPinned = pinned;\n", '') : baseline)
    expect(events.filter(event => event.data.type === 'changes').at(-1)?.data).toMatchObject({ changes: [{ status: decision === 'accept' ? 'applied' : 'rejected' }] })
  })

  it('formats structured question answers and rejects answers outside the offered options', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:question', settings)
    await waitFor(() => Boolean(pendingId(events)))
    const base = { sessionId: 's', runtimeId: 'runtime-1', requestId: pendingId(events)! }
    await expect(adapter.respond({ ...base, answers: { flavor: ['Chocolate'] } })).rejects.toThrow('offered')
    await adapter.respond({ ...base, answers: { flavor: ['Café'] } })
    await waitFor(() => completed(events))
    expect(sent).toContainEqual({ id: 501, result: { answers: { flavor: { answers: ['Café'] } } } })
  })

  it('waits for native interrupted completion and expires stale approval dialogs', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:approval', settings)
    await waitFor(() => Boolean(pendingId(events)))
    const requestId = pendingId(events)!
    await adapter.interrupt()
    expect(events.at(-1)?.data).not.toMatchObject({ phase: 'completed' })
    await waitFor(() => events.some(event => event.data.type === 'session' && event.data.phase === 'interrupted'))
    await expect(adapter.respond({ sessionId: 's', runtimeId: 'runtime-1', requestId, decision: 'accept' })).rejects.toThrow('expired')
    expect(sent.some(message => (message as { method?: string }).method === 'turn/interrupt')).toBe(true)
  })

  it('resumes the native thread without silently starting a turn or replaying user input', async () => {
    const { adapter, events, sent } = create({}, 'synthetic-thread-1')
    await adapter.start()
    expect(sent).toContainEqual({ id: 2, method: 'thread/resume', params: { threadId: 'synthetic-thread-1', cwd: expect.any(String), excludeTurns: true } })
    expect(sent.some(message => (message as { method?: string }).method === 'turn/start')).toBe(false)
    expect(events.some(event => event.data.type === 'text')).toBe(false)
  })

  it('translates permission, sandbox, model, effort and gated plan mode into actual turn parameters', async () => {
    const { adapter, events, sent } = create({ CONDUCTOR_CODEX_EXPERIMENTAL: '1' })
    await adapter.submit('synthetic:stream', { permission: 'read-only', plan: true, effort: 'low' })
    await waitFor(() => completed(events))
    const first = sent.find(message => (message as { method?: string }).method === 'turn/start')
    expect(first).toMatchObject({ params: { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false }, effort: 'low', model: 'synthetic-model', collaborationMode: { mode: 'plan', settings: { developer_instructions: null } } } })
    await adapter.submit('synthetic:stream', settings)
    const last = sent.filter(message => (message as { method?: string }).method === 'turn/start').at(-1)
    expect(last).toMatchObject({ params: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, collaborationMode: { mode: 'default' } } })
  })

  it('explicitly clears a native plan mode after resume into a fresh experimental adapter', async () => {
    const { adapter, sent } = create({ CONDUCTOR_CODEX_EXPERIMENTAL: '1' }, 'synthetic-thread-1')
    await adapter.start()
    expect(sent.some(message => (message as { method?: string }).method === 'turn/start')).toBe(false)
    await adapter.submit('synthetic:stream', settings)
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/start')).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ threadId: 'synthetic-thread-1', collaborationMode: { mode: 'default', settings: { model: 'synthetic-model', reasoning_effort: 'low', developer_instructions: null } } }) })
    ])
  })

  it('keeps sandbox scope independent of approval policy and exposes the native effective defaults', async () => {
    const { adapter, sent } = create()
    await adapter.start()
    expect(adapter.capabilities.effectiveSettings).toMatchObject({ model: 'synthetic-model', effort: 'low', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } })
    await adapter.submit('synthetic:stream', { ...settings, permission: 'read-only', sandbox: 'workspace-write', approvalPolicy: 'untrusted' })
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/start').at(-1)).toMatchObject({ params: { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite' } } })
  })

  it('publishes accepted settings when completion beats the turn acknowledgement without reviving the turn', async () => {
    const { adapter, events } = create({ CONDUCTOR_TEST_MODEL_CATALOG: '1', CONDUCTOR_TEST_TURN_ACK_DELAY: '1' })
    await adapter.start()
    const firstTurnEvent = events.length

    await adapter.submit('synthetic:context', { ...settings, model: 'plain-model', permission: 'read-only' })

    const sessions = events.slice(firstTurnEvent).flatMap(event => event.data.type === 'session' ? [event.data] : [])
    const completedIndex = sessions.findIndex(event => event.phase === 'completed')
    expect(completedIndex).toBeGreaterThanOrEqual(0)
    expect(sessions.slice(completedIndex + 1).some(event => event.phase === 'running')).toBe(false)
    expect(adapter.capabilities.effectiveSettings).toMatchObject({
      model: 'plain-model', effort: null, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly', networkAccess: false }
    })
    expect(sessions.at(-1)).toMatchObject({
      phase: 'completed',
      capabilities: { effectiveSettings: { model: 'plain-model', approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } } }
    })
  })

  it('reports disconnected execution and never retries a submitted turn', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:disconnect', settings)
    await waitFor(() => events.some(event => event.data.type === 'session' && event.data.phase === 'disconnected'))
    await expect(adapter.submit('synthetic:stream', settings)).rejects.toThrow('resume explicitly')
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/start')).toHaveLength(1)
  })

  it('forks native history and renames/archives without submitting inference or restoring files', async () => {
    const { adapter, sent } = create()
    await adapter.start()
    expect(await adapter.fork()).toBe('synthetic-fork-1')
    await adapter.rename('Useful conversation')
    await adapter.archive(true)
    await adapter.archive(false)
    expect(sent).toContainEqual({ id: 6, method: 'thread/unsubscribe', params: { threadId: 'synthetic-fork-1' } })
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/start')).toHaveLength(0)
    expect(sent).toContainEqual(expect.objectContaining({ method: 'thread/name/set', params: { threadId: 'synthetic-thread-1', name: 'Useful conversation' } }))
  })

  it('refuses native forks while a turn is waiting on an approval', async () => {
    const { adapter, events, sent } = create()
    await adapter.submit('synthetic:approval', settings)
    await waitFor(() => Boolean(pendingId(events)))
    await expect(adapter.fork()).rejects.toThrow('idle')
    expect(sent.some(message => (message as { method?: string }).method === 'thread/fork')).toBe(false)
  })

  it('discovers native local inventory on demand without tool execution or model turns', async () => {
    const { adapter, sent } = create()
    expect(await adapter.discover()).toMatchObject({ skills: { status: 'available' }, mcpServers: { status: 'available' }, plugins: { status: 'available' } })
    expect(sent.some(message => (message as { method?: string }).method === 'turn/start')).toBe(false)
    expect(sent.some(message => (message as { method?: string }).method === 'mcpServer/tool/call')).toBe(false)
    expect(sent).toContainEqual(expect.objectContaining({ method: 'plugin/list', params: { cwds: [expect.any(String)], marketplaceKinds: ['local'], forceRefetch: false } }))
  })

  it('refreshes the full account allowance buckets without submitting a model turn or changing the selected model', async () => {
    const { adapter, events, sent } = create()
    await adapter.refreshUsage()
    const usage = events.filter(event => event.data.type === 'usage' && event.itemId === 'account-rate-limits').at(-1)
    expect(usage?.data).toMatchObject({ type: 'usage', limits: { rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 12 } },
      'gpt-6-astra': { limitId: 'gpt-6-astra', primary: { usedPercent: 99 } },
      'gpt-5.6-sol': { limitId: 'gpt-5.6-sol', primary: { usedPercent: 20 } }
    } } })
    expect(sent).toContainEqual({ id: expect.any(Number), method: 'account/rateLimits/read' })
    expect(sent.some(message => (message as { method?: string }).method === 'turn/start')).toBe(false)
    expect(adapter.capabilities.effectiveSettings).toMatchObject({ model: 'synthetic-model' })
  })
})

describe('Codex deterministic mapping', () => {
  it('counts hunk deletions, handles CRLF and names with spaces, and does not count prose', () => {
    expect(codexDiffCounts('Removed 2 lines')).toBeUndefined()
    expect(codexDiffCounts('--- a/panel.mjs\r\n+++ b/panel.mjs\r\n@@ -1,3 +1,2 @@\r\n-a\r\n-b\r\n+café\r\n context\r\n')).toEqual({ additions: 1, deletions: 2 })
    expect(codexChanges([{ path: 'old path/árvíz.mjs', kind: { type: 'update', move_path: 'new path/árvíz.mjs' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }], 'applied')).toMatchObject([{ kind: 'rename', oldPath: 'old path/árvíz.mjs', path: 'new path/árvíz.mjs', additions: 1, deletions: 1 }])
  })
  it('uses native image input and preserves exact selected context without implicit repository attachments', () => {
    expect(codexInput('hello')).toEqual([{ type: 'text', text: 'hello', text_elements: [] }])
    expect(codexInput('hello', [{ id: 'a', kind: 'selection', name: 'panel', path: 'C:/A B/é.ts', startLine: 2, endLine: 4, content: '  exact\r\n' }, { id: 'b', kind: 'image', name: 'image', path: 'C:/A B/é.png' }])).toEqual([
      { type: 'text', text: 'hello', text_elements: [] },
      { type: 'text', text: '[Attached selection: C:/A B/é.ts:2-4]\n  exact\r\n', text_elements: [] },
      { type: 'localImage', path: 'C:/A B/é.png' }
    ])
  })

  it('keeps normal configuration inherited and generates bounded argument-array overrides only for explicit live mode', () => {
    expect(codexLaunchArguments({})).toEqual(['app-server', '--listen', 'stdio://'])
    const env = { CONDUCTOR_LIVE_TESTS: '1', CONDUCTOR_LIVE_MODEL_CODEX: 'approved-model', CONDUCTOR_LIVE_AUTH_CODEX: 'cli', CONDUCTOR_LIVE_OPTIONAL_MCP: '["chrome-devtools","node_repl"]' }
    const args = codexLaunchArguments(env)
    expect(args).toContain('mcp_servers.chrome-devtools.enabled=false')
    expect(args).toContain('mcp_servers.node_repl.enabled=false')
    expect(args).toContain('web_search="disabled"')
    expect(args).toContain('hooks')
    expect(() => codexLaunchArguments({ CONDUCTOR_LIVE_TESTS: '1' })).toThrow('explicit approved')
    expect(() => codexLaunchArguments({ ...env, CONDUCTOR_LIVE_OPTIONAL_MCP: '["unsafe\\nkey"]' })).toThrow('bounded list')
    expect(() => codexLaunchArguments({ ...env, CONDUCTOR_LIVE_OPTIONAL_MCP: '["server.with.dots"]' })).toThrow('without dots or quotes')
    expect(() => codexLaunchArguments({ ...env, CONDUCTOR_LIVE_OPTIONAL_MCP: JSON.stringify(['"quoted"']) })).toThrow('without dots or quotes')
  })

  it('refuses live isolation when optional integrations remain enabled or managed policy would be suppressed', () => {
    const config = {
      config: { features: Object.fromEntries(['hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'memories', 'unbounded_connection_retries'].map(key => [key, false])), web_search: 'disabled', notify: [], memories: { generate_memories: false, use_memories: false }, mcp_servers: { example: { enabled: false } } },
      layers: [], origins: {}
    } as unknown as ConfigReadResponse
    expect(() => validateCodexLiveConfiguration(config, { requirements: null })).not.toThrow()
    const enabled = structuredClone(config)
    ;(enabled.config.mcp_servers as Record<string, { enabled: boolean }>).example!.enabled = true
    expect(() => validateCodexLiveConfiguration(enabled, { requirements: null })).toThrow('enabled MCP')
    config.layers!.push({ name: { type: 'system', file: 'C:/managed.toml' }, config: { hooks: { SessionStart: [] } }, version: '1', disabledReason: null })
    expect(() => validateCodexLiveConfiguration(config, { requirements: null })).toThrow('managed integrations')
  })

  it('disables discovered optional skills through ephemeral thread config while preserving administrator skills', () => {
    const config = { config: { skills: { config: [{ path: 'C:/retained/SKILL.md', enabled: false }] } }, layers: [], origins: {} } as unknown as ConfigReadResponse
    const discovered = { data: [{ cwd: 'C:/fixture', errors: [], skills: [{ path: 'C:/optional/SKILL.md', scope: 'user', enabled: true }, { path: 'C:/managed/SKILL.md', scope: 'admin', enabled: true }] }] } as unknown as SkillsListResponse
    expect(codexLiveSkillOverrides(discovered, config)).toEqual({ 'skills.config': [{ path: 'C:/retained/SKILL.md', enabled: false }, { path: 'C:/optional/SKILL.md', enabled: false }] })
    expect(() => codexLiveSkillOverrides({ data: [] }, config)).toThrow('incomplete')
    discovered.data[0]!.skills[0]!.scope = 'unknown' as never
    expect(() => codexLiveSkillOverrides(discovered, config)).toThrow('Unknown skill scope')
  })
})

describe('model and empty-history regression contracts', () => {
  it('materializes empty history by saving its title before a CLI handoff', async () => {
    const { adapter } = create({ CONDUCTOR_TEST_EMPTY_HISTORY: '1' })
    await adapter.start()
    await expect(adapter.history()).rejects.toThrow('list_turns is not supported yet')
    await adapter.rename('Existing pane title')
    await expect(adapter.history()).resolves.toEqual([])
  })
  it('does not carry default reasoning effort into a model without effort', async () => {
    const { adapter, sent } = create({ CONDUCTOR_TEST_MODEL_CATALOG: '1' })
    await adapter.start()
    expect(adapter.capabilities.models.find(model => model.id === 'plain-model')?.effort).toEqual([])
    await adapter.submit('synthetic:stream', { ...settings, model: 'plain-model' })
    expect(sent.find(message => (message as { method?: string }).method === 'turn/start')).toMatchObject({ params: { model: 'plain-model', effort: null } })
  })
})


it('keeps latest context and response output separate from cumulative Codex totals across compaction', async () => {
  const { adapter, events } = create()
  await adapter.submit('synthetic:context', settings)
  await waitFor(() => completed(events))
  const usage = events.filter(event => event.data.type === 'usage' && event.data.scope === 'session').map(event => event.data)
  expect(usage).toHaveLength(3)
  for (const [index, used] of [140000, 190000, 24000].entries()) expect(usage[index]).toMatchObject({ totalTokens: 9004000, outputTokens: 4000, limits: { contextUsedTokens: used, contextCapacityTokens: 200000, workingOutputTokens: 42 } })
})


describe('Codex mid-turn steering (synthetic, zero inference)', () => {
  it('dispatches to the active turn immediately with native image input and no new turn', async () => {
    const { adapter, sent, events } = create()
    await adapter.submit('synthetic:steer', settings)
    expect(adapter.capabilities.steering).toBe(true)
    await adapter.steer('More data', settings, [{ id: 'image', kind: 'image', name: 'context.png', path: 'context.png' }])
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/steer')).toEqual([{ id: expect.any(Number), method: 'turn/steer', params: { threadId: 'synthetic-thread-1', clientUserMessageId: expect.any(String), expectedTurnId: 'synthetic-turn-1', input: codexInput('More data', [{ id: 'image', kind: 'image', name: 'context.png', path: 'context.png' }]) } }])
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/start')).toHaveLength(1)
    expect(completed(events)).toBe(false)
    expect(adapter.capabilities.steering).toBe(true)
    await adapter.interrupt()
    expect(adapter.capabilities.steering).toBe(false)
  })

  it('rejects an idle or disposed runtime without sending input', async () => {
    const { adapter, sent } = create()
    await adapter.start()
    expect(adapter.capabilities.steering).toBe(false)
    await expect(adapter.steer('Keep my text', settings)).rejects.toThrow('no active Codex turn')
    adapter.dispose()
    await expect(adapter.steer('Keep my text', settings)).rejects.toThrow('disconnected')
    expect(sent.some(message => (message as { method?: string }).method === 'turn/steer')).toBe(false)
  })

  it('rejects steering until turn/start is acknowledged even after turn/started', async () => {
    const { adapter, sent, events } = create({ CONDUCTOR_TEST_TURN_ACK_DELAY: '1' })
    const starting = adapter.submit('synthetic:steer', settings)
    await waitFor(() => events.some(event => event.data.type === 'session' && event.data.phase === 'running'))
    expect(adapter.capabilities.steering).toBe(false)
    await expect(adapter.steer('Keep my text', settings)).rejects.toThrow('not yet addressable')
    expect(sent.some(message => (message as { method?: string }).method === 'turn/steer')).toBe(false)
    await starting
    expect(adapter.capabilities.steering).toBe(true)
    expect(events.at(-1)?.data).toMatchObject({ capabilities: { steering: true } })
  })

  it('surfaces a stale expectedTurnId as a definite refusal without disconnecting', async () => {
    const { adapter, events } = create({ CONDUCTOR_TEST_STEER: 'stale' })
    await adapter.submit('synthetic:steer', settings)
    await expect(adapter.steer('Keep my text', settings)).rejects.toThrow(SteeringUnavailableError)
    expect(events.some(event => event.data.type === 'session' && event.data.phase === 'disconnected')).toBe(false)
  })

  it.each(['review', 'compact'])('disables steering for native %s turns before dispatch', async kind => {
    const { adapter, sent } = create()
    await adapter.submit('synthetic:steer-' + kind, settings)
    await waitFor(() => !adapter.capabilities.steering)
    await expect(adapter.steer('Keep my text', settings)).rejects.toThrow('cannot be steered')
    expect(sent.some(message => (message as { method?: string }).method === 'turn/steer')).toBe(false)
  })

  it.each(['review', 'compact'])('learns an unreported %s turn kind from its refusal', async kind => {
    const { adapter, sent } = create({ CONDUCTOR_TEST_STEER: kind })
    await adapter.submit('synthetic:steer', settings)
    await expect(adapter.steer('Keep my text', settings)).rejects.toThrow(SteeringUnavailableError)
    expect(adapter.capabilities.steering).toBe(false)
    await expect(adapter.steer('More text', settings)).rejects.toThrow('cannot be steered')
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/steer')).toHaveLength(1)
  })

  it.each(['timeout', 'malformed', 'disconnect'])('never authorizes a retry after a %s acknowledgement', async behavior => {
    const { adapter, sent, events } = create({ CONDUCTOR_TEST_STEER: behavior }, undefined, 500)
    await adapter.submit('synthetic:steer', settings)
    const error: unknown = await adapter.steer('Keep my text', settings).catch(reason => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(SteeringUnavailableError)
    expect(adapter.capabilities.steering).toBe(false)
    expect(events.at(-1)?.data).toMatchObject({ phase: 'disconnected' })
    expect(sent.filter(message => (message as { method?: string }).method === 'turn/steer')).toHaveLength(1)
  })
})


describe('native steering delivery receipts', () => {
  it('distinguishes acceptance from consumption while the original turn keeps working', async () => {
    const { adapter, events } = create({ CONDUCTOR_TEST_STEER: 'delayed' })
    await adapter.submit('synthetic:steer', settings)
    await adapter.steer('More data', settings, [], 'client-input')
    expect(events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'client-input', status: 'accepted' }])
    await waitFor(() => events.some(event => event.data.type === 'input_delivery' && event.data.status === 'delivered'))
    expect(completed(events)).toBe(false)
    await adapter.interrupt()
    await waitFor(() => events.some(event => event.data.type === 'session' && event.data.phase === 'interrupted'))
    expect(events.some(event => event.data.type === 'input_delivery' && event.data.status === 'cancelled')).toBe(false)
  })
  it('only confirms unconsumed input cancellation after native interrupted completion', async () => {
    const { adapter, events } = create({ CONDUCTOR_TEST_STEER: 'pending' })
    await adapter.submit('synthetic:steer', settings)
    await adapter.steer('More data', settings, [], 'client-pending')
    await adapter.interrupt()
    expect(events.some(event => event.data.type === 'input_delivery' && event.data.status === 'cancelled')).toBe(false)
    await waitFor(() => events.some(event => event.data.type === 'session' && event.data.phase === 'interrupted'))
    expect(events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'client-pending', status: 'accepted' }, { type: 'input_delivery', inputId: 'client-pending', status: 'cancelled' }])
  })
})
