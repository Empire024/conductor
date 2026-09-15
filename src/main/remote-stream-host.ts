import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { RemotePeerRecord } from '../shared/remote-control'
import {
  REMOTE_STREAM_PATH,
  REMOTE_STREAM_PROTOCOL,
  STREAM_HEARTBEAT_MS,
  STREAM_MAX_FRAME_BYTES,
  STREAM_MAX_QUEUED_FRAMES,
  STREAM_TIMEOUT_MS,
  readStreamFrame,
  type StreamClientFrame,
  type StreamHostFrame
} from '../shared/remote-stream'
import { CLOSE_PROTOCOL_ERROR, FrameDecoder, acceptKey, encodeClose, encodePing, encodePong, encodeText } from '../shared/websocket-framing'
import { refuseUpgrade, type RemoteControlServer } from './remote-control-server'
import { NONCE_HEADER, PEER_HEADER, RemoteAccessError, SIGNATURE_HEADER, TIMESTAMP_HEADER, type RemotePeers } from './remote-peers'

/**
 * The host's half of the push channel: one WebSocket per controlling machine, over the same pinned
 * HTTPS listener and behind the same signed challenge as a call.
 *
 * What it sends is deliberately thin. A notice says "this changed, up to here" and the controller
 * then fetches what it is missing over the RPC it would otherwise have polled with. That keeps the
 * socket an accelerator rather than a second source of truth: a frame that never arrives costs a
 * slower resync and nothing else, and no state on the controller depends on having seen every one.
 * Terminal bytes are the exception, because a PTY has no other home, and they carry an offset so a
 * reconnecting controller asks for exactly what it missed and is told honestly when the ring buffer
 * no longer holds it.
 *
 * Everything a peer may hear is scoped by the grant it was approved with, checked against the
 * *current* record on every subscription rather than the snapshot taken when the socket opened -
 * so revoking access closes the socket, and a project shared after the socket opened is usable
 * without making the owner reconnect anything.
 */

const CLOSE_NORMAL = 1000
const CLOSE_POLICY = 1008
/** The subscription key: a peer subscribes to one conversation inside one project, never a project. */
const subscriptionKey = (projectId: string, sessionId: string): string => `${projectId}\u0000${sessionId}`

export interface TerminalSubscription {
  peerId: string
  terminalId: string
  projectId: string
  sessionId: string
  /** Where in the host's ring buffer this controller wants the stream to resume. */
  fromOffset: number
}

export interface RemoteStreamHostDependencies {
  peers: RemotePeers
  machineName(): string
  /** The certificate this listener serves; every challenge is signed against it. */
  fingerprint(): string
  /** This machine's own attachment generation, carried in `welcome` so a stale reply is visible. */
  generation?(): number
  now?(): number
  /** Injected so tests drive the heartbeat instead of waiting on a timer. */
  schedule?(run: () => void, ms: number): { cancel(): void }
}

interface StreamSession {
  id: string
  peerId: string
  socket: Socket
  decoder: FrameDecoder
  greeted: boolean
  closed: boolean
  lastHeardAt: number
  /**
   * Frames written while the socket refused more. A notice is idempotent and carries its own
   * high-water mark, so a newer one for the same key replaces an older one instead of queueing
   * behind it; terminal bytes carry no key and are never collapsed, because dropping one would
   * put a hole in the transcript rather than delay a refresh.
   */
  queue: Array<{ key: string | null; payload: Buffer }>
  writable: boolean
  subscriptions: Map<string, { projectId: string; sessionId: string }>
  terminals: Map<string, { projectId: string; sessionId: string }>
}

export class RemoteStreamHost {
  private readonly sessions = new Map<string, StreamSession>()
  private readonly terminalSubscribed = new Set<(subscription: TerminalSubscription) => void>()
  private readonly terminalUnsubscribed = new Set<(subscription: { peerId: string; terminalId: string }) => void>()
  private heartbeat: { cancel(): void } | null = null
  private detach: (() => void) | null = null

