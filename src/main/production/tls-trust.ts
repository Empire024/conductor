import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import * as tls from 'node:tls'
import type { NetworkPolicy } from '../../shared/production'

/**
 * The audit's own certificate check for an environment with extra trust (EnvironmentTls,
 * docs/production-agent.md section 4). The audit browser fetches every document and subresource
 * in Node (the route handler's `route.fetch`), and Node trusts only its bundled roots, not the
 * operating system's store, so a staging site behind a private CA the owner installed fails there
 * with `self-signed certificate in certificate chain` while Chromium on the same machine opens it.
 * Playwright's fetch takes no CA option, so an environment with `tls` opens its context with
 * Chromium's and the fetch's own check off, and this module verifies each HTTPS origin once, before
 * the first request to it goes out: a full handshake with chain and host-name verification against
 * the bundled roots plus the system store and/or the listed CA files. An origin that does not
 * verify is blocked with the TLS error as the reason. Production never gets one.
 */

export const TLS_VERIFY_TIMEOUT_MS = 10_000

export interface TlsTrust {
  /** Null when the URL's origin verified (or is not HTTPS); otherwise why it is refused. */
  verify(url: string): Promise<string | null>
  /** One line for the run notes. */
  readonly description: string
}

export interface TlsTrustOptions {
  connect?: (options: tls.ConnectionOptions) => tls.TLSSocket
  readFile?: (path: string) => string
  systemCertificates?: () => string[]
  defaultCertificates?: () => string[]
  timeoutMs?: number
}

const certificates = (type: 'default' | 'system'): string[] => {
  const read = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates
  if (read) return read(type)
  if (type === 'default') return [...tls.rootCertificates]
  throw new Error('this runtime cannot read the system certificate store')
}

/** The environment's trust, or null when the policy has none (production never has one). */
export function createTlsTrust(policy: Pick<NetworkPolicy, 'environmentId' | 'environmentKind' | 'tls'>, options: TlsTrustOptions = {}): TlsTrust | null {
  const settings = policy.tls
  if (!settings || policy.environmentKind === 'production') return null
  if (!settings.allowSystemTrust && !settings.trustedCaPaths.length) return null
  const connect = options.connect ?? tls.connect
  const timeoutMs = options.timeoutMs ?? TLS_VERIFY_TIMEOUT_MS
  const sources = [...(settings.allowSystemTrust ? ['the system certificate store'] : []), ...settings.trustedCaPaths]
  let ca: string[] | null = null
  let caProblem: string | null = null
  const trusted = (): string[] | null => {
    if (ca || caProblem) return ca
    try {
      const list = [...(options.defaultCertificates ?? (() => certificates('default')))()]
      if (settings.allowSystemTrust) list.push(...(options.systemCertificates ?? (() => certificates('system')))())
      for (const path of settings.trustedCaPaths) {
        let text: string
        try { text = (options.readFile ?? (file => readFileSync(file, 'utf8')))(path) } catch { throw new Error(`the trusted CA file ${path} could not be read`) }
        if (!/-----BEGIN CERTIFICATE-----/.test(text)) throw new Error(`the trusted CA file ${path} holds no PEM certificate`)
        list.push(text)
      }
      ca = list
    } catch (error) {
      caProblem = error instanceof Error ? error.message : String(error)
    }
    return ca
  }
  const verified = new Map<string, Promise<string | null>>()
  const handshake = (host: string, port: number): Promise<string | null> => new Promise(resolve => {
    const roots = trusted()
    if (!roots) { resolve(`TLS trust of ${policy.environmentId} is unusable: ${caProblem}`); return }
    let settled = false
    let socket: tls.TLSSocket | null = null
    const finish = (problem: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(problem)
    }
    const timer = setTimeout(() => finish(`TLS: no handshake with ${host}:${port} within ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
    try {
      socket = connect({ host, port, ca: roots, rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) })
      socket.once('secureConnect', () => finish(socket!.authorized ? null : `TLS: the certificate of ${host} is not trusted (${String(socket!.authorizationError ?? 'unauthorized')})`))
      socket.once('error', (error: NodeJS.ErrnoException) => finish(`TLS: the certificate of ${host} did not verify against ${sources.join(', ')} and the public roots (${error.code ? `${error.code}: ` : ''}${error.message})`))
    } catch (error) {
      finish(`TLS: ${host}:${port} could not be reached (${error instanceof Error ? error.message : String(error)})`)
    }
  })
  return {
    description: `TLS trust of ${policy.environmentId}: certificates are verified against the public roots plus ${sources.join(', ')}`,
    verify(url) {
      let parsed: URL
      try { parsed = new URL(url) } catch { return Promise.resolve(null) }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') return Promise.resolve(null)
      const host = parsed.hostname.replace(/^\[|\]$/g, '')
      const port = Number(parsed.port) || 443
      const key = `${host}:${port}`
      let pending = verified.get(key)
      if (!pending) verified.set(key, pending = handshake(host, port))
      return pending
    },
  }
}
