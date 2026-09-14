/**
 * Contracts for reaching a paired machine that is not on this network.
 *
 * The direct HTTPS transport needs a route to the other machine, which two computers behind
 * separate NATs do not have. The relay gives them one without any Conductor server existing: both
 * machines are signed into the same GitHub account, so each one keeps a private gist that acts as
 * its outbox, and every message in it is sealed to the recipient's key before it is written. GitHub
 * stores ciphertext and routing ids and can read nothing else — the account is the rendezvous, not
 * a party to the conversation.
 *
 * Each machine writes only to the gist it owns, so two machines can never race on one file.
 */

/** Marks a gist as a Conductor mailbox. The owner sees it in their gist list under this name. */
export const RELAY_GIST_DESCRIPTION = 'Conductor remote control mailbox (encrypted)'
export const RELAY_DIRECTORY_FILE = 'machine.json'
export const RELAY_ACK_FILE = 'acks.json'

/** One sealed message is split across files this size, because GitHub truncates a gist file over
 *  1 MB in the API response and then only serves it from a separate raw URL. */
export const RELAY_CHUNK_BYTES = 384 * 1024
/** Matches the direct transport's own body limit, so neither transport accepts more than the other. */
export const RELAY_MAX_MESSAGE_BYTES = 3 * 1024 * 1024
/** A message nobody collects is dropped rather than left in the mailbox for ever. */
export const RELAY_MESSAGE_TTL_MS = 10 * 60_000
/** How long a delivered message id is remembered, so a replayed file cannot be processed twice. */
export const RELAY_SEEN_TTL_MS = 30 * 60_000
export const RELAY_POLL_ACTIVE_MS = 1500
export const RELAY_POLL_IDLE_MS = 15_000
export const RELAY_CALL_TIMEOUT_MS = 90_000
/**
 * The deadline for a call nobody is waiting on: a reachability probe the app starts by itself.
 *
 * An interactive call is worth waiting 90 seconds for, because a person asked for it and is holding
 * the answer open. A probe is not: nothing is blocked on it, and a machine that has not answered in
 * this long is exactly the "offline" the probe was asking about. Keeping it well under the
 * interactive deadline is what stops a probe from still occupying the relay when the next one
 * starts - see `MACHINE_PROBE_MS`, which is derived from this.
 */
export const RELAY_BACKGROUND_CALL_TIMEOUT_MS = 45_000
/**
 * How long a background call may hold the relay at its fast cadence.
 *
 * The 1.5 s cadence exists so a person waiting on an answer gets it promptly. A probe to a machine
 * that is not there would otherwise hold the whole loop there for the life of the call - and since
 * probes repeat, for ever - which is what turned an offline peer into thousands of GitHub requests
 * an hour. After this long with no traffic, a background call decays to the idle cadence; the
 * answer still arrives, one idle poll later.
 */
export const RELAY_BACKGROUND_ACTIVE_MS = 3_000

export type RelayMessageKind = 'request' | 'response'

/**
 * What a machine publishes about itself so the other one can seal a message to it. Everything here
 * is signed by the Ed25519 device key that GitHub lists for the account, so a tampered directory —
 * including one written by something that stole the gist scope — cannot redirect a message to a key
 * the owner never approved.
 */
export interface RelayDirectoryEntry {
  version: 1
  machineId: string
  machineName: string
  accountLogin: string
  /** OpenSSH ed25519 device key, the same one the direct transport authenticates with. */
  deviceKey: string
  /** Base64 raw X25519 public key; messages to this machine are sealed to it. */
  sealKey: string
  /** The machine's TLS certificate fingerprint, which its challenge signatures are bound to. */
  fingerprint: string
  updatedAt: string
  /** Ed25519 signature by `deviceKey` over the canonical form of every field above. */
  signature: string
}

/** One sealed chunk as it sits in a gist file. The tag covers the whole message, not the chunk. */
export interface RelayEnvelope {
  version: 1
  id: string
  from: string
  to: string
  kind: RelayMessageKind
  /** Which request a response answers; equal to `id` on a request. */
  correlationId: string
  index: number
  total: number
  /** Base64 ephemeral X25519 public key for this message. */
  ephemeralKey: string
  /** Base64 AES-256-GCM nonce. */
  nonce: string
  /** Base64 AES-256-GCM tag over the complete ciphertext. */
  tag: string
  /** Base64 slice of the ciphertext, `index` of `total`. */
  chunk: string
  createdAt: string
  /**
   * Base64 Ed25519 signature by the sender's device key over the routing fields and the seal
   * parameters. Sealing proves only that the writer knew the recipient's published key, which is
   * public; this is what proves who wrote the message. A message without one is refused.
   */
  senderSignature: string
}

/** The plaintext a sealed message carries: exactly what the direct transport puts on the wire. */
export interface RelayRequestBody {
  path: string
  headers: Record<string, string>
  /** Base64 of the raw request body, so signatures are verified over the identical bytes. */
  body: string
}

export interface RelayResponseBody {
  status: number
  /** Base64 of the raw response body. */
  body: string
}

export type RelayPhase = 'off' | 'unavailable' | 'connecting' | 'ready' | 'error'

export interface RelayStatus {
  phase: RelayPhase
  /** Machine ids whose mailbox this machine has found and can seal to. */
  reachable: string[]
  lastPollAt: string | null
  message: string | null
  /**
   * Which off-network route this machine is on: the relay the owner runs, or the private gist
   * mailbox that needs no server but lives inside GitHub's rate limit. The owner chooses by
   * configuring a relay or not, and the difference is worth showing rather than hiding.
   */
  route?: 'server' | 'github'
  /** The relay address in use, so "connected" can be read as "connected to the right one". */
  endpoint?: string | null
}

/** Machine and message ids are UUIDs, so a dash cannot separate the fields of a file name: the
 *  parse would be ambiguous and every message would be delivered to the wrong recipient or to
 *  nobody. A dot can, because no id may contain one — which is enforced here rather than assumed. */
const RELAY_NAME_FIELD = /^[A-Za-z0-9_-]{1,100}$/

export function relayFileName(envelope: Pick<RelayEnvelope, 'to' | 'id' | 'index'>): string {
  if (!RELAY_NAME_FIELD.test(envelope.to) || !RELAY_NAME_FIELD.test(envelope.id)) {
    throw new Error('A relay message can only be addressed with plain machine and message ids.')
  }
  return `m.${envelope.to}.${envelope.id}.${envelope.index}.json`
}

/** Every field of a gist file name is one this machine wrote, so the parse stays strict. */
export function parseRelayFileName(name: string): { to: string; id: string; index: number } | null {
  const match = /^m\.([A-Za-z0-9_-]{1,100})\.([A-Za-z0-9_-]{1,100})\.(\d{1,3})\.json$/.exec(name)
  return match ? { to: match[1]!, id: match[2]!, index: Number(match[3]) } : null
}
