/** Entry of the detached recovery watchdog (docs/recovery-mode.md). Bundled on its own into
 *  out/main/recovery-watchdog.js with only node: imports, and run from the runtime copy under
 *  userData, so nothing it uses lives in the files the NSIS installer replaces. */
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { recoveryAgentArgs, recoveryAgentCommand, recoveryPrompt, RECOVERY_AGENT_TIMEOUT_MS } from './agent'
import { HISTORY_FILE, PENDING_REPORT_FILE, TEST_TOAST_FILE, WATCHDOG_LOCK_FILE, WATCHDOG_LOG_FILE, ARM_FILE, parseArmRecord, recoveryDirectory, type AgentRun, type RecoveryReport, type WatchdogLock } from './protocol'
import { recoveryMarkdown, toastScript, watchdogTimings } from './watchdog-support'
import { DEFAULT_WATCHDOG_CONFIG, runWatchdog, type LaunchedProcess, type WatchdogDeps } from './watchdog'

const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const userData = argument('--user-data')
const appPid = Number(argument('--app-pid'))
if (!userData || !Number.isInteger(appPid) || appPid <= 0) { process.stderr.write('recovery watchdog: --user-data and --app-pid are required\n'); process.exit(2) }
const directory = recoveryDirectory(userData)
mkdirSync(directory, { recursive: true })
const logPath = join(directory, WATCHDOG_LOG_FILE), lockPath = join(directory, WATCHDOG_LOCK_FILE)
const testProfile = Boolean(process.env.CONDUCTOR_TEST_USER_DATA)

const log = (message: string): void => {
  try {
    try { if (statSync(logPath).size > 1024 * 1024) renameSync(logPath, logPath + '.1') } catch { /* no log yet */ }
    appendFileSync(logPath, `${new Date().toISOString()} [${process.pid} watching ${appPid}] ${message}\n`)
  } catch { /* logging never ends the watchdog */ }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } }
const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8') } catch { return null } }
const writeAtomic = (path: string, text: string): void => { writeFileSync(`${path}.${process.pid}.tmp`, text, 'utf8'); renameSync(`${path}.${process.pid}.tmp`, path) }
const tailFile = (path: string, maxBytes = 6000): string => {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size, length = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally { closeSync(fd) }
  } catch { return '' }
}

