import { execFile } from 'node:child_process'
import type { ProductionProfile } from '../../shared/production'

/**
 * Which commits may start a change-triggered audit, and how bursts of them are debounced
 * (docs/production-agent.md section 6). A change audit costs minutes and thousands of GETs against
 * the live site, so a commit that only touched documentation, scratch files or tests must not start
 * one, and a burst of commits yields one run per quiet window.
 */

/** The lock files the dependency hash reads (fingerprint `dependencyHash`). */
export const LOCK_FILES: readonly string[] = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'requirements.txt', 'go.sum', 'Cargo.lock']

/** A burst of commits closer together than this yields one change run, started once the project is quiet this long. */
export const CHANGE_QUIET_WINDOW_MS = 10 * 60_000
/** A steady stream of commits still gets one run at least this often (measured from the first change of the burst). */
export const CHANGE_MAX_WAIT_MS = 3 * CHANGE_QUIET_WINDOW_MS

/** Files the fingerprint hashes read directly: lock files, the stack's configuration files and email templates. */
export function coveredFilesOf(profile: Pick<ProductionProfile, 'stack'> | null): Set<string> {
  const files = new Set<string>(LOCK_FILES)
  for (const path of profile?.stack?.infrastructureFiles ?? []) files.add(normalisePath(path))
  for (const path of profile?.stack?.emailTemplates ?? []) files.add(normalisePath(path))
  return files
}

export const normalisePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

const IGNORED_DIRS = ['docs', 'doc', '.conductor-scratch', 'tests', 'test', '__tests__', '__mocks__', 'e2e', '.github', '.vscode', '.idea']
const IGNORED_FILE = /(^|\/)[^/]*\.(test|spec)\.[^/]+$|\.(md|mdx|markdown|txt|rst|adoc)$|(^|\/)(LICENSE|LICENCE|CHANGELOG|AUTHORS|CODEOWNERS|NOTICE)(\.[^/]*)?$|(^|\/)\.(gitignore|gitattributes|editorconfig|prettierrc[^/]*|eslintrc[^/]*)$/i

/**
 * True when a changed path can change what the audit tests: a file the fingerprint hashes read
 * (always, even a .md template or requirements.txt), or any other project file that is not
 * documentation, scratch, a test or editor/repository metadata.
 */
export function isCoveredChange(path: string, covered: ReadonlySet<string>): boolean {
  const rel = normalisePath(path)
  if (!rel || rel.startsWith('../')) return false
  if (covered.has(rel)) return true
  const segments = rel.split('/')
  if (segments.slice(0, -1).some(segment => IGNORED_DIRS.includes(segment.toLowerCase()))) return false
  if (IGNORED_FILE.test(rel)) return false
  return true
}

export interface CommitFilterOutcome {
  /** True when at least one changed file can change an audit result. */
  triggers: boolean
  covered: string[]
  ignored: string[]
}

/** Splits a commit range's changed files into the ones an audit covers and the ones it ignores. */
export function filterCommitPaths(paths: readonly string[], covered: ReadonlySet<string>): CommitFilterOutcome {
  const hit: string[] = [], ignored: string[] = []
  for (const path of paths) (isCoveredChange(path, covered) ? hit : ignored).push(normalisePath(path))
  return { triggers: hit.length > 0, covered: hit, ignored }
}

/**
 * Per-key trailing debounce: every `touch` restarts the quiet window, and the callback fires once
 * the key has been quiet for `quietMs`, or `maxWaitMs` after the first touch of the burst.
 */
export class QuietWindow {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>()
  constructor(private readonly quietMs: number = CHANGE_QUIET_WINDOW_MS, private readonly maxWaitMs: number = CHANGE_MAX_WAIT_MS, private readonly now: () => number = Date.now) {}

  touch(key: string, fire: () => void): void {
    const existing = this.pending.get(key)
    const firstAt = existing?.firstAt ?? this.now()
    if (existing) clearTimeout(existing.timer)
    const delay = Math.max(0, Math.min(this.quietMs, firstAt + Math.max(this.maxWaitMs, this.quietMs) - this.now()))
    const timer = setTimeout(() => { this.pending.delete(key); fire() }, delay)
    timer.unref?.()
    this.pending.set(key, { timer, firstAt })
  }

  isPending(key: string): boolean { return this.pending.has(key) }

  cancel(key: string): void {
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing.timer)
    this.pending.delete(key)
  }

  clear(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }
}

/** Files changed between two commits (`git diff --name-only`); null when git cannot tell (unknown commit, no git). */
export function gitChangedFiles(root: string, from: string, to: string): Promise<string[] | null> {
  if (!/^[0-9a-f]{7,64}$/i.test(from) || !/^[0-9a-f]{7,64}$/i.test(to)) return Promise.resolve(null)
  return new Promise(resolve => {
    execFile('git', ['diff', '--name-only', '--no-renames', '-z', from, to], { cwd: root, windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return }
      resolve(String(stdout).split('\0').map(line => line.trim()).filter(Boolean))
    })
  })
}
