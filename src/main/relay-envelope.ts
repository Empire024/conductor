import { RELAY_MAX_MESSAGE_BYTES, type RelayEnvelope } from '../shared/remote-relay'
import { sealMessage, signMessage, verifyMessageSignature, type RelayBinding } from './relay-crypto'
import { RemoteAccessError } from './remote-peers'

/**
 * The two rules a relayed message obeys no matter which relay carried it.
 *
 * Conductor now has two: a private gist, which needs nobody's server but lives inside GitHub's rate
 * limit, and the owner's own relay, which is a socket and does not. They are different transports
 * with the same security, and the way that stays true is that neither of them decides for itself who
 * is allowed to have written a message or how one is put together. Both ask here.
 */

export interface BuildEnvelopeOptions {
  /** PKCS#8 PEM of this machine's device key; it signs the routing binding, not just the payload. */
  privateKeyPem: string
  recipientSealKey: string
  binding: RelayBinding
  plaintext: Buffer
  /** Largest base64 slice one envelope may carry. A transport with no size limit passes Infinity. */
  chunkBytes: number
  now: number
}

/**
 * Seals a message to its recipient and splits it into as many envelopes as the transport needs.
 *
 * The seal proves only that the writer knew the recipient's published key, which is public, so the
 * sender's signature over the same binding is what proves who wrote it. Both cover the routing
 * fields, so a stored envelope cannot be re-addressed, relabelled as the answer to another call, or
 * replayed back in the other direction.
 */
export function buildEnvelopes(options: BuildEnvelopeOptions): RelayEnvelope[] {
  if (options.plaintext.length > RELAY_MAX_MESSAGE_BYTES) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
  const sealed = sealMessage(options.recipientSealKey, options.binding, options.plaintext)
  const senderSignature = signMessage(options.privateKeyPem, options.binding, sealed)
  const encoded = sealed.ciphertext.toString('base64')
  const size = Math.min(options.chunkBytes, Number.MAX_SAFE_INTEGER)
  const total = Math.max(1, Math.ceil(encoded.length / size))
  if (total > 64) throw new RemoteAccessError('Request exceeds 3 MiB.', 413)
  const createdAt = new Date(options.now).toISOString()
  const envelopes: RelayEnvelope[] = []
  for (let index = 0; index < total; index++) {
    envelopes.push({
      version: 1,
      id: options.binding.id,
      from: options.binding.from,
      to: options.binding.to,
      kind: options.binding.kind,
      correlationId: options.binding.correlationId,
      index,
      total,
      ephemeralKey: sealed.ephemeralKey,
      nonce: sealed.nonce,
      tag: sealed.tag,
      chunk: encoded.slice(index * size, (index + 1) * size),
      createdAt,
      senderSignature
    })
  }
  return envelopes
}

/** What this machine already has reason to trust about the sender of an arriving envelope. */
export interface SenderExpectation {
  /** For an answer: the machine and key the still-pending call was addressed to. */
  answeringPeer?: { machineId: string; deviceKey: string } | null
  /** For a request: the device key this machine has approved for that peer, if it has one. */
  knownPeerKey?: string | null
}

/**
 * Whether the machine an envelope names as its sender is the one that actually wrote it.
 *
 * Arriving sealed proves nothing about that, because the recipient's seal key is published: anything
 * that can write into the transport can seal to it. So an answer is accepted only from the device
 * key the call was addressed to, and a request from an established peer only from that peer's stored
 * key. The single envelope whose sender is not approved yet is a first pairing request, which the
 * request handler authenticates by its own challenge before anything happens.
 */
export function envelopeIsAuthentic(envelope: RelayEnvelope, binding: RelayBinding, expectation: SenderExpectation): boolean {
  if (envelope.kind === 'response') {
    const call = expectation.answeringPeer
    if (!call || call.machineId !== envelope.from) return false
    return verifyMessageSignature(call.deviceKey, binding, envelope, envelope.senderSignature)
  }
  const known = expectation.knownPeerKey ?? null
  return !known || verifyMessageSignature(known, binding, envelope, envelope.senderSignature)
}

/** The binding an envelope claims, which is also the associated data its seal is bound to. */
export const bindingOf = (envelope: RelayEnvelope): RelayBinding => ({
  from: envelope.from,
  to: envelope.to,
  id: envelope.id,
  kind: envelope.kind,
  correlationId: envelope.correlationId
})
