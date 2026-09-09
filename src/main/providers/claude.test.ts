import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEvent, AgentEvent, Json, SessionSettings } from '../../shared/structured-agent'
import { replayAgentEvents } from '../../shared/structured-agent-reducer'
import { ClaudeAdapter, CLAUDE_COMPATIBILITY, claudeCompatibility } from './claude'
import { JsonLineDecoder, JsonLineTransport, type TransportOptions } from './transport'
import { SteeringUnavailableError, type AdapterOptions } from './adapter'
import { resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

const settings: SessionSettings = { permission: 'default', plan: false }
const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }
class FakeTransport {
  connected = false
  autoControlResponses = true
  sent: Json[] = []
  constructor(readonly options: TransportOptions, private autoInitialize = true) {}
  start(): void { this.connected = true }
  close(): void { this.connected = false }
  send(value: Json): void {
    if (!this.connected) throw new Error('Disconnected')
    this.sent.push(value)
    const message = value as { type?: string; request_id?: string; request?: { subtype?: string } }
    if (this.autoControlResponses && message.type === 'control_request' && (message.request?.subtype !== 'initialize' || this.autoInitialize)) queueMicrotask(() => this.receive({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id!, response: { models: [{ value: 'fixture-model', displayName: 'Synthetic model' }] } } }))
  }
  receive(value: Json): void { this.options.onMessage(value) }
}
const adapters: ClaudeAdapter[] = []
const imageRoots: string[] = []
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); for (const root of imageRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
function fixture(overrides: Partial<AdapterOptions> = {}, autoInitialize = true, runtimeVersion = '2.1.263') {
  const events: AdapterEvent[] = []
  let transport!: FakeTransport
  const adapter = new ClaudeAdapter({ executable: 'synthetic-claude', cwd: process.cwd(), runtimeId: 'incarnation-A', settings, emit: (event) => events.push(event), ...overrides }, {
    version: async () => runtimeVersion, createTransport: (options) => transport = new FakeTransport(options, autoInitialize)
  })
  adapters.push(adapter)
  return { adapter, events, get transport() { return transport }, projection: () => replayAgentEvents('session', events.map((event, i): AgentEvent => ({ schemaVersion: 1, id: `event-${i}`, sequence: i + 1, sessionId: 'session', runtimeId: 'incarnation-A', provider: 'claude', projectId: 'project', workspaceId: 'workspace', cwd: process.cwd(), timestamp: '2026-09-07T00:00:00.000Z', ...event }))) }
}
function toolUse(id: string, name: string, input: Json, parent: string | null = null): Json {
  return { type: 'assistant', uuid: `msg-${id}`, parent_tool_use_id: parent, message: { id: `native-${id}`, content: [{ type: 'tool_use', id, name, input }] } }
}
function permission(id: string, toolId: string, name: string, input: Json): Json {
  return { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_use_id: toolId, tool_name: name, input } }
}
function hook(requestId: string, callback: string, toolId: string, name: string, input: Json, response?: Json): Json {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'hook_callback', callback_id: callback, tool_use_id: toolId, input: { tool_use_id: toolId, tool_name: name, tool_input: input, ...(response !== undefined ? { tool_response: response } : {}) } } }
}

