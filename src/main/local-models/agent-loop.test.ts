import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentSession } from './agent.ts'
import { runTool } from './tools.ts'
import type { Usage } from './client.ts'

/** A stand-in for llama.cpp's OpenAI-compatible endpoint: it checks the API key, records the
 *  requests, and replays scripted SSE frames. Enough to exercise streaming, tool dispatch and
 *  message threading without a model. */
function stubServer(scripts: string[][], failures: Array<{ status: number; body: string }> = []): Promise<{ endpoint: string; server: Server; requests: Array<Record<string, unknown>>; unauthorized: number }> {
  const requests: Array<Record<string, unknown>> = []
  const state = { unauthorized: 0 }
  let turn = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      if (request.headers.authorization !== 'Bearer ' + 'k'.repeat(64)) {
        state.unauthorized++
        response.writeHead(401).end('{}')
        return
      }
      requests.push(JSON.parse(body) as Record<string, unknown>)
      // A scripted refusal for this turn, exactly as llama.cpp reports one: a status and a
      // JSON error body, with no stream at all.
      const refusal = failures[turn]
      if (refusal) { turn++; response.writeHead(refusal.status, { 'Content-Type': 'application/json' }).end(refusal.body); return }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const frame of scripts[Math.min(turn, scripts.length - 1)] ?? []) response.write(`data: ${frame}\n\n`)
      turn++
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve({ endpoint: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, server, requests, get unauthorized() { return state.unauthorized } })
  }))
}

const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })

