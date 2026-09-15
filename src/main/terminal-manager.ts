import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type { RuntimeEnsureResult, TerminalSpec } from '../shared/models'
import { TERMINAL_BUFFER_BYTES, type RemoteTerminalAttachment, type RemoteTerminalSummary } from '../shared/remote-terminals'
import type { ConductorDatabase } from './database'

/** How many terminals that have already exited keep their buffer, so a late attach still reads the tail. */
const RETAINED_EXITED_TERMINALS = 16
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 34

export interface TerminalSize {
  cols: number
  rows: number
}

/** Called with the position the chunk starts at, so a subscriber's own cursor stays exact. */
export type TerminalOutputListener = (offset: number, bytes: Buffer) => void
export type TerminalExitListener = (exitCode: number | null) => void

/**
 * The output a controller may still ask for.
 *
 * A PTY is bytes, so this counts and slices bytes: an offset is a byte position within everything
 * this terminal has ever written, which is what lets a machine that reconnects say exactly where
 * it stopped instead of replaying a screen it already has. The buffer is bounded, so output old
 * enough falls out of it; what fell out is reported as a gap and never reconstructed, because a
 * plausible-looking substitute for lost terminal output is worse than a visible hole.
 */
export class TerminalOutputBuffer {
  private chunks: Buffer[] = []
  private retained = 0
  /** Byte position of the oldest byte still held; everything before it is gone for good. */
  private start: number
  private total: number

  constructor(private readonly limit: number = TERMINAL_BUFFER_BYTES, startOffset = 0) {
    this.start = startOffset
    this.total = startOffset
  }

  /** Bytes produced so far. The next chunk will start here. */
  get offset(): number { return this.total }
  /** The oldest offset that can still be served. */
  get startOffset(): number { return this.start }

  /** Appends a chunk and answers the offset it starts at. */
  append(bytes: Buffer): number {
    const offset = this.total
    if (!bytes.length) return offset
    this.chunks.push(bytes)
    this.retained += bytes.length
    this.total += bytes.length
    while (this.retained > this.limit) {
      const head = this.chunks[0]
      if (!head) break
      const excess = this.retained - this.limit
      // Drop exactly the excess, slicing the oldest chunk rather than discarding all of it, so
      // the retained window is the newest `limit` bytes however the writes happened to arrive.
      if (head.length <= excess) {
        this.chunks.shift()
        this.retained -= head.length
        this.start += head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retained -= excess
        this.start += excess
      }
    }
    return offset
  }

  /** What is still held from `fromOffset`, with the bytes between that and the answer counted as lost. */
  read(fromOffset: number): { offset: number; data: Buffer; lostBytes: number } {
    const requested = Number.isSafeInteger(fromOffset) && fromOffset > 0 ? fromOffset : 0
    // Asking from at or beyond the end is a controller that has already seen everything: there is
    // nothing to send, and nothing was lost either.
    if (requested >= this.total) return { offset: this.total, data: Buffer.alloc(0), lostBytes: 0 }
    const offset = Math.max(requested, this.start)
    const data = Buffer.concat(this.chunks).subarray(offset - this.start)
    return { offset, data, lostBytes: offset - requested }
  }
}

interface TerminalRecord {
  spec: TerminalSpec
  executable: string
  buffer: TerminalOutputBuffer
  cols: number
  rows: number
  exitCode: number | null
  /** Set once the shell's exit has been announced, so a kill followed by the PTY's own exit says it once. */
  finished?: boolean
  /** Present exactly while the shell is alive; its absence is what `ensure` treats as "spawn one". */
  process?: IPty
  /** Decodes the local text view across chunk boundaries when node-pty hands over raw bytes. */
  decoder: StringDecoder
  pendingTranscript: string
  flushTimer?: NodeJS.Timeout
}

