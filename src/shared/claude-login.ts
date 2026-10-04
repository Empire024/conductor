/**
 * Provider login from Settings and from the phone (docs/verification/2026-10-04-claude-logout.md):
 * a long-lived Claude token (`claude setup-token`) that Conductor stores encrypted and hands every
 * Claude CLI it starts, and a login flow Conductor runs in its own PTY so the owner can sign in from
 * the phone. Nothing in these shapes ever carries a token or an authorization code.
 */

export type LoginProvider = 'claude' | 'codex'
/** login: `claude auth login`; setup-token: `claude setup-token`; device: `codex login --device-auth`. */
export type LoginMode = 'login' | 'setup-token' | 'device'
export type LoginFlowPhase = 'starting' | 'awaiting-code' | 'awaiting-device' | 'verifying' | 'succeeded' | 'failed' | 'expired' | 'cancelled'
export type LoginOrigin = 'desktop' | 'phone'

export interface LoginFlowView {
  id: string
  provider: LoginProvider
  mode: LoginMode
  phase: LoginFlowPhase
  /** Where to sign in: the provider's own authorization page. */
  url: string | null
  /** Codex device auth: the one-time code the owner types on the provider's page. */
  userCode: string | null
  /** What happened, in words; never CLI output beyond a whitelisted error line. */
  message: string | null
  origin: LoginOrigin
  startedAt: string
  expiresAt: string
  /** Whether the single code this flow accepts has been used. */
  codeUsed: boolean
}

export interface ClaudeTokenStatus {
  /** A token is stored. */
  set: boolean
  /** A token is stored and not rejected: new Claude processes use it. */
  active: boolean
  createdAt: string | null
  expiresAt: string | null
  rejectedAt: string | null
  rejectedReason: string | null
  /** The OS credential store is available, so a token can be saved. */
  storageAvailable: boolean
  /** The owner set CLAUDE_CODE_OAUTH_TOKEN for Conductor itself; that one wins. */
  environmentOverride: boolean
}

export interface ProviderLoginState {
  token: ClaudeTokenStatus
  flow: LoginFlowView | null
  /** Providers whose login is lost right now (provider-auth.ts outages). */
  outages: Array<{ provider: LoginProvider; since: string; tabs: number }>
}

export const LOGIN_TIMEOUT_MS = 10 * 60_000

export interface ProviderLoginBridge {
  state(): Promise<ProviderLoginState>
  start(request: { provider: LoginProvider; mode: LoginMode }): Promise<LoginFlowView>
  submitCode(request: { id: string; code: string }): Promise<LoginFlowView>
  cancel(id: string): Promise<LoginFlowView | null>
  removeToken(): Promise<ProviderLoginState>
  onChanged(listener: (state: ProviderLoginState) => void): () => void
}
