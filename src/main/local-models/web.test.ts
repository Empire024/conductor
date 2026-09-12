import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { pinnedLookup, readPublicWeb, searchPublicWeb } from './web.ts'
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))

describe('research transport boundary', () => {
  beforeEach(() => { vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never) })
  afterEach(() => vi.resetAllMocks())
  function response(statusCode: number, headers: Record<string, string>, body: string) {
    vi.mocked(request).mockImplementationOnce(((_url: unknown, options: { signal: AbortSignal }, done: (res: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & { end(): void }
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: unknown; destroy(error?: Error): void }
        res.statusCode = statusCode; res.headers = headers
        let destroyed = false
        res.destroy = error => { destroyed = true; if (error) queueMicrotask(() => res.emit('error', error)) }
        queueMicrotask(() => { done(res); if (!destroyed) { res.emit('data', Buffer.from(body)); if (!destroyed) res.emit('end') } })
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
  it('turns a search into public links only, dropping the redirector and anything unreachable', async () => {
    response(200, { 'content-type': 'text/html' }, [
      '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example%2Fguide&rut=x">Docs &amp; guide</a>',
      '<a href="/settings">Settings</a>',
      '<a href="https://duckduckgo.com/about">About the engine</a>',
      '<a href="http://insecure.example/page">Insecure</a>',
      '<a href="https://blog.example/post">Blog <b>post</b></a>',
      '<a href="https://docs.example/guide">Docs duplicate</a>'
    ].join('\n'))
    const results = await searchPublicWeb('local model sandboxing')
    expect(results).toContain('Search: local model sandboxing')
    expect(results).toContain('1. Docs & guide\n   https://docs.example/guide')
    expect(results).toContain('2. Blog post\n   https://blog.example/post')
    // The engine's own pages, relative chrome, plain HTTP and a repeat of a link already listed.
    expect(results).not.toContain('duckduckgo.com')
    expect(results).not.toContain('Settings')
    expect(results).not.toContain('insecure.example')
    expect(results).not.toContain('Docs duplicate')
    const url = vi.mocked(request).mock.calls[0]![0] as URL
    expect(url.href).toBe('https://lite.duckduckgo.com/lite/?q=local%20model%20sandboxing')
    response(200, { 'content-type': 'text/html' }, '<a href="/nothing">nothing</a>')
    expect(await searchPublicWeb('no hits here')).toContain('No usable results')
    await expect(searchPublicWeb('  ')).rejects.toThrow(/query/)
    await expect(searchPublicWeb('x'.repeat(401))).rejects.toThrow(/400 characters/)
  })
  it('bounds response bytes and cancels even while DNS is pending', async () => {
    response(200, { 'content-type': 'text/plain' }, 'x'.repeat(256 * 1024 + 1))
    await expect(readPublicWeb('https://public.example')).rejects.toThrow(/256 KiB/)
    vi.mocked(lookup).mockImplementationOnce(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = readPublicWeb('https://public.example', controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })
})
