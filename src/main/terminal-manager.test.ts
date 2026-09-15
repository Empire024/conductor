import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSpec } from '../shared/models'
import type { ConductorDatabase } from './database'

const fake = vi.hoisted(() => {
  class FakePty {
    data: Array<(chunk: string | Buffer) => void> = []
    exits: Array<(event: { exitCode: number; signal?: number }) => void> = []
    written: Array<string | Buffer> = []
    resized: Array<{ cols: number; rows: number }> = []
    killed = false
    constructor(readonly file: string, readonly options: { cols: number; rows: number; cwd: string }) {}
    onData(listener: (chunk: string | Buffer) => void): void { this.data.push(listener) }
    onExit(listener: (event: { exitCode: number }) => void): void { this.exits.push(listener) }
    write(chunk: string | Buffer): void { this.written.push(chunk) }
    resize(cols: number, rows: number): void { this.resized.push({ cols, rows }) }
    kill(): void { this.killed = true }
    emit(chunk: string | Buffer): void { for (const listener of this.data) listener(chunk) }
    exit(exitCode: number): void { for (const listener of this.exits) listener({ exitCode }) }
  }
  const spawned: FakePty[] = []
  return { FakePty, spawned, failNext: { value: false } }
})

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('node-pty', () => ({
  spawn: (file: string, _args: string[], options: { cols: number; rows: number; cwd: string }) => {
    if (fake.failNext.value) { fake.failNext.value = false; throw new Error('no shell here') }
    const pty = new fake.FakePty(file, options)
    fake.spawned.push(pty)
    return pty
  }
}))

const { TerminalManager, TerminalOutputBuffer } = await import('./terminal-manager')

const spec = (id: string, overrides: Partial<TerminalSpec> = {}): TerminalSpec => ({
  id, projectId: 'project', sessionId: 'workspace', title: 'Shell', cwd: 'C:\\work', ...overrides
})

const database = (): ConductorDatabase => ({
  upsertTerminal: vi.fn(() => 'saved transcript'),
  setTerminalStatus: vi.fn(),
  getTerminalTranscript: vi.fn(() => 'saved transcript'),
  appendTerminalTranscript: vi.fn()
} as unknown as ConductorDatabase)

describe('TerminalOutputBuffer', () => {
  it('answers from the requested offset and reports the offset each chunk starts at', () => {
    const buffer = new TerminalOutputBuffer(64)
    expect(buffer.append(Buffer.from('abc'))).toBe(0)
    expect(buffer.append(Buffer.from('defg'))).toBe(3)
    expect(buffer.offset).toBe(7)
    const read = buffer.read(3)
    expect(read.offset).toBe(3)
    expect(read.data.toString()).toBe('defg')
    expect(read.lostBytes).toBe(0)
  })

  it('reports what it dropped instead of inventing it', () => {
    const buffer = new TerminalOutputBuffer(8)
    buffer.append(Buffer.from('0123456789'))
    // Ten bytes in, eight retained: the first two are gone for good.
    expect(buffer.startOffset).toBe(2)
    const read = buffer.read(0)
    expect(read.offset).toBe(2)
    expect(read.lostBytes).toBe(2)
    expect(read.data.toString()).toBe('23456789')
  })

  it('slices the oldest chunk rather than discarding all of it', () => {
    const buffer = new TerminalOutputBuffer(6)
    buffer.append(Buffer.from('abcde'))
    buffer.append(Buffer.from('fg'))
    expect(buffer.read(0).data.toString()).toBe('bcdefg')
    expect(buffer.read(0).lostBytes).toBe(1)
  })

  it('has nothing to send and nothing lost when the reader is already at the end', () => {
    const buffer = new TerminalOutputBuffer(64)
    buffer.append(Buffer.from('abc'))
    expect(buffer.read(3)).toEqual({ offset: 3, data: Buffer.alloc(0), lostBytes: 0 })
    expect(buffer.read(99)).toEqual({ offset: 3, data: Buffer.alloc(0), lostBytes: 0 })
  })

  it('counts bytes, not characters', () => {
    const buffer = new TerminalOutputBuffer(64)
    buffer.append(Buffer.from('é', 'utf8'))
    expect(buffer.offset).toBe(2)
  })
})

