import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalAdapter } from './local'
import { DEFAULT_SANDBOX, QWEN_35B, QWEN_9B, runFile } from '../local-models/config.ts'
import type { LocalModelConfig } from '../local-models/config.ts'
import * as localPaths from '../local-models/paths.ts'
import type { AdapterEvent, SessionSettings } from '../../shared/structured-agent'

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
function stubServer(frames: string[], holdMs = 0, identity = { model: QWEN_9B, anonymous: false }): Promise<{ port: number; server: Server; identity: typeof identity; prompts: string[][]; requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> }> }> {
  const prompts: string[][] = []
  const requests: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string; description: string } }> }> = []
  const server = createServer((request, response) => {
    if (!identity.anonymous && request.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401).end('{}'); return }
    if (request.url?.startsWith('/v1/models')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: identity.model }] })); return }
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

  it('refuses a foreign healthy server before sending any conversation', async () => {
    const ready = await stack([frame({ content: 'must not receive a prompt' }, 'stop')])
    ready.small.identity.model = 'local/foreign-model'
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events, { model: QWEN_9B })
    await expect(instance.start()).rejects.toThrow('Cannot start')
    expect(ready.small.requests).toHaveLength(0)
    expect(ready.large.requests).toHaveLength(0)
  })

  it('refuses a server impersonating the requested id without enforcing the key', async () => {
    const ready = await stack([frame({ content: 'must not receive a prompt' }, 'stop')])
    ready.small.identity.anonymous = true
    const instance = adapter(ready.workspace, [], { model: QWEN_9B })
    await expect(instance.start()).rejects.toThrow('Cannot start')
    expect(ready.small.requests).toHaveLength(0)
  })

  it('emits full prompt and cache usage with server timing telemetry', async () => {
    const ready = await stack([frame({ content: 'ok' }, 'stop'), JSON.stringify({ choices: [], usage: { prompt_tokens: 2100, completion_tokens: 3, total_tokens: 2103, prompt_tokens_details: { cached_tokens: 2000 } }, timings: { cache_n: 2000, prompt_n: 100, prompt_ms: 90, predicted_ms: 30 } })])
    const events: AdapterEvent[] = []
    const instance = adapter(ready.workspace, events)
    await instance.start()
    await instance.submit('answer', settings())
    expect(await settled(events)).toBe('completed')
    expect(events.find(event => event.data.type === 'usage')).toMatchObject({ data: { inputTokens: 2100, cachedTokens: 2000, outputTokens: 3, totalTokens: 2103 }, native: { method: 'llama.cpp/timings', payload: { cache_n: 2000, prompt_n: 100, prompt_ms: 90, predicted_ms: 30 } } })
    // Context figures the ring and "Model context window" read, as the CLIs report them: the
    // configured 32,768-token window, capacity once the 4,096-token answer reserve is held back.
    expect(events.find(event => event.data.type === 'usage')).toMatchObject({ data: { limits: { contextUsedTokens: 2103, contextCapacityTokens: 32768 - 4096, modelContextWindow: 32768 } } })
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
    await expect(instance.start()).rejects.toThrow(/Local model failed to start|not answering|llama/i)
    expect(JSON.stringify(events)).not.toContain(KEY)
  })
})
