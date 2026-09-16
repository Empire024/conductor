import { StringDecoder } from 'node:string_decoder'
import { makeId, type RuntimeEnsureResult, type TerminalSpec } from '../shared/models'
import type { RemotePeerRecord } from '../shared/remote-control'
import type { StreamHostFrame } from '../shared/remote-stream'
import {
  TERMINAL_MAX_WRITE_BYTES,
  type RemoteTerminalAttachment,
  type RemoteTerminalBinding,
  type RemoteTerminalSummary
} from '../shared/remote-terminals'
import { RemoteAccessError } from './remote-peers'
import type { TerminalExitListener, TerminalOutputListener, TerminalSize } from './terminal-manager'

/**
 * Terminals across two computers.
 *
 * `RemoteTerminalHost` is the half that runs the shell. It answers a paired machine's
 * `terminals.*` calls under the same project grant as every other host operation, opens a real tab
 * on this machine so its owner can see the shell that was started here, and fans output out over
 * the push stream from whatever offset a controller says it reached.
 *
 * `RemoteTerminalBindings` is the half that shows it. It binds a local terminal id to a shell on
 * another machine, spawns nothing of its own, forwards keystrokes, and turns streamed frames into
 * the ordinary `terminal:data` broadcast the panes already listen to. It is deliberately the same
 * shape as RemoteSessionMirror: ids are mapped, bindings are persisted, and `isRemote` is what
 * routes a request away from local execution.
 *
 * docs/multi-device.md states the trust boundary both halves sit on: a paired device allowed to
 * open a shell here is trusted to act as this machine's user. Nothing below narrows that, and
 * nothing below pretends to.
 */

/** What a controller asked for on the push channel, as the stream host reports it. */
export interface RemoteTerminalSubscription {
  peerId: string
  terminalId: string
  projectId: string
  sessionId: string
  /** Where in this machine's ring buffer that controller wants to resume. */
  fromOffset: number
}

/** Terminal fan-out on the transport's stream host; this file only ever calls into this shape. */
export interface RemoteTerminalStream {
  terminalData(terminalId: string, offset: number, base64: string): void
  terminalGap(terminalId: string, lostBytes: number, offset: number): void
  terminalExit(terminalId: string, exitCode: number | null): void
  onTerminalSubscribe(listener: (subscription: RemoteTerminalSubscription) => void): () => void
  onTerminalUnsubscribe(listener: (subscription: { peerId: string; terminalId: string }) => void): () => void
}

/** What the host half needs from TerminalManager, named so a test can stand in for the real one. */
export interface TerminalRuntime {
  ensure(spec: TerminalSpec, size?: TerminalSize): RuntimeEnsureResult
  list(projectId: string, sessionId: string): RemoteTerminalSummary[]
  summary(id: string): RemoteTerminalSummary | null
  spec(id: string): TerminalSpec | null
  attach(id: string, fromOffset: number): RemoteTerminalAttachment | null
  write(id: string, data: string | Buffer): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  running(id: string): boolean
  onOutput(id: string, listener: TerminalOutputListener): () => void
  onExit(id: string, listener: TerminalExitListener): () => void
}

type Args = Record<string, unknown>

const text = (args: Args, key: string, maximum: number): string => {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new RemoteAccessError(`Invalid ${key}`, 400)
  }
  return value
}

const size = (args: Args, key: 'cols' | 'rows'): number => {
  const value = args[key]
  const minimum = key === 'cols' ? 2 : 1
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 1000) {
    throw new RemoteAccessError(`Invalid ${key}`, 400)
  }
  return value
}

/** How many `opId`s one peer's retries are remembered for; older ones fall out. */
const OPID_MEMORY = 128
/** Base64 grows by four bytes per three, so anything past this cannot decode within the write bound. */
const MAX_WRITE_BASE64 = Math.ceil(TERMINAL_MAX_WRITE_BYTES / 3) * 4 + 8

