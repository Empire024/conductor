/** Entry of the detached runtime host process (docs/runtime-host.md). Bundled on its own into
 *  out/main/runtime-host.js with only node: imports, so the copy under userData runs by itself. */
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeHost } from './host'
import { RUNTIME_HOST_PROTOCOL, runtimeHostPipe, type HostLock } from './protocol'

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const userData = argument('--user-data')
if (!userData) { process.stderr.write('runtime host: --user-data is required\n'); process.exit(2) }
const directory = join(userData, 'runtime-host')
mkdirSync(directory, { recursive: true })
const logPath = join(directory, 'host.log'), lockPath = join(directory, 'host.json')

const log = (message: string): void => {
  try {
    try { if (statSync(logPath).size > 1024 * 1024) renameSync(logPath, logPath + '.1') } catch { /* no log yet */ }
    appendFileSync(logPath, `${new Date().toISOString()} [${process.pid}] ${message}\n`)
  } catch { /* logging never ends the host */ }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }

const existing = ((): HostLock | null => { try { return JSON.parse(readFileSync(lockPath, 'utf8')) as HostLock } catch { return null } })()
if (existing && existing.pid !== process.pid && alive(existing.pid)) { log(`another host (pid ${existing.pid}) holds the lock; exiting`); process.exit(0) }

const lock: HostLock = { pid: process.pid, pipe: runtimeHostPipe(userData), secret: randomBytes(32).toString('hex'), protocol: RUNTIME_HOST_PROTOCOL, startedAt: new Date().toISOString() }
const idleMs = Number(process.env.CONDUCTOR_RUNTIME_HOST_IDLE_MS) || undefined
const release = (): void => {
  try { if ((JSON.parse(readFileSync(lockPath, 'utf8')) as HostLock).pid === process.pid) rmSync(lockPath, { force: true }) } catch { /* someone else's lock now */ }
}
const host = new RuntimeHost({ pipe: lock.pipe, secret: lock.secret, idleMs, log, onIdle: () => { release(); log('exiting'); process.exit(0) } })

process.on('uncaughtException', error => log(`uncaught: ${error.stack ?? error.message}`))
process.on('unhandledRejection', error => log(`unhandled: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))

host.listen().then(() => {
  const temporary = lockPath + '.' + process.pid
  writeFileSync(temporary, JSON.stringify(lock), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, lockPath)
  log(`listening on ${lock.pipe}`)
}, (error: NodeJS.ErrnoException) => {
  // Another host won the race for the pipe: it is the one to use.
  log(`could not listen (${error.code ?? error.message}); exiting`)
  process.exit(0)
})
