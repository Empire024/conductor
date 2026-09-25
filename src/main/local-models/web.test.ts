import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { gzipSync } from 'node:zlib'
import { pageText, pinnedLookup, readPublicWeb, relevant, resetSearchState, searchPublicWeb, PAGE_BYTES, SEARCH_PAGE_BYTES } from './web.ts'
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

describe('research transport boundary', () => {
  beforeEach(() => { resetSearchState(); vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never) })
  afterEach(() => vi.resetAllMocks())
  function response(statusCode: number, headers: Record<string, string>, body: string | Buffer) {
    vi.mocked(request).mockImplementationOnce(((_url: unknown, options: { signal: AbortSignal }, done: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end(): void }
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: unknown; destroy(error?: Error): void }
        res.statusCode = statusCode; res.headers = headers
        let destroyed = false
        res.destroy = error => { destroyed = true; if (error) queueMicrotask(() => res.emit('error', error)) }
        queueMicrotask(() => { done(res); if (!destroyed) { res.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body)); if (!destroyed) res.emit('end') } })
        options.signal.addEventListener('abort', () => req.emit('error', options.signal.reason), { once: true })
      }
      return req
    }) as never)
  }
  it('pins the validated address in scalar and all-address socket lookup forms', async () => {
    const callback = vi.fn()
    pinnedLookup('93.184.216.34')('rebound.example', { all: true }, callback)
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: '93.184.216.34', family: 4 }])
    pinnedLookup('93.184.216.34')('rebound.example', {}, callback)
    expect(callback).toHaveBeenLastCalledWith(null, '93.184.216.34', 4)
    response(200, { 'content-type': 'text/html' }, '<h1>Source</h1>')
    expect(await readPublicWeb('https://public.example')).toContain('Untrusted web content')
    const options = vi.mocked(request).mock.calls[0]![1] as { lookup: ReturnType<typeof pinnedLookup>; headers: Record<string, string>; agent: boolean }
    options.lookup('public.example', { all: true }, callback)
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: '93.184.216.34', family: 4 }])
    expect(lookup).toHaveBeenCalledTimes(1) // The socket does not resolve DNS again.
    expect(options.agent).toBe(false)
    expect(Object.keys(options.headers)).not.toContain('Authorization')
  })
  it('refuses redirects to loopback and fresh DNS resolving a redirect to private space', async () => {
    response(302, { location: 'https://127.0.0.1/' }, '')
    await expect(readPublicWeb('https://public.example')).rejects.toThrow(/local or reserved/)
    expect(request).toHaveBeenCalledTimes(1)
    response(302, { location: 'https://redirect.example/' }, '')
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never).mockResolvedValueOnce([{ address: '192.168.0.1', family: 4 }] as never)
    await expect(readPublicWeb('https://public.example')).rejects.toThrow(/DNS/)
    expect(request).toHaveBeenCalledTimes(2)
  })
  function streamResponse(statusCode: number, headers: Record<string, string>, body: Buffer) {
    vi.mocked(request).mockImplementationOnce(((_url: unknown, _options: unknown, done: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end(): void }
      req.end = () => {
        const res = Object.assign(new PassThrough(), { statusCode, headers })
        queueMicrotask(() => { done(res); res.end(body) })
      }
      return req
    }) as never)
  }
  const html = (status = 200) => (body: string) => response(status, { 'content-type': 'text/html' }, body)
  it('turns a search into public links only, dropping the redirector and anything unreachable', async () => {
    resetSearchState({ spacingMs: 0 })
    html()([
      '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example%2Fsandboxing-guide&rut=x">Local model sandboxing &amp; guide</a>',
      '<a href="/settings">Settings</a>',
      '<a href="https://duckduckgo.com/about">About the engine</a>',
      '<a href="http://insecure.example/page">Insecure local model sandboxing</a>',
      '<a href="https://blog.example/post">Blog post on <b>local model</b> sandboxing</a>',
      '<a href="https://docs.example/sandboxing-guide">Docs duplicate</a>',
      '<a href="https://pots.example/pot">Enamel pot 18 cm</a>'
    ].join('\n'))
    const results = await searchPublicWeb('local model sandboxing')
    expect(results).toContain('Search: local model sandboxing (via DuckDuckGo)')
    expect(results).toContain('1. Local model sandboxing & guide\n   https://docs.example/sandboxing-guide')
    expect(results).toContain('2. Blog post on local model sandboxing\n   https://blog.example/post')
    // The engine's own pages, relative chrome, plain HTTP, a repeat, and a hit about something else.
    expect(results).not.toContain('duckduckgo.com')
    expect(results).not.toContain('Settings')
    expect(results).not.toContain('insecure.example')
    expect(results).not.toContain('Docs duplicate')
    expect(results).not.toContain('pots.example')
    const url = vi.mocked(request).mock.calls[0]![0] as URL
    expect(url.href).toBe('https://lite.duckduckgo.com/lite/?q=local%20model%20sandboxing')
    await expect(searchPublicWeb('  ')).rejects.toThrow(/query/)
    await expect(searchPublicWeb('x'.repeat(401))).rejects.toThrow(/400 characters/)
  })
  it('reads DuckDuckGo result rows with their date and snippet, and answers a repeat from memory', async () => {
    resetSearchState({ spacingMs: 0 })
    html()(`<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2Fdownloads%2F&amp;rut=1" class='result-link'>Download Python | Python.org</a></td></tr>
      <tr><td class='result-snippet'>The latest <b>Python</b> release is 3.14.7.</td></tr>
      <tr><td><span class='timestamp'>2026-08-05T00:00:00.0000000</span></td></tr>`)
    const results = await searchPublicWeb('latest python release')
    expect(results).toContain('1. Download Python | Python.org\n   https://www.python.org/downloads/\n   2026-08-05 - The latest Python release is 3.14.7.')
    expect(await searchPublicWeb('Latest Python release ')).toBe(results)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('lets a throttling engine rest and asks the next one, then says when nothing answered', async () => {
    resetSearchState({ spacingMs: 0 })
    html(202)('bot check')
    html(202)('bot check')
    html()('<h3><a data-e-a="heading" href="https://www.techspot.com/review/rtx-5070/"><span>RTX 5070 review</span></a></h3><div><span>The RTX 5070 is a $550 GPU with 12 GB of memory.</span></div>')
    const results = await searchPublicWeb('rtx 5070 review')
    expect(results).toContain('(via Seznam)')
    expect(results).toContain('https://www.techspot.com/review/rtx-5070/\n   The RTX 5070 is a $550 GPU with 12 GB of memory.')
    expect((vi.mocked(request).mock.calls[2]![0] as URL).hostname).toBe('search.seznam.cz')
    // DuckDuckGo is resting now: the next query does not ask it at all.
    html()('<a data-e-a="heading" href="https://pots.example/pot">Enamel pot</a>')
    response(200, { 'content-type': 'application/json' }, JSON.stringify({ query: { search: [] } }))
    const nothing = await searchPublicWeb('rtx 5080 review')
    expect(nothing).toMatch(/DuckDuckGo: rate-limiting this machine for about \d+ more seconds; Seznam: no usable results; Wikipedia: no usable results/)
    expect(nothing).toContain('Searching again now will not help')
    expect(vi.mocked(request).mock.calls.map(call => (call[0] as URL).hostname).slice(3)).toEqual(['search.seznam.cz', 'en.wikipedia.org'])
    // A failed query is answered from memory too, so a model repeating it sends nothing.
    expect(await searchPublicWeb('rtx 5080 review')).toBe(nothing)
    expect(request).toHaveBeenCalledTimes(5)
  })
  it('falls back to Wikipedia search results', async () => {
    resetSearchState({ spacingMs: 0 })
    html()('<p>no results</p>')
    html()('<p>no results</p>')
    response(200, { 'content-type': 'application/json' }, JSON.stringify({ query: { search: [{ title: 'Llama (language model)', snippet: 'A family of <span>large language models</span>' }] } }))
    expect(await searchPublicWeb('llama language model')).toContain('1. Llama (language model) - Wikipedia\n   https://en.wikipedia.org/wiki/Llama_(language_model)\n   A family of large language models')
  })
  it('judges a hit relevant by the query words it shares', () => {
    const hit = (title: string, url = 'https://example.com/') => ({ title, url })
    expect(relevant('dolphin x1 8b dphn', hit('dphn/Dolphin-X1-8B · Hugging Face'))).toBe(true)
    expect(relevant('dolphin x1 8b dphn', hit('Enamel pot 1.25 l'))).toBe(false)
    expect(relevant('whats the latest stable python version', hit('Status of Python versions', 'https://devguide.python.org/versions/'))).toBe(true)
    expect(relevant('whats the latest stable python version', hit('google-cloud-python'))).toBe(false)
    expect(relevant('python', hit('Python.org'))).toBe(true)
  })
  it('reads the article text of a page, without its chrome, scripts or attribute JSON', () => {
    const page = `<html><head><title>T</title><script>window.FUTR = {}</script></head><body><nav>Menu</nav>
      <div data-props='{"chat_template":"<|im_start|>{{ x }}"}'>Model card</div>
      <article><h1>RTX 5070 review</h1><p>${'Good value. '.repeat(40)}</p><p>Only 12&nbsp;GB &amp; DLSS&#8201;4.</p></article><footer>Footer</footer></body></html>`
    const text = pageText(page)
    expect(text).toContain('RTX 5070 review\nGood value.')
    expect(text).toContain('Only 12 GB & DLSS 4.')
    for (const chrome of ['FUTR', 'Menu', 'Footer', 'im_start', 'chat_template']) expect(text).not.toContain(chrome)
    // A page cut inside a script keeps what came before it and nothing of the script.
    expect(pageText('<p>Before the cut</p><script>var huge = "')).toBe('Before the cut')
  })
  it('decompresses a body sent compressed despite the identity request', async () => {
    streamResponse(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }, gzipSync('<p>Python 3.14.7 is out</p>'))
    expect(await readPublicWeb('https://www.python.org/downloads/')).toContain('Python 3.14.7 is out')
  })
  it('cuts an oversized page instead of refusing it, refuses an oversized result page, and cancels while DNS is pending', async () => {
    response(200, { 'content-type': 'text/html' }, '<p>' + 'x'.repeat(PAGE_BYTES + 10) + '</p>')
    const page = await readPublicWeb('https://public.example')
    expect(page).toContain('[Page text cut at 12000 characters.]')
    resetSearchState({ spacingMs: 0 })
    response(200, { 'content-type': 'text/html' }, 'x'.repeat(SEARCH_PAGE_BYTES + 1))
    html()('<p>none</p>')
    response(200, { 'content-type': 'application/json' }, '{}')
    expect(await searchPublicWeb('oversized result page')).toContain('DuckDuckGo: Research response exceeds 1536 KiB')
    vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = readPublicWeb('https://public.example', controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })
})
