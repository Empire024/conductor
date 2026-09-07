import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Json } from '../../shared/structured-agent'

export interface TransportOptions {
  executable: string
  args: string[]
  cwd: string
  environment?: NodeJS.ProcessEnv
  onMessage(message: Json): void
  onStderr?(text: string): void
  onExit?(code: number | null, signal: NodeJS.Signals | null): void
  onError?(error: Error): void
}

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

export class JsonLineTransport {
  private child?: ChildProcessWithoutNullStreams
  private exited = false
  get connected(): boolean { return Boolean(this.child && !this.exited && !this.child.killed && this.child.stdin.writable) }
  constructor(private options: TransportOptions) {}
  start(): void {
    if (this.child) throw new Error('Transport already started')
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
  send(message: Json): void {
    if (!this.connected || !this.child) throw new Error('Provider transport disconnected')
    const line = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(line) > 8 * 1024 * 1024 || this.child.stdin.writableLength > 8 * 1024 * 1024) throw new Error('Provider input queue exceeded limit')
    this.child.stdin.write(line)
  }
  close(): void {
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
