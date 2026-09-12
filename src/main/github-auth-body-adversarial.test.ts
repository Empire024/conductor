import { describe, expect, it } from 'vitest'
import { GitHubAuth } from './github-auth'
import { MemoryVault } from './secret-store'

const fixture = (fetcher: typeof fetch) => {
  const values = new Map<string, string>()
  const vault = new MemoryVault()
  const store = { getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) }, removeSetting: (key: string) => { values.delete(key) } }
  const auth = new GitHubAuth({ store, vault, fetch: fetcher, clientId: 'review-client', wait: () => new Promise(() => {}) })
  return { auth, vault, store }
}
const delayedResponse = () => {
  let release!: (body: string) => void
  let reading!: () => void
  const started = new Promise<void>(resolve => { reading = resolve })
  const body = new Promise<string>(resolve => { release = resolve })
  const response = { ok: true, status: 200, text: () => { reading(); return body } } as Response
  return { response, started, release }
}

describe('GitHub response-body cancellation adversarial review', () => {
  it('cannot revive a cancelled sign-in while the device response body arrives', async () => {
    const delayed = delayedResponse()
    const f = fixture(async () => delayed.response)
    const operation = f.auth.signIn()
    await delayed.started
    f.auth.cancelSignIn()
    delayed.release(JSON.stringify({ device_code: 'synthetic-code', user_code: 'AAAA-BBBB', expires_in: 900, interval: 5 }))
    await operation
    expect(f.auth.state().phase).toBe('signed-out')
    expect(f.auth.state().prompt).toBeNull()
  })

  it('cannot restore device credentials after sign-out during the key response body', async () => {
    const delayed = delayedResponse()
    const f = fixture(async (_input, init) => init?.method === 'POST' ? delayed.response : new Response('[]'))
    f.vault.write('github.token', 'synthetic-review-token')
    f.store.setSetting('github.identity', JSON.stringify({ id: 42, login: 'review-owner', name: null, avatarUrl: null }))
    const operation = f.auth.ensureDeviceKey().then(() => 'resolved', () => 'rejected')
    await delayed.started
    await f.auth.signOut()
    delayed.release(JSON.stringify({ id: 123 }))
    expect(await operation).toBe('rejected')
    expect(f.auth.deviceKey()).toBeNull()
    expect(f.store.getSetting('github.deviceKey.remoteId')).toBeNull()
  })
})
