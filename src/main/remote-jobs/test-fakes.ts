import { gzipSync } from 'node:zlib'
import { MARKER_PREFIX } from './shell.ts'
import type { ExecHandle, ExecOptions, ExecResult, NodeTransport, PushCommit, TransportFactory } from './transport.ts'
import type { ExecutionNode } from './types.ts'

/** Reads back the POSIX single-quoted words of a command line built by shell.ts. */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let at = 0
  while (at < command.length) {
    while (command[at] === ' ') at++
    if (at >= command.length) break
    let word = ''
    while (at < command.length && command[at] !== ' ') {
      if (command[at] === "'") {
        const end = command.indexOf("'", at + 1)
        word += command.slice(at + 1, end)
        at = end + 1
      } else if (command[at] === '\\') { word += command[at + 1]; at += 2 } else { word += command[at]; at++ }
    }
    words.push(word)
  }
  return words
}

export interface FakeJob { id: string; cwd: string; timeoutSec: number; command: string; nonce: string }

export interface FakeRun {
  stdout(text: string | Buffer): void
  stderr(text: string): void
  /** A wrapper line: "started pid=1", "reason=timeout", "exit=0". */
  mark(body: string): void
  end(code: number | null, extra?: Partial<ExecResult>): void
  stdinClosed: boolean
  onStdinClosed(callback: () => void): void
  onKill(callback: () => void): void
}

export type FakeHandler = (command: string, run: FakeRun, options: ExecOptions, nodeId: string) => void

/**
 * A node that answers in memory. Each exec goes to `handler`; the job helper decodes the job
 * wrapper's arguments so a test can act as the wrapper would.
 */
export class FakeNodes {
  readonly calls: Array<{ nodeId: string; command: string; holdStdin: boolean }> = []
  readonly pushes: Array<{ nodeId: string } & PushCommit> = []
  pushError: Error | null = null
  handler: FakeHandler = (_command, run) => run.end(0)

  factory(): TransportFactory {
    return (node: ExecutionNode): NodeTransport => ({
      exec: options => this.exec(node, options),
      pushCommit: async input => {
        this.pushes.push({ nodeId: node.id, ...input })
        if (this.pushError) throw this.pushError
      }
    })
  }

  private exec(node: ExecutionNode, options: ExecOptions): ExecHandle {
    this.calls.push({ nodeId: node.id, command: options.command, holdStdin: Boolean(options.holdStdin) })
    let resolve!: (result: ExecResult) => void
    const done = new Promise<ExecResult>(settle => { resolve = settle })
    let ended = false
    const stdinListeners: Array<() => void> = []
    const killListeners: Array<() => void> = []
    const run: FakeRun = {
      stdout: text => {
        if (options.onStdoutBytes) options.onStdoutBytes(typeof text === 'string' ? Buffer.from(text) : text)
        else options.onStdout?.(typeof text === 'string' ? text : text.toString('utf8'))
      },
      stderr: text => options.onStderr?.(text),
      mark: body => {
        const nonce = FakeNodes.job(options.command)?.nonce ?? ''
        options.onStderr?.(`${MARKER_PREFIX}${nonce} ${body}\n`)
      },
      end: (code, extra) => { if (!ended) { ended = true; resolve({ code, signal: null, error: null, timedOut: false, ...extra }) } },
      stdinClosed: !options.holdStdin,
      onStdinClosed: callback => { stdinListeners.push(callback) },
      onKill: callback => { killListeners.push(callback) }
    }
    queueMicrotask(() => this.handler(options.command, run, options, node.id))
    return {
      done,
      closeStdin: () => { if (!run.stdinClosed) { run.stdinClosed = true; for (const listener of stdinListeners) listener() } },
      kill: () => { for (const listener of killListeners) listener(); run.end(null, { signal: 'SIGTERM' }) }
    }
  }

