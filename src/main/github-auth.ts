import { hostname } from 'node:os'
import type { GitHubAuthState, GitHubDevicePrompt, GitHubIdentity } from '../shared/remote-control'
import { generateDeviceKey, keyFingerprint, type DeviceKeyPair } from './device-key'
import type { SecretKeyValueStore, SecretVault } from './secret-store'

const LEGACY_TOKEN_SECRET = 'github.token'
const CREDENTIALS_SECRET = 'github.credentials.v1'
const DEVICE_KEY_SECRET = 'github.deviceKey'
const IDENTITY_SETTING = 'github.identity'
const DEVICE_PUBLIC_SETTING = 'github.deviceKey.public'
const REMOTE_KEY_ID_SETTING = 'github.deviceKey.remoteId'

/**
 * `read:user` names the account; `admin:public_key` lets Conductor register this machine's device
 * key on the account and take it back off again at sign-out. `offline_access` asks for the
 * rotating refresh token used by an expiring-token OAuth app.
 */
export const GITHUB_SCOPES = 'read:user admin:public_key offline_access'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const API_URL = 'https://api.github.com'
const EXPIRY_SKEW_MS = 60_000
const REFRESH_BACKOFF_BASE_MS = 5_000
const REFRESH_BACKOFF_MAX_MS = 5 * 60_000

export interface GitHubAuthDependencies {
  vault: SecretVault
  store: SecretKeyValueStore
  fetch: typeof globalThis.fetch
  clientId: string
  machineName?: string
  now?(): number
  wait?(ms: number): Promise<void>
  changed?(state: GitHubAuthState): void
  /** Fired after the token is gone so paired peers and outbound connections are torn down too. */
  signedOut?(): void
}

interface PendingDeviceFlow {
  deviceCode: string
  prompt: GitHubDevicePrompt
  cancelled: boolean
  epoch: number
}

interface StoredCredentials {
  version: 1
  accessToken: string
  refreshToken: string | null
  accessTokenExpiresAt: number | null
  refreshTokenExpiresAt: number | null
  /** Null only while a newly rotated pair still needs its `/user` response checked. */
  accountId: number | null
}

interface AccessContext { token: string; epoch: number }

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const body = await response.text()
  try { return body ? JSON.parse(body) as Record<string, unknown> : {} } catch { return {} }
}

const futureTime = (now: number, seconds: unknown): number | null => {
  const value = Number(seconds)
  return Number.isFinite(value) && value > 0 ? now + value * 1000 : null
}

const identityFrom = (body: Record<string, unknown>): GitHubIdentity | null =>
  typeof body.id === 'number' && typeof body.login === 'string'
    ? {
        id: body.id,
        login: body.login,
        name: typeof body.name === 'string' ? body.name : null,
        avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null
      }
    : null

/** Hard credential failure, distinct from a network wobble that an offline grace may cover. */
export class GitHubUnverifiableError extends Error {
  readonly accountUnverifiable = true
}

const NO_CREDENTIAL_STORE = 'This computer has no available credential store, so Conductor will not save the token. Sign in again once the OS keychain is unlocked.'
const KEY_LEFT_BEHIND = 'Signed out locally. Remove the "Conductor device" key from your GitHub SSH keys to finish revoking it.'
const SESSION_EXPIRED = 'The GitHub session expired or was revoked; sign in again.'

/** GitHub device flow plus the account-bound device key. Nothing here talks to the renderer. */
export class GitHubAuth {
  private pending: PendingDeviceFlow | null = null
  private signingIn: Promise<GitHubAuthState> | null = null
  private renewing: Promise<StoredCredentials> | null = null
  private message: string | null = null
  private cachedKeys: { at: number; accountId: number; keys: string[] } | null = null
  private sessionEpoch = 0
  private refreshFailures = 0
  private refreshRetryAt = 0

