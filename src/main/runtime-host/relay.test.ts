import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { McpRelay } from './relay'

/** A stand-in for one of the app's MCP servers: answers with what it was asked and how. */
async function upstream(token: string): Promise<{ url: string; seen: Array<{ authorization?: string; host?: string; body: string }>; close(): Promise<void> }> {
  const seen: Array<{ authorization?: string; host?: string; body: string }> = []
  const server: Server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    seen.push({ authorization: request.headers.authorization, host: request.headers.host, body })
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end('{}'); return }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { token } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/mcp`, seen, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}

const post = (url: string, token: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) })

describe('MCP relay', () => {
  const closing: Array<() => Promise<void>> = []
  afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })
  const relay = (waitMs?: number): McpRelay => { const created = new McpRelay({ waitMs }); closing.push(() => created.close()); return created }
  const serve = async (token: string) => { const created = await upstream(token); closing.push(() => created.close()); return created }

  it('forwards to the app with the app\'s credential, never the relay\'s', async () => {
    const mcp = relay(), app = await serve('a'.repeat(64))
    const [route] = await mcp.register({}, 'conversation-1', [{ name: 'conductor-browser', upstream: app.url, authorization: `Bearer ${'a'.repeat(64)}` }])
    expect(route!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(route!.token).toMatch(/^[a-f0-9]{64}$/)
    const response = await post(route!.url, route!.token)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 7, result: { token: 'a'.repeat(64) } })
    expect(app.seen[0]).toMatchObject({ authorization: `Bearer ${'a'.repeat(64)}`, host: new URL(app.url).host })
  })

  it('refuses unknown credentials, web pages and non-loopback upstreams', async () => {
    const mcp = relay(), app = await serve('b'.repeat(64))
    const [route] = await mcp.register({}, 'conversation-1', [{ name: 'conductor-browser', upstream: app.url, authorization: `Bearer ${'b'.repeat(64)}` }])
    expect((await post(route!.url, 'c'.repeat(64))).status).toBe(401)
    expect((await post(route!.url, route!.token, { Origin: 'https://example.com' })).status).toBe(403)
    await expect(mcp.register({}, 'conversation-2', [{ name: 'x', upstream: 'http://example.com/mcp', authorization: 'Bearer x' }])).rejects.toThrow(/127\.0\.0\.1/)
    expect(app.seen).toHaveLength(0)
  })

  it('keeps one address and token while the app behind it restarts, and holds requests until it is back', async () => {
    const mcp = relay(), first = await serve('1'.repeat(64)), firstApp = {}
    const [route] = await mcp.register(firstApp, 'conversation-1', [{ name: 'conductor-local', upstream: first.url, authorization: `Bearer ${'1'.repeat(64)}` }])
    expect((await post(route!.url, route!.token)).status).toBe(200)
    // The app quits: its server is gone and its pipe client with it.
    await first.close()
    mcp.release(firstApp)
    const waiting = post(route!.url, route!.token)
    await new Promise(resolve => setTimeout(resolve, 300))
    // The next app serves the same tools on a new port with a new credential.
    const second = await serve('2'.repeat(64))
    const [again] = await mcp.register({}, 'conversation-1', [{ name: 'conductor-local', upstream: second.url, authorization: `Bearer ${'2'.repeat(64)}` }])
    expect(again).toEqual(route)
    const response = await waiting
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { token: '2'.repeat(64) } })
  })

  it('retries an app that has gone before the host noticed', async () => {
    const mcp = relay(), first = await serve('3'.repeat(64)), app = {}
    const [route] = await mcp.register(app, 'conversation-1', [{ name: 'conductor-local', upstream: first.url, authorization: `Bearer ${'3'.repeat(64)}` }])
    await first.close()
    const waiting = post(route!.url, route!.token)
    await new Promise(resolve => setTimeout(resolve, 300))
    const second = await serve('4'.repeat(64))
    await mcp.register(app, 'conversation-1', [{ name: 'conductor-local', upstream: second.url, authorization: `Bearer ${'4'.repeat(64)}` }])
    expect((await waiting).status).toBe(200)
  })

  it('refuses a server the next app no longer gives the conversation, and gives up after its wait', async () => {
    const mcp = relay(400), app = await serve('5'.repeat(64)), owner = {}
    const [browser, local] = await mcp.register(owner, 'conversation-1', [
      { name: 'conductor-browser', upstream: app.url, authorization: `Bearer ${'5'.repeat(64)}` },
      { name: 'conductor-local', upstream: app.url, authorization: `Bearer ${'5'.repeat(64)}` }
    ])
    mcp.release(owner)
    const started = Date.now()
    expect((await post(local!.url, local!.token)).status).toBe(503)
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    await mcp.register({}, 'conversation-1', [{ name: 'conductor-local', upstream: app.url, authorization: `Bearer ${'5'.repeat(64)}` }])
    expect((await post(browser!.url, browser!.token)).status).toBe(401)
    expect((await post(local!.url, local!.token)).status).toBe(200)
  })
})
