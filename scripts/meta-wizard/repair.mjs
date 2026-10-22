import { execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonFile, writeJsonAtomic } from './journal.mjs'

// The repair rung's effects (docs/startup-diagnostics.md, part 2): rolling back to a restore point,
// starting the detached repair runner (repair-run.mjs) and reading what it left. The prompt and the
// claude argv are pure functions, so the tests see exactly what the agent is told and allowed.

export const REPAIR_MAX_TURNS = 300
export const REPAIR_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'PowerShell']
const DENIED_COMMANDS = [
  'git push', 'gh', 'npm run dev', 'git reset', 'git clean', 'git checkout main', 'git switch main', 'git branch -D', 'git branch -d', 'git tag',
  'git worktree remove', 'git stash drop', 'rm', 'rmdir', 'del', 'rd', 'Remove-Item', 'format'
]

export const repairRoot = stateDirectory => join(stateDirectory, 'repair')
export const ACTIVE_FILE = 'active.json'
export const feedDirectory = userData => join(userData, 'local-updates')

/** A path in the POSIX form Claude Code matches permission rules against: C:\Users\x -> //c/Users/x. */
export function rulePath(path) {
  const forward = String(path).replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):\/(.*)$/.exec(forward)
  return drive ? `//${drive[1].toLowerCase()}/${drive[2]}` : `/${forward.replace(/^\/+/, '')}`
}

/** What the repair agent may not do, where Claude Code can enforce it. */
export function repairDeniedTools({ userData = null } = {}) {
  const denied = ['NotebookEdit', 'WebFetch', 'WebSearch']
  for (const tool of ['Bash', 'PowerShell']) for (const command of DENIED_COMMANDS) denied.push(`${tool}(${command}:*)`)
  if (userData) for (const tool of ['Edit', 'Write']) denied.push(`${tool}(${rulePath(userData)}/**)`)
  return denied
}

/** The headless high-effort call; the prompt goes on stdin (with the logs it outgrows a command line). */
export function repairAgentArgs({ userData = null, maxTurns = REPAIR_MAX_TURNS } = {}) {
  return [
    '-p', '--model', 'opus', '--effort', 'high', '--output-format', 'text', '--max-turns', String(maxTurns),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...REPAIR_ALLOWED_TOOLS,
    '--disallowedTools', ...repairDeniedTools({ userData })
  ]
}

/** `claude` on PATH, else ~/.local/bin (as the recovery watchdog finds it). */
export function resolveClaude(env = process.env) {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const exe = found.find(path => /\.exe$/i.test(path)) ?? found[0]
    if (exe) return exe
  } catch { /* not on PATH */ }
  const local = join(env.USERPROFILE ?? env.HOME ?? '', '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return existsSync(local) ? local : null
}

const jsonArgv = raw => {
  try {
    const argv = JSON.parse(raw)
    return Array.isArray(argv) && argv.length && argv.every(part => typeof part === 'string' && part) ? argv : null
  } catch { return null }
}

/**
 * The full agent argv, or `{command:null, reason}`. A test profile runs only
 * CONDUCTOR_REPAIR_AGENT_COMMAND (a JSON argv; the claude arguments are appended) and never the
 * owner's real CLI; the installed profile runs claude.
 */
export function repairAgentCommand({ env = process.env, testProfile, userData, resolve: resolveCli = resolveClaude }) {
  if (testProfile) {
    const override = env.CONDUCTOR_REPAIR_AGENT_COMMAND ? jsonArgv(env.CONDUCTOR_REPAIR_AGENT_COMMAND) : null
    if (!override) return { command: null, reason: env.CONDUCTOR_REPAIR_AGENT_COMMAND ? 'CONDUCTOR_REPAIR_AGENT_COMMAND is not a JSON argv array' : 'no repair agent command in this test profile (CONDUCTOR_REPAIR_AGENT_COMMAND)' }
    return { command: [...override, ...repairAgentArgs({ userData })], reason: '' }
  }
  const claude = resolveCli(env)
  return claude ? { command: [claude, ...repairAgentArgs({ userData })], reason: '' } : { command: null, reason: 'claude was not found on PATH or in ~/.local/bin' }
}

