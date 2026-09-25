import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnsureResult, TerminalSpec } from '../shared/models'
import { PHONE_TERMINAL_IDLE_MS, PHONE_TERMINALS_PER_DEVICE, PhoneTerminals, type PhoneTerminalEvent, type PhoneTerminalRuntime } from './phone-terminal'
import { TerminalOutputBuffer, type TerminalExitListener, type TerminalOutputListener } from './terminal-manager'

/** A TerminalManager stand-in: real output buffer, no process. */
class FakeRuntime implements PhoneTerminalRuntime {
  readonly specs = new Map<string, TerminalSpec>()
  readonly buffers = new Map<string, TerminalOutputBuffer>()
  readonly alive = new Set<string>()
  readonly written: Array<{ id: string; text: string }> = []
  readonly killed: string[] = []
  readonly sizes = new Map<string, { cols: number; rows: number }>()
  private outputs = new Map<string, Set<TerminalOutputListener>>()
  private exits = new Map<string, Set<TerminalExitListener>>()
  ensure(spec: TerminalSpec, size?: { cols: number; rows: number }): RuntimeEnsureResult {
    this.specs.set(spec.id, spec); this.buffers.set(spec.id, new TerminalOutputBuffer()); this.alive.add(spec.id)
    if (size) this.sizes.set(spec.id, size)
    return { id: spec.id, available: true, status: 'running', transcript: '' }
  }
  write(id: string, data: string | Buffer): void { this.written.push({ id, text: Buffer.from(data as Buffer).toString('utf8') }) }
  resize(id: string, cols: number, rows: number): void { this.sizes.set(id, { cols, rows }) }
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
  onExit(id: string, listener: TerminalExitListener): () => void { const set = this.exits.get(id) ?? new Set(); set.add(listener); this.exits.set(id, set); return () => set.delete(listener) }
  print(id: string, text: string): void { const bytes = Buffer.from(text); const offset = this.buffers.get(id)!.append(bytes); for (const listener of this.outputs.get(id) ?? []) listener(offset, bytes) }
  exit(id: string, code: number): void { this.alive.delete(id); for (const listener of this.exits.get(id) ?? []) listener(code) }
}

function fixture() {
  const runtime = new FakeRuntime()
  const audit = vi.fn()
  let now = Date.parse('2026-09-25T10:00:00Z')
  const terminals = new PhoneTerminals({
    terminals: runtime, audit, machineName: () => 'MAIN', now: () => now,
    workspace: (projectId, workspaceId) => projectId === 'project-a' && workspaceId === 'ws-1' ? { cwd: 'C:\\work\\conductor', projectName: 'Conductor', workspaceName: 'main' } : null
  })
  return { runtime, terminals, audit, advance: (ms: number) => { now += ms } }
}

const owner = { deviceId: 'phone-1', deviceName: 'iPhone', unlockSessionId: 'unlock-1' }
const open = { projectId: 'project-a', workspaceId: 'ws-1', cols: 40, rows: 20 }
const b64 = (text: string): string => Buffer.from(text).toString('base64')

