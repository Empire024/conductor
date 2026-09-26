import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { Server as HttpServer } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSpec } from '../shared/models'
import { AgentControlServer, type ControlEndpointFile, type OwnerCredentialFile } from './agent-control-server'
import { ControlHold } from './runtime-host/control-hold'

const spec: AgentSpec = { id: 'wizard', projectId: 'project', sessionId: 'workspace', provider: 'claude', title: 'Wizard', cwd: 'C:\\project' }

describe('a stable app-control endpoint across restarts (FX33)', () => {
  let directory: string
  const cleanup: Array<() => void> = []
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'conductor-control-endpoint-')) })
  afterEach(() => {
    for (const step of cleanup.splice(0).reverse()) { try { step() } catch { /* best effort */ } }
    rmSync(directory, { recursive: true, force: true })
  })

  /** One app launch: its own control server over the same profile files. */
  const launch = async (options: { reclaim?: (port: number) => Promise<boolean>; answer?: string; log?: (message: string) => void } = {}) => {
    const control = {
      authorize: vi.fn(() => spec),
      ownerScope: vi.fn(() => ({ projectId: '', sessionId: '', agentSessionId: 'owner', owner: true })),
      call: vi.fn(async (_scope: unknown, method: string) => ({ method, answeredBy: options.answer ?? 'app' }))
    }
    const server = new AgentControlServer(control as never, false, undefined,
      { path: join(directory, 'control-owner.json'), appVersion: '0.0.0-test', packaged: false },
      { path: join(directory, 'control-endpoint.json'), reclaim: options.reclaim, bindWaitMs: 1500, log: options.log })
    cleanup.push(() => server.close())
    await server.start()
    const briefing = server.briefing(spec)
    return {
      server, control,
      endpoint: briefing.match(/POST (http:\/\/127\.0\.0\.1:\d+\/control)/)![1]!,
      token: briefing.match(/Bearer ([a-f0-9]{64})/)![1]!,
      owner: JSON.parse(readFileSync(join(directory, 'control-owner.json'), 'utf8')) as OwnerCredentialFile
    }
  }
  const call = (endpoint: string, token: string, method = 'agents.list'): Promise<Response> => fetch(endpoint, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args: {} })
  })

  it('keeps the port, the owner token and every conversation credential after a restart', async () => {
    const first = await launch()
    expect(first.server.endpointChanged).toBe(true)
    first.server.close()

    const second = await launch({ answer: 'relaunched app' })
    expect(second.endpoint).toBe(first.endpoint)
    expect(second.token).toBe(first.token)
    expect(second.owner.token).toBe(first.owner.token)
    expect(second.owner.endpoint).toBe(first.owner.endpoint)
    expect(second.server.endpointChanged).toBe(false)
    // The credential the conversation was given before the restart works without a new briefing.
    const answer = await call(first.endpoint, first.token)
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ result: { answeredBy: 'relaunched app' } })
    expect((await call(first.endpoint, first.owner.token)).status).toBe(200)
  })

  it('mints new credentials only when the file is gone or the owner rotates them', async () => {
    const first = await launch()
    first.server.close()
    rmSync(join(directory, 'control-endpoint.json'))
    const second = await launch()
    expect(second.token).not.toBe(first.token)
    expect(second.owner.token).not.toBe(first.owner.token)
    expect(second.server.endpointChanged).toBe(true)

    second.server.rotate()
    expect((await call(second.endpoint, second.token)).status).toBe(401)
    const saved = JSON.parse(readFileSync(join(directory, 'control-endpoint.json'), 'utf8')) as ControlEndpointFile
    expect(saved.ownerToken).not.toBe(second.owner.token)
    expect(saved.credentials).toEqual({})
  })

  it('falls back to another port, and says so, when another process holds this one', async () => {
    const first = await launch()
    const port = first.server.port
    first.server.close()
    const squatter: Server = createServer()
    await new Promise<void>(resolve => squatter.listen(port, '127.0.0.1', resolve))
    cleanup.push(() => squatter.close())
    const log = vi.fn()
    const second = await launch({ reclaim: async () => false, log })
    expect(second.server.port).not.toBe(port)
    expect(second.server.endpointChanged).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`could not keep port ${port}`))
    // Its credentials still stand; only the address moved.
    expect(second.token).toBe(first.token)
    expect((await call(second.endpoint, first.token)).status).toBe(200)
  })

  it('answers a call made while no app runs once the next app takes the port back from the runtime host', async () => {
    const first = await launch()
    const port = first.server.port
    // The old app goes away with a turn kept running; the host holds its port meanwhile.
    const hold = new ControlHold({ waitMs: 20_000 })
    cleanup.push(() => hold.close())
    first.server.close()
    hold.hold(port)
    await vi.waitFor(() => expect(hold.holding).toBe(port))
    // The port answers (the host holds the call) instead of refusing the connection.
    const pending = call(first.endpoint, first.token, 'agents.list')
    await vi.waitFor(() => expect(hold.heldRequests).toBe(1))
    await new Promise(resolve => setTimeout(resolve, 500))

    // The new app finds the port held and asks for it back; the held call reaches it once.
    const second = await launch({ answer: 'relaunched app', reclaim: async taken => hold.release(taken).released })
    expect(second.server.port).toBe(port)
    const answer = await pending
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ result: { method: 'agents.list', answeredBy: 'relaunched app' } })
    expect(second.control.call).toHaveBeenCalledTimes(1)
  })

  it('answers a call whose connection it accepted just before its main thread stalled for 31 s', async () => {
    const { server, endpoint, token } = await launch()
    // The stall starts right after the connection is accepted, before its request is read: when
    // the loop runs again, Node's own header timeout check (every 30 s, 10 s allowed) comes first.
    ;(server as unknown as { server: HttpServer }).server.once('connection', () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 31_000)
    })
    const client = `fetch(${JSON.stringify(endpoint)}, { method: 'POST', headers: { Authorization: 'Bearer ${token}', 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'agents.list', args: {} }) }).then(r => console.log(r.status), e => console.log('error ' + (e.cause?.code ?? e.message)))`
    const pending = new Promise<string>(resolve => {
      // Another process, so the call is on the wire while this thread is stalled.
      const child = spawn(process.execPath, ['-e', client], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.on('close', () => resolve(out.trim()))
    })
    expect(await pending).toBe('200')
  }, 60_000)

  it('tells a held call it was never delivered when no app comes back in time', async () => {
    const first = await launch()
    const port = first.server.port
    const hold = new ControlHold({ waitMs: 300 })
    cleanup.push(() => hold.close())
    first.server.close()
    hold.hold(port)
    await vi.waitFor(() => expect(hold.holding).toBe(port))
    const answer = await call(first.endpoint, first.token)
    expect(answer.status).toBe(503)
    expect((await answer.json() as { error: string }).error).toMatch(/never delivered, so it is safe to send again/)
  })
})
