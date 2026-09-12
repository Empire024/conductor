import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAgentSession } from './agent.ts'

/** A stand-in for llama.cpp's OpenAI-compatible endpoint: it checks the API key, records the
 *  requests, and replays scripted SSE frames. Enough to exercise streaming, tool dispatch and
 *  message threading without a model. */
function stubServer(scripts: string[][]): Promise<{ endpoint: string; server: Server; requests: Array<Record<string, unknown>>; unauthorized: number }> {
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
    expect(second.tools.map(tool => tool.function.name)).toEqual(['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'run_command'])
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
    expect((stub.requests[0] as { tools: Array<{ function: { name: string } }> }).tools.map(tool => tool.function.name)).toEqual(['read_file', 'list_files', 'search'])
  })

  it('fails the turn when the local API key is rejected', async () => {
    const stub = await stubServer([[frame({ content: 'never' }, 'stop')]])
    cleanup.push(() => stub.server.close())
    const session = new LocalAgentSession({ endpoint: stub.endpoint, apiKey: 'w'.repeat(64), model: 'local/qwen3.5-9b', workspace: workspace(), sandbox: null, readOnly: true, timeoutSec: 30, contextTokens: 32768 })
    await expect(session.run('hello', {})).rejects.toThrow(/API key/)
    expect(stub.unauthorized).toBe(1)
  })
})
