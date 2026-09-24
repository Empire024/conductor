import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Json } from '../../shared/structured-agent'
import type { RuntimeHostClient } from '../runtime-host/client'
import type { RuntimeMeta } from '../runtime-host/protocol'

/** A running provider process held by the runtime host (docs/runtime-host.md): which one, and
 *  the last frame of it this process handled. */
export interface HostedRuntimeHandle { runtimeId: string; seq: number }

export interface TransportOptions {
  executable: string
  args: string[]
  cwd: string
  environment?: NodeJS.ProcessEnv
  onMessage(message: Json): void
  onStderr?(text: string): void
  onExit?(code: number | null, signal: NodeJS.Signals | null): void
  onError?(error: Error): void
  /** Continue a process the runtime host kept running instead of spawning one. */
  attach?: HostedRuntimeHandle
}

let runtimeHost: RuntimeHostClient | null = null
/** Every transport started while a connected host is installed spawns through it and can be
 *  detached; with none (the setting is off, the host is unavailable, tests) it spawns directly. */
export function setRuntimeHost(client: RuntimeHostClient | null): void { runtimeHost = client }
export function currentRuntimeHost(): RuntimeHostClient | null { return runtimeHost?.connected ? runtimeHost : null }

/** Newline-framed JSON with incremental UTF-8 decoding, separate stderr, and hard limits. */
export class JsonLineDecoder {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private failed = false
  constructor(private message: (value: Json) => void, private error: (error: Error) => void, private maxBytes = 8 * 1024 * 1024) {}
  push(chunk: Buffer | string): void {
    if (this.failed) return
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '')
      this.pending = this.pending.slice(end + 1)
      if (Buffer.byteLength(line) > this.maxBytes) return this.fail('Provider frame exceeded 8 MiB limit')
      if (!line.trim()) continue
      try { this.message(JSON.parse(line) as Json) } catch (error) {
        // Never include possibly secret frame contents in a diagnostic.
        return this.fail(error instanceof SyntaxError ? 'Malformed provider JSON frame' : 'Provider event handler failed')
      }
    }
    if (Buffer.byteLength(this.pending) > this.maxBytes) this.fail('Provider frame exceeded 8 MiB limit')
  }
  end(): void {
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.push('\n')
  }
  private fail(message: string): void { this.failed = true; this.pending = ''; this.error(new Error(message)) }
}

interface Hosted { client: RuntimeHostClient; runtimeId: string; seq: number; acked: number; ackTimer?: NodeJS.Timeout; closing: boolean; detached: boolean }

