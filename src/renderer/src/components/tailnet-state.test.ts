import { describe, expect, it } from 'vitest'
import type { TailscalePeer, TailscaleState } from '../../../shared/remote-control'
import { UNKNOWN_TAILSCALE } from '../../../shared/remote-control'
import { matchTailnetPeer, peerSummary, tailnetSummary } from './tailnet-state'

const state = (patch: Partial<TailscaleState>): TailscaleState => ({
  ...UNKNOWN_TAILSCALE, installed: true, backendState: 'Running',
  self: { hostName: 'laptop', dnsName: 'laptop.tail1234.ts.net', addresses: ['100.101.102.103'], loginName: 'owner@github', online: true },
  checkedAt: '2026-09-16T09:00:00.000Z', ...patch
})

const peer = (patch: Partial<TailscalePeer> = {}): TailscalePeer => ({
  id: 'n1', hostName: 'main', dnsName: 'main.tail1234.ts.net', addresses: ['100.64.0.9', 'fd7a::9'],
  online: true, path: 'direct', relay: null, loginName: 'owner@github', ...patch
})

describe('what the Tailscale panel says about this machine', () => {
  it('is ready only when Tailscale is running, signed in and has given this machine an address', () => {
    const summary = tailnetSummary(state({}))
    expect(summary).toMatchObject({ status: 'Ready', usable: true, address: '100.101.102.103', message: '' })
  })

  it('says what to do for each way the tailnet can be unusable, rather than just failing', () => {
    expect(tailnetSummary(state({ installed: false, backendState: null, self: null, message: null })))
      .toMatchObject({ status: 'Not installed', usable: false })
    expect(tailnetSummary(state({ installed: false, backendState: null, self: null, message: null })).message).toMatch(/Install it and sign in/)
    expect(tailnetSummary(state({ backendState: 'NeedsLogin', self: null, message: null })).message).toMatch(/Sign in to Tailscale/)
    expect(tailnetSummary(state({ backendState: 'Stopped', self: null, message: null })).message).toMatch(/switched off here/)
    expect(tailnetSummary(state({ backendState: 'Starting', self: null, message: null })).message).toMatch(/still starting/)
  })

  it('prefers the message the transport supplied over its own guess at one', () => {
    expect(tailnetSummary(state({ backendState: 'Stopped', self: null, message: 'tailscaled is not running as a service.' })).message)
      .toBe('tailscaled is not running as a service.')
  })

  it('is not usable while signed in but without an address, and says which of the two is missing', () => {
    expect(tailnetSummary(state({ self: { hostName: 'laptop', dnsName: 'l', addresses: [], loginName: null, online: true }, message: null })))
      .toMatchObject({ usable: false, address: '' })
    expect(tailnetSummary(state({ self: { hostName: 'laptop', dnsName: 'l', addresses: [], loginName: null, online: true }, message: null })).message)
      .toMatch(/has not given this machine an address/)
    expect(tailnetSummary(state({ self: null, message: null })).message).toMatch(/not signed in to a tailnet/)
  })

  it('shows when the tailnet was last looked at, so a stale panel is visibly stale', () => {
    expect(tailnetSummary(state({ checkedAt: null })).checkedAt).toBe('not yet')
    expect(tailnetSummary(state({})).checkedAt).not.toBe('not yet')
  })
})

describe('the hosts on your tailnet', () => {
  it('repeats Tailscale’s own answer about the route, never a guess', () => {
    expect(peerSummary(peer({ path: 'direct' }))).toBe('Online · Direct')
    expect(peerSummary(peer({ path: 'relayed', relay: 'fra' }))).toBe('Online · Relayed via fra')
    expect(peerSummary(peer({ path: 'relayed', relay: null }))).toBe('Online · Relayed')
    // Unknown stays unknown. It is a real answer and pretending it is 'Direct' would be a lie.
    expect(peerSummary(peer({ path: 'unknown' }))).toBe('Online · Route unknown')
    // An offline peer has no route to describe at all.
    expect(peerSummary(peer({ online: false, path: 'direct' }))).toBe('Offline')
  })

  it('matches a paired machine to its tailnet node by address or name, never by guesswork', () => {
    const peers = [peer(), peer({ id: 'n2', hostName: 'studio', dnsName: 'studio.tail1234.ts.net', addresses: ['100.64.0.20'] })]
    expect(matchTailnetPeer(peers, '100.64.0.9')?.id).toBe('n1')
    expect(matchTailnetPeer(peers, '[fd7a::9]')?.id).toBe('n1')
    expect(matchTailnetPeer(peers, 'MAIN.tail1234.ts.net')?.id).toBe('n1')
    expect(matchTailnetPeer(peers, 'studio')?.id).toBe('n2')
    expect(matchTailnetPeer(peers, '192.168.1.10')).toBeNull()
    expect(matchTailnetPeer(peers, '')).toBeNull()
  })
})
