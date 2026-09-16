import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnsureResult, TerminalSpec } from '../shared/models'
import type { RemotePeerRecord } from '../shared/remote-control'
import type { StreamHostFrame } from '../shared/remote-stream'
import { TERMINAL_MAX_WRITE_BYTES, type RemoteTerminalAttachment, type RemoteTerminalSummary } from '../shared/remote-terminals'
import { RemoteAccessError } from './remote-peers'
import {
  RemoteTerminalBindings,
  RemoteTerminalHost,
  type RemoteTerminalStream,
  type RemoteTerminalSubscription,
  type TerminalRuntime
} from './remote-terminals'
import { TerminalOutputBuffer, type TerminalExitListener, type TerminalOutputListener } from './terminal-manager'

const peer = { id: 'peer-1', machineName: 'LAPTOP' } as RemotePeerRecord
const other = { id: 'peer-2', machineName: 'TABLET' } as RemotePeerRecord

/** A runtime with real buffer semantics, so offsets and gaps in these tests are the real ones. */
class FakeRuntime implements TerminalRuntime {
  readonly specs = new Map<string, TerminalSpec>()
  readonly buffers = new Map<string, TerminalOutputBuffer>()
  readonly alive = new Set<string>()
  readonly exitCodes = new Map<string, number | null>()
  readonly writes: Array<{ id: string; bytes: Buffer }> = []
  readonly resizes: Array<{ id: string; cols: number; rows: number }> = []
  readonly killed: string[] = []
  readonly sizes = new Map<string, { cols: number; rows: number }>()
  private readonly outputs = new Map<string, Set<TerminalOutputListener>>()
  private readonly exits = new Map<string, Set<TerminalExitListener>>()
  limit = 1024
  available = true

  ensure(spec: TerminalSpec, size?: { cols: number; rows: number }): RuntimeEnsureResult {
    if (!this.available) return { id: spec.id, available: false, status: 'error', transcript: '', message: 'no shell here' }
    this.specs.set(spec.id, spec)
    this.buffers.set(spec.id, new TerminalOutputBuffer(this.limit))
    this.alive.add(spec.id)
    this.exitCodes.set(spec.id, null)
    if (size) this.sizes.set(spec.id, size)
    return { id: spec.id, available: true, status: 'running', transcript: '' }
  }

  list(projectId: string, sessionId: string): RemoteTerminalSummary[] {
    return [...this.specs.values()]
      .filter(spec => spec.projectId === projectId && spec.sessionId === sessionId)
      .map(spec => this.summary(spec.id)!)
  }

  summary(id: string): RemoteTerminalSummary | null {
    const spec = this.specs.get(id)
    if (!spec) return null
    return {
      terminalId: id, tabId: null, title: spec.title, cwd: spec.cwd,
      running: this.alive.has(id), exitCode: this.exitCodes.get(id) ?? null,
      offset: this.buffers.get(id)!.offset
    }
  }

  spec(id: string): TerminalSpec | null { return this.specs.get(id) ?? null }

  attach(id: string, fromOffset: number): RemoteTerminalAttachment | null {
    const buffer = this.buffers.get(id)
    if (!buffer) return null
    const read = buffer.read(fromOffset)
    const size = this.sizes.get(id) ?? { cols: 80, rows: 24 }
    return {
      terminalId: id, offset: read.offset, data: read.data.toString('base64'), lostBytes: read.lostBytes,
      running: this.alive.has(id), exitCode: this.exitCodes.get(id) ?? null, cols: size.cols, rows: size.rows
    }
  }

