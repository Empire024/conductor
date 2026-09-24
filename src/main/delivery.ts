import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { DELIVERY_STAGES, type DeliveryRequester, type DeliveryRun, type DeliveryStage, type DeliveryStageId, type RepositoryFile, type RepositoryStatus } from '../shared/delivery'

export interface DeliveryRunOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  signal: AbortSignal
  onLine(line: string): void
}

export interface DeliveryDependencies {
  /** Resolves with code null when the command timed out, was aborted, or could not start. */
  run(command: string, args: string[], options: DeliveryRunOptions): Promise<{ code: number | null; stdout: string }>
  fetch: typeof fetch
  githubToken(): Promise<string | null>
  now(): Date
  sleep(ms: number, signal: AbortSignal): Promise<void>
  tempDir(): string
}

export interface DeliveryConfig {
  branch: string
  remote: string
  /** Undefined means "use the package.json script when there is one". */
  test?: string[] | null
  build?: string[] | null
  release?: { workflow?: string; assets?: string[] } | null
}

const LOG_LINES = 40
const LINE_CHARS = 500
const ERROR_CHARS = 4000
const MESSAGE_CHARS = 5000
const GIT_TIMEOUT_MS = 2 * 60 * 1000
const NETWORK_TIMEOUT_MS = 5 * 60 * 1000
const COMMIT_TIMEOUT_MS = 10 * 60 * 1000
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000
const RELEASE_TIMEOUT_MS = 45 * 60 * 1000
const RELEASE_APPEAR_MS = 5 * 60 * 1000
const RATE_LIMIT_CAP_MS = 10 * 60 * 1000
const DEFAULT_ASSETS = ['.exe', '.exe.blockmap', 'latest.yml']
const EMIT_INTERVAL_MS = 250

// ---------------------------------------------------------------------------------------------
// Host process helpers. Copied from local-update-build.ts rather than shared: inside a packaged
// app process.execPath is Conductor.exe, so npm has to be found beside the host's real node.

function onPath(names: string[]): string | null {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = join(directory, name)
      try { if (existsSync(candidate)) return candidate } catch { /* an unreadable PATH entry is not an error */ }
    }
  }
  return null
}

function hostNode(): { executable: string; asNode: boolean } {
  const own = basename(process.execPath).toLowerCase()
  if (own === 'node.exe' || own === 'node') return { executable: process.execPath, asNode: false }
  const found = onPath(process.platform === 'win32' ? ['node.exe'] : ['node'])
  return found ? { executable: found, asNode: false } : { executable: process.execPath, asNode: true }
}

/** npm-cli.js / npx-cli.js beside whichever node this machine actually installed. */
function npmScript(nodeExecutable: string, script: 'npm-cli.js' | 'npx-cli.js'): string | null {
  const candidates = [process.env.npm_execpath ? join(dirname(process.env.npm_execpath), script) : undefined, join(dirname(nodeExecutable), 'node_modules', 'npm', 'bin', script)]
  const npm = onPath(process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'])
  if (npm) candidates.push(join(dirname(npm), 'node_modules', 'npm', 'bin', script))
  return candidates.find(path => path && existsSync(path)) ?? null
}

function quoteForCmd(value: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`
}

/** A timed-out or cancelled test run leaves vitest workers and electron-vite children behind
 *  unless the whole tree goes. */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => child.kill('SIGKILL'))
  } else child.kill('SIGKILL')
}

const STDOUT_LIMIT = 16 * 1024 * 1024

export function spawnCommand(command: string, args: string[], options: DeliveryRunOptions): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolvePromise => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env }
    let file = command
    let argv = args
    let shell = false
    if (command === 'npm' || command === 'npx' || command === 'node') {
      const node = hostNode()
      const script = command === 'node' ? null : npmScript(node.executable, command === 'npm' ? 'npm-cli.js' : 'npx-cli.js')
      if (command === 'node' || script) {
        file = node.executable
        argv = script ? [script, ...args] : args
        if (node.asNode) env.ELECTRON_RUN_AS_NODE = '1'
      } else if (process.platform === 'win32') { file = `${command}.cmd`; shell = true }
    } else if (process.platform === 'win32' && command !== 'git' && !/\.(exe|com)$/i.test(command)) shell = true
    if (shell) { file = quoteForCmd(file); argv = argv.map(quoteForCmd) }
    if (options.signal.aborted) { resolvePromise({ code: null, stdout: '' }); return }
    let child: ChildProcess
    try {
      child = spawn(file, argv, { cwd: options.cwd, env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      options.onLine(`Could not start ${command}: ${error instanceof Error ? error.message : String(error)}`)
      resolvePromise({ code: null, stdout: '' }); return
    }
    let stdout = ''
    let settled = false
    const pending = { out: '', err: '' }
    const feed = (key: 'out' | 'err', text: string, flush = false): void => {
      const lines = (pending[key] + text).split(/\r?\n/)
      pending[key] = flush ? '' : lines.pop() ?? ''
      for (const line of lines) if (line.trim()) options.onLine(line.trimEnd())
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => { if (stdout.length < STDOUT_LIMIT) stdout += text; feed('out', text) })
    child.stderr?.on('data', (text: string) => feed('err', text))
    const stop = (): void => killTree(child)
    const timer = setTimeout(() => { options.onLine(`Timed out after ${Math.round(options.timeoutMs / 1000)} s`); stop() }, options.timeoutMs)
    timer.unref?.()
    options.signal.addEventListener('abort', stop, { once: true })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', stop)
      feed('out', '', true); feed('err', '', true)
      resolvePromise({ code: options.signal.aborted ? null : code, stdout })
    }
    child.on('error', error => { options.onLine(`Could not start ${command}: ${error.message}`); finish(null) })
    child.on('close', code => finish(code))
  })
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolvePromise => {
    if (signal.aborted) { resolvePromise(); return }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolvePromise() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

export interface PorcelainEntry extends RepositoryFile { from: string | null }

/** `git status --porcelain=v1 -z`: "XY path\0", and renames/copies carry their origin as the next
 *  NUL-separated field. -z also means paths are never quoted, so spaces survive untouched. */
export function parsePorcelain(output: string): PorcelainEntry[] {
  const fields = output.split('\0')
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const index = field[0]!, worktree = field[1]!
    const entry: PorcelainEntry = { path: field.slice(3), index: index === ' ' ? '' : index, worktree: worktree === ' ' ? '' : worktree, from: null }
    if (index === 'R' || index === 'C') entry.from = fields[++i] ?? null
    entries.push(entry)
  }
  return entries
}

/** https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r(.git) */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match ? { owner: match[1]!, repo: match[2]! } : null
}

/** Repository-relative, forward-slashed, and unable to name anything outside the repository. */
export function normalizeDeliveryPath(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('A delivery path is empty.')
  const path = raw.trim().replace(/\\/g, '/')
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith('/')) throw new Error(`"${raw}" is absolute; delivery paths are relative to the repository root.`)
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.includes('..')) throw new Error(`"${raw}" leaves the repository; delivery paths cannot contain "..".`)
  if (!parts.length) throw new Error(`"${raw}" names the repository root; omit paths to deliver everything.`)
  if (parts[0]!.toLowerCase() === '.git') throw new Error(`"${raw}" is inside .git.`)
  return parts.join('/')
}

function inScope(path: string, scope: string[]): boolean {
  return scope.some(entry => path === entry || path.startsWith(`${entry}/`))
}

function isArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part.length > 0)
}

/** Strict: a typo in the file must stop a delivery, not silently run the default pipeline. */
export function parseDeliveryConfig(text: string | null): DeliveryConfig {
  if (text === null) return { branch: 'main', remote: 'origin' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch (error) { throw new Error(`.conductor/delivery.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('.conductor/delivery.json must contain a JSON object.')
  const object = raw as Record<string, unknown>
  const unknownKeys = Object.keys(object).filter(key => !['branch', 'remote', 'test', 'build', 'release'].includes(key))
  if (unknownKeys.length) throw new Error(`.conductor/delivery.json has unknown key(s): ${unknownKeys.join(', ')}. Allowed: branch, remote, test, build, release.`)
  const name = (key: 'branch' | 'remote', fallback: string): string => {
    const value = object[key]
    if (value === undefined) return fallback
    if (typeof value !== 'string' || !/^[\w./-]+$/.test(value) || value.startsWith('-')) throw new Error(`.conductor/delivery.json "${key}" must be a plain ${key} name.`)
    return value
  }
  const config: DeliveryConfig = { branch: name('branch', 'main'), remote: name('remote', 'origin') }
  for (const key of ['test', 'build'] as const) {
    const value = object[key]
    if (value === undefined) continue
    if (value !== null && !isArgv(value)) throw new Error(`.conductor/delivery.json "${key}" must be null or a non-empty argv array such as ["npm", "${key === 'test' ? 'test' : 'run", "build'}"].`)
    config[key] = value
  }
  if (object.release !== undefined) {
    const release = object.release
    if (release === null) config.release = null
    else {
      if (typeof release !== 'object' || Array.isArray(release)) throw new Error('.conductor/delivery.json "release" must be null or an object.')
      const r = release as Record<string, unknown>
      const extra = Object.keys(r).filter(key => key !== 'workflow' && key !== 'assets')
      if (extra.length) throw new Error(`.conductor/delivery.json "release" has unknown key(s): ${extra.join(', ')}. Allowed: workflow, assets.`)
      if (r.workflow !== undefined && (typeof r.workflow !== 'string' || !/^[\w.-]+\.ya?ml$/.test(r.workflow))) throw new Error('.conductor/delivery.json "release.workflow" must be a workflow file name such as "release.yml".')
      if (r.assets !== undefined && !isArgv(r.assets)) throw new Error('.conductor/delivery.json "release.assets" must be a non-empty array of asset name suffixes.')
      config.release = { ...(r.workflow !== undefined ? { workflow: r.workflow as string } : {}), ...(r.assets !== undefined ? { assets: r.assets as string[] } : {}) }
    }
  }
  return config
}

function readConfig(root: string): DeliveryConfig {
  const file = join(root, '.conductor', 'delivery.json')
  return parseDeliveryConfig(existsSync(file) ? readFileSync(file, 'utf8') : null)
}

function packageScripts(root: string): Record<string, unknown> {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    return manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {}
  } catch { return {} }
}