  constructor(private readonly deps: RemoteStreamHostDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Serves /v1/stream on the pinned listener. The server has already refused browsers by here. */
  listenOn(server: RemoteControlServer): void {
    this.detach?.()
    this.detach = server.onUpgrade(REMOTE_STREAM_PATH, (request, socket, head) => { void this.accept(request, socket, head) })
  }

  /** How many controllers are attached, which is what the diagnostics view reports. */
  get openSessions(): number { return this.sessions.size }

  onTerminalSubscribe(listener: (subscription: TerminalSubscription) => void): () => void {
    this.terminalSubscribed.add(listener)
    return () => { this.terminalSubscribed.delete(listener) }
  }

  onTerminalUnsubscribe(listener: (subscription: { peerId: string; terminalId: string }) => void): () => void {
    this.terminalUnsubscribed.add(listener)
    return () => { this.terminalUnsubscribed.delete(listener) }
  }

  private async accept(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const header = (name: string): string => {
      const value = request.headers[name]
      return typeof value === 'string' ? value : ''
    }
    let peer: RemotePeerRecord
    try {
      // The same authority a call goes through, with 'stream' inside the signed bytes: a signature
      // captured from an ordinary call cannot open this, and one made for this cannot make a call.
      const authenticated = await this.deps.peers.authenticate({
        peerId: header(PEER_HEADER),
        nonce: header(NONCE_HEADER),
        timestamp: Number(header(TIMESTAMP_HEADER)),
        signature: header(SIGNATURE_HEADER),
        body: Buffer.alloc(0),
        fingerprint: this.deps.fingerprint(),
        purpose: 'stream'
      })
      peer = authenticated.peer
    } catch (error) {
      // Only 401 and 403 mean "this pairing is over"; the controller stops reconnecting on those
      // and on nothing else. A nonce flood, a GitHub outage or a malformed header is temporary, so
      // it goes back as 503 rather than being mistaken for a revocation that needs re-pairing.
      const status = error instanceof RemoteAccessError ? error.status : 401
      return refuseUpgrade(socket, status === 403 ? 403 : status === 401 ? 401 : 503, error instanceof Error ? error.message : 'Unauthorized')
    }
    // Authenticating crosses GitHub, which takes as long as it takes. The owner may have closed
    // the lid in the meantime, and writing 101 to a dead socket would leave a session nobody holds.
    if (socket.destroyed || !socket.writable) { socket.destroy(); return }
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') return refuseUpgrade(socket, 400, 'Bad Request')

    socket.setNoDelay(true)
    socket.setTimeout(0)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )

    const session: StreamSession = {
      id: randomUUID(),
      peerId: peer.id,
      socket,
      decoder: null as unknown as FrameDecoder,
      greeted: false,
      closed: false,
      lastHeardAt: this.now(),
      queue: [],
      writable: true,
      subscriptions: new Map(),
      terminals: new Map()
    }
    session.decoder = new FrameDecoder({ maxMessageBytes: STREAM_MAX_FRAME_BYTES, requireMask: true }, {
      message: message => {
        session.lastHeardAt = this.now()
        if (message.kind !== 'text') return this.fail(session, 'protocol', 'This channel carries JSON frames only.')
        this.onFrame(session, message.data)
      },
      ping: payload => { session.lastHeardAt = this.now(); this.write(session, { key: null, payload: encodePong(payload) }) },
      pong: () => { session.lastHeardAt = this.now() },
      close: () => this.shutdown(session, CLOSE_NORMAL, ''),
      fail: (code, message) => this.shutdown(session, code, message)
    })
    this.sessions.set(session.id, session)
    socket.on('data', chunk => session.decoder.push(chunk as Buffer))
    socket.on('drain', () => this.drain(session))
    socket.on('error', () => this.shutdown(session, CLOSE_NORMAL, ''))
    socket.on('close', () => this.shutdown(session, CLOSE_NORMAL, ''))

    this.send(session, {
      type: 'welcome',
      protocol: REMOTE_STREAM_PROTOCOL,
      machineId: this.deps.peers.machineId,
      machineName: this.deps.machineName(),
      generation: this.deps.generation?.() ?? 0
    }, null)
    this.startHeartbeat()
    if (head?.length) session.decoder.push(head)
  }

