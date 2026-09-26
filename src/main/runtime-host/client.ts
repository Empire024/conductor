import { connect, type Socket } from 'node:net'
import { LineReader, RUNTIME_HOST_PROTOCOL, type FrameStream, type HostMessage, type HostRequest, type RelayRoute, type RelayServer, type RuntimeInfo, type RuntimeMeta, type RuntimeSpawn } from './protocol'

export interface RuntimeListener {
  frame(seq: number, stream: FrameStream, data: string): void
  exit(seq: number, code: number | null, signal: string | null): void
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Request = WithoutId<Extract<HostRequest, { id: number }>>

/** How long a request waits for the host's answer, counted from when it left this process. */
export const REQUEST_TIMEOUT_MS = 15_000
/** `attach` waits longer: giving up on it is what used to cost a kept turn (FX33). */
export const ATTACH_TIMEOUT_MS = 120_000
/** A timer this much later than it was due means this process's event loop was stalled, so the
 *  host's answer may be sitting unread in the pipe: the wait starts over instead of failing. */
export const STALL_TOLERANCE_MS = 1_000

/** The main process's end of the runtime host pipe (docs/runtime-host.md). */
export class RuntimeHostClient {
  private nextId = 1
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  /** Attach requests this process gave up on: a late answer that the host attached them after all
   *  lets go of the runtime again instead of leaving it to nobody (FX33). */
  private expiredAttaches = new Map<number, { runtimeId: string; afterSeq: number }>()
  /** Runtimes whose attach this process gave up on. The host may still hold them alive, so a close
   *  from the conversation that failed is not sent: a timeout here is no reason to end a turn. */
  private abandoned = new Set<string>()
  private listeners = new Map<string, RuntimeListener>()
  private closed = false
  private lostHandlers = new Set<() => void>()
  /** What this host offers beyond the process relay (RUNTIME_HOST_FEATURES); none for an older host. */
  readonly features: readonly string[] = []

  private constructor(private socket: Socket, readonly hostPid: number) {}

