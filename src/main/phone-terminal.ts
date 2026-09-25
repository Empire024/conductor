import { makeId, type TerminalSpec } from '../shared/models'
import { LOCAL_MACHINE_ID } from '../shared/remote-control'
import { TERMINAL_MAX_WRITE_BYTES } from '../shared/remote-terminals'
import type { TerminalRuntime } from './remote-terminals'

/**
 * A shell on this machine, driven from the phone app.
 *
 * Nothing here spawns a process of its own: the shell is an ordinary TerminalManager terminal in
 * a project workspace, so the desktop's terminal list, transcript and Processes board see it like
 * any other. What this file adds is the phone's rules around it:
 *   - a terminal belongs to the phone and the unlocked session that opened it, and nothing else
 *     can write to it, stream it or close it;
 *   - opening one needs the code typed again (the listener checks it before calling open);
 *   - it is killed when that session locks (idle, backgrounded, code changed, lockout, revoke),
 *     after TERMINAL_IDLE_MS without a keystroke, and when the app quits;
 *   - each one leaves exactly one audit line, written when it ends: device, workspace, start,
 *     end, why it ended and how much was typed. Never what was typed.
 *
 * Only this machine (MAIN). A paired machine's shells go through RemoteTerminalBindings, whose
 * output reaches windows only; docs/phone-lock-and-terminal.md says why that stays out for now.
 */

export const PHONE_TERMINAL_IDLE_MS = 10 * 60_000
export const PHONE_TERMINALS_PER_DEVICE = 3
export const PHONE_TERMINALS_TOTAL = 6
/** Output replayed to a stream that attaches without an offset: the scrollback it starts with. */
export const PHONE_TERMINAL_REPLAY_BYTES = 256 * 1024
const SWEEP_MS = 15_000

export type PhoneTerminalRuntime = Pick<TerminalRuntime, 'ensure' | 'write' | 'resize' | 'kill' | 'attach' | 'running' | 'onOutput' | 'onExit' | 'summary'>

export interface PhoneTerminalWorkspace { cwd: string; projectName: string; workspaceName: string }

export interface PhoneTerminalDependencies {
  terminals: PhoneTerminalRuntime
  /** The folder a phone shell starts in, for a project that lives on this machine; null otherwise. */
  workspace(projectId: string, workspaceId: string): PhoneTerminalWorkspace | null
  machineName(): string
  /** The app log's audit line. */
  audit(line: string): void
  now?(): number
  idleMs?: number
}

export class PhoneTerminalError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** What a stream is told, in order; the listener turns these into SSE frames. */
export type PhoneTerminalEvent =
  | { type: 'data'; offset: number; data: string }
  | { type: 'gap'; offset: number; lostBytes: number }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'closed'; reason: string }

export interface PhoneTerminalSummary {
  terminalId: string
  machineId: string
  projectId: string
  workspaceId: string
  title: string
  cwd: string
  running: boolean
  startedAt: string
  offset: number
}

interface Owner { deviceId: string; deviceName: string; unlockSessionId: string | null }

interface Session extends Owner {
  terminalId: string
  projectId: string
  workspaceId: string
  label: string
  cwd: string
  title: string
  startedAt: number
  lastInputAt: number
  bytesIn: number
  streams: Set<(event: PhoneTerminalEvent) => void>
  offExit: () => void
}

