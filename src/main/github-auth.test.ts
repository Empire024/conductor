import { afterEach, describe, expect, it, vi } from 'vitest'
import { GITHUB_SCOPES, GitHubAuth, GitHubUnverifiableError } from './github-auth'
import { keyFingerprint } from './device-key'
import { MemoryVault, StoredSecretVault, type SecretCipher, type SecretKeyValueStore } from './secret-store'

class MapStore implements SecretKeyValueStore {
  readonly values = new Map<string, string>()
  getSetting(key: string): string | null { return this.values.get(key) ?? null }
  setSetting(key: string, value: string): void { this.values.set(key, value) }
  removeSetting(key: string): void { this.values.delete(key) }
  dump(): string { return [...this.values.entries()].map(([key, value]) => `${key}=${value}`).join('\n') }
}

/** Stands in for Electron safeStorage: reversible, but never the plaintext. */
const reversibleCipher: SecretCipher = {
  available: () => true,
  encrypt: value => Buffer.from('enc:' + Buffer.from(value, 'utf8').toString('hex'), 'utf8'),
  decrypt: value => Buffer.from(value.toString('utf8').replace(/^enc:/, ''), 'hex').toString('utf8')
}

interface Route { status?: number; body: unknown }

function fixture(options: { routes?: Record<string, Route | Route[]>; vaultReady?: boolean; clientId?: string } = {}) {
  const store = new MapStore()
  const vault = options.vaultReady === false ? new MemoryVault(false) : new StoredSecretVault(store, reversibleCipher)
  const keys: Array<{ id: number; key: string; title: string }> = []
  const calls: Array<{ url: string; method: string; body: unknown; authorization: string | undefined }> = []
  const queues = new Map<string, Route[]>()
  for (const [url, route] of Object.entries(options.routes ?? {})) queues.set(url, Array.isArray(route) ? [...route] : [route])
  const signedOut = vi.fn()

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body, authorization: headers.Authorization })
    const queued = queues.get(url)
    if (queued?.length) {
      const route = queued.length > 1 ? queued.shift()! : queued[0]!
      return new Response(JSON.stringify(route.body), { status: route.status ?? 200 })
    }
    if (url.endsWith('/user/keys?per_page=100')) return new Response(JSON.stringify(keys), { status: 200 })
    if (url.endsWith('/user/keys') && init?.method === 'POST') {
      const entry = { id: keys.length + 1, key: String((body as { key: string }).key), title: String((body as { title: string }).title) }
      keys.push(entry)
      return new Response(JSON.stringify(entry), { status: 201 })
    }
    if (/\/user\/keys\/\d+$/.test(url) && init?.method === 'DELETE') {
      const id = Number(url.split('/').pop())
      const index = keys.findIndex(entry => entry.id === id)
      if (index >= 0) keys.splice(index, 1)
      return new Response('', { status: 204 })
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  })

  const auth = new GitHubAuth({
    store, vault, fetch: fetchMock as unknown as typeof globalThis.fetch,
    clientId: options.clientId === undefined ? 'Iv1.test-client' : options.clientId,
    machineName: 'Test Desktop',
    wait: async () => {},
    signedOut
  })
  return { store, vault, auth, calls, keys, fetchMock, signedOut }
}

