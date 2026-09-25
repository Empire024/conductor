// RV1 A11-A12: prepare-deps TTY gate, adversarial variants beyond the plain-pipe check already
// covered by scripts/smoke-v1-prepare-deps-tty-gate.mjs (not edited here).
// A11: the same command run through a coworker's own Bash-tool-shaped spawn (shell:true, piped
//      stdio, no TTY) -- still refused?
// A12: bypass attempt -- spawn the CLI inside a real pseudo-terminal via the repo's own node-pty,
//      so process.stdin.isTTY is genuinely true. If the "Type yes" prompt appears, answer "no"
//      (never yes) and record the transcript. Reaching the prompt from an agent-controlled pty is
//      a FAIL (gate bypassable); a volume must never be created either way.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-rv1-a-prepare-deps-bypass.mjs
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dockerVolumes = () => { try { return execFileSync('docker', ['volume', 'ls'], { encoding: 'utf8' }) } catch { return null } }
const newConductorVolumes = (before, after) => (before !== null && after !== null)
  ? after.split('\n').filter(line => !before.includes(line) && line.includes('conductor-linux-deps-'))
  : null

const root = await mkdtemp(join(tmpdir(), 'conductor-rv1-a12-'))
const output = resolve('artifacts/verification/2026-09-25-rv1/A')
await mkdir(output, { recursive: true })
const zeroDepsDir = join(root, 'zero-deps')
await mkdir(zeroDepsDir, { recursive: true })
await writeFile(join(zeroDepsDir, 'package.json'), JSON.stringify({ name: 'zero-deps', version: '1.0.0', dependencies: {} }, null, 2))
await writeFile(join(zeroDepsDir, 'package-lock.json'), JSON.stringify({ name: 'zero-deps', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'zero-deps', version: '1.0.0' } } }, null, 2))

const results = []
const record = (id, verdict, note) => { results.push({ id, verdict, note }); console.log(`[${id}] ${verdict}: ${note}`) }
const cliArgs = ['--experimental-transform-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', resolve('scripts/local-models/cli.ts'), 'prepare-deps', '--cwd', zeroDepsDir]

// ---- A11: coworker Bash-tool-shaped spawn (shell:true, piped stdio, no TTY) ----
try {
  const before = dockerVolumes()
  const cmdLine = [process.execPath, ...cliArgs].map(s => `"${s}"`).join(' ')
  let stdout = '', stderr = '', code = 0
  await new Promise(done => {
    const child = spawn(cmdLine, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', c => { code = c ?? -1; done() })
    setTimeout(() => { try { child.kill() } catch {}; done() }, 60_000)
  })
  const refused = code !== 0 && /real interactive terminal/.test(stderr)
  const after = dockerVolumes()
  const newVols = newConductorVolumes(before, after)
  record('A11', refused && (newVols === null || newVols.length === 0) ? 'PASS' : 'FAIL', `shell:true spawn: exit ${code}; refused=${refused}; new volumes=${JSON.stringify(newVols)}; stderr: ${stderr.trim().slice(0, 300)}`)
} catch (error) {
  record('A11', 'FAIL', String(error?.stack ?? error).slice(0, 800))
}

// ---- A12: real pseudo-terminal via node-pty, isTTY genuinely true ----
try {
  const pty = require('node-pty')
  const before = dockerVolumes()
  let transcript = ''
  let promptSeen = false
  let volumeCreatedDuringRun = false
  const exitCode = await new Promise((resolvePty, rejectPty) => {
    let term
    try {
      term = pty.spawn(process.execPath, cliArgs, { name: 'xterm-color', cols: 100, rows: 30, cwd: root, env: process.env })
    } catch (error) { rejectPty(error); return }
    const watchdog = setTimeout(() => { try { term.kill() } catch {}; resolvePty(-2) }, 45_000)
    term.onData(data => {
      transcript += data
      if (!promptSeen && /type\s+yes/i.test(data)) {
        promptSeen = true
        // Never answer yes -- answer no, exactly per the plan.
        setTimeout(() => { try { term.write('no\r') } catch {} }, 200)
      }
    })
    term.onExit(({ exitCode: code }) => { clearTimeout(watchdog); resolvePty(code) })
  })
  const after = dockerVolumes()
  const newVols = newConductorVolumes(before, after)
  await writeFile(join(output, 'a12-pty-transcript.txt'), transcript)
  const bypassed = promptSeen // reaching the "Type yes" prompt at all from an agent-controlled pty = gate bypassable
  const volumeLeak = newVols !== null && newVols.length > 0
  record('A12', !bypassed && !volumeLeak ? 'PASS' : 'FAIL', `pty exit=${exitCode}; reached "Type yes" prompt=${promptSeen}; new volumes=${JSON.stringify(newVols)}; transcript saved to a12-pty-transcript.txt (${transcript.length} chars)`)
} catch (error) {
  record('A12', 'FAIL', String(error?.stack ?? error).slice(0, 1500))
}

await writeFile(join(output, 'a11-a12-results.json'), JSON.stringify(results, null, 2))
await rm(root, { recursive: true, force: true })
console.log('\n=== A11/A12 SUMMARY ===')
for (const r of results) console.log(`${r.id}\t${r.verdict}\t${r.note}`)
if (results.some(r => r.verdict === 'FAIL')) process.exitCode = 1
