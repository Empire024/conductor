import { hostname } from 'node:os'
import type { GitHubAuthState, GitHubDevicePrompt, GitHubIdentity } from '../shared/remote-control'
import { generateDeviceKey, keyFingerprint, type DeviceKeyPair } from './device-key'
import type { SecretKeyValueStore, SecretVault } from './secret-store'

const TOKEN_SECRET = 'github.token'
const DEVICE_KEY_SECRET = 'github.deviceKey'
const IDENTITY_SETTING = 'github.identity'
const DEVICE_PUBLIC_SETTING = 'github.deviceKey.public'
const REMOTE_KEY_ID_SETTING = 'github.deviceKey.remoteId'

/**
 * `read:user` names the account; `admin:public_key` lets Conductor register this machine's device
 * key on the account and take it back off again at sign-out. The device key is the whole basis of
 * the same-account proof between machines, so its lifecycle has to be ours to manage.
 */
export const GITHUB_SCOPES = 'read:user admin:public_key'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const API_URL = 'https://api.github.com'

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
}

const parseJson = async (response: Response): Promise<Record<string, unknown>> => {
  const body = await response.text()
  try { return body ? JSON.parse(body) as Record<string, unknown> : {} } catch { return {} }
}

/**
 * Raised when this machine cannot ask GitHub who it is: the keychain will not hand the token back,
 * or GitHub has rejected it. Callers that hold a grace window for a flaky network must treat this
 * as a hard stop instead, because the account can never be confirmed by waiting.
 */
export class GitHubUnverifiableError extends Error {
  readonly accountUnverifiable = true
}

const NO_CREDENTIAL_STORE = 'This computer has no available credential store, so Conductor will not save the token. Sign in again once the OS keychain is unlocked.'
const KEY_LEFT_BEHIND = 'Signed out locally. Remove the "Conductor device" key from your GitHub SSH keys to finish revoking it.'

/** GitHub device flow plus the account-bound device key. Nothing here talks to the renderer. */
export class GitHubAuth {
  private pending: PendingDeviceFlow | null = null
  private message: string | null = null
  private cachedKeys: { at: number; keys: string[] } | null = null

  constructor(private readonly deps: GitHubAuthDependencies) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private wait(ms: number): Promise<void> { return this.deps.wait ? this.deps.wait(ms) : new Promise(resolve => setTimeout(resolve, ms)) }
  private machineName(): string { return this.deps.machineName || hostname() || 'Conductor machine' }

  identity(): GitHubIdentity | null {
    const stored = this.deps.store.getSetting(IDENTITY_SETTING)
    if (!stored) return null
    try {
      const parsed = JSON.parse(stored) as Partial<GitHubIdentity>
      return typeof parsed?.id === 'number' && typeof parsed.login === 'string'
        ? { id: parsed.id, login: parsed.login, name: parsed.name ?? null, avatarUrl: parsed.avatarUrl ?? null }
        : null
    } catch { return null }
  }

  token(): string | null {
    return this.identity() ? this.deps.vault.read(TOKEN_SECRET) : null
  }

  deviceKey(): DeviceKeyPair | null {
    const publicKey = this.deps.store.getSetting(DEVICE_PUBLIC_SETTING)
    const privateKeyPem = this.deps.vault.read(DEVICE_KEY_SECRET)
    if (!publicKey || !privateKeyPem) return null
    try { return { publicKey, privateKeyPem, fingerprint: keyFingerprint(publicKey) } } catch { return null }
  }