describe('local agent loop', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-loop-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42\n', 'utf8')
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    return root
  }

  it('reaches a tail answer within two requests and keeps the full output for review', async () => {
    const raw = 'HEAD\n' + 'payload '.repeat(6000) + '\nTAIL_ANSWER=7319\n'
    const root = workspace()
    writeFileSync(join(root, 'long.txt'), raw)
    let requests = 0
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        requests++
        const sent = JSON.parse(body) as { messages: Array<{ role: string; content: string }> }
        const result = sent.messages.find(message => message.role === 'tool')
        const reply = result
          ? frame({ content: result.content.includes('TAIL_ANSWER=7319') ? '7319' : 'TAIL_MISSING' }, 'stop')
          : frame({ tool_calls: [{ index: 0, id: 'tail', function: { name: 'read_file', arguments: '{"path":"long.txt"}' } }] }, 'tool_calls')
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${reply}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => server.close())
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const session = new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: root, sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768, maxIterations: 2 })
    const reviewed: string[] = []
    expect(await session.run('Read long.txt and answer with the tail marker', { toolEnd: call => reviewed.push(call.output) })).toEqual({ text: '7319', stopReason: 'complete' })
    expect(requests).toBe(2)
    expect(reviewed[0]).toContain(raw)
    expect(reviewed[0]!.length).toBeGreaterThan(32000)
  })

  it('keeps every result from a large parallel read group in the next request', async () => {
    const root = workspace()
    const paths = Array.from({ length: 5 }, (_value, index) => `large-${index}.txt`)
    for (const [index, path] of paths.entries()) writeFileSync(join(root, path), `FILE_${index}\n${String(index).repeat(24_000)}\nEND_${index}`)
    let requests = 0
    let secondOutbound: Array<{ role: string; toolCallId?: string; chars: number; digest: string }> = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        requests++
        const sent = JSON.parse(body) as { messages: Array<{ role: string; content: string; tool_call_id?: string }> }
        if (requests === 2) secondOutbound = sent.messages.map(message => ({
          role: message.role,
          ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
          chars: message.content.length,
          digest: createHash('sha256').update(message.content).digest('hex').slice(0, 12)
        }))
        const results = sent.messages.filter(message => message.role === 'tool')
        const complete = paths.every((_path, index) => results.some(result => result.tool_call_id === `read-${index}` && result.content.includes(`FILE_${index}`)))
        const reply = requests === 1
          ? frame({ tool_calls: paths.map((path, index) => ({ index, id: `read-${index}`, function: { name: 'read_file', arguments: JSON.stringify({ path }) } })) }, 'tool_calls')
          : frame({ content: complete ? 'ALL_RESULTS_REACHED_MODEL' : 'RESULTS_DROPPED' }, 'stop')
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${reply}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => server.close())
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const session = new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: root, sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768, maxIterations: 2 })

    expect(await session.run('Read all five files once, then report completion', {})).toEqual({ text: 'ALL_RESULTS_REACHED_MODEL', stopReason: 'complete' })
    expect(requests).toBe(2)
    expect(secondOutbound.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'tool'])
    expect(secondOutbound.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(paths.map((_path, index) => `read-${index}`))
    expect(new Set(secondOutbound.filter(message => message.role === 'tool').map(message => message.digest)).size).toBe(5)
    expect(secondOutbound.filter(message => message.role === 'tool').every(message => message.chars > 1_000 && message.chars < 20_000)).toBe(true)
  })

  it('reports read ranges and validates positive line offsets without changing schema order', async () => {
    const root = workspace()
    writeFileSync(join(root, 'lines.txt'), 'one\ntwo\nthree\n')
    const context = { workspace: root, readOnly: true, sandbox: null, timeoutSec: 30 }
    const read = (args: Record<string, unknown>) => runTool('read_file', JSON.stringify({ path: 'lines.txt', ...args }), context)
    expect((await read({ offset: 2, limit: 1 })).output).toContain('total_lines=3; returned_lines=2-2; truncated=true')
    expect((await read({ offset: 2, limit: 1 })).output.endsWith('\ntwo')).toBe(true)
    expect((await read({})).output).toContain('returned_lines=1-3; truncated=false')
    expect((await read({ offset: 5 })).output).toContain('returned_lines=0-0; truncated=true')
    for (const offset of [-1, 0, 1.5, '2']) {
      expect(await read({ offset })).toMatchObject({ failed: true })
      expect((await read({ offset })).output).toContain('positive 1-based line number')
    }
    writeFileSync(join(root, 'lines.txt'), '')
    expect((await read({})).output).toContain('total_lines=0; returned_lines=0-0; truncated=false')
  })

  it('retains full prompt occupancy, cached tokens and timing-only SSE frames in telemetry', async () => {
    const stub = await stubServer([[frame({ content: 'ok' }, 'stop'), JSON.stringify({ choices: [], timings: { cache_n: 1950, prompt_n: 50, prompt_ms: 100, predicted_n: 2, predicted_ms: 20, unexpected: 'discard', prompt_per_second: -1 } }), JSON.stringify({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 2, total_tokens: 2002, prompt_tokens_details: { cached_tokens: 1950 } } })]])
    cleanup.push(() => stub.server.close())
    const usage: Usage[] = []
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    await session.run('answer', { usage: value => usage.push(value) })
    expect(usage).toEqual([{ inputTokens: 2000, outputTokens: 2, totalTokens: 2002, cachedTokens: 1950, timings: { cache_n: 1950, prompt_n: 50, prompt_ms: 100, predicted_n: 2, predicted_ms: 20 } }])
  })

  it('refuses final overflow after trimming and repair without issuing HTTP or a retry', async () => {
    const stub = await stubServer([[frame({ content: 'must not be requested' }, 'stop')]])
    cleanup.push(() => stub.server.close())
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 8192 })
    await expect(session.run('x'.repeat(30000), {})).rejects.toThrow('No request was sent')
    expect(stub.requests).toHaveLength(0)
  })

  it('repairs interrupted multi-tool groups before the next turn and never executes skipped calls', async () => {
    const stub = await stubServer([
      [frame({ tool_calls: [
        { index: 0, id: 'first', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } },
        { index: 1, id: 'skipped', function: { name: 'write_file', arguments: '{"path":"forbidden.txt","content":"late"}' } }
      ] }, 'tool_calls')],
      [frame({ content: 'Resumed cleanly' }, 'stop')]
    ])
    cleanup.push(() => stub.server.close())
    const root = workspace(), controller = new AbortController()
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: root, sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768 })
    const executed: string[] = []
    expect((await session.run('Read and write', { toolEnd: call => { executed.push(call.name); controller.abort() } }, controller.signal)).stopReason).toBe('interrupted')
    expect(executed).toEqual(['read_file'])
    expect((await session.run('Continue', {})).stopReason).toBe('complete')
    const messages = stub.requests[1]!.messages as Array<{ role: string; tool_call_id?: string; content: string }>
    expect(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(['first', 'skipped'])
    expect(messages.find(message => message.tool_call_id === 'skipped')?.content).toContain('Interrupted before execution')
  })

  it('uses the scoped memory callback and feeds its result to the real protocol shape', async () => {
    const stub = await stubServer([
      [frame({ tool_calls: [{ index: 0, id: 'remember', function: { name: 'conductor', arguments: '{"method":"memory.remember","args":{"gist":"Durable fixture fact","kind":"semantic"}}' } }] }, 'tool_calls')],
      [frame({ content: 'Remembered' }, 'stop')]
    ])
    cleanup.push(() => stub.server.close())
    const remembered: unknown[] = []
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768, control: async (method, args) => { remembered.push({ method, args }); return { id: 'memory-from-host' } } })
    expect((await session.run('Remember this', {})).stopReason).toBe('complete')
    expect(remembered).toEqual([{ method: 'memory.remember', args: { gist: 'Durable fixture fact', kind: 'semantic' } }])
    expect(JSON.stringify(stub.requests[1]!.messages)).toContain('memory-from-host')
  })

  it('streams text, runs an allowed tool and feeds the result back', async () => {
    const stub = await stubServer([
      [frame({ content: 'Looking' }), frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } }] }, 'tool_calls')],
      [frame({ content: 'The answer is 42.' }, 'stop')]
    ])
    cleanup.push(() => stub.server.close())
    const root = workspace()
    const deltas: string[] = []
    const tools: string[] = []
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: root, sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768 })
    const outcome = await session.run('What is the answer?', { text: delta => deltas.push(delta), toolEnd: call => tools.push(`${call.name}:${call.failed ? 'failed' : 'ok'}`) })

    expect(outcome.stopReason).toBe('complete')
    expect(outcome.text).toBe('The answer is 42.')
    expect(deltas.join('')).toBe('LookingThe answer is 42.')
    expect(tools).toEqual(['read_file:ok'])
    const second = stub.requests[1] as { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool' })
    expect(second.messages.at(-1)!.content).toContain('export const answer = 42')
    expect(second.tools.map(tool => tool.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_read', 'write_file', 'edit_file', 'run_command'])
  })

  it('reports a refused capability to the model instead of executing it', async () => {
    const stub = await stubServer([
      [frame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'run_command', arguments: '{"command":"echo SHOULD_NOT_RUN_ON_HOST"}' } }] }, 'tool_calls')],
      [frame({ content: 'Execution is unavailable.' }, 'stop')]
    ])
    cleanup.push(() => stub.server.close())
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: false, timeoutSec: 30, contextTokens: 32768 })
    await session.run('Run something', {})
    const result = (stub.requests[1] as { messages: Array<{ role: string; content: string }> }).messages.at(-1)!
    expect(result.content).toMatch(/^denied: Sandbox unavailable/)
    expect(result.content).not.toContain('SHOULD_NOT_RUN_ON_HOST')
  })

  it('offers no write or execute tools in read-only mode', async () => {
    const stub = await stubServer([[frame({ content: 'Read only.' }, 'stop')]])
    cleanup.push(() => stub.server.close())
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    await session.run('Summarize', {})
    expect((stub.requests[0] as { tools: Array<{ function: { name: string } }> }).tools.map(tool => tool.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_read'])
  })

  it('repairs and retries once when the server refuses the request, then reports what it cannot fix', async () => {
    const refusal = JSON.stringify({ error: { type: 'invalid_request_error', message: 'tool_call_id not found in the preceding assistant message' } })
    const stub = await stubServer([[], [frame({ content: 'Recovered' }, 'stop')]], [{ status: 400, body: refusal }])
    cleanup.push(() => stub.server.close())
    const notices: string[] = []
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    expect((await session.run('Continue', { notice: message => notices.push(message) })).text).toBe('Recovered')
    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[0]!.reasoning_effort).toBe('none')
    // The retry gives up the optional parameter as well: an unrecognized one is refused with
    // the same status as a history the template cannot render.
    expect(stub.requests[1]!.reasoning_effort).toBeUndefined()
    expect(notices.join(' ')).toContain('HTTP 400')
  })

  it('names the context window when neither the first request nor the shorter retry fits', async () => {
    const overflow = JSON.stringify({ error: { type: 'exceed_context_size', message: 'the request exceeds the available context size' } })
    const stub = await stubServer([[]], [{ status: 400, body: overflow }, { status: 400, body: overflow }])
    cleanup.push(() => stub.server.close())
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    await expect(session.run('Continue', {})).rejects.toThrow(/32768 tokens of local context/)
    expect(stub.requests).toHaveLength(2)
  })

  it('asks once for the answer when a thinking model replies with reasoning only', async () => {
    const stub = await stubServer([
      [frame({ reasoning_content: 'Thinking about it at length' }, 'stop')],
      [frame({ content: 'The answer is 42.' }, 'stop')]
    ])
    cleanup.push(() => stub.server.close())
    const notices: string[] = []
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    const outcome = await session.run('What is the answer?', { notice: message => notices.push(message) })
    expect(outcome).toMatchObject({ stopReason: 'complete', text: 'The answer is 42.' })
    expect(notices.join(' ')).toContain('reasoning only')
    expect((stub.requests[1] as { messages: Array<{ role: string; content: string }> }).messages.at(-1)).toMatchObject({ role: 'user' })
  })

  it('keeps a truncated answer instead of failing the whole turn', async () => {
    const stub = await stubServer([[frame({ content: 'Half of an ans' }, 'length')]])
    cleanup.push(() => stub.server.close())
    const notices: string[] = []
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'k'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    expect(await session.run('Explain', { notice: message => notices.push(message) })).toMatchObject({ stopReason: 'complete', text: 'Half of an ans' })
    expect(notices.join(' ')).toContain('token limit')
  })

  it('fails the turn when the local API key is rejected', async () => {
    const stub = await stubServer([[frame({ content: 'never' }, 'stop')]])
    cleanup.push(() => stub.server.close())
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'w'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    await expect(session.run('hello', {})).rejects.toThrow(/API key/)
    expect(stub.unauthorized).toBe(1)
  })
})
