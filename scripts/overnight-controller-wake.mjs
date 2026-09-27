// One bounded wake of an already idle wizard. No overnight admission decision happens here.
import { readFile, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { readCredential, installedUserData } from './overseer/credentials.mjs'
import { clientFromCredential } from './overseer/control-client.mjs'

const MINUTE = 60_000
const MAX_HORIZON = 24 * 60 * MINUTE
const READ_TIMEOUT = 10_000
const MUTATION_TIMEOUT = 20_000
const execFileAsync = promisify(execFile)
const required = ['at', 'deadline', 'agent', 'project', 'workspace', 'prompt-file', 'state-file']

export function parseArgs(argv, now = Date.now()) {
  const values = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.match(/^--([a-z-]+)$/)?.[1]
    if (!key || !required.includes(key) || values[key] !== undefined || argv[i + 1] === undefined) throw new Error('Expected each required --option once')
    values[key] = argv[i + 1]
  }
  if (required.some(key => !values[key])) throw new Error(`Required: ${required.map(key => `--${key}`).join(' ')}`)
  const iso = value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && !Number.isNaN(Date.parse(value))
  if (!iso(values.at) || !iso(values.deadline)) throw new Error('--at and --deadline must be explicit ISO instants with offsets')
  const at = Date.parse(values.at), deadline = Date.parse(values.deadline)
  if (at < now || at - now > MAX_HORIZON || deadline <= at || deadline - now > MAX_HORIZON) throw new Error('Wake must be future, within 24 hours, and before its bounded deadline')
  for (const key of ['agent', 'project', 'workspace']) if (!/^[a-zA-Z0-9_-]{1,160}$/.test(values[key])) throw new Error(`Invalid --${key}`)
  return { at, deadline, agent: values.agent, project: values.project, workspace: values.workspace, promptFile: values['prompt-file'], stateFile: values['state-file'] }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// The shared client times out fetch(), but a response's text() can hang after headers.
// Bound the entire operation, including body parsing and injected local reads.
async function bounded(operation, maximumMs, deadline, clock) {
  const remaining = deadline - clock()
  if (remaining <= 0) throw Object.assign(new Error('deadline reached'), { code: 'timeout' })
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('operation timed out'), { code: 'timeout' })), Math.min(maximumMs, remaining)) })
    ])
  } finally { clearTimeout(timer) }
}
export async function windowsIdleSeconds() {
  if (process.platform !== 'win32') return null
  const script = `$code = '[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } public static class IdleInput { [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info); [System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern ulong GetTickCount64(); }'; Add-Type -TypeDefinition $code; $i = New-Object LASTINPUTINFO; $i.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][LASTINPUTINFO]); if (-not [IdleInput]::GetLastInputInfo([ref]$i)) { exit 2 }; $ticks = [IdleInput]::GetTickCount64(); if ($ticks -lt [uint64]$i.dwTime) { exit 2 }; $elapsed = (($ticks - [uint64]$i.dwTime) % 4294967296); [math]::Floor($elapsed / 1000)`
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5_000, maxBuffer: 1024 })
    const seconds = Number(stdout.trim())
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null
  } catch { return null }
}
const safeError = error => error?.code === 'unreachable' || error?.code === 'timeout' ? 'app unreachable' : 'control refused or invalid'
const ready = (agent, status, config) => agent?.agentSessionId === config.agent && status?.agentSessionId === config.agent &&
  agent.projectId === config.project && status.projectId === config.project &&
  agent.workspaceId === config.workspace && status.workspaceId === config.workspace &&
  agent.tabId && status.tabId === agent.tabId && agent.wizard === true && status.wizard === true &&
  !agent.superseded && !status.recovery?.superseded &&
  ['idle', 'completed'].includes(agent.phase) && ['idle', 'completed'].includes(status.phase) &&
  agent.backgroundTasks === 0 && status.backgroundTasks === 0 &&
  Array.isArray(status.pending) && status.pending.length === 0 && status.waitingPrompts === 0 && status.activeTool === null

async function atomicState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(state) + '\n'); await handle.sync() } finally { await handle.close() }
  try { await rename(temporary, path) } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}

