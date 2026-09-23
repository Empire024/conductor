import { spawn as realSpawn, execFile } from 'node:child_process'
import { appendFileSync, closeSync, createWriteStream, existsSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { clientFromCredential } from './control-client.mjs'
import { devLayout, installedUserData, pidAlive, readCredential } from './credentials.mjs'
import { CHECKOUT, newestMtime, sleep as realSleep, tailFile } from './util.mjs'

/** A client for an already running app, or a reason it is not reachable. */
export async function connect(userData, { isAlive = pidAlive, clientOptions } = {}) {
  const read = await readCredential(userData, { isAlive })
  if (!read.ok) return { ok: false, reason: read.reason, credential: read.credential }
  const client = clientFromCredential(read.credential, clientOptions)
  try {
    await client.call('tools.list', {}, null, { timeoutMs: 15_000 })
    return { ok: true, client, credential: read.credential }
  } catch (error) {
    return { ok: false, reason: error.message, credential: read.credential }
  }
}

export const connectInstalled = (options = {}) => connect(installedUserData(options.env), options)

/** Warn when the compiled main process is older than the newest source file. */
export async function buildStaleness(checkout = CHECKOUT) {
  const entry = resolve(checkout, 'out', 'main', 'index.js')
  let built = 0
  try { built = (await stat(entry)).mtimeMs } catch { return { stale: true, reason: `${entry} does not exist; run build` } }
  const newest = await newestMtime(resolve(checkout, 'src'))
  return newest > built ? { stale: true, reason: `out/main/index.js (${new Date(built).toISOString()}) is older than the newest file under src/ (${new Date(newest).toISOString()})` } : { stale: false }
}

/**
 * `npm run build` in the checkout. npm.cmd cannot be spawned with shell:false on current Node
 * (EINVAL since the .cmd argument-injection fix), so npm's own CLI runs under this node binary.
 */
export async function runBuild({ checkout = CHECKOUT, logPath, spawn = realSpawn } = {}) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const [command, args] = existsSync(npmCli) ? [process.execPath, [npmCli, 'run', 'build']] : [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build']]
  if (logPath) await mkdir(dirname(logPath), { recursive: true })
  const started = Date.now()
  const chunks = []
  const exitCode = await new Promise((done) => {
    const child = spawn(command, args, { cwd: checkout, shell: false, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
    const sink = logPath ? createWriteStream(logPath) : null
    const collect = chunk => { chunks.push(chunk); sink?.write(chunk) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => { collect(Buffer.from(`spawn failed: ${error.message}\n`)); sink?.end(); done(-1) })
    child.on('close', code => { sink?.end(); done(code ?? -1) })
  })
  const text = Buffer.concat(chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))).toString('utf8')
  return { ok: exitCode === 0, exitCode, durationMs: Date.now() - started, logPath: logPath ?? null, tail: text.split(/\r?\n/).slice(-40).join('\n') }
}

function taskkill(pid) {
  return new Promise(done => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done()))
}

/**
 * The parked dev instance: a real Electron app on the checkout's out/ build with its own
 * userData and projects root, window off-screen and never activated.
 */
export class DevInstance {
  constructor({ checkout = CHECKOUT, userData, projectsRoot, runDir, log = () => {}, spawn = realSpawn, electronPath, isAlive = pidAlive, sleep = realSleep, startTimeoutMs = 120_000 } = {}) {
    const layout = devLayout(checkout)
    this.checkout = checkout
    this.userData = userData ?? layout.userData
    this.projectsRoot = projectsRoot ?? layout.projectsRoot
    this.pidFile = join(layout.base, 'dev-app.json')
    this.runDir = runDir ?? join(layout.base, 'app-logs')
    this.log = log
    this.spawn = spawn
    this.electronPath = electronPath
    this.isAlive = isAlive
    this.sleep = sleep
    this.startTimeoutMs = startTimeoutMs
    this.launches = 0
    this.child = null
    this.client = null
  }

  async electron() {
    if (this.electronPath) return this.electronPath
    const module = await import('electron')
    return module.default
  }

