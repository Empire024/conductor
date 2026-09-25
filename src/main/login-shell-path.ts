import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix } from 'node:path'

/**
 * A macOS app started from Finder, the Dock or launchd gets PATH=/usr/bin:/bin:/usr/sbin:/sbin,
 * while the CLIs Conductor spawns (claude, codex, node, npm, git, gh) live in /opt/homebrew/bin,
 * ~/.local/bin and wherever the owner's shell profile puts them. The login shell is asked once
 * for its PATH, whose entries go first; the app's own entries follow. Other platforms keep the
 * PATH they were started with.
 */

const MARK = '__CONDUCTOR_LOGIN_PATH__'
const TIMEOUT_MS = 5000

/** Entries of `imported` first, then the entries of `current` it lacks; empty entries dropped. */
export function mergePath(current: string, imported: string, delimiter = ':'): string {
  const seen = new Set<string>(), merged: string[] = []
  for (const entry of [...imported.split(delimiter), ...current.split(delimiter)]) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry); merged.push(entry)
  }
  return merged.join(delimiter)
}

/** The PATH between the markers, so a profile that prints a banner cannot pollute it. */
export function parseShellPath(output: string): string | null {
  const start = output.indexOf(MARK), end = output.lastIndexOf(MARK)
  if (start < 0 || end <= start) return null
  const value = output.slice(start + MARK.length, end).trim()
  return value.includes('/') ? value : null
}

/** Where the usual installers put CLIs, for when the shell cannot be asked. */
export function fallbackPathEntries(home: string, exists: (path: string) => boolean): string[] {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', posix.join(home, '.local', 'bin')].filter(exists)
}

export type ShellRunner = (shell: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>

const runShell: ShellRunner = (shell, args, env) => new Promise((resolve, reject) => {
  const child = execFile(shell, args, { env, timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error); else resolve(stdout)
  })
  child.stdin?.end()
})

export interface LoginShellPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: ShellRunner
  home?: string
  exists?: (path: string) => boolean
}

/** On macOS, puts the login shell's PATH into `env.PATH` (process.env by default). Never throws. */
export async function importLoginShellPath(options: LoginShellPathOptions = {}): Promise<{ source: 'shell' | 'fallback' | 'unchanged'; path: string }> {
  const { platform = process.platform, env = process.env, run = runShell, home = homedir(), exists = existsSync } = options
  const current = env.PATH ?? ''
  if (platform !== 'darwin') return { source: 'unchanged', path: current }
  const shell = env.SHELL && posix.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh'
  let imported: string | null = null
  try {
    // -i reads .zshrc as well as .zprofile: installers add their bin folder to either.
    imported = parseShellPath(await run(shell, ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], { ...env, CONDUCTOR_LOGIN_SHELL_PROBE: '1' }))
  } catch { /* a slow or broken profile: fall back to the usual folders */ }
  if (imported) { env.PATH = mergePath(current, imported); return { source: 'shell', path: env.PATH } }
  const fallback = fallbackPathEntries(home, exists)
  if (!fallback.length) return { source: 'unchanged', path: current }
  env.PATH = mergePath(current, fallback.join(':'))
  return { source: 'fallback', path: env.PATH }
}