describe('Claude CLI bridge — synthetic raw protocol, zero inference', () => {
  it('connects to patch and minor releases at or above the baseline, recording the unverified gap', async () => {
    expect(claudeCompatibility(CLAUDE_COMPATIBILITY)).toEqual({ supported: true, verified: true })
    expect(claudeCompatibility('2.1.265')).toEqual({ supported: true, verified: false })
    expect(claudeCompatibility('2.2.0')).toEqual({ supported: true, verified: false })
    const f = fixture({}, true, '2.1.265')
    await f.adapter.start()
    expect(f.adapter.capabilities.runtimeVersion).toBe('2.1.265')
    expect(f.adapter.capabilities.limitations.some(limitation => limitation.includes('2.1.265') && limitation.includes('fixture-verified'))).toBe(true)
  })

  it('refuses a CLI below the baseline, a different major, and an unreadable version', async () => {
    expect(claudeCompatibility('2.1.262').supported).toBe(false)
    expect(claudeCompatibility('2.0.999').supported).toBe(false)
    expect(claudeCompatibility('3.0.0').supported).toBe(false)
    expect(claudeCompatibility('unknown').supported).toBe(false)
    await expect(fixture({}, true, '2.1.262').adapter.start()).rejects.toThrow('below the tested 2.1.263 bridge baseline')
  })

  it('awaits initialize and keeps user configuration/native coding prompt and resume identity', async () => {
    const f = fixture({ nativeSessionId: 'native-session' }, false)
    const starting = f.adapter.start()
    await flush()
    expect(f.transport.sent).toHaveLength(1)
    await expect(f.adapter.submit('Too early', settings)).rejects.toThrow('disconnected')
    const first = f.transport.sent[0] as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: first.request_id, response: {} } })
    await starting
    expect(f.transport.options.args).toContain('--resume')
    expect(f.transport.options.args).toContain('native-session')
    expect(f.transport.options.args).toContain('--permission-prompt-tool')
    expect(f.transport.options.args).not.toContain('--system-prompt')
    expect(f.transport.options.args).not.toContain('--bare')
    expect(f.transport.options.args).not.toContain('--setting-sources')
    await f.adapter.submit('Follow up', settings)
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', session_id: 'native-session', message: { content: 'Follow up' } })
  })

  it('reconciles by message identity, preserves repeated chunks, and never calls input completion execution', async () => {
    const f = fixture()
    await f.adapter.start()
    await f.adapter.submit('Synthetic prompt', settings)
    let seq = 0
    const stream = (event: Json) => f.transport.receive({ type: 'stream_event', uuid: `chunk-${seq++}`, session_id: 'native-1', event })
    stream({ type: 'message_start', message: { id: 'message-1' } })
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ha' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ha' } })
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'shell-1', name: 'PowerShell', input: {} } })
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } })
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Write-Output hé"}' } })
    expect(f.projection().items.find((item) => item.nativeItemId === 'shell-1')?.data).toMatchObject({ inputDelta: '{"command":"Write-Output hé"}', status: 'preparing' })
    stream({ type: 'content_block_stop', index: 1 })
    f.transport.receive({ type: 'assistant', uuid: 'completed-message', session_id: 'native-1', message: { id: 'message-1', content: [{ type: 'text', text: 'haha' }, { type: 'tool_use', id: 'shell-1', name: 'PowerShell', input: { command: 'Write-Output hé' } }] } })
    const projection = f.projection()
    expect(projection.items.filter((item) => item.data.type === 'text')).toHaveLength(1)
    expect(projection.items.find((item) => item.data.type === 'text')?.data).toMatchObject({ text: 'haha' })
    expect(projection.items.find((item) => item.data.type === 'tool')?.data).toMatchObject({ status: 'preparing', name: 'PowerShell', input: { command: 'Write-Output hé' } })
    f.transport.receive({ type: 'tool_progress', tool_use_id: 'shell-1', tool_name: 'PowerShell', elapsed_time_seconds: 1 })
    expect(f.projection().items.find((item) => item.data.type === 'tool')?.data).toMatchObject({ status: 'running' })
  })

  it('keeps interleaved tools and nested native parents correlated; nonzero exit is failure', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive(toolUse('one', 'Bash', { command: 'node test.mjs' }))
    f.transport.receive(toolUse('two', 'Read', { file_path: '日本語 file.mjs' }, 'agent-tool'))
    f.transport.receive({ type: 'user', uuid: 'result-two', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'two', content: 'file data' }] } })
    f.transport.receive({ type: 'user', uuid: 'result-one', tool_use_result: { stdout: 'actual failure', stderr: 'stderr', exitCode: 2 }, message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: 'actual failure' }] } })
    expect(f.projection().items.find((item) => item.nativeItemId === 'two')).toMatchObject({ parentId: 'agent-tool', data: { name: 'Read', output: 'file data', status: 'completed' } })
    expect(f.projection().items.find((item) => item.nativeItemId === 'one')?.data).toMatchObject({ name: 'Bash', output: 'actual failure', stderr: 'stderr', exitCode: 2, status: 'failed' })
  })

  it('captures auto-approved edit only at genuine pre/post hooks and waits before acknowledging', async () => {
    let release!: () => void
    const beforeTool = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const afterTool = vi.fn(async () => undefined)
    const f = fixture({ beforeTool, afterTool })
    await f.adapter.start()
    const input = { file_path: 'panel.mjs', old_string: 'one\ntwo\n', new_string: '' }
    f.transport.receive(toolUse('edit', 'Edit', input))
    expect(beforeTool).not.toHaveBeenCalled()
    f.transport.receive(hook('pre', 'conductor_before', 'edit', 'Edit', input))
    expect(beforeTool).toHaveBeenCalledWith('edit', ['panel.mjs'])
    expect(f.transport.sent).not.toContainEqual(expect.objectContaining({ type: 'control_response' }))
    release(); await flush()
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'pre', response: {} } })
    f.transport.receive(hook('post', 'conductor_after', 'edit', 'Edit', input, {}))
    await flush()
    expect(afterTool).toHaveBeenCalledWith('edit', ['panel.mjs'], true)
    expect(f.projection().items.find((item) => item.nativeItemId === 'edit')?.data).toMatchObject({ status: 'completed' })
    expect(f.events.some((event) => event.data.type === 'interaction')).toBe(false)
  })

  it('resolves exact approvals once across views, rejects old runtime and sends real deny/abort messages', async () => {
    const beforeTool = vi.fn(async () => undefined)
    const f = fixture({ beforeTool })
    await f.adapter.start()
    const input = { file_path: 'file.txt', content: 'new' }
    f.transport.receive(permission('approval-1', 'write-1', 'Write', input))
    expect(beforeTool).not.toHaveBeenCalled()
    await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'old', requestId: 'approval-1', decision: 'allow' })).rejects.toThrow('expired')
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval-1', decision: 'deny' })
    await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval-1', decision: 'allow' })).rejects.toThrow('stale')
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'approval-1', response: { behavior: 'deny', interrupt: false, toolUseID: 'write-1' } } })
    f.transport.receive(permission('approval-2', 'write-2', 'Write', input))
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval-2', decision: 'abort' })
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'deny', interrupt: true } } })
  })

  it('uses question text keys and preserves the real input when returning multiple answers', async () => {
    const f = fixture()
    await f.adapter.start()
    const input = { questions: [{ question: 'Which systems?', header: 'Systems', options: [{ label: 'Windows' }, { label: 'Linux' }], multiSelect: true }] }
    f.transport.receive(permission('ask', 'question-tool', 'AskUserQuestion', input))
    expect(f.projection().phase).toBe('waiting_input')
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'ask', answers: { 'question:0': ['Windows', 'Linux'] } })
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_response', response: { request_id: 'ask', response: { behavior: 'allow', updatedInput: { ...input, answers: { 'Which systems?': ['Windows', 'Linux'] } } } } })
  })

  it('records the chosen answers on the resolved interaction so history can read them back', async () => {
    const f = fixture()
    await f.adapter.start()
    const input = { questions: [{ question: 'Which label?', header: 'Label', options: [{ label: 'Ice Berry' }, { label: 'Sun Berry' }] }] }
    f.transport.receive(permission('ask', 'question-tool', 'AskUserQuestion', input))
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'ask', answers: { 'question:0': ['Ice Berry'] } })
    const resolved = f.events.filter(event => event.data.type === 'interaction').map(event => event.data).at(-1)
    expect(resolved).toMatchObject({ interaction: { status: 'resolved', answers: { 'Which label?': 'Ice Berry' } } })
  })

  it('expires cancelled requests, interrupts through control protocol, and does not turn ACK into completion', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(permission('approval', 'tool', 'Bash', { command: 'node --version' }))
    f.transport.receive({ type: 'control_cancel_request', request_id: 'approval' })
    await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'approval', decision: 'allow' })).rejects.toThrow('stale')
    await f.adapter.interrupt()
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt', cancel_queued: true } })
    expect(f.projection().phase).toBe('interrupting')
    f.transport.receive({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', usage: {} })
    expect(f.projection().phase).toBe('interrupted')
  })

  it('applies model and planning settings through acknowledged control requests and rejects unsupported controls', async () => {
    const f = fixture()
    await f.adapter.start()
    await f.adapter.submit('Plan', { ...settings, model: 'fixture-model', plan: true })
    expect(f.transport.sent.slice(-3)).toEqual([
      expect.objectContaining({ request: { subtype: 'set_model', model: 'fixture-model' } }),
      expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'plan' } }),
      expect.objectContaining({ type: 'user' })
    ])
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    await expect(f.adapter.submit('readonly', { ...settings, permission: 'read-only' })).rejects.toThrow('no Conductor read-only sandbox')
    await f.adapter.submit('effort', { ...settings, effort: 'high' })
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } }))
  })

  it('keeps unknown payloads inspectable and missing usage unknown; disconnect does not resend', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'future_provider_event', payload: { test: 'SYNTHETIC' } })
    expect(f.projection().items.some((item) => item.data.type === 'notice' && item.data.message.includes('future_provider_event'))).toBe(true)
    const sent = f.transport.sent.length
    f.transport.options.onExit?.(1, null)
    expect(f.projection().phase).toBe('disconnected')
    await expect(f.adapter.submit('Retry', settings)).rejects.toThrow('disconnected')
    expect(f.transport.sent).toHaveLength(sent)
  })

  it('decodes fragmented JSON and split Unicode all the way into an adapter projection', async () => {
    const f = fixture()
    await f.adapter.start()
    const errors: Error[] = []
    const decoder = new JsonLineDecoder((message) => f.transport.receive(message), (error) => errors.push(error))
    const frame = Buffer.from(JSON.stringify({ type: 'assistant', uuid: 'unicode-msg', message: { id: 'unicode', content: [{ type: 'text', text: 'Árvíz 日本語 😀' }] } }) + '\r\n')
    for (const byte of frame) decoder.push(Buffer.from([byte]))
    expect(errors).toEqual([])
    expect(f.projection().items.find((item) => item.nativeItemId === 'unicode:text:0')?.data).toMatchObject({ text: 'Árvíz 日本語 😀' })
  })

  it('drives an actual fake process through handshake, approval, hook and result round trips', async () => {
    const events: AdapterEvent[] = []
    const adapter = new ClaudeAdapter({ executable: process.execPath, cwd: process.cwd(), runtimeId: 'fake-process-runtime', settings, emit: (event) => events.push(event) }, {
      version: async () => '2.1.263', createTransport: (options) => new JsonLineTransport({ ...options, args: [resolve('scripts/fixtures/claude-runtime.mjs')] })
    })
    adapters.push(adapter)
    await adapter.start()
    await adapter.submit('SYNTHETIC_PROCESS_CONTRACT', settings)
    await vi.waitFor(() => expect(events.some((event) => event.data.type === 'interaction' && event.requestId === 'fake-approval')).toBe(true))
    await adapter.respond({ sessionId: 'session', runtimeId: 'fake-process-runtime', requestId: 'fake-approval', decision: 'allow' })
    await vi.waitFor(() => expect(events.some((event) => event.data.type === 'session' && event.data.phase === 'completed')).toBe(true))
    expect(events.some((event) => event.data.type === 'tool' && event.itemId === 'fake-shell' && event.data.output === 'SYNTHETIC OUTPUT 😀' && event.data.status === 'completed')).toBe(true)
    expect(events.some((event) => event.data.type === 'error')).toBe(false)
  })

  it('accounts runtime-cumulative estimated costs as deltas and keeps per-turn tokens authoritative', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'result', uuid: 'cost-1', subtype: 'success', total_cost_usd: 0.10, usage: { input_tokens: 10, output_tokens: 2 } })
    f.transport.receive({ type: 'result', uuid: 'cost-2', subtype: 'success', total_cost_usd: 0.15, usage: { input_tokens: 20, output_tokens: 3 } })
    f.transport.receive({ type: 'result', uuid: 'cost-3', subtype: 'success', usage: {} })
    const costs = f.events.flatMap((event) => event.data.type === 'usage' && event.data.costUsd !== undefined ? [event.data] : [])
    expect(costs).toHaveLength(2)
    expect(costs[0]).toMatchObject({ costUsd: 0.10, source: 'estimate' })
    expect(costs[1]!.costUsd).toBeCloseTo(0.05)
    expect(costs.reduce((sum, cost) => sum + cost.costUsd!, 0)).toBeCloseTo(0.15)
    expect(f.events.some((event) => event.data.type === 'usage' && event.data.source === 'provider' && event.data.inputTokens === 20 && event.data.costUsd === undefined)).toBe(true)
    const sent = f.transport.sent.length
    await expect(f.adapter.submit('/clear', settings)).rejects.toThrow('new Conductor session')
    expect(f.transport.sent).toHaveLength(sent)
  })

  it('returns discovered configuration metadata without making another runtime request', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'init', session_id: 'native', tools: ['Bash', 'Edit'], mcp_servers: [] })
    const sent = f.transport.sent.length
    expect(await f.adapter.discover()).toMatchObject({ connection: 'local-cli', runtimeVersion: '2.1.263', configuration: { tools: ['Bash', 'Edit'], mcp_servers: [] } })
    expect(f.transport.sent).toHaveLength(sent)
  })

  it.each([
    ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])],
    ['image/jpeg', Buffer.from([255, 216, 255, 224, 0, 16])],
    ['image/gif', Buffer.from('GIF89aSYNTHETIC')],
    ['image/webp', Buffer.from('RIFF0000WEBPSYNTHETIC')]
  ])('encodes explicitly selected %s fixture bytes into native image blocks without altering prompt text', async (mediaType, fixtureBytes) => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-image-contract-')); imageRoots.push(root)
    // Synthetic file headers test wire routing, not live-provider image interpretation.
    const bytes = fixtureBytes as Buffer
    writeFileSync(join(root, 'selected misleading extension.txt'), bytes)
    const f = fixture({ cwd: root })
    await f.adapter.start()
    await f.adapter.submit('Original user text', settings, [{ id: 'selected', kind: 'image', name: 'Selected fixture', path: 'selected misleading extension.txt' }])
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', message: { content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } },
      { type: 'text', text: 'Original user text' }
    ] } })
  })

  it('rejects invalid, oversized, traversing and junction image sources before any user message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-image-boundary-')); imageRoots.push(root)
    const cwd = join(root, 'workspace'); mkdirSync(cwd)
    writeFileSync(join(cwd, 'invalid.png'), 'not an image')
    writeFileSync(join(cwd, 'oversized.png'), Buffer.alloc(3 * 1024 * 1024 + 1))
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    symlinkSync(outside, join(cwd, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
    const f = fixture({ cwd }); await f.adapter.start()
    const sent = f.transport.sent.length
    for (const [path, expected] of [['invalid.png', 'PNG, JPEG'], ['oversized.png', '3 MiB'], ['../outside/private.png', 'outside'], ['junction/private.png', 'junction']]) {
      await expect(f.adapter.submit('Never sent', settings, [{ id: 'image', kind: 'image', name: 'Invalid fixture', path }])).rejects.toThrow(expected)
    }
    expect(f.transport.sent).toHaveLength(sent)
  })

  it('bounds the combined encoded image message before dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-image-limit-')); imageRoots.push(root)
    const bytes = Buffer.alloc(2 * 1024 * 1024, 65)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
    writeFileSync(join(root, 'large.png'), bytes)
    const f = fixture({ cwd: root }); await f.adapter.start()
    const sent = f.transport.sent.length
    await expect(f.adapter.submit('Never sent', settings, [
      { id: 'one', kind: 'image', name: 'One synthetic image', path: 'large.png' },
      { id: 'two', kind: 'image', name: 'Two synthetic images', path: 'large.png' }
    ])).rejects.toThrow('4 MiB combined')
    expect(f.transport.sent).toHaveLength(sent)
  })
})