export interface RemoteTerminalHostDependencies {
  terminals: TerminalRuntime
  /** The project grant, applied exactly as every other host method applies it. */
  workspace(peer: RemotePeerRecord, args: Args): { projectId: string; sessionId: string }
  /**
   * Re-checks a peer id against a project, for the stream, where only the id travels with a
   * subscription. Throws when that peer may no longer work in that project.
   */
  authorize(peerId: string, projectId: string): void
  /** Opens a visible terminal tab on this machine, through the same path a remote agent tab uses. */
  openTab(peer: RemotePeerRecord, request: { projectId: string; sessionId: string; terminalId: string; title: string }): Promise<{ id: string } | null>
  closeTab(peer: RemotePeerRecord, request: { projectId: string; sessionId: string; tabId: string }): Promise<void>
  /** This machine's own tab showing a terminal, when its UI shows one. */
  tabId(projectId: string, sessionId: string, terminalId: string): string | null
  /** The folder a shell opened for that project starts in. */
  projectPath(projectId: string): string | null
  stream?: RemoteTerminalStream
}

interface OpenedTerminal {
  terminalId: string
  projectId: string
  sessionId: string
}

interface Subscription {
  offOutput(): void
  offExit(): void
}

/** Serves one machine's terminals to the paired machines it granted projects to. */
export class RemoteTerminalHost {
  /** `${peerId}\0${opId}` → the open that request started, so a retry finds it instead of a second shell. */
  private readonly operations = new Map<string, Promise<RemoteTerminalSummary>>()
  private readonly opened = new Map<string, OpenedTerminal>()
  /** Which peer asked for a shell, so revoking that peer can stop what it started. */
  private readonly owners = new Map<string, string>()
  /** `${peerId}\0${terminalId}` → the manager subscriptions feeding that peer's stream. */
  private readonly subscriptions = new Map<string, Subscription>()

  /** Undone on dispose, so a restarted stream host is not fed by the previous one's listeners. */
  private readonly detachers: Array<() => void> = []
  private stream: RemoteTerminalStream | null = null

  constructor(private readonly deps: RemoteTerminalHostDependencies) {
    if (deps.stream) this.useStream(deps.stream)
  }

  /**
   * Attaches the push channel. Separate from the constructor because the stream host is built
   * after this one in the wiring, and a terminal that opened before the channel existed still has
   * to be streamable once it does - the controller simply subscribes from the offset it has.
   */
  useStream(stream: RemoteTerminalStream): void {
    for (const detach of this.detachers.splice(0)) detach()
    for (const key of [...this.subscriptions.keys()]) {
      const separator = key.indexOf('\0')
      this.unsubscribe(key.slice(0, separator), key.slice(separator + 1))
    }
    this.stream = stream
    this.detachers.push(stream.onTerminalSubscribe(subscription => this.subscribe(subscription)))
    this.detachers.push(stream.onTerminalUnsubscribe(({ peerId, terminalId }) => this.unsubscribe(peerId, terminalId)))
  }

  async call(peer: RemotePeerRecord, method: string, args: Args): Promise<unknown> {
    // Every method resolves the workspace first. That single call is the grant: it refuses a
    // project this peer was not given, one whose folder no longer holds the working copy the owner
    // approved, and a workspace that belongs to some other project.
    const { projectId, sessionId } = this.deps.workspace(peer, args)
    if (method === 'terminals.list') return this.list(projectId, sessionId)
    if (method === 'terminals.open') return this.open(peer, projectId, sessionId, args)
    if (method === 'terminals.attach') return this.attach(projectId, sessionId, args)
    if (method === 'terminals.write') return this.write(projectId, sessionId, args)
    if (method === 'terminals.resize') return this.resize(projectId, sessionId, args)
    if (method === 'terminals.close') return this.close(peer, projectId, sessionId, args)
    throw new RemoteAccessError('Unknown remote method; use tools.list.', 400)
  }

  private list(projectId: string, sessionId: string): RemoteTerminalSummary[] {
    return this.deps.terminals.list(projectId, sessionId)
      .map(summary => ({ ...summary, tabId: this.deps.tabId(projectId, sessionId, summary.terminalId) }))
  }