  private onFrame(session: StreamSession, data: Buffer): void {
    let parsed: unknown
    try { parsed = JSON.parse(data.toString('utf8')) }
    catch { return this.fail(session, 'protocol', 'That was not a stream frame.') }
    const frame = readStreamFrame(parsed) as StreamClientFrame | null
    if (!frame) return this.fail(session, 'protocol', 'That was not a stream frame.')
    if (frame.type === 'hello') {
      if (frame.protocol !== REMOTE_STREAM_PROTOCOL) {
        return this.fail(session, 'protocol', `This machine speaks stream protocol ${REMOTE_STREAM_PROTOCOL}, not ${frame.protocol}. Update both computers to the same version.`)
      }
      session.greeted = true
      return
    }
    // Everything after hello names a project, and naming one before saying who you are is a client
    // that is out of step rather than one this machine should start answering.
    if (!session.greeted) return this.fail(session, 'protocol', 'Say hello before subscribing to anything.')
    try {
      if (frame.type === 'subscribe') return this.subscribe(session, frame.projectId, frame.sessionId)
      if (frame.type === 'unsubscribe') {
        session.subscriptions.delete(subscriptionKey(String(frame.projectId), String(frame.sessionId)))
        return
      }
      if (frame.type === 'terminal.subscribe') return this.terminalSubscribe(session, frame)
      if (frame.type === 'terminal.unsubscribe') return this.terminalUnsubscribe(session, String(frame.terminalId))
    } catch (error) {
      // A refused subscription is not a broken connection: the peer may legitimately ask about a
      // project that has since been unshared, and the rest of what it is watching still works.
      const authorization = error instanceof RemoteAccessError && (error.status === 401 || error.status === 403)
      this.send(session, {
        type: 'error',
        code: authorization ? 'authorization' : 'protocol',
        message: error instanceof Error ? error.message.slice(0, 300) : 'That subscription was refused.'
      }, null)
      return
    }
    this.fail(session, 'protocol', 'This machine does not know that stream frame.')
  }

  /**
   * The current record, not the snapshot taken when the socket opened. Revocation has to bite on a
   * long-lived connection, and a project the owner shared a minute ago has to be usable on one.
   */
  private currentPeer(session: StreamSession): RemotePeerRecord {
    const peer = this.deps.peers.listPeers().find(entry => entry.id === session.peerId)
    if (!peer || peer.revokedAt) throw new RemoteAccessError('Access for this machine was revoked.', 403, 'peer-revoked')
    return peer
  }

  private subscribe(session: StreamSession, projectId: unknown, sessionId: unknown): void {
    const peer = this.currentPeer(session)
    const project = this.deps.peers.requireProject(peer, projectId)
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new RemoteAccessError('Name a conversation for this subscription.', 400)
    if (session.subscriptions.size >= 200) throw new RemoteAccessError('That is more conversations than one connection may watch.', 429)
    session.subscriptions.set(subscriptionKey(project.id, sessionId), { projectId: project.id, sessionId })
  }

  private terminalSubscribe(session: StreamSession, frame: Extract<StreamClientFrame, { type: 'terminal.subscribe' }>): void {
    const peer = this.currentPeer(session)
    const project = this.deps.peers.requireProject(peer, frame.projectId)
    const terminalId = String(frame.terminalId ?? '')
    if (!terminalId || terminalId.length > 200) throw new RemoteAccessError('Name a terminal for this subscription.', 400)
    if (session.terminals.size >= 64) throw new RemoteAccessError('That is more terminals than one connection may watch.', 429)
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId.slice(0, 200) : ''
    const fromOffset = Number.isSafeInteger(frame.fromOffset) && frame.fromOffset >= 0 ? frame.fromOffset : 0
    session.terminals.set(terminalId, { projectId: project.id, sessionId })
    for (const listener of this.terminalSubscribed) {
      try { listener({ peerId: session.peerId, terminalId, projectId: project.id, sessionId, fromOffset }) }
      catch (error) { console.warn('Terminal subscribe listener failed', error) }
    }
  }