it('preserves model-specific effort capability metadata from Claude initialization', async () => {
  const f = fixture({}, false)
  const starting = f.adapter.start()
  await flush()
  const first = f.transport.sent[0] as { request_id: string }
  f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: first.request_id, response: { models: [
    { value: 'reasoner', displayName: 'Reasoner', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'plain', displayName: 'Plain', supportsEffort: false },
    { value: 'unknown', displayName: 'Unknown' }
  ] } } })
  await starting
  expect(f.adapter.capabilities.models).toEqual([
    { id: 'reasoner', label: 'Reasoner', effort: ['low', 'high'] },
    { id: 'plain', label: 'Plain', effort: [] },
    { id: 'unknown', label: 'Unknown', effort: [] }
  ])
})


describe('Claude conversation reliability', () => {
  it('reconciles late native identity and ignores late deltas and result echoes', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'late-id' } } })
    f.transport.receive({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Once' } } })
    f.transport.receive({ type: 'assistant', session_id: 'native-late', uuid: 'final-message', message: { id: 'late-id', content: [{ type: 'text', text: 'Once only' }] } })
    f.transport.receive({ type: 'stream_event', session_id: 'native-late', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' only' } } })
    f.transport.receive({ type: 'result', subtype: 'success', result: 'Once only', usage: {} })
    const texts = f.projection().items.filter(item => item.data.type === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]?.data).toMatchObject({ text: 'Once only' })
  })
  it('uses Auto/Edit/Manual and keeps permission grants scoped to this session', async () => {
    const f = fixture({ settings: { ...settings, permission: 'auto' } })
    await f.adapter.start()
    expect(f.transport.options.args).toContain('auto')
    await f.adapter.submit('Edit', { ...settings, permission: 'accept-edits' })
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }))
    const request: Json = { type: 'control_request', request_id: 'grant', request: { subtype: 'can_use_tool', tool_use_id: 'shell', tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] } }
    f.transport.receive(request)
    await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'grant', decision: 'allow-session' })
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'allow', updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] } } })
    const reply = f.transport.sent.at(-1)
    f.transport.receive(request)
    expect(f.transport.sent.at(-1)).toEqual(reply)
    expect(f.projection().items.filter(item => item.data.type === 'interaction' && item.data.interaction.status === 'pending')).toHaveLength(0)
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    await f.adapter.submit('Manual', { ...settings, effort: 'high' })
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } }))
    f.transport.receive(request)
    expect(f.transport.sent.at(-1)).toEqual(reply)
    expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'manual' } }))
  })
  it('reports live message usage with cache inputs and authoritative turn usage', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'usage-msg', model: 'actual-runtime-model', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 } } } })
    f.transport.receive({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 12 } } })
    const live = f.projection().items.filter(item => item.data.type === 'usage' && item.data.scope === 'message')
    expect(live).toHaveLength(1)
    expect(live[0]?.data).toMatchObject({ scope: 'message', inputTokens: 35, cachedTokens: 20, cacheCreationTokens: 5, outputTokens: 12, totalTokens: 47 })
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ model: 'actual-runtime-model' })
    f.transport.receive({ type: 'result', subtype: 'success', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 15 } })
    expect(f.projection().items.some(item => item.data.type === 'usage' && item.data.scope === 'turn' && item.data.totalTokens === 50)).toBe(true)
  })
  it('normalizes reported account allowance windows and records the first level of a run separately', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    // Claude's own wire shape: fractional utilization keyed by window, epoch-second resetsAt.
    f.transport.receive({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0.24, resetsAt: 1789416000 },
      seven_day: { utilization: 0.1 },
      model_scoped: { utilization: null }
    } } })
    const first = f.projection().items.find(item => item.nativeItemId === 'usage:account-rate-limits:first')
    const rolling = () => f.projection().items.find(item => item.nativeItemId === 'usage:account-rate-limits')
    // Rescaled to the same 0-100 shape Codex reports, with Claude's fixed window durations.
    expect(first?.data).toMatchObject({ type: 'usage', source: 'provider', limits: { rateLimits: {
      five_hour: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1789416000 },
      seven_day: { usedPercent: 10, windowDurationMins: 10080 }
    } } })
    // An unreported utilization is dropped, never recorded as zero usage.
    expect(JSON.stringify(first?.data)).not.toContain('model_scoped')

    f.transport.receive({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.62 } } } })
    // The rolling item moves; the first-observed level is retained so a share can be sourced.
    expect(rolling()?.data).toMatchObject({ limits: { rateLimits: { seven_day: { usedPercent: 62 } } } })
    expect(first?.data).toMatchObject({ limits: { rateLimits: { seven_day: { usedPercent: 10 } } } })

    // A report with nothing measurable in it is not recorded at all.
    const before = f.projection().items.length
    f.transport.receive({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: null } } } })
    expect(f.projection().items).toHaveLength(before)
  })
  it('preserves an ordinary final bracket after withholding an incomplete diagnostic prefix', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'assistant', message: { id: 'bracket', content: [{ type: 'text', text: '[' }] } })
    expect(f.projection().items.find(item => item.data.type === 'text')?.data).toMatchObject({ text: '[' })
  })
  it('keeps internal stop diagnostics out of streamed text and interrupted errors', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'stopped' } } })
    f.transport.receive({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    for (const text of ['[ede_', 'diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use']) f.transport.receive({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
    await f.adapter.interrupt()
    f.transport.receive({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'], usage: {} })
    expect(f.projection().phase).toBe('interrupted')
    expect(f.projection().items.filter(item => item.data.type === 'error')).toHaveLength(0)
    expect(f.projection().items.filter(item => item.data.type === 'text')).toEqual([])
  })
})


it('reports the model from complete assistant messages without letting child models replace it', async () => {
  const f = fixture()
  await f.adapter.start()
  f.transport.receive({ type: 'assistant', message: { id: 'main-model', model: 'claude-main', content: [] } })
  expect(f.projection().capabilities?.effectiveSettings).toMatchObject({ model: 'claude-main' })
  f.transport.receive({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'child-model', model: 'claude-child', content: [] } })
  expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ model: 'claude-main' })
})