  /** Resolves a terminal id the peer named, refusing one that belongs to another workspace. */
  private require(projectId: string, sessionId: string, args: Args): string {
    const terminalId = text(args, 'terminalId', 160)
    const spec = this.deps.terminals.spec(terminalId)
    if (!spec) throw new RemoteAccessError('That terminal is not open on this machine.', 404)
    // A granted project does not carry an id from a different one: without this a peer could name
    // any terminal on the host as long as it had one project shared with it.
    if (spec.projectId !== projectId || spec.sessionId !== sessionId) {
      throw new RemoteAccessError('That terminal belongs to a different workspace on this machine.', 403)
    }
    return terminalId
  }

  /**
   * Opens a shell here for a paired machine. `opId` is what makes a retry safe: a request that was
   * answered but whose reply was lost on a dropped connection finds the terminal it already opened
   * rather than leaving a second shell running that nobody is attached to.
   */
  private async open(peer: RemotePeerRecord, projectId: string, sessionId: string, args: Args): Promise<RemoteTerminalSummary> {
    const opId = text(args, 'opId', 160)
    const key = `${peer.id}\0${opId}`
    const inFlight = this.operations.get(key)
    if (inFlight) return inFlight
    const remembered = this.opened.get(key)
    if (remembered) {
      if (remembered.projectId !== projectId || remembered.sessionId !== sessionId) {
        throw new RemoteAccessError('That operation id was already used for a different workspace.', 409)
      }
      const summary = this.deps.terminals.summary(remembered.terminalId)
      // Forgotten entirely - the shell exited long enough ago that its record was released - is
      // the one case where the same opId opens something new, because there is nothing to find.
      if (summary) return { ...summary, tabId: this.deps.tabId(projectId, sessionId, remembered.terminalId) }
      this.opened.delete(key)
    }
    const operation = this.spawn(peer, projectId, sessionId, args, key)
    this.operations.set(key, operation)
    try { return await operation } finally { this.operations.delete(key) }
  }

  private async spawn(peer: RemotePeerRecord, projectId: string, sessionId: string, args: Args, key: string): Promise<RemoteTerminalSummary> {
    const cwd = this.deps.projectPath(projectId)
    if (!cwd) throw new RemoteAccessError('That project is no longer registered on this machine.', 404)
    const cols = size(args, 'cols')
    const rows = size(args, 'rows')
    const title = args.title === undefined ? 'Terminal' : text(args, 'title', 120)
    const spec: TerminalSpec = { id: makeId('terminal'), projectId, sessionId, title, cwd }
    const started = this.deps.terminals.ensure(spec, { cols, rows })
    if (!started.available) throw new RemoteAccessError(started.message || 'This machine could not start a shell.', 409)
    this.remember(key, { terminalId: spec.id, projectId, sessionId })
    this.owners.set(spec.id, peer.id)
    // The owner of this machine sees the shell a paired machine started, in a real tab, stamped
    // with whose it is. The shell is already running by now, so a machine with no window open -
    // which is the ordinary state while it is hosting - still serves the terminal; it simply has
    // no tab to show until someone opens a window.
    let tabId: string | null = null
    try {
      tabId = (await this.deps.openTab(peer, { projectId, sessionId, terminalId: spec.id, title }))?.id ?? null
    } catch (error) {
      console.warn('Remote terminal tab could not be opened on this machine', error)
    }
    const summary = this.deps.terminals.summary(spec.id)
    if (!summary) throw new RemoteAccessError('The shell stopped before it could be reported.', 500)
    return { ...summary, tabId: tabId ?? this.deps.tabId(projectId, sessionId, spec.id) }
  }

  private remember(key: string, opened: OpenedTerminal): void {
    this.opened.set(key, opened)
    while (this.opened.size > OPID_MEMORY) {
      const oldest = this.opened.keys().next().value
      if (oldest === undefined) break
      this.opened.delete(oldest)
    }
  }

  private attach(projectId: string, sessionId: string, args: Args): RemoteTerminalAttachment {
    const terminalId = this.require(projectId, sessionId, args)
    const fromOffset = args.fromOffset === undefined ? 0 : args.fromOffset
    if (typeof fromOffset !== 'number' || !Number.isSafeInteger(fromOffset) || fromOffset < 0) {
      throw new RemoteAccessError('Invalid fromOffset', 400)
    }
    const attachment = this.deps.terminals.attach(terminalId, fromOffset)
    if (!attachment) throw new RemoteAccessError('That terminal is not open on this machine.', 404)
    return attachment
  }