  /** The job wrapper's arguments, when this command is a job. */
  static job(command: string): FakeJob | null {
    const words = shellWords(command)
    const at = words.indexOf('conductor-job')
    if (at < 0) return null
    const [id, cwd, timeout, body, nonce] = words.slice(at + 1)
    return { id: id!, cwd: cwd!, timeoutSec: Number(timeout), command: body!, nonce: nonce! }
  }
}

export interface DetachedState {
  id: string
  cwd: string
  command: string
  timeoutSec: number
  stdout: Buffer
  stderr: Buffer
  pid: number
  /** The supervisor is running. */
  alive: boolean
  exit: number | null
  reason: 'timeout' | 'cancelled' | null
  cancelled: boolean
}

export interface FakeFetchAnswer { marks: string[]; archive?: Buffer; code?: number }

/**
 * The node side of detached jobs, in memory: the launcher, the supervisor's state folder, the
 * follow sessions that stream it, cancel, clean and fetch. A test writes output and exits through
 * it and drops connections as a sleeping network would.
 */
export class FakeDetachedNode {
  readonly jobs = new Map<string, DetachedState>()
  readonly launches: string[] = []
  readonly follows: Array<{ id: string; stdoutOffset: number; stderrOffset: number; cancel: boolean }> = []
  readonly cancels: string[] = []
  readonly cleaned: string[] = []
  readonly fetches: Array<{ cwd: string; cap: number; patterns: string[] }> = []
  unreachable = false
  /** What the supervisor does when the cancel file appears; by default it stops the group at once. */
  onCancel: (state: DetachedState) => void = state => this.exit(state.id, 143, 'cancelled')
  fetch: (patterns: string[], cwd: string) => FakeFetchAnswer = () => ({ marks: ['none'] })
  private readonly sessions = new Set<{ notify(): void; drop(): void }>()
  private nextPid = 100

  /** Answers a detached command; false for anything else. */
  handle(command: string, run: FakeRun): boolean {
    const words = shellWords(command)
    const kind = words[3] ?? ''
    if (!['conductor-launch', 'conductor-follow', 'conductor-cancel', 'conductor-clean', 'conductor-fetch'].includes(kind)) return false
    if (this.unreachable) { run.stderr('ssh: connect to host: Operation timed out\n'); run.end(255, { error: 'ssh could not complete the connection' }); return true }
    const args = words.slice(4)
    if (kind === 'conductor-launch') {
      const [id, cwd, limit, body, nonce] = args as [string, string, string, string, string]
      const tag = `${MARKER_PREFIX}${nonce} `
      if (cwd === 'nowhere') { run.stderr(`${tag}error=cwd\n${tag}exit=125\n`); run.end(125); return true }
      const pid = this.nextPid++
      this.jobs.set(id, { id, cwd, command: body, timeoutSec: Number(limit), stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid, alive: true, exit: null, reason: null, cancelled: false })
      this.launches.push(id)
      run.stderr(`${tag}started pid=${pid}\n`)
      run.end(0)
      return true
    }
    if (kind === 'conductor-follow') {
      const [id, out, err, , nonce, cancel] = args as [string, string, string, string, string, string]
      this.follows.push({ id, stdoutOffset: Number(out), stderrOffset: Number(err), cancel: cancel === '1' })
      const tag = `${MARKER_PREFIX}${nonce} `
      const state = this.jobs.get(id)
      if (!state) { run.stdout(`${tag}gone\n`); run.end(0); return true }
      let o = Number(out)
      let e = Number(err)
      let first = true
      let open = true
      const close = (code: number, extra?: Partial<ExecResult>): void => { if (!open) return; open = false; this.sessions.delete(session); run.end(code, extra) }
      const session = {
        notify: (): void => {
          if (!open) return
          const lo = state.stdout.length - o
          const le = state.stderr.length - e
          if (!first && !lo && !le && state.exit === null && state.alive) return
          first = false
          run.stdout(Buffer.concat([
            Buffer.from(`${tag}frame out=${lo} err=${le} pid=${state.pid} alive=${state.alive ? 1 : 0} exit=${state.exit ?? '-'} reason=${state.reason ?? '-'}\n`),
            state.stdout.subarray(o), state.stderr.subarray(e)
          ]))
          o += lo
          e += le
          if (state.exit !== null || !state.alive) close(0)
        },
        drop: (): void => close(255, { error: 'ssh could not complete the connection' })
      }
      run.onKill(() => { open = false; this.sessions.delete(session) })
      this.sessions.add(session)
      session.notify()
      if (cancel === '1') this.requestCancel(state)
      return true
    }
    if (kind === 'conductor-cancel') {
      const state = this.jobs.get(args[0]!)
      if (state) this.requestCancel(state)
      run.end(0)
      return true
    }
    if (kind === 'conductor-clean') { this.jobs.delete(args[0]!); this.cleaned.push(args[0]!); run.end(0); return true }
    const [cwd, cap, nonce, ...patterns] = args as [string, string, string, ...string[]]
    this.fetches.push({ cwd, cap: Number(cap), patterns })
    const answer = this.fetch(patterns, cwd)
    const tag = `${MARKER_PREFIX}${nonce} `
    if (answer.marks.length) run.stderr(answer.marks.map(mark => `${tag}${mark}\n`).join(''))
    if (answer.archive) run.stdout(answer.archive)
    run.end(answer.code ?? 0)
    return true
  }