it('matches VS Code context accounting, reserves output and compaction space, and resets after compact', async () => {
  const f = fixture()
  await f.adapter.start()
  f.transport.receive({ type: 'assistant', message: { id: 'context-message', model: 'claude-main', usage: { input_tokens: 1000, cache_read_input_tokens: 120000, cache_creation_input_tokens: 2000, output_tokens: 300 }, content: [] } })
  f.transport.receive({ type: 'result', subtype: 'success', modelUsage: { 'claude-main': { contextWindow: 200000, maxOutputTokens: 32000 } }, usage: { input_tokens: 900000, output_tokens: 9000 } })
  const latest = () => f.events.filter(event => event.itemId === 'usage:context').at(-1)?.data
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 123300, contextCapacityTokens: 155000, modelContextWindow: 200000 } })
  f.transport.receive({ type: 'assistant', parent_tool_use_id: 'child', message: { id: 'child-context', model: 'claude-child', usage: { input_tokens: 190000, output_tokens: 500 }, content: [] } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 123300 } })
  f.transport.receive({ type: 'system', subtype: 'compact_boundary' })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: null } })
  f.transport.receive({ type: 'assistant', message: { id: 'new-context', model: 'claude-main', usage: { input_tokens: 2000, output_tokens: 30 }, content: [] } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 2030, contextCapacityTokens: 155000 } })
  f.transport.receive({ type: 'assistant', message: { id: 'new-model', model: 'claude-other', usage: { input_tokens: 1000, output_tokens: 20 }, content: [] } })
  expect(latest()).toMatchObject({ limits: { contextUsedTokens: 1020, contextCapacityTokens: null } })
})