  private write(projectId: string, sessionId: string, args: Args): { written: number } {
    const terminalId = this.require(projectId, sessionId, args)
    const encoded = args.data
    if (typeof encoded !== 'string' || encoded.length > MAX_WRITE_BASE64) {
      throw new RemoteAccessError(`A remote write is at most ${TERMINAL_MAX_WRITE_BYTES} bytes.`, 413)
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > TERMINAL_MAX_WRITE_BYTES) {
      throw new RemoteAccessError(`A remote write is at most ${TERMINAL_MAX_WRITE_BYTES} bytes.`, 413)
    }
    if (!this.deps.terminals.running(terminalId)) throw new RemoteAccessError('That shell has already stopped.', 409)
    this.deps.terminals.write(terminalId, bytes)
    return { written: bytes.length }
  }

  private resize(projectId: string, sessionId: string, args: Args): { resized: boolean } {
    const terminalId = this.require(projectId, sessionId, args)
    this.deps.terminals.resize(terminalId, size(args, 'cols'), size(args, 'rows'))
    return { resized: true }
  }

  /**
   * Stops the shell. This is the explicit "stop the work", not a controller closing its view: a
   * machine that merely stops looking unsubscribes from the stream and leaves the shell running,
   * exactly as detaching from an agent leaves the agent running.
   */
  private async close(peer: RemotePeerRecord, projectId: string, sessionId: string, args: Args): Promise<{ closed: boolean }> {
    const terminalId = this.require(projectId, sessionId, args)
    const tabId = this.deps.tabId(projectId, sessionId, terminalId)
    this.deps.terminals.kill(terminalId)
    this.owners.delete(terminalId)
    for (const key of [...this.subscriptions.keys()]) {
      this.unsubscribe(key.slice(0, key.indexOf('\0')), terminalId)
    }
    if (tabId) {
      // The tab was opened for this peer's shell, so it goes with it. Failing to close it must not
      // fail the stop: the shell is already gone, which is what was asked for.
      try { await this.deps.closeTab(peer, { projectId, sessionId, tabId }) }
      catch (error) { console.warn('Remote terminal tab could not be closed on this machine', error) }
    }
    return { closed: true }
  }

  /**
   * Starts feeding a peer's stream from where it says it reached. Replay and live subscription
   * happen in one synchronous run so no chunk can slip between them: registering the listener
   * first would deliver live output ahead of the replay, and registering it after an await would
   * lose whatever arrived in between.
   */
  private subscribe({ peerId, terminalId, projectId, sessionId, fromOffset }: RemoteTerminalSubscription): void {
    const stream = this.stream
    if (!stream) return
    const spec = this.deps.terminals.spec(terminalId)
    if (!spec) return
    // The frame names a workspace, and it has to be the one the shell actually belongs to: a peer
    // with one granted project must not reach a terminal running in a different one by naming the
    // project it does have.
    if (spec.projectId !== projectId || spec.sessionId !== sessionId) return
    try {
      this.deps.authorize(peerId, spec.projectId)
    } catch (error) {
      // The transport refuses the subscription on its own terms; this side simply does not feed a
      // peer whose grant no longer covers the project the shell belongs to.
      console.warn('Remote terminal subscription refused', error)
      return
    }
    this.unsubscribe(peerId, terminalId)
    const attachment = this.deps.terminals.attach(terminalId, Number.isSafeInteger(fromOffset) && fromOffset > 0 ? fromOffset : 0)
    if (!attachment) return
    if (attachment.lostBytes > 0) stream.terminalGap(terminalId, attachment.lostBytes, attachment.offset)
    if (attachment.data) stream.terminalData(terminalId, attachment.offset, attachment.data)
    const offOutput = this.deps.terminals.onOutput(terminalId, (offset, bytes) => {
      stream.terminalData(terminalId, offset, bytes.toString('base64'))
    })
    const offExit = this.deps.terminals.onExit(terminalId, exitCode => stream.terminalExit(terminalId, exitCode))
    this.subscriptions.set(`${peerId}\0${terminalId}`, { offOutput, offExit })
    // A shell that had already stopped when the controller asked still has to say so, or the view
    // waits forever for output from a process that is gone.
    if (!attachment.running) stream.terminalExit(terminalId, attachment.exitCode)
  }

