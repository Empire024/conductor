import { describe, expect, it } from 'vitest'
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_TOO_LARGE,
  FrameDecoder,
  OPCODE,
  acceptKey,
  encodeFrame,
  encodeMaskedFrame,
  encodeMaskedText,
  encodeText
} from './websocket-framing'

/**
 * The framing is written out here rather than taken from a package, so it is tested like a protocol
 * implementation and not like a helper: every rule it is allowed to enforce, and every rule it must
 * refuse, driven by bytes rather than by calling its own encoder and trusting the result.
 */

interface Captured {
  messages: Array<{ kind: string; text: string }>
  pings: Buffer[]
  pongs: Buffer[]
  closed: Array<{ code: number; reason: string }>
  failures: Array<{ code: number; message: string }>
}

const decoder = (options: { maxMessageBytes?: number; requireMask?: boolean } = {}): { decoder: FrameDecoder; seen: Captured } => {
  const seen: Captured = { messages: [], pings: [], pongs: [], closed: [], failures: [] }
  return {
    seen,
    decoder: new FrameDecoder({ maxMessageBytes: options.maxMessageBytes ?? 1024, requireMask: options.requireMask ?? true }, {
      message: message => seen.messages.push({ kind: message.kind, text: message.data.toString('utf8') }),
      ping: payload => seen.pings.push(payload),
      pong: payload => seen.pongs.push(payload),
      close: (code, reason) => seen.closed.push({ code, reason }),
      fail: (code, message) => seen.failures.push({ code, message })
    })
  }
}

/** A masked client frame with the FIN bit under the test's control, for fragmentation. */
const clientFrame = (opcode: number, payload: Buffer, fin = true): Buffer => {
  const frame = encodeMaskedFrame(opcode, payload)
  if (!fin) frame[0] = frame[0]! & 0x7f
  return frame
}

