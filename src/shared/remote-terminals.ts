/**
 * Terminals that run on a paired host and are driven from here.
 *
 * A terminal is a shell running as the host's user, and a machine allowed to open one is trusted
 * with everything that user can do - docs/multi-device.md says so in as many words. Within that
 * trust the rules are the same as for agents: the host owns the process, a controller only attaches
 * to it, closing the view is not stopping the shell, and a reconnect resumes the same shell from
 * the output offset it last saw instead of starting another. Keystrokes are never queued across a
 * lost connection: what could not be written while disconnected is dropped and said so.
 *
 * Host-side methods, all under the project grant like every other remote operation:
 *   terminals.list    ({projectId, sessionId})
 *   terminals.open    ({projectId, sessionId, opId, title?, cols, rows})   - opId makes a retry find the first one
 *   terminals.attach  ({projectId, sessionId, terminalId, fromOffset})
 *   terminals.write   ({projectId, sessionId, terminalId, data})            - data base64
 *   terminals.resize  ({projectId, sessionId, terminalId, cols, rows})
 *   terminals.close   ({projectId, sessionId, terminalId})
 */

/** Output kept per terminal for controllers that attach late or reconnect. */
export const TERMINAL_BUFFER_BYTES = 512 * 1024
export const TERMINAL_MAX_WRITE_BYTES = 64 * 1024

export interface RemoteTerminalSummary {
  terminalId: string
  /** The host's own tab for it, when the host's UI shows one. */
  tabId: string | null
  title: string
  cwd: string
  running: boolean
  exitCode: number | null
  /** Bytes of output produced so far; a controller attaching later asks from where it stopped. */
  offset: number
}

/** What `terminals.attach` returns: the buffer from the requested offset, or as much as is left. */
export interface RemoteTerminalAttachment {
  terminalId: string
  /** Where `data` starts. Greater than what was asked for when the buffer had already dropped earlier bytes. */
  offset: number
  /** Base64 of the buffered output from `offset`. */
  data: string
  /** Bytes between the requested offset and `offset` that the buffer no longer holds; 0 when nothing was lost. */
  lostBytes: number
  running: boolean
  exitCode: number | null
  cols: number
  rows: number
}

export interface RemoteTerminalBinding {
  localTerminalId: string
  remoteTerminalId: string
  machineId: string
  machineName: string
}

export interface RemoteTerminalsBridge {
  list(request: { machineId: string; projectId: string; sessionId: string }): Promise<RemoteTerminalSummary[]>
  /**
   * Opens a terminal on that machine and binds a local id to it. The pane then uses `localTerminalId`
   * with the ordinary terminal:* channels, which the main process routes to the host.
   */
  open(request: { machineId: string; projectId: string; sessionId: string; title?: string; cols: number; rows: number }): Promise<RemoteTerminalBinding>
  /** Binds a local id to a terminal already running there, so the pane reattaches instead of starting another shell. */
  attach(request: { machineId: string; projectId: string; sessionId: string; remoteTerminalId: string }): Promise<RemoteTerminalBinding>
}