  static async connect(pipe: string, secret: string, timeoutMs = 3000): Promise<RuntimeHostClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(pipe)
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Runtime host did not answer')) }, timeoutMs)
      socket.once('connect', () => { clearTimeout(timer); socket.off('error', reject); resolve(socket) })
      socket.once('error', error => { clearTimeout(timer); reject(error) })
    })
    const client = new RuntimeHostClient(socket, 0)
    client.wire()
    try {
      const hello = await client.request({ op: 'hello', secret, protocol: RUNTIME_HOST_PROTOCOL, client: `main:${process.pid}` }, timeoutMs) as { pid: number; features?: unknown }
      ;(client as { hostPid: number }).hostPid = hello.pid
      ;(client as { features: readonly string[] }).features = Array.isArray(hello.features) ? hello.features.filter((feature): feature is string => typeof feature === 'string') : []
      return client
    } catch (error) { socket.destroy(); throw error }
  }

  get connected(): boolean { return !this.closed && !this.socket.destroyed }

  /** Called once when the pipe drops; every attached runtime has already been told it exited. */
  onLost(handler: () => void): () => void { this.lostHandlers.add(handler); return () => this.lostHandlers.delete(handler) }

  spawn(spec: RuntimeSpawn, listener: RuntimeListener): Promise<{ pid: number | null }> {
    this.listeners.set(spec.runtimeId, listener)
    return this.request({ op: 'spawn', ...spec }) as Promise<{ pid: number | null }>
  }
  /** Replays every buffered frame after `afterSeq` into `listener`, then streams live. */
  attach(runtimeId: string, afterSeq: number, listener: RuntimeListener, timeoutMs = ATTACH_TIMEOUT_MS): Promise<{ lastSeq: number; replayed: number; missing: number; alive: boolean }> {
    this.listeners.set(runtimeId, listener)
    this.abandoned.delete(runtimeId)
    let requestId = 0
    return (this.request({ op: 'attach', runtimeId, afterSeq }, timeoutMs, id => { requestId = id }) as Promise<{ lastSeq: number; replayed: number; missing: number; alive: boolean }>)
      .catch(error => {
        if (this.listeners.get(runtimeId) === listener) this.listeners.delete(runtimeId)
        if (error instanceof RequestTimeout) { this.abandoned.add(runtimeId); this.expiredAttaches.set(requestId, { runtimeId, afterSeq }) }
        throw error
      })
  }
  /** Lets go of a runtime without ending it; `seq` is the last frame this process handled. */
  async detach(runtimeId: string, seq: number, meta?: RuntimeMeta): Promise<void> {
    this.listeners.delete(runtimeId)
    await this.request({ op: 'detach', runtimeId, seq, ...(meta ? { meta } : {}) })
  }
  send(runtimeId: string, line: string): void { this.post({ op: 'send', runtimeId, line }) }
  ack(runtimeId: string, seq: number): void { this.post({ op: 'ack', runtimeId, seq }) }
  close(runtimeId: string): void {
    if (this.abandoned.has(runtimeId)) return
    this.post({ op: 'close', runtimeId })
  }
  list(): Promise<RuntimeInfo[]> { return this.request({ op: 'list' }) as Promise<RuntimeInfo[]> }
  stopAll(onlyUnowned = false): Promise<{ stopped: number }> { return this.request({ op: 'stopAll', onlyUnowned }) as Promise<{ stopped: number }> }
  shutdown(): Promise<unknown> { return this.request({ op: 'shutdown' }) }
  /** Points `key`'s relayed MCP servers at where this app serves them now (McpRelay.register). */
  relay(key: string, servers: RelayServer[]): Promise<RelayRoute[]> { return this.request({ op: 'relay', key, servers }) as Promise<RelayRoute[]> }
  /** Asks the host to keep app control's port answering, and hold what arrives, once this app
   *  lets go of it; false when the host cannot (an older build). */
  async holdControl(port: number): Promise<boolean> {
    if (!this.features.includes('control-hold')) return false
    await this.request({ op: 'holdControl', port })
    return true
  }
  /** Takes app control's port back from the host, which then hands this app what it held. */
  async releaseControl(port: number): Promise<{ released: boolean; held: number }> {
    if (!this.features.includes('control-hold')) return { released: false, held: 0 }
    return await this.request({ op: 'releaseControl', port }) as { released: boolean; held: number }
  }
  /** Resolves once everything written so far has left this process. */
  flush(): Promise<void> {
    if (!this.connected) return Promise.resolve()
    return new Promise(resolve => this.socket.write('', () => resolve()))
  }
  dispose(): void { this.closed = true; this.socket.end() }

  /**
   * One request and its answer. The wait is counted from when the request actually left this
   * process (the socket's write callback), not from when it was queued: a request written while
   * an earlier write was still in flight sits in the stream's buffer until the event loop runs.
   * A timer that fires late means this process was stalled, and after a stall the timers run
   * before the pipe is read, so an answer the host sent in time would be missed: the wait starts
   * over. Before giving up, the pipe gets one more turn of the loop to deliver what it holds.
   * (2026-09-25: a 71 s startup stall let seven attach timers expire with their answers unread,
   * and each failed attach closed a turn the host was keeping alive.)
   */
  private request(body: Request, timeoutMs = REQUEST_TIMEOUT_MS, identify?: (id: number) => void): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error('Runtime host is not connected'))
    const id = this.nextId++
    identify?.(id)
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined, left = false, unsentRounds = 0
      const arm = (): void => {
        const due = Date.now() + timeoutMs
        timer = setTimeout(() => expire(due), timeoutMs)
        timer.unref?.()
      }
      const expire = (due: number): void => {
        if (!this.pending.has(id)) return
        if (Date.now() - due > STALL_TOLERANCE_MS) { arm(); return }
        // Not sent yet: the host cannot have answered. Only a pipe that never drains ends it.
        if (!left && ++unsentRounds < 4) { arm(); return }
        setImmediate(() => {
          if (!this.pending.has(id)) return
          this.pending.delete(id)
          reject(new RequestTimeout(`Runtime host did not answer ${body.op}`))
        })
      }
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      arm()
      this.socket.write(JSON.stringify({ ...body, id }) + '\n', error => {
        if (error || left) return
        left = true
        clearTimeout(timer)
        arm()
      })
    })
  }
  private post(message: HostRequest): void { if (this.connected) this.socket.write(JSON.stringify(message) + '\n') }

  private wire(): void {
    const reader = new LineReader(line => {
      let message: HostMessage
      try { message = JSON.parse(line) as HostMessage } catch { return }
      if (message.op === 'result') {
        const waiting = this.pending.get(message.id)
        if (!waiting) { this.lateAnswer(message); return }
        this.pending.delete(message.id)
        if (message.ok) waiting.resolve(message.value)
        else waiting.reject(new Error(message.error))
      } else if (message.op === 'frame') this.listeners.get(message.runtimeId)?.frame(message.seq, message.stream, message.data)
      else if (message.op === 'exit') {
        const listener = this.listeners.get(message.runtimeId)
        this.listeners.delete(message.runtimeId)
        listener?.exit(message.seq, message.code, message.signal)
      }
    })
    this.socket.on('data', chunk => { try { reader.push(chunk) } catch { this.socket.destroy() } })
    this.socket.on('error', () => { /* 'close' follows */ })
    this.socket.on('close', () => {
      this.closed = true
      for (const waiting of this.pending.values()) waiting.reject(new Error('Runtime host connection closed'))
      this.pending.clear()
      const listeners = [...this.listeners.values()]
      this.listeners.clear()
      for (const listener of listeners) {
        listener.frame(0, 'error', 'The runtime host connection was lost')
        listener.exit(0, null, null)
      }
      for (const handler of this.lostHandlers) { try { handler() } catch { /* one handler never blocks another */ } }
    })
  }

  /** The host attached a runtime after this process stopped waiting: it streams to nobody here,
   *  so it is detached again at the position asked for and stays alive in the host. */
  private lateAnswer(message: Extract<HostMessage, { op: 'result' }>): void {
    const expired = this.expiredAttaches.get(message.id)
    if (!expired) return
    this.expiredAttaches.delete(message.id)
    if (!message.ok || this.listeners.has(expired.runtimeId)) return
    void this.request({ op: 'detach', runtimeId: expired.runtimeId, seq: expired.afterSeq }).catch(() => { /* the host keeps it either way until its client leaves */ })
  }
}

/** A request the host did not answer in time (as opposed to one it refused). */
export class RequestTimeout extends Error {}
