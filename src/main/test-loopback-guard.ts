import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Socket as UdpSocket } from 'node:dgram'
import { Server } from 'node:net'

/*
 * A test instance never listens beyond this machine (owner, 2026-10-21: "conductor didn't start
 * until I manually clicked allow on the electron"). Every acceptance build and every smoke runs
 * electron.exe from a new candidate folder, and Windows Firewall asks the owner about each new
 * executable the first time it listens on anything but loopback: a smoke that enabled phone access
 * on the default 'network' exposure put an Allow dialog on the owner's screen for every candidate.
 *
 * So an automation profile (CONDUCTOR_TEST_USER_DATA) binds every listener to 127.0.0.1, enforced
 * once here (on load, below) for net servers (http, https, tls, ws, the relay) and UDP sockets, rather than trusted
 * to every call site and every smoke. CONDUCTOR_TEST_ALLOW_NETWORK=1 is the deliberate opt-out for
 * a run that truly needs the network; no smoke in the repo does.
 */

export const LOOPBACK_GUARD_LOG = 'loopback-guard.log'

export function loopbackOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CONDUCTOR_TEST_USER_DATA) && env.CONDUCTOR_TEST_ALLOW_NETWORK !== '1'
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value === '::1' || /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

/** The address a listener asked for, rewritten for a loopback-only instance: anything that is not
 *  loopback (a wildcard, a LAN or tailnet address, or no host at all, which means every interface)
 *  becomes 127.0.0.1. Null when the request already stays on this machine. */
export function loopbackHostFor(requested: string | null | undefined): string | null {
  if (typeof requested === 'string' && requested && isLoopbackHost(requested)) return null
  return '127.0.0.1'
}

type Rewrite = (from: string) => void

/** net.Server#listen's arguments with the host made loopback, or the same array when nothing
 *  needed changing. Pipes, handles and file descriptors are not network sockets and pass through. */
export function loopbackListenArgs(args: unknown[], rewrote: Rewrite = () => {}): unknown[] {
  const [first] = args
  if (first !== null && typeof first === 'object') {
    const options = first as { path?: unknown; fd?: unknown; handle?: unknown; _handle?: unknown; host?: unknown; port?: unknown }
    if (options.path !== undefined || options.fd !== undefined || options.handle !== undefined || options._handle !== undefined) return args
    if (options.port === undefined && options.host === undefined) return args
    const host = loopbackHostFor(typeof options.host === 'string' ? options.host : null)
    if (!host) return args
    rewrote(typeof options.host === 'string' ? options.host : '(every interface)')
    return [{ ...options, host }, ...args.slice(1)]
  }
  const portLike = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))
  if (typeof first === 'string' && !portLike) return args // a pipe or socket path
  if (!portLike && first !== undefined && typeof first !== 'function') return args
  const rest = portLike ? args.slice(1) : args
  if (typeof rest[0] === 'string') {
    const host = loopbackHostFor(rest[0])
    if (!host) return args
    rewrote(rest[0])
    return [portLike ? first : 0, host, ...rest.slice(1)]
  }
  rewrote('(every interface)')
  return [portLike ? first : 0, '127.0.0.1', ...rest]
}

/** dgram Socket#bind's arguments with the address made loopback. */
export function loopbackBindArgs(args: unknown[], family: 'udp4' | 'udp6', rewrote: Rewrite = () => {}): unknown[] {
  const loopback = family === 'udp6' ? '::1' : '127.0.0.1'
  const [first] = args
  if (first !== null && typeof first === 'object') {
    const options = first as { address?: unknown; fd?: unknown }
    if (options.fd !== undefined) return args
    if (typeof options.address === 'string' && options.address && isLoopbackHost(options.address)) return args
    rewrote(typeof options.address === 'string' && options.address ? options.address : '(every interface)')
    return [{ ...options, address: loopback }, ...args.slice(1)]
  }
  const portLike = typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))
  const rest = portLike ? args.slice(1) : args
  if (typeof rest[0] === 'string' && rest[0] && isLoopbackHost(rest[0])) return args
  rewrote(typeof rest[0] === 'string' && rest[0] ? rest[0] : '(every interface)')
  const tail = typeof rest[0] === 'string' ? rest.slice(1) : rest
  return [portLike ? first : 0, loopback, ...tail]
}

let installed = false

/** Patches net.Server#listen and dgram.Socket#bind in this process. Every rewrite is logged to
 *  `logPath` (when given) so a smoke can see which listener asked for the network. */
export function installLoopbackGuard(options: { logPath?: string; log?: (message: string) => void } = {}): boolean {
  if (installed) return false
  installed = true
  const record = (kind: string) => (from: string): void => {
    const line = `${new Date().toISOString()} ${kind} asked for ${from}; bound to loopback (test instance)`
    options.log?.(`[loopback-guard] ${line}`)
    if (options.logPath) { try { appendFileSync(options.logPath, `${line}\n`) } catch { /* evidence only */ } }
  }
  const listen = Server.prototype.listen
  Server.prototype.listen = function patchedListen(this: Server, ...args: unknown[]) {
    return (listen as (...values: unknown[]) => Server).apply(this, loopbackListenArgs(args, record('listen')))
  } as typeof listen
  const bind = UdpSocket.prototype.bind
  UdpSocket.prototype.bind = function patchedBind(this: UdpSocket & { type?: string }, ...args: unknown[]) {
    const family = this.type === 'udp6' ? 'udp6' : 'udp4'
    return (bind as (...values: unknown[]) => UdpSocket).apply(this, loopbackBindArgs(args, family, record(`udp bind (${family})`)))
  } as typeof bind
  return true
}

// Installed when this module loads. Main loads it (through remote-control-server, which the phone
// and remote listeners import) long before anything listens, so no call site and no smoke can forget.
if (loopbackOnly()) installLoopbackGuard({ logPath: join(resolve(process.env.CONDUCTOR_TEST_USER_DATA!), LOOPBACK_GUARD_LOG), log: message => console.log(message) })
