import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { RuntimeEnsureResult, TerminalSpec } from '../shared/models'
import { LOCAL_CONNECTION, LOCAL_MACHINE_ID } from '../shared/remote-control'
import { PhoneAccessService } from './phone-access'
import { PHONE_LOCK_ROUTES, PhoneAccessServer, registerPhoneApiRoute } from './phone-access-server'
import type { PhoneTerminalRuntime } from './phone-terminal'
import { MemoryVault, type SecretKeyValueStore } from './secret-store'
import { TerminalOutputBuffer, type TerminalExitListener, type TerminalOutputListener } from './terminal-manager'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
}

/** A shell that answers `echo ok` and nothing else; the real one is TerminalManager. */
class EchoRuntime implements PhoneTerminalRuntime {
  readonly buffers = new Map<string, TerminalOutputBuffer>()
  readonly specs = new Map<string, TerminalSpec>()
  readonly alive = new Set<string>()
  readonly killed: string[] = []
  private outputs = new Map<string, Set<TerminalOutputListener>>()
  ensure(spec: TerminalSpec): RuntimeEnsureResult {
    this.specs.set(spec.id, spec); this.alive.add(spec.id); this.buffers.set(spec.id, new TerminalOutputBuffer())
    setTimeout(() => this.print(spec.id, 'PS> '), 5)
    return { id: spec.id, available: true, status: 'running', transcript: '' }
  }
  write(id: string, data: string | Buffer): void {
    const text = Buffer.from(data as Buffer).toString('utf8')
    this.print(id, text.replace(/\r/g, '\r\n'))
    if (/^echo (.+)\r$/.test(text)) this.print(id, text.replace(/^echo (.+)\r$/, '$1\r\nPS> '))
  }
  resize(): void { /* sizes are not tracked here */ }
  kill(id: string): void { this.killed.push(id); this.alive.delete(id) }
  running(id: string): boolean { return this.alive.has(id) }
  summary(id: string) { const spec = this.specs.get(id); return spec ? { terminalId: id, tabId: null, title: spec.title, cwd: spec.cwd, running: this.alive.has(id), exitCode: null, offset: this.buffers.get(id)!.offset } : null }
  attach(id: string, fromOffset: number) {
    const buffer = this.buffers.get(id)
    if (!buffer) return null
    const read = buffer.read(fromOffset)
    return { terminalId: id, offset: read.offset, data: read.data.toString('base64'), lostBytes: read.lostBytes, running: this.alive.has(id), exitCode: null, cols: 80, rows: 24 }
  }
  onOutput(id: string, listener: TerminalOutputListener): () => void { const set = this.outputs.get(id) ?? new Set(); set.add(listener); this.outputs.set(id, set); return () => set.delete(listener) }
  onExit(_id: string, _listener: TerminalExitListener): () => void { return () => undefined }
  print(id: string, text: string): void { const bytes = Buffer.from(text); const offset = this.buffers.get(id)!.append(bytes); for (const listener of this.outputs.get(id) ?? []) listener(offset, bytes) }
}

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

interface Reply { status: number; headers: IncomingMessage['headers']; body: string }

