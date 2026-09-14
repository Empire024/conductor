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