/** Dependencies are injectable; the CLI supplies only installed-app implementations. */
export async function wake(config, deps = {}) {
  const clock = deps.now ?? Date.now
  const wait = deps.sleep ?? sleep
  const credential = deps.readCredential ?? (() => readCredential(installedUserData()))
  const client = deps.clientFromCredential ?? clientFromCredential
  const readPrompt = deps.readPrompt ?? (path => readFile(path, 'utf8'))
  const idleSeconds = deps.idleSeconds ?? windowsIdleSeconds
  const statePath = config.stateFile
  const lockPath = `${statePath}.lock`
  // The exclusive lock persists after a crash. An operator may inspect and remove a stale lock;
  // the state remains authoritative and a sent-intent is never retried.
  const lock = await open(lockPath, 'wx', 0o600)
  try {
    let previous
    try { previous = JSON.parse(await readFile(statePath, 'utf8')) } catch (error) { if (error?.code !== 'ENOENT') throw new Error('Invalid existing state; refusing wake') }
    if (previous) throw new Error(`Existing wake state (${previous.phase ?? 'unknown'}); refusing duplicate`)
    const identity = { at: new Date(config.at).toISOString(), deadline: new Date(config.deadline).toISOString(), agent: config.agent, project: config.project, workspace: config.workspace }
    await atomicState(statePath, { ...identity, phase: 'waiting' })
    while (clock() < config.at) await bounded(() => wait(Math.min(MINUTE, config.at - clock())), MINUTE + 1_000, config.deadline, clock)
    while (clock() < config.deadline) {
      let idle
      try { idle = await bounded(idleSeconds, READ_TIMEOUT, config.deadline, clock) } catch { idle = null }
      if (clock() >= config.deadline) break
      if (idle === null || idle < 600) {
        await bounded(() => wait(Math.min(MINUTE, config.deadline - clock())), MINUTE + 1_000, config.deadline, clock).catch(() => {})
        continue
      }
      try {
        const owner = await bounded(credential, READ_TIMEOUT, config.deadline, clock)
        if (!owner.ok) throw Object.assign(new Error('app unreachable'), { code: 'unreachable' })
        const control = client(owner.credential, { timeoutMs: READ_TIMEOUT })
        const scope = { projectId: config.project, workspaceId: config.workspace }
        const left = () => Math.max(1, Math.min(READ_TIMEOUT, config.deadline - clock()))
        const agents = await bounded(() => control.call('agents.list', {}, scope, { timeoutMs: left() }), READ_TIMEOUT, config.deadline, clock)
        if (!Array.isArray(agents)) throw new Error('Invalid agents.list response')
        const agent = agents.find(item => item.agentSessionId === config.agent)
        if (!agent) throw new Error('Target not listed')
        if (clock() >= config.deadline) break
        const status = await bounded(() => control.call('agents.status', { agentSessionId: config.agent }, scope, { timeoutMs: left() }), READ_TIMEOUT, config.deadline, clock)
        if (!ready(agent, status, config)) throw new Error('Target is not a live, idle, settled wizard')
        if (clock() < config.at || clock() >= config.deadline) break
        // Recheck just before the irreversible intent; the owner may have resumed typing.
        let finalIdle
        try { finalIdle = await bounded(idleSeconds, READ_TIMEOUT, config.deadline, clock) } catch { finalIdle = null }
        if (clock() >= config.deadline) break
        if (finalIdle === null || finalIdle < 600) {
          await bounded(() => wait(Math.min(MINUTE, config.deadline - clock())), MINUTE + 1_000, config.deadline, clock).catch(() => {})
          continue
        }
        const prompt = await bounded(() => readPrompt(config.promptFile), READ_TIMEOUT, config.deadline, clock)
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt file is empty')
        if (clock() >= config.deadline) break
        // Durable intent precedes the POST. A timeout, rejection or crash is ambiguous: never retry.
        await atomicState(statePath, { ...identity, phase: 'sent-intent', intentAt: new Date(clock()).toISOString() })
        if (clock() >= config.deadline) return 'ambiguous'
        try {
          const result = await bounded(() => control.call('agents.steer', { agentSessionId: config.agent, prompt }, scope,
            { timeoutMs: Math.max(1, Math.min(MUTATION_TIMEOUT, config.deadline - clock())) }), MUTATION_TIMEOUT, config.deadline, clock)
          await atomicState(statePath, { ...identity, phase: 'sent', intentAt: new Date(clock()).toISOString(), delivery: result?.delivery ?? null })
          return 'sent'
        } catch { return 'ambiguous' }
      } catch (error) {
        if (!['unreachable', 'timeout'].includes(error?.code)) {
          await atomicState(statePath, { ...identity, phase: 'refused', reason: safeError(error) })
          return 'refused'
        }
        if (clock() >= config.deadline) break
        await bounded(() => wait(Math.min(MINUTE, config.deadline - clock())), MINUTE + 1_000, config.deadline, clock).catch(() => {})
      }
    }
    await atomicState(statePath, { ...identity, phase: 'expired' })
    return 'expired'
  } finally {
    await lock.close()
    await unlink(lockPath).catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let watchdog
  try {
    const config = parseArgs(process.argv.slice(2))
    // A stalled socket/body can keep Node alive even after our promise race settles.
    // This process owns no other work; exit explicitly when settled or at the deadline.
    watchdog = setTimeout(() => { console.error('controller wake: expired'); process.exit(1) }, Math.max(1, config.deadline - Date.now()))
    const result = await wake(config)
    console.log(`controller wake: ${result}`)
    clearTimeout(watchdog)
    process.exit(result === 'sent' ? 0 : 1)
  } catch (error) {
    clearTimeout(watchdog)
    console.error(`controller wake: ${error.message}`)
    process.exit(1)
  }
}