export class JsonLineTransport {
  private child?: ChildProcessWithoutNullStreams
  private exited = false
  private hosted?: Hosted
  private exitWaiters: Array<() => void> = []
  get connected(): boolean {
    if (this.hosted) return !this.exited && !this.hosted.closing && !this.hosted.detached && this.hosted.client.connected
    return Boolean(this.child && !this.exited && !this.child.killed && this.child.stdin.writable)
  }
  /** Whether this process lives in the runtime host, and so can outlive the app. */
  get detachable(): boolean { return Boolean(this.hosted && this.connected) }
  constructor(private options: TransportOptions) {}
  start(): void {
    if (this.child || this.hosted) throw new Error('Transport already started')
    const host = currentRuntimeHost()
    if (this.options.attach) {
      if (!host) throw new Error('The runtime host is not connected, so the running provider process cannot be reattached')
      return this.startHosted(host, this.options.attach)
    }
    if (host) return this.startHosted(host)
    // .cmd/.bat need a shell and unsafe quoting; callers must resolve the native exe or JS entry point.
    if (/\.(cmd|bat)$/i.test(this.options.executable)) throw new Error('A native executable is required for structured agent transport')
    const child = spawn(this.options.executable, this.options.args, {
      cwd: this.options.cwd, env: this.options.environment ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
    })
    this.child = child
    const decoder = new JsonLineDecoder(this.options.onMessage, (error) => { this.options.onError?.(error); this.close() })
    const stderr = new StringDecoder('utf8')
    child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.options.onStderr?.(stderr.write(chunk).slice(-32_768)))
    child.stdout.on('end', () => decoder.end())
    child.stdin.on('error', (error) => this.options.onError?.(error))
    child.on('error', (error) => { this.exited = true; this.options.onError?.(error) })
    child.on('close', (code, signal) => { this.exited = true; this.options.onExit?.(code, signal) })
  }
  private startHosted(client: RuntimeHostClient, attach?: HostedRuntimeHandle): void {
    // .cmd/.bat need a shell and unsafe quoting; callers must resolve the native exe or JS entry point.
    if (!attach && /\.(cmd|bat)$/i.test(this.options.executable)) throw new Error('A native executable is required for structured agent transport')
    const runtimeId = attach?.runtimeId ?? randomUUID()
    const hosted: Hosted = this.hosted = { client, runtimeId, seq: attach?.seq ?? 0, acked: attach?.seq ?? 0, closing: false, detached: false }
    const decoder = new JsonLineDecoder(this.options.onMessage, (error) => { this.options.onError?.(error); this.close() })
    const listener = {
      frame: (seq: number, stream: string, data: string): void => {
        if (hosted.detached) return
        // A replayed frame this process already handled is never handled twice.
        if (seq) { if (seq <= hosted.seq) return; hosted.seq = seq }
        if (stream === 'stdout') decoder.push(data + '\n')
        else if (stream === 'stderr') this.options.onStderr?.(data.slice(-32_768))
        else this.options.onError?.(new Error(data))
        this.scheduleAck()
      },
      exit: (seq: number, code: number | null, signal: string | null): void => {
        if (hosted.detached || this.exited) return
        if (seq > hosted.seq) hosted.seq = seq
        this.exited = true
        if (hosted.ackTimer) clearTimeout(hosted.ackTimer)
        if (seq) client.ack(runtimeId, seq)
        this.options.onExit?.(code, signal as NodeJS.Signals | null)
        for (const waiter of this.exitWaiters.splice(0)) waiter()
      }
    }
    const failed = (error: unknown): void => {
      if (hosted.detached || this.exited) return
      listener.frame(0, 'error', error instanceof Error ? error.message : String(error))
      listener.exit(0, null, null)
    }
    if (attach) { client.attach(runtimeId, attach.seq, listener).catch(failed); return }
    const env = Object.fromEntries(Object.entries(this.options.environment ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    client.spawn({ runtimeId, executable: this.options.executable, args: this.options.args, cwd: this.options.cwd, env }, listener).catch(failed)
  }
  private scheduleAck(): void {
    const hosted = this.hosted
    if (!hosted || hosted.ackTimer || hosted.detached) return
    hosted.ackTimer = setTimeout(() => {
      hosted.ackTimer = undefined
      if (!hosted.detached && hosted.seq > hosted.acked) { hosted.acked = hosted.seq; hosted.client.ack(hosted.runtimeId, hosted.seq) }
    }, 500)
    hosted.ackTimer.unref?.()
  }
  /** Lets go of a hosted process without ending it, so a later app can continue it. Nothing
   *  reaches this transport's callbacks afterwards. Null when there is nothing to keep. */
  async detach(meta?: RuntimeMeta): Promise<HostedRuntimeHandle | null> {
    const hosted = this.hosted
    if (!hosted || !this.detachable) return null
    hosted.detached = true
    if (hosted.ackTimer) clearTimeout(hosted.ackTimer)
    const handle = { runtimeId: hosted.runtimeId, seq: hosted.seq }
    await hosted.client.detach(hosted.runtimeId, hosted.seq, meta)
    return handle
  }
  send(message: Json): void {
    if (this.hosted) {
      if (!this.connected) throw new Error('Provider transport disconnected')
      const line = JSON.stringify(message)
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error('Provider input queue exceeded limit')
      this.hosted.client.send(this.hosted.runtimeId, line)
      return
    }
    if (!this.connected || !this.child) throw new Error('Provider transport disconnected')
    const line = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(line) > 8 * 1024 * 1024 || this.child.stdin.writableLength > 8 * 1024 * 1024) throw new Error('Provider input queue exceeded limit')
    this.child.stdin.write(line)
  }
  async closeAndWait(): Promise<void> {
    if (this.hosted) {
      if (this.exited || this.hosted.detached) return
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The previous provider process has not exited. Try switching again.')), 5000)
        this.exitWaiters.push(() => { clearTimeout(timer); resolve() })
        this.close()
      })
      return
    }
    const child = this.child
    if (!child || this.exited) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.removeListener('close', closed); reject(new Error('The previous provider process has not exited. Try switching again.')) }, 5000)
      const closed = (): void => { clearTimeout(timer); resolve() }
      child.once('close', closed)
      this.close()
    })
  }
  close(): void {
    if (this.hosted) {
      if (this.exited || this.hosted.closing || this.hosted.detached) return
      this.hosted.closing = true
      this.hosted.client.close(this.hosted.runtimeId)
      return
    }
    const child = this.child
    if (!child || this.exited || child.killed) return
    child.stdin.end()
    if (process.platform === 'win32' && child.pid) {
      // Only the exact child owned by this transport and its descendants.
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
    } else child.kill('SIGTERM')
  }
}