describe('Claude mid-turn steering (synthetic, zero inference)', () => {
  it('writes another user message immediately without resetting turn identity, pending tools, or settings', async () => {
    const f = fixture({ nativeSessionId: 'native-steering' })
    await f.adapter.start(); await f.adapter.submit('Original prompt', settings)
    f.transport.receive(toolUse('still-running', 'Read', { path: 'context.txt' }))
    const turnId = f.events.at(-1)?.turnId
    const count = f.transport.sent.length
    await f.adapter.steer('More data', { ...settings, effort: 'low' }, [{ id: 'selection', kind: 'selection', name: 'Selected lines', content: 'Exact context' }])
    expect(f.transport.sent).toHaveLength(count + 1)
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', session_id: 'native-steering', uuid: expect.any(String), message: { role: 'user', content: expect.stringContaining('More data') } })
    expect(f.transport.sent.at(-1)).toMatchObject({ message: { content: expect.stringContaining('Exact context') } })
    expect((f.transport.sent.at(-1) as { uuid: string }).uuid).not.toBe(turnId)
    expect(f.projection().phase).toBe('running')
    expect(f.adapter.capabilities.steering).toBe(true)
    f.transport.receive(toolUse('after-steer', 'Read', {}))
    expect(f.events.at(-1)?.turnId).toBe(turnId)
    expect(f.projection().items.find(item => item.nativeItemId === 'still-running')).toBeDefined()
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ effort: null })
  })

  it.each(['idle', 'completed', 'disconnected', 'disposed', 'interrupting'])('refuses a %s runtime before writing input', async state => {
    const f = fixture()
    await f.adapter.start()
    if (state !== 'idle') await f.adapter.submit('Original prompt', settings)
    if (state === 'completed') f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    if (state === 'disconnected') f.transport.options.onExit?.(1, null)
    if (state === 'disposed') f.adapter.dispose()
    if (state === 'interrupting') await f.adapter.interrupt()
    const count = f.transport.sent.length
    expect(f.adapter.capabilities.steering).toBe(false)
    await expect(f.adapter.steer('Keep my text', settings)).rejects.toThrow(SteeringUnavailableError)
    expect(f.transport.sent).toHaveLength(count)
  })

  it('uses the same image encoder for submit and steer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-steer-image-')); imageRoots.push(root)
    writeFileSync(join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))
    const f = fixture({ cwd: root })
    const attachments = [{ id: 'image', kind: 'image' as const, name: 'image.png', path: 'image.png' }]
    await f.adapter.start(); await f.adapter.submit('Same text', settings, attachments)
    const original = f.transport.sent.at(-1) as { message: Json }
    await f.adapter.steer('Same text', settings, attachments)
    expect(f.transport.sent.at(-1)).toMatchObject({ message: original.message })
  })

  it('rechecks the active turn after asynchronous image capture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-steer-image-race-')); imageRoots.push(root)
    writeFileSync(join(root, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))
    const f = fixture({ cwd: root })
    await f.adapter.start(); await f.adapter.submit('Original prompt', settings)
    const count = f.transport.sent.length
    const steering = f.adapter.steer('Keep my image', settings, [{ id: 'image', kind: 'image', name: 'image.png', path: 'image.png' }])
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    await expect(steering).rejects.toThrow(SteeringUnavailableError)
    expect(f.transport.sent).toHaveLength(count)
  })

  it('surfaces a failed stdin write without claiming delivery or permitting automatic retry', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original prompt', settings)
    const count = f.transport.sent.length
    vi.spyOn(f.transport, 'send').mockImplementationOnce(() => { throw new Error('stdin write failed') })
    const reason: unknown = await f.adapter.steer('Keep my text', settings).catch(error => error)
    expect(reason).toBeInstanceOf(Error)
    expect(reason).not.toBeInstanceOf(SteeringUnavailableError)
    expect(f.transport.sent).toHaveLength(count)
  })
})