function clip(text: string, limit = ERROR_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** The lines that say why a test or build failed; the tail alone is usually a summary. */
export function failureLines(lines: string[], limit = 20): string[] {
  const clean = lines.map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))
  const telling = clean.filter(line => /\bFAIL\b|error TS\d+|Error:|AssertionError|×|✗|\bnot ok\b/.test(line))
  return (telling.length ? telling : clean).slice(-limit)
}

const short = (sha: string | null): string => (sha ?? '').slice(0, 7)

// ---------------------------------------------------------------------------------------------

class StageFailure extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'cancelled' = 'failed') { super(message) }
}

class Cancelled extends Error {}

interface GitResult { code: number | null; stdout: string; lines: string[] }

interface Active {
  run: DeliveryRun
  root: string
  controller: AbortController
  finished: boolean
  pushed: boolean
  settle: () => void
}

interface Plan {
  root: string
  config: DeliveryConfig
  entries: PorcelainEntry[]
  changedPaths: string[]
  snapshots: DeliverySnapshot[]
  scope: string[] | null
  commitNeeded: boolean
  isolate: boolean
  github: { owner: string; repo: string } | null
  test: string[] | null
  defaultTest: boolean
  testSkip: string
  build: string[] | null
  defaultBuild: boolean
  buildSkip: string
  release: { workflow: string; assets: string[]; dispatch: boolean } | null
  releaseSkip: string
  publish: boolean
}

interface VerificationCommand { command: string; args: string[]; env?: NodeJS.ProcessEnv }
interface DeliverySnapshot { path: string; blob: string | null; mode: string }

const sharedCore = (path: string): boolean =>
  path === 'package.json' || path === 'package-lock.json' || path === 'tsconfig.json'
  || /^(?:vitest|electron\.vite)\.config\.[cm]?[jt]s$/.test(path)
  || path.startsWith('src/shared/')
  || ['src/main/database.ts', 'src/main/structured-store.ts', 'src/main/structured-sessions.ts', 'src/main/agent-control.ts'].includes(path)

/** Whether a workflow file runs on push. A dispatch-only workflow (the shape this project uses,
 *  so that pushes never build a release by themselves) has to be started by the delivery. Read
 *  as text: the only question is whether `push` appears as a trigger under `on`. */