  private terminalUnsubscribe(session: StreamSession, terminalId: string): void {
    if (!session.terminals.delete(terminalId)) return
    for (const listener of this.terminalUnsubscribed) {
      try { listener({ peerId: session.peerId, terminalId }) }
      catch (error) { console.warn('Terminal unsubscribe listener failed', error) }
    }
  }

  // ---- what the rest of the app pushes in -------------------------------------------------

  notifyAgents(projectId: string, sessionId: string, agentSessionId: string, sequence: number): void {
    this.toSubscribers(projectId, sessionId, { type: 'agents.changed', projectId, sessionId, agentSessionId, sequence },
      `agents\u0000${projectId}\u0000${sessionId}\u0000${agentSessionId}`)
  }

  notifyTabs(projectId: string, sessionId: string): void {
    this.toSubscribers(projectId, sessionId, { type: 'tabs.changed', projectId, sessionId }, `tabs\u0000${projectId}\u0000${sessionId}`)
  }

  notifyFiles(projectId: string, path: string): void {
    this.toProject(projectId, { type: 'files.changed', projectId, path }, `files\u0000${projectId}\u0000${path}`)
  }

  notifyTasks(projectId: string): void {
    this.toProject(projectId, { type: 'tasks.changed', projectId }, `tasks\u0000${projectId}`)
  }

  /** Bytes from a PTY, already base64, already inside one frame's worth by the caller's chunking. */
  terminalData(terminalId: string, offset: number, data: string): void {
    this.toTerminal(terminalId, { type: 'terminal.data', terminalId, offset, data })
  }

  terminalGap(terminalId: string, lostBytes: number, offset: number): void {
    this.toTerminal(terminalId, { type: 'terminal.gap', terminalId, lostBytes, offset })
  }

  terminalExit(terminalId: string, exitCode: number | null): void {
    this.toTerminal(terminalId, { type: 'terminal.exit', terminalId, exitCode })
  }

  private toSubscribers(projectId: string, sessionId: string, frame: StreamHostFrame, key: string): void {
    const wanted = subscriptionKey(projectId, sessionId)
    for (const session of [...this.sessions.values()]) if (session.subscriptions.has(wanted)) this.send(session, frame, key)
  }

  private toProject(projectId: string, frame: StreamHostFrame, key: string): void {
    for (const session of [...this.sessions.values()]) {
      for (const entry of session.subscriptions.values()) {
        if (entry.projectId !== projectId) continue
        this.send(session, frame, key)
        break
      }
    }
  }

  private toTerminal(terminalId: string, frame: StreamHostFrame): void {
    // No key: terminal output is the one thing on this channel that cannot be coalesced, because
    // the controller reassembles it by offset and a collapsed frame is a hole in the transcript.
    for (const session of [...this.sessions.values()]) if (session.terminals.has(terminalId)) this.send(session, frame, null)
  }

  /** Closes every socket a peer holds, now. This is what makes revocation immediate rather than eventual. */
  /** Peers with a live, greeted stream right now - the ones a quit would actually cut off. */
  connectedPeers(): string[] {
    return [...new Set([...this.sessions.values()].filter(session => session.greeted && !session.closed).map(session => session.peerId))]
  }

