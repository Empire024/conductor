import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { CAPABILITIES_RESTATE_EVERY, mergeStreamedDelta, streamedDeltaKey, withoutRestatedCapabilities } from './journal-coalescing'
import type { AgentSpec } from '../shared/models'
import type { AdapterOptions, ProviderAdapter } from './providers/adapter'
import type { AdapterEvent, InteractionResponse, ProviderCapabilities } from '../shared/structured-agent'

const capabilities: ProviderCapabilities = { provider: 'claude', runtimeVersion: 'synthetic', adapterVersion: 1, authentication: 'cli', steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false, approvals: true, questions: true, resume: true, fork: true, plans: true, permissions: ['default'], effort: ['low'], models: [], limitations: ['SYNTHETIC zero-inference fixture'] }
const delta = (inputDelta: string, extra: Partial<AdapterEvent> = {}): AdapterEvent => ({ itemId: 'toolu_1', turnId: 't1', data: { type: 'tool', name: 'Write', status: 'preparing', inputDelta }, ...extra })

describe('streamed delta keys and merges', () => {
  it('merges tool input fragments and text deltas of one item only', () => {
    expect(streamedDeltaKey(delta('{"a'))).toBe(streamedDeltaKey(delta('": 1}')))
    expect(streamedDeltaKey(delta('x', { itemId: 'toolu_2' }))).not.toBe(streamedDeltaKey(delta('x')))
    expect(mergeStreamedDelta(delta('{"a'), delta('": 1}')).data).toEqual({ type: 'tool', name: 'Write', status: 'preparing', inputDelta: '{"a": 1}' })
    const text = (value: string): AdapterEvent => ({ itemId: 'm1', data: { type: 'text', role: 'assistant', mode: 'delta', text: value } })
    expect(streamedDeltaKey(text('Hel'))).toBe(streamedDeltaKey(text('lo')))
    expect(mergeStreamedDelta(text('Hel'), text('lo')).data).toEqual({ type: 'text', role: 'assistant', mode: 'delta', text: 'Hello' })
  })
  it('never merges a full input, a status change, a snapshot or a raw provider frame', () => {
    expect(streamedDeltaKey({ itemId: 'toolu_1', data: { type: 'tool', name: 'Write', status: 'preparing', input: { a: 1 } } })).toBeNull()
    expect(streamedDeltaKey({ itemId: 'toolu_1', data: { type: 'tool', name: 'Write', status: 'running', inputDelta: 'x' } })).toBeNull()
    expect(streamedDeltaKey({ itemId: 'm1', data: { type: 'text', role: 'assistant', mode: 'snapshot', text: 'x' } })).toBeNull()
    expect(streamedDeltaKey({ itemId: 'm1', native: { method: 'item/agentMessage/delta' }, data: { type: 'text', role: 'assistant', mode: 'delta', text: 'x' } })).toBeNull()
  })
  it('drops an unchanged capabilities restatement only while a recent one is in the journal', () => {
    const session = { type: 'session' as const, phase: 'running' as const, capabilities }
    expect(withoutRestatedCapabilities(session, capabilities, 10, 20)).toEqual({ type: 'session', phase: 'running' })
    expect(withoutRestatedCapabilities(session, capabilities, undefined, 20)).toBe(session)
    expect(withoutRestatedCapabilities(session, capabilities, 10, 10 + CAPABILITIES_RESTATE_EVERY)).toBe(session)
    expect(withoutRestatedCapabilities(session, { ...capabilities, runtimeVersion: 'other' }, 10, 20)).toBe(session)
  })
})