  /** Reuse a running dev instance if it answers and is newer than the build; else (re)launch. */
  async ensure() {
    const existing = await connect(this.userData, { isAlive: this.isAlive })
    if (existing.ok) {
      let built = 0
      try { built = (await stat(resolve(this.checkout, 'out', 'main', 'index.js'))).mtimeMs } catch { /* none */ }
      if (Date.parse(existing.credential.startedAt ?? '') >= built) {
        this.client = existing.client
        this.pid = existing.credential.pid
        this.log(`dev app already running (pid ${this.pid}), reusing it`)
        return this.client
      }
      this.log('dev app is running an older build; restarting it')
    }
    return this.restart()
  }

  async start() {
    const staleness = await buildStaleness(this.checkout)
    if (staleness.stale) this.log(`warning: ${staleness.reason}`)
    await mkdir(this.userData, { recursive: true })
    await mkdir(this.projectsRoot, { recursive: true })
    await mkdir(this.runDir, { recursive: true })
    await rm(join(this.userData, 'control-owner.json'), { force: true })
    const env = { ...process.env, CONDUCTOR_TEST_USER_DATA: this.userData, CONDUCTOR_PROJECTS_ROOT: this.projectsRoot, CONDUCTOR_BACKGROUND_WINDOWS: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.CONDUCTOR_OFFLINE_TESTS
    this.launches += 1
    const logPath = join(this.runDir, `app-${this.launches}.log`)
    const spawnedAt = Date.now()
    // Detached, logging through file descriptors rather than pipes: a pipe would keep a plain
    // `app start` command alive until something killed it, and the app with it. The child
    // outlives this process; stop() finds it again through the credential and pid files.
    const logFd = openSync(logPath, 'a')
    let child
    try {
      child = this.spawn(await this.electron(), [resolve(this.checkout, 'out', 'main', 'index.js')], { cwd: this.checkout, env, windowsHide: true, detached: true, stdio: ['ignore', logFd, logFd] })
    } finally { closeSync(logFd) }
    child.unref?.()
    this.child = child
    this.exited = new Promise(done => child.once('exit', code => { this.child = null; done(code) }))
    child.once('error', error => { try { appendFileSync(logPath, `spawn error: ${error.message}\n`) } catch { /* the log is best effort */ } })
    this.log(`dev app launching (pid ${child.pid}), log ${logPath}`)
    const deadline = spawnedAt + this.startTimeoutMs
    let lastReason = ''
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(`dev app exited during startup; log tail:\n${await tailFile(logPath, 30) ?? ''}`)
      const read = await readCredential(this.userData, { isAlive: this.isAlive })
      if (read.ok && (read.credential.pid === child.pid || Date.parse(read.credential.startedAt ?? '') >= spawnedAt - 1000)) {
        const attempt = await connect(this.userData, { isAlive: this.isAlive })
        if (attempt.ok) {
          this.client = attempt.client
          this.pid = attempt.credential.pid
          await writeFile(this.pidFile, JSON.stringify({ pid: child.pid, appPid: this.pid, startedAt: new Date(spawnedAt).toISOString(), log: logPath }) + '\n')
          this.log(`dev app ready (pid ${this.pid}, version ${attempt.credential.appVersion ?? '?'})`)
          return this.client
        }
        lastReason = attempt.reason
      } else lastReason = read.reason
      await this.sleep(1000)
    }
    await this.stop()
    throw new Error(`dev app did not answer within ${Math.round(this.startTimeoutMs / 1000)} s (${lastReason})`)
  }

  /** Stop our child, or a dev instance a previous overseer process left running. */
  async stop() {
    const pids = new Set()
    if (this.child?.pid) pids.add(this.child.pid)
    const read = await readCredential(this.userData, { isAlive: this.isAlive })
    if (read.credential?.pid && this.isAlive(read.credential.pid)) pids.add(read.credential.pid)
    try { const recorded = JSON.parse(await readFile(this.pidFile, 'utf8')); if (recorded.pid && this.isAlive(recorded.pid)) pids.add(recorded.pid) } catch { /* none */ }
    if (this.child) { try { this.child.kill() } catch { /* already gone */ } }
    if (this.exited) await Promise.race([this.exited, this.sleep(5000)])
    for (const pid of pids) if (this.isAlive(pid)) await taskkill(pid)
    for (let wait = 0; wait < 30 && [...pids].some(pid => this.isAlive(pid)); wait++) await this.sleep(500)
    await rm(this.pidFile, { force: true })
    this.child = null
    this.client = null
    if (pids.size) this.log(`dev app stopped (pid ${[...pids].join(', ')})`)
  }

  async restart() {
    await this.stop()
    return this.start()
  }
}