  constructor(private readonly deps: GitHubAuthDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private wait(ms: number): Promise<void> { return this.deps.wait ? this.deps.wait(ms) : new Promise(resolve => setTimeout(resolve, ms)) }
  private machineName(): string { return this.deps.machineName || hostname() || 'Conductor machine' }

  private storedIdentity(): GitHubIdentity | null {
    const stored = this.deps.store.getSetting(IDENTITY_SETTING)
    if (!stored) return null
    try {
      const parsed = JSON.parse(stored) as Partial<GitHubIdentity>
      return typeof parsed?.id === 'number' && typeof parsed.login === 'string'
        ? { id: parsed.id, login: parsed.login, name: parsed.name ?? null, avatarUrl: parsed.avatarUrl ?? null }
        : null
    } catch { return null }
  }

  private readCredentials(): StoredCredentials | null {
    const stored = this.deps.vault.read(CREDENTIALS_SECRET)
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<StoredCredentials>
        if (parsed.version === 1 && typeof parsed.accessToken === 'string' && parsed.accessToken) {
          return {
            version: 1,
            accessToken: parsed.accessToken,
            refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken ? parsed.refreshToken : null,
            accessTokenExpiresAt: typeof parsed.accessTokenExpiresAt === 'number' && Number.isFinite(parsed.accessTokenExpiresAt) ? parsed.accessTokenExpiresAt : null,
            refreshTokenExpiresAt: typeof parsed.refreshTokenExpiresAt === 'number' && Number.isFinite(parsed.refreshTokenExpiresAt) ? parsed.refreshTokenExpiresAt : null,
            accountId: typeof parsed.accountId === 'number' ? parsed.accountId : null
          }
        }
      } catch { /* a corrupt bundle is unusable; the legacy slot may still be valid */ }
    }
    const legacy = this.deps.vault.read(LEGACY_TOKEN_SECRET)
    if (!legacy) return null
    return {
      version: 1,
      accessToken: legacy,
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      accountId: this.storedIdentity()?.id ?? null
    }
  }

  private writeCredentials(credentials: StoredCredentials): void {
    this.deps.vault.write(CREDENTIALS_SECRET, JSON.stringify(credentials))
    this.deps.vault.delete(LEGACY_TOKEN_SECRET)
  }

  identity(): GitHubIdentity | null {
    const credentials = this.readCredentials()
    const identity = this.storedIdentity()
    return credentials && identity && credentials.accountId === identity.id ? identity : null
  }

  token(): string | null { return this.identity() ? this.readCredentials()?.accessToken ?? null : null }

  deviceKey(): DeviceKeyPair | null {
    const publicKey = this.deps.store.getSetting(DEVICE_PUBLIC_SETTING)
    const privateKeyPem = this.deps.vault.read(DEVICE_KEY_SECRET)
    if (!publicKey || !privateKeyPem) return null
    try { return { publicKey, privateKeyPem, fingerprint: keyFingerprint(publicKey) } } catch { return null }
  }

  state(): GitHubAuthState {
    const identity = this.identity()
    const signedIn = Boolean(identity)
    return {
      phase: signedIn ? 'signed-in' : this.pending ? 'awaiting-authorization' : 'signed-out',
      identity: signedIn ? identity : null,
      prompt: this.pending?.prompt ?? null,
      deviceKeyFingerprint: this.deviceKey()?.fingerprint ?? null,
      secureStorageAvailable: this.deps.vault.available(),
      clientIdConfigured: Boolean(this.deps.clientId),
      message: this.message
    }
  }

  private publish(): GitHubAuthState {
    const state = this.state()
    this.deps.changed?.(state)
    return state
  }

  private fail(message: string, epoch?: number): GitHubAuthState {
    if (epoch !== undefined && epoch !== this.sessionEpoch) return this.state()
    this.pending = null
    this.message = message
    return this.publish()
  }

  private clearSession(message: string, notify = true): void {
    const hadSession = Boolean(this.deps.vault.read(CREDENTIALS_SECRET) || this.deps.vault.read(LEGACY_TOKEN_SECRET) || this.deps.store.getSetting(IDENTITY_SETTING))
    this.sessionEpoch++
    if (this.pending) this.pending.cancelled = true
    this.pending = null
    this.renewing = null
    this.deps.vault.delete(CREDENTIALS_SECRET)
    this.deps.vault.delete(LEGACY_TOKEN_SECRET)
    this.deps.store.removeSetting(IDENTITY_SETTING)
    this.cachedKeys = null
    this.refreshFailures = 0
    this.refreshRetryAt = 0
    this.message = message
    if (notify && hadSession) this.deps.signedOut?.()
  }

  private expireSession(message = SESSION_EXPIRED): never {
    this.clearSession(message)
    this.publish()
    throw new GitHubUnverifiableError(message)
  }

  signIn(): Promise<GitHubAuthState> {
    if (this.identity()) return Promise.resolve(this.state())
    if (this.pending) return Promise.resolve(this.state())
    if (this.signingIn) return this.signingIn
    this.message = null
    if (!this.deps.clientId) return Promise.resolve(this.fail('Set a GitHub OAuth app client ID before signing in.'))
    if (!this.deps.vault.available()) return Promise.resolve(this.fail(NO_CREDENTIAL_STORE))
    const epoch = ++this.sessionEpoch
    const operation = this.startSignIn(epoch)
    this.signingIn = operation
    void operation.finally(() => { if (this.signingIn === operation) this.signingIn = null }).catch(() => {})
    return operation
  }

  private async startSignIn(epoch: number): Promise<GitHubAuthState> {
    let response: Response
    try {
      response = await this.deps.fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.deps.clientId, scope: GITHUB_SCOPES })
      })
    } catch (error) {
      return this.fail(`GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`, epoch)
    }
    if (epoch !== this.sessionEpoch) return this.state()
    const body = await parseJson(response)
    if (epoch !== this.sessionEpoch) return this.state()
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : ''
    const userCode = typeof body.user_code === 'string' ? body.user_code : ''
    if (!response.ok || !deviceCode || !userCode) {
      return this.fail(typeof body.error_description === 'string' ? body.error_description : 'GitHub refused to start the device flow.', epoch)
    }
    const interval = Math.max(1, Number(body.interval) || 5)
    const expiresIn = Math.max(60, Number(body.expires_in) || 900)
    this.pending = {
      deviceCode,
      cancelled: false,
      epoch,
      prompt: {
        userCode,
        verificationUri: typeof body.verification_uri === 'string' ? body.verification_uri : 'https://github.com/login/device',
        expiresAt: new Date(this.now() + expiresIn * 1000).toISOString(),
        interval
      }
    }
    const flow = this.pending
    void this.pump(flow).catch(error => {
      if (this.pending === flow && flow.epoch === this.sessionEpoch) this.fail(error instanceof Error ? error.message : String(error), flow.epoch)
    })
    return this.publish()
  }

  cancelSignIn(): GitHubAuthState {
    if (this.pending || this.signingIn) {
      this.sessionEpoch++
      if (this.pending) this.pending.cancelled = true
      this.pending = null
      this.message = 'Sign-in cancelled.'
    }
    return this.publish()
  }

  private async pump(flow: PendingDeviceFlow): Promise<void> {
    let interval = flow.prompt.interval
    const deadline = Date.parse(flow.prompt.expiresAt)
    while (!flow.cancelled && this.pending === flow && flow.epoch === this.sessionEpoch) {
      await this.wait(interval * 1000)
      if (flow.cancelled || this.pending !== flow || flow.epoch !== this.sessionEpoch) return
      if (this.now() > deadline) { this.fail('The GitHub sign-in code expired. Start again.', flow.epoch); return }
      const response = await this.deps.fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.deps.clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
      })
      const body = await parseJson(response)
      if (flow.cancelled || this.pending !== flow || flow.epoch !== this.sessionEpoch) return
      if (typeof body.access_token === 'string' && body.access_token) { await this.completeSignIn(flow, body); return }
      const error = typeof body.error === 'string' ? body.error : 'unexpected_response'
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') { interval = Math.max(interval + 5, Number(body.interval) || interval + 5); continue }
      this.fail(error === 'access_denied' ? 'The sign-in request was denied on GitHub.'
        : error === 'expired_token' ? 'The GitHub sign-in code expired. Start again.'
        : typeof body.error_description === 'string' ? body.error_description : 'GitHub declined the sign-in.', flow.epoch)
      return
    }
  }

  private credentialsFrom(body: Record<string, unknown>, accountId: number | null): StoredCredentials | null {
    const accessToken = typeof body.access_token === 'string' ? body.access_token : ''
    if (!accessToken) return null
    return {
      version: 1,
      accessToken,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
      accessTokenExpiresAt: futureTime(this.now(), body.expires_in),
      refreshTokenExpiresAt: futureTime(this.now(), body.refresh_token_expires_in),
      accountId
    }
  }

  private async completeSignIn(flow: PendingDeviceFlow, tokenBody: Record<string, unknown>): Promise<void> {
    const credentials = this.credentialsFrom(tokenBody, null)
    if (!credentials) { this.fail('GitHub accepted the sign-in but returned no usable access token.', flow.epoch); return }
    const response = await this.deps.fetch(`${API_URL}/user`, { headers: this.headers(credentials.accessToken) })
    const body = await parseJson(response)
    if (flow.cancelled || this.pending !== flow || flow.epoch !== this.sessionEpoch) return
    const identity = identityFrom(body)
    if (!response.ok || !identity) { this.fail('GitHub accepted the sign-in but did not return an account.', flow.epoch); return }
    if (flow.cancelled || this.pending !== flow || flow.epoch !== this.sessionEpoch) return
    try { this.writeCredentials({ ...credentials, accountId: identity.id }) }
    catch (error) { this.fail(error instanceof Error ? error.message : String(error), flow.epoch); return }
    this.deps.store.setSetting(IDENTITY_SETTING, JSON.stringify(identity))
    this.pending = null
    this.message = null
    this.cachedKeys = null
    this.publish()
    try { await this.ensureDeviceKey() }
    catch (error) {
      if (flow.epoch !== this.sessionEpoch || !this.identity()) return
      this.message = `Signed in, but this machine's device key could not be registered on GitHub: ${error instanceof Error ? error.message : String(error)}`
    }
    if (flow.epoch === this.sessionEpoch) this.publish()
  }

  private headers(token: string): Record<string, string> {
    return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Conductor' }
  }

  private noteRefreshFailure(): void {
    this.refreshFailures++
    this.refreshRetryAt = this.now() + Math.min(REFRESH_BACKOFF_MAX_MS, REFRESH_BACKOFF_BASE_MS * 2 ** (this.refreshFailures - 1))
  }

  private resetRefreshBackoff(): void { this.refreshFailures = 0; this.refreshRetryAt = 0 }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.sessionEpoch) throw new GitHubUnverifiableError('The GitHub session changed while a request was in flight.')
  }

  private async readAccount(token: string, epoch: number): Promise<GitHubIdentity> {
    let response: Response
    try { response = await this.deps.fetch(`${API_URL}/user`, { headers: this.headers(token) }) }
    catch (error) {
      this.assertEpoch(epoch)
      this.noteRefreshFailure()
      throw new Error(`GitHub could not revalidate the refreshed account: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.assertEpoch(epoch)
    const body = await parseJson(response)
    this.assertEpoch(epoch)
    const identity = identityFrom(body)
    if (response.status === 401) this.expireSession()
    if (!response.ok || !identity) {
      this.noteRefreshFailure()
      throw new Error(`GitHub could not revalidate the refreshed account (${response.status}).`)
    }
    return identity
  }

  private async validateRotatedCredentials(credentials: StoredCredentials, expected: GitHubIdentity, epoch: number): Promise<StoredCredentials> {
    const identity = await this.readAccount(credentials.accessToken, epoch)
    if (identity.id !== expected.id) this.expireSession('GitHub returned a different account while refreshing. Sign in again before remote access can continue.')
    this.assertEpoch(epoch)
    const verified = { ...credentials, accountId: identity.id }
    this.writeCredentials(verified)
    this.deps.store.setSetting(IDENTITY_SETTING, JSON.stringify(identity))
    this.resetRefreshBackoff()
    this.message = null
    this.publish()
    return verified
  }

  private providerRefreshError(body: Record<string, unknown>, status: number): never {
    const code = typeof body.error === 'string' ? body.error : ''
    if (code === 'bad_refresh_token') this.expireSession()
    if (status >= 500 || status === 429) {
      const message = `GitHub could not refresh the session (${status}); it will retry after a short delay.`
      this.noteRefreshFailure()
      this.message = message
      this.publish()
      throw new Error(message)
    }
    const message = code === 'incorrect_client_credentials'
      ? 'GitHub rejected the configured OAuth client ID. Restore the client ID used to sign in or sign in again.'
      : `GitHub could not refresh the session${code ? ` (${code})` : ` (${status})`}.`
    this.noteRefreshFailure()
    this.message = message
    this.publish()
    throw new GitHubUnverifiableError(message)
  }

  private async refreshCredentials(credentials: StoredCredentials, expected: GitHubIdentity, epoch: number): Promise<StoredCredentials> {
    if (!credentials.refreshToken) this.expireSession()
    if (credentials.refreshTokenExpiresAt !== null && credentials.refreshTokenExpiresAt <= this.now()) this.expireSession()
    let response: Response
    try {
      response = await this.deps.fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        // Device-flow refresh deliberately has no client_secret. Native apps cannot protect one,
        // and GitHub does not require it for a token originally issued through the device flow.
        body: JSON.stringify({ client_id: this.deps.clientId, grant_type: 'refresh_token', refresh_token: credentials.refreshToken })
      })
    } catch (error) {
      this.assertEpoch(epoch)
      this.noteRefreshFailure()
      throw new Error(`GitHub could not refresh the session: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.assertEpoch(epoch)
    const body = await parseJson(response)
    this.assertEpoch(epoch)
    if (!response.ok || typeof body.error === 'string') this.providerRefreshError(body, response.status)
    const rotated = this.credentialsFrom(body, null)
    if (!rotated?.refreshToken) this.expireSession('GitHub returned an incomplete refreshed session. Sign in again.')
    this.assertEpoch(epoch)
    // The old refresh token is already dead. Persist the rotated pair first, with accountId:null,
    // so a crash cannot lose it and no API call can use it until `/user` revalidates the account.
    this.writeCredentials(rotated)
    return this.validateRotatedCredentials(rotated, expected, epoch)
  }

  private async accessContext(rejectedToken?: string): Promise<AccessContext> {
    for (let pass = 0; pass < 3; pass++) {
      const credentials = this.readCredentials()
      const identity = this.storedIdentity()
      if (!credentials || !identity) this.expireSession('Sign in to GitHub first.')
      const epoch = this.sessionEpoch
      const needsValidation = credentials.accountId !== identity.id
      const expiresSoon = credentials.accessTokenExpiresAt !== null && credentials.accessTokenExpiresAt - this.now() <= EXPIRY_SKEW_MS
      const rejected = rejectedToken === credentials.accessToken
      if (!needsValidation && !expiresSoon && !rejected) return { token: credentials.accessToken, epoch }

      if (this.refreshRetryAt > this.now()) {
        if (!needsValidation && !rejected && (credentials.accessTokenExpiresAt === null || credentials.accessTokenExpiresAt > this.now())) {
          return { token: credentials.accessToken, epoch }
        }
        throw new Error('GitHub session renewal is waiting before retrying after a provider or network error.')
      }

      if (!this.renewing) {
        const operation = needsValidation
          ? this.validateRotatedCredentials(credentials, identity, epoch)
          : this.refreshCredentials(credentials, identity, epoch)
        this.renewing = operation
        void operation.finally(() => { if (this.renewing === operation) this.renewing = null }).catch(() => {})
      }
      try { await this.renewing }
      catch (error) {
        // A network/provider wobble during proactive refresh does not invalidate an access token
        // that still has useful life. A hard credential error, a rejected token, an expired token,
        // or an unvalidated rotated pair still fails closed.
        const current = this.readCredentials()
        if (!(error instanceof GitHubUnverifiableError)
          && current?.accountId === identity.id
          && !rejected
          && (current.accessTokenExpiresAt === null || current.accessTokenExpiresAt > this.now())) {
          return { token: current.accessToken, epoch }
        }
        throw error
      }
      this.assertEpoch(epoch)
    }
    throw new GitHubUnverifiableError('GitHub could not establish a current session.')
  }

  private async api(path: string, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> | unknown[] }> {
    let context = await this.accessContext()
    let response = await this.deps.fetch(`${API_URL}${path}`, {
      ...init,
      headers: { ...this.headers(context.token), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) }
    })
    this.assertEpoch(context.epoch)
    if (response.status === 401) {
      context = await this.accessContext(context.token)
      response = await this.deps.fetch(`${API_URL}${path}`, {
        ...init,
        headers: { ...this.headers(context.token), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) }
      })
      this.assertEpoch(context.epoch)
      if (response.status === 401) this.expireSession()
    }
    const text = await response.text()
    let body: Record<string, unknown> | unknown[] = {}
    try { if (text) body = JSON.parse(text) as Record<string, unknown> | unknown[] } catch { body = {} }
    if (context.epoch !== this.sessionEpoch) {
      // The POST may have reached GitHub even though sign-out won while its response body was
      // arriving. Remove that newly registered public key with the stale request's own token, but
      // never restore its private key or mutate the current (possibly new) session.
      if (path === '/user/keys' && init.method === 'POST' && response.ok && !Array.isArray(body) && typeof body.id === 'number') {
        try {
          await this.deps.fetch(`${API_URL}/user/keys/${encodeURIComponent(String(body.id))}`, {
            method: 'DELETE', headers: this.headers(context.token)
          })
        } catch { /* best effort; local authorization is already gone */ }
      }
      this.assertEpoch(context.epoch)
    }
    return { response, body }
  }

  async ensureDeviceKey(): Promise<DeviceKeyPair> {
    const existing = this.deviceKey()
    const title = `Conductor device: ${this.machineName()}`
    const keys = await this.accountKeys(true)
    if (existing && keys.some(key => keyFingerprint(key) === existing.fingerprint)) return existing
    const pair = existing ?? generateDeviceKey(title)
    const { response, body } = await this.api('/user/keys', { method: 'POST', body: JSON.stringify({ title, key: pair.publicKey }) })
    if (!response.ok) throw new Error(`GitHub refused the device key (${response.status})`)
    this.deps.vault.write(DEVICE_KEY_SECRET, pair.privateKeyPem)
    this.deps.store.setSetting(DEVICE_PUBLIC_SETTING, pair.publicKey)
    const id = !Array.isArray(body) && typeof body.id === 'number' ? body.id : null
    if (id !== null) this.deps.store.setSetting(REMOTE_KEY_ID_SETTING, String(id))
    this.cachedKeys = null
    return pair
  }

  async accountKeys(force = false): Promise<string[]> {
    // A rotated pair is stored with accountId:null until `/user` confirms it. Use the prior stored
    // identity to enter accessContext so a temporary validation failure can recover on a later
    // call; identity() deliberately remains null until that succeeds.
    const identity = this.storedIdentity()
    if (!identity) throw new GitHubUnverifiableError('Sign in to GitHub first.')
    if (!force && this.cachedKeys && this.cachedKeys.accountId === identity.id && this.now() - this.cachedKeys.at < 60000) return this.cachedKeys.keys
    const { response, body } = await this.api('/user/keys?per_page=100')
    if (!response.ok) {
      const message = `GitHub could not list the account keys (${response.status})`
      throw response.status === 403 ? new GitHubUnverifiableError(message) : new Error(message)
    }
    const keys = (Array.isArray(body) ? body : [])
      .map(entry => entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string' ? (entry as { key: string }).key : '')
      .filter(Boolean)
    const currentIdentity = this.identity()
    if (!currentIdentity || currentIdentity.id !== identity.id) throw new GitHubUnverifiableError('The GitHub account changed while listing its device keys.')
    this.cachedKeys = { at: this.now(), accountId: identity.id, keys }
    return keys
  }

  async signOut(): Promise<GitHubAuthState> {
    const remoteKeyId = this.deps.store.getSetting(REMOTE_KEY_ID_SETTING)
    const credentials = this.readCredentials()
    const epoch = this.sessionEpoch + 1
    this.clearSession('', true)
    this.deps.vault.delete(DEVICE_KEY_SECRET)
    this.deps.store.removeSetting(DEVICE_PUBLIC_SETTING)
    this.deps.store.removeSetting(REMOTE_KEY_ID_SETTING)
    this.message = null
    this.publish()

    let message: string | null = null
    if (remoteKeyId && credentials?.accessToken) {
      try {
        const response = await this.deps.fetch(`${API_URL}/user/keys/${encodeURIComponent(remoteKeyId)}`, {
          method: 'DELETE', headers: this.headers(credentials.accessToken)
        })
        if (!response.ok && response.status !== 404) message = KEY_LEFT_BEHIND
      } catch { message = KEY_LEFT_BEHIND }
    }
    // A new sign-in may begin while GitHub answers the best-effort deletion. The old sign-out must
    // not overwrite the new session's state or message.
    if (this.sessionEpoch === epoch) {
      this.message = message
      return this.publish()
    }
    return this.state()
  }
}
