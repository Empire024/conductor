import { createSocket } from 'node:dgram'
import { request as httpRequest } from 'node:http'
import { primaryAddress } from './network-addresses'

/**
 * Asking the router to let one port through, so a relay running on a machine at home can be reached
 * from a machine that is not.
 *
 * This is the part of "link my machines over the internet" that nobody can do for the owner: two
 * computers behind two routers have no route to each other, and one of them has to become
 * reachable. Renting a server is one answer, and the relay's container image is there for owners who
 * want that. This is the other answer, for the far more common case of a home router that is willing
 * to forward a port if something asks it politely.
 *
 * It speaks UPnP Internet Gateway Device, which is what consumer routers implement and - unlike
 * NAT-PMP - announces itself, so nothing here has to guess the gateway's address. The whole thing is
 * best effort by nature: plenty of routers have it switched off, and an ISP that puts its customers
 * behind its own NAT cannot forward anything at all. Every failure says which it was, because
 * "it did not work" is not something an owner can act on.
 */

const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900
const IGD_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
]
const WAN_SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1']
/** Long enough that renewal is rare, short enough that a forgotten mapping expires by itself. */
export const PORT_MAPPING_LEASE_SECONDS = 3600
const DISCOVERY_MS = 2500
const REQUEST_MS = 5000

export interface PortMapping {
  externalAddress: string
  externalPort: number
  /** Where the mapping lives, so it can be renewed or taken down again. */
  controlUrl: string
  serviceType: string
  internalAddress: string
  internalPort: number
  expiresAt: number
}

export type PortMappingFailure = 'no-router' | 'refused' | 'carrier-nat' | 'network'

export class PortMappingError extends Error {
  readonly reason: PortMappingFailure

  constructor(message: string, reason: PortMappingFailure) {
    super(message)
    this.reason = reason
  }
}

/**
 * This machine's address on the network the router is on; the mapping has to name it.
 *
 * Naming a virtual switch's address instead would have the router forward the port faithfully to an
 * interface no packet from outside can arrive on, which looks exactly like success.
 */
export function lanAddress(): string | null {
  return primaryAddress()
}

/** Addresses that are not routable on the public internet, so a router behind one cannot help. */
export function isPrivateAddress(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a = 0, b = 0] = parts
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  // 100.64.0.0/10 is what an ISP uses when it puts its customers behind its own NAT.
  return a === 100 && b >= 64 && b <= 127
}

interface Gateway { location: string }

/**
 * Where the router probably is, for asking it directly.
 *
 * Multicast is the specified way to find it and the way that needs no guessing, but it is also the
 * first thing a host firewall drops and the first thing a mesh or guest network stops carrying. The
 * addresses a home router almost always answers on are worth asking as well, because a question sent
 * straight to it looks like ordinary traffic.
 */
function gatewayCandidates(): string[] {
  const address = lanAddress()
  if (!address) return []
  const parts = address.split('.')
  if (parts.length !== 4) return []
  const prefix = parts.slice(0, 3).join('.')
  return [`${prefix}.1`, `${prefix}.254`].filter(candidate => candidate !== address)
}

/** Asks the network who the router is. Several may answer; the first usable one is taken. */
async function discover(timeoutMs = DISCOVERY_MS): Promise<Gateway[]> {
  return await new Promise<Gateway[]>(resolve => {
    const found = new Map<string, Gateway>()
    let socket: ReturnType<typeof createSocket>
    try { socket = createSocket({ type: 'udp4', reuseAddr: true }) }
    catch { return resolve([]) }
    const finish = (): void => {
      try { socket.close() } catch { /* already closed */ }
      resolve([...found.values()])
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    socket.on('error', () => { clearTimeout(timer); finish() })
    socket.on('message', message => {
      const text = message.toString('utf8')
      const location = /\r\nLOCATION:\s*(\S+)/i.exec(text)?.[1]
      if (location && !found.has(location)) found.set(location, { location })
    })
    socket.bind(0, () => {
      try { socket.setBroadcast(true) } catch { /* not fatal for M-SEARCH */ }
      for (const target of IGD_TARGETS) {
        const search = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
          'MAN: "ssdp:discover"\r\n' +
          'MX: 2\r\n' +
          `ST: ${target}\r\n\r\n`, 'utf8')
        socket.send(search, SSDP_PORT, SSDP_ADDRESS, () => { /* an unreachable router is a timeout */ })
      }
    })
  })
}