  private unsubscribe(peerId: string, terminalId: string): void {
    const key = `${peerId}\0${terminalId}`
    const subscription = this.subscriptions.get(key)
    if (!subscription) return
    subscription.offOutput()
    subscription.offExit()
    this.subscriptions.delete(key)
  }

  /**
   * Stops feeding one machine. Its shells keep running: losing a connection, or a controller
   * saying it is going standalone, is not the owner of this machine stopping the work.
   */
  dropPeer(peerId: string): void {
    for (const key of [...this.subscriptions.keys()]) {
      if (key.startsWith(`${peerId}\0`)) this.unsubscribe(peerId, key.slice(peerId.length + 1))
    }
    for (const key of [...this.opened.keys()]) {
      if (key.startsWith(`${peerId}\0`)) this.opened.delete(key)
    }
  }

  /**
   * Revocation, which docs/multi-device.md promises closes that device's terminals immediately.
   * Stronger than dropPeer on purpose: a device the owner just revoked must not leave a shell
   * running on this machine that it started.
   */
  revokePeer(peerId: string): void {
    for (const [terminalId, owner] of [...this.owners]) {
      if (owner !== peerId) continue
      this.deps.terminals.kill(terminalId)
      this.owners.delete(terminalId)
    }
    this.dropPeer(peerId)
  }

  dispose(): void {
    for (const detach of this.detachers.splice(0)) detach()
    this.stream = null
    for (const key of [...this.subscriptions.keys()]) {
      const separator = key.indexOf('\0')
      this.unsubscribe(key.slice(0, separator), key.slice(separator + 1))
    }
    this.operations.clear()
    this.opened.clear()
    this.owners.clear()
  }
}

/* ------------------------------------------------------------------------------------------- */

const BINDINGS_SETTING = 'remote-control.terminalBindings'
/** Output advanced past this since the last write before the resume offset is persisted again. */
const PERSIST_EVERY_BYTES = 64 * 1024

/**
 * The local half of a terminal that runs somewhere else. The local id is what every pane, IPC
 * handler and layout already keys on; the remote ids are the host's and are never shown.
 */
export interface RemoteTerminalBindingRecord extends RemoteTerminalBinding {
  projectId: string
  sessionId: string
  remoteProjectId: string
  remoteSessionId: string
  /** Bytes of that shell's output already shown here, so a reconnect resumes rather than replays. */
  offset: number
}

export function readTerminalBindings(raw: string | undefined): RemoteTerminalBindingRecord[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Partial<RemoteTerminalBindingRecord>
    const strings = [value.localTerminalId, value.remoteTerminalId, value.machineId, value.machineName,
      value.projectId, value.sessionId, value.remoteProjectId, value.remoteSessionId]
    if (strings.some(field => typeof field !== 'string' || !field)) return []
    return [{
      ...(value as RemoteTerminalBindingRecord),
      offset: Number.isSafeInteger(value.offset) && value.offset! >= 0 ? value.offset! : 0
    }]
  })
}

export interface RemoteTerminalBindingsDependencies {
  /** Only settings are used, so this half is testable without the rest of the database. */
  settings: { getSetting(key: string): string | null; setSetting(key: string, value: string): void }
  /** Calls one method on a paired machine; the client already enforces pairing and identity. */
  call(machineId: string, method: string, args?: Args): Promise<unknown>
  /** Asks that machine's stream for this terminal's output from an offset. */
  subscribe(machineId: string, projectId: string, sessionId: string, terminalId: string, fromOffset: number): void
  unsubscribe(machineId: string, terminalId: string): void
  publish(channel: string, payload: unknown): void
  /** False while nothing can reach that machine, which is what makes a keystroke a dropped one. */
  connected?(machineId: string): boolean
}

/**
 * Binds local terminal ids to shells running on paired machines. Nothing here ever spawns a
 * process: `ensure` reports the binding and resubscribes, and every other call is forwarded.
 */