const DEVICE_CODE = { device_code: 'device-123', user_code: 'WXYZ-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }
const USER = { id: 4242, login: 'Empire024', name: 'Owner', avatar_url: 'https://avatars/1' }
const routes = (accessToken: Route[] | Route) => ({
  'https://github.com/login/device/code': { body: DEVICE_CODE },
  'https://github.com/login/oauth/access_token': accessToken,
  'https://api.github.com/user': { body: USER }
})

const signedIn = async (auth: GitHubAuth): Promise<void> => {
  await auth.signIn()
  await vi.waitFor(() => expect(auth.state().phase).toBe('signed-in'), { timeout: 2000 })
}

afterEach(() => vi.useRealTimers())

describe('signing in with the GitHub device flow', () => {
  it('shows the owner a code to enter and never asks for a password', async () => {
    const fix = fixture({ routes: routes([{ body: { error: 'authorization_pending' } }, { body: { access_token: 'gho_secret' } }]) })
    const state = await fix.auth.signIn()
    expect(state.phase).toBe('awaiting-authorization')
    expect(state.prompt).toMatchObject({ userCode: 'WXYZ-1234', verificationUri: 'https://github.com/login/device' })
    const start = fix.calls.find(call => call.url.endsWith('/login/device/code'))
    expect((start?.body as { scope: string }).scope).toBe(GITHUB_SCOPES)
    // Nothing in the flow ever transports a password or reads one from the owner.
    expect(JSON.stringify(fix.calls)).not.toMatch(/password/i)
    await vi.waitFor(() => expect(fix.auth.state().phase).toBe('signed-in'))
  })

  it('stores the token only as ciphertext in the credential store, never in the settings table', async () => {
    const fix = fixture({ routes: routes({ body: { access_token: 'gho_super_secret_value' } }) })
    await signedIn(fix.auth)
    expect(fix.auth.token()).toBe('gho_super_secret_value')
    expect(fix.store.dump()).not.toContain('gho_super_secret_value')
    expect(fix.store.dump()).not.toContain('PRIVATE KEY')
    expect(fix.auth.identity()).toMatchObject({ id: 4242, login: 'Empire024' })
  })

  it('registers this machine device key on the account and reuses it afterwards', async () => {
    const fix = fixture({ routes: routes({ body: { access_token: 'gho_token' } }) })
    await signedIn(fix.auth)
    const key = fix.auth.deviceKey()
    expect(key).not.toBeNull()
    expect(fix.keys).toHaveLength(1)
    expect(fix.keys[0]).toMatchObject({ title: 'Conductor device: Test Desktop' })
    expect(keyFingerprint(fix.keys[0]!.key)).toBe(key!.fingerprint)
    await fix.auth.ensureDeviceKey()
    expect(fix.keys).toHaveLength(1)
    expect(await fix.auth.accountKeys(true)).toEqual([key!.publicKey])
  })

  it('refuses to sign in at all when the OS credential store is unavailable', async () => {
    const fix = fixture({ routes: routes({ body: { access_token: 'gho_token' } }), vaultReady: false })
    const state = await fix.auth.signIn()
    expect(state.phase).toBe('signed-out')
    expect(state.secureStorageAvailable).toBe(false)
    expect(state.message).toMatch(/credential store/)
    expect(fix.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to start without a configured client ID', async () => {
    const fix = fixture({ clientId: '' })
    const state = await fix.auth.signIn()
    expect(state.clientIdConfigured).toBe(false)
    expect(state.message).toMatch(/client ID/)
  })

  it.each([
    ['access_denied', /denied on GitHub/],
    ['expired_token', /expired/]
  ])('reports %s plainly and stays signed out', async (error, expected) => {
    const fix = fixture({ routes: routes({ body: { error } }) })
    await fix.auth.signIn()
    await vi.waitFor(() => expect(fix.auth.state().message).toMatch(expected))
    expect(fix.auth.state().phase).toBe('signed-out')
    expect(fix.auth.token()).toBeNull()
  })

  it('backs off when GitHub asks it to slow down instead of giving up', async () => {
    const fix = fixture({ routes: routes([{ body: { error: 'slow_down', interval: 10 } }, { body: { access_token: 'gho_token' } }]) })
    await signedIn(fix.auth)
    expect(fix.auth.token()).toBe('gho_token')
  })

  it('can be cancelled while the owner is still deciding', async () => {
    const fix = fixture({ routes: routes({ body: { error: 'authorization_pending' } }) })
    await fix.auth.signIn()
    const state = fix.auth.cancelSignIn()
    expect(state.phase).toBe('signed-out')
    expect(state.message).toMatch(/cancelled/i)
  })
})

describe('signing out', () => {
  it('removes the account key and every local trace, and tells the rest of the app', async () => {
    const fix = fixture({ routes: routes({ body: { access_token: 'gho_token' } }) })
    await signedIn(fix.auth)
    const state = await fix.auth.signOut()
    expect(state.phase).toBe('signed-out')
    expect(state.identity).toBeNull()
    expect(state.deviceKeyFingerprint).toBeNull()
    expect(fix.auth.token()).toBeNull()
    expect(fix.keys).toHaveLength(0)
    expect(fix.store.dump()).not.toContain('gho_token')
    expect(fix.signedOut).toHaveBeenCalledOnce()
  })

  it('still clears local state when GitHub cannot be reached, and says the key is left behind', async () => {
    const fix = fixture({ routes: routes({ body: { access_token: 'gho_token' } }) })
    await signedIn(fix.auth)
    fix.fetchMock.mockRejectedValue(new Error('offline'))
    const state = await fix.auth.signOut()
    expect(state.phase).toBe('signed-out')
    expect(fix.auth.token()).toBeNull()
    expect(fix.auth.deviceKey()).toBeNull()
    expect(state.message).toMatch(/Remove the "Conductor device" key/)
  })

  it('reports a credential it cannot use as unverifiable, not as a passing network fault', async () => {
    // Whoever holds a grace window for an unreachable GitHub must be able to tell these apart:
    // waiting cannot turn an unusable credential into a confirmed account.
    // Signing in first, then breaking the key listing: the first answer is consumed by sign-in.
    const afterSignIn = async (status: number): Promise<Error> => {
      const fix = fixture({ routes: { ...routes({ body: { access_token: 'gho_token' } }), 'https://api.github.com/user/keys?per_page=100': [{ body: [] }, { status, body: { message: 'no' } }] } })
      await signedIn(fix.auth)
      return fix.auth.accountKeys(true).then(() => new Error('unexpectedly succeeded'), error => error as Error)
    }
    // No token to ask with at all.
    await expect(fixture().auth.accountKeys(true)).rejects.toBeInstanceOf(GitHubUnverifiableError)
    // GitHub rejected the credential, or it no longer carries the scope.
    expect(await afterSignIn(401)).toBeInstanceOf(GitHubUnverifiableError)
    expect(await afterSignIn(403)).toBeInstanceOf(GitHubUnverifiableError)
    // A server-side wobble is a transient fault the grace window is allowed to ride out.
    const transient = await afterSignIn(502)
    expect(transient).toBeInstanceOf(Error)
    expect(transient).not.toBeInstanceOf(GitHubUnverifiableError)
  })

  it('never puts the token in a message it hands back to a caller', async () => {
    const fix = fixture({ routes: { ...routes({ body: { access_token: 'gho_supersecret' } }), 'https://api.github.com/user/keys?per_page=100': { status: 500, body: { message: 'boom' } } } })
    await signedIn(fix.auth)
    const message = await fix.auth.accountKeys(true).then(() => '', error => (error as Error).message)
    expect(message).not.toContain('gho_supersecret')
    expect(fix.auth.state().message ?? '').not.toContain('gho_supersecret')
    expect(fix.store.dump()).not.toContain('gho_supersecret')
  })

  it('forgets a token GitHub has already rejected', async () => {
    const fix = fixture({ routes: routes({ body: { access_token: 'gho_token' } }) })
    await signedIn(fix.auth)
    fix.fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(fix.auth.accountKeys(true)).rejects.toThrow(/sign in again/)
    expect(fix.auth.token()).toBeNull()
    expect(fix.auth.state().phase).toBe('signed-out')
  })
})
