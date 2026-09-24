import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConductorDatabase } from '../database'
import { ClaudeAdapter, CLAUDE_COMPATIBILITY } from '../providers/claude'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE } from '../providers/codex'
import { JsonLineTransport, setRuntimeHost } from '../providers/transport'
import type { AdapterOptions } from '../providers/adapter'
import { StructuredSessions } from '../structured-sessions'
import type { AgentSpec } from '../../shared/models'
import type { SessionSettings, StructuredProvider } from '../../shared/structured-agent'
import { RuntimeHostClient } from './client'
import { RuntimeHost } from './host'
import { runtimeHostPipe } from './protocol'

/** A Claude CLI stand-in on the real stream-json wire: one turn streams twenty words, runs a
 *  tool, and says one more thing, slowly enough for the app to restart in the middle of it. */
const FAKE_CLAUDE = `
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const session = 'reattach-native-1'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: session, parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const stream = async (words, delay) => {
  const id = randomUUID()
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const word of words) { emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } } }); await wait(delay) }
  emit({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  emit({ type: 'stream_event', event: { type: 'message_stop' } })
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text: words.join('') }] } })
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } } })
    return
  }
  if (message.type === 'control_request') { send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }); return }
  if (message.type !== 'user') return
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  await stream(Array.from({ length: 20 }, (_, i) => 'w' + i + ' '), 40)
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'tool-after-restart', name: 'Read', input: { file_path: 'notes.txt' } }] } })
  await wait(60)
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-after-restart', content: 'synthetic file body', is_error: false }] } })
  await stream(['Done ', 'after ', 'the ', 'restart.'], 20)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})`

/** A Codex App Server stand-in: one turn streams twenty deltas, runs a command and completes. */
const FAKE_CODEX = `
const readline = require('node:readline')
const threadId = 'reattach-thread-1'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const notify = (method, params) => send({ method, params })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const thread = () => ({ thread: { id: threadId, status: { type: 'idle' }, turns: [], cwd: process.cwd() }, model: 'synthetic-model', reasoningEffort: 'low', modelProvider: 'openai', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, instructionSources: [] })
const message = (id, text) => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null })
const command = (id, status, output) => ({ type: 'commandExecution', id, command: 'synthetic', cwd: process.cwd(), source: 'agent', status, aggregatedOutput: output, exitCode: status === 'completed' ? 0 : null, durationMs: null, commandActions: [], pluginId: null, scriptPath: null, processId: null })
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'codex/synthetic', codexHome: '/synthetic', platformFamily: 'windows', platformOs: 'windows' } })
  if (request.method === 'initialized') return
  if (request.method === 'thread/start' || request.method === 'thread/resume') return send({ id: request.id, result: thread() })
  if (request.method === 'model/list') return send({ id: request.id, result: { data: [{ id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Synthetic' }] }], nextCursor: null } })
  if (request.method !== 'turn/start') return send({ id: request.id, result: {} })
  const turnId = 'reattach-turn-1', turn = { id: turnId, status: 'inProgress', items: [], error: null }
  notify('turn/started', { threadId, turn })
  send({ id: request.id, result: { turn } })
  notify('item/started', { threadId, turnId, item: message('reply-1', '') })
  const words = Array.from({ length: 20 }, (_, i) => 'w' + i + ' ')
  for (const word of words) { notify('item/agentMessage/delta', { threadId, turnId, itemId: 'reply-1', delta: word }); await wait(40) }
  notify('item/completed', { threadId, turnId, item: message('reply-1', words.join('')) })
  notify('item/started', { threadId, turnId, item: command('command-1', 'inProgress', null) })
  await wait(60)
  notify('item/completed', { threadId, turnId, item: command('command-1', 'completed', 'synthetic output') })
  notify('item/completed', { threadId, turnId, item: message('reply-2', 'Done after the restart.') })
  notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } })
})`

