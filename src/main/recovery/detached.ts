import { spawn } from 'node:child_process'
import { existsSync, promises as fs, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { quoteWindowsArgument } from '../runtime-host/launcher'

/* The watchdog runs the way the runtime host does (docs/runtime-host.md): from the Electron runtime
 * copied out of the install directory, which the NSIS installer clears of every process, and
 * started without inheriting any of the app's handles. The copy is the host's own
 * (<userData>/runtime-host/runtime-<electron>-<size>), so the two share it. */

const RUNTIME_FILES = ['icudtl.dat', 'ffmpeg.dll', 'snapshot_blob.bin', 'v8_context_snapshot.bin']

export async function watchdogRuntime(userData: string, execPath = process.execPath): Promise<string> {
  const target = join(userData, 'runtime-host', `runtime-${process.versions.electron ?? 'node'}-${statSync(execPath).size}`)
  const executable = join(target, process.platform === 'win32' ? 'conductor-runtime-host.exe' : 'conductor-runtime-host')
  if (existsSync(executable)) return executable
  const staging = `${target}.${process.pid}.recovery.tmp`
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  await fs.copyFile(execPath, join(staging, basename(executable)))
  for (const file of RUNTIME_FILES) if (existsSync(join(dirname(execPath), file))) await fs.copyFile(join(dirname(execPath), file), join(staging, file))
  try { await fs.rename(staging, target) } catch (error) {
    // The runtime host's launcher finished the same copy first.
    await fs.rm(staging, { recursive: true, force: true })
    if (!existsSync(executable)) throw error
  }
  return executable
}

/** PowerShell's Start-Process (ShellExecuteEx) hands the watchdog none of the app's handles, so it
 *  never holds a listening socket or pipe of the app it outlives; a plain detached spawn otherwise. */
export function startWatchdogProcess(executable: string, args: string[], environment: NodeJS.ProcessEnv, cwd: string, log: (message: string) => void): void {
  const direct = (): void => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true, env: environment, cwd })
    child.on('error', error => log(`recovery: watchdog could not start: ${error.message}`))
    child.unref()
  }
  if (process.platform !== 'win32') { direct(); return }
  const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Start-Process -FilePath $env:CONDUCTOR_WATCHDOG_EXE -ArgumentList $env:CONDUCTOR_WATCHDOG_ARGS -WorkingDirectory $env:CONDUCTOR_WATCHDOG_CWD -WindowStyle Hidden'], {
    stdio: 'ignore', windowsHide: true, cwd,
    env: { ...environment, CONDUCTOR_WATCHDOG_EXE: executable, CONDUCTOR_WATCHDOG_ARGS: args.map(quoteWindowsArgument).join(' '), CONDUCTOR_WATCHDOG_CWD: cwd }
  })
  let fellBack = false
  const fallBack = (reason: string): void => {
    if (fellBack) return
    fellBack = true
    log(`recovery: watchdog could not be started without inherited handles (${reason}); starting it directly`)
    direct()
  }
  launcher.on('error', error => fallBack(error.message))
  launcher.on('exit', code => { if (code !== 0) fallBack(`PowerShell exited with ${code}`) })
}