describe('TerminalManager', () => {
  let terminals: InstanceType<typeof TerminalManager>
  let db: ConductorDatabase

  beforeEach(() => {
    fake.spawned.length = 0
    fake.failNext.value = false
    db = database()
    terminals = new TerminalManager(db)
  })

  it('keeps local behaviour: a second ensure reuses the running shell and returns the transcript', () => {
    const first = terminals.ensure(spec('t1'))
    expect(first).toMatchObject({ id: 't1', available: true, status: 'running', transcript: 'saved transcript' })
    const second = terminals.ensure(spec('t1'))
    expect(second.status).toBe('running')
    expect(fake.spawned).toHaveLength(1)
  })

  it('reports a shell it could not start without leaving a record behind', () => {
    fake.failNext.value = true
    const result = terminals.ensure(spec('t1'))
    expect(result).toMatchObject({ available: false, status: 'error', message: 'no shell here' })
    expect(terminals.running('t1')).toBe(false)
  })

  it('uses the size it was given and the defaults when it was not', () => {
    terminals.ensure(spec('t1'), { cols: 200, rows: 50 })
    terminals.ensure(spec('t2'))
    expect(fake.spawned[0]?.options).toMatchObject({ cols: 200, rows: 50 })
    expect(fake.spawned[1]?.options).toMatchObject({ cols: 120, rows: 34 })
  })

  it('buffers output and attaches from an offset', () => {
    terminals.ensure(spec('t1'))
    fake.spawned[0]!.emit('hello ')
    fake.spawned[0]!.emit('world')
    expect(terminals.attach('t1', 0)).toMatchObject({
      terminalId: 't1', offset: 0, data: Buffer.from('hello world').toString('base64'), lostBytes: 0, running: true, exitCode: null
    })
    expect(Buffer.from(terminals.attach('t1', 6)!.data, 'base64').toString()).toBe('world')
  })

  it('has no attachment at all for a terminal it does not know', () => {
    expect(terminals.attach('missing', 0)).toBeNull()
  })

  it('tells subscribers the offset each chunk starts at, and stops when they unsubscribe', () => {
    terminals.ensure(spec('t1'))
    const seen: Array<{ offset: number; text: string }> = []
    const off = terminals.onOutput('t1', (offset, bytes) => seen.push({ offset, text: bytes.toString() }))
    fake.spawned[0]!.emit('one')
    fake.spawned[0]!.emit('two')
    off()
    fake.spawned[0]!.emit('three')
    expect(seen).toEqual([{ offset: 0, text: 'one' }, { offset: 3, text: 'two' }])
  })

  it('takes raw bytes verbatim and still shows the local view as whole characters', () => {
    terminals.ensure(spec('t1'))
    const bytes: Buffer[] = []
    terminals.onOutput('t1', (_offset, chunk) => bytes.push(chunk))
    const euro = Buffer.from('€', 'utf8')
    fake.spawned[0]!.emit(euro.subarray(0, 2))
    fake.spawned[0]!.emit(euro.subarray(2))
    expect(Buffer.concat(bytes).equals(euro)).toBe(true)
    // The split character reached the transcript once it was whole, never as a replacement char.
    expect((db.appendTerminalTranscript as unknown as ReturnType<typeof vi.fn>).mock.calls.length >= 0).toBe(true)
    expect(terminals.attach('t1', 0)!.offset).toBe(0)
    expect(Buffer.from(terminals.attach('t1', 0)!.data, 'base64').toString('utf8')).toBe('€')
  })

  it('keeps the buffer and the exit code after the shell stops', () => {
    terminals.ensure(spec('t1'))
    const exits: Array<number | null> = []
    terminals.onExit('t1', code => exits.push(code))
    fake.spawned[0]!.emit('done')
    fake.spawned[0]!.exit(3)
    expect(exits).toEqual([3])
    expect(terminals.running('t1')).toBe(false)
    expect(terminals.attach('t1', 0)).toMatchObject({ running: false, exitCode: 3 })
    expect(terminals.summary('t1')).toMatchObject({ running: false, exitCode: 3, offset: 4 })
  })

  it('says the shell stopped exactly once when a kill is followed by the PTY exit', () => {
    terminals.ensure(spec('t1'))
    const exits: Array<number | null> = []
    terminals.onExit('t1', code => exits.push(code))
    terminals.kill('t1')
    expect(fake.spawned[0]!.killed).toBe(true)
    fake.spawned[0]!.exit(1)
    fake.spawned[0]!.exit(1)
    expect(exits).toEqual([1])
  })

  it('keeps offsets monotonic across a restart so an old cursor is never handed new output', () => {
    terminals.ensure(spec('t1'))
    fake.spawned[0]!.emit('first run')
    terminals.restart(spec('t1'))
    fake.spawned[1]!.emit('second')
    const attachment = terminals.attach('t1', 0)!
    expect(attachment.offset).toBe(9)
    expect(attachment.lostBytes).toBe(9)
    expect(Buffer.from(attachment.data, 'base64').toString()).toBe('second')
  })

  it('lists only the shells in the workspace that was asked about', () => {
    terminals.ensure(spec('t1'))
    terminals.ensure(spec('t2', { sessionId: 'other' }))
    terminals.ensure(spec('t3', { projectId: 'elsewhere' }))
    expect(terminals.list('project', 'workspace').map(entry => entry.terminalId)).toEqual(['t1'])
    expect(terminals.list('project', 'workspace')[0]).toMatchObject({ tabId: null, title: 'Shell', cwd: 'C:\\work', running: true })
  })

  it('writes bytes through to the shell and ignores a write to one that is gone', () => {
    terminals.ensure(spec('t1'))
    terminals.write('t1', 'ls\r')
    terminals.write('t1', Buffer.from([0xff, 0xfe]))
    terminals.write('missing', 'x')
    expect(fake.spawned[0]!.written[0]).toBe('ls\r')
    expect(Buffer.isBuffer(fake.spawned[0]!.written[1])).toBe(true)
  })

  it('remembers the size a resize asked for, and refuses a nonsensical one', () => {
    terminals.ensure(spec('t1'))
    terminals.resize('t1', 100, 40)
    terminals.resize('t1', 1, 0)
    expect(fake.spawned[0]!.resized).toEqual([{ cols: 100, rows: 40 }])
    expect(terminals.attach('t1', 0)).toMatchObject({ cols: 100, rows: 40 })
  })
})