describe('Claude background task reporting (payloads captured from a real session)', () => {
  const subagents = (f: ReturnType<typeof fixture>) =>
    f.events.filter(event => event.data.type === 'subagent').map(event => event.data as Extract<AdapterEvent['data'], { type: 'subagent' }>)

  it('does not report a foreground tool call as a subagent', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'bu8bk69bg', tool_use_id: 'toolu_A', description: 'Typecheck the renderer changes', is_backgrounded: false, task_type: 'local_bash' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'bu8bk69bg', tool_use_id: 'toolu_A', status: 'completed', output_file: '', summary: 'Typecheck the renderer changes' })
    expect(subagents(f)).toHaveLength(0)
    // The native record is retained for the inspector without entering the conversation.
    expect(f.events.some(event => event.data.type === 'notice' && event.native?.method === 'system/task_started')).toBe(true)
  })

  it('reports a backgrounded task and keeps its launch description as the name', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'b90gny9dq', tool_use_id: 'toolu_B', description: 'Run Codex on the steering implementation', is_backgrounded: true, task_type: 'local_bash' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'b90gny9dq', tool_use_id: 'toolu_B', status: 'completed', output_file: 'C:/tmp/b90gny9dq.output', summary: 'Background command "Run Codex on the steering implementation" completed (exit code 0)' })
    const reported = subagents(f)
    expect(reported).toHaveLength(2)
    expect(reported[0]).toMatchObject({ name: 'Run Codex on the steering implementation', status: 'running', detached: true })
    expect(reported[1]).toMatchObject({ name: 'Run Codex on the steering implementation', status: 'completed' })
    expect(reported[1]?.name).not.toContain('exit code')
  })

  it('clamps a report-sized summary to a one-line roster name', async () => {
    const f = fixture()
    await f.adapter.start()
    const report = '## 1. `HAF_Blaze_Tax_Price_Sync` - includes/class-tax-price-sync.php ' + 'design notes and verified call sites '.repeat(400)
    f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu_R', is_backgrounded: true, task_type: 'local_bash' })
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', tool_use_id: 'toolu_R', status: 'completed', output_file: 'C:/tmp/agent-1.output', summary: report })
    const named = subagents(f).at(-1)?.name ?? ''
    expect(named.length).toBeLessThanOrEqual(120)
    expect(named).toContain('HAF_Blaze_Tax_Price_Sync')
    expect(named).not.toContain('\n')
  })

  it('still reports a completion that names an output file after its start was missed', async () => {
    const f = fixture()
    await f.adapter.start()
    f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'orphan', tool_use_id: 'toolu_C', status: 'completed', output_file: 'C:/tmp/orphan.output', summary: 'Background command "Deploy" completed (exit code 0)' })
    expect(subagents(f)).toHaveLength(1)
  })

  it('keeps two concurrent background runs distinct', async () => {
    const f = fixture()
    await f.adapter.start()
    for (const [task, tool] of [['one', 'toolu_D'], ['two', 'toolu_E']] as const) {
      f.transport.receive({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tool, description: 'Run ' + task, is_backgrounded: true, task_type: 'local_bash' })
    }
    expect(new Set(subagents(f).map(agent => agent.name)).size).toBe(2)
  })
})


describe('Claude visible text identity', () => {
  it('reconciles text after hidden thinking when final blocks are renumbered, including multiple identical visible blocks', async () => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Prompt', settings)
    const stream = (event: Json) => f.transport.receive({ type: 'stream_event', session_id: 'native-1', event })
    stream({ type: 'message_start', message: { id: 'thinking-message' } })
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
    for (const index of [1, 2]) {
      stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Repeated intentionally.' } })
    }
    stream({ type: 'message_stop' })
    f.transport.receive({ type: 'assistant', uuid: 'final', message: { id: 'thinking-message', content: [{ type: 'text', text: 'Repeated intentionally.' }, { type: 'text', text: 'Repeated intentionally.' }] } })
    const text = f.projection().items.filter(item => item.data.type === 'text')
    expect(text).toHaveLength(2)
    expect(text.map(item => item.nativeItemId)).toEqual(['thinking-message:text:0', 'thinking-message:text:1'])
  })
})


it('attaches actual bounded background command output to its task record', async () => {
  const base = join(tmpdir(), 'claude'); mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'conductor-adapter-output-')); imageRoots.push(root)
  const taskDirectory = join(root, 'native-output-session', 'tasks'); mkdirSync(taskDirectory, { recursive: true })
  const outputFile = join(taskDirectory, 'background-1.output'); writeFileSync(outputFile, 'Native background command completed successfully')
  const f = fixture({ nativeSessionId: 'native-output-session' }); await f.adapter.start()
  f.transport.receive({ type: 'system', subtype: 'task_started', task_id: 'background-1', is_backgrounded: true, description: 'Run checks' })
  f.transport.receive({ type: 'system', subtype: 'task_notification', task_id: 'background-1', status: 'completed', output_file: outputFile })
  await vi.waitFor(() => expect(f.projection().items.find(item => item.data.type === 'subagent')?.data).toMatchObject({ name: 'Run checks', status: 'completed', detached: true, outputFile, output: 'Native background command completed successfully', outputTruncated: false }))
})


