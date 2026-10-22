import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The meta-wizard's repair ladder (docs/startup-diagnostics.md, part 2) for real, on a parked app
// and a test profile. Every start dies in boot stage structured-store (CONDUCTOR_TEST_BOOT_FAIL_FILE
// holds "structured-store:exit"), so the meta-wizard
//   restarts it twice (each alert carries the boot verdict "died in stage structured-store"),
//   rolls back to the restore point in local-updates (a fake installer command records it ran and
//     leaves the fail file: the rolled-back build fails the same way, a data problem),
//   starts the repair runner: a worktree of a scratch repository (--checkout), and a fake agent that
//     records its prompt and argv, deletes the fail file, starts the app, commits a fix on its branch
//     and prints a report;
//   sees Conductor answer, reports "Repaired" and tells the wizard tabs (none in this profile).
// Nothing touches the owner's installed app, profile, checkout or scheduled task; the real claude CLI
// never runs.
//   node scripts/smoke-lock.mjs -- node scripts/smoke-meta-wizard-repair.mjs [--keep]   (after npm run build)

const HARD_TIMEOUT_MS = 7 * 60_000
const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'conductor-meta-repair-'))
const output = resolve('artifacts/meta-wizard')
await mkdir(output, { recursive: true })
const profile = join(root, 'profile'), stateDir = join(profile, 'meta-wizard'), checkout = join(root, 'checkout'), fixtures = join(root, 'fixtures')
const failFile = join(root, 'boot-fail.txt'), rollbackLog = join(root, 'rollback.log'), agentLog = join(root, 'agent.json'), appLog = join(root, 'app.log')
for (const path of [profile, checkout, fixtures, join(profile, 'local-updates'), join(profile, 'recovery')]) await mkdir(path, { recursive: true })
const observations = []
const observe = (label, data = {}) => {
  const entry = { at: new Date().toISOString(), label, ...data }
  observations.push(entry)
  process.stderr.write(`[${entry.at}] ${label}${Object.keys(data).length ? ' ' + JSON.stringify(data) : ''}\n`)
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const lines = async path => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const journal = () => lines(join(stateDir, 'journal.jsonl'))
const toasts = () => lines(join(stateDir, 'toasts.jsonl'))
const poll = async (what, check, timeoutMs, intervalMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(done => setTimeout(done, intervalMs))
  }
}

// The scratch repository the repair worktree is made from.
const git = (...args) => execFileSync('git', ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Smoke', ...args], { cwd: checkout, stdio: 'pipe' }).toString().trim()
await writeFile(join(checkout, 'README.md'), '# Repair smoke checkout\n')
git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'Initial')
const base = git('rev-parse', 'HEAD')

// The app, parked on the test profile, dying in stage structured-store while the fail file exists.
const electron = createRequire(import.meta.url)('electron')
const appEnv = {
  CONDUCTOR_TEST_USER_DATA: profile, CONDUCTOR_PROJECTS_ROOT: join(root, 'projects'), CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_RUNTIME_HOST: '0',
  CONDUCTOR_TEST_PARENT_PID: String(process.pid), CONDUCTOR_RECOVERY_WATCHDOG: '0', CONDUCTOR_TEST_BOOT_FAIL_FILE: failFile
}
const launch = { exe: electron, args: [resolve('out/main/index.js')], cwd: resolve('.') }
await writeFile(failFile, 'structured-store:exit')

// A restore point that ran here, with its installer in the feed.
const point = { version: '0.0.1-local.1', commit: null, createdAt: '2026-10-21T08:00:00.000Z', dirty: false, cliVersions: { claude: null, codex: null, grok: null }, models: [], installer: 'Conductor-Setup-0.0.1-local.1.exe', blockmap: 'Conductor-Setup-0.0.1-local.1.exe.blockmap', pinned: false, knownGood: true, crashCount: 0, failedShipCount: 0, firstLaunchedAt: '2026-10-21T08:05:00.000Z' }
await writeFile(join(profile, 'local-updates', 'restore-points.json'), JSON.stringify({ schemaVersion: 1, points: [point] }, null, 2))
await writeFile(join(profile, 'local-updates', point.installer), 'not a real installer')

