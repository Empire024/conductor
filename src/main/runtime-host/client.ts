import { connect, type Socket } from 'node:net'
import { LineReader, RUNTIME_HOST_PROTOCOL, type FrameStream, type HostMessage, type HostRequest, type RuntimeInfo, type RuntimeMeta, type RuntimeSpawn } from './protocol'

export interface RuntimeListener {
  frame(seq: number, stream: FrameStream, data: string): void
  exit(seq: number, code: number | null, signal: string | null): void
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type Request = WithoutId<Extract<HostRequest, { id: number }>>

/** The main process's end of the runtime host pipe (docs/runtime-host.md). */
export class RuntimeHostClient {
  private nextId = 1
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private listeners = new Map<string, RuntimeListener>()
  private closed = false
  private lostHandlers = new Set<() => void>()

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
      const hello = await client.request({ op: 'hello', secret, protocol: RUNTIME_HOST_PROTOCOL, client: `main:${process.pid}` }, timeoutMs) as { pid: number }
      ;(client as { hostPid: number }).hostPid = hello.pid
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
  attach(runtimeId: string, afterSeq: number, listener: RuntimeListener): Promise<{ lastSeq: number; replayed: number; missing: number; alive: boolean }> {
    this.listeners.set(runtimeId, listener)
    return (this.request({ op: 'attach', runtimeId, afterSeq }) as Promise<{ lastSeq: number; replayed: number; missing: number; alive: boolean }>)
      .catch(error => { if (this.listeners.get(runtimeId) === listener) this.listeners.delete(runtimeId); throw error })
  }
  /** Lets go of a runtime without ending it; `seq` is the last frame this process handled. */
  async detach(runtimeId: string, seq: number, meta?: RuntimeMeta): Promise<void> {
    this.listeners.delete(runtimeId)
    await this.request({ op: 'detach', runtimeId, seq, ...(meta ? { meta } : {}) })
  }
  send(runtimeId: string, line: string): void { this.post({ op: 'send', runtimeId, line }) }
  ack(runtimeId: string, seq: number): void { this.post({ op: 'ack', runtimeId, seq }) }
  close(runtimeId: string): void { this.post({ op: 'close', runtimeId }) }
  list(): Promise<RuntimeInfo[]> { return this.request({ op: 'list' }) as Promise<RuntimeInfo[]> }
  stopAll(onlyUnowned = false): Promise<{ stopped: number }> { return this.request({ op: 'stopAll', onlyUnowned }) as Promise<{ stopped: number }> }
  shutdown(): Promise<unknown> { return this.request({ op: 'shutdown' }) }
  /** Resolves once everything written so far has left this process. */
  flush(): Promise<void> {
    if (!this.connected) return Promise.resolve()
    return new Promise(resolve => this.socket.write('', () => resolve()))
  }
  dispose(): void { this.closed = true; this.socket.end() }

  private request(body: Request, timeoutMs = 15_000): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error('Runtime host is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Runtime host did not answer ${body.op}`)) }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.socket.write(JSON.stringify({ ...body, id }) + '\n')
    })
  }
  private post(message: HostRequest): void { if (this.connected) this.socket.write(JSON.stringify(message) + '\n') }

  private wire(): void {
    const reader = new LineReader(line => {
      let message: HostMessage
      try { message = JSON.parse(line) as HostMessage } catch { return }
      if (message.op === 'result') {
        const waiting = this.pending.get(message.id)
        if (!waiting) return
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
}