const existing = ((): WatchdogLock | null => { try { return JSON.parse(readFileSync(lockPath, 'utf8')) as WatchdogLock } catch { return null } })()
if (existing && existing.pid !== process.pid && existing.appPid === appPid && alive(existing.pid)) { log(`watchdog ${existing.pid} already watches this app; exiting`); process.exit(0) }
writeAtomic(lockPath, `${JSON.stringify({ pid: process.pid, appPid, startedAt: new Date().toISOString() } satisfies WatchdogLock)}\n`)
const release = (): void => { try { if ((JSON.parse(readFileSync(lockPath, 'utf8')) as WatchdogLock).pid === process.pid) rmSync(lockPath, { force: true }) } catch { /* someone else's lock now */ } }
process.on('uncaughtException', error => log(`uncaught: ${error.stack ?? error.message}`))
process.on('unhandledRejection', error => log(`unhandled: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))

/** The app's environment, minus what made this process plain Node. */
const appEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.CONDUCTOR_RECOVERY_APP_PID
  return environment
}
const parentPid = Number(process.env.CONDUCTOR_RECOVERY_PARENT_PID)
const config = { ...DEFAULT_WATCHDOG_CONFIG, ...watchdogTimings(process.env, testProfile), appPid }

const deps: WatchdogDeps = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  alive,
  readArm: () => parseArmRecord(readText(join(directory, ARM_FILE))),
  async ready(previousPid) {
    let owner: { pid?: unknown; endpoint?: unknown; token?: unknown }
    try { owner = JSON.parse(readFileSync(join(userData, 'control-owner.json'), 'utf8')) as typeof owner } catch { return null }
    const pid = Number(owner.pid)
    if (!Number.isInteger(pid) || pid === previousPid || !alive(pid) || typeof owner.endpoint !== 'string' || typeof owner.token !== 'string') return null
    try {
      const response = await fetch(owner.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tools.list', args: {} }), signal: AbortSignal.timeout(3000) })
      return response.ok ? { pid } : null
    } catch { return null }
  },
  installerRunning() {
    if (process.platform !== 'win32') return false
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*conductor-desktop-updater*' -or $_.Path -like '*\\Temp\\*\\Un_*.exe' }).Count"], { windowsHide: true, timeout: 8000 }).toString().trim()
      return Number(out) > 0
    } catch { return false }
  },
  launch(exe, args, cwd) {
    return new Promise<LaunchedProcess>(resolve => {
      const outputPath = join(directory, `launch-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
      let fd: number | null = null
      try { fd = openSync(outputPath, 'a') } catch { /* no output capture */ }
      let exitCode: number | null = null, settled = false
      const done = (value: LaunchedProcess): void => { if (!settled) { settled = true; resolve(value) } }
      const observed = (pid?: number): LaunchedProcess => ({ pid, exitCode: () => exitCode, output: () => tailFile(outputPath, 3000), outputPath, release: () => child.unref() })
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(exe, args, { cwd: cwd && existsSync(cwd) ? cwd : undefined, detached: true, stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'], env: appEnvironment() })
      } catch (error) {
        done({ error: error instanceof Error ? error.message : String(error), exitCode: () => null, output: () => '', release: () => {} })
        return
      } finally { if (fd !== null) closeSync(fd) }
      child.once('spawn', () => done(observed(child.pid)))
      child.once('error', error => done({ error: error.message, exitCode: () => null, output: () => '', release: () => {} }))
      child.once('exit', code => { exitCode = code ?? -1 })
    })
  },
  async runAgent(request) {
    const arm = request.arm
    const cwd = arm?.checkout && existsSync(arm.checkout) ? arm.checkout : userData
    const command = recoveryAgentCommand({ env: process.env, testProfile, resolveClaude })
    const run: AgentRun = { command: command ?? [], cwd, exitCode: null, timedOut: false, diagnosisPath: request.diagnosisPath }
    if (!command) { run.error = testProfile ? 'no recovery agent command in this test profile' : 'claude was not found on PATH'; writeFileSync(request.diagnosisPath, `# Recovery agent did not run\n\n${run.error}.\n`, 'utf8'); return run }
    const prompt = recoveryPrompt(request, { userData, now: new Date().toISOString() })
    writeFileSync(`${request.diagnosisPath}.prompt.txt`, prompt, 'utf8')
    const environment = appEnvironment()
    delete environment.NODE_OPTIONS
    environment.CONDUCTOR_RECOVERY_LAUNCH = JSON.stringify(arm?.launch ?? null)
    environment.CONDUCTOR_RECOVERY_DIAGNOSIS = request.diagnosisPath
    return await new Promise<AgentRun>(resolve => {
      let stdout = '', stderr = ''
      const child = spawn(command[0]!, [...command.slice(1), ...recoveryAgentArgs()], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const timer = setTimeout(() => {
        run.timedOut = true
        if (process.platform === 'win32' && child.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* already gone */ } } else child.kill('SIGKILL')
      }, Number(process.env.CONDUCTOR_RECOVERY_AGENT_TIMEOUT_MS) > 0 && testProfile ? Number(process.env.CONDUCTOR_RECOVERY_AGENT_TIMEOUT_MS) : RECOVERY_AGENT_TIMEOUT_MS)
      child.stdout.on('data', chunk => { if (stdout.length < 200_000) stdout += chunk })
      child.stderr.on('data', chunk => { if (stderr.length < 20_000) stderr += chunk })
      child.stdin.on('error', () => { /* the agent may not read stdin */ })
      child.stdin.end(prompt)
      const finish = (code: number | null, error?: string): void => {
        clearTimeout(timer)
        run.exitCode = code
        if (error) run.error = error
        const body = stdout.trim() || `The agent wrote nothing to stdout.${stderr.trim() ? `\n\nstderr:\n\n\`\`\`\n${stderr.trim().slice(-4000)}\n\`\`\`` : ''}`
        writeFileSync(request.diagnosisPath, `# Recovery agent diagnosis\n\n${body}\n`, 'utf8')
        resolve(run)
      }
      child.once('error', error => finish(null, error.message))
      child.once('close', code => finish(code))
    })
  },
  async notify(title, body) {
    log(`notify: ${title}: ${body}`)
    // A test profile never puts a toast over the owner's desktop.
    if (testProfile) { appendFileSync(join(directory, TEST_TOAST_FILE), `${JSON.stringify({ at: new Date().toISOString(), title, body })}\n`); return }
    if (process.platform !== 'win32') return
    await new Promise<void>(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', toastScript()], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CONDUCTOR_TOAST_TITLE: title, CONDUCTOR_TOAST_BODY: body } })
      const timer = setTimeout(() => { child.kill(); resolve() }, 15_000)
      child.once('error', () => { clearTimeout(timer); resolve() })
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  },
  async logTails() {
    const tails: Record<string, string> = {}
    for (const path of [join(userData, 'runtime-host', 'host.log'), logPath]) {
      const text = tailFile(path, 5000)
      if (text) tails[path] = text.split('\n').slice(-50).join('\n')
    }
    return tails
  },
  recentRecoveries(windowMs) {
    const since = Date.now() - windowMs
    return (readText(join(directory, HISTORY_FILE)) ?? '').split('\n').filter(line => { try { return Date.parse((JSON.parse(line) as { at: string }).at) >= since } catch { return false } }).length
  },
  recordRecovery() { appendFileSync(join(directory, HISTORY_FILE), `${JSON.stringify({ at: new Date().toISOString(), appPid })}\n`) },
  reportPaths() {
    const id = `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`
    return { id, json: join(directory, `${id}.json`), markdown: join(directory, `${id}.md`) }
  },
  writeReport(report: RecoveryReport) {
    const json = report.reportPath.replace(/\.md$/, '.json')
    writeAtomic(json, `${JSON.stringify(report, null, 2)}\n`)
    const summary = recoveryMarkdown(report)
    if (existsSync(report.reportPath)) appendFileSync(report.reportPath, `\n\n${summary}`)
    else writeFileSync(report.reportPath, summary, 'utf8')
  },
  announce(report: RecoveryReport) { writeAtomic(join(directory, PENDING_REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`) },
  log,
  parentGone: () => Number.isInteger(parentPid) && parentPid > 0 && !alive(parentPid)
}

function resolveClaude(): string | null {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { windowsHide: true, timeout: 5000 }).toString().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const exe = found.find(path => /\.exe$/i.test(path)) ?? found[0]
    if (exe) return exe
  } catch { /* not on PATH */ }
  const local = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  return existsSync(local) ? local : null
}

void runWatchdog(deps, config).then(result => {
  log(`done: ${result.result}`)
  release()
  process.exit(0)
}, error => {
  log(`failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  release()
  process.exit(1)
})