export class RemoteTerminalBindings {
  private readonly bindings = new Map<string, RemoteTerminalBindingRecord>()
  /** `${machineId}\0${remoteTerminalId}` → local id, so an incoming frame finds its pane. */
  private readonly remoteIndex = new Map<string, string>()
  private readonly decoders = new Map<string, StringDecoder>()
  /** Bytes advanced since the resume offset was last persisted, per binding. */
  private readonly unsaved = new Map<string, number>()
  /** One notice per disconnection, not one per keystroke. */
  private readonly warned = new Set<string>()

  constructor(private readonly deps: RemoteTerminalBindingsDependencies) {
    for (const binding of readTerminalBindings(this.deps.settings.getSetting(BINDINGS_SETTING) || undefined)) {
      this.bindings.set(binding.localTerminalId, binding)
      this.remoteIndex.set(this.remoteKey(binding), binding.localTerminalId)
    }
  }

  private remoteKey(binding: Pick<RemoteTerminalBindingRecord, 'machineId' | 'remoteTerminalId'>): string {
    return `${binding.machineId}\0${binding.remoteTerminalId}`
  }

  list(): RemoteTerminalBindingRecord[] { return [...this.bindings.values()].map(binding => ({ ...binding })) }

  get(localTerminalId: string): RemoteTerminalBindingRecord | undefined {
    const binding = this.bindings.get(localTerminalId)
    return binding ? { ...binding } : undefined
  }

  /** True means this id must never reach a local PTY, whatever the renderer asked for. */
  isRemote(localTerminalId: string): boolean {
    return this.bindings.has(localTerminalId)
  }

  private binding(localTerminalId: string): RemoteTerminalBindingRecord {
    const binding = this.bindings.get(localTerminalId)
    if (!binding) throw new Error('This terminal is not running on another machine.')
    return binding
  }

  private save(): void {
    this.deps.settings.setSetting(BINDINGS_SETTING, JSON.stringify([...this.bindings.values()]))
    this.unsaved.clear()
  }

  /** What that machine is running in a workspace, so a pane can reattach instead of opening another. */
  async remoteList(request: { machineId: string; projectId: string; sessionId: string }): Promise<RemoteTerminalSummary[]> {
    const raw = await this.deps.call(request.machineId, 'terminals.list', {
      projectId: request.projectId, sessionId: request.sessionId
    })
    return Array.isArray(raw) ? raw as RemoteTerminalSummary[] : []
  }

  /**
   * Opens a shell on that machine and binds a local id to it. `opId` is generated here and kept
   * for the life of the request, so a retry after a dropped reply reaches the same shell.
   */
  async open(request: {
    machineId: string
    projectId: string
    sessionId: string
    title?: string
    cols: number
    rows: number
    /** The ids on the host, when the local project and workspace are mirrors of different ids. */
    remoteProjectId?: string
    remoteSessionId?: string
    machineName?: string
    /** Supplied only when a caller is retrying an open it already started. */
    opId?: string
  }): Promise<RemoteTerminalBindingRecord> {
    const remoteProjectId = request.remoteProjectId ?? request.projectId
    const remoteSessionId = request.remoteSessionId ?? request.sessionId
    const raw = await this.deps.call(request.machineId, 'terminals.open', {
      projectId: remoteProjectId,
      sessionId: remoteSessionId,
      opId: request.opId ?? makeId('termop'),
      cols: request.cols,
      rows: request.rows,
      ...(request.title ? { title: request.title } : {})
    })
    const summary = raw as Partial<RemoteTerminalSummary> | null
    if (!summary || typeof summary.terminalId !== 'string' || !summary.terminalId) {
      throw new Error('That machine did not return a terminal.')
    }
    return this.bind({
      localTerminalId: makeId('terminal'),
      remoteTerminalId: summary.terminalId,
      machineId: request.machineId,
      machineName: request.machineName ?? request.machineId,
      projectId: request.projectId,
      sessionId: request.sessionId,
      remoteProjectId,
      remoteSessionId,
      offset: 0
    })
  }

