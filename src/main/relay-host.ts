import { X509Certificate } from 'node:crypto'
import type { RelayHostStatus } from '../shared/remote-control'
import { RELAY_SOCKET_PATH } from '../shared/relay-protocol'
import { PortMappingError, lanAddress, releasePortMapping, requestPortMapping, PORT_MAPPING_LEASE_SECONDS, type PortMapping } from './port-mapping'
import { RelayServer } from '../relay-server/server'
import { createRemoteTlsIdentity, tlsIdentityUsable, type RemoteTlsIdentity } from './remote-tls'
import { globalIpv6Addresses, localAddresses, primaryMacAddress } from './network-addresses'
import type { SecretKeyValueStore } from './secret-store'

/**
 * The relay, run by Conductor itself.
 *
 * The relay can be started from a terminal and put on any machine with a public address, and for an
 * owner who has one that is the better place for it. Most people do not. What they have is two
 * computers and a router, and asking them to keep a shell open on one of them - or to rent a server
 * - is the difference between a feature that exists and a feature they can use.
 *
 * So the app runs it: the same server, in this process, with a certificate it mints for itself, the
 * room secret it already keeps for pairing, and - if the owner asks for it - one port opened on the
 * router so the other machine can arrive from outside the house. Nothing about the relay's own rules
 * changes; this only decides where it runs and who can reach it.
 */

const RELAY_CERT_SETTING = 'remote-control.relay.host.certificate'
const RELAY_CERT_EXPIRY_SETTING = 'remote-control.relay.host.certificateExpiry'
const RELAY_TLS_KEY_SECRET = 'remote-control.relay.host.tlsKey'

export interface RelayHostSettings {
  enabled: boolean
  port: number
  /** Ask the router to forward the port, so a machine off this network can reach it. */
  internet: boolean
}

export interface RelayHostVault {
  available(): boolean
  read(name: string): string | null
  write(name: string, value: string): void
}

export interface RelayHostDependencies {
  store: SecretKeyValueStore
  vault: RelayHostVault
  settings(): RelayHostSettings
  machineName(): string
  /** The room secret this machine pairs with; the relay it runs serves exactly that one room. */
  secret(): string | null
  changed?(): void
  now?(): number
  /** This machine's public IPv6 addresses and hardware address; injectable so the advice the owner
   *  is given can be exercised for a machine that has them and one that does not. */
  publicIpv6?(): string[]
  hardwareAddress?(): string | null
  /** Test seams: a server that does not bind, and a router that does not exist. */
  createServer?(options: { secrets: string[]; port: number; host: string; tls: { key: string; cert: string } }): RelayServer
  mapPort?(port: number): Promise<PortMapping>
  unmapPort?(mapping: PortMapping): Promise<void>
  schedule?(run: () => void, ms: number): { cancel(): void }
}

const offline: RelayHostStatus = {
  running: false, port: null, fingerprint: null, addresses: [],
  internet: { state: 'off', address: null, message: null }, message: null
}

export class RelayHost {
  private server: RelayServer | null = null
  private mapping: PortMapping | null = null
  private renewal: { cancel(): void } | null = null
  private status: RelayHostStatus = { ...offline }
  /** Every apply is an intent; an older one may finish its teardown but never publish a status. */
  private intent = 0