const broadcast = (channel: string, payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

/**
 * node-pty's typings describe only its decoded-string mode, and on Windows its agent sets utf8 on
 * the conout socket itself, so a chunk arrives as a string there whatever options are passed. Both
 * shapes are accepted and everything downstream works in bytes: the offsets a remote controller
 * resumes from have to be byte positions, and a string would make them positions in a decoding.
 */
const chunkBytes = (chunk: string | Buffer): Buffer => typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk

export class TerminalManager {
  private readonly records = new Map<string, TerminalRecord>()
  /** Exit order, so the oldest finished terminal is the one whose buffer is released first. */
  private exited: string[] = []
  private readonly outputListeners = new Map<string, Set<TerminalOutputListener>>()
  private readonly exitListeners = new Map<string, Set<TerminalExitListener>>()

  constructor(private readonly database: ConductorDatabase) {}

  ensure(spec: TerminalSpec, size?: TerminalSize): RuntimeEnsureResult {
    const existing = this.records.get(spec.id)
    if (existing?.process) {
      return {
        id: spec.id,
        available: true,
        status: 'running',
        transcript: this.database.getTerminalTranscript(spec.id),
        executable: existing.executable
      }
    }
    return this.spawn(spec, size)
  }

  restart(spec: TerminalSpec, size?: TerminalSize): RuntimeEnsureResult {
    this.kill(spec.id)
    return this.spawn(spec, size)
  }

  write(id: string, data: string | Buffer): void {
    const target = this.records.get(id)?.process
    if (!target) return
    // node-pty types `write` as string because of its default decoding mode; the socket under it
    // takes bytes, which is the only way to forward a paste that is not valid UTF-8.
    target.write(typeof data === 'string' ? data : data as unknown as string)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1) return
    const record = this.records.get(id)
    if (!record) return
    record.cols = cols
    record.rows = rows
    try {
      record.process?.resize(cols, rows)
    } catch {
      // PTYs may exit between ResizeObserver delivery and this call.
    }
  }

  kill(id: string): void {
    const record = this.records.get(id)
    if (!record?.process) return
    this.flush(record)
    try {
      record.process.kill()
    } catch {
      // The process may already have exited.
    }
    // The buffer and exit state outlive the process: a controller that attaches after the shell
    // stopped must still be able to read why it stopped. The exit code itself is left to the
    // PTY's own exit event, which is the only place it is actually known.
    this.detach(record)
    this.database.setTerminalStatus(id, 'exited')
  }

  killProject(projectId: string): void {
    for (const [id, record] of this.records) {
      if (record.spec.projectId === projectId) this.kill(id)
    }
  }

  killSession(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.spec.sessionId === sessionId) this.kill(id)
    }
  }

  dispose(): void {
    for (const id of [...this.records.keys()]) this.kill(id)
    this.records.clear()
    this.exited = []
    this.outputListeners.clear()
    this.exitListeners.clear()
  }

  /** True while a shell with this id is alive on this machine. */
  running(id: string): boolean {
    return Boolean(this.records.get(id)?.process)
  }

  /** What this machine is running in one workspace, for a paired machine's terminal list. */
  list(projectId: string, sessionId: string): RemoteTerminalSummary[] {
    return [...this.records.values()]
      .filter(record => record.spec.projectId === projectId && record.spec.sessionId === sessionId)
      .map(record => this.describe(record))
  }

  summary(id: string): RemoteTerminalSummary | null {
    const record = this.records.get(id)
    return record ? this.describe(record) : null
  }

  spec(id: string): TerminalSpec | null {
    const record = this.records.get(id)
    return record ? { ...record.spec } : null
  }

  /**
   * The buffered output from `fromOffset`, or from the oldest byte still retained with the
   * difference counted as lost. Null means this machine has no terminal by that id at all, which
   * the caller reports as a missing terminal rather than as an empty one.
   */
  attach(id: string, fromOffset: number): RemoteTerminalAttachment | null {
    const record = this.records.get(id)
    if (!record) return null
    const { offset, data, lostBytes } = record.buffer.read(fromOffset)
    return {
      terminalId: id,
      offset,
      data: data.toString('base64'),
      lostBytes,
      running: Boolean(record.process),
      exitCode: record.exitCode,
      cols: record.cols,
      rows: record.rows
    }
  }

  /** Live output for one terminal. The listener is called with the offset each chunk starts at. */
  onOutput(id: string, listener: TerminalOutputListener): () => void {
    return this.subscribe(this.outputListeners, id, listener)
  }

  onExit(id: string, listener: TerminalExitListener): () => void {
    return this.subscribe(this.exitListeners, id, listener)
  }

  private subscribe<T>(registry: Map<string, Set<T>>, id: string, listener: T): () => void {
    const listeners = registry.get(id) ?? new Set<T>()
    listeners.add(listener)
    registry.set(id, listeners)
    return () => {
      const current = registry.get(id)
      if (!current) return
      current.delete(listener)
      if (!current.size) registry.delete(id)
    }
  }

  private describe(record: TerminalRecord): RemoteTerminalSummary {
    return {
      terminalId: record.spec.id,
      // The manager knows nothing about panes; whoever serves a remote list fills in the tab.
      tabId: null,
      title: record.spec.title,
      cwd: record.spec.cwd,
      running: Boolean(record.process),
      exitCode: record.exitCode,
      offset: record.buffer.offset
    }
  }

  private spawn(spec: TerminalSpec, size?: TerminalSize): RuntimeEnsureResult {
    const transcript = this.database.upsertTerminal(spec, 'starting')
    const executable = spec.shell || this.defaultShell()
    const args = this.shellArgs(executable)
    const cols = size && size.cols >= 2 ? Math.floor(size.cols) : DEFAULT_COLS
    const rows = size && size.rows >= 1 ? Math.floor(size.rows) : DEFAULT_ROWS
    // Offsets are monotonic per terminal id, across a restart too: a controller holding an offset
    // from the previous shell would otherwise be handed unrelated output at the same positions.
    const previous = this.records.get(spec.id)?.buffer.offset ?? 0
    const record: TerminalRecord = {
      spec, executable, cols, rows, exitCode: null,
      buffer: new TerminalOutputBuffer(TERMINAL_BUFFER_BYTES, previous),
      decoder: new StringDecoder('utf8'),
      pendingTranscript: ''
    }

    try {
      const process = pty.spawn(executable, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spec.cwd,
        useConptyDll: globalThis.process.platform === 'win32',
        env: { ...globalThis.process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
          string,
          string
        >
      })
      record.process = process
      this.records.set(spec.id, record)
      this.exited = this.exited.filter(id => id !== spec.id)
      this.database.setTerminalStatus(spec.id, 'running')

      process.onData((data: string | Buffer) => this.output(record, data))
      process.onExit(({ exitCode }) => {
        this.flush(record)
        this.detach(record)
        this.finish(record, exitCode)
        this.database.setTerminalStatus(spec.id, 'exited')
        broadcast('terminal:status', { id: spec.id, status: 'exited', exitCode })
      })

      if (spec.startupCommand) process.write(`${spec.startupCommand}\r`)
      broadcast('terminal:status', { id: spec.id, status: 'running' })
      return { id: spec.id, available: true, status: 'running', transcript, executable }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.database.setTerminalStatus(spec.id, 'error')
      return { id: spec.id, available: false, status: 'error', transcript, message, executable }
    }
  }

  private output(record: TerminalRecord, chunk: string | Buffer): void {
    const bytes = chunkBytes(chunk)
    // The local view is text. When node-pty already decoded, that string is used unchanged so this
    // machine's own behaviour is exactly what it was; when it handed over bytes, the decoder holds
    // a multi-byte character split across two chunks instead of emitting a replacement character.
    const text = typeof chunk === 'string' ? chunk : record.decoder.write(chunk)
    const offset = record.buffer.append(bytes)
    if (text) {
      broadcast('terminal:data', { id: record.spec.id, data: text })
      this.bufferTranscript(record, text)
    }
    const listeners = this.outputListeners.get(record.spec.id)
    if (!listeners?.size || !bytes.length) return
    for (const listener of [...listeners]) {
      try { listener(offset, bytes) }
      // One failing subscriber must not cost the others their output, nor the terminal its life.
      catch (error) { console.warn('Terminal output subscriber failed', error) }
    }
  }

  /** Keeps the record, its buffer and its exit code after the shell is gone, within a bound. */
  private detach(record: TerminalRecord): void {
    const id = record.spec.id
    if (!record.process) return
    record.process = undefined
    this.exited = [...this.exited.filter(entry => entry !== id), id]
    while (this.exited.length > RETAINED_EXITED_TERMINALS) {
      const oldest = this.exited.shift()
      if (oldest && !this.records.get(oldest)?.process) {
        this.records.delete(oldest)
        this.outputListeners.delete(oldest)
        this.exitListeners.delete(oldest)
      }
    }
  }

  /** Tells subscribers the shell stopped, exactly once however it stopped. */
  private finish(record: TerminalRecord, exitCode: number | null): void {
    if (record.finished) return
    record.finished = true
    record.exitCode = exitCode
    const listeners = this.exitListeners.get(record.spec.id)
    for (const listener of listeners ? [...listeners] : []) {
      try { listener(exitCode) }
      catch (error) { console.warn('Terminal exit subscriber failed', error) }
    }
  }

  private defaultShell(): string {
    if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash'
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return existsSync(powershell) ? powershell : 'powershell.exe'
  }

  private shellArgs(executable: string): string[] {
    const name = executable.toLowerCase()
    if (name.includes('powershell') || name.endsWith('pwsh.exe') || name.endsWith('pwsh')) {
      return ['-NoLogo']
    }
    return []
  }

  private bufferTranscript(terminal: TerminalRecord, data: string): void {
    terminal.pendingTranscript += data
    if (terminal.flushTimer) return
    terminal.flushTimer = setTimeout(() => this.flush(terminal), 350)
  }

  private flush(terminal: TerminalRecord): void {
    if (terminal.flushTimer) clearTimeout(terminal.flushTimer)
    terminal.flushTimer = undefined
    if (!terminal.pendingTranscript) return
    this.database.appendTerminalTranscript(terminal.spec.id, terminal.pendingTranscript)
    terminal.pendingTranscript = ''
  }
}
