import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalAdapter } from './local'
import { DEFAULT_SANDBOX, QWEN_35B, QWEN_9B } from '../local-models/config.ts'
import { detectDrives, systemDrive } from '../local-models/paths.ts'
import type { AdapterEvent, SessionSettings } from '../../shared/structured-agent'

/** The local root is refused on the system drive by design, so these tests need a real fixed
 *  second drive and skip rather than pretend otherwise. */
function scratchRoot(): string | null {
  const drive = detectDrives().find(candidate => candidate.letter !== systemDrive() && candidate.freeBytes > 1024 ** 3)
  if (!drive) return null
  const root = join(drive.letter + '\\', `ConductorAdapterTest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(root, 'config'), { recursive: true })
  return root
}

const KEY = 'a'.repeat(64)
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })

/** A stand-in llama.cpp server: it answers the health probe, enforces the key and replays
 *  scripted SSE frames, so the adapter can be driven end to end without a model. */
function stubServer(frames: string[], holdMs = 0): Promise<{ port: number; server: Server; prompts: string[][] }> {
  const prompts: string[][] = []
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${KEY}`) { response.writeHead(401).end('{}'); return }
    if (request.url?.startsWith('/v1/models')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}'); return }
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> }
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
    resolve({ port: typeof address === 'object' && address ? address.port : 0, server, prompts })
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
    if (previous === undefined) delete process.env.CONDUCTOR_LOCAL_ROOT
    else process.env.CONDUCTOR_LOCAL_ROOT = previous
  })

  /** A configured local stack whose two "servers" are the stubs handed in. */
  const stack = async (frames: string[], holdMs = 0): Promise<{ small: Awaited<ReturnType<typeof stubServer>>; large: Awaited<ReturnType<typeof stubServer>>; workspace: string }> => {
    const root = scratchRoot()
    if (!root) throw new Error('skip')
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const small = await stubServer(frames, holdMs)
    const large = await stubServer(frames, holdMs)
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

  const guard = (reason: unknown): void => { if (!(reason instanceof Error) || reason.message !== 'skip') throw reason }

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
