import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalAdapter, LocalSetupError, localModelAvailability, phaseFor, releaseVerdict } from './local'
import { DEFAULT_SANDBOX, QWEN_35B, QWEN_9B, modelDir, runFile } from '../local-models/config.ts'
import type { LocalModelConfig } from '../local-models/config.ts'
import * as localPaths from '../local-models/paths.ts'
import * as resources from '../local-models/resource-guard.ts'
import type { AdapterEvent, SessionSettings } from '../../shared/structured-agent'
import { localStopOf } from '../../shared/local-stop.ts'

/** Synthetic server state needs no model disk or writable secondary drive. */
function scratchRoot(): string | null {
  const root = mkdtempSync(join(tmpdir(), 'ConductorAdapterTest-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'runtime'))
  vi.spyOn(localPaths, 'layout').mockReturnValue(localPaths.layoutFor(root))
  return root
}

const KEY = 'a'.repeat(64)
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })

/** A stand-in llama.cpp server: it answers the health probe, enforces the key and replays
 *  scripted SSE frames, so the adapter can be driven end to end without a model. */
function stubServer(frames: string[], holdMs = 0, identity: { model: string; anonymous: boolean; contextTokens?: number } = { model: QWEN_9B, anonymous: false }): Promise<{ port: number; server: Server; identity: typeof identity; prompts: string[][]; requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> }> }> {
  const prompts: string[][] = []
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> }> = []
  const server = createServer((request, response) => {
    if (!identity.anonymous && request.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401).end('{}'); return }
    if (request.url === '/props' && identity.contextTokens) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ default_generation_settings: { n_ctx: identity.contextTokens } })); return }
    if (request.url === '/apply-template' || request.url === '/tokenize') { response.writeHead(404).end('{}'); return }
    if (request.url?.startsWith('/v1/models')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: identity.model }] })); return }
    // No /slots here, like a server built without it: the release policy then relies on what this process knows.
    if (request.method === 'GET') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> }
      requests.push(parsed)
      prompts.push(parsed.messages.filter(message => message.role === 'user').map(message => message.content))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const write = (index: number): void => {
        if (index >= frames.length) { response.write('data: [DONE]\n\n'); response.end(); return }
        response.write(`data: ${frames[index]}\n\n`)
        setTimeout(() => write(index + 1), holdMs)
      }
      write(0)
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({ port: typeof address === 'object' && address ? address.port : 0, server, identity, prompts, requests })
  }))
}

const model = (id: string, port: number): Record<string, unknown> => ({
  id, label: id, repo: 'owner/repo', revision: 'a'.repeat(40), file: 'model.gguf', quant: 'Q4_K_M',
  sizeBytes: 1, sha256: 'b'.repeat(64), port, contextTokens: 32768, gpuLayers: 1, extraArgs: []
})

const settings = (overrides: Partial<SessionSettings> = {}): SessionSettings => ({ permission: 'accept-edits', plan: false, ...overrides })

