import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { RestorePointStore } from './restore-points'

/** Where a candidate build is: making its worktree, copying node_modules into it, building,
 *  running its smokes, or done. Null for a build of the working tree itself. */
export type LocalUpdateStage = 'worktree' | 'dependencies' | 'build' | 'smoke' | 'done'

/** One smoke script run against a candidate build. `log` is the full output on disk; `tail` holds
 *  its last lines once it failed. */
export interface LocalUpdateSmoke {
  name: string
  state: 'pending' | 'running' | 'passed' | 'failed'
  exitCode: number | null
  startedAt: string | null
  finishedAt: string | null
  log: string | null
  note?: string
  tail?: string[]
}

/** What a caller can learn about the local update build without watching the console. The log is
 *  a bounded tail: a full electron-builder run is tens of thousands of lines, and the last of them
 *  are the only ones that say what happened. */
export interface LocalUpdateBuildStatus {
  state: 'idle' | 'running' | 'succeeded' | 'failed'
  workspace: string | null
  startedAt: string | null
  finishedAt: string | null
  version: string | null
  feedDirectory: string | null
  exitCode: number | null
  message: string
  log: string[]
  /** The exact commit a candidate build was made from, and the clean worktree it was built in. */
  commit: string | null
  worktree: string | null
  stage: LocalUpdateStage | null
  smokes: LocalUpdateSmoke[]
  /** True when every requested smoke passed, false when one failed or never ran, null when none were asked for. */
  verified: boolean | null
}

/** app.update({commit, smoke}): build that commit in a clean worktree instead of the working tree,
 *  then run the named scripts/smoke-*.mjs against it. */
export interface LocalUpdateRequest { commit?: string; smoke?: string[] }

export interface LocalUpdateBuildService {
  /** Null when this workspace can produce a local update; otherwise why it cannot. */
  unsupported(workspace: string): string | null
  /** Throws, saying why, when this request cannot be built (unknown commit or smoke, dirty worktree). */
  validate?(workspace: string, request: LocalUpdateRequest): void
  status(): LocalUpdateBuildStatus
  start(workspace: string, request?: LocalUpdateRequest): LocalUpdateBuildStatus
}

const LOG_LINES = 40
const SMOKE_TAIL_LINES = 20
const MAX_SMOKES = 12
const BUILD_TIMEOUT_MS = 45 * 60 * 1000
const COPY_TIMEOUT_MS = 20 * 60 * 1000
const SMOKE_RUN_MINUTES = 20
// smoke-lock waits up to an hour for the machine-wide lock, then runs for at most SMOKE_RUN_MINUTES.
const SMOKE_TIMEOUT_MS = (60 + SMOKE_RUN_MINUTES + 10) * 60 * 1000
const COMMIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,99}$/
const SMOKE_PATTERN = /^smoke-[a-z0-9][a-z0-9-]*$/
const FEED_DESCRIPTOR = 'conductor-local-build.json'
const idle = (): LocalUpdateBuildStatus => ({ state: 'idle', workspace: null, startedAt: null, finishedAt: null, version: null, feedDirectory: null, exitCode: null, message: 'No local update has been built since Conductor started.', log: [], commit: null, worktree: null, stage: null, smokes: [], verified: null })

/** The npm and node the build needs are the host's, not Electron's. Inside a packaged app
 *  process.execPath is Conductor.exe and has no npm beside it, so a real node on PATH is
 *  preferred and Electron-as-node is only the fallback. */
function hostNode(): { executable: string; asNode: boolean } {
  const own = basename(process.execPath).toLowerCase()
  if (own === 'node.exe' || own === 'node') return { executable: process.execPath, asNode: false }
  const found = onPath(process.platform === 'win32' ? ['node.exe', 'node.cmd'] : ['node'])
  return found ? { executable: found, asNode: false } : { executable: process.execPath, asNode: true }
}

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

/** npm-cli.js beside whichever node this machine actually installed. build-local-update.mjs
 *  takes npm_execpath as its first candidate, which is how npm itself hands it down. */
