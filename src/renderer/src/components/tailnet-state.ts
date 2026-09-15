import type { TailscalePeer, TailscaleState } from '../../../shared/remote-control'

/**
 * What the Tailscale panel says, from `tailscale status` and nothing else.
 *
 * The distinction this keeps is the one docs/multi-device.md insists on: Conductor reports what
 * Tailscale reports. Whether a peer is reached directly or through a DERP relay is a fact about
 * the two networks, answered by Tailscale, and never inferred here from a round trip. And the
 * exposure that binds only the tailnet address does not start at all when the tailnet is not
 * usable - it never widens to something else - so the panel's job when it is unusable is to say
 * exactly which of the four things is wrong and what the owner does about it.
 */

export interface TailnetSummary {
  /** 'Ready' / 'Not installed' / 'Signed out' / 'Stopped' / 'Starting' / 'Unknown'. */
  status: string
  /** True only when this machine really can be bound to and reached over the tailnet. */
  usable: boolean
  /** This machine's Tailscale address, which is the only address the listener binds in that mode. */
  address: string
  /** What to do next, whenever it is not usable. */
  message: string
  /** When the tailnet was last looked at, so a stale panel is visibly stale. */
  checkedAt: string
}

const BACKEND_WORDS: Record<string, { status: string; message: string }> = {
  Running: { status: 'Ready', message: '' },
  NeedsLogin: { status: 'Signed out', message: 'Sign in to Tailscale on this computer, with the same account as your other machine.' },
  Stopped: { status: 'Stopped', message: 'Tailscale is installed but switched off here. Start it, then check again.' },
  NoState: { status: 'Not set up', message: 'Tailscale has not been set up on this computer yet.' },
  Starting: { status: 'Starting', message: 'Tailscale is still starting. This usually takes a moment.' }
}

export function tailnetSummary(state: TailscaleState): TailnetSummary {
  const checkedAt = state.checkedAt ? new Date(state.checkedAt).toLocaleTimeString() : 'not yet'
  if (!state.installed) {
    return {
      status: 'Not installed', usable: false, address: '', checkedAt,
      message: state.message ?? 'Tailscale is not installed on this computer. Install it and sign in with the account both machines use.'
    }
  }
  const words = state.backendState ? BACKEND_WORDS[state.backendState] : undefined
  const address = state.self?.addresses[0] ?? ''
  const usable = state.backendState === 'Running' && Boolean(state.self?.online) && Boolean(address)
  const fallback = !state.self
    ? 'Tailscale is running but this machine is not signed in to a tailnet.'
    : !address
      ? 'Tailscale has not given this machine an address yet.'
      : ''
  return {
    status: words?.status ?? (state.backendState || 'Unknown'),
    usable,
    address,
    checkedAt,
    // `||` rather than `??` deliberately: an empty message is nothing to say, not an answer, and
    // 'Running' carries one. Chaining on null alone would leave the owner with a blank explanation.
    message: usable ? '' : state.message || words?.message || fallback
  }
}

/** One line per host on the tailnet: online or not, and direct or relayed, in Tailscale's own words. */
export function peerSummary(peer: TailscalePeer): string {
  if (!peer.online) return 'Offline'
  if (peer.path === 'direct') return 'Online · Direct'
  if (peer.path === 'relayed') return `Online · Relayed${peer.relay ? ` via ${peer.relay}` : ''}`
  return 'Online · Route unknown'
}

/**
 * Why a tailnet host still is not a paired machine.
 *
 * Seeing a computer on the tailnet is not permission to control it, and this is the sentence that
 * stops the panel from implying otherwise. Pairing is a single-use ticket carried between the
 * owner's own machines and approved on the far one; a device that has not been through that sees
 * nothing but a refusal, however visible it is here.
 */
export const PEER_PAIRING_NOTE =
  'Seeing a computer here is not the same as being allowed to use it. Pairing still needs an invite made on that computer and approved there.'

/** Which tailnet peer a paired machine is, matched on the addresses the pairing actually dials. */
export function matchTailnetPeer(peers: TailscalePeer[], host: string): TailscalePeer | null {
  if (!host) return null
  const needle = host.toLowerCase().replace(/^\[|\]$/g, '')
  return peers.find(peer =>
    peer.addresses.some(address => address.toLowerCase() === needle)
    || peer.dnsName.toLowerCase() === needle
    || peer.dnsName.toLowerCase().replace(/\.$/, '') === needle
    || peer.hostName.toLowerCase() === needle) ?? null
}
