/**
 * The push channel between a controlling machine and a host: one WebSocket, opened by the
 * controller on the host's pinned HTTPS listener, over which the host says what changed.
 *
 * It carries notices, not state. A notice names the thing that changed and the cursor it reached;
 * the controller then fetches exactly what it is missing through the same signed RPC it would have
 * polled with. That keeps every transfer idempotent - the mirror already filters by sequence - and
 * makes the channel an accelerator rather than a second source of truth: if it drops, a slow poll
 * against the same cursors recovers everything, and nothing is lost by a frame that never arrived.
 *
 * Terminal output is the one thing streamed inline, because it has no other home: the host keeps a
 * bounded ring buffer per terminal with a byte offset, and a controller that reconnects asks from
 * the offset it last saw. What the buffer no longer holds is reported as a gap, never invented.
 *
 * The upgrade request is signed exactly like a call, with purpose 'stream' over an empty body, and
 * the host closes the socket the moment the peer's authority is revoked or its listener stops.
 */

export const REMOTE_STREAM_PATH = '/v1/stream'
export const REMOTE_STREAM_PROTOCOL = 1
/** One frame. A host that needs more than this has a bug, and a controller refuses anything larger. */
export const STREAM_MAX_FRAME_BYTES = 256 * 1024
/** The host pings at this cadence; either side that hears nothing for STREAM_TIMEOUT_MS closes. */
export const STREAM_HEARTBEAT_MS = 15_000
export const STREAM_TIMEOUT_MS = 45_000
/** Reconnect backoff: doubles from the first value, never past the second, with jitter on top. */
export const STREAM_RECONNECT_MIN_MS = 1_000
export const STREAM_RECONNECT_MAX_MS = 30_000
/** Frames a host will queue for one slow controller before it closes that connection instead. */
export const STREAM_MAX_QUEUED_FRAMES = 512
/** While the stream is open the mirror still polls, at this cadence, as the resync of last resort. */
export const STREAM_RESYNC_POLL_MS = 30_000

/** Controller → host. */
export type StreamClientFrame =
  | { type: 'hello'; protocol: number; machineId: string; generation: number }
  | { type: 'subscribe'; projectId: string; sessionId: string }
  | { type: 'unsubscribe'; projectId: string; sessionId: string }
  | { type: 'terminal.subscribe'; projectId: string; sessionId: string; terminalId: string; fromOffset: number }
  | { type: 'terminal.unsubscribe'; terminalId: string }

/** Host → controller. `data` is base64, because a PTY is bytes and not always valid UTF-8. */
export type StreamHostFrame =
  | { type: 'welcome'; protocol: number; machineId: string; machineName: string; generation: number }
  | { type: 'agents.changed'; projectId: string; sessionId: string; agentSessionId: string; sequence: number }
  | { type: 'tabs.changed'; projectId: string; sessionId: string }
  | { type: 'files.changed'; projectId: string; path: string }
  | { type: 'tasks.changed'; projectId: string }
  | { type: 'terminal.data'; terminalId: string; offset: number; data: string }
  | { type: 'terminal.gap'; terminalId: string; lostBytes: number; offset: number }
  | { type: 'terminal.exit'; terminalId: string; exitCode: number | null }
  | { type: 'revoked'; reason: string }
  | { type: 'error'; code: 'protocol' | 'authorization' | 'overloaded'; message: string }

export type StreamFrame = StreamClientFrame | StreamHostFrame

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A frame from the wire, or null when it is not one this protocol version knows. */
export function readStreamFrame(value: unknown): StreamFrame | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  return value as StreamFrame
}