async function fetchText(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  const target = new URL(url)
  if (target.protocol !== 'http:') throw new PortMappingError('The router described itself at an address this does not follow.', 'network')
  // The router is on the local network by definition; following it anywhere else would make this a
  // way to have Conductor make requests to arbitrary hosts.
  if (!isPrivateAddress(target.hostname)) throw new PortMappingError('That router is not on this network.', 'network')
  return await new Promise((resolve, reject) => {
    const call = httpRequest({
      host: target.hostname,
      port: Number(target.port) || 80,
      path: `${target.pathname}${target.search}`,
      method: init?.method ?? 'GET',
      headers: init?.headers,
      timeout: REQUEST_MS
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        // A router's description is a few kilobytes; anything larger is not one.
        if (size > 512 * 1024) { response.destroy(); reject(new PortMappingError('That router answered with more than a router sends.', 'network')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    call.on('timeout', () => { call.destroy(); reject(new PortMappingError('The router did not answer in time.', 'network')) })
    call.on('error', error => reject(new PortMappingError(error instanceof Error ? error.message : String(error), 'network')))
    if (init?.body) call.write(init.body)
    call.end()
  })
}

/** The forwarding service inside a router's description, and where to call it. */
function findService(description: string, base: string): { controlUrl: string; serviceType: string } | null {
  for (const serviceType of WAN_SERVICES) {
    const index = description.indexOf(serviceType)
    if (index < 0) continue
    const control = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(description.slice(index))?.[1]
    if (!control) continue
    try { return { controlUrl: new URL(control, base).toString(), serviceType } }
    catch { continue }
  }
  return null
}

async function soap(controlUrl: string, serviceType: string, action: string, body: string): Promise<string> {
  const envelope =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`
  const answer = await fetchText(controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      'content-length': String(Buffer.byteLength(envelope)),
      soapaction: `"${serviceType}#${action}"`
    },
    body: envelope
  })
  if (answer.status !== 200) {
    const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(answer.body)?.[1]
    throw new PortMappingError(
      code === '718' ? 'Another device already forwards that port on this router.'
        : code === '725' ? 'This router only makes permanent mappings, which Conductor does not ask for.'
        : `The router refused (${code ?? answer.status}).`,
      'refused')
  }
  return answer.body
}

export interface RequestMappingOptions {
  port: number
  description?: string
  leaseSeconds?: number
  now?(): number
  /** Routers to ask directly instead of looking for them, by description URL. */
  locations?: string[]
}

/**
 * Asks the router to forward one TCP port to this machine, and reports the address that reaches it.
 *
 * The external port asked for is the same as the internal one, because the owner has to be able to
 * read the resulting address and recognise it, and because a mapping that survives a restart is
 * worth more than one that is guaranteed to be free.
 */
export async function requestPortMapping(options: RequestMappingOptions): Promise<PortMapping> {
  const internalAddress = lanAddress()
  if (!internalAddress) throw new PortMappingError('This machine has no address on a local network.', 'network')
  const gateways = options.locations?.length ? options.locations.map(location => ({ location })) : await discover()
  if (!gateways.length) {
    throw new PortMappingError(
      "No router on this network answered. That is usually UPnP being switched off in the router, or this computer's firewall dropping the reply.",
      'no-router')
  }
  const lease = options.leaseSeconds ?? PORT_MAPPING_LEASE_SECONDS
  let lastError: PortMappingError | null = null
  for (const gateway of gateways) {
    try {
      const description = await fetchText(gateway.location)
      const service = findService(description.body, gateway.location)
      if (!service) continue
      const external = await soap(service.controlUrl, service.serviceType, 'GetExternalIPAddress', '')
      const externalAddress = /<NewExternalIPAddress>\s*([^<]*?)\s*<\/NewExternalIPAddress>/i.exec(external)?.[1] ?? ''
      if (!externalAddress) throw new PortMappingError('The router did not say what its public address is.', 'refused')
      if (isPrivateAddress(externalAddress)) {
        // The router forwarded the port faithfully to an address that is itself behind the ISP's
        // NAT, which no amount of asking will fix.
        throw new PortMappingError(
          `This connection is behind your provider's own network (${externalAddress}), so a port opened here is still not reachable from the internet. Run the relay somewhere with a public address instead.`,
          'carrier-nat')
      }
      await soap(service.controlUrl, service.serviceType, 'AddPortMapping',
        '<NewRemoteHost></NewRemoteHost>' +
        `<NewExternalPort>${options.port}</NewExternalPort>` +
        '<NewProtocol>TCP</NewProtocol>' +
        `<NewInternalPort>${options.port}</NewInternalPort>` +
        `<NewInternalClient>${internalAddress}</NewInternalClient>` +
        '<NewEnabled>1</NewEnabled>' +
        `<NewPortMappingDescription>${options.description ?? 'Conductor relay'}</NewPortMappingDescription>` +
        `<NewLeaseDuration>${lease}</NewLeaseDuration>`)
      return {
        externalAddress,
        externalPort: options.port,
        controlUrl: service.controlUrl,
        serviceType: service.serviceType,
        internalAddress,
        internalPort: options.port,
        expiresAt: (options.now?.() ?? Date.now()) + lease * 1000
      }
    } catch (error) {
      lastError = error instanceof PortMappingError ? error : new PortMappingError(String(error), 'network')
      // A router that cannot forward is worth reporting rather than hidden behind the next one.
      if (lastError.reason === 'carrier-nat') throw lastError
    }
  }
  throw lastError ?? new PortMappingError('No router on this network offers port forwarding.', 'no-router')
}

/** Takes the mapping down again. A failure here only means it will expire on its own instead. */
export async function releasePortMapping(mapping: PortMapping): Promise<void> {
  await soap(mapping.controlUrl, mapping.serviceType, 'DeletePortMapping',
    '<NewRemoteHost></NewRemoteHost>' +
    `<NewExternalPort>${mapping.externalPort}</NewExternalPort>` +
    '<NewProtocol>TCP</NewProtocol>')
}
