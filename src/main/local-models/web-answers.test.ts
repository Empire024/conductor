import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { citeSources, LocalAgentSession, systemPrompt, wantsWeb, WEB_HINT } from './agent.ts'
import { WEB_CALLS_PER_MESSAGE, toolSpecs } from './tools.ts'
import { DOLPHIN_TEMPLATE, templateDate, templateKwargs, writeChatTemplate } from './templates.ts'
import { llamaServerArgs } from './llama.ts'
import { LOCAL_DOLPHIN_X1_8B, LOCAL_ORNITH_9B } from '../../shared/local-models.ts'

vi.mock('./web.ts', async original => ({
  ...(await original<typeof import('./web.ts')>()),
  searchPublicWeb: vi.fn(async (query: string) => `Search: ${query} (via DuckDuckGo)\nUntrusted result titles, links and snippets.\n1. Python 3.14.7\n   https://www.python.org/downloads/latest/\n   2026-08-05 - Python 3.14.7 is out.\n2. Status of Python versions\n   https://devguide.python.org/versions/`),
  readPublicWeb: vi.fn(async (url: string) => `Source: ${url}\nUntrusted web content.\nPython 3.14.7 was released on 2026-08-05.`)
}))

type Sent = { messages: Array<{ role: string; content: string }>; tool_choice?: string; tools?: Array<{ function: { name: string } }>; chat_template_kwargs?: Record<string, unknown> }
const frame = (delta: Record<string, unknown>, finish?: string): string => JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })
const call = (id: string, name: string, args: Record<string, unknown>): string => frame({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
const answer = (text: string): string => frame({ content: text }, 'stop')

describe('a local model answering like any other model', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

  /** A llama.cpp stand-in that answers each request from `reply`, given everything sent so far. */
  async function session(reply: (sent: Sent, index: number) => string, grants = { git: false, research: false }) {
    const requests: Sent[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const sent = JSON.parse(body) as Sent
        requests.push(sent)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${reply(sent, requests.length - 1)}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const root = mkdtempSync(join(tmpdir(), 'conductor-web-answers-'))
    cleanup.push(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const agent = new LocalAgentSession({ endpoint, apiKey: 'k'.repeat(64), model: LOCAL_DOLPHIN_X1_8B, workspace: root, sandbox: null, readOnly: false, grants, timeoutSec: 30, contextTokens: 32768 })
    const tools: Array<{ name: string; output: string }> = []
    const run = async (prompt: string) => {
      tools.length = 0
      let streamed = ''
      const outcome = await agent.run(prompt, { text: delta => { streamed += delta }, toolEnd: result => tools.push({ name: result.name, output: result.output }) })
      return { ...outcome, streamed }
    }
    return { requests, run, tools }
  }

  it('answers a plain question in one request, offered the web but not pushed to it, with today\'s date in the template', async () => {
    const { requests, run } = await session(() => answer('TCP is reliable and ordered; UDP is connectionless.'))
    const outcome = await run('whats the difference between tcp and udp? short answer pls')
    expect(outcome).toMatchObject({ stopReason: 'completed', text: 'TCP is reliable and ordered; UDP is connectionless.' })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.tool_choice).toBe('auto')
    expect(requests[0]!.tools?.map(tool => tool.function.name)).toContain('web_search')
    expect(requests[0]!.chat_template_kwargs).toEqual({ date_string: templateDate(new Date()), tools_in_user_message: false })
    expect(requests[0]!.messages.at(-1)!.content).toBe('whats the difference between tcp and udp? short answer pls')
  })

  it('searches first for a current question, reads a result, and cites the page when the answer names none', async () => {
    const { requests, run, tools } = await session((sent, index) => [
      call('s', 'web_search', { query: 'latest stable python version' }),
      call('r', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      answer('The latest stable Python is 3.14.7, released 2026-08-05.')
    ][index]!)
    const outcome = await run('whats the latest stable python version right now')
    // The hint goes in front, so the owner's words are still the last thing the model reads.
    expect(requests[0]!.messages.at(-1)!.content).toBe(`${WEB_HINT}\n\nwhats the latest stable python version right now`)
    expect(requests[0]!.tool_choice).toBe('required')
    expect(requests[0]!.tools?.map(tool => tool.function.name)).toEqual(['web_search', 'web_read'])
    expect(requests[1]!.tool_choice).toBe('auto')
    expect(requests[1]!.tools?.map(tool => tool.function.name)).toContain('read_file')
    expect(tools.map(tool => tool.name)).toEqual(['web_search', 'web_read'])
    expect(outcome.text).toBe('The latest stable Python is 3.14.7, released 2026-08-05.\n\nSources: https://www.python.org/downloads/latest/')
    expect(outcome.streamed).toContain('Sources: https://www.python.org/downloads/latest/')
  })

  it('searches for the model when it writes prose instead of the search it was asked for', async () => {
    const { run, tools } = await session((sent, index) => [
      answer('Here are the results from my search: the RTX 5070 is great (made up).'),
      call('r', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      answer('Reviewers call it decent value.')
    ][index]!)
    const outcome = await run('find reviews of the nvidia rtx 5070 online and summarize what they say, with sources')
    expect(tools.map(tool => tool.name)).toEqual(['web_search', 'web_read'])
    expect(tools[0]!.output).toContain('Search: reviews of the nvidia rtx 5070')
    // The made-up roundup never became part of the answer.
    expect(outcome.streamed).not.toContain('made up')
    expect(outcome.text).toBe('Reviewers call it decent value.\n\nSources: https://www.python.org/downloads/latest/')
  })

  it('asks once for a page when the answer rests on search results alone', async () => {
    const { requests, run, tools } = await session((sent, index) => [
      call('s', 'web_search', { query: 'rtx 5070 reviews' }),
      answer('Reviewers call it decent value.'),
      call('r', 'web_read', { url: 'https://www.python.org/downloads/latest/' }),
      answer('Reviewers call it decent value (https://www.python.org/downloads/latest/).')
    ][index]!)
    const outcome = await run('find reviews of the rtx 5070 online and summarize them')
    expect(requests[2]!.messages.at(-1)!.content).toContain('[Conductor] Before answering, open the best one or two results with web_read')
    expect(tools.map(tool => tool.name)).toEqual(['web_search', 'web_read'])
    expect(outcome.text).toBe('Reviewers call it decent value (https://www.python.org/downloads/latest/).')
    // The answer from snippets was held back, so the owner reads one answer, not two.
    expect(outcome.streamed).toBe('Reviewers call it decent value (https://www.python.org/downloads/latest/).')
  })

  it('does not re-read a page, and holds a message to its web budget unless deep research is on', async () => {
    const script = (sent: Sent, index: number): string => index === 0 ? call('r0', 'web_read', { url: 'https://example.com/a' })
      : index === 1 ? call('r1', 'web_read', { url: 'https://example.com/a' })
        : index <= WEB_CALLS_PER_MESSAGE + 1 ? call(`s${index}`, 'web_search', { query: `query number ${index}` })
          : answer('Done (https://example.com/a).')
    const limited = await session(script)
    await limited.run('look up example.com a')
    expect(limited.tools[1]!.output).toContain('You already read https://example.com/a for this message')
    const denied = limited.tools.filter(tool => tool.output.startsWith(`denied: this message has used its ${WEB_CALLS_PER_MESSAGE} web calls`))
    // One read and the searches up to the budget ran; the re-read cost nothing.
    expect(limited.tools.length - denied.length).toBe(WEB_CALLS_PER_MESSAGE + 1)
    expect(denied.length).toBeGreaterThan(0)
    const deep = await session(script, { git: false, research: true })
    await deep.run('look up example.com a')
    expect(deep.tools.some(tool => tool.output.startsWith('denied'))).toBe(false)
  })

  it('offers web search to every full-scope conversation, never to a bounded coding task', () => {
    expect(toolSpecs(false).map(spec => spec.function.name)).toContain('web_search')
    expect(toolSpecs(true).map(spec => spec.function.name)).toEqual(['read_file', 'list_files', 'search', 'web_search', 'web_read'])
    expect(toolSpecs(false, false, undefined, 'coding').map(spec => spec.function.name)).not.toContain('web_search')
    const prompt = systemPrompt('C:/w', false, undefined, 'full', new Date(2026, 8, 25))
    expect(prompt).toContain('Today is 2026-09-25')
    expect(prompt).toContain(`at most ${WEB_CALLS_PER_MESSAGE} web calls`)
    expect(prompt).toContain('answer directly from what you know, with no tool call')
    expect(systemPrompt('C:/w', false, { git: false, research: true }, 'full')).toContain('deep research')
    expect(systemPrompt('C:/w', false, undefined, 'coding')).not.toContain('web_search')
  })

  it('recognizes owner words that ask for current or online facts', () => {
    for (const ask of ['whats the latest stable python version right now', 'what is the newest llama.cpp release on github?', 'find reviews of the nvidia rtx 5070 online', 'look up the dolphin x1 8b model online', 'any news about the eu ai act?'])
      expect(wantsWeb(ask), ask).toBe(true)
    for (const plain of ['whats the difference between tcp and udp? short answer pls', 'how many grams of butter is 1 cup', 'explain mortgage APR vs interest rate', 'fix the failing test in src/app.ts'])
      expect(wantsWeb(plain), plain).toBe(false)
    expect(citeSources('See https://a.example', ['https://b.example'], [])).toBe('')
    expect(citeSources('Answer.', ['https://b.example', 'https://b.example'], ['https://c.example'])).toBe('\n\nSources: https://b.example')
    expect(citeSources('Answer.', [], ['https://c.example'])).toBe('\n\nFrom search results: https://c.example')
  })
})

describe('Conductor chat templates', () => {
  it('passes the template date in the Llama 3.1 format', () => {
    expect(templateDate(new Date(2026, 8, 5))).toBe('5 Sep 2026')
    expect(templateKwargs(new Date(2026, 8, 25))).toEqual({ date_string: '25 Sep 2026', tools_in_user_message: false })
  })
  it('gives Dolphin a template without the code-interpreter line and with its own call format', () => {
    expect(DOLPHIN_TEMPLATE).not.toContain('Environment: ipython')
    expect(DOLPHIN_TEMPLATE).toContain(`'"arguments": '`)
    expect(DOLPHIN_TEMPLATE).not.toContain('"parameters"')
    expect(DOLPHIN_TEMPLATE).toContain('otherwise answer the user directly in plain text')
  })
  it('writes the template for Dolphin only, and the server is started with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-templates-'))
    try {
      const path = writeChatTemplate(LOCAL_DOLPHIN_X1_8B, dir)!
      expect(readFileSync(path, 'utf8')).toBe(DOLPHIN_TEMPLATE)
      expect(writeChatTemplate(LOCAL_ORNITH_9B, dir)).toBeUndefined()
      const model = { id: LOCAL_DOLPHIN_X1_8B, label: '', repo: 'a/b', revision: 'x', file: 'a.gguf', quant: 'Q4_K_M', sizeBytes: 1, sha256: 'a'.repeat(64), port: 51438, contextTokens: 32768, gpuLayers: 999, extraArgs: [] }
      const args = llamaServerArgs(model, 'a'.repeat(64), 'a.gguf', undefined, path)
      expect(args.slice(args.indexOf('--chat-template-file'), args.indexOf('--chat-template-file') + 2)).toEqual(['--chat-template-file', path])
      expect(llamaServerArgs(model, 'a'.repeat(64), 'a.gguf')).not.toContain('--chat-template-file')
      // The owner's own arguments still may not point the server at a template file.
      expect(() => llamaServerArgs({ ...model, extraArgs: ['--chat-template-file'] }, 'a'.repeat(64), 'a.gguf')).toThrow(/Refusing/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