  state(): GitHubAuthState {
    const identity = this.identity()
    const signedIn = Boolean(identity && this.token())
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

  private fail(message: string): GitHubAuthState {
    this.pending = null
    this.message = message
    return this.publish()
  }

  /**
   * Starts the device flow and returns as soon as there is a code to show. The poll loop keeps
   * running in the background; the owner authorizes in their own browser, so Conductor never sees
   * a GitHub password.
   */
  async signIn(): Promise<GitHubAuthState> {
    if (this.pending) return this.state()
    this.message = null
    if (!this.deps.clientId) return this.fail('Set a GitHub OAuth app client ID before signing in.')
    if (!this.deps.vault.available()) return this.fail(NO_CREDENTIAL_STORE)
    let response: Response
    try {
      response = await this.deps.fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.deps.clientId, scope: GITHUB_SCOPES })
      })
    } catch (error) { return this.fail(`GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`) }
    const body = await parseJson(response)
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : ''
    const userCode = typeof body.user_code === 'string' ? body.user_code : ''
    if (!response.ok || !deviceCode || !userCode) {
      return this.fail(typeof body.error_description === 'string' ? body.error_description : 'GitHub refused to start the device flow.')
    }
    const interval = Math.max(1, Number(body.interval) || 5)
    const expiresIn = Math.max(60, Number(body.expires_in) || 900)
    this.pending = {
      deviceCode,
      cancelled: false,
      prompt: {
        userCode,
        verificationUri: typeof body.verification_uri === 'string' ? body.verification_uri : 'https://github.com/login/device',
        expiresAt: new Date(this.now() + expiresIn * 1000).toISOString(),
        interval
      }
    }
    const flow = this.pending
    void this.pump(flow).catch(error => { if (this.pending === flow) this.fail(error instanceof Error ? error.message : String(error)) })
    return this.publish()
  }

  cancelSignIn(): GitHubAuthState {
    if (this.pending) { this.pending.cancelled = true; this.pending = null; this.message = 'Sign-in cancelled.' }
    return this.publish()
  }

  private async pump(flow: PendingDeviceFlow): Promise<void> {
    let interval = flow.prompt.interval
    const deadline = Date.parse(flow.prompt.expiresAt)
    while (!flow.cancelled && this.pending === flow) {
      await this.wait(interval * 1000)
      if (flow.cancelled || this.pending !== flow) return
      if (this.now() > deadline) { this.fail('The GitHub sign-in code expired. Start again.'); return }
      const response = await this.deps.fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.deps.clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
      })
      const body = await parseJson(response)
      const token = typeof body.access_token === 'string' ? body.access_token : ''
      if (token) { await this.completeSignIn(flow, token); return }
      const error = typeof body.error === 'string' ? body.error : 'unexpected_response'
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') { interval = Math.max(interval + 5, Number(body.interval) || interval + 5); continue }
      this.fail(error === 'access_denied' ? 'The sign-in request was denied on GitHub.'
        : error === 'expired_token' ? 'The GitHub sign-in code expired. Start again.'
        : typeof body.error_description === 'string' ? body.error_description : 'GitHub declined the sign-in.')
      return
    }
  }

  private async completeSignIn(flow: PendingDeviceFlow, token: string): Promise<void> {
    const response = await this.deps.fetch(`${API_URL}/user`, { headers: this.headers(token) })
    const body = await parseJson(response)
    if (!response.ok || typeof body.id !== 'number' || typeof body.login !== 'string') {
      this.fail('GitHub accepted the sign-in but did not return an account.')
      return
    }
    if (flow.cancelled || this.pending !== flow) return
    const identity: GitHubIdentity = {
      id: body.id,
      login: body.login,
      name: typeof body.name === 'string' ? body.name : null,
      avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null
    }
    try { this.deps.vault.write(TOKEN_SECRET, token) }
    catch (error) { this.fail(error instanceof Error ? error.message : String(error)); return }
    this.deps.store.setSetting(IDENTITY_SETTING, JSON.stringify(identity))
    this.pending = null
    this.message = null
    this.cachedKeys = null
    try { await this.ensureDeviceKey() }
    catch (error) { this.message = `Signed in, but this machine's device key could not be registered on GitHub: ${error instanceof Error ? error.message : String(error)}` }
    this.publish()
  }

  private headers(token: string): Record<string, string> {
    return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Conductor' }
  }

  private async api(path: string, init: RequestInit = {}): Promise<{ response: Response; body: Record<string, unknown> | unknown[] }> {
    const token = this.token()
    if (!token) throw new GitHubUnverifiableError('Sign in to GitHub first')
    const response = await this.deps.fetch(`${API_URL}${path}`, {
      ...init,
      headers: { ...this.headers(token), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) }
    })
    if (response.status === 401) { this.forgetToken(); throw new GitHubUnverifiableError('GitHub rejected the stored token; sign in again.') }
    const text = await response.text()
    let body: Record<string, unknown> | unknown[] = {}
    try { if (text) body = JSON.parse(text) as Record<string, unknown> | unknown[] } catch { body = {} }
    return { response, body }
  }

  /** Registers this machine's Ed25519 key on the account, reusing it across restarts. */
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

  /**
   * The SSH keys on *this* account, read with this machine's own token. A peer is the same
   * account exactly when the key it signs with appears in this list, which is why the check
   * cannot be satisfied by presenting a token or by claiming a login.
   */
  async accountKeys(force = false): Promise<string[]> {
    if (!force && this.cachedKeys && this.now() - this.cachedKeys.at < 60000) return this.cachedKeys.keys
    const { response, body } = await this.api('/user/keys?per_page=100')
    // 403 here means the token lost the scope (or is being throttled): either way this machine
    // cannot prove the account, so it is reported as unverifiable rather than as a passing blip.
    if (!response.ok) {
      const message = `GitHub could not list the account keys (${response.status})`
      throw response.status === 403 ? new GitHubUnverifiableError(message) : new Error(message)
    }
    const keys = (Array.isArray(body) ? body : [])
      .map(entry => entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string' ? (entry as { key: string }).key : '')
      .filter(Boolean)
    this.cachedKeys = { at: this.now(), keys }
    return keys
  }

  private forgetToken(): void {
    this.deps.vault.delete(TOKEN_SECRET)
    this.deps.store.removeSetting(IDENTITY_SETTING)
    this.cachedKeys = null
  }

  /**
   * Removes the account key, then every local trace of the session. Local state goes even when
   * GitHub is unreachable, so signing out is never blocked by the network.
   */
  async signOut(): Promise<GitHubAuthState> {
    const remoteKeyId = this.deps.store.getSetting(REMOTE_KEY_ID_SETTING)
    let message: string | null = null
    if (remoteKeyId && this.token()) {
      try {
        const { response } = await this.api(`/user/keys/${encodeURIComponent(remoteKeyId)}`, { method: 'DELETE' })
        if (!response.ok && response.status !== 404) message = KEY_LEFT_BEHIND
      } catch { message = KEY_LEFT_BEHIND }
    }
    if (this.pending) { this.pending.cancelled = true; this.pending = null }
    this.forgetToken()
    this.deps.vault.delete(DEVICE_KEY_SECRET)
    this.deps.store.removeSetting(DEVICE_PUBLIC_SETTING)
    this.deps.store.removeSetting(REMOTE_KEY_ID_SETTING)
    this.message = message
    this.deps.signedOut?.()
    return this.publish()
  }
}
