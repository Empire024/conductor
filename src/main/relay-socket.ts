import { randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { globalIpv6Addresses } from './network-addresses'
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
function explain(error: unknown, address: string, port: number): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? ''
  const where = address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
  const ipv6 = address.includes(':')
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    if (ipv6 && !globalIpv6Addresses().length) {
      return new Error(`This machine has no IPv6 connection, so it cannot reach ${where} - that relay has an IPv6 address and nothing else. Use it from a network that has IPv6, or give the relay an address this machine can reach.`)
    }
    return new Error(`This network has no route to ${where}.`)
  }
  if (code === 'ECONNREFUSED') return new Error(`Nothing is listening at ${where}. The relay is probably switched off on that machine.`)
  if (code === 'ETIMEDOUT') return new Error(`${where} did not answer. A firewall on that machine, or the router in front of it, is the usual reason.`)
  if (/^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED)$/.test(code)) {
    return new Error(`The certificate at ${where} is not one a public authority signed. A relay Conductor runs makes its own, so that machine has to be paired with a pairing code - the code carries the certificate to pin. An address typed in by hand can only reach a relay whose certificate an authority signed.`)
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

  connect(): void {
    let target: URL
    try { target = new URL(this.url) } catch { return this.fail(new Error(`"${this.url}" is not a relay address.`)) }
    const secure = target.protocol === 'wss:'
    if (!secure && target.protocol !== 'ws:') {
      return this.fail(new Error(`A relay address has to start with ws:// or wss://, not "${target.protocol}".`))
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

    this.timer = setTimeout(() => this.fail(new Error('The relay did not answer in time.')), this.options.connectTimeoutMs ?? 15_000)

    socket.on('error', error => this.fail(explain(error, address, port)))
    socket.on('close', () => this.finish(this.upgraded ? CLOSE_NORMAL : 1006, this.upgraded ? '' : 'The relay closed the connection.'))
    socket.on('data', chunk => this.onData(chunk))
    socket.on(secure ? 'secureConnect' : 'connect', () => {
      if (pinned) {
        const presented = (socket as ReturnType<typeof tlsConnect>).getPeerCertificate()?.fingerprint256 ?? ''
        if (!presented || presented.toUpperCase() !== pinned.toUpperCase()) {
          return this.fail(new Error('That relay presented a different certificate than the one in the pairing code. Nothing was sent to it.'))
        }
      }
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
