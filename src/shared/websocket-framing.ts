import { createHash, randomBytes } from 'node:crypto'

/**
 * RFC 6455 framing for both ends of Conductor's relay, written out rather than taken from a package.
 *
 * The relay is the one part of Conductor that faces the open internet with no window and nothing to
 * look at, so what it depends on is exactly what an attacker gets to reach. The frames Conductor
 * needs are a small fixed subset - text and binary messages, ping, pong and close, no extensions and
 * no compression - and they come to a few hundred lines of bit twiddling. That is a smaller thing to
 * be responsible for than a dependency tree, and it does not change under the app on a Node upgrade:
 * the runtime's own WebSocket client is not reliably present or working in every Electron and Node
 * build Conductor ships on, and a link between the owner's machines cannot be conditional on that.
 *
 * Bytes arrive masked or not, fragmented however the far end likes, and attacker-controlled, so the
 * decoder's job is to be unsurprising: it refuses a frame it does not understand instead of guessing,
 * and it counts bytes against the message limit as they arrive rather than after.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F'

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(String(key ?? '').trim() + WS_GUID, 'utf8').digest('base64')
}

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa
} as const

export interface DecodedMessage {
  kind: 'text' | 'binary'
  data: Buffer
}

export interface FrameHandlers {
  message(message: DecodedMessage): void
  ping(payload: Buffer): void
  pong(payload: Buffer): void
  close(code: number, reason: string): void
  /** A frame this server refuses to process at all; the socket is closed with this code. */
  fail(code: number, message: string): void
}

export const CLOSE_PROTOCOL_ERROR = 1002
export const CLOSE_TOO_LARGE = 1009
const MAX_CONTROL_PAYLOAD = 125
const MAX_HEADER_BYTES = 14

/** Encodes one unmasked server frame. A server must never mask, and nothing here ever does. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | (opcode & 0x0f)
  return Buffer.concat([header, payload])
}

/**
 * The client's side of the same frame. Masking is not secrecy - the key travels with the frame - it
 * is what stops a crafted payload from reading as a request to a proxy sitting in the middle, so a
 * client that does not mask is one every server is entitled to hang up on.
 */
export function encodeMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index++) masked[index] = masked[index]! ^ mask[index & 3]!
  const length = payload.length
  let prefix: Buffer
  if (length < 126) {
    prefix = Buffer.alloc(2)
    prefix[1] = 0x80 | length
  } else if (length < 65536) {
    prefix = Buffer.alloc(4)
    prefix[1] = 0x80 | 126
    prefix.writeUInt16BE(length, 2)
  } else {
    prefix = Buffer.alloc(10)
    prefix[1] = 0x80 | 127
    prefix.writeBigUInt64BE(BigInt(length), 2)
  }
  prefix[0] = 0x80 | (opcode & 0x0f)
  return Buffer.concat([prefix, mask, masked])
}

export const encodeText = (text: string): Buffer => encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'))
export const encodeMaskedText = (text: string): Buffer => encodeMaskedFrame(OPCODE.text, Buffer.from(text, 'utf8'))
export const encodeMaskedPong = (payload: Buffer): Buffer => encodeMaskedFrame(OPCODE.pong, payload)
export const encodeMaskedPing = (payload = Buffer.alloc(0)): Buffer => encodeMaskedFrame(OPCODE.ping, payload)

export function encodeMaskedClose(code: number, reason = ''): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL_PAYLOAD - 2)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeMaskedFrame(OPCODE.close, payload)
}
export const encodePing = (payload = Buffer.alloc(0)): Buffer => encodeFrame(OPCODE.ping, payload)
export const encodePong = (payload: Buffer): Buffer => encodeFrame(OPCODE.pong, payload)

export function encodeClose(code: number, reason = ''): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL_PAYLOAD - 2)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeFrame(OPCODE.close, payload)
}