describe('local provider adapter', () => {
  const previous = process.env.CONDUCTOR_LOCAL_ROOT
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
    vi.restoreAllMocks()
    if (previous === undefined) delete process.env.CONDUCTOR_LOCAL_ROOT
    else process.env.CONDUCTOR_LOCAL_ROOT = previous
  })

  /** A configured local stack whose two "servers" are the stubs handed in. */
  const stack = async (frames: string[], holdMs = 0): Promise<{ small: Awaited<ReturnType<typeof stubServer>>; large: Awaited<ReturnType<typeof stubServer>>; workspace: string }> => {
    const root = scratchRoot()
    if (!root) throw new Error('skip')
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const small = await stubServer(frames, holdMs)
    const large = await stubServer(frames, holdMs, { model: QWEN_35B, anonymous: false })
    cleanup.push(() => new Promise<void>(done => small.server.close(() => done())))
    cleanup.push(() => new Promise<void>(done => large.server.close(() => done())))
    writeFileSync(join(root, 'config', 'api-key'), KEY + '\n', 'utf8')
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({
      version: 1, llamaServer: 'llama-server', llamaVersion: 'stub 1.0',
      models: { [QWEN_9B]: model(QWEN_9B, small.port), [QWEN_35B]: model(QWEN_35B, large.port) },
      sandbox: DEFAULT_SANDBOX
    }), 'utf8')
    process.env.CONDUCTOR_LOCAL_ROOT = root
    for (const id of [QWEN_9B, QWEN_35B]) {
      const configured = model(id, id === QWEN_9B ? small.port : large.port) as unknown as LocalModelConfig
      mkdirSync(modelDir(configured), { recursive: true })
      writeFileSync(join(modelDir(configured), configured.file), 'fixture', 'utf8')
    }
    const workspace = mkdtempSync(join(root, 'ws-'))
    return { small, large, workspace }
  }

  const adapter = (workspace: string, events: AdapterEvent[], overrides: Partial<SessionSettings> = {}): LocalAdapter => {
    const instance = new LocalAdapter({ executable: 'llama-server', cwd: workspace, runtimeId: 'runtime-' + Math.random().toString(36).slice(2, 8), settings: settings(overrides), emit: event => events.push(event) })
    cleanup.push(() => instance.dispose())
    return instance
  }
  const settled = async (events: AdapterEvent[]): Promise<string> => {
    for (let tick = 0; tick < 200; tick++) {
      const phase = events.map(event => event.data.type === 'session' ? event.data.phase : '').filter(Boolean).at(-1)
      if (phase && !['starting', 'running', 'idle'].includes(phase)) return phase
      await new Promise(done => setTimeout(done, 25))
    }
    throw new Error('turn never settled: ' + JSON.stringify(events.map(event => event.data.type)))
  }
  const texts = (events: AdapterEvent[], role: 'assistant' | 'status'): string =>
    events.filter(event => event.data.type === 'text' && event.data.role === role).map(event => event.data.type === 'text' ? event.data.text : '').join('')

  it('restores registered task state on start without submitting or replaying a turn', async () => {
    const { small, workspace } = await stack([frame({ content: 'Recorded answer.' }, 'stop')])
    let saved: unknown
    const checkpoint = { load: () => saved, save: async (value: unknown) => { saved = structuredClone(value) } }
    const events: AdapterEvent[] = []
    const first = new LocalAdapter({ executable: '', cwd: workspace, runtimeId: 'old-runtime', localTaskId: 'registered-task', localCheckpoint: checkpoint, settings: settings({ permission: 'read-only' }), emit: event => events.push(event) })
    cleanup.push(() => first.dispose())
    await first.start()
    await first.submit('Keep this original input.', settings({ permission: 'read-only' }))
    expect(await settled(events)).toBe('completed')
    const before = first.runStatus()
    expect(saved).toMatchObject({ taskId: 'registered-task' })
    first.dispose()
    const restored = new LocalAdapter({ executable: '', cwd: workspace, runtimeId: 'replacement-runtime', localTaskId: 'registered-task', localCheckpoint: checkpoint, settings: settings({ permission: 'read-only' }), emit: () => {} })
    cleanup.push(() => restored.dispose())
    const requests = small.requests.length
    await restored.start()
    expect(restored.runStatus()).toEqual(before)
    await restored.start()
    expect(small.requests).toHaveLength(requests)
  })

  it.each(['cancelled', 'blocked', 'pending'] as const)('does not restart %s work while restoring a view', async lifecycle => {
    const { small, workspace } = await stack([frame({ content: 'Recorded answer.' }, 'stop')])
    let saved: unknown
    const checkpoint = { load: () => saved, save: async (value: unknown) => { saved = structuredClone(value) } }
    const events: AdapterEvent[] = []
    const first = new LocalAdapter({ executable: '', cwd: workspace, runtimeId: 'old-runtime', localTaskId: 'registered-task', localCheckpoint: checkpoint, settings: settings({ permission: 'read-only' }), emit: event => events.push(event) })
    cleanup.push(() => first.dispose())
    await first.submit('Keep this input.', settings({ permission: 'read-only' }))
    expect(await settled(events)).toBe('completed')
    const stored = saved as { state: { execution: { lifecycle: string; pending?: { id: string; name: string; arguments: string } } } }
    stored.state.execution.lifecycle = lifecycle === 'pending' ? 'running' : lifecycle
    if (lifecycle === 'pending') stored.state.execution.pending = { id: 'mutation-before-crash', name: 'write_file', arguments: '{"path":"never-replay.txt","content":"private"}' }
    first.dispose()
    const restored = new LocalAdapter({ executable: '', cwd: workspace, runtimeId: 'new-runtime', localTaskId: 'registered-task', localCheckpoint: checkpoint, settings: settings({ permission: 'read-only' }), emit: () => {} })
    cleanup.push(() => restored.dispose())
    const requests = small.requests.length
    await restored.start()
    expect(restored.runStatus()).toMatchObject({ execution: { lifecycle: lifecycle === 'pending' ? 'blocked' : lifecycle } })
    if (lifecycle === 'pending') expect(restored.runStatus()).toMatchObject({ execution: { pending: { id: 'mutation-before-crash' } } })
    expect(small.requests).toHaveLength(requests)
    expect(existsSync(join(workspace, 'never-replay.txt'))).toBe(false)
  })

  it('says whether a local model can start now: an idle server of ours gives way, a mid-turn one is named', async () => {
    const { small, large, workspace } = await stack([frame({ content: 'ok' }, 'stop')], 600)
    vi.spyOn(resources, 'runningLlamaProcesses').mockReturnValue([])
    // Only the small model's server is up, recorded as started by this process.
    await new Promise<void>(done => large.server.close(() => done()))
    writeFileSync(runFile(model(QWEN_9B, small.port) as unknown as LocalModelConfig), JSON.stringify({ pid: process.pid, port: small.port, model: QWEN_9B, file: 'model.gguf', startedAt: '2026-09-22' }), 'utf8')
    expect(await localModelAvailability(QWEN_9B)).toMatchObject({ available: true, note: expect.stringContaining('already running') })
    expect(await localModelAvailability(QWEN_35B)).toMatchObject({ available: true, note: expect.stringContaining('idle') })
    expect(await localModelAvailability('local/not-configured')).toMatchObject({ available: false, reason: expect.stringContaining('not configured') })
    const events: AdapterEvent[] = []
    const instance = adapter(workspace, events)
    await instance.submit('hello', settings())
    await vi.waitFor(async () => expect(await localModelAvailability(QWEN_35B)).toMatchObject({ available: false, reason: expect.stringContaining('mid-turn') }))
    expect(await settled(events)).toBe('completed')
    expect(await localModelAvailability(QWEN_35B)).toMatchObject({ available: true })
  })

  it('lets an idle server go and names a mid-turn conversation or a busy slot', async () => {
    const running = { model: QWEN_9B, port: 1, pid: 1, ours: true }
    expect(await releaseVerdict(running, KEY, { inFlight: new Map(), slots: async () => false })).toBe('idle')
    expect(await releaseVerdict(running, KEY, { inFlight: new Map([[QWEN_9B, new Set(['a'])]]), slots: async () => false })).toContain('mid-turn')
    expect(await releaseVerdict(running, KEY, { inFlight: new Map(), slots: async () => true })).toContain('generating')
  })

  it('carries an actionable setup code and public guide without local configuration details', () => {
    const error = new LocalSetupError('Qwen 3.5 9B is not installed.')
    expect(error).toMatchObject({ code: 'local-setup-required', actionUrl: 'https://github.com/Empire024/conductor/blob/main/docs/local-models.md' })
    expect(error.message).toContain('Download or set up the local model')
  })

  it('refuses a foreign healthy server before sending any conversation', async () => {
    const ready = await stack([frame({ content: 'must not receive a prompt' }, 'stop')])
    ready.small.identity.model = 'local/foreign-model'
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events, { model: QWEN_9B })
    await instance.start()
    await instance.submit('must not send', settings({ model: QWEN_9B }))
    expect(await settled(events)).toBe('failed')
    expect(events.some(event => event.data.type === 'error' && /Cannot start/.test(event.data.message))).toBe(true)
    expect(ready.small.requests).toHaveLength(0)
    expect(ready.large.requests).toHaveLength(0)
  })

  it('refuses a server impersonating the requested id without enforcing the key', async () => {
    const ready = await stack([frame({ content: 'must not receive a prompt' }, 'stop')])
    ready.small.identity.anonymous = true
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events, { model: QWEN_9B })
    await instance.start()
    await instance.submit('must not send', settings({ model: QWEN_9B }))
    expect(await settled(events)).toBe('failed')
    expect(events.some(event => event.data.type === 'error' && /Cannot start/.test(event.data.message))).toBe(true)
    expect(ready.small.requests).toHaveLength(0)
  })

  it('emits full prompt and cache usage with server timing telemetry', async () => {
    const ready = await stack([frame({ content: 'ok' }, 'stop'), JSON.stringify({ choices: [], usage: { prompt_tokens: 2100, completion_tokens: 3, total_tokens: 2103, prompt_tokens_details: { cached_tokens: 2000 } }, timings: { cache_n: 2000, prompt_n: 100, prompt_ms: 90, predicted_ms: 30 } })])
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events)
    await instance.start()
    await instance.submit('answer', settings())
    expect(await settled(events)).toBe('completed')
    expect(events.find(event => event.data.type === 'usage')).toMatchObject({ itemId: expect.stringContaining(':usage:0'), data: { scope: 'message', inputTokens: 2100, cachedTokens: 2000, outputTokens: 3, totalTokens: 2103 }, native: { method: 'llama.cpp/timings', payload: { cache_n: 2000, prompt_n: 100, prompt_ms: 90, predicted_ms: 30 } } })
    // Context figures the ring and "Model context window" read, as the CLIs report them: the
    // configured 32,768-token window, capacity once this round's answer reserve (the policy's
    // tool-round reserve, 2,560 tokens) is held back, and the reserve itself so the pane can say so.
    expect(events.find(event => event.data.type === 'usage')).toMatchObject({ data: { limits: { contextUsedTokens: 2103, contextCapacityTokens: 32768 - 2560, contextReserveTokens: 2560, modelContextWindow: 32768 } } })
  })

  it('emits the actual server context ceiling and leaves missing occupancy unknown', async () => {
    const ready = await stack([frame({ content: 'ok' }, 'stop'), JSON.stringify({ choices: [], usage: { completion_tokens: 3 } })])
    ready.small.identity.contextTokens = 8192
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events, { permission: 'read-only' })
    await instance.submit('answer', settings({ permission: 'read-only' }))
    expect(await settled(events)).toBe('completed')
    const usage = events.find(event => event.data.type === 'usage')
    expect(usage).toMatchObject({ data: { scope: 'message', limits: { modelContextWindow: 8192, contextCapacityTokens: 8192 - 2560, contextMeasurement: expect.stringContaining('unknown') } } })
    expect(usage?.data.type === 'usage' && usage.data.limits).toHaveProperty('contextUsedTokens', null)
    expect(events.some(event => event.data.type === 'notice' && (event.data.payload as Record<string, unknown> | undefined)?.localEndpointContext)).toBe(true)
  })

  const guard = (reason: unknown): void => { if (!(reason instanceof Error) || reason.message !== 'skip') throw reason }

  /** A port nothing is listening on: bound just long enough to be told a number, then released. */
  const closedPort = async (): Promise<number> => {
    const probe = createTcpServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    return port
  }

  it('offers both Qwen models under their canonical ids, with no capability it cannot honour', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    try { ready = await stack([]) } catch (reason) { return guard(reason) }
    const capabilities = adapter(ready.workspace, []).capabilities
    expect(capabilities.provider).toBe('local')
    expect(capabilities.models).toEqual([
      { id: QWEN_9B, label: 'Qwen 3.5 9B', isDefault: true },
      { id: QWEN_35B, label: 'Qwen 3.6 35B-A3B', isDefault: false }
    ])
    // Nothing here ever asks, resumes or forks, so none of it is advertised; Edit is first and
    // is therefore the mode a new conversation opens in.
    expect(capabilities.permissions).toEqual(['accept-edits', 'read-only'])
    expect([capabilities.approvals, capabilities.questions, capabilities.resume, capabilities.fork, capabilities.plans]).toEqual([false, false, false, false, false])
  })

  it('returns from submit before the turn finishes, then streams text and reasoning separately', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    try { ready = await stack([frame({ reasoning_content: 'weighing it up' }), frame({ content: 'LOCAL_OK' }), frame({}, 'stop')], 40) } catch (reason) { return guard(reason) }
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events)
    await instance.start()
    await instance.submit('say it', settings())
    // The composer clears its draft on this promise, so it must resolve while the turn runs.
    expect(events.some(event => event.data.type === 'session' && event.data.phase === 'running')).toBe(true)
    expect(events.some(event => event.data.type === 'text')).toBe(false)
    expect(await settled(events)).toBe('completed')
    expect(texts(events, 'assistant')).toBe('LOCAL_OK')
    // Qwen's thinking is a status item, never mixed into the answer.
    expect(texts(events, 'status')).toBe('weighing it up')
    expect(ready.small.prompts.at(-1)).toEqual(['say it'])
    expect(ready.large.prompts).toEqual([])
  })

  it('offers web search and states the git grant only when the conversation was granted them', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    try { ready = await stack([frame({ content: 'ok' }), frame({}, 'stop')]) } catch (reason) { return guard(reason) }
    const plainEvents: AdapterEvent[] = []
    const plain = adapter(ready.workspace, plainEvents)
    await plain.start()
    await plain.submit('research this', settings())
    expect(await settled(plainEvents)).toBe('completed')
    const ungranted = ready.small.requests.at(-1)!
    expect(ungranted.tools?.map(tool => tool.function.name)).not.toContain('web_search')
    expect(ungranted.messages[0]!.content).toContain('.git directory is mounted read-only')
    expect(ungranted.messages[0]!.content).toContain('no web search tool')

    const grantedEvents: AdapterEvent[] = []
    const granted = adapter(ready.workspace, grantedEvents, { localGit: true, localResearch: true })
    await granted.start()
    await granted.submit('research this', settings({ localGit: true, localResearch: true }))
    expect(await settled(grantedEvents)).toBe('completed')
    const request = ready.small.requests.at(-1)!
    expect(request.tools?.map(tool => tool.function.name)).toContain('web_search')
    expect(request.messages[0]!.content).toContain('deep research')
    expect(request.messages[0]!.content).toContain('granted repository writes')
    // The sandbox still has no network; the grant tells the model the push runs on the host.
    expect(request.messages[0]!.content).toContain('brokered for you on the host')
    expect(ungranted.messages[0]!.content).not.toContain('brokered for you on the host')
  })

  it('sends a conversation only to the model it was opened on, and keeps two sessions apart', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    try { ready = await stack([frame({ content: 'ok' }), frame({}, 'stop')]) } catch (reason) { return guard(reason) }
    const firstEvents: AdapterEvent[] = [], secondEvents: AdapterEvent[] = []
    const first = adapter(ready.workspace, firstEvents, { model: QWEN_9B })
    const second = adapter(ready.workspace, secondEvents, { model: QWEN_35B })
    await first.submit('to the small one', settings({ model: QWEN_9B }))
    await second.submit('to the big one', settings({ model: QWEN_35B }))
    expect(await settled(firstEvents)).toBe('completed')
    expect(await settled(secondEvents)).toBe('completed')
    expect(ready.small.prompts).toEqual([['to the small one']])
    expect(ready.large.prompts).toEqual([['to the big one']])
    // A second turn on the first conversation carries its own history and nothing of the other's.
    await first.submit('and again', settings({ model: QWEN_9B }))
    expect(await settled(firstEvents)).toBe('completed')
    expect(ready.small.prompts.at(-1)).toEqual(['to the small one', 'and again'])
  })

  it('reports an interrupted turn as interrupted rather than failed', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    try { ready = await stack([frame({ content: 'one ' }), frame({ content: 'two ' }), frame({ content: 'three' }), frame({}, 'stop')], 120) } catch (reason) { return guard(reason) }
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events)
    await instance.submit('count', settings())
    await new Promise(done => setTimeout(done, 150))
    await instance.interrupt()
    expect(await settled(events)).toBe('interrupted')
    expect(events.some(event => event.data.type === 'error')).toBe(false)
  })

  it('ends a run that repeats one failing call with a failed phase and a stop report the pane and a controller can read', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    // The stub replays the same read of a missing file on every request: the loop notices.
    try { ready = await stack([frame({ tool_calls: [{ index: 0, id: 'same', function: { name: 'read_file', arguments: '{"path":"missing.txt"}' } }] }, 'tool_calls')]) } catch (reason) { return guard(reason) }
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events)
    await instance.submit('open it', settings())
    expect(await settled(events)).toBe('failed')
    const report = events.map(event => localStopOf(event.data)).find(Boolean)
    expect(report).toMatchObject({ reason: 'stagnation', rounds: 6, hardLimit: 72, task: { segmentLimit: 24 }, loopWarnings: 1, context: { windowTokens: 32768, reserveTokens: 2560 } })
    const notice = events.find(event => event.data.type === 'notice' && localStopOf(event.data))
    expect(notice && notice.data.type === 'notice' ? notice.data.message : '').toMatch(/^Stopped: repeating without progress after 6 of 72 tool rounds/)
    expect(ready.small.requests.length).toBe(6)
    expect(instance.runStatus()).toMatchObject({ task: 'open it', filesChanged: [] })
  })

  /**
   * The port in config is only a request: a server that could not bind it moved to a neighbouring
   * or OS-assigned one and recorded where it landed, which is what every other client reads. If
   * the adapter's own pre-turn health check asks the configured port instead, it fails on every
   * single turn - announcing a start and making a redundant one - for a server that is up.
   */
  it('health-checks the port the running server recorded, not the one config asked for', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    try { ready = await stack([frame({ content: 'ok' }), frame({}, 'stop')]) } catch (reason) { return guard(reason) }
    const root = process.env.CONDUCTOR_LOCAL_ROOT!
    // Nothing is listening on the configured port: the server moved, exactly as a reserved range
    // would force it to, and said so in its run record.
    const abandoned = await closedPort()
    const config = JSON.parse(readFileSync(join(root, 'config', 'config.json'), 'utf8')) as { models: Record<string, LocalModelConfig> }
    config.models[QWEN_9B]!.port = abandoned
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify(config), 'utf8')
    mkdirSync(join(root, 'runtime'), { recursive: true })
    writeFileSync(runFile(config.models[QWEN_9B]!), JSON.stringify({ pid: null, port: ready.small.port, model: QWEN_9B, file: 'model.gguf', startedAt: new Date().toISOString() }), 'utf8')

    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events, { model: QWEN_9B })
    await instance.start()
    await instance.submit('say it', settings({ model: QWEN_9B }))
    expect(await settled(events)).toBe('completed')
    // No start was announced and none was attempted: the recorded port answered.
    expect(JSON.stringify(events)).not.toContain('Starting')
    expect(ready.small.prompts.at(-1)).toEqual(['say it'])
  })

  it('reports a refused key as something the owner can act on, without echoing the key', async () => {
    let ready: Awaited<ReturnType<typeof stack>>
    try { ready = await stack([frame({ content: 'never sent' })]) } catch (reason) { return guard(reason) }
    writeFileSync(join(process.env.CONDUCTOR_LOCAL_ROOT!, 'config', 'api-key'), 'c'.repeat(64) + '\n', 'utf8')
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events)
    await instance.start()
    await instance.submit('must not send', settings())
    expect(await settled(events)).toBe('failed')
    expect(events.some(event => event.data.type === 'error' && /Local model failed to start|not answering|llama/i.test(event.data.message))).toBe(true)
    expect(JSON.stringify(events)).not.toContain(KEY)
  })
})

describe('local stop diagnostics', () => {
  it('maps every stop reason to a phase a controller can trust', () => {
    expect(phaseFor({ stopReason: 'completed', text: 'done' })).toBe('completed')
    expect(phaseFor({ stopReason: 'interrupted', text: '' })).toBe('interrupted')
    expect(phaseFor({ stopReason: 'output_limit', text: 'half an ans' })).toBe('completed')
    expect(phaseFor({ stopReason: 'output_limit', text: '' })).toBe('failed')
    for (const reason of ['round_limit', 'stagnation', 'context_limit', 'unverified_claim', 'provider_error', 'empty_answer'] as const) expect(phaseFor({ stopReason: reason, text: 'text' }), reason).toBe('failed')
  })
})