  private requestCancel(state: DetachedState): void {
    if (state.cancelled || state.exit !== null) return
    state.cancelled = true
    this.cancels.push(state.id)
    this.onCancel(state)
  }

  private changed(): void { for (const session of [...this.sessions]) session.notify() }

  output(id: string, stream: 'stdout' | 'stderr', text: string | Buffer): void {
    const state = this.jobs.get(id)!
    state[stream] = Buffer.concat([state[stream], typeof text === 'string' ? Buffer.from(text) : text])
    this.changed()
  }

  exit(id: string, code: number, reason: 'timeout' | 'cancelled' | null = null): void {
    const state = this.jobs.get(id)!
    state.exit = code
    state.reason = reason
    state.alive = false
    this.changed()
  }

  /** The supervisor is gone without an exit file: the node restarted. */
  die(id: string): void {
    this.jobs.get(id)!.alive = false
    this.changed()
  }

  /** Every follow session breaks, as when the network or this machine goes to sleep. */
  dropConnections(): void { for (const session of [...this.sessions]) session.drop() }

  get openSessions(): number { return this.sessions.size }
}

export interface TarEntry { name: string; type?: '0' | '5' | '2' | '1'; content?: string | Buffer; linkname?: string; pax?: boolean }

/** A gzip'd ustar archive, with a pax header for names over 100 bytes or when asked. */
export function tarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  const header = (name: string, type: string, size: number, linkname = ''): Buffer => {
    const block = Buffer.alloc(512)
    block.write(name.slice(0, 100), 0, 'utf8')
    block.write('0000644\0', 100)
    block.write('0000000\0', 108)
    block.write('0000000\0', 116)
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136)
    block.write('        ', 148)
    block.write(type, 156)
    block.write(linkname, 157)
    block.write('ustar\0', 257)
    block.write('00', 263)
    let sum = 0
    for (const byte of block) sum += byte
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    return block
  }
  const pad = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
  for (const entry of entries) {
    const content = typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content ?? Buffer.alloc(0)
    const type = entry.type ?? '0'
    if (entry.pax || Buffer.byteLength(entry.name) > 100) {
      const body = ` path=${entry.name}\n`
      let length = Buffer.byteLength(body) + 1
      while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body)
      const record = Buffer.from(`${length}${body}`)
      blocks.push(header('PaxHeader', 'x', record.length), pad(record))
    }
    blocks.push(header(entry.name, type, type === '0' ? content.length : 0, entry.linkname))
    if (content.length && type === '0') blocks.push(pad(content))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}
