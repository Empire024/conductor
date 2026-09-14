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
 */

export interface RelayRouteDependencies {
  server: ConductorRelay
  github: RemoteRelay
  /** The address the owner configured, for showing which relay "connected" means. */
  endpoint(): string | null
}

export class RelayRoute {
  constructor(private readonly deps: RelayRouteDependencies) {}

  /** True when the owner runs their own relay, which is then the only route used. */
  usingServer(): boolean { return this.deps.server.configured() }

  private active(): ConductorRelay | RemoteRelay {
    return this.usingServer() ? this.deps.server : this.deps.github
  }

  start(): void {
    if (this.usingServer()) {
      this.deps.github.stop()
      this.deps.server.start()
      return
    }
    this.deps.server.stop()
    this.deps.github.start()
  }

  stop(): void {
    this.deps.server.stop()
    this.deps.github.stop()
  }

  getStatus(): RelayStatus {
    const status = this.active().getStatus()
    return this.usingServer()
      ? { ...status, route: 'server', endpoint: this.deps.endpoint() }
      : { ...status, route: 'github', endpoint: null }
  }

  async checkIn(): Promise<void> {
    await this.active().checkIn()
  }

  async call(machineId: string, peerDeviceKey: string, path: string, body: Buffer, headers: Record<string, string>, peerRelayKey?: string, options?: RelayCallOptions): Promise<RelayResponseBody> {
    return await this.active().call(machineId, peerDeviceKey, path, body, headers, peerRelayKey, options)
  }
}
