import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SecretVault } from './secret-store'
import { LOGIN_TIMEOUT_MS, type ClaudeTokenStatus, type LoginFlowPhase, type LoginFlowView, type LoginMode, type LoginOrigin, type LoginProvider } from '../shared/claude-login'

/**
 * Keeping the Claude login alive (docs/verification/2026-10-04-claude-logout.md).
 *
 * A long-lived token from `claude setup-token` never refreshes, so nothing can spend it: stored
 * with the OS credential store (SecretVault over Electron safeStorage) and handed to every Claude
 * CLI Conductor starts as CLAUDE_CODE_OAUTH_TOKEN. A token the API rejects is marked rejected and
 * no longer injected, so new processes fall back to the normal login.
 *
 * And when the login is lost anyway, the owner signs in from wherever they are: Conductor runs the
 * CLI's own login in a PTY it owns, with the browser launch disabled, and relays the sign-in URL
 * and the one pasted code. The CLI output can hold the new token, so it is never logged, stored
 * or shown; a flow's view carries only the URL, a device code and whitelisted messages.
 */

export const CLAUDE_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'
const TOKEN_KEY = 'claude.longLivedToken'
const META_KEY = 'claudeLogin.tokenMeta'
const TOKEN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/
export const isClaudeLongLivedToken = (value: string): boolean => new RegExp(`^${TOKEN.source}$`).test(value)

interface TokenMeta { createdAt: string; expiresAt: string | null; rejectedAt: string | null; rejectedReason: string | null }
export interface SettingsStore { getSetting(key: string): string | null; setSetting(key: string, value: string): void; removeSetting(key: string): void }

export class ClaudeTokenStore {
  private cached: string | null | undefined

  constructor(private readonly vault: SecretVault, private readonly settings: SettingsStore, private readonly environment: NodeJS.ProcessEnv = process.env, private readonly now: () => number = Date.now) {}

  private meta(): TokenMeta | null {
    try { const raw = this.settings.getSetting(META_KEY); return raw ? JSON.parse(raw) as TokenMeta : null } catch { return null }
  }

  private stored(): string | null {
    if (this.cached === undefined) this.cached = this.vault.read(TOKEN_KEY)
    return this.cached
  }

  status(): ClaudeTokenStatus {
    const token = this.stored(), meta = this.meta()
    const set = Boolean(token)
    return {
      set, active: set && !meta?.rejectedAt,
      createdAt: set ? meta?.createdAt ?? null : null, expiresAt: set ? meta?.expiresAt ?? null : null,
      rejectedAt: set ? meta?.rejectedAt ?? null : null, rejectedReason: set ? meta?.rejectedReason ?? null : null,
      storageAvailable: this.vault.available(), environmentOverride: Boolean(this.environment[CLAUDE_TOKEN_ENV]?.trim())
    }
  }

  /** The token new Claude processes get, or null (none, or rejected). */
  token(): string | null {
    const token = this.stored()
    return token && !this.meta()?.rejectedAt ? token : null
  }

  save(token: string, expiresAt: string | null = null): void {
    const value = token.trim()
    if (!isClaudeLongLivedToken(value)) throw new Error('That is not a Claude long-lived token.')
    this.vault.write(TOKEN_KEY, value)
    this.cached = value
    this.settings.setSetting(META_KEY, JSON.stringify({ createdAt: new Date(this.now()).toISOString(), expiresAt, rejectedAt: null, rejectedReason: null } satisfies TokenMeta))
  }

  remove(): void {
    this.vault.delete(TOKEN_KEY)
    this.settings.removeSetting(META_KEY)
    this.cached = null
  }

  /** The API refused the token: stop handing it out. Returns whether this call changed anything. */
  reject(reason: string): boolean {
    const meta = this.meta()
    if (!this.stored() || meta?.rejectedAt) return false
    this.settings.setSetting(META_KEY, JSON.stringify({ ...(meta ?? { createdAt: new Date(this.now()).toISOString(), expiresAt: null }), rejectedAt: new Date(this.now()).toISOString(), rejectedReason: reason.replace(/\s+/g, ' ').slice(0, 300) } satisfies TokenMeta))
    return true
  }
}

/* --- Injection --------------------------------------------------------------------------- */

let tokenSource: (() => string | null) | null = null
/** The main process sets this once; every Claude launch reads it at spawn time. */
export function setClaudeTokenSource(source: (() => string | null) | null): void { tokenSource = source }
const currentToken = (): string | null => { try { return tokenSource?.() ?? null } catch { return null } }
/** Whether Conductor would hand a new Claude process the long-lived token now. */
export const claudeTokenActive = (): boolean => Boolean(currentToken())

