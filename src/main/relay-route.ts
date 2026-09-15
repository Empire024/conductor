import type { RelayStatus } from '../shared/remote-relay'
import type { ConductorRelay } from './conductor-relay'
import type { RelayCallOptions, RemoteRelay } from './remote-relay'
import type { RelayResponseBody } from '../shared/remote-relay'

/**
 * Which off-network route this machine is on.
 *
 * Conductor has two, and the choice is the owner's: point it at a relay of their own and every
 * message goes over a socket that is already open, or configure none and fall back to the private
 * gist mailbox, which needs no server but lives inside GitHub's rate limit. One of them carries any
 * given message - two copies of every request would be two chances to run it twice - so this
 * decides, and everything else in the app talks to whichever it picked without knowing which it was.
 *
 * Which one carries a message is a fact about the pair, not about this machine, so it is decided per
 * peer. Listening is the opposite: a machine cannot know which route someone will come looking for
 * it on, so while any paired machine is missing from the relay this one answers on the mailbox too.
 * That costs nothing while every machine is on the relay, which is the case the relay exists for.
 *
 * It also decides again when it has to. A relay is an address, and an address is only true from
 * somewhere: a laptop on a network without IPv6 cannot reach a relay that has only an IPv6 address,
 * and a relay on a machine that went to sleep cannot be reached from anywhere at all. Refusing the
 * other route in that state would leave the owner with two machines that cannot meet and a panel
 * explaining why - so after the relay has been unreachable long enough to mean it, this falls back
 * to the mailbox and says so. The relay keeps being retried, and the moment it answers, that is the
 * route again. The two machines reach that point by different evidence - the stranded one by failing
 * to connect, the one hosting the relay by noticing who never arrived - because a host dials its own
 * relay over loopback and would otherwise wait forever in a room only it can enter.
 */

export interface RelayRouteDependencies {
  server: ConductorRelay
  github: RemoteRelay
  /** The address the owner configured, for showing which relay "connected" means. */
  endpoint(): string | null
  /**
   * Paired machines that are not on the relay right now.
   *
   * A machine cannot tell whether its relay can be reached from anywhere except where it is
   * standing, and the machine hosting the relay stands on loopback - which always answers. So the
   * host is never stranded, never falls back, and a laptop that fell back to the mailbox would be
   * waiting in a room the host never enters. What the host can see is who failed to arrive, and
   * that is the signal used here: while a paired machine is missing from the relay, this one is
   * also reachable through the mailbox, because that is where a machine that cannot reach the
   * relay will look for it.
   */
  awaitedPeers(): string[]
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

  /** True while the mailbox is also being listened on, so a peer that cannot reach the relay
   *  still has somewhere to find this machine. */
  private awaitingPeers(): boolean {
    return this.deps.awaitedPeers().length > 0
  }

  private active(): ConductorRelay | RemoteRelay {
    return this.usingServer() ? this.deps.server : this.deps.github
  }

  /**
   * Which route carries a message to one particular machine.
   *
   * Being on the relay is not a property of this machine but of the pair: a peer that never
   * arrived there cannot be reached that way however well the relay is working from here, and
   * sending to it anyway would time out against a room with nobody in it. So presence decides,
   * per peer, and anyone the relay does not list is addressed through the mailbox instead.
   */
  private routeFor(machineId: string): ConductorRelay | RemoteRelay {
    if (!this.usingServer()) return this.deps.github
    return this.deps.server.getStatus().reachable.includes(machineId) ? this.deps.server : this.deps.github
  }

  start(): void {
    this.live = true
    if (this.deps.server.configured()) {
      // Kept running even while the mailbox carries this machine, because it is what notices the
      // relay coming back - and nothing else would.
      this.deps.server.start()
      if (this.strandedFromServer() || this.awaitingPeers()) this.deps.github.start()
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
    return await this.routeFor(machineId).call(machineId, peerDeviceKey, path, body, headers, peerRelayKey, options)
  }
}
