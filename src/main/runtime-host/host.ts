import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { LineReader, RUNTIME_BUFFER_BYTES, RUNTIME_BUFFER_FRAMES, RUNTIME_HOST_FEATURES, RUNTIME_HOST_PROTOCOL, type FrameStream, type HostMessage, type HostRequest, type RuntimeInfo, type RuntimeSpawn } from './protocol'
import { McpRelay } from './relay'

export interface RuntimeHostOptions {
  pipe: string
  secret: string
  /** No runtime alive and no client connected for this long ends the host (onIdle). */
  idleMs?: number
  /** A runtime its client detached from and nobody reattached within this long is closed. */
  unattachedMs?: number
  bufferBytes?: number
  bufferFrames?: number
  /** How long an MCP request waits for an app to take its route over again (McpRelay). */
  relayWaitMs?: number
  log?(message: string): void
  onIdle?(): void
}

interface Client { socket: Socket; authed: boolean }
interface Frame { seq: number; text: string }
interface Runtime {
  info: RuntimeInfo
  child?: ChildProcessWithoutNullStreams
  frames: Frame[]
  bytes: number
  owner?: Client
  unattachedTimer?: NodeJS.Timeout
}

/** Owns provider child processes on behalf of Conductor main processes that come and go
 *  (docs/runtime-host.md). Knows nothing about any provider protocol: it moves lines. */
export class RuntimeHost {
  private server?: Server
  private runtimes = new Map<string, Runtime>()
  private clients = new Set<Client>()
  private idleTimer?: NodeJS.Timeout
  private closed = false
  private readonly idleMs: number
  private readonly unattachedMs: number
  private readonly bufferBytes: number
  private readonly bufferFrames: number
  private readonly relay: McpRelay

  constructor(private options: RuntimeHostOptions) {
    this.idleMs = options.idleMs ?? 5 * 60_000
    this.unattachedMs = options.unattachedMs ?? 12 * 60 * 60_000
    this.bufferBytes = options.bufferBytes ?? RUNTIME_BUFFER_BYTES
    this.bufferFrames = options.bufferFrames ?? RUNTIME_BUFFER_FRAMES
    this.relay = new McpRelay({ waitMs: options.relayWaitMs, log: options.log })
  }

