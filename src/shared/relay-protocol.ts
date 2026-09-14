/**
 * The contract between Conductor and its own relay server.
 *
 * The GitHub gist mailbox proved that a relay built out of somebody else's API is only as usable as
 * that API's rate limit: two machines idling cost polls, one unreachable machine cost thousands of
 * requests an hour, and the account's budget - not the owner's need - decided whether the machines
 * could be linked at all. This protocol replaces polling with a socket the owner runs: a message is
 * pushed the moment it is written, presence is a fact the server states rather than something a
 * probe has to discover, and nothing here is charged against anybody's quota.
 *
 * What the server is trusted with is deliberately small. It routes sealed envelopes by machine id
 * and remembers who is connected. It cannot read a message: confidentiality and sender authenticity
 * are decided in relay-crypto, exactly as they are on the gist route, so a relay that is hostile,
 * compromised or simply somebody else's is still only a router. What the room secret buys is that
 * strangers cannot connect to it, take up its memory, or watch the owner's machines meet.
 *
 * Both the app and the server import this file, so neither can drift from the other about what a
 * frame means or how large it may be.
 */

export const RELAY_PROTOCOL_VERSION = 1

export const RELAY_SOCKET_PATH = '/v1/socket'
export const RELAY_HEALTH_PATH = '/v1/health'

/**
 * A relayed message carries a base64 payload, so the frame is always larger than the 3 MiB the
 * direct transport accepts: 3 MiB of ciphertext is 4 MiB of base64 before the envelope's own
 * fields. The cap is what the server refuses to read at all, so it has to clear that with room.
 */
export const RELAY_MAX_FRAME_BYTES = 6 * 1024 * 1024
/** A socket that has not said who it is by then is closed, so an unauthenticated one costs little. */
export const RELAY_HANDSHAKE_DEADLINE_MS = 10_000
/** Nothing in the handshake is large, and a socket that has not authenticated may not make it so. */
export const RELAY_HANDSHAKE_MAX_BYTES = 16 * 1024
/** How stale a hello may be. The nonce is the real replay defence; this bounds how long a stolen
 *  one is worth stealing, and tolerates ordinary clock skew between two of the owner's machines. */
export const RELAY_HELLO_SKEW_MS = 5 * 60_000
export const RELAY_HEARTBEAT_MS = 25_000
/** A peer that has not answered a heartbeat by then is treated as gone rather than as connected. */
export const RELAY_HEARTBEAT_TIMEOUT_MS = 15_000

/**
 * How long the server holds a message for a machine that is not connected.
 *
 * Long enough that a peer reconnecting mid-call still gets the request, and no longer: the caller
 * gives up after RELAY_CALL_TIMEOUT_MS, and delivering a request whose answer nobody is waiting for
 * means running the owner's work late and unwatched. It also bounds what a disconnected machine can
 * make the server hold.
 */
export const RELAY_QUEUE_TTL_MS = 90_000
export const RELAY_QUEUE_MAX_MESSAGES = 16
export const RELAY_QUEUE_MAX_BYTES = 8 * 1024 * 1024

/** A directory entry is a handful of keys and names; anything larger is not one. */
export const RELAY_DIRECTORY_MAX_ENTRY_BYTES = 8 * 1024
/** One owner's machines. Reaching this is a sign the room secret has escaped, not ordinary use. */
export const RELAY_ROOM_MAX_MACHINES = 64

/**
 * Token bucket for one socket. It exists to stop a runaway loop, not to shape ordinary use, so it
 * is set well above what ordinary use costs: every mirrored tab polls its machine about once a
 * second and each poll is a request and an answer, so a dozen tabs on one machine is already tens
 * of messages a second before anybody types anything. A limit that normal work can reach is a limit
 * that turns into an error message for the owner rather than a defence against anything.
 */
export const RELAY_SEND_RATE_PER_SEC = 200
export const RELAY_SEND_BURST = 400

export type RelayErrorCode =
  | 'protocol'
  | 'unauthorized'
  | 'unknown-room'
  | 'room-full'
  | 'too-large'
  | 'rate-limited'
  | 'unknown-peer'
  | 'queue-full'
  | 'replaced'
  | 'shutting-down'

/** What one machine in the room looks like to the others. */
export interface RelayPresence {
  machineId: string
  online: boolean
  /** The signed entry that machine published about itself, or null before it has published one. */
  entry: unknown
  lastSeenAt: string
}

export interface RelayHelloFrame {
  t: 'hello'
  protocol: number
  roomId: string
  machineId: string
  machineName: string
  /** OpenSSH ed25519 device key; the socket is bound to it once `keyProof` checks out. */
  deviceKey: string
  /** The nonce the server issued on this socket, echoed back inside the signed statement. */
  nonce: string
  issuedAt: number
  /** Ed25519 signature over the canonical hello statement by the device key above. */
  keyProof: string
  /** HMAC-SHA256 of the same statement under the room secret, so strangers never get this far. */
  roomProof: string
}

export interface RelayPublishFrame { t: 'publish'; entry: unknown }
export interface RelaySendFrame { t: 'send'; ref: string; to: string; envelope: unknown }
export interface RelayPingFrame { t: 'ping'; ref: string }
export interface RelayPongFrame { t: 'pong'; ref: string }

export type RelayClientFrame = RelayHelloFrame | RelayPublishFrame | RelaySendFrame | RelayPingFrame | RelayPongFrame

export interface RelayChallengeFrame { t: 'challenge'; protocol: number; nonce: string; serverId: string }
export interface RelayWelcomeFrame {
  t: 'welcome'
  sessionId: string
  heartbeatMs: number
  maxMessageBytes: number
  /** HMAC over the hello statement under the room secret: the server proving it is the owner's. */
  serverProof: string
  presence: RelayPresence[]
}
export interface RelayPresenceFrame { t: 'presence'; presence: RelayPresence[] }
export interface RelayEnvelopeFrame { t: 'envelope'; envelope: unknown }
export interface RelayAcceptedFrame { t: 'accepted'; ref: string; delivery: 'online' | 'queued' }
export interface RelayRejectedFrame { t: 'rejected'; ref: string; code: RelayErrorCode; message: string }
export interface RelayErrorFrame { t: 'error'; code: RelayErrorCode; message: string }

export type RelayServerFrame =
  | RelayChallengeFrame | RelayWelcomeFrame | RelayPresenceFrame | RelayEnvelopeFrame
  | RelayAcceptedFrame | RelayRejectedFrame | RelayErrorFrame | RelayPingFrame | RelayPongFrame

/** Ids travel in frames and name queues and rooms; keeping them plain keeps every parse strict. */
export const RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/

/** The statement both proofs are made over. Every field a hello claims is inside it, so changing
 *  any of them - the room, the machine, the key, the moment - invalidates both proofs at once. */
export function relayHelloStatement(hello: {
  protocol: number
  roomId: string
  machineId: string
  machineName: string
  deviceKey: string
  nonce: string
  issuedAt: number
}): string {
  return [
    'conductor-relay-hello/1',
    String(hello.protocol),
    hello.roomId,
    hello.machineId,
    hello.machineName,
    hello.deviceKey.trim(),
    hello.nonce,
    String(hello.issuedAt)
  ].join('\n')
}

/** What the server answers with, so a client knows it reached the relay the owner set up and not
 *  something that merely accepted the connection. */
export function relayWelcomeStatement(helloStatement: string, sessionId: string): string {
  return ['conductor-relay-welcome/1', sessionId, helloStatement].join('\n')
}

/** The domain separator for the device-key signature, kept away from every other statement kind. */
export const RELAY_HELLO_STATEMENT_KIND = 'relay-hello'