// The fake rollback: records that it ran and leaves the fail file (the old build fails the same way).
await writeFile(join(fixtures, 'fake-rollback.mjs'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(rollbackLog)}, JSON.stringify({ at: new Date().toISOString(), argv: process.argv.slice(2) }) + '\\n')\n`)
// The fake repair agent. Its environment is the stripped one, so the app's test environment is written in.
await writeFile(join(fixtures, 'fake-agent.mjs'), `
import { closeSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
writeFileSync(${JSON.stringify(agentLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, testUserData: process.env.CONDUCTOR_TEST_USER_DATA ?? null, bootFail: process.env.CONDUCTOR_TEST_BOOT_FAIL_FILE ?? null }, null, 2))
rmSync(${JSON.stringify(failFile)}, { force: true })
const log = openSync(${JSON.stringify(appLog)}, 'a')
const app = spawn(${JSON.stringify(launch.exe)}, ${JSON.stringify(launch.args)}, { cwd: ${JSON.stringify(launch.cwd)}, env: { ...process.env, ...${JSON.stringify(appEnv)} }, detached: true, stdio: ['ignore', log, log], windowsHide: true })
app.unref(); closeSync(log)
writeFileSync('FIX.md', 'Projections load lazily.\\n')
const git = (...args) => execFileSync('git', ['-c', 'user.email=agent@example.invalid', '-c', 'user.name=Repair agent', ...args], { stdio: 'pipe' })
git('add', 'FIX.md'); git('commit', '-q', '-m', 'Load projections lazily')
process.stdout.write('**Cause** structured-store dies at boot.\\n\\n**Fix** repair branch, one commit.\\n\\n**Verified** smoke.\\n\\n**Is Conductor up** yes, pid ' + app.pid + '\\n\\n**Next steps for the owner/wizard** review and ship.\\n')
`)

// A crash the meta-wizard should notice: armed "running" for a pid that is gone.
const gone = spawnSync(process.execPath, ['-e', '0']).pid
await writeFile(join(profile, 'recovery', 'armed.json'), JSON.stringify({ appPid: gone, kind: 'running', at: new Date(Date.now() - 3_600_000).toISOString(), fromVersion: '', foreground: false, launch, checkout: null, packaged: false }, null, 2))

const summary = { root, profile, checkout, build: resolve('out/main/index.js') }
let failed = null, metaWizard
const hard = setTimeout(() => { observe('hard timeout: giving up'); failed = new Error('hard timeout'); void finish() }, HARD_TIMEOUT_MS)
try {
  assert.ok(existsSync(resolve('out/main/index.js')), 'npm run build first')
  const timings = { tickMs: 3000, recheckMs: 2000, crashGraceMs: 2000, restartGraceMs: 2000, startWaitMs: 90_000, exitSettleMs: 3000, maxRestarts: 10, incidentCloseMs: 15_000, repairAnswerGraceMs: 90_000, probeTimeoutMs: 5000, resumeDelayMs: 5000 }
  const metaLog = openSync(join(root, 'meta-wizard.log'), 'a')
  const metaEnv = { ...process.env, CONDUCTOR_REPAIR_AGENT_COMMAND: JSON.stringify([process.execPath, join(fixtures, 'fake-agent.mjs')]), CONDUCTOR_META_ROLLBACK_COMMAND: JSON.stringify([process.execPath, join(fixtures, 'fake-rollback.mjs')]) }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CONDUCTOR_LIVE_TESTS', 'CONDUCTOR_BACKGROUND_WINDOWS', 'CONDUCTOR_RECOVERY_REAL_AGENT']) delete metaEnv[key]
  metaWizard = spawn(process.execPath, [resolve('scripts/meta-wizard.mjs'), 'run', '--user-data', profile, '--checkout', checkout, '--timings', JSON.stringify(timings), '--launch', JSON.stringify(launch), '--launch-env', JSON.stringify(appEnv)], { env: metaEnv, stdio: ['ignore', metaLog, metaLog], windowsHide: true })
  closeSync(metaLog)
  observe('meta-wizard started', { pid: metaWizard.pid })

  // 1. Restarts, each alert carrying the boot verdict.
  const dead = await poll('two failed starts', async () => { const list = (await toasts()).filter(toast => toast.title === 'Conductor did not start'); return list.length >= 2 ? list : null }, 150_000)
  for (const toast of dead) assert.match(toast.body, /died in stage structured-store/, `the alert names the stage: ${toast.body}`)
  assert.match(dead[0].body, /Restarting \(2 of 2\)/)
  assert.match(dead[1].body, /Rolling back to 0\.0\.1-local\.1 next/)
  observe('restarts alerted with the verdict', { first: dead[0].body.slice(0, 200) })
  // 2. The rollback: the installer command ran, and the rolled-back build died the same way.
  await poll('the rollback', async () => (await lines(rollbackLog)).length >= 1, 60_000)
  assert.deepEqual((await lines(rollbackLog))[0].argv, [join(profile, 'local-updates', point.installer)])
  const afterRollback = await poll('the failure after the rollback', async () => (await toasts()).find(toast => toast.title === 'Conductor did not start' && /Starting a repair agent next/.test(toast.body)), 90_000)
  assert.match(afterRollback.body, /fails the same way \(died:structured-store:[a-z]+\): data or environment/)
  assert.ok((await toasts()).some(toast => toast.title === 'Conductor: rolling back'))
  observe('rolled back; the rolled-back build fails the same way')
  // 3. The repair: the runner, the worktree, the agent.
  const started = await poll('the repair start', async () => (await journal()).find(entry => entry.event === 'repair-start'), 60_000)
  assert.equal(started.branch, `repair/${started.id}`)
  assert.equal(started.worktree, resolve(checkout, '..', 'conductor-repairs', started.id))
  assert.ok((await toasts()).some(toast => toast.title === 'Conductor: repair agent started'))
  const agent = await poll('the fake agent', async () => JSON.parse(await readFile(agentLog, 'utf8')), 60_000)
  assert.equal(resolve(agent.cwd), resolve(started.worktree), 'the agent runs in its worktree')
  for (const flag of ['-p', 'opus', 'high', 'acceptEdits', 'Bash(git push:*)']) assert.ok(agent.argv.includes(flag), `agent argv lacks ${flag}`)
  assert.equal(agent.testUserData, null, 'the agent environment has no test knobs')
  assert.match(agent.prompt, /died in stage structured-store/)
  assert.ok(agent.prompt.includes(started.worktree) && agent.prompt.includes(checkout))
  observe('repair agent ran in its worktree', { id: started.id, worktree: started.worktree })
  // 4. Repaired: Conductor answers, the owner is told, the wizard tabs are told once.
  const outcome = await poll('the repair outcome', async () => (await journal()).find(entry => entry.event === 'repair-outcome'), 120_000)
  assert.equal(outcome.outcome, 'repaired', JSON.stringify(outcome))
  const repaired = (await toasts()).find(toast => toast.title === 'Conductor repaired')
  assert.match(repaired.body, /^Repaired: Conductor answers again \(pid \d+\)/)
  const announced = await poll('the wizard summary', async () => (await journal()).find(entry => entry.event === 'repair-announced'), 60_000)
  assert.match(announced.prompt, /git\.ship/)
  assert.match(announced.prompt, /Load projections lazily/)
  const phone = (await journal()).find(entry => entry.event === 'alert' && entry.title === 'Conductor repaired')
  assert.ok(phone && phone.phone !== 'app not answering', `the repaired alert went to the app's phone path too: ${JSON.stringify(phone)}`)
  const result = JSON.parse(await readFile(join(stateDir, 'repair', started.id, 'result.json'), 'utf8'))
  assert.equal(result.branch, started.branch)
  assert.equal(result.base, base)
  assert.deepEqual(result.commits.map(commit => commit.subject), ['Load projections lazily'])
  assert.equal(result.exitCode, 0)
  assert.ok(Number.isInteger(result.conductorAnswered))
  assert.match(await readFile(join(stateDir, 'repair', started.id, 'report.md'), 'utf8'), /\*\*Cause\*\*/)
  assert.ok(!existsSync(join(stateDir, 'repair', 'active.json')), 'active.json is gone after the runner')
  assert.equal(git('rev-parse', 'main'), base, 'main is untouched')
  observe('repaired and announced', { pid: result.conductorAnswered, wizardsSteered: announced.steered })
  // 5. The incident closes once Conductor has answered for incidentCloseMs.
  await poll('the incident to close', async () => (await journal()).find(entry => entry.event === 'incident-closed'), 60_000)
  const statusOut = JSON.parse(execFileSync(process.execPath, [resolve('scripts/meta-wizard.mjs'), 'status', '--json', '--user-data', profile], { encoding: 'utf8' }))
  assert.equal(statusOut.repair.outcome, 'repaired')
  summary.toasts = await toasts()
  summary.result = result
  observe('PASS')
} catch (error) {
  failed = error
  observe('FAILED', { message: String(error?.message ?? error).slice(0, 1500) })
}
await finish()

