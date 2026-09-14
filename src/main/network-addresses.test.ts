import { describe, expect, it } from 'vitest'
import { orderAddresses } from './network-addresses.ts'

/**
 * The address a machine hands out in a pairing code decides whether the other one can reach it at
 * all, and a developer machine is full of addresses that no other machine is on.
 */
describe('which address a machine should give out', () => {
  it('puts the network a real cable or radio is on ahead of a virtual switch', () => {
    expect(orderAddresses({
      'vEthernet (WSL (Hyper-V firewall))': [{ family: 'IPv4', internal: false, address: '172.24.224.1' }],
      'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.0.205' }],
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
    })).toEqual(['192.168.0.205', '172.24.224.1'])
  })

  it('keeps a virtual address rather than dropping it, since some owners link machines over one', () => {
    expect(orderAddresses({
      'Docker Desktop': [{ family: 'IPv4', internal: false, address: '10.10.0.1' }]
    })).toEqual(['10.10.0.1'])
  })

  it('ignores loopback and anything that is not IPv4', () => {
    expect(orderAddresses({
      'Wi-Fi': [
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '192.168.1.7' }
      ],
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
    })).toEqual(['192.168.1.7'])
  })
})