  /** Binds a local id to a shell already running there, so the pane reattaches instead of starting one. */
  async attach(request: {
    machineId: string
    projectId: string
    sessionId: string
    remoteTerminalId: string
    remoteProjectId?: string
    remoteSessionId?: string
    machineName?: string
  }): Promise<RemoteTerminalBindingRecord> {
    const remoteProjectId = request.remoteProjectId ?? request.projectId
    const remoteSessionId = request.remoteSessionId ?? request.sessionId
    const existing = this.remoteIndex.get(`${request.machineId}\0${request.remoteTerminalId}`)
    if (existing) return { ...this.binding(existing) }
    const raw = await this.deps.call(request.machineId, 'terminals.attach', {
      projectId: remoteProjectId, sessionId: remoteSessionId, terminalId: request.remoteTerminalId, fromOffset: 0
    })
    const attachment = raw as Partial<RemoteTerminalAttachment> | null
    if (!attachment || attachment.terminalId !== request.remoteTerminalId) {
      throw new Error('That machine did not return the terminal that was asked for.')
    }
    return this.bind({
      localTerminalId: makeId('terminal'),
      remoteTerminalId: request.remoteTerminalId,
      machineId: request.machineId,
      machineName: request.machineName ?? request.machineId,
      projectId: request.projectId,
      sessionId: request.sessionId,
      remoteProjectId,
      remoteSessionId,
      // From the start: a view that has shown nothing yet wants the buffer, and the host reports
      // honestly whatever of it has already fallen out.
      offset: 0
    })
  }

  bind(binding: RemoteTerminalBindingRecord): RemoteTerminalBindingRecord {
    const stored = { ...binding, offset: Number.isSafeInteger(binding.offset) && binding.offset >= 0 ? binding.offset : 0 }
    this.bindings.set(stored.localTerminalId, stored)
    this.remoteIndex.set(this.remoteKey(stored), stored.localTerminalId)
    this.save()
    return { ...stored }
  }

  /**
   * Mounts the pane. It spawns nothing: the shell is the host's, already running, and all this
   * does is say so and ask the stream for output from where this machine stopped reading.
   */
  ensure(spec: TerminalSpec): RuntimeEnsureResult {
    const binding = this.binding(spec.id)
    this.deps.subscribe(binding.machineId, binding.remoteProjectId, binding.remoteSessionId, binding.remoteTerminalId, binding.offset)
    return {
      id: spec.id,
      available: true,
      status: 'running',
      // The transcript lives on the host; the stream replays it from `offset`, so sending a local
      // copy here would double what the pane shows.
      transcript: '',
      executable: `${binding.machineName} terminal`
    }
  }

  /**
   * Forwards keystrokes. They are never queued: what could not be sent while the machine was
   * unreachable is dropped and said so, because a buffer of keystrokes replayed into a shell
   * minutes later runs commands nobody is looking at.
   */
  write(localTerminalId: string, data: string): void {
    const binding = this.binding(localTerminalId)
    if (!data) return
    if (this.deps.connected && !this.deps.connected(binding.machineId)) { this.dropped(binding); return }
    const bytes = Buffer.from(data, 'utf8')
    for (let at = 0; at < bytes.length; at += TERMINAL_MAX_WRITE_BYTES) {
      const chunk = bytes.subarray(at, at + TERMINAL_MAX_WRITE_BYTES)
      void this.deps.call(binding.machineId, 'terminals.write', {
        projectId: binding.remoteProjectId,
        sessionId: binding.remoteSessionId,
        terminalId: binding.remoteTerminalId,
        data: chunk.toString('base64')
      }).then(() => { this.warned.delete(binding.localTerminalId) }, () => { this.dropped(binding) })
    }
  }

  private dropped(binding: RemoteTerminalBindingRecord): void {
    if (this.warned.has(binding.localTerminalId)) return
    this.warned.add(binding.localTerminalId)
    this.notice(binding, `Not connected to ${binding.machineName} — keystrokes were not sent.`)
  }

  /** A line Conductor itself is saying, inside the terminal the owner is looking at. */
  private notice(binding: RemoteTerminalBindingRecord, message: string): void {
    this.deps.publish('terminal:data', { id: binding.localTerminalId, data: `\r\n[Conductor] ${message}\r\n` })
  }