async function finish() {
  clearTimeout(hard)
  if (metaWizard?.pid && alive(metaWizard.pid)) { try { execFileSync('taskkill.exe', ['/pid', String(metaWizard.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
  try { const last = JSON.parse(readFileSync(join(profile, 'control-owner.json'), 'utf8')); if (alive(last.pid)) execFileSync('taskkill.exe', ['/pid', String(last.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
  summary.journal = (await journal()).map(entry => ({ at: entry.at, event: entry.event, title: entry.title, reason: entry.reason, action: entry.action, line: entry.line, error: entry.error, id: entry.id, outcome: entry.outcome }))
  summary.toasts ??= await toasts()
  try { summary.metaWizardLog = readFileSync(join(root, 'meta-wizard.log'), 'utf8').split('\n').slice(-30) } catch { /* none */ }
  const result = { result: failed ? 'FAIL' : 'PASS', ...summary, root: keep || failed ? root : '(removed)', observations }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await writeFile(join(output, `meta-wizard-repair-${stamp}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ result: result.result, evidence: join(output, `meta-wizard-repair-${stamp}.json`) }))
  if (!keep && !failed) {
    await new Promise(done => setTimeout(done, 2000))
    try { git('worktree', 'prune') } catch { /* scratch */ }
    await rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {})
  }
  process.exit(failed ? 1 : 0)
}
