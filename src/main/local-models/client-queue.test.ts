import { afterEach, expect, it, vi } from 'vitest'
import { chatCompletion, localRequestsWaiting } from './client'

/** local-model-swarms: conversations sharing the one server take turns request by request. */
afterEach(() => vi.unstubAllGlobals())

const streamed = (text: string): Response => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 })

it('sends a second conversation\'s request only after the first one\'s stream ends, and an aborted waiter never', async () => {
  const releases: Array<() => void> = []
  const fetched: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }
    const name = body.messages[0]!.content
    fetched.push(name)
    await new Promise<void>(resolve => releases.push(resolve))
    return streamed('reply to ' + name)
  }))
  const request = (name: string, extra: Partial<Parameters<typeof chatCompletion>[0]> = {}) => chatCompletion({ endpoint: 'http://127.0.0.1:9', apiKey: 'k', model: 'local/m', messages: [{ role: 'user', content: name }], ...extra })
  const queued = vi.fn()
  const first = request('first')
  const aborter = new AbortController()
  const aborted = request('aborted', { signal: aborter.signal, onQueued: queued })
  const second = request('second', { onQueued: queued })
  await vi.waitFor(() => expect(fetched).toEqual(['first']))
  expect(queued).toHaveBeenCalledTimes(2)
  expect(localRequestsWaiting('http://127.0.0.1:9')).toBe(true)
  aborter.abort(new Error('stopped'))
  await expect(aborted).rejects.toThrow('stopped')
  releases.shift()!()
  expect((await first).content).toBe('reply to first')
  await vi.waitFor(() => expect(fetched).toEqual(['first', 'second']))
  releases.shift()!()
  expect((await second).content).toBe('reply to second')
  expect(localRequestsWaiting('http://127.0.0.1:9')).toBe(false)
})
