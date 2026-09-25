// V1 verify S13b, fixed: prepare-deps must refuse an owner act it cannot verify. The CLI now
// requires a real interactive terminal (process.stdin.isTTY) before it will touch the network or
// Docker; an agent's shell tool (run_and_summarize, run_command, or a coworker's own Bash tool)
// always spawns without one, no matter what the command text says, so this is a gate the command
// text itself cannot defeat (unlike an env var or flag, which the agent could just add).
// This runs the CLI directly, with piped stdio (never a TTY) — the same shape any agent shell
// tool spawns a command with — and needs neither Docker nor the Conductor app.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-v1-prepare-deps-tty-gate.mjs
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dockerVolumes = () => { try { return execFileSync('docker', ['volume', 'ls'], { encoding: 'utf8' }) } catch { return null } }

const root = await mkdtemp(join(tmpdir(), 'conductor-v1-s13b-tty-'))
const zeroDepsDir = join(root, 'zero-deps')
await mkdir(zeroDepsDir, { recursive: true })
await writeFile(join(zeroDepsDir, 'package.json'), JSON.stringify({ name: 'zero-deps', version: '1.0.0', dependencies: {} }, null, 2))
await writeFile(join(zeroDepsDir, 'package-lock.json'), JSON.stringify({ name: 'zero-deps', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'zero-deps', version: '1.0.0' } } }, null, 2))

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }

try {
  const before = dockerVolumes()
  let stderr = '', code = 0
  try {
    execFileSync(process.execPath, ['--experimental-transform-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', resolve('scripts/local-models/cli.ts'), 'prepare-deps', '--cwd', zeroDepsDir], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 })
  } catch (error) {
    code = error.status ?? -1
    stderr = error.stderr ?? String(error)
  }
  const refused = code !== 0 && /real interactive terminal/.test(stderr)
  record('S13b-tty-gate', refused ? 'PASS' : 'FAIL', `exit ${code}; stderr: ${stderr.trim().slice(0, 400)}`)

  const after = dockerVolumes()
  if (before !== null && after !== null) {
    const newVolumes = after.split('\n').filter(line => !before.includes(line) && line.includes('conductor-linux-deps-'))
    record('S13b-no-volume', newVolumes.length === 0 ? 'PASS' : 'FAIL', `new volumes: ${JSON.stringify(newVolumes)}`)
  } else {
    record('S13b-no-volume', 'INFO', 'docker not available on this machine; the CLI never reached it anyway (the gate runs before loadConfig/linuxDepsStatus)')
  }
} catch (error) {
  record('S13b-tty-gate', 'FAIL', String(error?.stack ?? error))
} finally {
  await rm(root, { recursive: true, force: true })
  console.log('\n=== S13b (TTY gate) SUMMARY ===')
  for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
  if (results.some(r => r.verdict === 'FAIL')) process.exitCode = 1
}