const roots: string[] = [], databases: ConductorDatabase[] = [], managers: StructuredSessions[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) { try { manager.dispose() } catch { /* fixture teardown */ } }
  for (const db of databases.splice(0)) { try { db.close() } catch { /* fixture teardown */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  vi.unstubAllEnvs()
})
class FakeProvider implements ProviderAdapter {
  readonly provider = 'claude' as const
  readonly capabilities = capabilities
  constructor(readonly options: AdapterOptions) {}
  async start(): Promise<void> { this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: 'native-1', capabilities: this.capabilities } }) }
  async submit(): Promise<void> { this.emit({ data: { type: 'session', phase: 'running', capabilities: this.capabilities } }) }
  async steer(): Promise<void> { /* not exercised */ }
  async respond(_response: InteractionResponse): Promise<void> { /* not exercised */ }
  async interrupt(): Promise<void> { /* not exercised */ }
  async fork(): Promise<string> { return 'fork' }
  async rename(): Promise<void> { /* not exercised */ }
  dispose(): void { /* not exercised */ }
  emit(event: AdapterEvent): void { this.options.emit(event) }
}
async function fixture() {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
  vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
  const root = mkdtempSync(join(tmpdir(), 'conductor-coalescing-')); roots.push(root)
  const workspace = join(root, 'Workspace'); mkdirSync(workspace)
  const database = new ConductorDatabase(join(root, 'conductor.db')); databases.push(database)
  const project = database.upsertProject(workspace, 'Synthetic project')
  const session = database.listSessions(project.id)[0]!
  const spec: AgentSpec = { id: 'agent-session', projectId: project.id, sessionId: session.id, provider: 'claude', title: 'Synthetic', cwd: workspace }
  const adapters: FakeProvider[] = []
  const manager = new StructuredSessions(database, () => 'synthetic-executable', vi.fn(), (_provider, options) => { const adapter = new FakeProvider(options); adapters.push(adapter); return adapter })
  managers.push(manager)
  manager.ensure(spec)
  await manager.submit(spec.id, 'Synthetic turn', { permission: 'default', plan: false })
  const journal = () => database.structured.events(spec.id)
  return { database, spec, manager, adapter: () => adapters.at(-1)!, journal }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('the journal holds one event per streamed burst (synthetic, zero inference)', () => {
  it('journals a burst of tool input fragments as one event the timeline reads the same', async () => {
    const { database, spec, adapter, journal } = await fixture()
    const before = journal().length
    const input = { file_path: 'C:/x.txt', content: 'y'.repeat(4000) }
    const text = JSON.stringify(input)
    adapter().emit({ itemId: 'toolu_1', data: { type: 'tool', name: 'Write', input: {}, status: 'preparing' } })
    for (let at = 0; at < text.length; at += 16) adapter().emit({ itemId: 'toolu_1', data: { type: 'tool', name: 'Write', status: 'preparing', inputDelta: text.slice(at, at + 16) } })
    await tick()
    const streamed = journal().slice(before)
    expect(streamed.length).toBe(2)
    const tool = database.structured.snapshot(spec.id)!.items.find(item => item.nativeItemId === 'toolu_1' || item.id.includes('toolu_1'))!
    expect(tool.data.type === 'tool' && tool.data.inputDelta).toBe(text)
    // The next burst continues the same item, then the full input replaces the preview.
    adapter().emit({ itemId: 'toolu_1', data: { type: 'tool', name: 'Write', status: 'preparing', inputDelta: '' } })
    adapter().emit({ itemId: 'toolu_1', data: { type: 'tool', name: 'Write', status: 'preparing', input } })
    adapter().emit({ itemId: 'toolu_1', data: { type: 'tool', name: 'Write', status: 'completed', input, output: 'ok' } })
    await tick()
    expect(journal().length - before).toBe(5)
    const done = database.structured.snapshot(spec.id)!.items.find(item => item.id === tool.id)!
    expect(done.data).toMatchObject({ type: 'tool', status: 'completed', input, output: 'ok' })
    expect(done.data.type === 'tool' && done.data.inputDelta).toBeFalsy()
  })
  it('journals streamed text as one event per burst, ordered before what ends it', async () => {
    const { database, spec, adapter, journal } = await fixture()
    const before = journal().length
    for (const part of ['Hel', 'lo, ', 'wor', 'ld']) adapter().emit({ itemId: 'msg_1', data: { type: 'text', role: 'assistant', mode: 'delta', text: part } })
    adapter().emit({ data: { type: 'session', phase: 'completed' } })
    await tick()
    const written = journal().slice(before)
    expect(written.map(event => event.data.type)).toEqual(['text', 'session'])
    expect(written[0]!.data).toMatchObject({ text: 'Hello, world' })
    expect(written[0]!.sequence + 1).toBe(written[1]!.sequence)
    const message = database.structured.snapshot(spec.id)!.items.find(item => item.data.type === 'text' && item.data.role === 'assistant')!
    expect(message.data.type === 'text' && message.data.text).toBe('Hello, world')
  })
  it('journals a runtime\'s unchanged capabilities once, and the projection keeps them', async () => {
    const { database, spec, manager, adapter, journal } = await fixture()
    adapter().emit({ data: { type: 'session', phase: 'running', capabilities } })
    adapter().emit({ data: { type: 'session', phase: 'running', capabilities } })
    await tick()
    const stated = journal().filter(event => event.data.type === 'session' && event.data.capabilities)
    expect(stated.length).toBe(1)
    expect(database.structured.snapshot(spec.id)!.capabilities).toEqual(capabilities)
    adapter().emit({ data: { type: 'session', phase: 'running', capabilities: { ...capabilities, runtimeVersion: 'newer' } } })
    await tick()
    expect(journal().filter(event => event.data.type === 'session' && event.data.capabilities).length).toBe(2)
    expect(database.structured.snapshot(spec.id)!.capabilities?.runtimeVersion).toBe('newer')
  })
})
