import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { isPrivateAddress, releasePortMapping, requestPortMapping, PortMappingError } from './port-mapping.ts'

/**
 * A router that answers, driven against a real HTTP server pretending to be one.
 *
 * The part worth testing is not the discovery - that is the network's business - but what happens
 * after a router does answer: whether its description is read correctly, whether the mapping asks
 * for the right thing, and whether the two answers that mean "this will never work" are recognised
 * as such instead of being reported as an ordinary failure.
 */

const running: Server[] = []

afterEach(async () => {
  while (running.length) await new Promise<void>(resolve => running.pop()?.close(() => resolve()))
})

interface FakeRouter {
  location: string
  calls: Array<{ action: string; body: string }>
}

async function router(options: { externalAddress?: string; refuse?: string; service?: string } = {}): Promise<FakeRouter> {
  const calls: FakeRouter['calls'] = []
  const service = options.service ?? 'urn:schemas-upnp-org:service:WANIPConnection:1'
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/xml' })
      response.end(
        '<?xml version="1.0"?><root><device><serviceList><service>' +
        `<serviceType>${service}</serviceType>` +
        '<controlURL>/upnp/control/wan</controlURL>' +
        '</service></serviceList></device></root>')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const action = /<u:(\w+)/.exec(body)?.[1] ?? ''
      calls.push({ action, body })
      if (options.refuse && action === 'AddPortMapping') {
        response.writeHead(500, { 'content-type': 'text/xml' })
        response.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${options.refuse}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`)
        return
      }
      response.writeHead(200, { 'content-type': 'text/xml' })
      response.end(action === 'GetExternalIPAddress'
        ? `<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>${options.externalAddress ?? '203.0.113.9'}</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`
        : '<s:Envelope><s:Body><u:AddPortMappingResponse></u:AddPortMappingResponse></s:Body></s:Envelope>')
    })
  })
  running.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { location: `http://127.0.0.1:${port}/desc.xml`, calls }
}

describe('opening a port on the router', () => {
  it('knows which addresses the public internet can reach', () => {
    expect(isPrivateAddress('192.168.0.1')).toBe(true)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('172.16.0.1')).toBe(true)
    expect(isPrivateAddress('172.32.0.1')).toBe(false)
    expect(isPrivateAddress('169.254.1.1')).toBe(true)
    // What an internet provider hands out when its customers share one public address.
    expect(isPrivateAddress('100.64.0.1')).toBe(true)
    expect(isPrivateAddress('100.128.0.1')).toBe(false)
    expect(isPrivateAddress('203.0.113.9')).toBe(false)
    expect(isPrivateAddress('not an address')).toBe(true)
  })

  it('reads a router description, asks for the port, and reports the address that reaches it', async () => {
    const fake = await router()
    const mapping = await requestPortMapping({ port: 8787, locations: [fake.location], leaseSeconds: 600 })

    expect(mapping.externalAddress).toBe('203.0.113.9')
    expect(mapping.externalPort).toBe(8787)
    expect(fake.calls.map(call => call.action)).toEqual(['GetExternalIPAddress', 'AddPortMapping'])
    const request = fake.calls[1]!.body
    expect(request).toContain('<NewExternalPort>8787</NewExternalPort>')
    expect(request).toContain('<NewInternalPort>8787</NewInternalPort>')
    expect(request).toContain('<NewProtocol>TCP</NewProtocol>')
    // A lease, so a mapping nobody takes down disappears on its own.
    expect(request).toContain('<NewLeaseDuration>600</NewLeaseDuration>')

    await releasePortMapping(mapping)
    expect(fake.calls[2]?.action).toBe('DeletePortMapping')
  })

  it('refuses to call a mapping a success when the router is itself behind the provider', async () => {
    const fake = await router({ externalAddress: '100.70.1.4' })
    await expect(requestPortMapping({ port: 8787, locations: [fake.location] }))
      .rejects.toMatchObject({ reason: 'carrier-nat' })
    // Nothing was asked for: a forwarded port behind carrier NAT would only look like it worked.
    expect(fake.calls.map(call => call.action)).toEqual(['GetExternalIPAddress'])
  })

  it('names the router refusal the owner can act on', async () => {
    const fake = await router({ refuse: '718' })
    await expect(requestPortMapping({ port: 8787, locations: [fake.location] }))
      .rejects.toThrow(/already forwards that port/)
  })

  it('will not follow a router that describes itself somewhere off this network', async () => {
    await expect(requestPortMapping({ port: 8787, locations: ['http://203.0.113.10/desc.xml'] }))
      .rejects.toBeInstanceOf(PortMappingError)
  })

  it('reports a router with no forwarding service rather than hanging on it', async () => {
    const fake = await router({ service: 'urn:schemas-upnp-org:service:Layer3Forwarding:1' })
    await expect(requestPortMapping({ port: 8787, locations: [fake.location] }))
      .rejects.toMatchObject({ reason: 'no-router' })
  })
})