  write(id: string, data: string | Buffer): void {
    this.writes.push({ id, bytes: typeof data === 'string' ? Buffer.from(data) : data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.sizes.set(id, { cols, rows })
    this.resizes.push({ id, cols, rows })
  }

  kill(id: string): void {
    if (!this.alive.delete(id)) return
    this.killed.push(id)
    this.exitCodes.set(id, null)
    for (const listener of this.exits.get(id) ?? []) listener(null)
  }

  running(id: string): boolean { return this.alive.has(id) }

  onOutput(id: string, listener: TerminalOutputListener): () => void {
    const set = this.outputs.get(id) ?? new Set()
    set.add(listener)
    this.outputs.set(id, set)
    return () => { set.delete(listener) }
  }

  onExit(id: string, listener: TerminalExitListener): () => void {
    const set = this.exits.get(id) ?? new Set()
    set.add(listener)
    this.exits.set(id, set)
    return () => { set.delete(listener) }
  }

  /** Test driver: output the shell produced. */
  emit(id: string, text: string): void {
    const bytes = Buffer.from(text, 'utf8')
    const offset = this.buffers.get(id)!.append(bytes)
    for (const listener of this.outputs.get(id) ?? []) listener(offset, bytes)
  }

  exit(id: string, exitCode: number): void {
    this.alive.delete(id)
    this.exitCodes.set(id, exitCode)
    for (const listener of this.exits.get(id) ?? []) listener(exitCode)
  }
}

type Frame =
  | { type: 'data'; terminalId: string; offset: number; data: string }
  | { type: 'gap'; terminalId: string; lostBytes: number; offset: number }
  | { type: 'exit'; terminalId: string; exitCode: number | null }

const fakeStream = (): {
  api: RemoteTerminalStream
  frames: Frame[]
  subscribe(peerId: string, terminalId: string, fromOffset: number, where?: { projectId: string; sessionId: string }): void
  unsubscribe(peerId: string, terminalId: string): void
  detached: number
} => {
  const frames: Frame[] = []
  const state = { detached: 0 }
  let onSubscribe: ((subscription: RemoteTerminalSubscription) => void) | null = null
  let onUnsubscribe: ((subscription: { peerId: string; terminalId: string }) => void) | null = null
  return {
    frames,
    get detached(): number { return state.detached },
    subscribe: (peerId, terminalId, fromOffset, where) => onSubscribe?.({
      peerId, terminalId, fromOffset,
      projectId: where?.projectId ?? 'shared', sessionId: where?.sessionId ?? 'workspace'
    }),
    unsubscribe: (peerId, terminalId) => onUnsubscribe?.({ peerId, terminalId }),
    api: {
      terminalData: (terminalId, offset, data) => { frames.push({ type: 'data', terminalId, offset, data }) },
      terminalGap: (terminalId, lostBytes, offset) => { frames.push({ type: 'gap', terminalId, lostBytes, offset }) },
      terminalExit: (terminalId, exitCode) => { frames.push({ type: 'exit', terminalId, exitCode }) },
      onTerminalSubscribe: listener => { onSubscribe = listener; return () => { state.detached++; onSubscribe = null } },
      onTerminalUnsubscribe: listener => { onUnsubscribe = listener; return () => { state.detached++; onUnsubscribe = null } }
    }
  }
}

describe('RemoteTerminalHost', () => {
  let runtime: FakeRuntime
  let stream: ReturnType<typeof fakeStream>
  let host: RemoteTerminalHost
  let granted: boolean
  let authorized: boolean
  let openedTabs: Array<{ projectId: string; sessionId: string; terminalId: string; title: string; peerId: string }>
  let closedTabs: string[]
  let tabs: Map<string, string>

  beforeEach(() => {
    runtime = new FakeRuntime()
    stream = fakeStream()
    granted = true
    authorized = true
    openedTabs = []
    closedTabs = []
    tabs = new Map()
    host = new RemoteTerminalHost({
      terminals: runtime,
      workspace: (_peer, args) => {
        if (!granted) throw new RemoteAccessError('That project was not shared with this machine.', 403)
        if (args.projectId !== 'shared') throw new RemoteAccessError('That project was not shared with this machine.', 403)
        if (args.sessionId !== 'workspace') throw new RemoteAccessError('That workspace is not in the shared project.', 403)
        return { projectId: 'shared', sessionId: 'workspace' }
      },
      authorize: () => { if (!authorized) throw new RemoteAccessError('Remote access changed while this request was pending.', 403) },
      openTab: async (opener, request) => {
        openedTabs.push({ ...request, peerId: opener.id })
        tabs.set(request.terminalId, `tab-${request.terminalId}`)
        return { id: `tab-${request.terminalId}` }
      },
      closeTab: async (_opener, request) => { closedTabs.push(request.tabId) },
      tabId: (_projectId, _sessionId, terminalId) => tabs.get(terminalId) ?? null,
      projectPath: projectId => projectId === 'shared' ? 'C:\\work' : null,
      stream: stream.api
    })
  })

  const open = async (args: Record<string, unknown> = {}): Promise<RemoteTerminalSummary> =>
    await host.call(peer, 'terminals.open', { projectId: 'shared', sessionId: 'workspace', opId: 'op-1', cols: 100, rows: 40, ...args }) as RemoteTerminalSummary

  it.each([
    ['terminals.list', {}],
    ['terminals.open', { opId: 'op-1', cols: 80, rows: 24 }],
    ['terminals.attach', { terminalId: 'anything', fromOffset: 0 }],
    ['terminals.write', { terminalId: 'anything', data: '' }],
    ['terminals.resize', { terminalId: 'anything', cols: 80, rows: 24 }],
    ['terminals.close', { terminalId: 'anything' }]
  ])('refuses %s when the project grant does not cover it', async (method, args) => {
    granted = false
    await expect(host.call(peer, method, { projectId: 'shared', sessionId: 'workspace', ...args })).rejects.toThrow(/not shared/)
    expect(runtime.specs.size).toBe(0)
  })

  it('refuses a terminal id that belongs to another workspace on this machine', async () => {
    const opened = await open()
    runtime.specs.get(opened.terminalId)!.sessionId = 'somewhere-else'
    await expect(host.call(peer, 'terminals.write', {
      projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId, data: Buffer.from('x').toString('base64')
    })).rejects.toThrow(/different workspace/)
  })

  it('opens one shell and a visible tab stamped with the machine that asked for it', async () => {
    const opened = await open({ title: 'Build' })
    expect(runtime.specs.size).toBe(1)
    expect(runtime.sizes.get(opened.terminalId)).toEqual({ cols: 100, rows: 40 })
    expect(runtime.specs.get(opened.terminalId)).toMatchObject({ projectId: 'shared', sessionId: 'workspace', title: 'Build', cwd: 'C:\\work' })
    expect(openedTabs).toEqual([{ projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId, title: 'Build', peerId: 'peer-1' }])
    expect(opened.tabId).toBe(`tab-${opened.terminalId}`)
  })

  it('finds the shell a retried open already started instead of leaving a second one running', async () => {
    const first = await open()
    const retry = await open()
    expect(retry.terminalId).toBe(first.terminalId)
    expect(runtime.specs.size).toBe(1)
    expect(openedTabs).toHaveLength(1)
  })

  it('shares one in-flight open between concurrent retries', async () => {
    const [first, second] = await Promise.all([open(), open()])
    expect(second!.terminalId).toBe(first!.terminalId)
    expect(runtime.specs.size).toBe(1)
  })

  it('opens a new shell when the same opId comes from a different machine', async () => {
    const mine = await open()
    const theirs = await host.call(other, 'terminals.open', { projectId: 'shared', sessionId: 'workspace', opId: 'op-1', cols: 80, rows: 24 }) as RemoteTerminalSummary
    expect(theirs.terminalId).not.toBe(mine.terminalId)
    expect(runtime.specs.size).toBe(2)
  })

  it('refuses reusing an operation id for a different workspace', async () => {
    await open()
    await expect(host.call(peer, 'terminals.open', { projectId: 'shared', sessionId: 'elsewhere', opId: 'op-1', cols: 80, rows: 24 }))
      .rejects.toThrow(/workspace/)
  })

  it('serves the shell even when this machine has no window to show it in', async () => {
    const failing = new RemoteTerminalHost({
      terminals: runtime,
      workspace: () => ({ projectId: 'shared', sessionId: 'workspace' }),
      authorize: () => undefined,
      openTab: async () => { throw new Error('no window open') },
      closeTab: async () => undefined,
      tabId: () => null,
      projectPath: () => 'C:\\work'
    })
    const opened = await failing.call(peer, 'terminals.open', { projectId: 'shared', sessionId: 'workspace', opId: 'op-9', cols: 80, rows: 24 }) as RemoteTerminalSummary
    expect(opened.tabId).toBeNull()
    expect(runtime.running(opened.terminalId)).toBe(true)
  })

  it('refuses to open when the shell could not start', async () => {
    runtime.available = false
    await expect(open()).rejects.toThrow(/no shell here/)
  })

  it('attaches from an offset and reports what the buffer no longer holds', async () => {
    runtime.limit = 8
    const opened = await open()
    runtime.emit(opened.terminalId, '0123456789')
    const attachment = await host.call(peer, 'terminals.attach', {
      projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId, fromOffset: 0
    }) as RemoteTerminalAttachment
    expect(attachment).toMatchObject({ offset: 2, lostBytes: 2 })
    expect(Buffer.from(attachment.data, 'base64').toString()).toBe('23456789')
  })

  it.each([
    ['a negative offset', -1],
    ['a fractional offset', 1.5],
    ['an offset that is not a number', 'zero']
  ])('refuses %s', async (_label, fromOffset) => {
    const opened = await open()
    await expect(host.call(peer, 'terminals.attach', {
      projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId, fromOffset
    })).rejects.toThrow(/fromOffset/)
  })

  it('writes what was sent, decoded from base64', async () => {
    const opened = await open()
    await host.call(peer, 'terminals.write', {
      projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId, data: Buffer.from('ls\r').toString('base64')
    })
    expect(runtime.writes[0]?.bytes.toString()).toBe('ls\r')
  })

  it('refuses a write past the bound before it decodes it', async () => {
    const opened = await open()
    const oversized = Buffer.alloc(TERMINAL_MAX_WRITE_BYTES + 1, 0x61).toString('base64')
    await expect(host.call(peer, 'terminals.write', {
      projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId, data: oversized
    })).rejects.toThrow(/at most/)
    expect(runtime.writes).toHaveLength(0)
  })

  it('accepts a write at exactly the bound', async () => {
    const opened = await open()
    await host.call(peer, 'terminals.write', {
      projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId,
      data: Buffer.alloc(TERMINAL_MAX_WRITE_BYTES, 0x61).toString('base64')
    })
    expect(runtime.writes[0]?.bytes).toHaveLength(TERMINAL_MAX_WRITE_BYTES)
  })

  it('refuses a write to a shell that already stopped', async () => {
    const opened = await open()
    runtime.exit(opened.terminalId, 0)
    await expect(host.call(peer, 'terminals.write', {
      projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId, data: Buffer.from('x').toString('base64')
    })).rejects.toThrow(/already stopped/)
  })

  it('closes the shell and the tab it opened for it', async () => {
    const opened = await open()
    stream.subscribe('peer-1', opened.terminalId, 0)
    await host.call(peer, 'terminals.close', { projectId: 'shared', sessionId: 'workspace', terminalId: opened.terminalId })
    expect(runtime.killed).toEqual([opened.terminalId])
    expect(closedTabs).toEqual([`tab-${opened.terminalId}`])
  })

  it('leaves the shell running when a machine only stops watching it', async () => {
    const opened = await open()
    stream.subscribe('peer-1', opened.terminalId, 0)
    host.dropPeer('peer-1')
    runtime.emit(opened.terminalId, 'still here')
    expect(runtime.killed).toEqual([])
    expect(runtime.running(opened.terminalId)).toBe(true)
    expect(stream.frames.filter(frame => frame.type === 'data')).toHaveLength(0)
  })

  it('stops the shells a revoked machine started', async () => {
    const opened = await open()
    host.revokePeer('peer-1')
    expect(runtime.killed).toEqual([opened.terminalId])
  })

  it('leaves another machine\'s shells alone when one is revoked', async () => {
    const mine = await open()
    const theirs = await host.call(other, 'terminals.open', { projectId: 'shared', sessionId: 'workspace', opId: 'op-2', cols: 80, rows: 24 }) as RemoteTerminalSummary
    host.revokePeer('peer-1')
    expect(runtime.killed).toEqual([mine.terminalId])
    expect(runtime.running(theirs.terminalId)).toBe(true)
  })

  it('replays from the requested offset and then forwards live output, in that order', async () => {
    const opened = await open()
    runtime.emit(opened.terminalId, 'already said')
    stream.subscribe('peer-1', opened.terminalId, 8)
    runtime.emit(opened.terminalId, ' and more')
    expect(stream.frames).toEqual([
      { type: 'data', terminalId: opened.terminalId, offset: 8, data: Buffer.from('said').toString('base64') },
      { type: 'data', terminalId: opened.terminalId, offset: 12, data: Buffer.from(' and more').toString('base64') }
    ])
  })

  it('reports the gap before the replay when the buffer had already dropped output', async () => {
    runtime.limit = 4
    const opened = await open()
    runtime.emit(opened.terminalId, '0123456789')
    stream.subscribe('peer-1', opened.terminalId, 0)
    expect(stream.frames[0]).toEqual({ type: 'gap', terminalId: opened.terminalId, lostBytes: 6, offset: 6 })
    expect(stream.frames[1]).toMatchObject({ type: 'data', offset: 6 })
  })

  it('tells a machine that subscribes to a shell that already stopped', async () => {
    const opened = await open()
    runtime.emit(opened.terminalId, 'bye')
    runtime.exit(opened.terminalId, 2)
    stream.subscribe('peer-1', opened.terminalId, 0)
    expect(stream.frames.at(-1)).toEqual({ type: 'exit', terminalId: opened.terminalId, exitCode: 2 })
  })

  it('forwards an exit that happens while a machine is watching', async () => {
    const opened = await open()
    stream.subscribe('peer-1', opened.terminalId, 0)
    runtime.exit(opened.terminalId, 130)
    expect(stream.frames).toContainEqual({ type: 'exit', terminalId: opened.terminalId, exitCode: 130 })
  })

  it('does not feed a machine whose grant no longer covers the project', async () => {
    const opened = await open()
    authorized = false
    stream.subscribe('peer-1', opened.terminalId, 0)
    runtime.emit(opened.terminalId, 'secret')
    expect(stream.frames).toHaveLength(0)
  })

  it('stops feeding a machine that unsubscribed', async () => {
    const opened = await open()
    stream.subscribe('peer-1', opened.terminalId, 0)
    stream.unsubscribe('peer-1', opened.terminalId)
    runtime.emit(opened.terminalId, 'after')
    expect(stream.frames).toHaveLength(0)
  })

  it('does not double-feed a machine that subscribes twice', async () => {
    const opened = await open()
    stream.subscribe('peer-1', opened.terminalId, 0)
    stream.subscribe('peer-1', opened.terminalId, 0)
    runtime.emit(opened.terminalId, 'once')
    expect(stream.frames.filter(frame => frame.type === 'data' && frame.data === Buffer.from('once').toString('base64'))).toHaveLength(1)
  })

  it('names the tab showing each shell when it lists them', async () => {
    const opened = await open()
    const listed = await host.call(peer, 'terminals.list', { projectId: 'shared', sessionId: 'workspace' }) as RemoteTerminalSummary[]
    expect(listed).toEqual([expect.objectContaining({ terminalId: opened.terminalId, tabId: `tab-${opened.terminalId}`, running: true })])
  })

  it('refuses a method it does not know', async () => {
    await expect(host.call(peer, 'terminals.destroyEverything', { projectId: 'shared', sessionId: 'workspace' })).rejects.toThrow(/Unknown remote method/)
  })

  it('will not stream a shell to a peer that named a workspace the shell is not in', async () => {
    const opened = await open()
    stream.subscribe('peer-1', opened.terminalId, 0, { projectId: 'shared', sessionId: 'some-other-workspace' })
    runtime.emit(opened.terminalId, 'secret')
    expect(stream.frames).toHaveLength(0)
  })

  it('can be given the stream after it was built, and drops what the old one fed', async () => {
    const late = new RemoteTerminalHost({
      terminals: runtime,
      workspace: () => ({ projectId: 'shared', sessionId: 'workspace' }),
      authorize: () => undefined,
      openTab: async () => null,
      closeTab: async () => undefined,
      tabId: () => null,
      projectPath: () => 'C:\work'
    })
    const opened = await late.call(peer, 'terminals.open', { projectId: 'shared', sessionId: 'workspace', opId: 'op-late', cols: 80, rows: 24 }) as RemoteTerminalSummary
    runtime.emit(opened.terminalId, 'before the channel')
    late.useStream(stream.api)
    stream.subscribe('peer-1', opened.terminalId, 0)
    expect(stream.frames).toEqual([{ type: 'data', terminalId: opened.terminalId, offset: 0, data: Buffer.from('before the channel').toString('base64') }])
    late.dispose()
  })

  it('lets go of the stream host when it is disposed', async () => {
    const opened = await open()
    stream.subscribe('peer-1', opened.terminalId, 0)
    host.dispose()
    expect(stream.detached).toBe(2)
    runtime.emit(opened.terminalId, 'after')
    expect(stream.frames.filter(frame => frame.type === 'data' && frame.data === Buffer.from('after').toString('base64'))).toHaveLength(0)
  })
})

describe('RemoteTerminalBindings', () => {
  let settings: Map<string, string>
  let calls: Array<{ machineId: string; method: string; args: Record<string, unknown> }>
  let published: Array<{ channel: string; payload: Record<string, unknown> }>
  let subscriptions: Array<{ machineId: string; projectId: string; sessionId: string; terminalId: string; fromOffset: number }>
  let unsubscribed: Array<{ machineId: string; terminalId: string }>
  let connected: boolean
  let reply: (method: string) => unknown
  let fail: boolean
  let bindings: RemoteTerminalBindings

  const store = () => ({
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string) => { settings.set(key, value) }
  })

  const build = (): RemoteTerminalBindings => new RemoteTerminalBindings({
    settings: store(),
    call: async (machineId, method, args) => {
      calls.push({ machineId, method, args: args ?? {} })
      if (fail) throw new Error('unreachable')
      return reply(method)
    },
    subscribe: (machineId, projectId, sessionId, terminalId, fromOffset) => {
      subscriptions.push({ machineId, projectId, sessionId, terminalId, fromOffset })
    },
    unsubscribe: (machineId, terminalId) => { unsubscribed.push({ machineId, terminalId }) },
    publish: (channel, payload) => { published.push({ channel, payload: payload as Record<string, unknown> }) },
    connected: () => connected
  })

  beforeEach(() => {
    settings = new Map()
    calls = []
    published = []
    subscriptions = []
    unsubscribed = []
    connected = true
    fail = false
    reply = method => {
      if (method === 'terminals.open') return { terminalId: 'host-term', tabId: 'host-tab', title: 'Shell', cwd: '/w', running: true, exitCode: null, offset: 0 }
      if (method === 'terminals.attach') return { terminalId: 'host-term', offset: 0, data: '', lostBytes: 0, running: true, exitCode: null, cols: 80, rows: 24 }
      if (method === 'terminals.list') return [{ terminalId: 'host-term', tabId: null, title: 'Shell', cwd: '/w', running: true, exitCode: null, offset: 12 }]
      return { closed: true }
    }
    bindings = build()
  })

  const opened = async (): Promise<string> => {
    const binding = await bindings.open({ machineId: 'main', projectId: 'local-project', sessionId: 'local-workspace', cols: 100, rows: 40, machineName: 'MAIN', remoteProjectId: 'host-project', remoteSessionId: 'host-workspace' })
    return binding.localTerminalId
  }

  it('binds a local id to the shell it opened there, keeping the host ids out of sight', async () => {
    const localId = await opened()
    expect(calls[0]).toMatchObject({ machineId: 'main', method: 'terminals.open', args: { projectId: 'host-project', sessionId: 'host-workspace', cols: 100, rows: 40 } })
    expect(typeof calls[0]?.args.opId).toBe('string')
    expect(bindings.isRemote(localId)).toBe(true)
    expect(bindings.get(localId)).toMatchObject({ remoteTerminalId: 'host-term', machineId: 'main', machineName: 'MAIN', offset: 0 })
  })

  it('mounts a pane without spawning anything and asks the stream for output from where it stopped', async () => {
    const localId = await opened()
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'host-term', offset: 0, data: Buffer.from('hello').toString('base64') })
    subscriptions.length = 0
    const result = bindings.ensure({ id: localId, projectId: 'local-project', sessionId: 'local-workspace', title: 'Shell', cwd: 'C:\\anything' })
    expect(result).toMatchObject({ id: localId, available: true, status: 'running', transcript: '' })
    expect(subscriptions).toEqual([{ machineId: 'main', projectId: 'host-project', sessionId: 'host-workspace', terminalId: 'host-term', fromOffset: 5 }])
    // Nothing here starts a process; every call this class made went to the other machine.
    expect(calls.map(call => call.method)).toEqual(['terminals.open'])
  })