describe('Claude permission actions and native approval boundaries', () => {
  function request(f: ReturnType<typeof fixture>, id = 'approval') {
    const item = f.projection().items.find(item => item.data.type === 'interaction' && item.data.interaction.id === id)
    if (item?.data.type !== 'interaction') throw new Error('Missing permission request')
    return item.data.interaction
  }
  function answer(id: string, decision: string) { return { sessionId: 'session', runtimeId: 'incarnation-A', requestId: id, decision } }
  function modeAck(f: ReturnType<typeof fixture>, error?: string) {
    const sent = f.transport.sent.at(-1) as { request_id: string }
    f.transport.receive({ type: 'control_response', response: { subtype: error ? 'error' : 'success', request_id: sent.request_id, ...(error ? { error } : { response: {} }) } })
  }
  it('shows distinct session and auto actions without inventing a reusable grant', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive(permission('approval', 'shell', 'Bash', { command: 'npm test' }))
    expect(request(f).choices).toContainEqual(expect.objectContaining({ id: 'allow-session', label: 'Allow for this session', disabled: true, description: expect.stringContaining('did not offer') }))
    expect(request(f).choices).toContainEqual(expect.objectContaining({ id: 'auto-mode', label: 'Switch to auto-mode', disabled: false }))
    await expect(f.adapter.respond(answer('approval', 'allow-session'))).rejects.toThrow('Unsupported')
    expect(request(f).status).toBe('pending')
    await f.adapter.respond(answer('approval', 'allow'))
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'allow', updatedInput: { command: 'npm test' } } } })
    expect(JSON.stringify(f.transport.sent.at(-1))).not.toContain('updatedPermissions')
  })
  it('limits native suggestions to the permitted tool and session, including provider Edit rules for Write', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive({ type: 'control_request', request_id: 'approval', request: {
      subtype: 'can_use_tool', tool_use_id: 'write', tool_name: 'Write', input: { file_path: 'report.txt', content: 'data' },
      permission_suggestions: [
        { type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Edit', ruleContent: '/report.txt' }] },
        { type: 'addRules', behavior: 'allow', destination: 'projectSettings', rules: [{ toolName: 'Bash' }] },
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        { type: 'addDirectories', directories: ['C:/'], destination: 'session' }
      ]
    } })
    expect(request(f).choices.find(choice => choice.id === 'allow-session')).toMatchObject({ disabled: false, description: expect.stringContaining('Edit(/report.txt)') })
    await f.adapter.respond(answer('approval', 'allow-session'))
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Edit', ruleContent: '/report.txt' }] }] } } })
    // If Claude still requests a matching permission, host grants must never skip it:
    // native ask rules and required-interaction tools outrank native allow rules.
    f.transport.receive(permission('required-again', 'write-again', 'Write', { file_path: 'report.txt', content: 'data' }))
    expect(request(f, 'required-again').status).toBe('pending')
    expect(f.projection().settings.permission).toBe('default')
    f.adapter.dispose()
    const fresh = fixture(); await fresh.adapter.start()
    fresh.transport.receive(permission('approval', 'write', 'Write', { file_path: 'report.txt', content: 'data' }))
    expect(request(fresh).status).toBe('pending')
    expect(JSON.stringify(fresh.transport.sent)).not.toContain('updatedPermissions')
  })
  it.each<Record<string, Json>>([
    { matched_ask_rule: { source: 'policySettings', tool_name: 'Bash' } },
    { decision_reason: 'Your organization requires approval for this tool' }
  ])('does not offer a reusable grant over a mandatory approval: %j', async boundary => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive({ type: 'control_request', request_id: 'approval', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, ...boundary,
      permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], destination: 'session' }]
    } })
    expect(request(f).choices.find(choice => choice.id === 'allow-session')).toMatchObject({ disabled: true, description: expect.stringContaining('individual approval') })
  })
  it('awaits native auto-mode confirmation, allows the selected request once, and preserves other pending requests', async () => {
    const f = fixture({ settings: { ...settings, plan: true } }); await f.adapter.start(); await f.adapter.submit('Synthetic', { ...settings, plan: true })
    f.transport.receive(permission('approval', 'one', 'Bash', { command: 'npm test' }))
    f.transport.receive(permission('second', 'two', 'Bash', { command: 'git status' }))
    f.transport.autoControlResponses = false
    const switching = f.adapter.respond(answer('approval', 'auto-mode'))
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'auto' } })
    expect(request(f).status).toBe('pending')
    expect(f.adapter.capabilities.effectiveSettings).toMatchObject({ permissionMode: 'plan' })
    await expect(f.adapter.respond(answer('approval', 'auto-mode'))).rejects.toThrow('already resolved')
    modeAck(f); await switching
    expect(f.projection()).toMatchObject({ phase: 'waiting_approval', settings: { permission: 'auto', plan: false }, capabilities: { effectiveSettings: { permissionMode: 'auto' } } })
    expect(request(f)).toMatchObject({ status: 'resolved', outcome: 'auto-mode' })
    expect(request(f, 'second').status).toBe('pending')
    expect(f.transport.sent.at(-1)).toMatchObject({ response: { request_id: 'approval', response: { behavior: 'allow', updatedInput: { command: 'npm test' } } } })
    expect(JSON.stringify(f.transport.sent.at(-1))).not.toContain('updatedPermissions')
    await f.adapter.respond(answer('second', 'deny'))
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    f.transport.autoControlResponses = true
    await f.adapter.submit('Keep Auto', { ...settings, permission: 'auto' })
    expect(f.transport.sent.filter(value => JSON.stringify(value).includes('set_permission_mode'))).toHaveLength(1)
    f.transport.receive(permission('mandatory-in-auto', 'three', 'Bash', { command: 'npm test' }))
    expect(request(f, 'mandatory-in-auto').choices.find(choice => choice.id === 'auto-mode')).toMatchObject({ disabled: true, description: expect.stringContaining('already active') })
    expect(request(f, 'mandatory-in-auto').status).toBe('pending')
  })
  it('leaves a rejected native auto switch pending and lets the owner deny the operation', async () => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(permission('approval', 'one', 'Bash', { command: 'npm test' }))
    f.transport.autoControlResponses = false
    const switching = f.adapter.respond(answer('approval', 'auto-mode'))
    modeAck(f, 'Auto mode is disabled by managed policy')
    await expect(switching).rejects.toThrow('disabled by managed policy')
    expect(request(f).status).toBe('pending')
    expect(f.projection()).toMatchObject({ settings: { permission: 'default' }, phase: 'waiting_approval' })
    expect(f.transport.sent.filter(value => JSON.stringify(value).includes('"behavior":"allow"'))).toHaveLength(0)
    await f.adapter.respond(answer('approval', 'deny'))
    expect(request(f)).toMatchObject({ status: 'resolved', outcome: 'deny' })
  })
  it.each(['cancel', 'complete'] as const)('never answers a request that the provider %s event expired during mode switching', async ending => {
    const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
    f.transport.receive(permission('approval', 'one', 'Bash', { command: 'npm test' }))
    f.transport.autoControlResponses = false
    const switching = f.adapter.respond(answer('approval', 'auto-mode'))
    const modeRequest = f.transport.sent.at(-1)
    if (ending === 'cancel') f.transport.receive({ type: 'control_cancel_request', request_id: 'approval' })
    else f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    modeAck(f); await switching
    expect(request(f).status).toBe('expired')
    expect(f.transport.sent.at(-1)).toEqual(modeRequest)
    expect(f.projection()).toMatchObject({ phase: ending === 'cancel' ? 'running' : 'completed', settings: { permission: 'auto', plan: false } })
  })
  it('keeps questions separate from permission mode actions', async () => {
    const f = fixture(); await f.adapter.start()
    f.transport.receive(permission('approval', 'question', 'AskUserQuestion', { questions: [{ question: 'Pick one', options: [{ label: 'One' }] }] }))
    expect(request(f).choices.map(choice => choice.id)).toEqual(['allow', 'deny', 'abort'])
  })
})