/** `environment` plus CLAUDE_CODE_OAUTH_TOKEN when a long-lived token is active. A token the owner
 *  exported for Conductor itself is left alone. */
export function claudeTokenEnvironment<T extends NodeJS.ProcessEnv>(environment: T): T {
  if (environment[CLAUDE_TOKEN_ENV]?.trim()) return environment
  const token = currentToken()
  return token ? { ...environment, [CLAUDE_TOKEN_ENV]: token } : environment
}
export const usesClaudeToken = (environment: NodeJS.ProcessEnv): boolean => Boolean(environment[CLAUDE_TOKEN_ENV]?.trim())

/* --- Login flows --------------------------------------------------------------------------- */

export interface LoginPty {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  kill(): void
}
export type SpawnLoginPty = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }) => LoginPty

export interface LoginFlowsDeps {
  spawn: SpawnLoginPty
  executable(provider: LoginProvider): string | null
  /** The base environment a login CLI starts with. */
  environment(): NodeJS.ProcessEnv
  /** A private, empty directory: setup-token runs with it as its config home, so the owner's
   *  own login is never touched by it. Removed when the flow ends. */
  scratchDirectory(): string
  removeDirectory(path: string): void
  saveToken(token: string, expiresAt: string | null): void
  /** After a login: `claude auth status` / `codex login status`. */
  verify(provider: LoginProvider): Promise<{ loggedIn: boolean; detail?: string }>
  /** The login is back (or a token was set): resume the tabs that stopped on it. */
  restored(provider: LoginProvider, mode: LoginMode): void
  changed(view: LoginFlowView): void
  log?(message: string): void
  now?(): number
  timeoutMs?: number
}

export class LoginFlowError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

interface Flow {
  view: LoginFlowView
  pty: LoginPty | null
  output: string
  scratch: string | null
  timer: ReturnType<typeof setTimeout> | null
  settled: boolean
  submittedAt: number | null
}

const START_LIMIT = 5
const START_WINDOW_MS = 15 * 60_000
const OUTPUT_CAP = 256 * 1024
const CODE = /^[A-Za-z0-9_\-#.~]{8,1024}$/
const ACTIVE: ReadonlySet<LoginFlowPhase> = new Set(['starting', 'awaiting-code', 'awaiting-device', 'verifying'])

/** Terminal escapes out, OSC 8 hyperlinks kept as their target, so a URL survives Ink's layout. */
export function plainTerminalText(raw: string): string {
  return raw
    .replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, (_match, target: string) => target ? ` ${target} ` : ' ')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>78]/g, '')
}