  constructor(private readonly deps: RelayHostDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  getStatus(): RelayHostStatus {
    return { ...this.status, addresses: [...this.status.addresses], internet: { ...this.status.internet } }
  }

  /** The address another machine should be given, public first because it works from both sides. */
  advertisedEndpoint(): string | null {
    return this.advertisedEndpoints()[0] ?? null
  }

  /**
   * Every address this relay answers on, best first.
   *
   * More than one is needed because the best address is not best from everywhere: a machine out in
   * the world needs a public address, a machine sitting on this network usually cannot use one at
   * all - most routers will not send a packet back in through their own public address - and an
   * IPv6 address only works if the machine reading it has IPv6 too. Handing over all of them lets
   * the other machine use whichever one works from where it is.
   */
  advertisedEndpoints(): string[] {
    if (!this.status.running) return []
    const internet = this.status.internet.address
    return internet ? [internet, ...this.status.addresses] : [...this.status.addresses]
  }

  /** Whether this machine is reachable from outside at all, by any route it can see. */
  private ipv6Endpoints(): string[] {
    const port = this.status.port
    return port ? this.ipv6().map(address => `wss://[${address}]:${port}${RELAY_SOCKET_PATH}`) : []
  }

  private ipv6(): string[] { return this.deps.publicIpv6?.() ?? globalIpv6Addresses() }

  /** What this machine itself connects to when it is the one running the relay. */
  localEndpoint(): string | null {
    return this.status.running && this.status.port ? `wss://127.0.0.1:${this.status.port}${RELAY_SOCKET_PATH}` : null
  }

  fingerprint(): string | null { return this.status.fingerprint }

  private publish(patch: Partial<RelayHostStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.changed?.()
  }

  /**
   * The relay's own certificate. It is pinned by fingerprint in the pairing code exactly as the
   * direct listener's is, which is what lets a relay on a home machine serve wss:// without a
   * domain name, a certificate authority, or the owner proving they own anything.
   */
  private tlsIdentity(): RemoteTlsIdentity {
    const certificatePem = this.deps.store.getSetting(RELAY_CERT_SETTING) ?? ''
    const privateKeyPem = this.deps.vault.read(RELAY_TLS_KEY_SECRET) ?? ''
    const notAfter = this.deps.store.getSetting(RELAY_CERT_EXPIRY_SETTING) ?? ''
    const stored = { certificatePem, privateKeyPem, notAfter }
    if (tlsIdentityUsable(stored)) {
      try { return { ...stored, fingerprint: new X509Certificate(certificatePem).fingerprint256 } }
      catch { /* a corrupted certificate is replaced rather than trusted */ }
    }
    const created = createRemoteTlsIdentity(`Conductor relay · ${this.deps.machineName()}`, localAddresses())
    this.deps.vault.write(RELAY_TLS_KEY_SECRET, created.privateKeyPem)
    this.deps.store.setSetting(RELAY_CERT_SETTING, created.certificatePem)
    this.deps.store.setSetting(RELAY_CERT_EXPIRY_SETTING, created.notAfter)
    return created
  }

  /** Starts, restarts or stops the relay to match the owner's settings. */
  async apply(): Promise<RelayHostStatus> {
    const intent = ++this.intent
    await this.teardown()
    if (intent !== this.intent) return this.getStatus()

    const settings = this.deps.settings()
    if (!settings.enabled) { this.publish({ ...offline }); return this.getStatus() }

    const secret = this.deps.secret()
    if (!secret) {
      this.publish({ ...offline, message: 'Sign in to GitHub first, so this machine has a room secret to serve.' })
      return this.getStatus()
    }
    if (!this.deps.vault.available()) {
      this.publish({ ...offline, message: 'The OS credential store is unavailable, so the relay key cannot be protected.' })
      return this.getStatus()
    }

    let tls: RemoteTlsIdentity
    try { tls = this.tlsIdentity() }
    catch (error) {
      this.publish({ ...offline, message: `The relay could not make a certificate: ${error instanceof Error ? error.message : String(error)}` })
      return this.getStatus()
    }

    // Zero means "ask the operating system", exactly as it does for the direct listener. A relay
    // usually wants a fixed port - the router rule that lets it in names one - so the setting
    // defaults to 8787, but an owner or a test that asks for any free port gets one.
    const wanted = settings.port
    const port = wanted === 0 || (Number.isInteger(wanted) && wanted >= 1 && wanted <= 65535) ? wanted : 8787
    // Both families. On a connection with no public IPv4 - which is what a provider hands out as
    // DS-Lite, and is now common - IPv6 is the only way in from outside, and a relay listening on
    // 0.0.0.0 would answer nothing there however the router is configured. Binding the IPv6 wildcard
    // takes IPv4 with it; a machine with IPv6 switched off falls back to IPv4 alone.
    const start = async (host: string, on: number): Promise<{ server: RelayServer; port: number }> => {
      const made = this.deps.createServer
        ? this.deps.createServer({ secrets: [secret], port: on, host, tls: { key: tls.privateKeyPem, cert: tls.certificatePem } })
        : new RelayServer({ secrets: [secret], port: on, host, tls: { key: tls.privateKeyPem, cert: tls.certificatePem } })
      const bound = await made.listen()
      return { server: made, port: bound.port }
    }
    /**
     * In order of what the owner would want: both families on the port they chose, then - only if
     * the machine has no IPv6 at all - IPv4 alone on it, and failing that any free port.
     *
     * A port already in use deliberately does not fall through to IPv4 on the same port. Windows
     * will often allow that bind to succeed next to the IPv6 one, leaving two relays sharing a port
     * and traffic going to whichever the operating system feels like: worse than moving. Moving is
     * safe because the pairing code carries whichever port it ended up on.
     */
    let bound = port
    try {
      let last: unknown = null
      const tryBind = async (host: string, on: number): Promise<{ server: RelayServer; port: number } | null> => {
        try { return await start(host, on) }
        catch (error) { last = error; return null }
      }
      const inUse = (): boolean => /EADDRINUSE/.test(last instanceof Error ? last.message : String(last))

      let started = await tryBind('::', port)
      if (!started && !inUse()) started = await tryBind('0.0.0.0', port)
      if (!started && port !== 0) started = await tryBind('::', 0) ?? await tryBind('0.0.0.0', 0)
      if (!started) throw last ?? new Error('The relay could not listen anywhere.')
      if (intent !== this.intent) { await started.server.close(); return this.getStatus() }
      this.server = started.server
      // Conductor's window decides when the app is over, not the relay it happens to be running.
      started.server.unref()
      // What the router is asked to open, and what the pairing code carries, is the port actually
      // bound - which is not the port asked for when the owner let the operating system choose.
      bound = started.port
      this.publish({
        running: true,
        port: started.port,
        fingerprint: tls.fingerprint,
        // A public IPv6 address goes first because it is the only one that works from both sides:
        // a machine out in the world can reach it once the router allows it, and a machine on this
        // network reaches it directly, with no router involved at all. Only the two most stable are
        // carried, since the rest are temporary addresses that will have rotated by tomorrow.
        addresses: [
          ...this.ipv6().slice(0, 2).map(address => `wss://[${address}]:${started.port}${RELAY_SOCKET_PATH}`),
          ...localAddresses().map(address => `wss://${address}:${started.port}${RELAY_SOCKET_PATH}`)
        ],
        internet: { state: settings.internet ? 'opening' : 'off', address: null, message: null },
        // A port nobody asked for is not a failure, but it is something to know: a router rule that
        // names the old port now points at nothing.
        message: port !== 0 && started.port !== port
          ? `Port ${port} was already in use on this machine, so the relay is on ${started.port} instead. If your router allows ${port} to this machine, point it at ${started.port}.`
          : null
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.publish({
        ...offline,
        message: /EADDRINUSE/.test(detail)
          ? `Port ${port} is already in use on this machine. Choose another one.`
          : `The relay could not start: ${detail}`
      })
      return this.getStatus()
    }

    if (settings.internet) await this.openPort(intent, bound)
    return this.getStatus()
  }

  /** Asks the router for a way in, and says plainly what happened either way. */
  private async openPort(intent: number, port: number): Promise<void> {
    try {
      const mapping = this.deps.mapPort ? await this.deps.mapPort(port) : await requestPortMapping({ port, description: 'Conductor relay' })
      if (intent !== this.intent) { await this.release(mapping); return }
      this.mapping = mapping
      this.publish({
        internet: {
          state: 'open',
          address: `wss://${mapping.externalAddress}:${mapping.externalPort}${RELAY_SOCKET_PATH}`,
          message: null
        }
      })
      this.scheduleRenewal(port)
    } catch (error) {
      if (intent !== this.intent) return
      const reason = error instanceof PortMappingError ? error.reason : 'network'
      const detail = error instanceof Error ? error.message : String(error)
      // Whatever the router would not do, the owner still can - but only if they are told the right
      // thing to do. A connection with no public IPv4 cannot forward a port at all, and telling
      // someone to forward one is how an evening disappears. What such a connection almost always
      // has is IPv6, where this machine already holds a public address and the router only has to
      // stop refusing traffic to it, so that instruction is given instead whenever it applies.
      const ipv6 = this.ipv6Endpoints()[0]
      const mac = this.deps.hardwareAddress?.() ?? primaryMacAddress()
      const elsewhere = 'run the relay somewhere that already has a public address.'
      const advice = ipv6
        ? `This machine already has a public IPv6 address, so nothing needs forwarding: allow TCP ${port} to it in your router, on the page for IPv6 exposure, pinholes or firewall rules${mac ? ` (it asks for this machine's hardware address: ${mac})` : ''}. Machines that have IPv6 then reach it at ${ipv6}. Failing that, ${elsewhere}`
        : reason === 'carrier-nat'
          ? `There is no port to forward on this connection, so ${elsewhere}`
          : `Forward TCP port ${port} to ${lanAddress() ?? 'this machine'} in your router, or ${elsewhere}`
      this.publish({ internet: { state: 'failed', address: null, message: `${detail} ${advice}` } })
    }
  }

  /** A mapping is taken on a lease, so it has to be asked for again before the router forgets it. */
  private scheduleRenewal(port: number): void {
    this.renewal?.cancel()
    const wait = Math.max(60_000, (PORT_MAPPING_LEASE_SECONDS - 300) * 1000)
    const run = (): void => {
      this.renewal = null
      const intent = this.intent
      void this.openPort(intent, port)
    }
    this.renewal = this.deps.schedule
      ? this.deps.schedule(run, wait)
      : (handle => { handle.unref?.(); return { cancel: () => clearTimeout(handle) } })(setTimeout(run, wait))
  }

  private async release(mapping: PortMapping): Promise<void> {
    try { await (this.deps.unmapPort ? this.deps.unmapPort(mapping) : releasePortMapping(mapping)) }
    catch { /* the lease expires by itself; a router that will not listen now is not a failure */ }
  }

  private async teardown(): Promise<void> {
    this.renewal?.cancel()
    this.renewal = null
    const mapping = this.mapping
    this.mapping = null
    if (mapping) await this.release(mapping)
    const server = this.server
    this.server = null
    if (server) await server.close()
  }

  async stop(): Promise<void> {
    this.intent++
    await this.teardown()
    this.publish({ ...offline })
  }
}
