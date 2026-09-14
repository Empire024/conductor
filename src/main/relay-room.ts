import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { relayHelloStatement, relayWelcomeStatement } from '../shared/relay-protocol.ts'

/**
 * The room secret: one value the owner carries to every machine they want linked, and to the relay
 * server they run. It is what separates "the owner's machines" from "anything that can reach the
 * port", and it is deliberately the only membership rule the server has - no accounts, no database,
 * nothing to sign up for, and no third party whose quota decides whether the machines can meet.
 *
 * The secret itself never travels. A machine sends the room's public id, which is derived from the
 * secret and reveals nothing about it, and proves membership by keying an HMAC over the statement
 * it is already signing with its device key. The server answers with an HMAC of its own, so a relay
 * that does not hold the secret cannot even pretend to be the owner's.
 */

const ROOM_ID_LABEL = 'conductor-relay-room/1'

const secretKey = (secret: string): Buffer => {
  const trimmed = String(secret ?? '').trim()
  if (!trimmed) throw new Error('A relay room secret is required')
  return Buffer.from(trimmed, 'utf8')
}

/** A secret worth generating for the owner: 32 bytes, printed in the form they will paste. */
export function generateRoomSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** The public name of a room. Two machines derive the same one from the same secret without ever
 *  sending it, and the server can host several rooms without holding anything that identifies a
 *  person. */
export function roomIdFor(secret: string): string {
  return createHmac('sha256', secretKey(secret)).update(ROOM_ID_LABEL, 'utf8').digest('base64url')
}

export function roomProofFor(secret: string, statement: string): string {
  return createHmac('sha256', secretKey(secret)).update(statement, 'utf8').digest('base64')
}

export function welcomeProofFor(secret: string, helloStatement: string, sessionId: string): string {
  return roomProofFor(secret, relayWelcomeStatement(helloStatement, sessionId))
}

/** Constant-time, and false rather than a throw for anything that is not a proof at all. */
export function proofsMatch(a: string, b: string): boolean {
  let left: Buffer, right: Buffer
  try {
    left = Buffer.from(String(a ?? ''), 'base64')
    right = Buffer.from(String(b ?? ''), 'base64')
  } catch { return false }
  if (left.length !== right.length || left.length !== 32) return false
  return timingSafeEqual(left, right)
}

export { relayHelloStatement }