/** The installer argv for a rollback: CONDUCTOR_META_ROLLBACK_COMMAND + installer in a test profile (none without it), else `<installer> /S`. */
export function rollbackCommand({ env = process.env, testProfile, installer }) {
  // A test profile never runs a real installer over the owner's installed app.
  if (testProfile) {
    const prefix = env.CONDUCTOR_META_ROLLBACK_COMMAND ? jsonArgv(env.CONDUCTOR_META_ROLLBACK_COMMAND) : null
    return prefix ? [...prefix, installer] : null
  }
  return [installer, '/S']
}

/** The agent's environment: no Electron-as-node, no inherited Node options, no test knobs or control tokens. */
export function repairEnv(env = process.env) {
  const clean = {}
  for (const [key, value] of Object.entries(env)) {
    if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].includes(key)) continue
    if (/^CONDUCTOR_TEST_/.test(key) || /^CONDUCTOR_.*(TOKEN|CONTROL|CREDENTIAL)/.test(key)) continue
    clean[key] = value
  }
  return clean
}

const clip = (text, max) => { const value = String(text ?? ''); return value.length > max ? `…${value.slice(-max)}` : value }
const fence = (text, max = 4000) => '```\n' + clip(text, max).replace(/```/g, "'''") + '\n```'
const at = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms ?? '')

/**
 * The repair agent's prompt. Pure: everything is passed in. `diagnostics` holds the raw text of
 * boot.json, boot-last-failure.json and boot-sample.json (null when absent), `launchLogs` the tails
 * of the newest launch logs, `recovery` the newest recovery report.
 */
export function repairPrompt({ incident, reason, diagnostics = {}, launchLogs = [], recovery = null, paths, now, timeoutMinutes = 90, maxTurns = REPAIR_MAX_TURNS, ownerScaleCheck = true }) {
  const failures = (incident?.failures ?? []).map(failure => `- ${at(failure.at)} [${failure.rung}] ${failure.line}${failure.version ? ` (version ${failure.version})` : ''}${failure.signature ? ` signature ${failure.signature}` : ''}`)
  const rungs = (incident?.rungs ?? []).map(rung => `- ${at(rung.at)} ${rung.rung}${rung.detail ? `: ${rung.detail}` : ''}`)
  const file = (name, text) => `### ${name}\n${text ? fence(text, 3000) : '(none)'}`
  const logs = launchLogs.length ? launchLogs.map(log => `### ${log.path}\n${fence(log.tail, 3000)}`).join('\n\n') : '(none captured)'
  const p = paths
  return [
    `You are Conductor's repair agent. Conductor (a local Electron desktop app, the owner's workbench) does not start, and the meta-wizard (its supervisor outside the app) has already restarted it and, where it could, rolled it back. You run headless and unattended, at most ${timeoutMinutes} minutes and ${maxTurns} turns. Fix it in your own git worktree, prove the fix, install it and bring Conductor back.`,
    '',
    '## Why you were started',
    reason,
    '',
    '## The incident',
    `opened ${at(incident?.openedAt)}; now ${at(now)}`,
    '### Failed starts (boot verdicts, oldest first)',
    failures.join('\n') || '- none recorded',
    '### Ladder so far',
    rungs.join('\n') || '- none',
    '',
    '## Boot diagnostics (<userData>/diagnostics/)',
    file('boot.json', diagnostics.boot),
    file('boot-last-failure.json', diagnostics.lastFailure),
    file('boot-sample.json', diagnostics.sample),
    '',
    '## Launch log tails (the meta-wizard\'s starts)',
    logs,
    '',
    '## Newest recovery report (the recovery watchdog\'s read-only diagnosis)',
    recovery ? `${recovery.path}\n${fence(recovery.excerpt, 3000)}` : '(none)',
    '',
    '## Paths',
    `- userData (the owner's real profile; conductor.db is the owner's journal, multi-GB): ${p.userData}`,
    `- checkout (the shared main tree; read it, never edit it): ${p.checkout}`,
    `- your worktree (edit only here; it is your cwd): ${p.worktree}`,
    `- your branch: ${p.branch} (based on ${p.base ?? 'HEAD'})`,
    `- installed exe: ${p.exe}`,
    `- local update feed (installers): ${p.feed}`,
    `- your report is saved to: ${p.report}`,
    '',
    '## Steps',
    '1. Diagnose from the evidence above and the code: which boot stage dies and why.',
    '2. Fix the code ONLY in your worktree. Keep the change small and aimed at the cause.',
    '3. Run the related Vitest tests (`npx vitest run <files>`) and `npm run typecheck` in the worktree.',
    ownerScaleCheck
      ? '4. `npm run build`, then the owner-scale startup check: `node scripts/smoke-lock.mjs -- node scripts/smoke-owner-scale-startup.mjs` (it boots the build on an owner-sized synthetic profile; the owner\'s data is what broke it).'
      : '4. `npm run build` (this checkout has no owner-scale startup check yet; say so in the report).',
    '5. Build a local update from the worktree: `node scripts/build-local-update.mjs`.',
    `6. Make sure no Conductor.exe is running, install the new installer silently (\`<installer> /S\`, the newest one in ${p.feed}), then start \`${p.exe}\` detached so it outlives you.`,
    `7. Confirm with \`node ${join(p.checkout, 'scripts', 'meta-wizard.mjs')} status --json\` that Conductor answers on the owner's real profile, and that the cut work is resumed: the meta-wizard resumes it about 90 s after Conductor answers; its journal shows \`restart-seen\` and the \`steer\`s.`,
    `8. Commit on ${p.branch} (git add + git commit in the worktree).`,
    '',
    '## Rules',
    '- Never push, publish, tag, or touch main (no checkout, reset, merge or rebase of main); never delete branches or worktrees.',
    '- Never delete or edit anything in userData (conductor.db and every other file there); installing through the local feed is the only change you make to the installed app.',
    '- Never `npm run dev` (it opens a window over the owner\'s screen); never install software.',
    '- If you cannot fix it, leave Conductor in the best state you can (the previous build installed and running is better than nothing) and say exactly what is wrong.',
    '',
    '## Your final reply',
    'A markdown report and nothing else, with these headings: **Cause**, **Fix** (branch, commits), **Verified** (tests, startup check), **Is Conductor up** (yes/no, pid), **Next steps for the owner/wizard**.'
  ].join('\n')
}

