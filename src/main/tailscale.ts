import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import type { ConnectionPath, TailscalePeer, TailscaleState } from '../shared/remote-control'

/**
 * What this machine can learn about its tailnet, which is exactly what `tailscale status --json`
 * says and nothing more.
 *
 * Conductor does not talk to Tailscale's coordination server, hold a Tailscale credential or parse
 * its logs. The CLI on this machine already knows whether the backend is running, which address
 * this node holds and how each peer is currently being reached, and it is the only thing entitled
 * to answer those questions. Everything here is a reading of that answer.
 *
 * Two rules that look like details and are not:
 *
 * - Whether a path is direct or relayed is never inferred. Tailscale reports `CurAddr` once real
 *   traffic has found a direct path and `Relay` when DERP is carrying it, and before any traffic
 *   flows it reports neither - which is 'unknown', not 'direct'. Guessing from a round trip time
 *   would put a confident wrong word in front of the owner, and the whole point of showing the
 *   path is that it is the truth about their two networks.
 * - The CLI is located, not assumed. A machine without Tailscale is an ordinary state with an
 *   ordinary answer ("install it and sign in"), not an error, and certainly not a reason to fall
 *   back to some other route.
 */

/** Runs the Tailscale CLI. Injected so tests read fixtures instead of the machine they run on. */
export interface TailscaleCommand {
  (executable: string, args: string[], timeoutMs: number): Promise<string>
}

export interface TailscaleServiceDependencies {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Test seam: whether this path exists and is executable here. */
  exists?(path: string): boolean
  run?: TailscaleCommand
  now?(): number
  /** How long a reading stays good. Tailscale's own state changes on the order of seconds. */
  cacheMs?: number
  timeoutMs?: number
}

/** `tailscale status --json` on a busy machine still answers well inside this. */
const STATUS_TIMEOUT_MS = 5_000
const STATUS_CACHE_MS = 5_000
const WINDOWS_CLI = 'C:\\Program Files\\Tailscale\\tailscale.exe'
const MACOS_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

export const INSTALL_TAILSCALE_MESSAGE =
  'Install Tailscale from https://tailscale.com/download and sign in with your GitHub account.'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown, limit = 300): string => (typeof value === 'string' ? value.slice(0, limit) : '')

/**
 * Normalises whatever form an address arrived in. A socket's remote address is an IPv4-mapped IPv6
 * one (`::ffff:100.80.0.1`) as often as not, a URL keeps its brackets, and a link-local IPv6
 * address carries a zone. None of those change which network the address is on, and treating them
 * as different is how a tailnet address ends up being refused as a stranger.
 */
export function normalizeAddress(value: string): string {
  const trimmed = String(value ?? '').trim().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  const lowered = trimmed.toLowerCase()
  return lowered.startsWith('::ffff:') && lowered.includes('.') ? lowered.slice(7) : lowered
}

/**
 * Whether an address belongs to a tailnet: 100.64.0.0/10 for IPv4, fd7a:115c:a1e0::/48 for IPv6.
 *
 * This is the whole of the "Tailscale and nothing else" rule on both ends - the host refuses a
 * socket from anywhere else while it is in Tailscale exposure, and the controller refuses to dial
 * anywhere else for a Tailscale pairing - so it is deliberately a range test on the address rather
 * than a lookup in anything that could be stale or spoofed.
 */
export function isTailscaleAddress(value: string): boolean {
  const address = normalizeAddress(value)
  if (!address) return false
  if (address.includes('.')) {
    const parts = address.split('.')
    if (parts.length !== 4) return false
    const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : -1))
    if (octets.some(octet => octet < 0 || octet > 255)) return false
    // 100.64.0.0/10 is the carrier-grade NAT range Tailscale allocates from: the first octet is
    // 100 and the top six bits of the second are 0b010000, which is 64 through 127 inclusive.
    return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127
  }
  return address.startsWith('fd7a:115c:a1e0:')
}

export const isTailscaleIpv4 = (value: string): boolean => isTailscaleAddress(value) && normalizeAddress(value).includes('.')

/** IPv4 first: it is what a pairing code carries and what both ends dial. */
export function orderTailscaleAddresses(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const addresses = values.flatMap(entry => {
    const address = typeof entry === 'string' ? normalizeAddress(entry) : ''
    return address && isTailscaleAddress(address) ? [address] : []
  })
  return [...addresses.filter(address => address.includes('.')), ...addresses.filter(address => !address.includes('.'))].slice(0, 8)
}

/**
 * The path Tailscale itself reports, and only that. `CurAddr` is the peer's current direct
 * endpoint; `Relay` is a DERP region code. Neither is set until traffic has flowed, which is
 * 'unknown' - a state the owner is shown honestly rather than papered over.
 */