  it('refuses to mount a terminal that is not bound to a machine', () => {
    expect(() => bindings.ensure({ id: 'unknown', projectId: 'p', sessionId: 's', title: 'x', cwd: 'c' })).toThrow(/not running on another machine/)
  })

  it('shows streamed output under the local id', async () => {
    const localId = await opened()
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'host-term', offset: 0, data: Buffer.from('hello').toString('base64') })
    expect(published).toEqual([{ channel: 'terminal:data', payload: { id: localId, data: 'hello' } }])
  })

  it('shows a character split across two frames once, whole', async () => {
    await opened()
    const euro = Buffer.from('€', 'utf8')
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'host-term', offset: 0, data: euro.subarray(0, 2).toString('base64') })
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'host-term', offset: 2, data: euro.subarray(2).toString('base64') })
    expect(published.map(entry => entry.payload.data).join('')).toBe('€')
  })

  it('drops what it has already shown when a reconnect replays over it', async () => {
    const localId = await opened()
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'host-term', offset: 0, data: Buffer.from('abcdef').toString('base64') })
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'host-term', offset: 3, data: Buffer.from('defghi').toString('base64') })
    expect(published.map(entry => entry.payload.data)).toEqual(['abcdef', 'ghi'])
    expect(bindings.get(localId)?.offset).toBe(9)
  })

  it('says how much output was lost rather than letting it pass unnoticed', async () => {
    const localId = await opened()
    bindings.onFrame('main', { type: 'terminal.gap', terminalId: 'host-term', lostBytes: 4096, offset: 4096 })
    expect(published[0]?.payload.data).toBe('\r\n[Conductor] 4096 bytes of output were dropped by MAIN before this view caught up.\r\n')
    expect(bindings.get(localId)?.offset).toBe(4096)
  })

  it('broadcasts the exit in the shape the panes already listen for', async () => {
    const localId = await opened()
    bindings.onFrame('main', { type: 'terminal.exit', terminalId: 'host-term', exitCode: 137 })
    expect(published).toEqual([{ channel: 'terminal:status', payload: { id: localId, status: 'exited', exitCode: 137 } }])
  })

  it('ignores a frame for a terminal on a machine it has no binding to', async () => {
    await opened()
    bindings.onFrame('other-machine', { type: 'terminal.data', terminalId: 'host-term', offset: 0, data: Buffer.from('x').toString('base64') })
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'someone-else', offset: 0, data: Buffer.from('x').toString('base64') })
    expect(published).toEqual([])
  })

  it('forwards keystrokes as base64 to the host', async () => {
    const localId = await opened()
    bindings.write(localId, 'ls\r')
    await Promise.resolve()
    expect(calls[1]).toMatchObject({ method: 'terminals.write', args: { terminalId: 'host-term', data: Buffer.from('ls\r').toString('base64') } })
  })

  it('drops keystrokes rather than queueing them while the machine is unreachable, and says so once', async () => {
    const localId = await opened()
    connected = false
    bindings.write(localId, 'rm -rf /\r')
    bindings.write(localId, 'y\r')
    expect(calls.map(call => call.method)).toEqual(['terminals.open'])
    expect(published).toEqual([{ channel: 'terminal:data', payload: { id: localId, data: '\r\n[Conductor] Not connected to MAIN — keystrokes were not sent.\r\n' } }])
  })

  it('says so again after a write got through and the connection dropped a second time', async () => {
    const localId = await opened()
    connected = false
    bindings.write(localId, 'a')
    connected = true
    bindings.write(localId, 'b')
    await Promise.resolve()
    connected = false
    bindings.write(localId, 'c')
    expect(published.filter(entry => String(entry.payload.data).includes('keystrokes were not sent'))).toHaveLength(2)
  })

  it('says keystrokes were lost when the call itself fails', async () => {
    const localId = await opened()
    fail = true
    bindings.write(localId, 'x')
    await Promise.resolve()
    await Promise.resolve()
    expect(published.at(-1)?.payload.data).toContain('keystrokes were not sent')
  })

  it('splits a paste larger than one write into bounded writes', async () => {
    const localId = await opened()
    bindings.write(localId, 'a'.repeat(TERMINAL_MAX_WRITE_BYTES + 10))
    await Promise.resolve()
    const writes = calls.filter(call => call.method === 'terminals.write')
    expect(writes).toHaveLength(2)
    expect(Buffer.from(String(writes[0]?.args.data), 'base64')).toHaveLength(TERMINAL_MAX_WRITE_BYTES)
    expect(Buffer.from(String(writes[1]?.args.data), 'base64')).toHaveLength(10)
  })

  it('forwards a resize and ignores a nonsensical one', async () => {
    const localId = await opened()
    bindings.resize(localId, 120, 30)
    bindings.resize(localId, 1, 0)
    await Promise.resolve()
    expect(calls.filter(call => call.method === 'terminals.resize')).toHaveLength(1)
  })

  it('closing the view keeps the shell; killing it stops the shell', async () => {
    const first = await opened()
    bindings.release(first)
    expect(calls.map(call => call.method)).toEqual(['terminals.open'])
    expect(unsubscribed).toEqual([{ machineId: 'main', terminalId: 'host-term' }])
    expect(bindings.isRemote(first)).toBe(false)

    const second = await opened()
    await bindings.kill(second)
    expect(calls.at(-1)).toMatchObject({ method: 'terminals.close', args: { terminalId: 'host-term' } })
    expect(bindings.isRemote(second)).toBe(false)
  })

  it('releases the view even when the machine could not be told to close the shell', async () => {
    const localId = await opened()
    fail = true
    await expect(bindings.kill(localId)).rejects.toThrow(/unreachable/)
    expect(bindings.isRemote(localId)).toBe(false)
  })

  it('drops every view onto a machine the owner detached from', async () => {
    const localId = await opened()
    bindings.releaseMachine('main')
    expect(bindings.list()).toEqual([])
    expect(bindings.isRemote(localId)).toBe(false)
  })

  it('reattaches to a shell already running there instead of opening another', async () => {
    const binding = await bindings.attach({ machineId: 'main', projectId: 'local-project', sessionId: 'local-workspace', remoteTerminalId: 'host-term', remoteProjectId: 'host-project', remoteSessionId: 'host-workspace', machineName: 'MAIN' })
    expect(calls[0]).toMatchObject({ method: 'terminals.attach', args: { terminalId: 'host-term', fromOffset: 0 } })
    expect(binding.offset).toBe(0)
    const again = await bindings.attach({ machineId: 'main', projectId: 'local-project', sessionId: 'local-workspace', remoteTerminalId: 'host-term' })
    expect(again.localTerminalId).toBe(binding.localTerminalId)
    expect(calls.filter(call => call.method === 'terminals.attach')).toHaveLength(1)
  })

  it('survives a restart, resuming from the offset it had persisted', async () => {
    const localId = await opened()
    bindings.onFrame('main', { type: 'terminal.data', terminalId: 'host-term', offset: 0, data: Buffer.from('hello').toString('base64') })
    bindings.flush()
    const restarted = build()
    expect(restarted.isRemote(localId)).toBe(true)
    subscriptions.length = 0
    restarted.ensure({ id: localId, projectId: 'local-project', sessionId: 'local-workspace', title: 'Shell', cwd: 'C:\\anything' })
    expect(subscriptions[0]?.fromOffset).toBe(5)
  })

  it('ignores a stored binding that is missing the ids it needs', () => {
    settings.set('remote-control.terminalBindings', JSON.stringify([{ localTerminalId: 'a' }, null, 'nonsense']))
    expect(build().list()).toEqual([])
  })

  it('asks the host what it is running', async () => {
    const listed = await bindings.remoteList({ machineId: 'main', projectId: 'host-project', sessionId: 'host-workspace' })
    expect(listed).toEqual([expect.objectContaining({ terminalId: 'host-term', offset: 12 })])
  })

  it('refuses a reply that does not name a terminal', async () => {
    reply = () => ({})
    await expect(bindings.open({ machineId: 'main', projectId: 'p', sessionId: 's', cols: 80, rows: 24 })).rejects.toThrow(/did not return a terminal/)
  })

  it('refuses an attachment for a terminal other than the one asked for', async () => {
    reply = () => ({ terminalId: 'something-else' })
    await expect(bindings.attach({ machineId: 'main', projectId: 'p', sessionId: 's', remoteTerminalId: 'host-term' }))
      .rejects.toThrow(/did not return the terminal/)
  })
})

describe('StreamHostFrame routing', () => {
  it('ignores frames that are not about terminals', () => {
    const published: unknown[] = []
    const bindings = new RemoteTerminalBindings({
      settings: { getSetting: () => null, setSetting: () => undefined },
      call: async () => ({}),
      subscribe: () => undefined,
      unsubscribe: () => undefined,
      publish: payload => { published.push(payload) }
    })
    const frame: StreamHostFrame = { type: 'tabs.changed', projectId: 'p', sessionId: 's' }
    bindings.onFrame('main', frame)
    expect(published).toEqual([])
  })
})
