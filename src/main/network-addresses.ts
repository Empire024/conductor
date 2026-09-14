import { networkInterfaces } from 'node:os'

/**
 * Which of this machine's addresses another machine could actually dial.
 *
 * A developer machine has more addresses than it has networks: Docker, WSL, Hyper-V and the like
 * each add a virtual switch with a real-looking IPv4 address that nothing outside this computer is
 * on. Handing one of those out - in a pairing code, or as the address of a relay - produces a link
 * that cannot work and an error that says nothing about why, so the ones on a real network come
 * first and the virtual ones are kept only as a last resort.
 *
 * They are kept rather than dropped because an overlay network is sometimes exactly how the owner
 * connects their machines, and an address that only some machines can reach still beats none.
 */

/** Adapter names Windows, macOS and Linux give to switches that are local to this machine. */
const VIRTUAL_ADAPTER = /vEthernet|Hyper-V|VirtualBox|VMware|Parallels|WSL|Docker|bridge\d|virbr|utun|TAP-|Loopback/i

/** The ordering itself, so it can be exercised without the machine the test happens to run on. */
export function orderAddresses(interfaces: Record<string, Array<{ family: string; internal: boolean; address: string }> | undefined>): string[] {
  const real: string[] = []
  const virtual: string[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (VIRTUAL_ADAPTER.test(name)) virtual.push(entry.address)
      else real.push(entry.address)
    }
  }
  return [...real, ...virtual]
}

export function localAddresses(): string[] {
  return orderAddresses(networkInterfaces())
}

/** The one address to name when only one will do: this machine on the network it really is on. */
export function primaryAddress(): string | null {
  return localAddresses()[0] ?? null
}

/**
 * This machine's addresses on the public IPv6 internet, stable ones first.
 *
 * On a connection with no public IPv4 - which is now ordinary, and is what an internet provider
 * hands out as DS-Lite - these are the only addresses another machine can reach from outside. There
 * is nothing to forward and no port to map: the address belongs to this machine already, and the
 * router only has to stop refusing traffic to it.
 *
 * Which of them to advertise matters. Windows and macOS rotate temporary addresses for outgoing
 * traffic, so an address picked at random may be gone tomorrow, while the one a router handed out
 * over DHCPv6 or one built from the hardware address stays. Neither origin is visible from here, so
 * they are ranked by what they look like: a short suffix is a router's assignment, ff:fe in the
 * middle is built from the adapter, and anything else is assumed to rotate.
 */
export function globalIpv6Addresses(interfaces = networkInterfaces()): string[] {
  const scored: Array<{ address: string; rank: number }> = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv6' || entry.internal) continue
      const address = entry.address.toLowerCase()
      // Link-local and unique-local addresses are not reachable from off this network.
      if (address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) continue
      if (VIRTUAL_ADAPTER.test(name)) continue
      const assigned = /::[0-9a-f]{1,4}$/.test(address)
      const hardware = address.includes('ff:fe')
      scored.push({ address: entry.address, rank: assigned ? 0 : hardware ? 1 : 2 })
    }
  }
  return scored.sort((left, right) => left.rank - right.rank).map(entry => entry.address)
}

/** The hardware address of the interface this machine is really on, which is what a router's
 *  IPv6 exposure table asks for - it follows the device rather than whatever address it holds. */
export function primaryMacAddress(interfaces = networkInterfaces()): string | null {
  const primary = primaryAddress()
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_ADAPTER.test(name)) continue
    for (const entry of entries ?? []) {
      if (entry.address === primary && entry.mac && entry.mac !== '00:00:00:00:00:00') return entry.mac.toUpperCase()
    }
  }
  return null
}
