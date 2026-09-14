import { randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import {
  CLOSE_PROTOCOL_ERROR,
  FrameDecoder,
  acceptKey,
  encodeMaskedClose,
  encodeMaskedPing,
  encodeMaskedPong,
  encodeMaskedText
} from '../shared/websocket-framing.ts'

/**
 * Conductor's side of a WebSocket, written on top of a plain socket.
 *
 * The runtime's own WebSocket client would have done, if it worked: on the Node build this repo is
 * developed against it fails to open a connection at all, including against a public echo server,
 * and a link between the owner's machines cannot be conditional on which Electron or Node a build
 * happens to carry. Since the relay's server side already had to own its framing, owning the client
 * half costs one file and removes the question entirely - and with it any dependency between the
 * owner's traffic and a package nobody in this repo reads.
 *
 * It speaks only what the relay needs: one text frame per JSON message, ping, pong and close.
 */

export interface RelaySocketEvents {
  open(): void
  /** One decoded JSON frame from the server. Anything unparseable closes the socket instead. */
  frame(frame: Record<string, unknown>): void
  /** Terminal, once: either end closed, or the connection failed. */
  closed(detail: { code: number; reason: string; error?: Error }): void
}

export interface RelaySocketOptions {
  maxMessageBytes: number
  connectTimeoutMs?: number
  /** Test seam and a deliberate escape hatch for a relay with a self-signed certificate. */
  rejectUnauthorized?: boolean
}

const CLOSE_NORMAL = 1000
const MAX_HTTP_HEADER_BYTES = 16 * 1024

export class RelaySocket {
  private socket: Socket | null = null
  private decoder: FrameDecoder | null = null
  private handshake: Buffer[] = []
  private handshakeBytes = 0
  private upgraded = false
  private settled = false
  private timer: NodeJS.Timeout | null = null
  private readonly key = randomBytes(16).toString('base64')

  constructor(
    private readonly url: string,
    private readonly events: RelaySocketEvents,
    private readonly options: RelaySocketOptions
  ) {}

  get connected(): boolean { return this.upgraded && !this.settled }

  connect(): void {
    let target: URL
    try { target = new URL(this.url) } catch { return this.fail(new Error(`"${this.url}" is not a relay address.`)) }
    const secure = target.protocol === 'wss:'
    if (!secure && target.protocol !== 'ws:') {
      return this.fail(new Error(`A relay address has to start with ws:// or wss://, not "${target.protocol}".`))
    }
    const port = Number(target.port) || (secure ? 443 : 80)
    const path = `${target.pathname || '/'}${target.search || ''}`

    const socket = secure
      ? tlsConnect({ host: target.hostname, port, servername: target.hostname, rejectUnauthorized: this.options.rejectUnauthorized !== false })
      : netConnect({ host: target.hostname, port })
    this.socket = socket as Socket
    socket.setNoDelay(true)

    this.timer = setTimeout(() => this.fail(new Error('The relay did not answer in time.')), this.options.connectTimeoutMs ?? 15_000)

    socket.on('error', error => this.fail(error instanceof Error ? error : new Error(String(error))))
    socket.on('close', () => this.finish(this.upgraded ? CLOSE_NORMAL : 1006, this.upgraded ? '' : 'The relay closed the connection.'))
    socket.on('data', chunk => this.onData(chunk))
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      const host = target.port ? `${target.hostname}:${target.port}` : target.hostname
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${this.key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      )
    })
  }

  send(value: unknown): void {
    if (!this.connected || !this.socket) return
    this.socket.write(encodeMaskedText(JSON.stringify(value)))
  }

  ping(): void {
    if (this.connected && this.socket) this.socket.write(encodeMaskedPing())
  }

  close(code = CLOSE_NORMAL, reason = ''): void {
    if (this.socket && this.upgraded && !this.settled) {
      try { this.socket.write(encodeMaskedClose(code, reason)) } catch { /* already gone */ }
    }
    this.finish(code, reason)
  }

  private onData(chunk: Buffer): void {
    if (this.upgraded) { this.decoder?.push(chunk); return }
    this.handshake.push(chunk)
    this.handshakeBytes += chunk.length
    if (this.handshakeBytes > MAX_HTTP_HEADER_BYTES) return this.fail(new Error('The relay answered with more headers than a relay sends.'))
    const buffered = Buffer.concat(this.handshake, this.handshakeBytes)
    const end = buffered.indexOf('\r\n\r\n')
    if (end < 0) return
    const head = buffered.subarray(0, end).toString('latin1')
    const rest = buffered.subarray(end + 4)
    this.handshake = []
    this.handshakeBytes = 0

    const [statusLine = '', ...headerLines] = head.split('\r\n')
    const status = Number(statusLine.split(' ')[1])
    if (status !== 101) {
      return this.fail(new Error(status === 404
        ? 'That address answered, but it is not a Conductor relay.'
        : `The relay refused the connection (${Number.isFinite(status) ? status : statusLine || 'no answer'}).`))
    }
    const headers = new Map<string, string>()
    for (const line of headerLines) {
      const index = line.indexOf(':')
      if (index > 0) headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim())
    }
    if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return this.fail(new Error('That address did not upgrade to a WebSocket.'))
    if (!(headers.get('connection') ?? '').toLowerCase().split(/\s*,\s*/).includes('upgrade')) {
      return this.fail(new Error('That address did not upgrade to a WebSocket.'))
    }
    // Proves the answer came from something that read our key, rather than a cache or a proxy
    // replaying somebody else's 101.
    if (headers.get('sec-websocket-accept') !== acceptKey(this.key)) {
      return this.fail(new Error("The relay did not answer this connection's own key."))
    }
    // We offer no extensions, so a server that negotiated one is describing frames we do not read.
    if (headers.get('sec-websocket-extensions')) return this.fail(new Error('The relay asked for a WebSocket extension Conductor does not speak.'))

    this.upgraded = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.decoder = new FrameDecoder({ maxMessageBytes: this.options.maxMessageBytes, requireMask: false }, {
      message: message => {
        if (message.kind !== 'text') return
        let parsed: unknown
        try { parsed = JSON.parse(message.data.toString('utf8')) } catch { return this.close(CLOSE_PROTOCOL_ERROR, 'Unreadable frame') }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.events.frame(parsed as Record<string, unknown>)
      },
      ping: payload => { if (this.socket && !this.settled) this.socket.write(encodeMaskedPong(payload)) },
      pong: () => { /* the relay asking whether we are alive; the reply is the whole answer */ },
      close: (code, reason) => this.close(code === 1005 ? CLOSE_NORMAL : code, reason),
      fail: (code, message) => this.close(code, message)
    })
    this.events.open()
    if (rest.length) this.decoder.push(rest)
  }

  private fail(error: Error): void {
    this.finish(1006, error.message, error)
  }

  private finish(code: number, reason: string, error?: Error): void {
    if (this.settled) return
    this.settled = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.decoder?.stop()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.removeAllListeners('data')
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
      socket.on('error', () => { /* a socket already on its way out has nothing left to report */ })
      socket.destroy()
    }
    this.events.closed({ code, reason, error })
  }
}