const settings: SessionSettings = { permission: 'auto', plan: false }
const until = async (check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('reattaching a turn across an app restart', () => {
  let root: string, host: RuntimeHost, pipe: string, secret: string, fake: string, fakeCodex: string
  const cleanup: Array<() => void> = []
  beforeEach(async () => {
    vi.stubEnv('CONDUCTOR_LIVE_TESTS', '0')
    vi.stubEnv('CONDUCTOR_OFFLINE_TESTS', '0')
    root = mkdtempSync(join(tmpdir(), 'conductor-reattach-'))
    fake = join(root, 'fake-claude.cjs')
    writeFileSync(fake, FAKE_CLAUDE)
    fakeCodex = join(root, 'fake-codex.cjs')
    writeFileSync(fakeCodex, FAKE_CODEX)
    pipe = runtimeHostPipe(join(root, randomUUID()))
    secret = randomBytes(16).toString('hex')
    host = new RuntimeHost({ pipe, secret })
    await host.listen()
  })
  afterEach(async () => {
    setRuntimeHost(null)
    for (const step of cleanup.splice(0).reverse()) { try { step() } catch { /* best effort */ } }
    await host.close()
    await new Promise(resolve => setTimeout(resolve, 200))
    vi.unstubAllEnvs()
    // taskkill ends the fake CLIs asynchronously, and Windows keeps a directory a process runs in.
    for (let attempt = 0; ; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break } catch (error) { if (attempt > 40) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
  })

  const factory = (provider: StructuredProvider, options: AdapterOptions) => provider === 'codex' ? new CodexAdapter(options, {
    version: async () => CODEX_PROTOCOL_BASELINE,
    transport: transport => new JsonLineTransport({ ...transport, executable: process.execPath, args: [fakeCodex], environment: { ...process.env } })
  }) : new ClaudeAdapter(options, {
    version: async () => CLAUDE_COMPATIBILITY,
    createTransport: transport => new JsonLineTransport({ ...transport, executable: process.execPath, args: [fake, ...transport.args], environment: { ...process.env } })
  })
  /** One app process: its own database connection, runtime host client and sessions. */
  const app = async (databasePath: string): Promise<{ database: ConductorDatabase; sessions: StructuredSessions; client: RuntimeHostClient }> => {
    const database = new ConductorDatabase(databasePath)
    const client = await RuntimeHostClient.connect(pipe, secret)
    setRuntimeHost(client)
    const sessions = new StructuredSessions(database, () => process.execPath, vi.fn(), factory)
    cleanup.push(() => { sessions.dispose(); client.dispose(); database.close() })
    return { database, sessions, client }
  }
  const assistantText = (database: ConductorDatabase, id: string): string[] =>
    database.structured.snapshot(id)!.items.filter(item => item.data.type === 'text' && item.data.role === 'assistant').map(item => (item.data as { text: string }).text)

  it('keeps the provider process running and finishes the turn in the next process with every event', async () => {
    const workspace = join(root, 'workspace'); mkdirSync(workspace)
    const databasePath = join(root, 'conductor.db')
    const first = await app(databasePath)
    const project = first.database.upsertProject(workspace, 'Reattach project')
    const spec: AgentSpec = { id: 'reattach-agent', projectId: project.id, sessionId: first.database.listSessions(project.id)[0]!.id, provider: 'claude', title: 'Wizard', cwd: workspace }
    first.sessions.ensure(spec)
    await first.sessions.submit(spec.id, 'Start the long turn', settings)
    await until(() => assistantText(first.database, spec.id).some(text => text.includes('w4 ')), 'the turn to be under way')
    const runtimeId = first.database.structured.snapshot(spec.id)!.runtimeId

    // The app restarts in the middle of the turn.
    expect(await first.sessions.detachForRestart()).toEqual([spec.id])
    const before = first.database.structured.snapshot(spec.id)!
    expect(before.phase).toBe('running')
    expect(assistantText(first.database, spec.id).join('')).not.toContain('w19')
    first.sessions.dispose(); first.client.dispose(); first.database.close()
    const [kept] = host.list()
    expect(kept).toMatchObject({ alive: true, detached: true })

    // While no app is running the turn goes on and the host buffers what it says.
    await until(() => (host.list()[0]?.lastSeq ?? 0) > kept!.lastSeq + 10, 'output while no app listens')

    const second = await app(databasePath)
    // The store closes open work when it loads; the reattached adapter restates it.
    expect(second.database.structured.snapshot(spec.id)!.phase).toBe('disconnected')
    expect(second.sessions.detachedRuntimes().map(entry => entry.id)).toEqual([spec.id])
    await second.sessions.reattach(spec.id)
    expect(second.database.structured.snapshot(spec.id)!.phase).toBe('running')
    expect(second.sessions.hasRuntime(spec.id)).toBe(true)
    await until(() => second.database.structured.snapshot(spec.id)!.phase === 'completed', 'the turn to complete', 20_000)
    second.sessions.flush()

    const state = second.database.structured.snapshot(spec.id)!
    expect(state.runtimeId).toBe(runtimeId)
    expect(assistantText(second.database, spec.id)).toEqual([Array.from({ length: 20 }, (_, i) => `w${i} `).join(''), 'Done after the restart.'])
    expect(state.items.find(item => item.data.type === 'tool')?.data).toMatchObject({ type: 'tool', status: 'completed' })
    const sequences = second.database.structured.events(spec.id).map(event => event.sequence)
    expect(sequences).toEqual(sequences.map((_, index) => sequences[0]! + index))
    expect(state.items.some(item => item.data.type === 'notice' && /kept running/.test((item.data as { message: string }).message))).toBe(true)
    expect(second.sessions.detachedRuntimes()).toEqual([])
  })

  it('continues a Codex turn the same way', async () => {
    const workspace = join(root, 'workspace-codex'); mkdirSync(workspace)
    const databasePath = join(root, 'codex.db')
    const first = await app(databasePath)
    const project = first.database.upsertProject(workspace, 'Codex project')
    const spec: AgentSpec = { id: 'codex-agent', projectId: project.id, sessionId: first.database.listSessions(project.id)[0]!.id, provider: 'codex', title: 'Astra', cwd: workspace }
    first.sessions.ensure(spec)
    await first.sessions.submit(spec.id, 'Start the long turn', settings)
    await until(() => assistantText(first.database, spec.id).some(text => text.includes('w4 ')), 'the Codex turn to be under way')
    expect(await first.sessions.detachForRestart()).toEqual([spec.id])
    first.sessions.dispose(); first.client.dispose(); first.database.close()
    await new Promise(resolve => setTimeout(resolve, 300))

    const second = await app(databasePath)
    await second.sessions.reattach(spec.id)
    expect(second.database.structured.snapshot(spec.id)!.phase).toBe('running')
    await until(() => second.database.structured.snapshot(spec.id)!.phase === 'completed', 'the Codex turn to complete', 20_000)
    second.sessions.flush()
    const state = second.database.structured.snapshot(spec.id)!
    expect(assistantText(second.database, spec.id)).toEqual([Array.from({ length: 20 }, (_, i) => `w${i} `).join(''), 'Done after the restart.'])
    expect(state.items.find(item => item.data.type === 'tool')?.data).toMatchObject({ type: 'tool', status: 'completed' })
    const sequences = second.database.structured.events(spec.id).map(event => event.sequence)
    expect(sequences).toEqual(sequences.map((_, index) => sequences[0]! + index))
  })

  it('stops an idle conversation as before and keeps no record of it', async () => {
    const workspace = join(root, 'workspace-idle'); mkdirSync(workspace)
    const first = await app(join(root, 'idle.db'))
    const project = first.database.upsertProject(workspace, 'Idle project')
    const spec: AgentSpec = { id: 'idle-agent', projectId: project.id, sessionId: first.database.listSessions(project.id)[0]!.id, provider: 'claude', title: 'Idle', cwd: workspace }
    first.sessions.ensure(spec)
    await first.sessions.submit(spec.id, 'A short turn', settings)
    await until(() => first.database.structured.snapshot(spec.id)!.phase === 'completed', 'the turn to complete', 20_000)
    expect(await first.sessions.detachForRestart()).toEqual([])
    expect(first.sessions.detachedRuntimes()).toEqual([])
    first.sessions.dispose()
    await until(() => host.list().length === 0, 'the idle runtime to stop')
  })

  it('reports a kept conversation whose runtime is gone as disconnected', async () => {
    const workspace = join(root, 'workspace-gone'); mkdirSync(workspace)
    const databasePath = join(root, 'gone.db')
    const first = await app(databasePath)
    const project = first.database.upsertProject(workspace, 'Gone project')
    const spec: AgentSpec = { id: 'gone-agent', projectId: project.id, sessionId: first.database.listSessions(project.id)[0]!.id, provider: 'claude', title: 'Gone', cwd: workspace }
    first.sessions.ensure(spec)
    await first.sessions.submit(spec.id, 'Start the long turn', settings)
    await until(() => assistantText(first.database, spec.id).some(text => text.includes('w2 ')), 'the turn to be under way')
    expect(await first.sessions.detachForRestart()).toEqual([spec.id])
    first.sessions.dispose(); first.client.dispose(); first.database.close()
    await host.close()
    host = new RuntimeHost({ pipe, secret })
    await host.listen()
    const second = await app(databasePath)
    second.sessions.abandonDetached(spec.id, 'The runtime kept for this turn is gone.')
    expect(second.database.structured.snapshot(spec.id)!.phase).toBe('disconnected')
    expect(second.sessions.detachedRuntimes()).toEqual([])
  })
})