describe('phone terminals', () => {
  it('opens a shell in a local workspace at the phone size, and refuses paired machines and unknown workspaces', () => {
    const { runtime, terminals } = fixture()
    const opened = terminals.open(owner, open)
    expect(runtime.specs.get(opened.terminalId)).toMatchObject({ projectId: 'project-a', sessionId: 'ws-1', cwd: 'C:\\work\\conductor', title: 'Phone · iPhone' })
    expect(runtime.sizes.get(opened.terminalId)).toEqual({ cols: 40, rows: 20 })
    expect(() => terminals.open(owner, { ...open, machineId: 'peer-mac' })).toThrow(/MAIN only/)
    expect(() => terminals.open(owner, { ...open, workspaceId: 'nope' })).toThrow(/Pick a project/)
  })

  it('streams scrollback then live output, writes input, resizes, and keeps other phones and older unlocks out', () => {
    const { runtime, terminals } = fixture()
    const { terminalId } = terminals.open(owner, open)
    runtime.print(terminalId, 'PS C:\\work> ')
    const events: PhoneTerminalEvent[] = []
    const detach = terminals.attach(owner, terminalId, undefined, event => events.push(event))
    terminals.write(owner, terminalId, b64('echo ok\r'))
    expect(runtime.written).toEqual([{ id: terminalId, text: 'echo ok\r' }])
    runtime.print(terminalId, 'ok\r\n')
    expect(events.map(event => event.type === 'data' ? Buffer.from(event.data, 'base64').toString() : event.type)).toEqual(['PS C:\\work> ', 'ok\r\n'])
    expect(terminals.resize(owner, terminalId, 60, 30)).toEqual({ cols: 60, rows: 30 })
    for (const stranger of [{ ...owner, deviceId: 'phone-2' }, { ...owner, unlockSessionId: 'unlock-0' }]) {
      expect(() => terminals.write(stranger, terminalId, b64('x'))).toThrow(/not open/)
      expect(() => terminals.attach(stranger, terminalId, 0, () => undefined)).toThrow(/not open/)
      expect(() => terminals.close(stranger, terminalId)).toThrow(/not open/)
    }
    expect(terminals.list({ ...owner, unlockSessionId: 'unlock-0' })).toEqual([])
    detach()
    runtime.print(terminalId, 'later')
    expect(events).toHaveLength(2)
  })

  it('refuses an oversized write', () => {
    const { terminals } = fixture()
    const { terminalId } = terminals.open(owner, open)
    expect(() => terminals.write(owner, terminalId, 'A'.repeat(200_000))).toThrow(/at most/)
  })

  it('caps terminals per phone', () => {
    const { terminals } = fixture()
    for (let index = 0; index < PHONE_TERMINALS_PER_DEVICE; index += 1) terminals.open(owner, open)
    expect(() => terminals.open(owner, open)).toThrow(/close one first/)
  })

  it('kills the shell and writes one audit line when the phone locks, with device, times and reason but no input', () => {
    const { runtime, terminals, audit, advance } = fixture()
    const { terminalId } = terminals.open(owner, open)
    const events: PhoneTerminalEvent[] = []
    terminals.attach(owner, terminalId, 0, event => events.push(event))
    terminals.write(owner, terminalId, b64('secret-command\r'))
    advance(42_000)
    terminals.locked('phone-1', 'unlock-1')
    expect(runtime.killed).toEqual([terminalId])
    expect(events.at(-1)).toEqual({ type: 'closed', reason: 'phone locked' })
    expect(audit).toHaveBeenCalledTimes(1)
    const line = audit.mock.calls[0]![0] as string
    expect(line).toMatch(/^phone terminal: device "iPhone" \(phone-1\) on MAIN in Conductor \/ main; started 2026-09-25T10:00:00.000Z, ended 2026-09-25T10:00:42.000Z \(42 s\); phone locked; 15 bytes typed$/)
    expect(line).not.toContain('secret')
    // Ending twice never writes a second line.
    terminals.locked('phone-1', 'unlock-1')
    terminals.dispose()
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('times out after idle input, and a shell that exits on its own is closed without a kill', () => {
    const { runtime, terminals, audit, advance } = fixture()
    const idle = terminals.open(owner, open)
    const exiting = terminals.open(owner, open)
    advance(PHONE_TERMINAL_IDLE_MS - 1000)
    terminals.write(owner, exiting.terminalId, b64('exit\r'))
    runtime.exit(exiting.terminalId, 0)
    expect(runtime.killed).toEqual([])
    advance(2000)
    terminals.sweep()
    expect(runtime.killed).toEqual([idle.terminalId])
    expect(audit.mock.calls.map(call => String(call[0]).match(/; ([^;]+); \d+ bytes typed$/)?.[1])).toEqual(['shell exited with 0', 'idle timeout'])
    expect(terminals.count()).toBe(0)
  })

  it('closes every terminal of a phone that is unpaired, and all of them when the app quits', () => {
    const { terminals, audit } = fixture()
    terminals.open(owner, open)
    terminals.open({ ...owner, deviceId: 'phone-2', deviceName: 'Pixel' }, open)
    terminals.deviceRemoved('phone-1')
    expect(terminals.count()).toBe(1)
    terminals.dispose()
    expect(audit.mock.calls.map(call => String(call[0]).includes('Conductor quit'))).toEqual([false, true])
  })
})