  closePeer(peerId: string, reason: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.peerId !== peerId) continue
      this.send(session, { type: 'revoked', reason: reason.slice(0, 300) }, null)
      this.shutdown(session, CLOSE_POLICY, reason.slice(0, 100))
    }
  }

  // ---- socket plumbing --------------------------------------------------------------------

  private send(session: StreamSession, frame: StreamHostFrame, key: string | null): void {
    if (session.closed) return
    const payload = encodeText(JSON.stringify(frame))
    if (payload.length > STREAM_MAX_FRAME_BYTES) {
      // A frame this machine cannot send is this machine's bug, not the controller's problem. The
      // notice is dropped rather than truncated: a truncated one would be read as a real cursor.
      console.warn(`Refusing to send a ${payload.length} byte stream frame of type ${frame.type}`)
      return
    }
    this.write(session, { key, payload })
  }

  private write(session: StreamSession, entry: { key: string | null; payload: Buffer }): void {
    if (session.closed || session.socket.destroyed) return
    if (session.writable && !session.queue.length) {
      session.writable = session.socket.write(entry.payload)
      return
    }
    if (entry.key !== null) {
      const existing = session.queue.findIndex(queued => queued.key === entry.key)
      if (existing >= 0) { session.queue[existing] = entry; return }
    }
    session.queue.push(entry)
    if (session.queue.length > STREAM_MAX_QUEUED_FRAMES) {
      // A controller this far behind is not going to catch up by being sent more. Saying so and
      // closing gives it a clean reconnect, which resyncs from cursors; growing the queue instead
      // would trade the host's memory for a channel that is already useless.
      session.queue = []
      this.fail(session, 'overloaded', 'This connection fell too far behind to keep up. Reconnect to resync.')
    }
  }

  private drain(session: StreamSession): void {
    session.writable = true
    while (session.writable && session.queue.length) {
      const entry = session.queue.shift()!
      session.writable = session.socket.write(entry.payload)
    }
  }

  private fail(session: StreamSession, code: 'protocol' | 'authorization' | 'overloaded', message: string): void {
    if (session.closed) return
    // Straight to the socket: the queue is exactly what is wrong in the overloaded case.
    if (!session.socket.destroyed) {
      try { session.socket.write(encodeText(JSON.stringify({ type: 'error', code, message } satisfies StreamHostFrame))) }
      catch { /* the socket is on its way out, which is where this was going anyway */ }
    }
    this.shutdown(session, code === 'protocol' ? CLOSE_PROTOCOL_ERROR : CLOSE_POLICY, message.slice(0, 100))
  }

  private shutdown(session: StreamSession, code: number, reason: string): void {
    if (session.closed) return
    session.closed = true
    session.queue = []
    session.decoder.stop()
    this.sessions.delete(session.id)
    for (const terminalId of [...session.terminals.keys()]) this.terminalUnsubscribe(session, terminalId)
    try {
      if (!session.socket.destroyed) {
        session.socket.write(encodeClose(code, reason))
        session.socket.end()
      }
    } catch { /* already gone, which is the outcome */ }
    session.socket.destroy()
    if (!this.sessions.size) { this.heartbeat?.cancel(); this.heartbeat = null }
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    const schedule = this.deps.schedule ?? ((run, ms) => {
      const handle = setInterval(run, ms)
      // A heartbeat is not a reason for the app to stay alive after the owner has closed it.
      handle.unref?.()
      return { cancel: () => clearInterval(handle) }
    })
    this.heartbeat = schedule(() => this.beat(), STREAM_HEARTBEAT_MS)
  }

  /** One tick: hang up on anyone who has gone silent, ping everyone who has not. */
  private beat(): void {
    const now = this.now()
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastHeardAt >= STREAM_TIMEOUT_MS) {
        this.shutdown(session, CLOSE_POLICY, 'This connection went silent.')
        continue
      }
      this.write(session, { key: null, payload: encodePing() })
    }
  }

  stop(): void {
    this.detach?.()
    this.detach = null
    for (const session of [...this.sessions.values()]) this.shutdown(session, CLOSE_NORMAL, 'This machine stopped serving.')
    this.heartbeat?.cancel()
    this.heartbeat = null
  }
}