function call(port: number, ca: string, path: string, options: { method?: string; token?: string; unlock?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` }
    if (options.token) headers.authorization = `Bearer ${options.token}`
    if (options.unlock) headers['x-conductor-unlock'] = options.unlock
    const method = options.method ?? 'GET'
    if (method === 'POST') headers['content-type'] = 'application/json'
    const requestOptions: RequestOptions = { host: '127.0.0.1', port, path, method, ca, rejectUnauthorized: true, headers }
    const req = httpsRequest(requestOptions, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.once('error', reject)
    if (method === 'POST') req.write(JSON.stringify(options.body ?? {}))
    req.end()
  })
}

/** Reads server-sent events until `until` says enough, then hangs up. */
function events(port: number, ca: string, path: string, token: string, unlock: string, until: (seen: Array<{ event: string; data: Record<string, unknown> }>) => boolean): Promise<{ status: number; seen: Array<{ event: string; data: Record<string, unknown> }>; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = []
    let buffer = '', done = false
    const req = httpsRequest({ host: '127.0.0.1', port, path, ca, rejectUnauthorized: true, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'x-conductor-unlock': unlock } }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve({ status: response.statusCode ?? 0, seen, ended: true }); return }
      const finish = (ended: boolean): void => { if (done) return; done = true; if (!ended) req.destroy(); resolve({ status: 200, seen, ended }) }
      response.on('data', chunk => {
        buffer += chunk.toString('utf8')
        let split = buffer.indexOf('\n\n')
        while (split >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2)
          const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1]
          if (event && data) seen.push({ event, data: JSON.parse(data) as Record<string, unknown> })
          split = buffer.indexOf('\n\n')
        }
        if (until(seen)) finish(false)
      })
      response.on('end', () => finish(true))
    })
    req.once('error', error => { if (!done) reject(error) })
    req.end()
  })
}

async function fixture(options: { terminals?: PhoneTerminalRuntime } = {}) {
  const store = new MapStore()
  const push = vi.fn(async () => ({ status: 201, gone: false, retryAfter: null, body: '' }))
  const audit = vi.fn()
  const project = { id: 'project-a', name: 'Conductor', path: process.cwd(), createdAt: 't', updatedAt: 't' }
  const workspace = { id: 'ws-1', projectId: 'project-a', name: 'main', createdAt: 't', updatedAt: 't', layout: { root: { type: 'group', id: 'g', tabs: [], activeTabId: null } } } as never
  const service = new PhoneAccessService({
    store, vault: new MemoryVault(),
    database: { listProjects: () => [project], getProject: id => id === project.id ? project : null, listSessions: () => [workspace], listDetachedWindows: () => [], listProcesses: () => [], listAgentActivity: () => [], structured: { snapshot: () => null, spec: () => null, history: () => [], update: () => undefined } },
    sessions: { ensure: () => ({ id: 'x', available: false, status: 'unavailable', transcript: '' }), connectSession: async () => undefined, submit: async () => undefined, steer: async () => undefined, queue: async () => undefined, respond: async () => undefined, interrupt: async () => undefined, resume: async () => undefined },
    providers: () => [], machines: () => [{ id: LOCAL_MACHINE_ID, name: 'MAIN', kind: 'local', status: 'online', accountLogin: null, projects: [], connection: LOCAL_CONNECTION }],
    machineName: () => 'MAIN', version: '0.1.3', ui: async () => ({}),
    metrics: async () => ({ sampledAt: 'now', cpuPercent: 1, cpuCores: 4, memoryUsedBytes: 1, memoryTotalBytes: 2, gpus: [], processes: [], localServers: [], unavailable: [] }),
    push, log: () => undefined, audit
  })
  service.updateSettings({ enabled: true, port: 0 })
  const server = new PhoneAccessServer({ service, terminals: options.terminals, localAddresses: () => ['127.0.0.1'], hostname: () => 'main-pc', assets: { 'index.html': '<!doctype html>', 'app.js': '1', 'app.css': '', 'sw.js': '', 'manifest.webmanifest': '{}', 'icon.svg': '<svg/>' }, log: () => undefined })
  cleanup.push(() => server.dispose())
  cleanup.push(() => service.dispose())
  const status = await server.apply()
  if (!status.listening) throw new Error('listener did not start: ' + status.message)
  const port = Number(new URL(status.endpoints[0]!).port)
  const ca = service.certificateAuthority().certificatePem
  const offer = service.createPairing()
  const paired = await call(port, ca, '/api/pair', { method: 'POST', body: { code: offer.code, name: 'iPhone' } })
  const { token, device } = JSON.parse(paired.body) as { token: string; device: { id: string } }
  return { service, server, port, ca, token, deviceId: device.id, push, audit }
}

describe('the phone lock on the listener', () => {
  it('refuses every authenticated route and extension with 423 until the phone unlocks', { timeout: 30_000 }, async () => {
    const extension = vi.fn(async () => ({ ok: true }))
    cleanup.push(registerPhoneApiRoute('/api/lock-test-extension', extension))
    const { service, server, port, ca, token } = await fixture({ terminals: new EchoRuntime() })
    await service.lock.setCode('482915')
    const table = server.routeTable()
    // The table is the whole API: this list only grows by adding a route, and each one is walked.
    expect(table.length).toBeGreaterThanOrEqual(21)
    const probes = [...table.map(route => ({ method: route.method, path: route.sample })), { method: 'GET', path: '/api/lock-test-extension' }, { method: 'POST', path: '/api/lock-test-extension/x' }]
    for (const probe of probes) {
      const locked = await call(port, ca, probe.path, { method: probe.method, token })
      expect({ probe, status: locked.status }).toEqual({ probe, status: 423 })
      expect(JSON.parse(locked.body)).toMatchObject({ locked: true })
      const forged = await call(port, ca, probe.path, { method: probe.method, token, unlock: 'A'.repeat(43) })
      expect({ probe, status: forged.status }).toEqual({ probe, status: 423 })
    }
    expect(extension).not.toHaveBeenCalled()
    // Unpaired is still 401, and the diagnose route stays open.
    expect((await call(port, ca, '/api/state')).status).toBe(401)
    expect((await call(port, ca, '/api/health')).status).toBe(200)
    // Once unlocked, the same routes are answered (by their own rules rather than the gate).
    const { unlockToken } = JSON.parse((await call(port, ca, '/api/lock/unlock', { method: 'POST', token, body: { code: '482915' } })).body) as { unlockToken: string }
    expect((await call(port, ca, '/api/state', { token, unlock: unlockToken })).status).toBe(200)
    expect((await call(port, ca, '/api/lock-test-extension', { token, unlock: unlockToken })).status).toBe(200)
  })

  it('answers only the lock pad routes while locked, and no route is handled ahead of the gate', () => {
    expect(PHONE_LOCK_ROUTES.map(route => `${route.method} ${route.path}`)).toEqual(['GET /api/lock/state', 'POST /api/lock/unlock', 'POST /api/lock/touch', 'POST /api/lock/lock'])
    // Paths the request handler looks at itself, before the table: a new one here is a route that
    // could be answered to a locked phone, so it has to be added to this list on purpose.
    const source = readFileSync(new URL('./phone-access-server.ts', import.meta.url), 'utf8')
    const early = [...source.matchAll(/url\.pathname(?:\s*===\s*|\.startsWith\()'([^']+)'/g)].map(match => match[1])
    expect(new Set(early)).toEqual(new Set(['/api/health', '/api/', '/ca.crt', '/api/pair', '/api/lock/']))
  })

  it('unlocks with the code, counts wrong codes, and backs off', { timeout: 30_000 }, async () => {
    const { service, port, ca, token } = await fixture()
    let state = JSON.parse((await call(port, ca, '/api/lock/state', { token })).body)
    expect(state).toMatchObject({ configured: false, unlocked: false })
    // Without a code the phone is not locked at all.
    expect((await call(port, ca, '/api/state', { token })).status).toBe(200)
    await service.lock.setCode('482915')
    state = JSON.parse((await call(port, ca, '/api/lock/state', { token })).body)
    expect(state).toMatchObject({ configured: true, unlocked: false, remaining: 5, idleMs: 300_000, backgroundMs: 60_000 })
    const wrong = await call(port, ca, '/api/lock/unlock', { method: 'POST', token, body: { code: '000000' } })
    expect(wrong.status).toBe(403)
    expect(JSON.parse(wrong.body)).toMatchObject({ error: 'That code is wrong.', remaining: 4 })
    await call(port, ca, '/api/lock/unlock', { method: 'POST', token, body: { code: '000001' } })
    const waiting = await call(port, ca, '/api/lock/unlock', { method: 'POST', token, body: { code: '482915' } })
    expect(waiting.status).toBe(429)
    expect(JSON.parse(waiting.body).retryAt).toBeTruthy()
    service.lock.resetAttempts()
    const right = await call(port, ca, '/api/lock/unlock', { method: 'POST', token, body: { code: '482915' } })
    expect(right.status).toBe(200)
    const { unlockToken } = JSON.parse(right.body) as { unlockToken: string }
    expect(JSON.parse((await call(port, ca, '/api/lock/state', { token, unlock: unlockToken })).body)).toMatchObject({ unlocked: true })
    expect((await call(port, ca, '/api/lock/touch', { method: 'POST', token, unlock: unlockToken })).status).toBe(200)
    expect((await call(port, ca, '/api/lock/lock', { method: 'POST', token, unlock: unlockToken })).status).toBe(200)
    expect((await call(port, ca, '/api/state', { token, unlock: unlockToken })).status).toBe(423)
  })

  it('closes an open stream the moment the phone locks', { timeout: 30_000 }, async () => {
    const { service, port, ca, token } = await fixture()
    await service.lock.setCode('482915')
    const { unlockToken } = await service.lock.unlock('482915', { id: service.listDevices()[0]!.id })
    const reading = events(port, ca, '/api/stream', token, unlockToken, () => false)
    await vi.waitFor(() => expect(service.streamCount()).toBe(1))
    service.lock.lockAll()
    const result = await reading
    expect(result.ended).toBe(true)
    expect(result.seen.map(entry => entry.event)).toEqual(['state', 'locked'])
  })

  it('closes a stream opened before any code existed once a code is set', { timeout: 30_000 }, async () => {
    const { service, port, ca, token } = await fixture()
    const reading = events(port, ca, '/api/stream', token, '', () => false)
    await vi.waitFor(() => expect(service.streamCount()).toBe(1))
    await service.lock.setCode('482915')
    const result = await reading
    expect(result.ended).toBe(true)
    expect(result.seen.map(entry => entry.event)).toEqual(['state', 'locked'])
    expect((await call(port, ca, '/api/stream', { token })).status).toBe(423)
  })

  it('sends a locked phone notifications without their content',{ timeout: 30_000 }, async () => {
    const { service, push, deviceId } = await fixture()
    service.setSubscription(deviceId, { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } })
    const notification = { id: 'n1', kind: 'attention' as const, sessionId: 'session-a', title: 'Codex needs you', body: 'Approve rm -rf build?', at: 'now', url: '/#/session/session-a' }
    await service.sendNotification(notification)
    expect(JSON.parse(String((push.mock.calls[0] as unknown[])[1]))).toMatchObject({ title: 'Codex needs you' })
    await service.lock.setCode('482915')
    await service.sendNotification(notification)
    const redacted = JSON.parse(String((push.mock.calls[1] as unknown[])[1]))
    expect(redacted).toEqual({ id: 'n1', kind: 'attention', sessionId: null, title: 'Conductor', body: 'Unlock Conductor to see what changed.', at: 'now', url: '/#/' })
    await service.lock.unlock('482915', { id: deviceId })
    await service.sendNotification(notification)
    expect(JSON.parse(String((push.mock.calls[2] as unknown[])[1]))).toMatchObject({ body: 'Approve rm -rf build?' })
  })
})

describe('the phone terminal on the listener', () => {
  it('needs a code, opens with the code again, runs echo ok, and dies with the lock, leaving one audit line', { timeout: 30_000 }, async () => {
    const runtime = new EchoRuntime()
    const { service, port, ca, token, audit } = await fixture({ terminals: runtime })
    // No code set: no terminal, even though every other route answers.
    expect((await call(port, ca, '/api/terminal', { token })).status).toBe(403)
    await service.lock.setCode('482915')
    const { unlockToken } = JSON.parse((await call(port, ca, '/api/lock/unlock', { method: 'POST', token, body: { code: '482915' } })).body) as { unlockToken: string }
    const request = { projectId: 'project-a', workspaceId: 'ws-1', cols: 40, rows: 20 }
    const wrong = await call(port, ca, '/api/terminal/open', { method: 'POST', token, unlock: unlockToken, body: { ...request, code: '111111' } })
    expect(wrong.status).toBe(403)
    const peer = await call(port, ca, '/api/terminal/open', { method: 'POST', token, unlock: unlockToken, body: { ...request, code: '482915', machineId: 'peer-mac' } })
    expect(peer.status).toBe(403)
    expect(JSON.parse(peer.body).error).toMatch(/MAIN only/)
    const opened = await call(port, ca, '/api/terminal/open', { method: 'POST', token, unlock: unlockToken, body: { ...request, code: '482915' } })
    expect(opened.status).toBe(200)
    const { terminalId } = JSON.parse(opened.body) as { terminalId: string }
    const text = (seen: Array<{ event: string; data: Record<string, unknown> }>): string => seen.filter(entry => entry.event === 'data').map(entry => Buffer.from(String(entry.data.data), 'base64').toString('utf8')).join('')
    const reading = events(port, ca, `/api/terminal/${terminalId}/stream`, token, unlockToken, seen => /ok\r\nPS> $/.test(text(seen)))
    await vi.waitFor(() => expect(runtime.buffers.get(terminalId)!.offset).toBeGreaterThan(0))
    const input = await call(port, ca, `/api/terminal/${terminalId}/input`, { method: 'POST', token, unlock: unlockToken, body: { data: Buffer.from('echo ok\r').toString('base64') } })
    expect(input.status).toBe(200)
    expect(text((await reading).seen)).toContain('echo ok\r\nok\r\nPS> ')
    expect((await call(port, ca, `/api/terminal/${terminalId}/resize`, { method: 'POST', token, unlock: unlockToken, body: { cols: 50, rows: 30 } })).status).toBe(200)
    // Another unlocked session of the same phone does not see this shell.
    const { unlockToken: other } = await service.lock.unlock('482915', { id: service.listDevices()[0]!.id })
    expect((await call(port, ca, `/api/terminal/${terminalId}/input`, { method: 'POST', token, unlock: other, body: { data: 'eA==' } })).status).toBe(404)
    const watching = events(port, ca, `/api/terminal/${terminalId}/stream`, token, unlockToken, () => false)
    await new Promise(resolve => setTimeout(resolve, 50))
    service.lock.lockAll()
    const closed = await watching
    expect(closed.ended).toBe(true)
    expect(closed.seen.map(entry => entry.event)).toContain('closed')
    expect(runtime.killed).toEqual([terminalId])
    const lines = audit.mock.calls.map(entry => String(entry[0])).filter(line => line.startsWith('phone terminal:'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/device "iPhone" .* on MAIN in Conductor \/ main; .*; phone locked; 8 bytes typed$/)
  })
})
