import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdapterEvent, AgentEvent, Json, SessionSettings } from '../../shared/structured-agent'
import { replayAgentEvents } from '../../shared/structured-agent-reducer'
import { ClaudeAdapter } from './claude'
import { JsonLineDecoder, JsonLineTransport, type TransportOptions } from './transport'
import type { AdapterOptions } from './adapter'
import { resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

const settings: SessionSettings = { permission: 'default', plan: false }
const flush = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }
class FakeTransport {
  connected = false
  sent: Json[] = []
  constructor(readonly options: TransportOptions, private autoInitialize = true) {}
  start(): void { this.connected = true }
  close(): void { this.connected = false }
  send(value: Json): void {
    if (!this.connected) throw new Error('Disconnected')
    this.sent.push(value)
    const message = value as { type?: string; request_id?: string; request?: { subtype?: string } }
    if (message.type === 'control_request' && (message.request?.subtype !== 'initialize' || this.autoInitialize)) queueMicrotask(() => this.receive({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id!, response: { models: [{ value: 'fixture-model', displayName: 'Synthetic model' }] } } }))
  }
  receive(value: Json): void { this.options.onMessage(value) }
}
const adapters: ClaudeAdapter[] = []
const imageRoots: string[] = []
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); for (const root of imageRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
function fixture(overrides: Partial<AdapterOptions> = {}, autoInitialize = true) {
  const events: AdapterEvent[] = []
  let transport!: FakeTransport
  const adapter = new ClaudeAdapter({ executable: 'synthetic-claude', cwd: process.cwd(), runtimeId: 'incarnation-A', settings, emit: (event) => events.push(event), ...overrides }, {
    version: async () => '2.1.263', createTransport: (options) => transport = new FakeTransport(options, autoInitialize)
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
    expect(f.projection().items.find((item) => item.nativeItemId === 'unicode:0')?.data).toMatchObject({ text: 'Árvíz 日本語 😀' })
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
