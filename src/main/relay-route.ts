import type { RelayStatus } from '../shared/remote-relay'
import type { ConductorRelay } from './conductor-relay'
import type { RelayCallOptions, RemoteRelay } from './remote-relay'
import type { RelayResponseBody } from '../shared/remote-relay'

/**
 * Which off-network route this machine is on.
 *
 * Conductor has two, and the choice is the owner's: point it at a relay of their own and every
 * message goes over a socket that is already open, or configure none and fall back to the private
 * gist mailbox, which needs no server but lives inside GitHub's rate limit. Only one runs at a time
 * - two mailboxes would mean two copies of every request and two ways to be found - so this decides,
 * once, and everything else in the app talks to whichever it picked without knowing which it was.
 *
 * It also decides again when it has to. A relay is an address, and an address is only true from
 * somewhere: a laptop on a network without IPv6 cannot reach a relay that has only an IPv6 address,
 * and a relay on a machine that went to sleep cannot be reached from anywhere at all. Refusing the
 * other route in that state would leave the owner with two machines that cannot meet and a panel
 * explaining why - so after the relay has been unreachable long enough to mean it, this falls back
 * to the mailbox and says so. The relay keeps being retried, and the moment it answers, that is the
 * route again. Both machines make that decision independently and land in the same place, which is
 * what matters: a machine that falls back alone has only changed which empty room it waits in.
 */

export interface RelayRouteDependencies {
  server: ConductorRelay
  github: RemoteRelay
  /** The address the owner configured, for showing which relay "connected" means. */
  endpoint(): string | null
}

export class RelayRoute {
  /** Whether a route is meant to be running at all, so a status change cannot revive a stopped one. */
  private live = false

  constructor(private readonly deps: RelayRouteDependencies) {}

  /** True when the owner runs their own relay and it can actually be reached from here. */
  usingServer(): boolean {
    return this.deps.server.configured() && !this.deps.server.stranded()
  }

  /** True when a relay is set up but out of reach, so the mailbox is carrying this machine. */
  strandedFromServer(): boolean {
    return this.deps.server.configured() && this.deps.server.stranded()
  }

  private active(): ConductorRelay | RemoteRelay {
    return this.usingServer() ? this.deps.server : this.deps.github
  }

  start(): void {
    this.live = true
    if (this.deps.server.configured()) {
      // Kept running even while the mailbox carries this machine, because it is what notices the
      // relay coming back - and nothing else would.
      this.deps.server.start()
      if (this.strandedFromServer()) this.deps.github.start()
      else this.deps.github.stop()
      return
    }
    this.deps.server.stop()
    this.deps.github.start()
  }

  stop(): void {
    this.live = false
    this.deps.server.stop()
    this.deps.github.stop()
  }

  /**
   * Weighs the choice again after something changed underneath it - a relay that went out of reach,
   * or came back.
   *
   * It is deliberately not `start`. Stopping a relay publishes a status change like any other, and
   * a plain re-evaluation would take that as a reason to start it again: on sign-out that would
   * reconnect what the owner just switched off, and while the app is closing it would raise the
   * relay again for as long as the process kept trying to end.
   */
  reconsider(): void {
    if (this.live) this.start()
  }

  getStatus(): RelayStatus {
    const status = this.active().getStatus()
    if (this.usingServer()) {
      // The relay reports which of its addresses it is actually on, which is not always the first
      // one it was given, so its own answer is kept rather than overwritten with the configured one.
      return { ...status, route: 'server', endpoint: status.endpoint ?? this.deps.endpoint() }
    }
    if (this.strandedFromServer()) {
      const why = this.deps.server.getStatus().message
      return {
        ...status,
        route: 'github',
        endpoint: null,
        message: `Your relay cannot be reached from here, so your machines are meeting through the GitHub mailbox instead.${why ? ` ${why}` : ''}`
      }
    }
    return { ...status, route: 'github', endpoint: null }
  }

  async checkIn(): Promise<void> {
    await this.active().checkIn()
  }

  async call(machineId: string, peerDeviceKey: string, path: string, body: Buffer, headers: Record<string, string>, peerRelayKey?: string, options?: RelayCallOptions): Promise<RelayResponseBody> {
    return await this.active().call(machineId, peerDeviceKey, path, body, headers, peerRelayKey, options)
  }
}