/** Text of a small file, bounded; null when absent. */
async function readBounded(path, max = 16_000) {
  try { const text = await readFile(path, 'utf8'); return text.length > max ? text.slice(0, max) + '\n…(clipped)' : text } catch { return null }
}

/** The evidence for the prompt: diagnostics, launch log tails, the newest recovery report. Never throws. */
export async function gatherEvidence({ userData, stateDirectory, logs = 3 }) {
  const diagnosticsDir = join(userData, 'diagnostics')
  const diagnostics = {
    boot: await readBounded(join(diagnosticsDir, 'boot.json')),
    lastFailure: await readBounded(join(diagnosticsDir, 'boot-last-failure.json')),
    sample: await readBounded(join(diagnosticsDir, 'boot-sample.json'))
  }
  const launchLogs = []
  try {
    const names = (await readdir(stateDirectory)).filter(name => /^launch-.*\.log$/.test(name)).sort().slice(-logs)
    for (const name of names) launchLogs.push({ path: join(stateDirectory, name), tail: (await readFile(join(stateDirectory, name), 'utf8').catch(() => '')).slice(-3000) })
  } catch { /* no logs */ }
  let recovery = null
  try {
    const recoveryDir = join(userData, 'recovery')
    const newest = (await readdir(recoveryDir)).filter(name => /^recovery-.*\.md$/.test(name)).sort().at(-1)
    if (newest) recovery = { path: join(recoveryDir, newest), excerpt: (await readFile(join(recoveryDir, newest), 'utf8')).slice(0, 3000) }
  } catch { /* none */ }
  return { diagnostics, launchLogs, recovery }
}

