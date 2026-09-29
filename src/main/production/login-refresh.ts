import { readFileSync, statSync } from 'node:fs'
import type { EvidenceSink, StoredLoginStateRef, TestAccountRef } from '../../shared/production'
import type { CommandRunner } from './checks/engineering-smokes'

/**
 * Unattended login-state refresh (docs/production-agent.md section 4.6). An account's recorded
 * storage state may name a `refresh` command from the owner's own repository. Before the audit
 * browser loads the state, `ensureLoginState` decides whether the file is stale — missing, older
 * than `maxAgeHours`, or holding an expired cookie for an allowed origin — and if so runs the
 * command on the host with a bounded time, keeps its output as evidence (values of `maskEnv`
 * variables masked, the sink's redaction on top), and checks the file again. The audit browser
 * never submits a login form itself; this command is the owner's.
 */

export const DEFAULT_REFRESH_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 64 * 1024

export class LoginRefreshFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginRefreshFailed'
  }
}

const hostOf = (origin: string): string | null => { try { return new URL(origin).hostname.toLowerCase() } catch { return null } }

/** Why the state needs recording again, or null when it is usable as it is. */
export function staleReason(ref: StoredLoginStateRef, allowedOrigins: readonly string[], now: Date): string | null {
  let modified: number
  try { modified = statSync(ref.path).mtimeMs } catch { return 'the storage-state file does not exist' }
  const maxAgeHours = ref.refresh?.maxAgeHours
  if (maxAgeHours && now.getTime() - modified > maxAgeHours * 3_600_000) return `the storage-state file is older than ${maxAgeHours} h`
  let parsed: { cookies?: unknown }
  try { parsed = JSON.parse(readFileSync(ref.path, 'utf8')) as { cookies?: unknown } } catch { return 'the storage-state file is not valid JSON' }
  const hosts = allowedOrigins.map(hostOf).filter((host): host is string => !!host)
  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies as Array<{ domain?: unknown; expires?: unknown }> : []
  const expired = cookies.find(cookie => {
    const domain = String(cookie?.domain ?? '').replace(/^\./, '').toLowerCase()
    const expires = typeof cookie?.expires === 'number' ? cookie.expires : -1
    return expires > 0 && expires * 1000 <= now.getTime() && hosts.some(host => host === domain || host.endsWith(`.${domain}`))
  })
  return expired ? 'a cookie in the storage-state file has expired' : null
}

export interface LoginRefreshPorts {
  runCommand: CommandRunner | null
  evidence: EvidenceSink & { addSecrets?(values: Iterable<string>): void }
  allowedOrigins: readonly string[]
  signal: AbortSignal
  now(): Date
  env?: NodeJS.ProcessEnv
  /** A line for the run's journal (never carries environment values). */
  note?(line: string): void
}

/**
 * Makes the account's login state usable, refreshing it at most once per account for the lifetime
 * of the returned function (one run). Resolves when the state is usable, rejects with
 * LoginRefreshFailed naming why not. An account without `refresh` is left to the browser as before.
 */
export function createLoginStatePreparer(ports: LoginRefreshPorts): (account: TestAccountRef) => Promise<void> {
  const attempts = new Map<string, Promise<void>>()
  return account => {
    const ref = account.storageState
    if (!ref?.refresh) return Promise.resolve()
    const reason = staleReason(ref, ports.allowedOrigins, ports.now())
    if (!reason) return Promise.resolve()
    let attempt = attempts.get(account.id)
    if (!attempt) {
      attempt = refresh(account, ref, reason, ports)
      attempts.set(account.id, attempt)
    }
    return attempt
  }
}

async function refresh(account: TestAccountRef, ref: StoredLoginStateRef, reason: string, ports: LoginRefreshPorts): Promise<void> {
  const refresh = ref.refresh!
  const label = `the login state of ${account.label}`
  if (!ports.runCommand) throw new LoginRefreshFailed(`${label} needs recording again (${reason}), but no command runner is wired for this run`)
  const env = ports.env ?? process.env
  const masked = (refresh.maskEnv ?? []).map(name => env[name]).filter((value): value is string => !!value && value.length >= 4)
  ports.evidence.addSecrets?.(masked)
  const mask = (text: string): string => masked.reduce((out, value) => out.split(value).join('[masked]'), text)
  ports.note?.(`Refreshing ${label}: ${reason}; running the owner's refresh command in ${refresh.cwd}`)
  const started = Date.now()
  let result: Awaited<ReturnType<CommandRunner>>
  try {
    result = await ports.runCommand(refresh.command, { cwd: refresh.cwd, timeoutMs: refresh.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS, signal: ports.signal })
  } catch (error) {
    throw new LoginRefreshFailed(`${label} could not be refreshed: the command did not start (${mask(error instanceof Error ? error.message : String(error)).slice(0, 300)})`)
  }
  const output = mask(result.output).slice(-MAX_OUTPUT_CHARS)
  const log = await ports.evidence.writeText('command', `login-state refresh for ${account.label} (${reason})`, `$ ${refresh.command}\n(cwd ${refresh.cwd}; exit ${result.exitCode ?? 'none'}${result.timedOut ? '; timed out' : ''}; ${Date.now() - started} ms)\n\n${output}`, 'log').catch(() => null)
  const where = log ? ` (evidence ${log.id})` : ''
  if (result.timedOut) throw new LoginRefreshFailed(`${label} could not be refreshed: the refresh command timed out after ${Math.round((refresh.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS) / 1000)} s${where}`)
  if (result.exitCode !== 0) throw new LoginRefreshFailed(`${label} could not be refreshed: the refresh command exited ${result.exitCode ?? 'without a code'}${where}`)
  const still = staleReason(ref, ports.allowedOrigins, ports.now())
  if (still) throw new LoginRefreshFailed(`${label} is still unusable after the refresh command succeeded: ${still}${where}`)
  ports.note?.(`Refreshed ${label}${where}`)
}