export function pathFor(curAddr: string, relay: string): ConnectionPath {
  if (curAddr) return 'direct'
  if (relay) return 'relayed'
  return 'unknown'
}

function readPeer(node: Record<string, unknown>, users: Map<string, string>): TailscalePeer | null {
  const addresses = orderTailscaleAddresses(node.TailscaleIPs)
  const hostName = text(node.HostName, 120)
  const dnsName = text(node.DNSName, 300)
  if (!hostName && !dnsName && !addresses.length) return null
  const curAddr = text(node.CurAddr, 100)
  const relay = text(node.Relay, 40)
  return {
    id: text(node.ID, 120),
    hostName,
    dnsName,
    addresses,
    online: node.Online === true,
    path: pathFor(curAddr, relay),
    relay: relay || null,
    loginName: users.get(String(node.UserID ?? '')) ?? null,
    // Tailscale writes "iOS", "android", "windows", "macOS", "linux"; one case so callers can compare.
    os: text(node.OS, 40).toLowerCase()
  }
}

/**
 * The names `tailscale cert` may issue for. Tailscale lists them only while HTTPS certificates are
 * enabled for the tailnet, so an empty list is the "switch it on at admin/dns" signal and a missing
 * document field is the same thing as none.
 */
function readCertDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(entry => (typeof entry === 'string' && entry.trim() ? [entry.trim().toLowerCase().replace(/\.$/, '')] : [])).slice(0, 20)
}

/**
 * Turns one `tailscale status --json` document into the state the rest of Conductor reads. Pure,
 * so the interesting cases - signed out, stopped, a peer reached over DERP - are fixtures rather
 * than a machine somebody has to own.
 */
export function readTailscaleStatus(raw: unknown, now: number): TailscaleState {
  const checkedAt = new Date(now).toISOString()
  if (!isRecord(raw)) {
    return { installed: true, backendState: null, self: null, peers: [], message: 'Tailscale answered with something this build cannot read.', checkedAt }
  }
  const backendState = text(raw.BackendState, 40) || null
  const users = new Map<string, string>()
  if (isRecord(raw.User)) {
    for (const [id, value] of Object.entries(raw.User)) {
      if (isRecord(value)) users.set(id, text(value.LoginName, 200) || text(value.DisplayName, 200))
    }
  }
  const selfNode = isRecord(raw.Self) ? readPeer(raw.Self, users) : null
  const self = selfNode
    ? { hostName: selfNode.hostName, dnsName: selfNode.dnsName, addresses: selfNode.addresses, loginName: selfNode.loginName, online: selfNode.online }
    : null
  const peers = (isRecord(raw.Peer) ? Object.values(raw.Peer) : [])
    .flatMap(value => (isRecord(value) ? [readPeer(value, users)] : []))
    .flatMap(peer => (peer ? [peer] : []))
    .slice(0, 200)
  return { installed: true, backendState, self, peers, message: statusMessage(backendState, self), checkedAt, certDomains: readCertDomains(raw.CertDomains) }
}

/** What to do next, in words, whenever the tailnet cannot carry anything from here. */
function statusMessage(backendState: string | null, self: TailscaleState['self']): string | null {
  if (backendState === 'NeedsLogin') {
    return 'Tailscale is installed here but not signed in. Open Tailscale and sign in with the same GitHub account as your other computer.'
  }
  if (backendState === 'Stopped') {
    return 'Tailscale is signed in but stopped on this machine. Start it from the Tailscale menu, then try again.'
  }
  if (backendState === 'NoState' || backendState === 'Starting') {
    return 'Tailscale is still starting up on this machine.'
  }
  if (backendState !== 'Running') {
    return backendState
      ? `Tailscale reports "${backendState}", which this build does not know how to use.`
      : 'Tailscale did not say what state it is in.'
  }
  if (!self?.addresses.some(isTailscaleIpv4)) {
    return 'Tailscale is running but this machine has no tailnet address yet. Sign in again from the Tailscale menu if this does not clear.'
  }
  return null
}

/** The peer a paired machine resolves to, by tailnet address first and MagicDNS name second. */
export function findTailscalePeer(state: TailscaleState, host: string, dnsName?: string): TailscalePeer | null {
  const address = normalizeAddress(host)
  const wanted = String(dnsName ?? '').trim().toLowerCase().replace(/\.$/, '')
  const byAddress = address ? state.peers.find(peer => peer.addresses.includes(address)) : undefined
  if (byAddress) return byAddress
  if (!wanted) return null
  return state.peers.find(peer => peer.dnsName.toLowerCase().replace(/\.$/, '') === wanted) ?? null
}

const defaultExists = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

const defaultRun: TailscaleCommand = (executable, args, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    execFile(executable, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) { resolve(String(stdout)); return }
      const detail = String(stderr ?? '').trim().split('\n')[0] ?? ''
      reject(new Error(detail || error.message))
    })
  })

