import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { RuntimeHostClient } from './client'
import { RUNTIME_HOST_FEATURES, RUNTIME_HOST_PROTOCOL, type HostLock } from './protocol'

export interface RuntimeHostLaunch {
  userData: string
  /** The bundled host entry (out/main/runtime-host.js). */
  hostScript: string
  /** A packaged app copies its runtime out of the install directory, which the NSIS installer
   *  clears of every process on update (docs/runtime-host.md). A checkout runs its own. */
  packaged: boolean
  /** When no host is running: start one (true) or report none (false). */
  start: boolean
  log?(message: string): void
}

const hostDirectory = (userData: string): string => join(userData, 'runtime-host')
export const readHostLock = (userData: string): HostLock | null => {
  try { return JSON.parse(readFileSync(join(hostDirectory(userData), 'host.json'), 'utf8')) as HostLock } catch { return null }
}

/** Connects to this profile's runtime host, starting one when asked to. */
export async function connectRuntimeHost(launch: RuntimeHostLaunch): Promise<RuntimeHostClient | null> {
  const lock = readHostLock(launch.userData)
  if (lock && lock.protocol === RUNTIME_HOST_PROTOCOL) {
    try {
      const client = await RuntimeHostClient.connect(lock.pipe, lock.secret)
      // A host outlives the app, so after an update it is the previous build's. One that keeps
      // nothing running is replaced, so this build's host features (RUNTIME_HOST_FEATURES) apply.
      const missing = RUNTIME_HOST_FEATURES.filter(feature => !client.features.includes(feature))
      if (!launch.start || !missing.length || (await client.list()).length) return client
      launch.log?.(`replacing idle runtime host ${client.hostPid}: it predates ${missing.join(', ')}`)
      await client.shutdown().catch(() => { /* it is going anyway */ })
      client.dispose()
      const gone = Date.now() + 5000
      while (processAlive(client.hostPid) && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 100))
    } catch (error) { launch.log?.(`runtime host lock found but unreachable: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (!launch.start) return null
  await fs.mkdir(hostDirectory(launch.userData), { recursive: true })
  const runtime = launch.packaged ? await copiedRuntime(launch.userData) : process.execPath
  const script = launch.packaged ? await copiedScript(launch.userData, launch.hostScript) : launch.hostScript
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS
  // A test-profile host must not outlive the app that started it: a restart smoke left detached
  // host processes running 35 min after their app was gone (feature-list.md:
  // smoke-instances-never-leak). It watches the smoke launcher, so the host still survives a test
  // restart. Off test mode the host is meant to survive an app restart, so this
  // is never set for a real launch.
  if (process.env.CONDUCTOR_TEST_USER_DATA) environment.CONDUCTOR_RUNTIME_HOST_WATCH_PID = process.env.CONDUCTOR_TEST_PARENT_PID || String(process.pid)
  startDetached(runtime, [script, '--user-data', launch.userData], environment, hostDirectory(launch.userData), launch.log)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150))
    const started = readHostLock(launch.userData)
    if (!started || started.protocol !== RUNTIME_HOST_PROTOCOL || started.secret === lock?.secret) continue
    try { return await RuntimeHostClient.connect(started.pipe, started.secret) } catch { /* not listening yet */ }
  }
  throw new Error('The runtime host did not start within 15 s')
}

const processAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }

/** Windows command-line quoting (CommandLineToArgvW rules). */
export const quoteWindowsArgument = (value: string): string =>
  value && !/[\s"]/.test(value) ? value : `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`

/**
 * Starts the host with none of this process's handles. On Windows every child Node spawns is
 * created with handle inheritance on, and Chromium's listening sockets (the
 * --remote-debugging-port among them) are inheritable: a host started that way held the old app's
 * port after the app was gone, so a relaunched app never answered on it (FX12, feature-list.md
 * runtime-host-handle-inheritance). PowerShell's Start-Process starts it through ShellExecuteEx,
 * which hands the new process no handles; PowerShell itself exits at once. If that route fails the
 * host is spawned directly, as before.
 */
function startDetached(executable: string, args: string[], environment: NodeJS.ProcessEnv, cwd: string, log?: (message: string) => void): void {
  const direct = (): void => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true, env: environment, cwd })
    child.on('error', error => log?.(`runtime host could not start: ${error.message}`))
    child.unref()
  }
  if (process.platform !== 'win32') { direct(); return }
  // Paths travel in the environment, never inside the PowerShell command text.
  const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Start-Process -FilePath $env:CONDUCTOR_RUNTIME_HOST_EXE -ArgumentList $env:CONDUCTOR_RUNTIME_HOST_ARGS -WorkingDirectory $env:CONDUCTOR_RUNTIME_HOST_CWD -WindowStyle Hidden'], {
    stdio: 'ignore', windowsHide: true, cwd,
    env: { ...environment, CONDUCTOR_RUNTIME_HOST_EXE: executable, CONDUCTOR_RUNTIME_HOST_ARGS: args.map(quoteWindowsArgument).join(' '), CONDUCTOR_RUNTIME_HOST_CWD: cwd }
  })
  let fellBack = false
  const fallBack = (reason: string): void => {
    if (fellBack) return
    fellBack = true
    log?.(`runtime host could not be started without inherited handles (${reason}); starting it directly`)
    direct()
  }
  launcher.on('error', error => fallBack(error.message))
  launcher.on('exit', code => { if (code !== 0) fallBack(`PowerShell exited with ${code}`) })
}

/** The Electron files running as plain Node needs, copied once per Electron version. */
const RUNTIME_FILES = ['icudtl.dat', 'ffmpeg.dll', 'snapshot_blob.bin', 'v8_context_snapshot.bin']
async function copiedRuntime(userData: string): Promise<string> {
  const source = dirname(process.execPath)
  const target = join(hostDirectory(userData), `runtime-${process.versions.electron ?? 'node'}-${statSync(process.execPath).size}`)
  const executable = join(target, process.platform === 'win32' ? 'conductor-runtime-host.exe' : 'conductor-runtime-host')
  if (existsSync(executable)) return executable
  const staging = `${target}.${process.pid}.tmp`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  await fs.copyFile(process.execPath, join(staging, basename(executable)))
  for (const file of RUNTIME_FILES) if (existsSync(join(source, file))) await fs.copyFile(join(source, file), join(staging, file))
  try { await fs.rename(staging, target) } catch (error) {
    // Another launch finished the same copy first.
    await fs.rm(staging, { recursive: true, force: true })
    if (!existsSync(executable)) throw error
  }
  await pruneRuntimes(userData, basename(target))
  return executable
}

/** Old runtime copies whose executable nobody is running any more (a running one cannot be deleted). */
async function pruneRuntimes(userData: string, keep: string): Promise<void> {
  for (const entry of await fs.readdir(hostDirectory(userData)).catch(() => [] as string[])) {
    if (!entry.startsWith('runtime-') || entry === keep) continue
    await fs.rm(join(hostDirectory(userData), entry), { recursive: true, force: true }).catch(() => { /* still running */ })
  }
}

/** The host bundle lives inside app.asar; a host reading it there would keep the archive open. */
async function copiedScript(userData: string, hostScript: string): Promise<string> {
  const content = await fs.readFile(hostScript)
  const target = join(hostDirectory(userData), `host-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.js`)
  if (!existsSync(target)) {
    await fs.mkdir(hostDirectory(userData), { recursive: true })
    await fs.writeFile(target + '.tmp', content)
    await fs.rename(target + '.tmp', target)
  }
  return target
}
