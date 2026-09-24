// Runs one command under a machine-wide lock so concurrent agents never run two Electron smokes
// (or a build and a smoke) at once: docs/machine-profile.md asks for smokes one at a time because
// parallel ones push each other past their timeouts. Usage:
//   node scripts/smoke-lock.mjs -- <command> [args...]
// The lock is a directory under the OS temp folder (mkdir is atomic). A holder older than
// LOCK_STALE_MS is treated as abandoned and replaced. Exit code is the command's.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOCK_DIR = join(tmpdir(), 'conductor-smoke.lock')
const LOCK_STALE_MS = 20 * 60 * 1000
const POLL_MS = 5000

const separator = process.argv.indexOf('--')
const command = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2)
if (!command.length) { console.error('usage: node scripts/smoke-lock.mjs -- <command> [args...]'); process.exit(2) }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function acquire() {
  const started = Date.now()
  for (;;) {
    try { mkdirSync(LOCK_DIR); writeFileSync(join(LOCK_DIR, 'holder.txt'), `${process.pid} ${new Date().toISOString()} ${command.join(' ')}\n`); return }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    let age = 0
    try { age = Date.now() - statSync(LOCK_DIR).mtimeMs } catch { continue }
    if (age > LOCK_STALE_MS) { try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* another waiter got it */ } continue }
    if ((Date.now() - started) % 60000 < POLL_MS) console.error(`[smoke-lock] waiting for ${LOCK_DIR} (${Math.round((Date.now() - started) / 1000)} s)`)
    await sleep(POLL_MS)
  }
}

const release = () => { try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* already gone */ } }

await acquire()
// Direct spawn keeps arguments intact; only a .cmd/.bat launcher (npm.cmd) needs the shell.
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: /\.(?:cmd|bat)$/i.test(command[0]) })
const finish = code => { release(); process.exit(code ?? 1) }
child.on('exit', finish)
child.on('error', error => { console.error(`[smoke-lock] ${error.message}`); finish(1) })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(); finish(130) })
