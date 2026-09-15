import { randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { globalIpv6Addresses } from './network-addresses'
import {
  CLOSE_PROTOCOL_ERROR,
  FrameDecoder,
  acceptKey,
  encodeMaskedBinary,
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
  /**
   * One decoded binary message. Only the tunnel uses these: it carries a TCP connection, which is
   * bytes, and a text frame would mean deciding an encoding for something that has none.
   */
  binary?(data: Buffer): void
  /** The send buffer emptied. A tunnel resumes the socket it paused when `send` said to stop. */
  drain?(): void
  /** The far end asking whether we are alive. Answering is automatic; hearing it is the signal. */
  pong?(): void
  /** Terminal, once: either end closed, or the connection failed. */
  closed(detail: { code: number; reason: string; error?: Error }): void
}

export interface RelaySocketOptions {
  maxMessageBytes: number
  connectTimeoutMs?: number
  /**
   * What to call the far end when something goes wrong. The relay and the push channel fail in the
   * same ways and need different words for it: "the relay is switched off on that machine" and
   * "that machine is not running Conductor" are the same ECONNREFUSED and different evenings.
   */
  subject?: string
  /**
   * Extra request headers for the upgrade. The push channel signs its challenge here, which is why
   * this client exists rather than a bare socket: the signature has to be on the request that opens
   * the connection, not on a frame sent after it is already open and already trusted.
   */
  headers?: Record<string, string>
  /**
   * SHA-256 of the certificate this relay must present, carried in the pairing code.
   *
   * A relay an owner runs on their own machine has no domain name and no certificate authority
   * behind it, and requiring one would mean requiring them to own a domain before they may link two
   * computers. Pinning is the same answer the direct listener already uses: the owner carries the
   * fingerprint across by hand, and nothing else is accepted - which is stricter than a public
   * certificate, not weaker, because exactly one certificate will do.
   */
  fingerprint?: string
}

const CLOSE_NORMAL = 1000
const MAX_HTTP_HEADER_BYTES = 16 * 1024

/**
 * What a failed connection means, in words the owner can act on.
 *
 * The operating system's own answer - ENETUNREACH against an address with colons in it - is exactly
 * right and says nothing to anyone: it means this machine has no IPv6 at all, which is a fact about
 * the network it is on rather than anything to do with the relay, the router it sits behind, or the
 * machine at the other end. Each of these failures has a different thing to do about it, and naming
 * the wrong one costs an evening.
 */
function explain(error: unknown, address: string, port: number, subject = 'relay'): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ''
  const where = address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
  const ipv6 = address.includes(':')
  // The operating system's own code travels with the explanation. The words are for the owner;
  // the code is what the push channel classifies a failure by, and re-deriving it from the prose
  // afterwards would make every message change a behaviour change.
  const carrying = (message: string): Error => Object.assign(new Error(message), code ? { code } : {})
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    if (ipv6 && !globalIpv6Addresses().length) {
      return carrying(`This machine has no IPv6 connection, so it cannot reach ${where} - that ${subject} has an IPv6 address and nothing else. Use it from a network that has IPv6, or give the ${subject} an address this machine can reach.`)
    }
    return carrying(`This network has no route to ${where}.`)
  }
  if (code === 'ECONNREFUSED') return carrying(`Nothing is listening at ${where}. The ${subject} is probably switched off on that machine.`)
  if (code === 'ETIMEDOUT') return carrying(`${where} did not answer. A firewall on that machine, or the router in front of it, is the usual reason.`)
  if (/^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED)$/.test(code)) {
    return carrying(`The certificate at ${where} is not one a public authority signed. A ${subject} Conductor runs makes its own, so that machine has to be paired with a pairing code - the code carries the certificate to pin. An address typed in by hand can only reach a ${subject} whose certificate an authority signed.`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

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

  private get subject(): string { return this.options.subject ?? 'relay' }

  connect(): void {
    let target: URL
    try { target = new URL(this.url) } catch { return this.fail(new Error(`"${this.url}" is not a ${this.subject} address.`)) }
    const secure = target.protocol === 'wss:'
    if (!secure && target.protocol !== 'ws:') {
      return this.fail(new Error(`A ${this.subject} address has to start with ws:// or wss://, not "${target.protocol}".`))
    }
    const port = Number(target.port) || (secure ? 443 : 80)
    const path = `${target.pathname || '/'}${target.search || ''}`

    const pinned = this.options.fingerprint?.trim() ?? ''
    // An IPv6 address keeps its brackets in a URL and in the Host header, and must lose them to be
    // connected to. A relay on a connection with no public IPv4 is reached this way and no other.
    const address = target.hostname.replace(/^\[|\]$/g, '')
    // A relay reached at an address rather than a name has no server name to send, and sending one
    // anyway is both meaningless and forbidden.
    const named = !/^[\d.]+$/.test(address) && !address.includes(':')
    const socket = secure
      ? tlsConnect({
          host: address,
          port,
          ...(named ? { servername: address } : {}),
          // A pinned certificate is checked below, by its fingerprint, instead of by a chain it was
          // never meant to have. Without a pin, the ordinary public rules apply.
          rejectUnauthorized: !pinned
        })
      : netConnect({ host: address, port })
    this.socket = socket as Socket
    socket.setNoDelay(true)
    // The connection to the relay is how this machine is reachable, not a reason for it to stay
    // running: an app the owner has closed must close.
    socket.unref?.()

    this.timer = setTimeout(
      () => this.fail(Object.assign(new Error(`The ${this.subject} did not answer in time.`), { code: 'ETIMEDOUT' })),
      this.options.connectTimeoutMs ?? 15_000
    )

    socket.on('error', error => this.fail(explain(error, address, port, this.subject)))
    socket.on('close', () => this.finish(this.upgraded ? CLOSE_NORMAL : 1006, this.upgraded ? '' : `The ${this.subject} closed the connection.`))
    socket.on('data', chunk => this.onData(chunk))
    socket.on('drain', () => { if (this.upgraded && !this.settled) this.events.drain?.() })
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      if (pinned) {
        const presented = (socket as ReturnType<typeof tlsConnect>).getPeerCertificate()?.fingerprint256 ?? ''
        if (!presented || presented.toUpperCase() !== pinned.toUpperCase()) {
          return this.fail(Object.assign(
            new Error(`That ${this.subject} presented a different certificate than the one in the pairing code. Nothing was sent to it.`),
            { code: 'ERR_TLS_CERT_PIN' }
          ))
        }
      }
      const host = target.port ? `${target.hostname}:${target.port}` : target.hostname
      // Header values come from this machine's own signing, never from the wire, but a CR or LF in
      // one would still be a request this client wrote rather than the one it meant to.
      const extra = Object.entries(this.options.headers ?? {})
        .filter(([name, value]) => /^[A-Za-z0-9-]{1,64}$/.test(name) && !/[\r\n]/.test(String(value)))
        .map(([name, value]) => `${name}: ${String(value)}\r\n`)
        .join('')
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${this.key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        extra +
        '\r\n'
      )
    })
  }

  send(value: unknown): void {
    if (!this.connected || !this.socket) return
    this.socket.write(encodeMaskedText(JSON.stringify(value)))
  }

  /**
   * One binary message. The answer is the socket's own: false means the kernel buffer is full and
   * whoever is feeding this should stop reading its source until `drain` says otherwise. Ignoring
   * it would not lose bytes - Node queues them - it would queue a whole transfer in this process's
   * memory, which is the same bug with a later symptom.
   */
  sendBinary(payload: Buffer): boolean {
    if (!this.connected || !this.socket) return false
    return this.socket.write(encodeMaskedBinary(payload))
  }

  /** Bytes written but not yet flushed, for a caller deciding whether to keep reading. */
  get bufferedBytes(): number { return this.socket?.writableLength ?? 0 }

  /** Stops and restarts reading from the far end, which is backpressure in the other direction. */
  pause(): void { this.socket?.pause() }
  resume(): void { this.socket?.resume() }

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
    if (this.handshakeBytes > MAX_HTTP_HEADER_BYTES) return this.fail(new Error(`The ${this.subject} answered with more headers than a ${this.subject} sends.`))
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
      // The status travels on the error: 401 and 403 are "this pairing is finished", which must
      // stop the reconnect loop, and every other refusal is worth trying again.
      return this.fail(Object.assign(new Error(status === 404
        ? `That address answered, but it is not a Conductor ${this.subject}.`
        : `The ${this.subject} refused the connection (${Number.isFinite(status) ? status : statusLine || 'no answer'}).`),
      Number.isFinite(status) ? { status } : {}))
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
      return this.fail(new Error(`The ${this.subject} did not answer this connection's own key.`))
    }
    // We offer no extensions, so a server that negotiated one is describing frames we do not read.
    if (headers.get('sec-websocket-extensions')) return this.fail(new Error(`The ${this.subject} asked for a WebSocket extension Conductor does not speak.`))

    this.upgraded = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.decoder = new FrameDecoder({ maxMessageBytes: this.options.maxMessageBytes, requireMask: false }, {
      message: message => {
        if (message.kind === 'binary') return this.events.binary?.(message.data)
        let parsed: unknown
        try { parsed = JSON.parse(message.data.toString('utf8')) } catch { return this.close(CLOSE_PROTOCOL_ERROR, 'Unreadable frame') }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.events.frame(parsed as Record<string, unknown>)
      },
      ping: payload => { if (this.socket && !this.settled) this.socket.write(encodeMaskedPong(payload)) },
      pong: () => { this.events.pong?.() },
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
      socket.removeAllListeners('drain')
      socket.removeAllListeners('error')
      socket.removeAllListeners('close')
      socket.on('error', () => { /* a socket already on its way out has nothing left to report */ })
      socket.destroy()
    }
    this.events.closed({ code, reason, error })
  }
}
