import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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

/** A Claude CLI stand-in that steers the way the installed runtime does: input sent with
 *  priority 'next' while a turn runs is acknowledged ('queued', here after a short delay so an
 *  app restart can land before it) and answered in arrival order, each as its own native turn
 *  ('started' after the preceding result, then 'completed'). */
const STEERING_CLAUDE = `
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'steer-native-1', parent_tool_use_id: null, ...message })
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
let busy = false
const waiting = []
const turn = async (words, command) => {
  busy = true
  if (command) emit({ type: 'command_lifecycle', command_uuid: command, state: 'started' })
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  await stream(words, 40)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
  if (command) emit({ type: 'command_lifecycle', command_uuid: command, state: 'completed' })
  busy = false
  const next = waiting.shift()
  if (next) void turn(['ack:' + next.text], next.uuid)
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {}
    return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
  }
  if (message.type !== 'user') return
  const text = /steer-\\d+/.exec(JSON.stringify(message.message.content))?.[0] ?? 'prompt'
  if (busy) {
    waiting.push({ uuid: message.uuid, text })
    setTimeout(() => emit({ type: 'command_lifecycle', command_uuid: message.uuid, state: 'queued' }), 300)
    return
  }
  void turn(Array.from({ length: 30 }, (_, i) => 'w' + i + ' '))
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

/** A Claude CLI stand-in that uses its tools after the app it started with is gone: once the test
 *  writes `go` into its working directory, it sends a PreToolUse hook and calls the MCP server
 *  named in its --mcp-config, the way the installed CLI does, and reports what came back. Like the
 *  CLI it gives up on a hook after the timeout registered at initialize. */
const TOOLS_CLAUDE = `
const readline = require('node:readline')
const { randomUUID } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const emit = message => send({ uuid: randomUUID(), session_id: 'tools-native-1', parent_tool_use_id: null, ...message })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const say = text => { const id = randomUUID(); emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } }) }
const config = process.argv[process.argv.indexOf('--mcp-config') + 1]
const server = Object.values(JSON.parse(config.trim().startsWith('{') ? config : readFileSync(config, 'utf8')).mcpServers)[0]
let timeout = 0
const answers = new Map()
const hook = tool => new Promise(resolve => {
  const id = randomUUID()
  const timer = setTimeout(() => resolve('timed out after ' + timeout + ' s'), timeout * 1000)
  answers.set(id, response => { clearTimeout(timer); resolve(response.subtype) })
  send({ type: 'control_request', request_id: id, request: { subtype: 'hook_callback', callback_id: 'conductor_before', tool_use_id: tool, input: { tool_use_id: tool, tool_name: 'Bash', tool_input: { command: 'echo hi' } } } })
})
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line)
  if (message.type === 'control_response') { answers.get(message.response.request_id)?.(message.response); return }
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') timeout = message.request.hooks.PreToolUse[0].timeout
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [{ value: 'synthetic-claude', displayName: 'Synthetic' }] } : {} } })
    return
  }
  if (message.type !== 'user') return
  emit({ type: 'system', subtype: 'init', model: 'synthetic-claude' })
  say('waiting')
  while (!existsSync('go')) await wait(20)
  emit({ type: 'assistant', message: { id: randomUUID(), content: [{ type: 'tool_use', id: 'tool-while-away', name: 'Bash', input: { command: 'echo hi' } }] } })
  const [answer, reached] = await Promise.all([hook('tool-while-away'), fetch(server.url, { method: 'POST', headers: { Authorization: server.headers.Authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(async response => response.status + ' ' + (await response.text()), error => 'failed ' + error.message)])
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-while-away', content: 'hi', is_error: false }] } })
  say('hook timeout ' + timeout + '; hook ' + answer + '; mcp ' + reached)
  emit({ type: 'result', subtype: 'success', is_error: false, usage: {} })
})`

/** One of the app's loopback MCP servers: a new port and token every launch, like BrowserMcpServer. */
async function mcpServer(token: string, directory: string): Promise<{ config: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    request.resume()
    response.writeHead(request.headers.authorization === 'Bearer ' + token ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ served: token.slice(0, 4) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = join(directory, `mcp-${token.slice(0, 4)}.json`)
  writeFileSync(config, JSON.stringify({ mcpServers: { 'conductor-browser': { type: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, headers: { Authorization: 'Bearer ' + token } } } }))
  return { config, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}

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
    mcpConfig = ''
    for (const step of cleanup.splice(0).reverse()) { try { step() } catch { /* best effort */ } }
    await host.close()
    await new Promise(resolve => setTimeout(resolve, 200))
    vi.unstubAllEnvs()
    // taskkill ends the fake CLIs asynchronously, and Windows keeps a directory a process runs in.
    for (let attempt = 0; ; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break } catch (error) { if (attempt > 40) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
  })

  /** The MCP configuration the current app process hands its adapters (StructuredSessions.options). */
  let mcpConfig = ''
  const factory = (provider: StructuredProvider, given: AdapterOptions) => { const options = mcpConfig ? { ...given, mcpConfig } : given; return provider === 'codex' ? new CodexAdapter(options, {
    version: async () => CODEX_PROTOCOL_BASELINE,
    transport: transport => new JsonLineTransport({ ...transport, executable: process.execPath, args: [fakeCodex], environment: { ...process.env } })
  }) : new ClaudeAdapter(options, {
    version: async () => CLAUDE_COMPATIBILITY,
    createTransport: transport => new JsonLineTransport({ ...transport, executable: process.execPath, args: [fake, ...transport.args], environment: { ...process.env } })
  }) }
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

  it('hands steers sent just before a restart over exactly once and completes the turn (V3 S2)', async () => {
    writeFileSync(fake, STEERING_CLAUDE)
    const workspace = join(root, 'workspace-steer'); mkdirSync(workspace)
    const databasePath = join(root, 'steer.db')
    const first = await app(databasePath)
    const project = first.database.upsertProject(workspace, 'Steer project')
    const spec: AgentSpec = { id: 'steer-agent', projectId: project.id, sessionId: first.database.listSessions(project.id)[0]!.id, provider: 'claude', title: 'Steered', cwd: workspace }
    first.sessions.ensure(spec)
    await first.sessions.submit(spec.id, 'Start the long turn', settings)
    await until(() => assistantText(first.database, spec.id).some(text => text.includes('w3 ')), 'the turn to be under way')
    for (let index = 0; index < 4; index++) await first.sessions.steer(spec.id, `steer-${index}`, settings)
    // Some receipts arrive before the restart, the rest while no app is listening, and the last
    // steer is still being handed over when the restart begins.
    await until(() => (first.database.structured.snapshot(spec.id)!.pendingSteering ?? []).some(input => input.status === 'accepted'), 'the first native receipt')
    const lastSteer = first.sessions.steer(spec.id, 'steer-4', settings)
    expect(await first.sessions.detachForRestart()).toEqual([spec.id])
    await lastSteer
    expect(first.database.structured.snapshot(spec.id)!.pendingSteering).toHaveLength(5)
    first.sessions.dispose(); first.client.dispose(); first.database.close()
    await new Promise(resolve => setTimeout(resolve, 400))

    const second = await app(databasePath)
    // The kept process still holds every steer: none may come back as a message to resend.
    expect(second.database.structured.snapshot(spec.id)!.pendingSteering?.map(input => input.status)).toEqual(Array(5).fill('uncertain'))
    await second.sessions.reattach(spec.id)
    expect((second.database.structured.snapshot(spec.id)!.pendingSteering ?? []).filter(input => !['sending', 'accepted'].includes(input.status))).toEqual([])
    await until(() => {
      const state = second.database.structured.snapshot(spec.id)!
      return state.phase === 'completed' && !(state.pendingSteering?.length) && assistantText(second.database, spec.id).includes('ack:steer-4')
    }, 'every steer to be answered and the turn to complete', 20_000)
    second.sessions.flush()
    const state = second.database.structured.snapshot(spec.id)!
    expect(assistantText(second.database, spec.id).filter(text => text.startsWith('ack:'))).toEqual([0, 1, 2, 3, 4].map(index => `ack:steer-${index}`))
    const userTexts = state.items.filter(item => item.data.type === 'text' && item.data.role === 'user').map(item => (item.data as { text: string }).text)
    expect(userTexts.filter(text => text.startsWith('steer-'))).toEqual([0, 1, 2, 3, 4].map(index => `steer-${index}`))
    expect(state.queuedPrompts ?? []).toEqual([])
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

  it('answers a kept turn\'s tool hook and MCP call made while no app ran, from the next app (FX16)', async () => {
    writeFileSync(fake, TOOLS_CLAUDE)
    const workspace = join(root, 'workspace-tools'); mkdirSync(workspace)
    const databasePath = join(root, 'tools.db')
    const before = await mcpServer('a'.repeat(64), root)
    mcpConfig = before.config
    const first = await app(databasePath)
    const project = first.database.upsertProject(workspace, 'Tools project')
    const spec: AgentSpec = { id: 'tools-agent', projectId: project.id, sessionId: first.database.listSessions(project.id)[0]!.id, provider: 'claude', title: 'Wizard', cwd: workspace }
    first.sessions.ensure(spec)
    await first.sessions.submit(spec.id, 'Use a tool after the restart', settings)
    await until(() => assistantText(first.database, spec.id).includes('waiting'), 'the turn to be under way')
    expect(await first.sessions.detachForRestart()).toEqual([spec.id])
    first.sessions.dispose(); first.client.dispose(); first.database.close()
    await before.close()

    // No app runs: the CLI's hook and MCP call wait in the runtime host for the next one.
    writeFileSync(join(workspace, 'go'), '')
    await new Promise(resolve => setTimeout(resolve, 1500))

    // The next app serves its MCP server on another port with another credential.
    const after = await mcpServer('b'.repeat(64), root)
    cleanup.push(() => { void after.close() })
    mcpConfig = after.config
    const second = await app(databasePath)
    await second.sessions.reattach(spec.id)
    await until(() => second.database.structured.snapshot(spec.id)!.phase === 'completed', 'the turn to complete', 20_000)
    const report = assistantText(second.database, spec.id).find(text => text.startsWith('hook timeout'))
    expect(report).toBe('hook timeout 900; hook success; mcp 200 {"served":"bbbb"}')
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