  resize(localTerminalId: string, cols: number, rows: number): void {
    const binding = this.bindings.get(localTerminalId)
    if (!binding || cols < 2 || rows < 1) return
    // A resize that does not arrive is the same nuisance as a local PTY that exited mid-gesture:
    // the next one corrects it, so it is not worth a notice in the owner's terminal.
    void this.deps.call(binding.machineId, 'terminals.resize', {
      projectId: binding.remoteProjectId, sessionId: binding.remoteSessionId,
      terminalId: binding.remoteTerminalId, cols: Math.floor(cols), rows: Math.floor(rows)
    }).catch(() => undefined)
  }

  /** Stops the shell on the host. This is the owner closing the work, not closing the view. */
  async kill(localTerminalId: string): Promise<void> {
    const binding = this.bindings.get(localTerminalId)
    if (!binding) return
    try {
      await this.deps.call(binding.machineId, 'terminals.close', {
        projectId: binding.remoteProjectId, sessionId: binding.remoteSessionId, terminalId: binding.remoteTerminalId
      })
    } finally {
      this.release(localTerminalId)
    }
  }

  /** Closes the view and keeps the shell: the other machine goes on running it. */
  release(localTerminalId: string): void {
    const binding = this.bindings.get(localTerminalId)
    if (!binding) return
    this.deps.unsubscribe(binding.machineId, binding.remoteTerminalId)
    this.bindings.delete(localTerminalId)
    this.remoteIndex.delete(this.remoteKey(binding))
    this.decoders.delete(localTerminalId)
    this.unsaved.delete(localTerminalId)
    this.warned.delete(localTerminalId)
    this.save()
  }

  /** Drops every view onto a machine the owner just forgot, revoked or went standalone from. */
  releaseMachine(machineId: string): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.machineId === machineId) this.release(binding.localTerminalId)
    }
  }

  /**
   * One streamed frame from a host, turned into what the panes already listen to. The local id is
   * substituted here so nothing downstream has to know the terminal is somewhere else.
   */
  onFrame(machineId: string, frame: StreamHostFrame): void {
    if (frame.type !== 'terminal.data' && frame.type !== 'terminal.gap' && frame.type !== 'terminal.exit') return
    const localTerminalId = this.remoteIndex.get(`${machineId}\0${frame.terminalId}`)
    if (!localTerminalId) return
    const binding = this.bindings.get(localTerminalId)
    if (!binding) return
    if (frame.type === 'terminal.exit') {
      this.deps.publish('terminal:status', { id: localTerminalId, status: 'exited', exitCode: frame.exitCode })
      return
    }
    if (frame.type === 'terminal.gap') {
      // Naming the byte count matters: it is the difference between "the shell said nothing" and
      // "this much of what it said is gone", and only one of those is worth re-running a command over.
      this.notice(binding, `${frame.lostBytes} bytes of output were dropped by ${binding.machineName} before this view caught up.`)
      binding.offset = Math.max(binding.offset, frame.offset)
      this.save()
      return
    }
    const bytes = Buffer.from(frame.data, 'base64')
    if (!bytes.length) return
    // An overlapping replay after a reconnect is normal, so bytes already shown are dropped rather
    // than printed twice; a forward jump is taken at its word, because inventing the middle would
    // be worse than the host's own gap notice.
    if (frame.offset + bytes.length <= binding.offset) return
    const fresh = bytes.subarray(Math.max(0, Math.min(bytes.length, binding.offset - frame.offset)))
    binding.offset = frame.offset + bytes.length
    const decoder = this.decoders.get(localTerminalId) ?? new StringDecoder('utf8')
    this.decoders.set(localTerminalId, decoder)
    const text = decoder.write(fresh)
    if (text) this.deps.publish('terminal:data', { id: localTerminalId, data: text })
    const unsaved = (this.unsaved.get(localTerminalId) ?? 0) + fresh.length
    // Persisting the resume offset on every frame would write the settings row for every keypress
    // echoed back; persisting never would resume a restarted app at a stale position.
    if (unsaved < PERSIST_EVERY_BYTES) this.unsaved.set(localTerminalId, unsaved)
    else this.save()
  }

  /** Writes the resume offsets out, for a shutdown that should not lose the last window of output. */
  flush(): void {
    if (this.unsaved.size) this.save()
  }
}