function npmCli(nodeExecutable: string): string | null {
  const candidates = [process.env.npm_execpath, join(dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const npm = onPath(process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'])
  if (npm) candidates.push(join(dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  return candidates.find(path => path && path.endsWith('.js') && existsSync(path)) ?? null
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

const samePath = (a: string, b: string): boolean => {
  const left = resolve(a), right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** `git worktree list --porcelain`, reduced to the worktrees that still exist on disk. */
function worktrees(workspace: string): Array<{ path: string; head: string }> {
  const found: Array<{ path: string; head: string }> = []
  for (const block of git(workspace, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1], head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1]
    if (path && head && !/^prunable/m.test(block) && existsSync(path)) found.push({ path: resolve(path), head })
  }
  return found
}

/** node_modules entries that are junctions or symlinks. electron-builder walks node_modules to
 *  collect production dependencies and silently drops what it reaches through one, so the
 *  installed app then dies at launch with "Cannot find module" (fs-extra, the last time). */
function linkedModules(root: string): string[] {
  const modules = join(root, 'node_modules')
  if (!existsSync(modules)) return []
  if (lstatSync(modules).isSymbolicLink()) return ['node_modules']
  const linked: string[] = []
  for (const entry of readdirSync(modules)) {
    const path = join(modules, entry)
    let stat
    try { stat = lstatSync(path) } catch { continue }
    if (stat.isSymbolicLink()) { linked.push(`node_modules/${entry}`); continue }
    if (!entry.startsWith('@') || !stat.isDirectory()) continue
    for (const scoped of readdirSync(path)) {
      try { if (lstatSync(join(path, scoped)).isSymbolicLink()) linked.push(`node_modules/${entry}/${scoped}`) } catch { /* vanished while listing */ }
    }
  }
  return linked
}

/** The environment a smoke runs in: the host's, minus what would make it act as, or report to,
 *  this Conductor instead of launching its own parked one. */
function smokeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('CONDUCTOR_TEST_') || ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_BACKGROUND_WINDOWS', 'CONDUCTOR_LIVE_TESTS'].includes(key)) delete env[key]
  }
  return env
}

interface CandidatePlan { commit: string; worktree: string; reuse: boolean; smokes: string[] }

/**
 * Runs `scripts/build-local-update.mjs` on the host, once at a time, and keeps the result where
 * a conversation can read it back. The build itself is the existing `npm run update:local`
 * pipeline — it publishes into the installed app's local feed and never launches an installer —
 * so what this adds is only that a conversation can ask for it and then poll for the outcome
 * instead of holding a tool call open for the twenty minutes electron-builder takes.
 *
 * With a commit it builds that commit rather than the shared working tree, which carries every
 * other agent's unfinished edits: in a clean detached worktree under ../conductor-candidates/,
 * with a real copy of the checkout's node_modules, and then runs the named smokes there through
 * scripts/smoke-lock.mjs, one at a time and parked (docs/overseer.md, "Delivering one commit").
 */
export class LocalUpdateBuilder implements LocalUpdateBuildService {
  private current: LocalUpdateBuildStatus = idle()
  private child: ChildProcess | null = null
  private disposed = false

  /** `feedDirectory` overrides where the build publishes; a test instance passes its own profile's
   *  feed so its builds never reach the installed app's (see update-install-seam.ts).
   *  `candidatesDirectory` overrides where commit worktrees go (tests). */
  constructor(private readonly options: { modelsList?: () => unknown; feedDirectory?: () => string | null; candidatesDirectory?: (workspace: string) => string } = {}) {}

  unsupported(workspace: string): string | null {
    if (process.platform !== 'win32') return 'Local installed-app updates currently require Windows x64.'
    if (!process.env.APPDATA) return 'APPDATA is unavailable, so the installed app’s local update feed cannot be located.'
    if (!existsSync(join(workspace, 'scripts', 'build-local-update.mjs'))) return 'This project has no scripts/build-local-update.mjs; only a Conductor checkout can build a Conductor update.'
    try {
      const manifest = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name !== 'conductor-desktop') return 'This project is not the Conductor desktop app, so it cannot build a Conductor update.'
    } catch { return 'This project has no readable package.json.' }
    if (!existsSync(join(workspace, 'node_modules', 'electron-builder', 'cli.js'))) return 'electron-builder is not installed in this checkout; run npm install on the host first.'
    return null
  }

  validate(workspace: string, request: LocalUpdateRequest): void {
    if (request.commit !== undefined || request.smoke !== undefined) this.plan(resolve(workspace), request)
  }

  status(): LocalUpdateBuildStatus { return { ...this.current, log: [...this.current.log], smokes: this.current.smokes.map(smoke => ({ ...smoke, ...(smoke.tail ? { tail: [...smoke.tail] } : {}) })) } }

  start(workspace: string, request: LocalUpdateRequest = {}): LocalUpdateBuildStatus {
    if (this.current.state === 'running') return this.status()
    const root = resolve(workspace)
    const reason = this.unsupported(root)
    if (reason) throw new Error(reason)
    const plan = request.commit !== undefined || request.smoke !== undefined ? this.plan(root, request) : null
    const node = hostNode()
    const npm = npmCli(node.executable)
    if (!npm) throw new Error('Could not find npm on this machine; the build needs the host’s Node.js installation.')
    if (plan?.smokes.length && node.asNode) throw new Error('Smokes need a node.exe on PATH; only Conductor’s own Electron was found, and a smoke launched through it would not start Electron.')
    this.current = {
      ...idle(), state: 'running', workspace: root, startedAt: new Date().toISOString(), log: [],
      message: plan ? `Building commit ${plan.commit.slice(0, 10)} in ${plan.worktree}; this takes several minutes${plan.smokes.length ? ', then the smokes run one at a time' : ''}.` : 'Building a local Conductor update; this takes several minutes.',
      ...(plan ? { commit: plan.commit, worktree: plan.worktree, stage: 'worktree' as const, smokes: plan.smokes.map(name => ({ name, state: 'pending' as const, exitCode: null, startedAt: null, finishedAt: null, log: null })), verified: plan.smokes.length ? false : null } : {})
    }
    if (!plan) { this.build(root, node, npm).then(code => this.built(code)); return this.status() }
    this.candidate(root, plan, node, npm).catch(error => this.finish(null, `The candidate build stopped: ${error instanceof Error ? error.message : String(error)}`))
    return this.status()
  }

  /** Stop watching a build at shutdown; the spawned build is left to finish or die with the app. */
  dispose(): void {
    this.disposed = true
    this.child?.removeAllListeners()
    this.child = null
  }

  /** Resolves the commit, checks every smoke name against that commit's scripts/, and picks the
   *  worktree: an existing clean one at that commit, else a new one under conductor-candidates. */
  private plan(root: string, request: LocalUpdateRequest): CandidatePlan {
    if (request.commit === undefined) throw new Error('smoke needs commit: smokes run against a clean build of one commit, never the shared working tree. Pass commit (a sha, or HEAD).')
    if (!COMMIT_PATTERN.test(request.commit)) throw new Error(`commit must be a sha or ref such as HEAD, not ${JSON.stringify(request.commit)}`)
    let commit: string
    try { commit = git(root, ['rev-parse', '--verify', '--quiet', `${request.commit}^{commit}`]) } catch { throw new Error(`No commit ${request.commit} in ${root}. Commit the work first (git.ship), then pass its sha.`) }
    const exists = (path: string): boolean => { try { git(root, ['cat-file', '-e', `${commit}:${path}`]); return true } catch { return false } }
    const smokes: string[] = []
    for (const raw of request.smoke ?? []) {
      const name = raw.trim().replace(/^scripts[\\/]/, '').replace(/\.mjs$/, '')
      if (!SMOKE_PATTERN.test(name) || name === 'smoke-lock') throw new Error(`smoke names a scripts/smoke-*.mjs file, such as smoke-permission-grant; ${JSON.stringify(raw)} is not one.`)
      if (!exists(`scripts/${name}.mjs`)) throw new Error(`Commit ${commit.slice(0, 10)} has no scripts/${name}.mjs.`)
      if (!smokes.includes(name)) smokes.push(name)
    }
    if (smokes.length > MAX_SMOKES) throw new Error(`At most ${MAX_SMOKES} smokes per build; they run one at a time.`)
    if (smokes.length && !exists('scripts/smoke-lock.mjs')) throw new Error(`Commit ${commit.slice(0, 10)} has no scripts/smoke-lock.mjs to run its smokes under.`)
    const candidates = this.options.candidatesDirectory?.(root) ?? resolve(root, '..', 'conductor-candidates')
    // Only a candidates worktree is reused: one elsewhere at the same commit is another agent's.
    const existing = worktrees(root).find(tree => tree.head === commit && samePath(dirname(tree.path), candidates))
    const worktree = existing?.path ?? join(candidates, commit.slice(0, 7))
    if (existing) {
      const dirty = git(worktree, ['status', '--porcelain'])
      if (dirty) throw new Error(`The worktree ${worktree} at ${commit.slice(0, 10)} has uncommitted changes (${dirty.split(/\r?\n/).slice(0, 3).join('; ')}), so its build would not be that commit. Remove it (git worktree remove --force "${worktree}") and call app.update again.`)
      const linked = linkedModules(worktree)
      if (linked.length) throw new Error(`The worktree ${worktree} has a junction in node_modules (${linked.slice(0, 3).join(', ')}); electron-builder would package an app missing its dependencies. Delete its node_modules and call app.update again: Conductor copies a real one.`)
    } else if (existsSync(worktree)) {
      throw new Error(`${worktree} exists but is not a worktree at ${commit.slice(0, 10)}. Move it away or remove it (git worktree remove), then call app.update again.`)
    }
    return { commit, worktree, reuse: Boolean(existing), smokes }
  }

  private async candidate(root: string, plan: CandidatePlan, node: { executable: string; asNode: boolean }, npm: string): Promise<void> {
    const short = plan.commit.slice(0, 10)
    if (!plan.reuse) {
      mkdirSync(dirname(plan.worktree), { recursive: true })
      const added = await this.run('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'worktree', 'add', '--detach', plan.worktree, plan.commit], root, 5 * 60_000)
      if (added !== 0) return this.finish(added, `git worktree add failed (exit ${added ?? -1}); the log tail says why.`)
    } else this.append(`Reusing the clean worktree ${plan.worktree} at ${short}.`)
    this.current.stage = 'dependencies'
    // A real copy: robocopy follows junctions and copies what they point at.
    const copied = await this.run('robocopy', [join(root, 'node_modules'), join(plan.worktree, 'node_modules'), '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NP', '/R:1', '/W:1'], root, COPY_TIMEOUT_MS)
    if (copied === null || copied >= 8) return this.finish(copied, `Copying node_modules into ${plan.worktree} failed (robocopy exit ${copied ?? -1}).`)
    const linked = linkedModules(plan.worktree)
    if (linked.length) return this.finish(null, `node_modules in ${plan.worktree} still has junctions (${linked.slice(0, 3).join(', ')}); not building an app that would miss its dependencies.`)
    try { git(root, ['diff', '--quiet', plan.commit, '--', 'package-lock.json']) }
    catch { this.append(`Warning: package-lock.json at ${short} differs from the checkout's; node_modules was copied from the checkout.`) }
    this.current.stage = 'build'
    const code = await this.build(plan.worktree, node, npm)
    if (code !== 0) return this.built(code)
    const feed = this.current.feedDirectory
    let descriptor: { commit?: unknown; dirty?: unknown; version?: unknown } | null = null
    try { descriptor = feed ? JSON.parse(readFileSync(join(feed, FEED_DESCRIPTOR), 'utf8')) : null } catch { /* reported below */ }
    if (descriptor?.commit !== plan.commit || descriptor?.dirty !== false) {
      return this.finish(code, `The build finished, but the feed records ${descriptor ? `commit ${String(descriptor.commit).slice(0, 10)} dirty=${String(descriptor.dirty)}` : 'no readable descriptor'} instead of ${short} dirty=false; not treating it as that commit.`)
    }
    this.pruneRestorePoints()
    if (!plan.smokes.length) {
      this.current.stage = 'done'
      return this.finish(0, `Local update ${this.current.version ?? ''} built from ${short} (dirty=false) in ${plan.worktree} and published; Conductor offers “Update pending”. Nothing was installed: app.update.install does that once no tab is mid-turn.`)
    }
    this.current.stage = 'smoke'
    for (const smoke of this.current.smokes) {
      if (this.disposed) return
      await this.smoke(plan.worktree, smoke, node.executable)
    }
    const failed = this.current.smokes.filter(smoke => smoke.state !== 'passed')
    this.current.verified = failed.length === 0
    this.current.stage = 'done'
    this.finish(0, failed.length
      ? `Local update ${this.current.version ?? ''} built from ${short} and published, but NOT verified: ${failed.map(smoke => smoke.name).join(', ')} failed (smokes[].tail and smokes[].log say why). Do not install it before that is understood.`
      : `Local update ${this.current.version ?? ''} built from ${short} (dirty=false) and verified: ${this.current.smokes.length} smoke${this.current.smokes.length === 1 ? '' : 's'} passed. Nothing was installed: app.update.install does that once no tab is mid-turn.`)
  }

  /** One smoke through smoke-lock, so it waits for any other smoke or build on this machine. */
  private async smoke(worktree: string, smoke: LocalUpdateSmoke, node: string): Promise<void> {
    const directory = join(worktree, '.conductor-scratch', 'candidate-smokes')
    mkdirSync(directory, { recursive: true })
    smoke.log = join(directory, `${smoke.name}.log`)
    smoke.state = 'running'
    smoke.startedAt = new Date().toISOString()
    const tail: string[] = []
    const file = createWriteStream(smoke.log)
    const code = await this.run(node, [join(worktree, 'scripts', 'smoke-lock.mjs'), '--timeout-min', String(SMOKE_RUN_MINUTES), '--', node, join('scripts', `${smoke.name}.mjs`)], worktree, SMOKE_TIMEOUT_MS, {
      env: smokeEnvironment(),
      onText: text => {
        file.write(text)
        tail.push(...text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).map(line => line.slice(0, 500)))
        tail.splice(0, Math.max(0, tail.length - SMOKE_TAIL_LINES))
      }
    })
    await new Promise<void>(done => file.end(done))
    smoke.exitCode = code
    smoke.finishedAt = new Date().toISOString()
    // smoke-lock's 3 is "the command passed, but some process could not be accounted for".
    smoke.state = code === 0 || code === 3 ? 'passed' : 'failed'
    if (code === 3) smoke.note = 'Passed; smoke-lock could not account for every process it started (exit 3), see the log.'
    if (smoke.state === 'failed') smoke.tail = tail
  }

  /** scripts/build-local-update.mjs in `cwd`, streamed into the status. */
  private build(cwd: string, node: { executable: string; asNode: boolean }, npm: string): Promise<number | null> {
    const feedDirectory = this.options.feedDirectory?.()
    return this.run(node.executable, [join(cwd, 'scripts', 'build-local-update.mjs'), ...(feedDirectory ? ['--feed-dir', feedDirectory] : [])], cwd, BUILD_TIMEOUT_MS, {
      env: {
        ...process.env, npm_execpath: npm,
        ...(this.options.modelsList ? { CONDUCTOR_MODELS_LIST_JSON: JSON.stringify(this.options.modelsList()) } : {}),
        ...(node.asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
    })
  }

  /** Spawns one step and resolves with its exit code, or null when it could not start or was
   *  killed. Its output goes to the status log unless `onText` takes it. */
  private run(command: string, args: string[], cwd: string, timeoutMs: number, options: { env?: NodeJS.ProcessEnv; onText?: (text: string) => void } = {}): Promise<number | null> {
    return new Promise(done => {
      const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env })
      this.child = child
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      timer.unref?.()
      const mine = (): boolean => this.child === child
      const absorb = (chunk: Buffer): void => { if (!mine()) return; if (options.onText) options.onText(chunk.toString('utf8')); else this.append(chunk.toString('utf8')) }
      child.stdout?.on('data', absorb)
      child.stderr?.on('data', absorb)
      child.on('error', error => {
        if (!mine()) return
        clearTimeout(timer); this.child = null
        this.append(`${basename(command)} could not be started: ${error instanceof Error ? error.message : 'unknown error'}`)
        done(null)
      })
      child.on('close', code => {
        if (!mine()) return
        clearTimeout(timer); this.child = null
        done(code)
      })
    })
  }

  private built(code: number | null): void {
    if (this.disposed) return
    if (code === 0) this.pruneRestorePoints()
    if (code === 0 && this.current.stage) this.current.stage = 'done'
    this.finish(code, code === 0
      ? `Local update ${this.current.version ?? 'build'} published. Open Conductor’s update control — it offers “Update pending”; nothing has been installed for you.`
      : `The local update build failed (exit ${code ?? -1}). The log tail says why.`)
  }

  private pruneRestorePoints(): void {
    if (!this.current.feedDirectory) return
    try { new RestorePointStore(this.current.feedDirectory).prune() }
    catch (error) { this.append(`Restore point pruning warning: ${error instanceof Error ? error.message : String(error)}`) }
  }

  private append(text: string): void {
    const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean)
    if (!lines.length) return
    for (const line of lines) {
      const ready = /^Local update ready:\s*(\S+)/.exec(line)
      if (ready) this.current.version = ready[1]!
      const building = /^Building (\d+\.\d+\.\d+-local\.\d+)/.exec(line)
      if (building && !this.current.version) this.current.version = building[1]!
      const feed = /^Feed:\s*(.+)$/.exec(line)
      if (feed) this.current.feedDirectory = feed[1]!.trim()
    }
    this.current.log = [...this.current.log, ...lines.map(line => line.slice(0, 500))].slice(-LOG_LINES)
  }

  private finish(code: number | null, message: string): void {
    if (this.disposed) return
    this.current = { ...this.current, state: code === 0 ? 'succeeded' : 'failed', exitCode: code, finishedAt: new Date().toISOString(), message }
  }
}