/** The sign-in URL a login CLI printed. */
export function loginUrl(provider: LoginProvider, text: string): string | null {
  const pattern = provider === 'claude' ? /https:\/\/[^\s"'<>\x00-\x1f]+\/oauth\/authorize\?[^\s"'<>\x00-\x1f]+/ : /https:\/\/auth\.openai\.com\/[^\s"'<>\x00-\x1f]*device[^\s"'<>\x00-\x1f]*/
  const match = pattern.exec(text)?.[0]
  if (!match) return null
  try { return new URL(match).toString() } catch { return null }
}

/** The long-lived token `claude setup-token` printed, and how long it is valid. */
export function setupTokenResult(text: string, now: number): { token: string; expiresAt: string | null } | null {
  const token = TOKEN.exec(text)?.[0]
  if (!token) return null
  const valid = /valid for\s+(\d+)\s+(year|day|month)s?/i.exec(text)
  const days = valid ? Number(valid[1]) * (valid[2]!.toLowerCase() === 'year' ? 365 : valid[2]!.toLowerCase() === 'month' ? 30 : 1) : null
  return { token, expiresAt: days ? new Date(now + days * 86_400_000).toISOString() : null }
}

/** A CLI error line worth showing; never anything that could hold a secret. */
function failureLine(text: string): string | null {
  const match = /(Login failed: [^\r\n]{0,160}|OAuth error: [^\r\n]{0,160}|Error: (?:timed out|access denied|invalid[^\r\n]{0,80}))/i.exec(text)?.[0]
  return match ? match.replace(TOKEN, '[token]').replace(/\s+/g, ' ').trim() : null
}

/**
 * At most one login runs at a time. A start is rate-limited per origin (desktop or one phone), the
 * code is accepted once, and the PTY is killed after ten minutes whatever state it is in.
 */
export class LoginFlows {
  private current: Flow | null = null
  private readonly starts = new Map<string, number[]>()

  constructor(private readonly deps: LoginFlowsDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  view(): LoginFlowView | null { return this.current ? { ...this.current.view } : null }

  start(request: { provider: LoginProvider; mode: LoginMode; origin: LoginOrigin; requester: string }): LoginFlowView {
    const { provider, mode } = request
    if (!(provider === 'claude' && (mode === 'login' || mode === 'setup-token')) && !(provider === 'codex' && mode === 'device')) throw new LoginFlowError('Unknown login.')
    const running = this.current && !this.current.settled ? this.current : null
    if (running) {
      if (running.view.provider === provider && running.view.mode === mode) return { ...running.view }
      throw new LoginFlowError(`Another login (${running.view.provider} ${running.view.mode}) is running; cancel it first.`, 409)
    }
    const now = this.now()
    const recent = (this.starts.get(request.requester) ?? []).filter(at => now - at < START_WINDOW_MS)
    if (recent.length >= START_LIMIT) throw new LoginFlowError('Too many login attempts; try again in a few minutes.', 429)
    recent.push(now)
    this.starts.set(request.requester, recent)
    const executable = this.deps.executable(provider)
    if (!executable) throw new LoginFlowError(`The ${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI is not installed on this computer.`, 503)

    const timeout = this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS
    const flow: Flow = {
      view: { id: randomUUID(), provider, mode, phase: 'starting', url: null, userCode: null, message: null, origin: request.origin, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + timeout).toISOString(), codeUsed: false },
      pty: null, output: '', scratch: null, timer: null, settled: false, submittedAt: null
    }
    this.current = flow
    const environment: NodeJS.ProcessEnv = { ...this.deps.environment() }
    let cwd = process.cwd()
    if (provider === 'claude') {
      // A token in the environment would make the CLI log in "for this session only".
      delete environment[CLAUDE_TOKEN_ENV]
      flow.scratch = this.deps.scratchDirectory()
      cwd = flow.scratch
      // No browser on the host: the CLI then prints the URL and waits for the pasted code. A
      // missing executable makes its launch fail (src: BROWSER is run with the URL), never opens one.
      environment.BROWSER = join(flow.scratch, 'no-browser.exe')
      if (mode === 'setup-token') environment.CLAUDE_CONFIG_DIR = flow.scratch
    }
    const args = provider === 'codex' ? ['login', '--device-auth'] : mode === 'setup-token' ? ['setup-token'] : ['auth', 'login']
    try {
      flow.pty = this.deps.spawn(executable, args, { cwd, env: environment, cols: 500, rows: 50 })
    } catch (error) {
      this.finish(flow, 'failed', `The login could not start: ${error instanceof Error ? error.message : String(error)}`)
      return { ...flow.view }
    }
    flow.pty.onData(data => this.data(flow, data))
    flow.pty.onExit(({ exitCode }) => { void this.exited(flow, exitCode) })
    flow.timer = setTimeout(() => this.finish(flow, 'expired', 'The login timed out after 10 minutes; start it again.'), timeout)
    ;(flow.timer as { unref?: () => void }).unref?.()
    this.deps.log?.(`${provider} ${mode} login started from ${request.origin}`)
    this.emit(flow)
    return { ...flow.view }
  }

  submitCode(request: { id: string; code: unknown }): LoginFlowView {
    const flow = this.current
    if (!flow || flow.view.id !== request.id || flow.settled) throw new LoginFlowError('That login is no longer running.', 410)
    if (flow.view.codeUsed) throw new LoginFlowError('This login already took its code; start a new one to try again.', 409)
    if (flow.view.phase !== 'awaiting-code') throw new LoginFlowError('This login is not waiting for a code.', 409)
    const code = typeof request.code === 'string' ? request.code.trim() : ''
    if (!CODE.test(code)) throw new LoginFlowError('Paste the whole code the sign-in page shows.')
    flow.view.codeUsed = true
    flow.view.phase = 'verifying'
    flow.view.message = 'Signing in…'
    flow.submittedAt = this.now()
    // Ink reads a paste and the Enter separately.
    flow.pty?.write(code)
    const enter = setTimeout(() => { if (!flow.settled) flow.pty?.write('\r') }, 300)
    ;(enter as { unref?: () => void }).unref?.()
    this.emit(flow)
    return { ...flow.view }
  }

  cancel(id: string): LoginFlowView | null {
    const flow = this.current
    if (!flow || flow.view.id !== id) return null
    if (!flow.settled) this.finish(flow, 'cancelled', 'Login cancelled.')
    return { ...flow.view }
  }

  dispose(): void {
    if (this.current && !this.current.settled) this.finish(this.current, 'cancelled', 'Conductor is closing.')
  }

  private data(flow: Flow, chunk: string): void {
    if (flow.settled) return
    if (flow.output.length < OUTPUT_CAP) flow.output += chunk
    const text = plainTerminalText(flow.output)
    const { provider, mode } = flow.view
    if (!flow.view.url) {
      const url = loginUrl(provider, text)
      if (url && (provider === 'codex' || /paste code/i.test(text))) {
        flow.view.url = url
        if (provider === 'codex') {
          flow.view.userCode = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/.exec(text.slice(text.indexOf('code')))?.[1] ?? null
          if (!flow.view.userCode) { flow.view.url = null; return }
          flow.view.phase = 'awaiting-device'
          flow.view.message = 'Open the link, sign in and enter the code shown here.'
        } else {
          flow.view.phase = 'awaiting-code'
          flow.view.message = 'Open the link, sign in, then paste the code the page shows.'
        }
        this.emit(flow)
      }
      return
    }
    if (provider === 'claude' && mode === 'setup-token' && flow.view.codeUsed) {
      const result = setupTokenResult(text, this.now())
      if (result) {
        flow.output = ''
        try { this.deps.saveToken(result.token, result.expiresAt) }
        catch (error) { this.finish(flow, 'failed', `The token was created but could not be saved: ${error instanceof Error ? error.message : String(error)}`); return }
        this.finish(flow, 'succeeded', 'Long-lived token saved. New Claude processes use it; it never needs a refresh.')
        this.deps.restored('claude', 'setup-token')
        return
      }
    }
    if (flow.view.codeUsed) {
      const failure = failureLine(text.slice(text.search(/paste code/i)))
      if (failure) this.finish(flow, 'failed', `${failure}. Start the login again and paste the newest code.`)
    }
  }

  private async exited(flow: Flow, exitCode: number): Promise<void> {
    if (flow.settled) return
    flow.pty = null
    const text = plainTerminalText(flow.output)
    flow.output = ''
    const { provider, mode } = flow.view
    const created = mode === 'setup-token' && flow.view.codeUsed ? setupTokenResult(text, this.now()) : null
    if (created) {
      try { this.deps.saveToken(created.token, created.expiresAt) }
      catch (error) { this.finish(flow, 'failed', `The token was created but could not be saved: ${error instanceof Error ? error.message : String(error)}`); return }
      this.finish(flow, 'succeeded', 'Long-lived token saved. New Claude processes use it; it never needs a refresh.')
      this.deps.restored('claude', 'setup-token')
      return
    }
    if (exitCode !== 0 || mode === 'setup-token') {
      this.finish(flow, 'failed', failureLine(text) ?? `The ${provider} CLI ended (exit ${exitCode}) before the login finished.`)
      return
    }
    flow.view.phase = 'verifying'
    flow.view.message = 'Checking the login…'
    this.emit(flow)
    let verified: { loggedIn: boolean; detail?: string }
    try { verified = await this.deps.verify(provider) } catch (error) { verified = { loggedIn: false, detail: error instanceof Error ? error.message : String(error) } }
    if (flow.settled) return
    if (!verified.loggedIn) { this.finish(flow, 'failed', `The CLI finished but still reports no login${verified.detail ? ` (${verified.detail.slice(0, 160)})` : ''}.`); return }
    this.finish(flow, 'succeeded', 'Logged in. Conductor resumes the tabs that stopped on the login.')
    this.deps.restored(provider, mode)
  }

  private finish(flow: Flow, phase: LoginFlowPhase, message: string): void {
    if (flow.settled) return
    flow.settled = true
    flow.output = ''
    if (flow.timer) clearTimeout(flow.timer)
    flow.timer = null
    try { flow.pty?.kill() } catch { /* already gone */ }
    flow.pty = null
    if (flow.scratch) { try { this.deps.removeDirectory(flow.scratch) } catch { /* best effort */ } flow.scratch = null }
    flow.view.phase = phase
    flow.view.message = message
    this.deps.log?.(`${flow.view.provider} ${flow.view.mode} login ${phase}`)
    this.emit(flow)
  }

  private emit(flow: Flow): void {
    try { this.deps.changed({ ...flow.view }) } catch { /* a listener never breaks the flow */ }
  }

  /** Whether a flow is running (not settled). */
  active(): boolean { return Boolean(this.current && !this.current.settled && ACTIVE.has(this.current.view.phase)) }
}