  listen(): Promise<void> {
    const server = createServer(socket => this.accept(socket))
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.pipe, () => { server.off('error', reject); this.checkIdle(); resolve() })
    })
  }

  /** Stops every runtime and the pipe. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const runtime of this.runtimes.values()) this.stop(runtime)
    for (const client of this.clients) client.socket.destroy()
    await this.relay.close()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }

  list(): RuntimeInfo[] { return [...this.runtimes.values()].map(runtime => ({ ...runtime.info, attached: Boolean(runtime.owner), buffered: runtime.frames.length, meta: { ...runtime.info.meta } })) }

  private accept(socket: Socket): void {
    const client: Client = { socket, authed: false }
    this.clients.add(client)
    this.checkIdle()
    const reader = new LineReader(line => {
      let request: HostRequest
      try { request = JSON.parse(line) as HostRequest } catch { socket.destroy(); return }
      try { this.handle(client, request) } catch (error) {
        if ('id' in request && typeof request.id === 'number') this.reply(client, request.id, false, error instanceof Error ? error.message : String(error))
      }
    })
    socket.on('data', chunk => { try { reader.push(chunk) } catch { socket.destroy() } })
    socket.on('error', () => { /* 'close' follows */ })
    socket.on('close', () => this.release(client))
  }

  private handle(client: Client, request: HostRequest): void {
    if (request.op === 'hello') {
      const given = Buffer.from(String(request.secret ?? '')), expected = Buffer.from(this.options.secret)
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { client.socket.destroy(); return }
      if (request.protocol !== RUNTIME_HOST_PROTOCOL) { this.reply(client, request.id, false, `Runtime host speaks protocol ${RUNTIME_HOST_PROTOCOL}, not ${request.protocol}`); return }
      client.authed = true
      this.reply(client, request.id, true, { pid: process.pid, protocol: RUNTIME_HOST_PROTOCOL, features: RUNTIME_HOST_FEATURES })
      return
    }
    if (!client.authed) { client.socket.destroy(); return }
    switch (request.op) {
      case 'spawn': return this.reply(client, request.id, true, this.spawn(client, request))
      case 'send': {
        const runtime = this.runtimes.get(request.runtimeId)
        if (runtime?.owner === client && runtime.info.alive && runtime.child?.stdin.writable) runtime.child.stdin.write(request.line + '\n')
        return
      }
      case 'attach': return this.attach(client, request.id, request.runtimeId, request.afterSeq)
      case 'detach': {
        const runtime = this.owned(client, request.runtimeId)
        this.acknowledge(runtime, request.seq)
        runtime.owner = undefined
        runtime.info.detached = true
        runtime.info.detachedAt = new Date().toISOString()
        if (request.meta) runtime.info.meta = { ...runtime.info.meta, ...request.meta }
        this.armUnattached(runtime)
        this.options.log?.(`detached ${runtime.info.runtimeId} at ${request.seq} (last ${runtime.info.lastSeq})`)
        this.reply(client, request.id, true)
        return this.checkIdle()
      }
      case 'ack': {
        const runtime = this.runtimes.get(request.runtimeId)
        if (runtime?.owner === client) this.acknowledge(runtime, request.seq)
        return
      }
      case 'close': {
        const runtime = this.runtimes.get(request.runtimeId)
        if (runtime && runtime.owner && runtime.owner !== client) { if (request.id !== undefined) this.reply(client, request.id, false, 'Runtime belongs to another client'); return }
        if (runtime) { runtime.owner = client; this.stop(runtime); if (!runtime.info.alive) this.forget(runtime) }
        if (request.id !== undefined) this.reply(client, request.id, true)
        return
      }
      case 'list': return this.reply(client, request.id, true, this.list())
      case 'stopAll': {
        let stopped = 0
        for (const runtime of [...this.runtimes.values()]) {
          if (request.onlyUnowned && runtime.owner && runtime.owner !== client) continue
          if (runtime.info.alive) stopped++
          this.stop(runtime)
          if (!runtime.info.alive) this.forget(runtime)
        }
        return this.reply(client, request.id, true, { stopped })
      }
      case 'relay': {
        const id = request.id
        this.relay.register(client, request.key, request.servers).then(routes => this.reply(client, id, true, routes), error => this.reply(client, id, false, error instanceof Error ? error.message : String(error)))
        return
      }
      case 'shutdown':
        this.reply(client, request.id, true)
        void this.close().then(() => this.options.onIdle?.())
        return
      default: throw new Error('Unknown runtime host request')
    }
  }

  private spawn(client: Client, request: RuntimeSpawn): { pid: number | null } {
    if (!/^[\w.:-]{1,160}$/.test(String(request.runtimeId))) throw new Error('Invalid runtime id')
    if (this.runtimes.has(request.runtimeId)) throw new Error('Runtime already exists')
    if (/\.(cmd|bat)$/i.test(request.executable)) throw new Error('A native executable is required for structured agent transport')
    const runtime: Runtime = {
      info: { runtimeId: request.runtimeId, pid: null, alive: true, exitCode: null, signal: null, attached: true, detached: false, lastSeq: 0, ackSeq: 0, buffered: 0, lostFrames: 0, startedAt: new Date().toISOString(), detachedAt: null, meta: { ...request.meta } },
      frames: [], bytes: 0, owner: client
    }
    this.runtimes.set(request.runtimeId, runtime)
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    } catch (error) {
      this.push(runtime, 'error', error instanceof Error ? error.message : String(error))
      this.exited(runtime, null, null)
      return { pid: null }
    }
    runtime.child = child
    runtime.info.pid = child.pid ?? null
    const stdout = new LineReader(line => this.push(runtime, 'stdout', line)), stderr = new StringDecoder('utf8')
    child.stdout.on('data', (chunk: Buffer) => { try { stdout.push(chunk) } catch (error) { this.push(runtime, 'error', error instanceof Error ? error.message : String(error)); this.stop(runtime) } })
    child.stdout.on('end', () => { const rest = stdout.end(); if (rest) this.push(runtime, 'stdout', rest) })
    child.stderr.on('data', (chunk: Buffer) => { const text = stderr.write(chunk); if (text) this.push(runtime, 'stderr', text) })
    child.stdin.on('error', error => this.push(runtime, 'error', error.message))
    child.on('error', error => {
      this.push(runtime, 'error', error.message)
      // A process that never started emits no 'close' on some platforms.
      if (!child.pid) this.exited(runtime, null, null)
    })
    child.on('close', (code, signal) => this.exited(runtime, code, signal))
    this.options.log?.(`spawned ${request.runtimeId} pid ${child.pid ?? '?'} ${request.executable}`)
    return { pid: child.pid ?? null }
  }

  private attach(client: Client, id: number, runtimeId: string, afterSeq: number): void {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) return this.reply(client, id, false, 'Runtime not found')
    if (runtime.owner && runtime.owner !== client && !runtime.owner.socket.destroyed) return this.reply(client, id, false, 'Runtime is attached to another client')
    runtime.owner = client
    runtime.info.detached = false
    runtime.info.detachedAt = null
    if (runtime.unattachedTimer) clearTimeout(runtime.unattachedTimer)
    runtime.unattachedTimer = undefined
    const replay = runtime.frames.filter(frame => frame.seq > afterSeq)
    // Frames between afterSeq and the oldest one kept were dropped when the buffer overflowed.
    const missing = replay.length && replay[0]!.seq > afterSeq + 1 ? replay[0]!.seq - afterSeq - 1 : !replay.length && runtime.info.lastSeq > afterSeq ? runtime.info.lastSeq - afterSeq : 0
    for (const frame of replay) client.socket.write(frame.text + '\n')
    this.options.log?.(`attached ${runtimeId} after ${afterSeq}: replayed ${replay.length}, missing ${missing}`)
    this.reply(client, id, true, { lastSeq: runtime.info.lastSeq, replayed: replay.length, missing, alive: runtime.info.alive })
    this.checkIdle()
  }

  private owned(client: Client, runtimeId: string): Runtime {
    const runtime = this.runtimes.get(runtimeId)
    if (!runtime) throw new Error('Runtime not found')
    if (runtime.owner !== client) throw new Error('Runtime is not attached to this client')
    return runtime
  }

  private push(runtime: Runtime, stream: FrameStream, data: string): void {
    const seq = ++runtime.info.lastSeq
    this.record(runtime, { op: 'frame', runtimeId: runtime.info.runtimeId, seq, stream, data })
  }

  private record(runtime: Runtime, message: Extract<HostMessage, { seq: number }>): void {
    const text = JSON.stringify(message)
    runtime.frames.push({ seq: message.seq, text })
    runtime.bytes += text.length
    while (runtime.frames.length > 1 && (runtime.bytes > this.bufferBytes || runtime.frames.length > this.bufferFrames)) {
      runtime.bytes -= runtime.frames.shift()!.text.length
      runtime.info.lostFrames++
    }
    const owner = runtime.owner
    if (owner && !owner.socket.destroyed) owner.socket.write(text + '\n')
  }

  private exited(runtime: Runtime, code: number | null, signal: NodeJS.Signals | null): void {
    if (!runtime.info.alive) return
    runtime.info.alive = false
    runtime.info.exitCode = code
    runtime.info.signal = signal
    this.record(runtime, { op: 'exit', runtimeId: runtime.info.runtimeId, seq: ++runtime.info.lastSeq, code, signal })
    this.options.log?.(`exited ${runtime.info.runtimeId} (${signal ?? code ?? 'unknown'})`)
    // Nobody will ever read the exit of a runtime whose client is gone and did not detach.
    if (!runtime.owner && !runtime.info.detached) this.forget(runtime)
    this.checkIdle()
  }

  private acknowledge(runtime: Runtime, seq: number): void {
    if (!Number.isFinite(seq) || seq <= runtime.info.ackSeq) return
    runtime.info.ackSeq = Math.min(seq, runtime.info.lastSeq)
    while (runtime.frames.length && runtime.frames[0]!.seq <= runtime.info.ackSeq) runtime.bytes -= runtime.frames.shift()!.text.length
    if (!runtime.info.alive && runtime.info.ackSeq >= runtime.info.lastSeq) this.forget(runtime)
  }

  /** Ends the child and its whole tree. */
  private stop(runtime: Runtime): void {
    const child = runtime.child
    if (!child || !runtime.info.alive) return
    try { child.stdin.end() } catch { /* already closed */ }
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
    } else child.kill('SIGTERM')
  }

  private forget(runtime: Runtime): void {
    if (runtime.unattachedTimer) clearTimeout(runtime.unattachedTimer)
    this.runtimes.delete(runtime.info.runtimeId)
    this.checkIdle()
  }

  private armUnattached(runtime: Runtime): void {
    if (runtime.unattachedTimer) clearTimeout(runtime.unattachedTimer)
    runtime.unattachedTimer = setTimeout(() => {
      if (runtime.owner) return
      this.options.log?.(`closing ${runtime.info.runtimeId}: nobody reattached within ${this.unattachedMs} ms`)
      this.stop(runtime)
      this.forget(runtime)
    }, this.unattachedMs)
    runtime.unattachedTimer.unref?.()
  }

  /** A client that goes away without detaching (a crash, a dev instance killed) takes its
   *  runtimes with it: without the adapter state it saves on detach, nobody could continue them. */
  private release(client: Client): void {
    this.clients.delete(client)
    this.relay.release(client)
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.owner !== client) continue
      runtime.owner = undefined
      this.options.log?.(`client left without detaching ${runtime.info.runtimeId}; closing it`)
      this.stop(runtime)
      if (!runtime.info.alive) this.forget(runtime)
    }
    this.checkIdle()
  }

  private checkIdle(): void {
    if (this.closed) return
    const idle = !this.clients.size && ![...this.runtimes.values()].some(runtime => runtime.info.alive)
    if (!idle) { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined; return }
    if (this.idleTimer) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      this.options.log?.('idle: no runtime alive and no client attached')
      void this.close().then(() => this.options.onIdle?.())
    }, this.idleMs)
  }

  private reply(client: Client, id: number, ok: boolean, value?: unknown): void {
    if (client.socket.destroyed) return
    const message: HostMessage = ok ? { op: 'result', id, ok: true, ...(value === undefined ? {} : { value }) } : { op: 'result', id, ok: false, error: String(value) }
    client.socket.write(JSON.stringify(message) + '\n')
  }
}
