import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A provider CLI that lost its login (feature-list logged-out-alert). 2026-10-01 a wizard tab's
 * Claude CLI answered a timer wake-up with "Failed to authenticate: OAuth session expired and could
 * not be refreshed"; the turn failed like any other, nobody was told, and the tab sat dead for
 * 18.5 h until the owner logged in again and typed "continue". From here a lost login is one owner
 * alert per provider outage, a free `auth status` probe every few minutes, and every tab that
 * failed on it resumed - wizards first - once the login is back.
 */

export type AuthProvider = 'claude' | 'codex'
export const isAuthProvider = (provider: string): provider is AuthProvider => provider === 'claude' || provider === 'codex'

/** What the CLIs say when their login is gone: Claude's synthetic `authentication_failed` text
 *  ("Failed to authenticate: OAuth session expired and could not be refreshed", "Not logged in ·
 *  Please run /login", "Login expired · Please run /login", "API Error: 401 … authentication_error")
 *  and Codex's unauthorized/expired ChatGPT session. Read only from a turn's own error, never from
 *  tool output, which can quote any of these without the conversation being logged out. */
const AUTH_FAILURE = [
  /\bauthentication_(?:failed|error)\b/i,
  /\bfailed to authenticate\b/i,
  /\boauth (?:session|token)\b[^.\r\n]{0,40}\b(?:expired|revoked|invalid)\b/i,
  /\b(?:not logged in|login expired|logged out)\b/i,
  /\bplease (?:run|use) [`'"]?\/?login\b/i,
  /\b(?:invalid|expired) (?:api[ -]key|x-api-key|access token|refresh token)\b/i,
  /\bAPI Error:\s*401\b/i,
  /\b401\b[^\r\n]{0,40}\bunauthori[sz]ed\b/i,
  /\bunauthori[sz]ed\b[^\r\n]{0,40}\b401\b/i,
  /\b(?:token|session)[^.\r\n]{0,30}\bhas expired\b[^\r\n]{0,80}\b(?:sign|log)\s*in\b/i
]
export const isAuthFailureMessage = (text: string): boolean => AUTH_FAILURE.some(pattern => pattern.test(text))

const LABEL: Record<AuthProvider, string> = { claude: 'Claude', codex: 'Codex' }
/** The exact fix, as the owner types it. */
export const LOGIN_FIX: Record<AuthProvider, string> = {
  claude: 'run `claude /login` (or `claude auth login`) in a terminal',
  codex: 'run `codex login` in a terminal'
}
/** The error a turn that failed on a lost login records: what happened and the fix, then the CLI's own words. */
export const authExpiredMessage = (provider: AuthProvider, detail: string): string => {
  const said = detail.replace(/\s+/g, ' ').trim().slice(0, 300)
  return `${LABEL[provider]} login expired: ${LOGIN_FIX[provider]}. Conductor resumes this conversation once the login is back.${said ? ` (${said})` : ''}`
}

/** One free probe of a CLI's login: no model call, no tokens. `stamp` changes whenever the stored
 *  credentials are rewritten (a new login, or a refresh another process managed); null when the
 *  credentials live where a file time cannot see them (a keychain). */
export interface AuthProbeResult { loggedIn: boolean; stamp: string | null; detail?: string }

export interface AuthOutageTab { id: string; title: string; wizard: boolean; failedAt: string }
export interface AuthOutage {
  provider: AuthProvider
  /** When the first turn failed on it. */
  since: string
  message: string
  tabs: AuthOutageTab[]
  alertedAt: string | null
  /** The credentials stamp seen once the outage was known; recovery needs it to change. */
  baseline?: string | null
  lastProbeAt?: string
  lastAttemptAt?: string
}
export type AuthResumeResult = 'sent' | 'busy' | 'recovered' | 'closed' | 'failed'

export interface ProviderAuthMonitorDeps {
  probe(provider: AuthProvider): Promise<AuthProbeResult>
  /** One owner alert per outage (desktop notification, phone push). */
  alert(outage: AuthOutage, text: { title: string; body: string }): void | Promise<void>
  /** Send the continue message to one tab that failed on the outage. */
  resume(tab: AuthOutageTab, message: string, outage: AuthOutage): Promise<AuthResumeResult>
  /** Persist (or clear, with null) an open outage, so a restart keeps probing for it. */
  persist?(provider: AuthProvider, outage: AuthOutage | null): void
  restore?(): AuthOutage[]
  log?(message: string): void
  now?(): number
  intervalMs?: number
  /** Without a credentials stamp, how long between attempts that trust the probe alone. */
  blindRetryMs?: number
  /** A failure this soon after a resume is the same outage coming back: no second alert. */
  relapseMs?: number
}

export const AUTH_PROBE_INTERVAL_MS = 3 * 60_000
const BLIND_RETRY_MS = 30 * 60_000
const RELAPSE_MS = 15 * 60_000

const iso = (ms: number): string => new Date(ms).toISOString()

/** The alert text for an outage: what stopped, which tabs wait, and the fix. */
export function outageAlert(outage: AuthOutage): { title: string; body: string } {
  const label = LABEL[outage.provider]
  const wizards = outage.tabs.filter(tab => tab.wizard)
  const waiting = outage.tabs.length === 1 ? `"${outage.tabs[0]!.title}"${outage.tabs[0]!.wizard ? ' (wizard)' : ''} is stopped`
    : `${outage.tabs.length} tabs are stopped${wizards.length ? `, including wizard "${wizards[0]!.title}"` : ''}`
  return {
    title: `${label} login expired`,
    body: `${label} lost its login at ${outage.since} and ${waiting}. Fix: ${LOGIN_FIX[outage.provider]}. Conductor checks every few minutes and resumes the stopped tabs, wizards first, once the login is back. (${outage.message.replace(/\s+/g, ' ').trim().slice(0, 200)})`
  }
}

/** The continue message a resumed tab receives. */
export function resumeMessage(provider: AuthProvider, failedAt: string, restoredAt: string): string {
  const label = LABEL[provider]
  return `[Conductor] Your ${label} login expired at ${failedAt} and was restored at ${restoredAt}, so your last turn failed without running and nothing happened in between. Any timers, background waits or watchers you had armed were lost or fired into the dead turn. Re-check your state now (agents.list, your coworkers, pending work and deadlines), re-arm the waits you still need, and continue.`
}

/**
 * Tracks one outage per provider: the tabs that failed on it, one alert, a cheap probe on an
 * interval, and the resume once the login is back. The probe alone is not proof: a CLI whose
 * refresh token was rejected still reports itself logged in, so recovery also needs the stored
 * credentials to have been rewritten since the outage was seen (a new login does that). Where no
 * stamp is available, the probe is trusted at most every blindRetryMs; a resumed tab that fails
 * again reopens the same outage without a second alert.
 */
export class ProviderAuthMonitor {
  private readonly outages = new Map<AuthProvider, AuthOutage>()
  private readonly restored = new Map<AuthProvider, { at: number; alertedAt: string | null }>()
  private readonly timers = new Map<AuthProvider, ReturnType<typeof setTimeout>>()
  private readonly checking = new Set<AuthProvider>()
  private disposed = false

  constructor(private readonly deps: ProviderAuthMonitorDeps) {
    for (const outage of deps.restore?.() ?? []) {
      if (!isAuthProvider(outage.provider) || !Array.isArray(outage.tabs)) continue
      this.outages.set(outage.provider, outage)
      this.schedule(outage.provider)
    }
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private log(message: string): void { this.deps.log?.(message) }

  /** The open outages, for status and the supervisor. */
  status(): AuthOutage[] { return [...this.outages.values()].map(outage => ({ ...outage, tabs: [...outage.tabs] })) }

  /** A turn failed on a lost login. Returns whether this call raised the outage's one alert. */
  noteFailure(provider: AuthProvider, tab: Omit<AuthOutageTab, 'failedAt'> & { failedAt?: string }, message: string): boolean {
    if (this.disposed) return false
    const at = tab.failedAt ?? iso(this.now())
    let outage = this.outages.get(provider)
    let alerted = false
    if (!outage) {
      const relapse = this.restored.get(provider)
      const same = relapse && this.now() - relapse.at < (this.deps.relapseMs ?? RELAPSE_MS)
      // A relapse keeps its alert and its last attempt, so a blind retry waits its full window.
      const opened: AuthOutage = { provider, since: at, message, tabs: [], alertedAt: same ? relapse.alertedAt : null, ...(same ? { lastAttemptAt: iso(relapse.at) } : {}) }
      outage = opened
      this.outages.set(provider, opened)
      this.restored.delete(provider)
      // The stamp at the moment it is known; only a later rewrite counts as the login coming back.
      const baseline = (stamp: string | null): void => { if (this.outages.get(provider) === opened && opened.baseline === undefined) { opened.baseline = stamp; this.save(provider) } }
      void this.deps.probe(provider).then(result => baseline(result.stamp), () => { /* the next check takes it */ })
    }
    const entry: AuthOutageTab = { id: tab.id, title: tab.title, wizard: tab.wizard, failedAt: at }
    const index = outage.tabs.findIndex(existing => existing.id === tab.id)
    if (index >= 0) outage.tabs[index] = { ...entry, failedAt: outage.tabs[index]!.failedAt }
    else outage.tabs.push(entry)
    if (!outage.alertedAt) {
      outage.alertedAt = iso(this.now())
      alerted = true
      const text = outageAlert(outage)
      this.log(`${text.title}: ${text.body}`)
      try { void Promise.resolve(this.deps.alert(outage, text)).catch(error => this.log(`Login alert failed: ${error instanceof Error ? error.message : String(error)}`)) }
      catch (error) { this.log(`Login alert failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    this.save(provider)
    this.schedule(provider)
    return alerted
  }

  /** The owner closed or took over a tab: it no longer waits on the login. */
  forget(id: string): void {
    for (const [provider, outage] of this.outages) {
      const before = outage.tabs.length
      outage.tabs = outage.tabs.filter(tab => tab.id !== id)
      if (outage.tabs.length !== before) this.save(provider)
    }
  }

  private save(provider: AuthProvider): void {
    try { this.deps.persist?.(provider, this.outages.get(provider) ?? null) } catch { /* the in-memory outage still runs */ }
  }

  private schedule(provider: AuthProvider): void {
    if (this.disposed || this.timers.has(provider)) return
    const timer = setTimeout(() => {
      this.timers.delete(provider)
      void this.check(provider).finally(() => { if (this.outages.has(provider)) this.schedule(provider) })
    }, this.deps.intervalMs ?? AUTH_PROBE_INTERVAL_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.set(provider, timer)
  }

  /** Probe once; when the login is back, resume the tabs that failed on it. Returns whether it resumed. */
  async check(provider: AuthProvider): Promise<boolean> {
    const outage = this.outages.get(provider)
    if (!outage || this.disposed || this.checking.has(provider)) return false
    this.checking.add(provider)
    try {
      let result: AuthProbeResult
      try { result = await this.deps.probe(provider) } catch (error) { this.log(`${LABEL[provider]} login probe failed: ${error instanceof Error ? error.message : String(error)}`); return false }
      const now = this.now()
      outage.lastProbeAt = iso(now)
      if (this.outages.get(provider) !== outage) return false
      if (outage.baseline === undefined) { outage.baseline = result.stamp; this.save(provider); if (result.stamp !== null) return false }
      if (!result.loggedIn) { this.save(provider); return false }
      const rewritten = result.stamp !== null && result.stamp !== outage.baseline
      const blind = result.stamp === null && (!outage.lastAttemptAt || now - Date.parse(outage.lastAttemptAt) >= (this.deps.blindRetryMs ?? BLIND_RETRY_MS))
      if (!rewritten && !blind) { this.save(provider); return false }
      await this.resumeAll(outage, now)
      return true
    } finally { this.checking.delete(provider) }
  }

  private async resumeAll(outage: AuthOutage, now: number): Promise<void> {
    const provider = outage.provider, restoredAt = iso(now)
    outage.lastAttemptAt = restoredAt
    this.outages.delete(provider)
    this.restored.set(provider, { at: now, alertedAt: outage.alertedAt })
    const timer = this.timers.get(provider)
    if (timer) clearTimeout(timer)
    this.timers.delete(provider)
    this.save(provider)
    // Wizards first: they run the rest, and their coworkers' reports land in a live conversation.
    const order = [...outage.tabs].sort((a, b) => Number(b.wizard) - Number(a.wizard) || a.failedAt.localeCompare(b.failedAt))
    this.log(`${LABEL[provider]} login is back (${restoredAt}); resuming ${order.length} tab(s)`)
    for (const tab of order) {
      let result: AuthResumeResult
      try { result = await this.deps.resume(tab, resumeMessage(provider, tab.failedAt, restoredAt), outage) }
      catch (error) { result = 'failed'; this.log(`${tab.id} could not be resumed after the login came back: ${error instanceof Error ? error.message : String(error)}`) }
      this.log(`${tab.id} after the login came back: ${result}`)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

/* --- The real probes ---------------------------------------------------------------------- */

const run = (executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> => new Promise(resolve => {
  const options = { windowsHide: true, timeout: 20_000, maxBuffer: 65_536, env }
  const done = (error: (Error & { code?: unknown }) | null, stdout: string | Buffer, stderr: string | Buffer): void =>
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
  // An npm shim (.cmd) cannot be started without a shell on Windows (cli-versions.ts runVersion).
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`], { ...options, windowsVerbatimArguments: true }, done)
  else execFile(executable, args, options, done)
})

const mtime = (path: string): string | null => { try { return statSync(path).mtime.toISOString() } catch { return null } }

/** `claude auth status` prints JSON ({loggedIn, configDirectory, …}); no model call. The stamp is
 *  the credentials file's time, read, never written. */
export async function probeClaudeAuth(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<AuthProbeResult> {
  const result = await run(executable, ['auth', 'status'], env)
  let parsed: { loggedIn?: unknown; configDirectory?: unknown; authMethod?: unknown } = {}
  try { parsed = JSON.parse(result.stdout) as typeof parsed } catch { /* older CLIs print text */ }
  const loggedIn = typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : result.code === 0 && /logged in/i.test(result.stdout) && !/not logged in/i.test(result.stdout)
  const directory = typeof parsed.configDirectory === 'string' ? parsed.configDirectory : env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  // The status names the account; only the method is kept.
  return { loggedIn, stamp: mtime(join(directory, '.credentials.json')), detail: typeof parsed.authMethod === 'string' ? parsed.authMethod : result.stderr.trim().slice(0, 300) }
}

/** `codex login status` exits 0 with "Logged in using …"; the stamp is auth.json's time. */
export async function probeCodexAuth(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<AuthProbeResult> {
  const result = await run(executable, ['login', 'status'], env)
  const text = `${result.stdout}\n${result.stderr}`
  const loggedIn = result.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)
  return { loggedIn, stamp: mtime(join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')), detail: text.trim().slice(0, 300) }
}