/**
 * Turns a stream of TCP chunks into whole messages. One decoder belongs to one socket, and it stops
 * for good the first time that socket breaks the protocol - a connection that has already sent
 * something nonsensical does not get to keep being parsed.
 */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private available = 0
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private fragmentKind: 'text' | 'binary' | null = null
  private stopped = false

  private readonly maxMessageBytes: number
  /** A server reads masked frames and a client reads unmasked ones; each refuses the other. */
  private readonly requireMask: boolean
  private readonly handlers: FrameHandlers

  // Written out rather than declared in the parameter list: Node runs this file with type stripping
  // only, and a parameter property is syntax it refuses rather than erases.
  constructor(options: { maxMessageBytes: number; requireMask: boolean }, handlers: FrameHandlers) {
    this.maxMessageBytes = options.maxMessageBytes
    this.requireMask = options.requireMask
    this.handlers = handlers
  }

  stop(): void {
    this.stopped = true
    this.chunks = []
    this.available = 0
    this.fragments = []
    this.fragmentBytes = 0
    this.fragmentKind = null
  }

  push(chunk: Buffer): void {
    if (this.stopped) return
    this.chunks.push(chunk)
    this.available += chunk.length
    while (!this.stopped && this.parse()) { /* one frame per pass */ }
  }

  /** Copies the first bytes without consuming them, for reading a header. */
  private peek(length: number): Buffer {
    const wanted = Math.min(length, this.available)
    const first = this.chunks[0]
    if (first && first.length >= wanted) return first.subarray(0, wanted)
    const out = Buffer.alloc(wanted)
    let offset = 0
    for (const chunk of this.chunks) {
      if (offset >= wanted) break
      offset += chunk.copy(out, offset, 0, Math.min(chunk.length, wanted - offset))
    }
    return out
  }

  private consume(length: number): Buffer {
    const out = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const chunk = this.chunks[0]!
      const take = Math.min(chunk.length, length - offset)
      chunk.copy(out, offset, 0, take)
      offset += take
      if (take === chunk.length) this.chunks.shift()
      else this.chunks[0] = chunk.subarray(take)
    }
    this.available -= length
    return out
  }

  private fail(code: number, message: string): boolean {
    this.stop()
    this.handlers.fail(code, message)
    return false
  }

  private parse(): boolean {
    if (this.available < 2) return false
    const header = this.peek(MAX_HEADER_BYTES)
    const first = header[0]!
    const second = header[1]!
    const fin = (first & 0x80) !== 0
    if ((first & 0x70) !== 0) return this.fail(CLOSE_PROTOCOL_ERROR, 'Reserved bits are set')
    const opcode = first & 0x0f
    // A client masks every frame and a server masks none. Either mistake is a broken peer or
    // something speaking a different protocol at us, and the specification says to close either way.
    const masked = (second & 0x80) !== 0
    if (masked !== this.requireMask) {
      return this.fail(CLOSE_PROTOCOL_ERROR, this.requireMask ? 'Client frames must be masked' : 'Server frames must not be masked')
    }

    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (this.available < 4) return false
      length = header.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (this.available < 10) return false
      const big = header.readBigUInt64BE(2)
      if (big > BigInt(this.maxMessageBytes)) return this.fail(CLOSE_TOO_LARGE, 'Message is larger than this relay accepts')
      length = Number(big)
      offset = 10
    }

    const control = (opcode & 0x08) !== 0
    if (control) {
      if (!fin) return this.fail(CLOSE_PROTOCOL_ERROR, 'Control frames may not be fragmented')
      if (length > MAX_CONTROL_PAYLOAD) return this.fail(CLOSE_PROTOCOL_ERROR, 'Control frame is too large')
    } else if (length > this.maxMessageBytes || this.fragmentBytes + length > this.maxMessageBytes) {
      return this.fail(CLOSE_TOO_LARGE, 'Message is larger than this relay accepts')
    }

    const total = offset + (masked ? 4 : 0) + length
    if (this.available < total) return false
    const frame = this.consume(total)
    const payload = frame.subarray(offset + (masked ? 4 : 0))
    if (masked) {
      const mask = frame.subarray(offset, offset + 4)
      for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index & 3]!
    }

    if (control) {
      if (opcode === OPCODE.ping) this.handlers.ping(payload)
      else if (opcode === OPCODE.pong) this.handlers.pong(payload)
      else if (opcode === OPCODE.close) {
        this.stop()
        this.handlers.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1005, payload.subarray(2).toString('utf8'))
        return false
      } else return this.fail(CLOSE_PROTOCOL_ERROR, 'Unknown control opcode')
      return this.available > 0
    }

    if (opcode === OPCODE.text || opcode === OPCODE.binary) {
      if (this.fragmentKind) return this.fail(CLOSE_PROTOCOL_ERROR, 'A new message started before the last one finished')
      if (fin) {
        this.handlers.message({ kind: opcode === OPCODE.text ? 'text' : 'binary', data: payload })
        return this.available > 0
      }
      this.fragmentKind = opcode === OPCODE.text ? 'text' : 'binary'
      this.fragments = [payload]
      this.fragmentBytes = payload.length
      return this.available > 0
    }

    if (opcode === OPCODE.continuation) {
      if (!this.fragmentKind) return this.fail(CLOSE_PROTOCOL_ERROR, 'Continuation frame without a message')
      this.fragments.push(payload)
      this.fragmentBytes += payload.length
      if (!fin) return this.available > 0
      const kind = this.fragmentKind
      const data = Buffer.concat(this.fragments, this.fragmentBytes)
      this.fragments = []
      this.fragmentBytes = 0
      this.fragmentKind = null
      this.handlers.message({ kind, data })
      return this.available > 0
    }

    return this.fail(CLOSE_PROTOCOL_ERROR, 'Unknown opcode')
  }
}