export class TailscaleService {
  private cached: TailscaleState | null = null
  private cachedAt = 0
  /** One reading at a time: several panels asking at once must not become several processes. */
  private inFlight: Promise<TailscaleState> | null = null
  private located: string | null | undefined

  constructor(private readonly deps: TailscaleServiceDependencies = {}) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private platform(): NodeJS.Platform { return this.deps.platform ?? process.platform }
  private env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env }
  private exists(path: string): boolean { return (this.deps.exists ?? defaultExists)(path) }

  /** Where the CLI is, or null when Tailscale is not installed here. Resolved once per process. */
  locate(): string | null {
    if (this.located !== undefined) return this.located
    this.located = this.find()
    return this.located
  }

  private find(): string | null {
    const platform = this.platform()
    const env = this.env()
    const windows = platform === 'win32'
    const name = windows ? 'tailscale.exe' : 'tailscale'
    // Joined for the platform being asked about rather than the one this process runs on. A
    // developer machine resolving a Linux layout is only ever a test, but a helper that quietly
    // used the host's separator would pass there and mean nothing.
    const separator = windows ? '\\' : '/'
    const under = (...parts: string[]): string => parts.join(separator)
    const wellKnown = windows
      // The installer's own location, and the environment variables Windows uses to name it, so a
      // system drive that is not C: is not simply declared to have no Tailscale on it.
      ? [WINDOWS_CLI, ...[env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
          .flatMap(root => (root ? [under(root.replace(/[\\/]+$/, ''), 'Tailscale', name)] : []))]
      : platform === 'darwin' ? [MACOS_CLI] : []
    for (const candidate of wellKnown) if (this.exists(candidate)) return candidate
    for (const entry of String(env.PATH ?? env.Path ?? '').split(windows ? ';' : ':')) {
      const directory = entry.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '')
      if (!directory) continue
      const candidate = under(directory, name)
      if (this.exists(candidate)) return candidate
    }
    return null
  }

  /** The last reading, without asking again. Used where an answer now matters more than a fresh one. */
  last(): TailscaleState {
    return this.cached ?? { installed: this.located === undefined ? false : this.located !== null, backendState: null, self: null, peers: [], message: null, checkedAt: null }
  }

  async state(force = false): Promise<TailscaleState> {
    if (!force && this.cached && this.now() - this.cachedAt < (this.deps.cacheMs ?? STATUS_CACHE_MS)) return this.cached
    if (this.inFlight) return this.inFlight
    this.inFlight = this.read().finally(() => { this.inFlight = null })
    return this.inFlight
  }

  private async read(): Promise<TailscaleState> {
    const executable = this.locate()
    const checkedAt = new Date(this.now()).toISOString()
    if (!executable) {
      return this.publish({ installed: false, backendState: null, self: null, peers: [], message: INSTALL_TAILSCALE_MESSAGE, checkedAt })
    }
    const run = this.deps.run ?? defaultRun
    let output: string
    try { output = await run(executable, ['status', '--json'], this.deps.timeoutMs ?? STATUS_TIMEOUT_MS) }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return this.publish({
        installed: true, backendState: null, self: null, peers: [],
        message: `Tailscale is installed here but did not answer: ${detail}`,
        checkedAt: new Date(this.now()).toISOString()
      })
    }
    let parsed: unknown
    try { parsed = JSON.parse(output) }
    catch {
      return this.publish({
        installed: true, backendState: null, self: null, peers: [],
        message: 'Tailscale answered with something that is not JSON, so this build cannot read its state.',
        checkedAt: new Date(this.now()).toISOString()
      })
    }
    return this.publish(readTailscaleStatus(parsed, this.now()))
  }

  private publish(state: TailscaleState): TailscaleState {
    this.cached = state
    this.cachedAt = this.now()
    return state
  }

  /**
   * This machine's own tailnet IPv4, or null when there is none to bind to or advertise. The
   * listener and the pairing code both refuse to name anything else.
   */
  async selfAddress(force = false): Promise<string | null> {
    const state = await this.state(force)
    return state.self?.addresses.find(isTailscaleIpv4) ?? null
  }

  /** The same answer from the last reading, for callers that cannot await. */
  lastSelfAddress(): string | null {
    return this.last().self?.addresses.find(isTailscaleIpv4) ?? null
  }

  async peerFor(host: string, dnsName?: string): Promise<TailscalePeer | null> {
    return findTailscalePeer(await this.state(), host, dnsName)
  }
}

/** The part of the service the listener and the transport facade actually depend on. */
export interface TailscaleReader {
  state(force?: boolean): Promise<TailscaleState>
  last(): TailscaleState
  selfAddress(force?: boolean): Promise<string | null>
}