export function workflowRunsOnPush(text: string): boolean {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => /^(on|"on"|'on'):\s*(\S.*)?$/.test(line))
  if (start < 0) return false
  const inline = /^(on|"on"|'on'):\s*(\S.*)$/.exec(lines[start]!)?.[2] ?? ''
  if (inline) return /\bpush\b/.test(inline.replace(/#.*$/, ''))
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (/^\S/.test(line)) break
    if (/^\s+(-\s*)?push\s*:?\s*(#.*)?$/.test(line)) return true
  }
  return false
}

type GithubResponse = { ok: true; data: any } | { ok: false; status: number; message: string }

/**
 * The host-side "ship it" pipeline: preflight, test, build, commit, push, then wait for the GitHub
 * release the push triggers. It lives in the main process because it needs what agent sandboxes do
 * not have — the owner's Git credentials and a working TLS stack to reach GitHub.
 */
export class DeliveryService {
  private readonly deps: DeliveryDependencies
  private readonly latest = new Map<string, DeliveryRun>()
  private readonly active = new Map<string, Active>()
  private readonly done = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(run: DeliveryRun) => void>()
  private readonly emitTimers = new Map<string, NodeJS.Timeout>()
  /** Detached verification trees are expensive to register and populate on Windows. Keep one
   *  cleanable tree per repository for this host process and reset it to the next delivery's HEAD. */
  private readonly worktrees = new Map<string, { dir: string; parent: string }>()

  constructor(deps: Partial<DeliveryDependencies> = {}) {
    this.deps = {
      run: spawnCommand,
      fetch: (...args) => fetch(...args),
      githubToken: async () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null,
      now: () => new Date(),
      sleep: abortableSleep,
      tempDir: () => tmpdir(),
      ...deps
    }
  }

  onChanged(listener: (run: DeliveryRun) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  current(projectId: string): DeliveryRun | null {
    const run = this.latest.get(projectId)
    return run ? snapshot(run) : null
  }

  async status(projectId: string, cwd: string): Promise<RepositoryStatus> {
    const checkedAt = this.deps.now().toISOString()
    const result: RepositoryStatus = { projectId, available: false, reason: null, branch: null, upstream: null, ahead: 0, behind: 0, head: null, headSubject: null, files: [], github: null, releaseWorkflow: false, checkedAt }
    const signal = new AbortController().signal
    const git = async (args: string[], at = cwd): Promise<GitResult> => {
      try { return await this.git(args, at, signal) } catch { return { code: null, stdout: '', lines: [] } }
    }
    try {
      const top = await git(['rev-parse', '--show-toplevel'])
      if (top.code !== 0) return { ...result, reason: existsSync(cwd) ? 'This project is not a Git repository.' : 'The project folder does not exist.' }
      const root = resolve(top.stdout.trim())
      const reasons: string[] = []
      const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)
      result.branch = branch.code === 0 ? branch.stdout.trim() || null : null
      if (!result.branch) reasons.push('HEAD is detached; check out a branch to deliver.')
      const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)
      result.upstream = upstream.code === 0 ? upstream.stdout.trim() || null : null
      if (result.upstream) {
        const counts = await git(['rev-list', '--left-right', '--count', '@{u}...HEAD'], root)
        const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
        if (counts.code === 0) { result.behind = behind || 0; result.ahead = ahead || 0 }
      }
      const head = await git(['log', '-1', '--format=%H%x00%s'], root)
      if (head.code === 0 && head.stdout.includes('\0')) {
        const [sha, subject] = head.stdout.replace(/\r?\n$/, '').split('\0')
        result.head = sha || null; result.headSubject = subject ?? null
      }
      const files = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)
      result.files = parsePorcelain(files.stdout).map(({ path, index, worktree }) => ({ path, index, worktree }))
      let config: DeliveryConfig | null = null
      try { config = readConfig(root) } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)) }
      const remoteName = config?.remote ?? 'origin'
      const remote = await git(['remote', 'get-url', remoteName], root)
      if (remote.code !== 0) reasons.push(`There is no "${remoteName}" remote to push to.`)
      else result.github = parseGithubRemote(remote.stdout)
      if (config && result.branch && result.branch !== config.branch) reasons.push(`On branch ${result.branch}; delivery pushes ${config.branch}.`)
      const workflow = config?.release?.workflow ?? 'release.yml'
      result.releaseWorkflow = Boolean(result.github && config?.release !== null && existsSync(join(root, '.github', 'workflows', workflow)))
      return { ...result, available: reasons.length === 0, reason: reasons.length ? reasons.join(' ') : null }
    } catch (error) {
      return { ...result, reason: `Could not read the repository: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  ship(projectId: string, cwd: string, request: { message: string; paths?: string[]; publish?: boolean }, requestedBy: DeliveryRequester): DeliveryRun {
    const root = resolve(cwd)
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    for (const [id, active] of this.active) {
      const activeKey = process.platform === 'win32' ? active.root.toLowerCase() : active.root
      if (id === projectId || activeKey === key) {
        throw new Error(active.run.state === 'running'
          ? `Delivery ${active.run.id} is already running for this ${id === projectId ? 'project' : 'folder'}; wait for it or cancel it first.`
          : `Delivery ${active.run.id} was cancelled and is still stopping its last command; try again in a moment.`)
      }
    }
    const now = this.deps.now().toISOString()
    const run: DeliveryRun = {
      id: `delivery-${randomUUID()}`, projectId, state: 'running', requestedBy: { ...requestedBy },
      message: typeof request?.message === 'string' ? request.message : '',
      paths: Array.isArray(request?.paths) ? [...request.paths] : null,
      publish: request?.publish === true,
      startedAt: now, finishedAt: null, commit: null, releaseTag: null, releaseUrl: null, workflowRunUrl: null,
      stages: DELIVERY_STAGES.map(({ id, label }) => ({ id, label, state: 'pending', startedAt: null, finishedAt: null, detail: '', log: [] })),
      error: null
    }
    let settle = (): void => {}
    this.done.set(run.id, new Promise<void>(resolvePromise => { settle = resolvePromise }))
    const active: Active = { run, root, controller: new AbortController(), finished: false, pushed: false, settle }
    this.active.set(projectId, active)
    this.latest.set(projectId, run)
    this.emit(run)
    void this.execute(active).catch(error => this.finalize(active, 'failed', `Delivery crashed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (this.active.get(projectId) === active) this.active.delete(projectId) })
    return snapshot(run)
  }

  async wait(projectId: string, runId: string, timeoutMs: number): Promise<DeliveryRun> {
    const run = this.latest.get(projectId)
    if (!run || run.id !== runId) throw new Error(`No delivery ${runId} is known for this project.`)
    if (run.state === 'running') {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([this.done.get(runId), new Promise<void>(resolvePromise => { timer = setTimeout(resolvePromise, Math.max(0, timeoutMs)); timer.unref?.() })])
      clearTimeout(timer)
    }
    return snapshot(run)
  }

  cancel(projectId: string): DeliveryRun | null {
    const active = this.active.get(projectId)
    if (!active || active.finished) return this.current(projectId)
    const afterPush = active.pushed
    active.controller.abort(new Cancelled('cancelled'))
    this.finalize(active, 'cancelled', afterPush
      ? `Cancelled after the push: commit ${short(active.run.commit)} is already on the remote and its release workflow keeps running on GitHub; Conductor only stopped watching it.`
      : 'Cancelled by request before anything was pushed.', afterPush)
    return snapshot(active.run)
  }

  // -------------------------------------------------------------------------------------------

  private async execute(active: Active): Promise<void> {
    const signal = active.controller.signal
    try {
      let plan!: Plan
      await this.stage(active, 'preflight', async () => { const checked = await this.preflight(active); plan = checked.plan; return checked.detail })
      const worktree = plan.isolate && (plan.test || plan.build) ? await this.createWorktree(active, plan) : null
      const verifyAt = worktree?.dir ?? plan.root
      const where = worktree ? ' in an isolated worktree holding the frozen delivery snapshot' : ' in the working tree'
      const verification = [
        ['test', this.testCommands(plan), plan.testSkip],
        ['build', this.buildCommands(plan, verifyAt), plan.buildSkip]
      ] as const
      const running: Promise<void>[] = []
      for (const [id, commands, skip] of verification) {
        if (!commands.length) { this.skip(active, id, skip); continue }
        running.push(this.stage(active, id, async stage => {
          const results = await Promise.all(commands.map(async ({ command, args, env }) => ({ command, args, result: await this.command(active, stage, command, args, verifyAt, VERIFY_TIMEOUT_MS, { CI: '1', ...env }) })))
          const failed = results.find(entry => entry.result.code !== 0)
          if (failed) {
            const what = id === 'test' ? 'Tests failed' : 'The build failed'
            throw new StageFailure(`${what} (${[failed.command, ...failed.args].join(' ')}, exit ${failed.result.code ?? 'none'})${where}. Nothing was committed or pushed.\n${failureLines(failed.result.lines).join('\n')}`)
          }
          return `${results.map(entry => [entry.command, ...entry.args].join(' ')).join(' + ')} passed${where}.`
        }))
      }
      const verified = await Promise.allSettled(running)
      const failure = verified.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw failure.reason
      if (!plan.commitNeeded) this.skip(active, 'commit', 'No changes to commit; pushing the local commits that are ahead of the remote.')
      else await this.stage(active, 'commit', stage => this.commit(active, stage, plan))
      if (!plan.publish) {
        // The default: the commit is the delivery. A hosted release build is only worth its
        // minutes when another device has to update, and that is a separate, explicit ask.
        this.skip(active, 'push', `Local delivery: commit ${short(active.run.commit)} stays on this machine. Publish (git.ship with publish: true, or the Source control panel's Publish switch) when other devices need a release.`)
        this.skip(active, 'release', 'Not published: no GitHub release was requested. The installed app on this machine updates from the checkout through app.update.')
        this.finalize(active, 'delivered', null)
        return
      }
      await this.stage(active, 'push', stage => this.push(active, stage, plan))
      active.pushed = true
      if (!plan.release) this.skip(active, 'release', plan.releaseSkip)
      else await this.stage(active, 'release', stage => this.release(active, stage, plan))
      this.finalize(active, 'delivered', null)
    } catch (error) {
      if (signal.aborted || error instanceof Cancelled) this.finalize(active, 'cancelled', 'Cancelled by request.', active.pushed)
      else if (error instanceof StageFailure) this.finalize(active, error.outcome, error.message)
      else this.finalize(active, 'failed', `Delivery stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private testCommands(plan: Plan): VerificationCommand[] {
    if (!plan.test) return []
    if (!plan.defaultTest) return [{ command: plan.test[0]!, args: plan.test.slice(1) }]
    const full = plan.publish || !plan.scope || plan.changedPaths.some(sharedCore)
    const commands: VerificationCommand[] = [{ command: 'npx', args: full ? ['vitest', 'run'] : ['vitest', 'related', ...plan.changedPaths, '--run', '--passWithNoTests'] }]
    if (plan.changedPaths.some(path => path === 'scripts' || path.startsWith('scripts/'))) commands.push({ command: 'npm', args: ['run', 'test:scripts'] })
    return commands
  }

  private buildCommands(plan: Plan, verifyAt: string): VerificationCommand[] {
    if (!plan.build) return []
    if (!plan.defaultBuild) return [{ command: plan.build[0]!, args: plan.build.slice(1) }]
    mkdirSync(join(verifyAt, '.conductor-scratch', 'delivery-cache'), { recursive: true })
    return [
      { command: 'npx', args: ['tsc', '--noEmit', '--incremental', '--tsBuildInfoFile', '.conductor-scratch/delivery-cache/tsconfig.tsbuildinfo'] },
      { command: 'npx', args: ['electron-vite', 'build'] }
    ]
  }

  private async preflight(active: Active): Promise<{ plan: Plan; detail: string }> {
    const { run } = active
    const stage = this.stageOf(run, 'preflight')
    const signal = active.controller.signal
    const message = run.message.trim()
    if (!message) throw new StageFailure('The commit message is empty.')
    if (run.message.length > MESSAGE_CHARS) throw new StageFailure(`The commit message is ${run.message.length} characters; the limit is ${MESSAGE_CHARS}.`)
    let scope: string[] | null = null
    if (run.paths) {
      // An empty list is the Source control panel's "commit nothing, push what is already committed".
      try { scope = [...new Set(run.paths.map(normalizeDeliveryPath))] } catch (error) { throw new StageFailure(error instanceof Error ? error.message : String(error)) }
    }
    const top = await this.git(['rev-parse', '--show-toplevel'], active.root, signal)
    if (top.code !== 0) throw new StageFailure(`${active.root} is not a Git repository.`)
    const root = resolve(top.stdout.trim())
    active.root = root
    let config: DeliveryConfig
    try { config = readConfig(root) } catch (error) { throw new StageFailure(error instanceof Error ? error.message : String(error)) }
    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, signal)
    if (branch.code !== 0 || !branch.stdout.trim()) throw new StageFailure('HEAD is detached; check out a branch before delivering.')
    if (branch.stdout.trim() !== config.branch) throw new StageFailure(`On branch ${branch.stdout.trim()}, but delivery pushes ${config.branch}. Switch branches or set "branch" in .conductor/delivery.json.`)
    const gitDir = await this.git(['rev-parse', '--absolute-git-dir'], root, signal)
    if (gitDir.code === 0) {
      const dir = gitDir.stdout.trim()
      const busy = [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase or am'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']].find(([name]) => existsSync(join(dir, name!)))
      if (busy) throw new StageFailure(`${busy[1]} is in progress; finish or abort it before delivering.`)
    }
    const publish = active.run.publish === true
    const remoteUrl = await this.git(['remote', 'get-url', config.remote], root, signal)
    if (remoteUrl.code !== 0 && publish) throw new StageFailure(`There is no "${config.remote}" remote to push to.`)
    const github = remoteUrl.code === 0 ? parseGithubRemote(remoteUrl.stdout) : null

    const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, signal)
    if (status.code !== 0) throw new StageFailure(`git status failed:\n${status.lines.slice(-10).join('\n')}`)
    const entries = parsePorcelain(status.stdout)
    let inside = entries
    if (scope) {
      const changed = entries.flatMap(entry => entry.from ? [entry.path, entry.from] : [entry.path])
      const missing = scope.filter(path => !changed.some(file => file === path || file.startsWith(`${path}/`)))
      if (missing.length) throw new StageFailure(`These paths have no changes to deliver: ${missing.join(', ')}. Paths must name changed files (or folders holding them) relative to the repository root.`)
      inside = entries.filter(entry => inScope(entry.path, scope!) || (entry.from !== null && inScope(entry.from, scope!)))
      // A rename is one change: committing only its new name would leave the old file behind.
      for (const entry of inside) for (const path of [entry.path, entry.from]) if (path && !inScope(path, scope)) scope.push(path)
    }
    const outside = scope ? entries.filter(entry => !inside.includes(entry)) : []
    const snapshots = await this.snapshotPaths(root, inside, signal)

    // A local delivery never touches the network: nothing is compared or pushed.
    let remoteExists = publish
    if (publish) {
      this.log(active, stage, [`git fetch ${config.remote} ${config.branch}`])
      const fetched = await this.git(['fetch', config.remote, config.branch], root, signal, NETWORK_TIMEOUT_MS)
      if (fetched.code !== 0) {
        if (fetched.lines.some(line => /couldn't find remote ref/i.test(line))) remoteExists = false
        else throw new StageFailure(`git fetch ${config.remote} ${config.branch} failed, so the remote cannot be compared:\n${fetched.lines.slice(-10).join('\n')}`)
      }
    }
    let ahead = 0, behind = 0
    if (!publish) {
      if (!inside.length) throw new StageFailure(scope && !scope.length ? 'Nothing to commit: no paths were selected. A local delivery commits changes; publish when there are commits to push.' : scope ? 'Nothing to commit: the requested paths have no changes.' : 'Nothing to commit: the working tree is clean.')
    } else if (remoteExists) {
      const counts = await this.git(['rev-list', '--left-right', '--count', `${config.remote}/${config.branch}...HEAD`], root, signal)
      const [b, a] = counts.stdout.trim().split(/\s+/).map(Number)
      if (counts.code === 0) { behind = b || 0; ahead = a || 0 }
    } else {
      const count = await this.git(['rev-list', '--count', 'HEAD'], root, signal)
      ahead = Number(count.stdout.trim()) || 0
    }
    if (publish && !inside.length && !ahead) throw new StageFailure(scope && !scope.length ? 'Nothing to deliver: no paths were selected and no local commits are ahead of the remote.' : scope ? 'Nothing to deliver: the requested paths have no changes and no local commits are ahead of the remote.' : 'Nothing to deliver: the working tree is clean and no local commits are ahead of the remote.')

    const scripts = packageScripts(root)
    const pick = (key: 'test' | 'build', script: string, argv: string[]): { argv: string[] | null; skip: string; default: boolean } => {
      const configured = config[key]
      if (configured === null) return { argv: null, skip: `Disabled in .conductor/delivery.json.`, default: false }
      if (configured) return { argv: configured, skip: '', default: false }
      if (typeof scripts[script] !== 'string') return { argv: null, skip: `package.json has no "${script}" script.`, default: false }
      const optimized = key === 'test' ? /\bvitest\b/.test(scripts[script] as string) : /\belectron-vite\s+build\b/.test(scripts[script] as string)
      return { argv, skip: '', default: optimized }
    }
    const test = pick('test', 'test', ['npm', 'test'])
    const build = pick('build', 'build', ['npm', 'run', 'build'])
    const workflow = config.release?.workflow ?? 'release.yml'
    let release: Plan['release'] = null
    let releaseSkip = ''
    if (config.release === null) releaseSkip = 'Release verification is disabled in .conductor/delivery.json.'
    else if (!github) releaseSkip = `The "${config.remote}" remote is not on GitHub, so there is no release to verify.`
    else if (!existsSync(join(root, '.github', 'workflows', workflow))) releaseSkip = `No .github/workflows/${workflow}, so the push is the delivery.`
    else {
      let text = ''
      try { text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8') } catch { /* unreadable: treated as push-triggered, the older shape */ }
      release = { workflow, assets: config.release?.assets ?? DEFAULT_ASSETS, dispatch: text ? !workflowRunsOnPush(text) : false }
    }

    const parts = [
      inside.length ? `${inside.length} changed file${inside.length === 1 ? '' : 's'}${scope ? ` in scope (${outside.length} other change${outside.length === 1 ? '' : 's'} stay uncommitted)` : ''}` : 'no uncommitted changes',
      publish ? `${ahead} local commit${ahead === 1 ? '' : 's'} ahead of ${config.remote}/${config.branch}` : 'local delivery (no push, no release)'
    ]
    if (behind) parts.push(`${behind} remote commit${behind === 1 ? '' : 's'} behind (the push will rebase onto them)`)
    if (publish && !remoteExists) parts.push(`${config.remote}/${config.branch} does not exist yet`)
    const changedPaths = [...new Set(inside.flatMap(entry => entry.from ? [entry.path, entry.from] : [entry.path]))]
    const plan: Plan = { root, config, entries, changedPaths, snapshots, scope, commitNeeded: inside.length > 0, isolate: inside.length > 0, github, test: test.argv, defaultTest: test.default, testSkip: test.skip, build: build.argv, defaultBuild: build.default, buildSkip: build.skip, release, releaseSkip, publish }
    return { plan, detail: `${parts.join('; ')}.` }
  }

  /** Freeze every changed path as a Git object before verification. The worktree can keep moving
   *  while tests run; these object IDs are both what the isolated tree sees and what commit uses. */
  private async snapshotPaths(root: string, entries: PorcelainEntry[], signal: AbortSignal): Promise<DeliverySnapshot[]> {
    const paths = [...new Set(entries.flatMap(entry => entry.from ? [entry.path, entry.from] : [entry.path]))]
    const snapshots: DeliverySnapshot[] = []
    for (const path of paths) {
      if (!existsSync(join(root, path))) { snapshots.push({ path, blob: null, mode: '100644' }); continue }
      const staged = await this.git(['ls-files', '-s', '--', path], root, signal)
      const mode = /^(100644|100755|120000)\s/.exec(staged.stdout.trim())?.[1] ?? (process.platform !== 'win32' && (statSync(join(root, path)).mode & 0o111) ? '100755' : '100644')
      const hashed = await this.git(['hash-object', '-w', '--', path], root, signal)
      const blob = hashed.stdout.trim()
      if (hashed.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(blob)) throw new StageFailure(`Could not snapshot ${path} before verification:\n${hashed.lines.slice(-10).join('\n')}`)
      snapshots.push({ path, blob, mode })
    }
    return snapshots
  }

  /** Other agents' unfinished work shares the tree, so a subset is verified on its own: a detached
   *  worktree of HEAD plus only the requested snapshots, with the repository's node_modules linked in. */
  private async createWorktree(active: Active, plan: Plan): Promise<{ dir: string; parent: string }> {
    const signal = active.controller.signal
    const key = process.platform === 'win32' ? plan.root.toLowerCase() : plan.root
    let worktree = this.worktrees.get(key)
    if (worktree && !existsSync(worktree.dir)) { this.worktrees.delete(key); worktree = undefined }
    const reused = Boolean(worktree)
    if (!worktree) {
      const parent = mkdtempSync(join(this.deps.tempDir(), 'conductor-delivery-'))
      worktree = { dir: join(parent, 'tree'), parent }
    }
    const { dir } = worktree
    const stage = this.stageOf(active.run, 'test')
    try {
      if (reused) {
        const head = await this.git(['rev-parse', 'HEAD'], plan.root, signal)
        if (head.code !== 0 || !head.stdout.trim()) throw new StageFailure(`Could not resolve HEAD before resetting the cached verification worktree:\n${head.lines.slice(-10).join('\n')}`)
        const reset = await this.git(['reset', '--hard', head.stdout.trim()], dir, signal)
        const clean = await this.git(['clean', '-fd', '-e', 'node_modules', '-e', '.conductor-scratch'], dir, signal)
        if (reset.code !== 0 || clean.code !== 0) throw new StageFailure(`Could not reset the cached verification worktree:\n${[...reset.lines, ...clean.lines].slice(-10).join('\n')}`)
      } else {
        const added = await this.git(['worktree', 'add', '--detach', dir, 'HEAD'], plan.root, signal)
        if (added.code !== 0) throw new StageFailure(`Could not create an isolated worktree to verify the requested paths:\n${added.lines.slice(-10).join('\n')}`)
        this.worktrees.set(key, worktree)
      }
      for (const snapshot of plan.snapshots) {
        const indexed = snapshot.blob
          ? await this.git(['update-index', '--add', '--cacheinfo', snapshot.mode, snapshot.blob, snapshot.path], dir, signal)
          : await this.git(['update-index', '--force-remove', '--', snapshot.path], dir, signal)
        if (indexed.code !== 0) throw new StageFailure(`Could not materialize the verified snapshot of ${snapshot.path}:\n${indexed.lines.slice(-10).join('\n')}`)
        if (snapshot.blob) {
          const checkedOut = await this.git(['checkout-index', '--force', '--', snapshot.path], dir, signal)
          if (checkedOut.code !== 0) throw new StageFailure(`Could not check out the verified snapshot of ${snapshot.path}:\n${checkedOut.lines.slice(-10).join('\n')}`)
        } else {
          try { rmSync(join(dir, snapshot.path), { recursive: true, force: true }) } catch { /* already absent */ }
        }
      }
      const modules = join(plan.root, 'node_modules')
      if (existsSync(modules) && existsSync(dir) && !existsSync(join(dir, 'node_modules'))) symlinkSync(modules, join(dir, 'node_modules'), 'junction')
      this.log(active, stage, [`Verifying in ${reused ? 'cached ' : ''}isolated worktree ${dir}`])
      return worktree
    } catch (error) {
      if (!reused) { this.worktrees.delete(key); await this.removeWorktree(plan.root, worktree).catch(() => undefined) }
      if (signal.aborted) throw new Cancelled('cancelled')
      throw error instanceof StageFailure ? error : new StageFailure(`Could not prepare the isolated worktree: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async removeWorktree(root: string, worktree: { dir: string; parent: string }): Promise<void> {
    // Unlink the junction first: a recursive delete that followed it would empty the real
    // repository's node_modules.
    const link = join(worktree.dir, 'node_modules')
    try {
      if (lstatSync(link).isSymbolicLink()) { try { unlinkSync(link) } catch { rmdirSync(link) } }
    } catch { /* no junction */ }
    const signal = new AbortController().signal
    await this.git(['worktree', 'remove', '--force', worktree.dir], root, signal).catch(() => undefined)
    try { rmSync(worktree.parent, { recursive: true, force: true }) } catch { /* best effort; prune below forgets it */ }
    await this.git(['worktree', 'prune'], root, signal).catch(() => undefined)
  }

  private async commit(active: Active, stage: DeliveryStage, plan: Plan): Promise<string> {
    // The message goes through a file: on Windows a multi-line message on the command line is
    // mangled by quoting, and it could be long.
    const file = join(this.deps.tempDir(), `conductor-commit-${active.run.id}.txt`)
    const index = join(this.deps.tempDir(), `conductor-index-${active.run.id}`)
    writeFileSync(file, active.run.message.replace(/\r\n/g, '\n'), 'utf8')
    const env = { GIT_INDEX_FILE: index }
    try {
      try { rmSync(index, { force: true }) } catch { /* Git needs a missing file, not an empty index. */ }
      const read = await this.command(active, stage, 'git', ['read-tree', 'HEAD'], plan.root, GIT_TIMEOUT_MS, env)
      if (read.code !== 0) throw new StageFailure(`Could not create the delivery index:\n${read.lines.slice(-15).join('\n')}`)
      for (const snapshot of plan.snapshots) {
        const indexed = snapshot.blob
          ? await this.command(active, stage, 'git', ['update-index', '--add', '--cacheinfo', snapshot.mode, snapshot.blob, snapshot.path], plan.root, GIT_TIMEOUT_MS, env)
          : await this.command(active, stage, 'git', ['update-index', '--force-remove', '--', snapshot.path], plan.root, GIT_TIMEOUT_MS, env)
        if (indexed.code !== 0) throw new StageFailure(`Could not add the verified snapshot of ${snapshot.path} to the delivery index:\n${indexed.lines.slice(-15).join('\n')}`)
      }
      const committed = await this.command(active, stage, 'git', ['commit', '-F', file], plan.root, COMMIT_TIMEOUT_MS, env)
      if (committed.code !== 0) throw new StageFailure(`git commit failed (a commit hook may have rejected it):\n${failureLines(committed.lines, 15).join('\n')}`)
    } finally {
      try { rmSync(file, { force: true }) } catch { /* temp file */ }
      try { rmSync(index, { force: true }) } catch { /* temp index */ }
    }
    const head = await this.git(['rev-parse', 'HEAD'], plan.root, active.controller.signal)
    active.run.commit = head.stdout.trim() || null
    // The real index may contain another worker's staged work. Reset only our exact paths to the
    // new HEAD, leaving their entries intact and leaving later working-tree bytes uncommitted.
    const committedPaths = plan.snapshots.map(snapshot => snapshot.path)
    if (committedPaths.length) await this.git(['reset', '--mixed', 'HEAD', '--', ...committedPaths], plan.root, active.controller.signal)
    const changed: string[] = []
    for (const snapshot of plan.snapshots) {
      let blob: string | null = null
      if (existsSync(join(plan.root, snapshot.path))) {
        const current = await this.git(['hash-object', '--', snapshot.path], plan.root, active.controller.signal)
        blob = current.code === 0 ? current.stdout.trim() : null
      }
      if (blob !== snapshot.blob) changed.push(`${snapshot.path} changed during delivery; the verified version was committed`)
    }
    if (changed.length) this.log(active, stage, changed)
    return `Committed ${short(active.run.commit)}${plan.scope ? ` with ${plan.scope.length} requested path${plan.scope.length === 1 ? '' : 's'}` : ''}.${changed.length ? ` ${changed.join('. ')}.` : ''}`
  }

  private async push(active: Active, stage: DeliveryStage, plan: Plan): Promise<string> {
    const { remote, branch } = plan.config
    const target = `${remote}/${branch}`
    const pushArgs = ['push', remote, `HEAD:${branch}`]
    let pushed = await this.command(active, stage, 'git', pushArgs, plan.root, NETWORK_TIMEOUT_MS)
    let rebased = false
    if (pushed.code !== 0 && pushed.lines.some(line => /non-fast-forward|\[rejected\]|fetch first|updates were rejected/i.test(line))) {
      const head = await this.git(['rev-parse', 'HEAD'], plan.root, active.controller.signal)
      const local = short(head.stdout.trim())
      // --autostash: a subset delivery leaves other agents' changes in the tree, which a plain
      // pull --rebase refuses to work around.
      const pulled = await this.command(active, stage, 'git', ['pull', '--rebase', '--autostash', remote, branch], plan.root, NETWORK_TIMEOUT_MS)
      if (pulled.code !== 0) {
        const conflicts = await this.git(['diff', '--name-only', '--diff-filter=U'], plan.root, active.controller.signal)
        const files = conflicts.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        await this.command(active, stage, 'git', ['rebase', '--abort'], plan.root, GIT_TIMEOUT_MS, undefined, new AbortController().signal)
        throw new StageFailure(files.length
          ? `${target} moved on and rebasing onto it conflicts in: ${files.slice(0, 30).join(', ')}. The rebase was aborted; commit ${local} is still local and nothing was pushed. Resolve the conflict and deliver again.`
          : `${target} moved on and git pull --rebase failed; the rebase was aborted, commit ${local} is still local and nothing was pushed:\n${pulled.lines.slice(-10).join('\n')}`)
      }
      rebased = true
      pushed = await this.command(active, stage, 'git', pushArgs, plan.root, NETWORK_TIMEOUT_MS)
    }
    if (pushed.code !== 0) throw new StageFailure(`git push ${remote} HEAD:${branch} failed${rebased ? ' after rebasing onto the remote' : ''}; the commit is still local:\n${pushed.lines.slice(-12).join('\n')}`)
    const head = await this.git(['rev-parse', 'HEAD'], plan.root, active.controller.signal)
    active.run.commit = head.stdout.trim() || active.run.commit
    return `Pushed ${short(active.run.commit)} to ${target}${rebased ? ' after rebasing onto newer remote commits' : ''}.`
  }

  private async release(active: Active, stage: DeliveryStage, plan: Plan): Promise<string> {
    const { owner, repo } = plan.github!
    const { workflow, assets } = plan.release!
    const sha = active.run.commit!
    const signal = active.controller.signal
    const token = await this.deps.githubToken().catch(() => null)
    const interval = token ? 20_000 : 45_000
    const started = this.deps.now().getTime()
    const elapsed = (): number => this.deps.now().getTime() - started
    const api = (path: string): Promise<GithubResponse> => this.github(active, stage, `https://api.github.com/repos/${owner}/${repo}${path}`, token, started + RELEASE_TIMEOUT_MS)
    if (plan.release!.dispatch) {
      // A dispatch-only workflow never runs on its own; this is the one place a release is asked
      // for, so an ordinary push (or a coworker's local delivery) can never start one by accident.
      if (!token) throw new StageFailure(`The push succeeded, but ${workflow} only runs on request and no GitHub token was available to start it. Run it once from the repository's Actions page (or \`gh workflow run ${workflow}\`), or sign Git in to GitHub so Conductor can start it next time.`)
      const dispatched = await this.deps.fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: 'POST', signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Conductor', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: plan.config.branch })
      })
      if (dispatched.status !== 204) throw new StageFailure(`The push succeeded, but GitHub answered ${dispatched.status} when asked to start ${workflow}. Start it from the repository's Actions page.`)
      this.log(active, stage, [`Started ${workflow} on ${plan.config.branch}`])
    }
    this.log(active, stage, [`Waiting for ${workflow} on ${short(sha)}`])
    let workflowRun: any = null
    let lastStatus = ''
    for (;;) {
      const response = await api(`/actions/runs?head_sha=${sha}&per_page=10`)
      if (!response.ok && (response.status === 401 || response.status === 404)) {
        throw new StageFailure(`GitHub answered ${response.status} for ${owner}/${repo}'s workflow runs${token ? '' : '; a private repository needs a GitHub token'}. The push succeeded; check the release on GitHub.`)
      }
      if (response.ok) {
        const runs: any[] = Array.isArray(response.data?.workflow_runs) ? response.data.workflow_runs : []
        workflowRun = runs.filter(entry => String(entry?.path ?? '').replace(/@.*$/, '').split('/').pop() === workflow || entry?.name === workflow)
          .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null
        if (workflowRun) {
          if (active.run.workflowRunUrl !== workflowRun.html_url) { active.run.workflowRunUrl = workflowRun.html_url ?? null; this.emit(active.run) }
          const now = `${workflowRun.status}${workflowRun.conclusion ? `/${workflowRun.conclusion}` : ''}`
          if (now !== lastStatus) { lastStatus = now; this.log(active, stage, [`Workflow run ${workflowRun.id}: ${now}`]) }
          if (workflowRun.status === 'completed') break
        }
      } else this.log(active, stage, [`GitHub answered ${response.status}: ${response.message}`])
      if (!workflowRun && elapsed() >= RELEASE_APPEAR_MS) throw new StageFailure(`No ${workflow} run appeared for ${short(sha)} within 5 minutes of the push. The push succeeded; check the repository's Actions page.`)
      if (elapsed() >= RELEASE_TIMEOUT_MS) throw new StageFailure(`${workflow} did not finish within 45 minutes (last status ${lastStatus || 'unknown'}). The push succeeded; the workflow may still complete: ${active.run.workflowRunUrl ?? ''}`)
      await this.deps.sleep(interval, signal)
      if (signal.aborted) throw new Cancelled('cancelled')
    }

    const conclusion = String(workflowRun.conclusion ?? '')
    if (conclusion === 'cancelled') {
      throw new StageFailure(`The ${workflow} run for ${short(sha)} was cancelled — superseded by a newer push. The commit is on ${plan.config.remote}/${plan.config.branch}; the newer run's release will include it.`, 'cancelled')
    }
    if (conclusion !== 'success') {
      const reasons = await this.failureAnnotations(api, workflowRun.id)
      if (reasons.length) this.log(active, stage, reasons.flatMap(reason => reason.split('\n')))
      throw new StageFailure(`The ${workflow} run for ${short(sha)} ended ${conclusion || 'unsuccessfully'}: ${active.run.workflowRunUrl ?? ''}${reasons.length ? `\n${reasons.join('\n')}` : ''}`)
    }

    // The workflow publishes the release as its last step, but the releases list can lag a moment.
    const since = String(workflowRun.run_started_at ?? workflowRun.created_at ?? '')
    let release: any = null
    for (let attempt = 0; attempt < 3 && !release; attempt++) {
      if (attempt) { await this.deps.sleep(interval, signal); if (signal.aborted) throw new Cancelled('cancelled') }
      const response = await api('/releases?per_page=10')
      if (!response.ok) continue
      const releases: any[] = Array.isArray(response.data) ? response.data.filter((entry: any) => entry && !entry.draft) : []
      release = releases.find(entry => entry.target_commitish === sha)
        ?? releases.filter(entry => String(entry.published_at ?? '') >= since).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0]
        ?? null
    }
    if (!release) throw new StageFailure(`${workflow} succeeded but no GitHub release for ${short(sha)} was found: ${active.run.workflowRunUrl ?? ''}`)
    active.run.releaseTag = release.tag_name ?? null
    active.run.releaseUrl = release.html_url ?? null
    const names: string[] = Array.isArray(release.assets) ? release.assets.map((asset: any) => String(asset?.name ?? '')) : []
    const missing = assets.filter(pattern => !names.some(name => name.endsWith(pattern)))
    this.log(active, stage, [`Release ${release.tag_name}: ${names.join(', ') || 'no assets'}`])
    if (missing.length) throw new StageFailure(`Release ${release.tag_name} is missing assets matching ${missing.join(', ')} (it has ${names.join(', ') || 'none'}). The installed app cannot update from it: ${release.html_url ?? ''}`)
    return `Release ${release.tag_name} published with ${assets.join(', ')}.`
  }

  /** Workflow logs need admin rights to download; the release workflow re-emits test failures as
   *  annotations precisely so this readable route explains a red run. */
  private async failureAnnotations(api: (path: string) => Promise<GithubResponse>, runId: number): Promise<string[]> {
    const jobs = await api(`/actions/runs/${runId}/jobs?per_page=50`)
    if (!jobs.ok) return []
    const failed: any[] = (Array.isArray(jobs.data?.jobs) ? jobs.data.jobs : []).filter((job: any) => job && job.conclusion && job.conclusion !== 'success' && job.conclusion !== 'skipped')
    const messages: string[] = []
    for (const job of failed.slice(0, 5)) {
      const step = (Array.isArray(job.steps) ? job.steps : []).find((entry: any) => entry?.conclusion === 'failure')
      messages.push(`Job "${job.name}" ${job.conclusion}${step ? ` at step "${step.name}"` : ''}`)
      const annotations = await api(`/check-runs/${job.id}/annotations?per_page=50`)
      if (!annotations.ok || !Array.isArray(annotations.data)) continue
      for (const annotation of annotations.data.slice(0, 20)) {
        if (annotation?.message) messages.push(`${annotation.title ? `${annotation.title}: ` : ''}${String(annotation.message)}`)
      }
    }
    return messages.join('\n').length > ERROR_CHARS ? [clip(messages.join('\n'), ERROR_CHARS - 200)] : messages
  }

  /** One GitHub REST call; rate limiting waits it out instead of failing the delivery. */
  private async github(active: Active, stage: DeliveryStage, url: string, token: string | null, deadline: number): Promise<GithubResponse> {
    const signal = active.controller.signal
    for (;;) {
      let response: Response
      try {
        response = await this.deps.fetch(url, { signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Conductor', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
      } catch (error) {
        if (signal.aborted) throw new Cancelled('cancelled')
        return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
      }
      if (response.ok) return { ok: true, data: await response.json() }
      const text = await response.text().catch(() => '')
      const limited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after') || /rate limit/i.test(text)))
      if (!limited) return { ok: false, status: response.status, message: clip(text, 300) }
      const retryAfter = Number(response.headers.get('retry-after'))
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      const now = this.deps.now().getTime()
      let wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? reset * 1000 - now : 60_000
      wait = Math.min(Math.max(wait, 5_000), RATE_LIMIT_CAP_MS, Math.max(0, deadline - now))
      if (wait <= 0) return { ok: false, status: response.status, message: 'GitHub rate limit' }
      this.log(active, stage, [`GitHub rate limit; waiting ${Math.round(wait / 1000)} s`])
      await this.deps.sleep(wait, signal)
      if (signal.aborted) throw new Cancelled('cancelled')
    }
  }

  // -------------------------------------------------------------------------------------------
  // Stage bookkeeping

  private stageOf(run: DeliveryRun, id: DeliveryStageId): DeliveryStage {
    return run.stages.find(stage => stage.id === id)!
  }

  private async stage(active: Active, id: DeliveryStageId, body: (stage: DeliveryStage) => Promise<string>): Promise<void> {
    if (active.finished) throw new Cancelled('cancelled')
    const stage = this.stageOf(active.run, id)
    stage.state = 'running'
    stage.startedAt = this.deps.now().toISOString()
    this.emit(active.run)
    const result = await body(stage)
    if (active.controller.signal.aborted || active.finished) throw new Cancelled('cancelled')
    stage.state = 'passed'
    stage.finishedAt = this.deps.now().toISOString()
    stage.detail = clip(result, 500)
    this.emit(active.run)
  }

  private skip(active: Active, id: DeliveryStageId, detail: string): void {
    if (active.finished) throw new Cancelled('cancelled')
    const stage = this.stageOf(active.run, id)
    const now = this.deps.now().toISOString()
    Object.assign(stage, { state: 'skipped', startedAt: now, finishedAt: now, detail })
    this.emit(active.run)
  }

  private log(active: Active, stage: DeliveryStage, lines: string[]): void {
    if (active.finished) return
    const clean = lines.map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd().slice(0, LINE_CHARS)).filter(Boolean)
    if (!clean.length) return
    stage.log = [...stage.log, ...clean].slice(-LOG_LINES)
    this.emitSoon(active.run)
  }

  private async git(args: string[], cwd: string, signal: AbortSignal, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
    const lines: string[] = []
    const result = await this.deps.run('git', args, { cwd, timeoutMs, signal, env: { GIT_TERMINAL_PROMPT: '0' }, onLine: line => { if (lines.length < 2000) lines.push(line) } })
    if (signal.aborted) throw new Cancelled('cancelled')
    return { ...result, lines }
  }

  /** A command whose output belongs in the stage log. Keeps a longer tail than the log for
   *  failure extraction, since the failing test is rarely in the last 40 lines. */
  private async command(active: Active, stage: DeliveryStage, command: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv, signal = active.controller.signal): Promise<GitResult> {
    const lines: string[] = []
    this.log(active, stage, [`> ${command} ${args.join(' ')}`])
    const result = await this.deps.run(command, args, {
      cwd, timeoutMs, signal, env: { GIT_TERMINAL_PROMPT: '0', ...env },
      onLine: line => { lines.push(line); if (lines.length > 800) lines.splice(0, lines.length - 400); this.log(active, stage, [line]) }
    })
    if (signal.aborted) throw new Cancelled('cancelled')
    return { ...result, lines }
  }

  private finalize(active: Active, state: 'delivered' | 'failed' | 'cancelled', error: string | null, afterPush = false): void {
    if (active.finished) return
    active.finished = true
    const { run } = active
    const now = this.deps.now().toISOString()
    for (const stage of run.stages) {
      if (stage.state !== 'running') continue
      stage.finishedAt = now
      if (state === 'cancelled' && afterPush && stage.id === 'release') {
        stage.state = 'skipped'
        stage.detail = 'Stopped watching: the push already happened and the release workflow keeps running on GitHub.'
      } else {
        stage.state = 'failed'
        stage.detail = clip(state === 'cancelled' ? (error && /superseded/.test(error) ? 'Cancelled: superseded by a newer push.' : 'Cancelled.') : (error ?? 'Failed.').split('\n')[0]!, 500)
      }
    }
    run.state = state
    run.finishedAt = now
    run.error = error === null ? null : clip(error)
    this.emit(run)
    active.settle()
  }

  private emitSoon(run: DeliveryRun): void {
    if (this.emitTimers.has(run.id)) return
    const timer = setTimeout(() => { this.emitTimers.delete(run.id); this.broadcast(run) }, EMIT_INTERVAL_MS)
    timer.unref?.()
    this.emitTimers.set(run.id, timer)
  }

  private emit(run: DeliveryRun): void {
    const pending = this.emitTimers.get(run.id)
    if (pending) { clearTimeout(pending); this.emitTimers.delete(run.id) }
    this.broadcast(run)
  }

  private broadcast(run: DeliveryRun): void {
    for (const listener of [...this.listeners]) {
      try { listener(snapshot(run)) } catch { /* a broken listener must not stop a delivery */ }
    }
  }
}

function snapshot(run: DeliveryRun): DeliveryRun {
  return { ...run, requestedBy: { ...run.requestedBy }, paths: run.paths ? [...run.paths] : null, stages: run.stages.map(stage => ({ ...stage, log: [...stage.log] })) }
}
