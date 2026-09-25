import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { RestorePointStore } from './restore-points'

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
}

export interface LocalUpdateBuildService {
  /** Null when this workspace can produce a local update; otherwise why it cannot. */
  unsupported(workspace: string): string | null
  status(): LocalUpdateBuildStatus
  start(workspace: string): LocalUpdateBuildStatus
}

const LOG_LINES = 40
const BUILD_TIMEOUT_MS = 45 * 60 * 1000
const idle = (): LocalUpdateBuildStatus => ({ state: 'idle', workspace: null, startedAt: null, finishedAt: null, version: null, feedDirectory: null, exitCode: null, message: 'No local update has been built since Conductor started.', log: [] })

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

/**
 * Runs `scripts/build-local-update.mjs` on the host, once at a time, and keeps the result where
 * a conversation can read it back. The build itself is the existing `npm run update:local`
 * pipeline — it publishes into the installed app's local feed and never launches an installer —
 * so what this adds is only that a conversation can ask for it and then poll for the outcome
 * instead of holding a tool call open for the twenty minutes electron-builder takes.
 */
export class LocalUpdateBuilder implements LocalUpdateBuildService {
  private current: LocalUpdateBuildStatus = idle()
  private child: ChildProcess | null = null

  /** `feedDirectory` overrides where the build publishes; a test instance passes its own profile's
   *  feed so its builds never reach the installed app's (see update-install-seam.ts). */
  constructor(private readonly options: { modelsList?: () => unknown; feedDirectory?: () => string | null } = {}) {}

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

  status(): LocalUpdateBuildStatus { return { ...this.current, log: [...this.current.log] } }

  start(workspace: string): LocalUpdateBuildStatus {
    if (this.current.state === 'running') return this.status()
    const root = resolve(workspace)
    const reason = this.unsupported(root)
    if (reason) throw new Error(reason)
    const node = hostNode()
    const npm = npmCli(node.executable)
    if (!npm) throw new Error('Could not find npm on this machine; the build needs the host’s Node.js installation.')
    const started = new Date().toISOString()
    this.current = { state: 'running', workspace: root, startedAt: started, finishedAt: null, version: null, feedDirectory: null, exitCode: null, message: 'Building a local Conductor update; this takes several minutes.', log: [] }
    const feedDirectory = this.options.feedDirectory?.()
    const child = spawn(node.executable, [join(root, 'scripts', 'build-local-update.mjs'), ...(feedDirectory ? ['--feed-dir', feedDirectory] : [])], {
      cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, npm_execpath: npm,
        ...(this.options.modelsList ? { CONDUCTOR_MODELS_LIST_JSON: JSON.stringify(this.options.modelsList()) } : {}),
        ...(node.asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
    })
    this.child = child
    const timer = setTimeout(() => child.kill('SIGKILL'), BUILD_TIMEOUT_MS)
    timer.unref?.()
    const mine = (): boolean => this.child === child
    const absorb = (chunk: Buffer): void => { if (mine()) this.append(chunk.toString('utf8')) }
    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)
    child.on('error', error => {
      if (!mine()) return
      clearTimeout(timer); this.child = null
      this.finish(null, `The build could not be started: ${error instanceof Error ? error.message : 'unknown error'}`)
    })
    child.on('close', code => {
      if (!mine()) return
      clearTimeout(timer); this.child = null
      if (code === 0 && this.current.feedDirectory) {
        try { new RestorePointStore(this.current.feedDirectory).prune() }
        catch (error) { this.append(`Restore point pruning warning: ${error instanceof Error ? error.message : String(error)}`) }
      }
      this.finish(code, code === 0
        ? `Local update ${this.current.version ?? 'build'} published. Open Conductor’s update control — it offers “Update pending”; nothing has been installed for you.`
        : `The local update build failed (exit ${code ?? -1}). The log tail says why.`)
    })
    return this.status()
  }

  /** Stop watching a build at shutdown; the spawned build is left to finish or die with the app. */
  dispose(): void {
    this.child?.removeAllListeners()
    this.child = null
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
    this.current = { ...this.current, state: code === 0 ? 'succeeded' : 'failed', exitCode: code, finishedAt: new Date().toISOString(), message }
  }
}
