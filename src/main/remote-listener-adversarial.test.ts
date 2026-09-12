import { describe, expect, it } from 'vitest'
import { RemoteControlServer } from './remote-control-server'
import { RemotePeers } from './remote-peers'
import { StoredSecretVault } from './secret-store'
import type { RemoteControlHost } from './remote-control-host'

function fixture() {
  const values = new Map<string, string>()
  const store = { getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) }, removeSetting: (key: string) => { values.delete(key) } }
  const vault = new StoredSecretVault(store, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const peers = new RemotePeers({ store, accountId: () => 42, accountLogin: () => 'owner', accountKeys: async () => [], projects: () => [] })
  peers.updateSettings({ enabled: true, port: 0 })
  const server = new RemoteControlServer({ peers, host: {} as RemoteControlHost, store, vault, machineName: () => 'test', accountLogin: () => 'owner' })
  return { peers, server }
}

describe('remote listener lifecycle adversarial review', () => {
  it('a newer disable defeats an in-flight listener start', async () => {
    const { peers, server } = fixture()
    try {
      const enabling = server.apply()
      peers.updateSettings({ enabled: false })
      const disabling = server.apply()
      await Promise.all([enabling, disabling])
      expect(server.getStatus().listening).toBe(false)
      expect(server.getStatus().endpoint).toBeNull()
    } finally { await server.close() }
  })

  it('closing during startup cannot leave a listener alive', async () => {
    const { server } = fixture()
    try {
      await Promise.all([server.apply(), server.close()])
      expect(server.getStatus().listening).toBe(false)
      expect(server.getStatus().endpoint).toBeNull()
    } finally { await server.close() }
  })
})
