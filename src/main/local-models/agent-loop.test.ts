import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentSession } from './agent.ts'

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