const size = (value: unknown, minimum: number, fallback: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= 1000 ? value : fallback

export class PhoneTerminals {
  private sessions = new Map<string, Session>()
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: PhoneTerminalDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private idleMs(): number { return this.deps.idleMs ?? PHONE_TERMINAL_IDLE_MS }

  /**
   * Starts a shell in a workspace of a project on this machine. The caller has already checked the
   * phone is unlocked and that the code was typed again for this.
   */
  open(owner: Owner, input: { machineId?: unknown; projectId?: unknown; workspaceId?: unknown; cols?: unknown; rows?: unknown }): PhoneTerminalSummary {
    const machineId = input.machineId === undefined || input.machineId === null || input.machineId === '' ? LOCAL_MACHINE_ID : String(input.machineId)
    if (machineId !== LOCAL_MACHINE_ID) throw new PhoneTerminalError(`A phone terminal opens on ${this.deps.machineName()} only; a paired machine's shell is not reachable from the phone yet.`, 403)
    const projectId = typeof input.projectId === 'string' ? input.projectId : ''
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
    const workspace = projectId && workspaceId ? this.deps.workspace(projectId, workspaceId) : null
    if (!workspace) throw new PhoneTerminalError('Pick a project and workspace on this computer.', 404)
    const mine = [...this.sessions.values()].filter(session => session.deviceId === owner.deviceId)
    if (mine.length >= PHONE_TERMINALS_PER_DEVICE) throw new PhoneTerminalError(`This phone already has ${PHONE_TERMINALS_PER_DEVICE} terminals open; close one first.`, 429)
    if (this.sessions.size >= PHONE_TERMINALS_TOTAL) throw new PhoneTerminalError('Too many phone terminals are open on this computer.', 429)
    const title = `Phone · ${owner.deviceName}`.slice(0, 120)
    const spec: TerminalSpec = { id: makeId('terminal'), projectId, sessionId: workspaceId, title, cwd: workspace.cwd }
    const started = this.deps.terminals.ensure(spec, { cols: size(input.cols, 2, 80), rows: size(input.rows, 1, 24) })
    if (!started.available) throw new PhoneTerminalError(started.message || 'This computer could not start a shell.', 409)
    const at = this.now()
    const session: Session = {
      ...owner, terminalId: spec.id, projectId, workspaceId, cwd: workspace.cwd, title,
      label: `${workspace.projectName} / ${workspace.workspaceName}`,
      startedAt: at, lastInputAt: at, bytesIn: 0, streams: new Set(),
      offExit: () => undefined
    }
    session.offExit = this.deps.terminals.onExit(spec.id, exitCode => {
      this.emit(session, { type: 'exit', exitCode })
      this.finish(session, exitCode === null ? 'shell exited' : `shell exited with ${exitCode}`, false)
    })
    this.sessions.set(spec.id, session)
    this.startSweeper()
    return this.describe(session)
  }

  /** The terminal a request names, if it belongs to this phone's current unlocked session. */
  private owned(owner: Owner, terminalId: unknown): Session {
    const session = typeof terminalId === 'string' ? this.sessions.get(terminalId) : undefined
    // Another phone's terminal, or one opened under an earlier unlock, looks exactly like none.
    if (!session || session.deviceId !== owner.deviceId || session.unlockSessionId !== owner.unlockSessionId) throw new PhoneTerminalError('That terminal is not open.', 404)
    return session
  }

  list(owner: Owner): PhoneTerminalSummary[] {
    return [...this.sessions.values()].filter(session => session.deviceId === owner.deviceId && session.unlockSessionId === owner.unlockSessionId).map(session => this.describe(session))
  }

  write(owner: Owner, terminalId: unknown, data: unknown): { written: number } {
    const session = this.owned(owner, terminalId)
    if (typeof data !== 'string' || data.length > Math.ceil(TERMINAL_MAX_WRITE_BYTES / 3) * 4 + 8) throw new PhoneTerminalError(`A write is at most ${TERMINAL_MAX_WRITE_BYTES} bytes.`, 413)
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > TERMINAL_MAX_WRITE_BYTES) throw new PhoneTerminalError(`A write is at most ${TERMINAL_MAX_WRITE_BYTES} bytes.`, 413)
    if (!this.deps.terminals.running(session.terminalId)) throw new PhoneTerminalError('That shell has already stopped.', 409)
    this.deps.terminals.write(session.terminalId, bytes)
    session.lastInputAt = this.now()
    session.bytesIn += bytes.length
    return { written: bytes.length }
  }

  resize(owner: Owner, terminalId: unknown, cols: unknown, rows: unknown): { cols: number; rows: number } {
    const session = this.owned(owner, terminalId)
    const width = size(cols, 2, 0), height = size(rows, 1, 0)
    if (!width || !height) throw new PhoneTerminalError('Invalid terminal size.')
    this.deps.terminals.resize(session.terminalId, width, height)
    return { cols: width, rows: height }
  }

  close(owner: Owner, terminalId: unknown): { closed: true } {
    this.finish(this.owned(owner, terminalId), 'closed on the phone', true)
    return { closed: true }
  }

  /**
   * Feeds one stream: the buffered scrollback from `fromOffset` (or the last
   * PHONE_TERMINAL_REPLAY_BYTES), then live output. Replay and subscription happen in one
   * synchronous run so no chunk falls between them.
   */
  attach(owner: Owner, terminalId: unknown, fromOffset: unknown, send: (event: PhoneTerminalEvent) => void): () => void {
    const session = this.owned(owner, terminalId)
    const summary = this.deps.terminals.summary(session.terminalId)
    const end = summary?.offset ?? 0
    const requested = typeof fromOffset === 'number' && Number.isSafeInteger(fromOffset) && fromOffset >= 0 ? fromOffset : Math.max(0, end - PHONE_TERMINAL_REPLAY_BYTES)
    const attachment = this.deps.terminals.attach(session.terminalId, requested)
    if (!attachment) throw new PhoneTerminalError('That terminal is not open.', 404)
    if (attachment.lostBytes > 0 && typeof fromOffset === 'number') send({ type: 'gap', offset: attachment.offset, lostBytes: attachment.lostBytes })
    if (attachment.data) send({ type: 'data', offset: attachment.offset, data: attachment.data })
    if (!attachment.running) { send({ type: 'exit', exitCode: attachment.exitCode }); return () => undefined }
    const offOutput = this.deps.terminals.onOutput(session.terminalId, (offset, bytes) => send({ type: 'data', offset, data: bytes.toString('base64') }))
    session.streams.add(send)
    return () => { offOutput(); session.streams.delete(send) }
  }

  /** The unlocked session ended: every terminal it opened goes with it. */
  locked(deviceId: string, unlockSessionId: string | null): void {
    for (const session of [...this.sessions.values()]) {
      if (session.deviceId === deviceId && (unlockSessionId === null || session.unlockSessionId === unlockSessionId)) this.finish(session, 'phone locked', true)
    }
  }

  /** The phone was unpaired or revoked. */
  deviceRemoved(deviceId: string): void {
    for (const session of [...this.sessions.values()]) if (session.deviceId === deviceId) this.finish(session, 'phone unpaired', true)
  }

  sweep(): void {
    const at = this.now()
    for (const session of [...this.sessions.values()]) if (at - session.lastInputAt > this.idleMs()) this.finish(session, 'idle timeout', true)
  }

  count(): number { return this.sessions.size }

  dispose(reason = 'Conductor quit'): void {
    for (const session of [...this.sessions.values()]) this.finish(session, reason, true)
    this.stopSweeper()
  }

  private describe(session: Session): PhoneTerminalSummary {
    const summary = this.deps.terminals.summary(session.terminalId)
    return {
      terminalId: session.terminalId, machineId: LOCAL_MACHINE_ID, projectId: session.projectId, workspaceId: session.workspaceId,
      title: session.title, cwd: session.cwd, running: summary?.running ?? false,
      startedAt: new Date(session.startedAt).toISOString(), offset: summary?.offset ?? 0
    }
  }

  private emit(session: Session, event: PhoneTerminalEvent): void {
    for (const send of [...session.streams]) {
      try { send(event) } catch { session.streams.delete(send) }
    }
  }

  /** Ends a phone terminal exactly once: kills the shell if asked, tells streams, writes the audit line. */
  private finish(session: Session, reason: string, kill: boolean): void {
    if (!this.sessions.delete(session.terminalId)) return
    session.offExit()
    if (kill) {
      try { this.deps.terminals.kill(session.terminalId) } catch { /* already gone */ }
    }
    this.emit(session, { type: 'closed', reason })
    session.streams.clear()
    const end = this.now()
    this.deps.audit(
      `phone terminal: device "${session.deviceName}" (${session.deviceId}) on ${this.deps.machineName()} in ${session.label}; ` +
      `started ${new Date(session.startedAt).toISOString()}, ended ${new Date(end).toISOString()} (${Math.round((end - session.startedAt) / 1000)} s); ` +
      `${reason}; ${session.bytesIn} bytes typed`
    )
    if (!this.sessions.size) this.stopSweeper()
  }

  private startSweeper(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS)
    this.sweeper.unref?.()
  }

  private stopSweeper(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null }
  }
}