/** The restore-point catalog and whether an installer is still in the feed. */
export async function readCatalog(userData) {
  const feed = feedDirectory(userData)
  const catalog = await readJsonFile(join(feed, 'restore-points.json'), null)
  const installerExists = name => typeof name === 'string' && basename(name) === name && !/[\\/:]/.test(name) && existsSync(join(feed, name))
  return { catalog, installerExists, feed }
}

/** Runs an installer (or the test command) and waits for it; `{ok, exitCode, detail}`, never throws. */
export function runInstaller(argv, { timeoutMs, spawnImpl = spawn, env = process.env } = {}) {
  return new Promise(done => {
    let child, timer
    const finish = value => { clearTimeout(timer); done(value) }
    try {
      child = spawnImpl(argv[0], argv.slice(1), { stdio: 'ignore', windowsHide: true, env: repairEnv(env) })
    } catch (error) { finish({ ok: false, exitCode: null, detail: `could not run the installer: ${error.message}` }); return }
    timer = setTimeout(() => {
      try { if (process.platform === 'win32' && child.pid) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else child.kill('SIGKILL') } catch { /* gone */ }
      finish({ ok: false, exitCode: null, detail: `the installer did not finish within ${Math.round(timeoutMs / 1000)} s` })
    }, timeoutMs)
    child.on('error', error => finish({ ok: false, exitCode: null, detail: `the installer failed to start: ${error.message}` }))
    child.on('exit', code => finish({ ok: code === 0, exitCode: code, detail: code === 0 ? 'installed' : `the installer exited with code ${code}` }))
  })
}

export const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'repair-run.mjs')

/**
 * Prepares `<state>/repair/<id>/` (prompt.md, request.json) and starts repair-run.mjs detached, so a
 * 90-minute repair never blocks a tick and outlives a restart of the meta-wizard. Writes active.json
 * at once (the runner rewrites it), so the next tick already sees the repair.
 */
export async function startRepairRunner({ stateDirectory, id, request, prompt, spawnImpl = spawn, node = process.execPath, now = Date.now() }) {
  const root = repairRoot(stateDirectory)
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const promptPath = join(dir, 'prompt.md')
  await writeFile(promptPath, prompt, 'utf8')
  const requestPath = join(dir, 'request.json')
  await writeJsonAtomic(requestPath, { ...request, id, dir, promptPath, activePath: join(root, ACTIVE_FILE) })
  const log = openSync(join(dir, 'runner.log'), 'a')
  let child
  try {
    child = spawnImpl(node, [RUNNER, requestPath], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
    child.on?.('error', () => {})
    child.unref?.()
  } finally { closeSync(log) }
  if (child?.pid) await writeJsonAtomic(join(root, ACTIVE_FILE), { pid: child.pid, id, startedAt: new Date(now).toISOString() })
  return { pid: child?.pid ?? null, dir, promptPath, requestPath }
}

export async function readActive(stateDirectory) { return readJsonFile(join(repairRoot(stateDirectory), ACTIVE_FILE), null) }
export async function readResult(dir) { return readJsonFile(join(dir, 'result.json'), null) }

/** Existing repair ids, so a new one in the same minute gets a suffix. */
export async function takenIds(stateDirectory, checkout) {
  const taken = new Set()
  try { for (const name of await readdir(repairRoot(stateDirectory))) taken.add(name) } catch { /* none yet */ }
  if (checkout) try { for (const name of await readdir(resolve(checkout, '..', 'conductor-repairs'))) taken.add(name) } catch { /* none yet */ }
  return [...taken]
}

/** The checkout's current commit, or null. */
export function headOf(checkout) {
  return new Promise(done => execFile('git', ['rev-parse', 'HEAD'], { cwd: checkout, windowsHide: true, timeout: 15_000 }, (error, stdout) => done(error ? null : String(stdout).trim())))
}

/** Whether the owner-scale startup check exists in this checkout (part 3). */
export const hasOwnerScaleCheck = checkout => existsSync(join(checkout, 'scripts', 'smoke-owner-scale-startup.mjs'))

/** The report's first lines, for alerts. */
export function reportExcerpt(path, max = 400) {
  try { return readFileSync(path, 'utf8').replace(/\s+/g, ' ').trim().slice(0, max) } catch { return '' }
}
