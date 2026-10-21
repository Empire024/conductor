import { createSocket } from 'node:dgram'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveBindHost } from './remote-control-server'
import { installLoopbackGuard, isLoopbackHost, loopbackBindArgs, loopbackListenArgs, loopbackOnly } from './test-loopback-guard'

describe('loopback guard for test instances', () => {
  it('applies to automation profiles unless the network is asked for explicitly', () => {
    expect(loopbackOnly({ CONDUCTOR_TEST_USER_DATA: 'C:\\t' })).toBe(true)
    expect(loopbackOnly({ CONDUCTOR_TEST_USER_DATA: 'C:\\t', CONDUCTOR_TEST_ALLOW_NETWORK: '1' })).toBe(false)
    expect(loopbackOnly({})).toBe(false)
  })

  it('knows loopback when it sees it', () => {
    for (const host of ['127.0.0.1', '127.5.0.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ['0.0.0.0', '::', '192.168.1.4', '100.64.0.7', 'fd7a:115c:a1e0::1', '']) expect(isLoopbackHost(host)).toBe(false)
  })

  it('rewrites every listen() form that would reach beyond this machine', () => {
    const callback = (): void => {}
    expect(loopbackListenArgs([0])).toEqual([0, '127.0.0.1'])
    expect(loopbackListenArgs([8787, '::', callback])).toEqual([8787, '127.0.0.1', callback])
    expect(loopbackListenArgs([8787, '0.0.0.0', 511, callback])).toEqual([8787, '127.0.0.1', 511, callback])
    expect(loopbackListenArgs([8787, 511, callback])).toEqual([8787, '127.0.0.1', 511, callback])
    expect(loopbackListenArgs(['8787', '100.64.0.7'])).toEqual(['8787', '127.0.0.1'])
    expect(loopbackListenArgs([])).toEqual([0, '127.0.0.1'])
    expect(loopbackListenArgs([callback])).toEqual([0, '127.0.0.1', callback])
    expect(loopbackListenArgs([{ port: 0, host: '::', ipv6Only: false }])).toEqual([{ port: 0, host: '127.0.0.1', ipv6Only: false }])
    expect(loopbackListenArgs([{ port: 4000 }, callback])).toEqual([{ port: 4000, host: '127.0.0.1' }, callback])
  })

  it('leaves loopback listeners, pipes and handles alone', () => {
    const asked = ['127.0.0.1', '::1', 'localhost']
    for (const host of asked) { const args = [0, host]; expect(loopbackListenArgs(args)).toBe(args) }
    const pipe = ['\\\\.\\pipe\\conductor-runtime-host']
    expect(loopbackListenArgs(pipe)).toBe(pipe)
    const options = [{ path: '/tmp/socket' }]
    expect(loopbackListenArgs(options)).toBe(options)
    const handle = [{ fd: 3 }]
    expect(loopbackListenArgs(handle)).toBe(handle)
  })

  it('rewrites UDP binds to the loopback of their family', () => {
    expect(loopbackBindArgs([], 'udp4')).toEqual([0, '127.0.0.1'])
    expect(loopbackBindArgs([5351], 'udp4')).toEqual([5351, '127.0.0.1'])
    expect(loopbackBindArgs([0, '0.0.0.0'], 'udp4')).toEqual([0, '127.0.0.1'])
    expect(loopbackBindArgs([0, '::'], 'udp6')).toEqual([0, '::1'])
    expect(loopbackBindArgs([{ port: 0 }], 'udp4')).toEqual([{ port: 0, address: '127.0.0.1' }])
    const loop = [0, '127.0.0.1']
    expect(loopbackBindArgs(loop, 'udp4')).toBe(loop)
  })

  it('phone access and remote control bind loopback on every exposure in a test instance', () => {
    const test = { CONDUCTOR_TEST_USER_DATA: 'C:\\t' }
    expect(resolveBindHost({ exposure: 'network' }, null, test)).toBe('127.0.0.1')
    expect(resolveBindHost({ exposure: 'tailscale' }, '100.64.0.7', test)).toBe('127.0.0.1')
    // No tailnet address still means nothing listens, test instance or not.
    expect(resolveBindHost({ exposure: 'tailscale' }, null, test)).toBeNull()
    expect(resolveBindHost({ exposure: 'network' }, null, {})).toBe('0.0.0.0')
    expect(resolveBindHost({ exposure: 'network' }, null, { ...test, CONDUCTOR_TEST_ALLOW_NETWORK: '1' })).toBe('0.0.0.0')
  })

  describe('installed in a process', () => {
    const directory = mkdtempSync(join(tmpdir(), 'loopback-guard-'))
    const logPath = join(directory, 'loopback-guard.log')
    const servers: Server[] = []
    afterAll(async () => {
      await Promise.all(servers.map(server => new Promise(done => server.close(done))))
      rmSync(directory, { recursive: true, force: true })
    })
    const listen = (...args: unknown[]): Promise<AddressInfo> => new Promise((resolve, reject) => {
      const server = createServer()
      servers.push(server)
      server.once('error', reject)
      ;(server.listen as (...values: unknown[]) => Server)(...args, () => resolve(server.address() as AddressInfo))
    })

    it('a listener that asks for every interface, or for the wildcard, gets loopback and is recorded', async () => {
      expect(installLoopbackGuard({ logPath })).toBe(true)
      expect(installLoopbackGuard({ logPath })).toBe(false)
      expect((await listen(0)).address).toBe('127.0.0.1')
      expect((await listen(0, '::')).address).toBe('127.0.0.1')
      expect((await listen({ port: 0, host: '0.0.0.0' })).address).toBe('127.0.0.1')
      const udp = createSocket('udp4')
      const bound = await new Promise<AddressInfo>(resolve => udp.bind(0, () => resolve(udp.address())))
      udp.close()
      expect(bound.address).toBe('127.0.0.1')
      const log = readFileSync(logPath, 'utf8')
      expect(log).toMatch(/listen asked for \(every interface\); bound to loopback/)
      expect(log).toMatch(/listen asked for ::; bound to loopback/)
      expect(log).toMatch(/udp bind \(udp4\) asked for \(every interface\)/)
    })
  })
})