it('honors the native offered session Edit mode, keeps it across turns, and expires it for another runtime', async () => {
  const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
  f.transport.receive({ type: 'control_request', request_id: 'session-edit', request: {
    subtype: 'can_use_tool', tool_use_id: 'write', tool_name: 'Write', input: { file_path: 'proof.txt', content: 'first' },
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  } })
  const interaction = f.projection().items.find(item => item.data.type === 'interaction')
  expect(interaction?.data).toMatchObject({ interaction: { choices: expect.arrayContaining([expect.objectContaining({ id: 'allow-session', disabled: false, description: expect.stringContaining('all file edits') })]) } })
  await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'session-edit', decision: 'allow-session' })
  expect(f.transport.sent).toContainEqual(expect.objectContaining({ request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } }))
  expect(f.transport.sent.at(-1)).toMatchObject({ response: { response: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } } })
  expect(f.projection()).toMatchObject({ settings: { permission: 'accept-edits', temporaryPermission: { runtimeId: 'incarnation-A', restore: 'default' } }, capabilities: { effectiveSettings: { permissionMode: 'acceptEdits' } } })
  f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
  await f.adapter.submit('Another turn', f.projection().settings)
  expect(f.transport.sent.filter(value => JSON.stringify(value).includes('set_permission_mode'))).toHaveLength(1)
  const resumed = fixture({ settings: f.projection().settings, runtimeId: 'incarnation-B' })
  await resumed.adapter.start()
  expect(resumed.transport.options.args[resumed.transport.options.args.indexOf('--permission-mode') + 1]).toBe('manual')
  await resumed.adapter.submit('Stale queued settings', f.projection().settings)
  expect(resumed.transport.sent.filter(value => JSON.stringify(value).includes('set_permission_mode'))).toHaveLength(0)
})

it.each([
  { tool_name: 'Bash', update: { type: 'setMode', mode: 'acceptEdits', destination: 'session' } },
  { tool_name: 'Write', update: { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' } },
  { tool_name: 'Write', update: { type: 'setMode', mode: 'bypassPermissions', destination: 'session' } }
])('does not invent a session mode grant for an unrelated tool or permanent/dangerous mode: %j', async row => {
  const f = fixture(); await f.adapter.start()
  f.transport.receive({ type: 'control_request', request_id: 'unoffered', request: { subtype: 'can_use_tool', tool_name: row.tool_name, input: {}, permission_suggestions: [row.update] } })
  await expect(f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'unoffered', decision: 'allow-session' })).rejects.toThrow('Unsupported')
})


it.each(['deny', 'abort', 'interrupt'] as const)('preserves explicit %s outcome through native failure hooks and error echoes', async action => {
  const f = fixture(); await f.adapter.start(); await f.adapter.submit('Synthetic', settings)
  const input = { command: 'node --version' }
  f.transport.receive(permission('decision', 'shell', 'Bash', input))
  if (action === 'interrupt') await f.adapter.interrupt()
  else await f.adapter.respond({ sessionId: 'session', runtimeId: 'incarnation-A', requestId: 'decision', decision: action })
  f.transport.receive(hook('failure-hook', 'conductor_failed', 'shell', 'Bash', input, { exitCode: 1, stderr: 'Native request did not run' }))
  await flush()
  f.transport.receive({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'shell', content: 'Native request did not run', is_error: true }] } })
  expect(f.projection().items.find(item => item.data.type === 'tool' && item.nativeItemId === 'shell')?.data).toMatchObject({ status: action === 'deny' ? 'rejected' : 'interrupted' })
  f.transport.receive(toolUse('ordinary-error', 'Bash', { command: 'node missing-file.js' }))
  f.transport.receive(hook('ordinary-failure-hook', 'conductor_failed', 'ordinary-error', 'Bash', { command: 'node missing-file.js' }, { exitCode: 1 }))
  await flush()
  expect(f.projection().items.find(item => item.data.type === 'tool' && item.nativeItemId === 'ordinary-error')?.data).toMatchObject({ status: 'failed' })
})


describe('Claude native steering command lifecycle', () => {
  it('uses next priority and only reports consumption on the matching native started frame', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original', settings)
    await f.adapter.steer('Followup', settings, [], 'steering-1')
    expect(f.transport.sent.at(-1)).toMatchObject({ type: 'user', uuid: 'steering-1', priority: 'next' })
    expect(f.events.some(event => event.data.type === 'input_delivery')).toBe(false)
    const lifecycle = (id: string, state: string) => f.transport.receive({ type: 'command_lifecycle', uuid: id + state, command_uuid: id, state })
    lifecycle('other-input', 'started'); lifecycle('steering-1', 'queued')
    f.transport.receive(toolUse('next-tool', 'Read', { file_path: 'panel.mjs' }))
    expect(f.events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'steering-1', status: 'accepted' }])
    lifecycle('steering-1', 'started'); lifecycle('steering-1', 'started'); lifecycle('steering-1', 'cancelled')
    expect(f.events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'steering-1', status: 'accepted' }, { type: 'input_delivery', inputId: 'steering-1', status: 'delivered' }])
    expect(f.adapter.capabilities.steering).toBe(true)
  })
  it('uses the interrupt cancellation receipt, never an ambiguous cancelled lifecycle, to authorize replay', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original', settings)
    await f.adapter.steer('Pending', settings, [], 'pending-input')
    f.transport.autoControlResponses = false
    const stopping = f.adapter.interrupt()
    const request = f.transport.sent.at(-1) as { request_id: string }
    f.transport.receive({ type: 'command_lifecycle', command_uuid: 'pending-input', state: 'cancelled' })
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    expect(f.events.some(event => event.data.type === 'input_delivery')).toBe(false)
    f.transport.receive({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [], cancelled: ['pending-input'] } } })
    await stopping
    expect(f.events.at(-1)?.data).toEqual({ type: 'input_delivery', inputId: 'pending-input', status: 'cancelled' })
  })
  it('marks pending input uncertain on disconnect and tracks a native next command after a result', async () => {
    const f = fixture()
    await f.adapter.start(); await f.adapter.submit('Original', settings)
    await f.adapter.steer('Next', settings, [], 'next-input')
    f.transport.receive({ type: 'result', subtype: 'success', usage: {} })
    f.transport.receive({ type: 'command_lifecycle', command_uuid: 'next-input', state: 'started' })
    expect(f.adapter.capabilities.steering).toBe(true)
    await f.adapter.steer('Unconfirmed', settings, [], 'unconfirmed-input')
    f.adapter.dispose()
    expect(f.events.filter(event => event.data.type === 'input_delivery').map(event => event.data)).toEqual([{ type: 'input_delivery', inputId: 'next-input', status: 'delivered' }, { type: 'input_delivery', inputId: 'unconfirmed-input', status: 'uncertain' }])
  })
})