describe('websocket framing', () => {
  it('computes the accept key the specification requires', () => {
    // Cross-checked against OpenSSL rather than against this implementation, since a hand-written
    // handshake that only agrees with itself would interoperate with nothing:
    //   printf '%s' 'dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-5AB0DC85B11F' | openssl sha1 -binary | openssl base64
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('tF+4yo8PvjWV9zMFht911yVrKKY=')
    expect(acceptKey('x3JJHMbDL1EzLkh9GBhXDw==')).toBe('NehNes/zC1C01D7vDzNM9XwJGTo=')
    // The key is what it answers, so two connections never get the same one.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).not.toBe(acceptKey('x3JJHMbDL1EzLkh9GBhXDw=='))
  })

  it('reads a masked message that arrives in one piece and one that arrives a byte at a time', () => {
    const whole = decoder()
    whole.decoder.push(encodeMaskedText('hello relay'))
    expect(whole.seen.messages).toEqual([{ kind: 'text', text: 'hello relay' }])

    const dribbled = decoder()
    const frame = encodeMaskedText('hello relay')
    for (const byte of frame) dribbled.decoder.push(Buffer.from([byte]))
    expect(dribbled.seen.messages).toEqual([{ kind: 'text', text: 'hello relay' }])
  })

  it('reassembles a fragmented message and answers a ping that arrives in the middle of it', () => {
    const { decoder: read, seen } = decoder()
    read.push(clientFrame(OPCODE.text, Buffer.from('first '), false))
    read.push(clientFrame(OPCODE.ping, Buffer.from('are you there')))
    read.push(clientFrame(OPCODE.continuation, Buffer.from('second'), false))
    expect(seen.messages).toEqual([])
    read.push(clientFrame(OPCODE.continuation, Buffer.from(' third')))
    expect(seen.messages).toEqual([{ kind: 'text', text: 'first second third' }])
    expect(seen.pings.map(payload => payload.toString('utf8'))).toEqual(['are you there'])
  })

  it('reads the two longer length forms', () => {
    const medium = decoder({ maxMessageBytes: 200_000 })
    medium.decoder.push(encodeMaskedText('m'.repeat(1000)))
    expect(medium.seen.messages[0]?.text.length).toBe(1000)

    const large = decoder({ maxMessageBytes: 200_000 })
    large.decoder.push(encodeMaskedText('l'.repeat(70_000)))
    expect(large.seen.messages[0]?.text.length).toBe(70_000)
  })

  it('refuses an unmasked frame from a client and a masked frame from a server', () => {
    const server = decoder({ requireMask: true })
    server.decoder.push(encodeText('unmasked'))
    expect(server.seen.failures).toEqual([{ code: CLOSE_PROTOCOL_ERROR, message: 'Client frames must be masked' }])
    expect(server.seen.messages).toEqual([])

    const client = decoder({ requireMask: false })
    client.decoder.push(encodeMaskedText('masked'))
    expect(client.seen.failures).toEqual([{ code: CLOSE_PROTOCOL_ERROR, message: 'Server frames must not be masked' }])
  })

  it('refuses reserved bits, an unknown opcode, and a fragmented or oversized control frame', () => {
    const reserved = decoder()
    const withRsv = encodeMaskedText('x')
    withRsv[0] = withRsv[0]! | 0x40
    reserved.decoder.push(withRsv)
    expect(reserved.seen.failures[0]?.message).toBe('Reserved bits are set')

    const unknown = decoder()
    unknown.decoder.push(clientFrame(0x3, Buffer.from('x')))
    expect(unknown.seen.failures[0]?.message).toBe('Unknown opcode')

    const split = decoder()
    split.decoder.push(clientFrame(OPCODE.ping, Buffer.from('x'), false))
    expect(split.seen.failures[0]?.message).toBe('Control frames may not be fragmented')

    const fat = decoder()
    fat.decoder.push(clientFrame(OPCODE.ping, Buffer.alloc(126)))
    expect(fat.seen.failures[0]?.message).toBe('Control frame is too large')
  })

  it('refuses a message larger than it accepts, whichever length form claims it', () => {
    const single = decoder({ maxMessageBytes: 100 })
    single.decoder.push(encodeMaskedText('x'.repeat(200)))
    expect(single.seen.failures).toEqual([{ code: CLOSE_TOO_LARGE, message: 'Message is larger than this relay accepts' }])

    // A 64-bit length is refused on the header alone, before the payload is read or allocated.
    const claimed = decoder({ maxMessageBytes: 100 })
    const header = Buffer.alloc(14)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(5_000_000_000), 2)
    claimed.decoder.push(header)
    expect(claimed.seen.failures).toEqual([{ code: CLOSE_TOO_LARGE, message: 'Message is larger than this relay accepts' }])

    // And so is a fragmented message that only exceeds the limit once its parts are added up.
    const growing = decoder({ maxMessageBytes: 100 })
    growing.decoder.push(clientFrame(OPCODE.text, Buffer.alloc(80), false))
    growing.decoder.push(clientFrame(OPCODE.continuation, Buffer.alloc(80)))
    expect(growing.seen.failures[0]?.code).toBe(CLOSE_TOO_LARGE)
    expect(growing.seen.messages).toEqual([])
  })

  it('refuses a continuation with nothing to continue, and a second message before the first ended', () => {
    const orphan = decoder()
    orphan.decoder.push(clientFrame(OPCODE.continuation, Buffer.from('x')))
    expect(orphan.seen.failures[0]?.message).toBe('Continuation frame without a message')

    const interleaved = decoder()
    interleaved.decoder.push(clientFrame(OPCODE.text, Buffer.from('one'), false))
    interleaved.decoder.push(clientFrame(OPCODE.text, Buffer.from('two')))
    expect(interleaved.seen.failures[0]?.message).toBe('A new message started before the last one finished')
  })

  it('reports a close frame with its code, and stops reading whatever follows it', () => {
    const { decoder: read, seen } = decoder()
    const close = Buffer.alloc(2 + 7)
    close.writeUInt16BE(1001, 0)
    close.write('going', 2)
    read.push(Buffer.concat([clientFrame(OPCODE.close, close), encodeMaskedText('after the close')]))
    expect(seen.closed[0]?.code).toBe(1001)
    expect(seen.messages).toEqual([])
  })

  it('stops for good once a connection has broken the protocol', () => {
    const { decoder: read, seen } = decoder()
    read.push(encodeText('unmasked'))
    read.push(encodeMaskedText('a perfectly good frame'))
    expect(seen.messages).toEqual([])
    expect(seen.failures).toHaveLength(1)
  })

  it('encodes server frames unmasked and client frames masked, and each reads the other', () => {
    const fromServer = encodeFrame(OPCODE.text, Buffer.from('to the client'))
    expect((fromServer[1]! & 0x80) === 0).toBe(true)
    const client = decoder({ requireMask: false })
    client.decoder.push(fromServer)
    expect(client.seen.messages).toEqual([{ kind: 'text', text: 'to the client' }])

    const fromClient = encodeMaskedFrame(OPCODE.binary, Buffer.from('to the server'))
    expect((fromClient[1]! & 0x80) !== 0).toBe(true)
    const server = decoder({ requireMask: true })
    server.decoder.push(fromClient)
    expect(server.seen.messages).toEqual([{ kind: 'binary', text: 'to the server' }])
  })
})
