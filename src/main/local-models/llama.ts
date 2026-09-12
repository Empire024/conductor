import { execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalModelConfig } from './config.ts'
import { logsDir, modelFilePath, runDir } from './config.ts'
import { childEnvironment } from './paths.ts'

/** llama.cpp is an inference engine here and nothing else. These flags would hand it tools, a
 *  network surface or an agent runtime of its own, so they are refused wherever extra arguments
 *  can be configured: Conductor stays the only orchestrator, and the server stays loopback-only
 *  behind its API key. */
const FORBIDDEN_ARGS = [
  /^--host$/, /^--port$/, /^--api-key(-file)?$/, /^--path$/, /^--rpc/, /^--mcp/, /^--agent/, /^--tools?$/,
  /^--jinja-tools/, /^--webui/, /^--cors/, /^--allow-origin/, /^--chat-template-file$/, /^--lora/, /^--public/
]

export function validateExtraArgs(args: string[]): string[] {
  for (const arg of args) {
    if (typeof arg !== 'string' || /[\0\r\n]/.test(arg)) throw new Error('Invalid llama.cpp argument')
    if (FORBIDDEN_ARGS.some(pattern => pattern.test(arg))) throw new Error(`Refusing llama.cpp argument ${arg}: binding, web UI, tool and agent features stay disabled`)
  }
  return args
}

/** The exact server argv. Bound to 127.0.0.1 only, web UI off, API key required, one slot, and
 *  --jinja so the model's own chat template drives OpenAI-style tool calls. No tool runtime, no
 *  MCP, no agent mode, no RPC backend. */
export function llamaServerArgs(model: LocalModelConfig, apiKey: string, modelPath = modelFilePath(model)): string[] {
  if (!/^[a-f0-9]{32,}$/i.test(apiKey)) throw new Error('Local model API key is malformed')
  return [
    '--host', '127.0.0.1',
    '--port', String(model.port),
    '--api-key', apiKey,
    '--no-webui',
    '--model', modelPath,
    '--alias', model.id,
    '--ctx-size', String(model.contextTokens),
    '--n-gpu-layers', String(model.gpuLayers),
    '--parallel', '1',
    '--jinja',
    ...validateExtraArgs(model.extraArgs ?? [])
  ]
}

export const runFile = (model: LocalModelConfig): string => join(runDir(), model.id.replace(/[^a-z0-9.-]/gi, '_') + '.json')
export const logFile = (model: LocalModelConfig): string => join(logsDir(), model.id.replace(/[^a-z0-9.-]/gi, '_') + '.log')

export interface RunRecord { pid: number; port: number; model: string; file: string; startedAt: string }

export function readRunRecord(model: LocalModelConfig): RunRecord | null {
  const path = runFile(model)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RunRecord
    return Number.isInteger(record.pid) && record.pid > 0 ? record : null
  } catch { return null }
}

export const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function portInUse(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (value: boolean): void => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export interface HealthResult { ok: boolean; status: number; detail?: string }

export async function health(port: number, apiKey: string, timeoutMs = 4000): Promise<HealthResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal })
    return { ok: response.ok, status: response.status, detail: response.ok ? undefined : `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : 'unreachable' }
  } finally { clearTimeout(timer) }
}

/** Proof that the key is enforced: the same endpoint without an Authorization header must be
 *  refused. Used by `status` and by the security tests. */
export async function rejectsAnonymous(port: number, timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: controller.signal })
    return response.status === 401 || response.status === 403
  } catch { return false }
  finally { clearTimeout(timer) }
}

export async function llamaServerVersion(executable: string): Promise<string> {
  return await new Promise<string>(resolve => {
    let output = ''
    const child = spawn(executable, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', () => { clearTimeout(timer); resolve('') })
    child.on('close', () => { clearTimeout(timer); resolve(output.trim().split(/\r?\n/).filter(Boolean).join(' | ').slice(0, 300)) })
  })
}

/** Where a working llama-server may be found, in order of preference. A winget install adds
 *  its package directory to the user PATH, which an already-running shell has not picked up
 *  yet, so the known install locations are checked directly rather than asking for a reinstall
 *  or copying a binary into the project. */
export function llamaServerCandidates(configured?: string): string[] {
  const candidates: string[] = []
  const add = (value: string | undefined | null): void => { if (value?.trim() && !candidates.includes(value.trim())) candidates.push(value.trim()) }
  add(configured)
  add(process.env.CONDUCTOR_LLAMA_SERVER)
  if (process.platform === 'win32') {
    try {
      const found = execFileSync('where.exe', ['llama-server'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of found.split(/\r?\n/)) add(line)
    } catch { /* Not on this process's PATH; the install locations below still apply. */ }
    const local = process.env.LOCALAPPDATA
    if (local) {
      add(join(local, 'Microsoft', 'WinGet', 'Links', 'llama-server.exe'))
      const packages = join(local, 'Microsoft', 'WinGet', 'Packages')
      try {
        for (const entry of readdirSync(packages, { withFileTypes: true })) {
          if (!entry.isDirectory() || !/llamacpp/i.test(entry.name)) continue
          const base = join(packages, entry.name)
          add(join(base, 'llama-server.exe'))
          try {
            for (const nested of readdirSync(base, { withFileTypes: true })) if (nested.isDirectory()) add(join(base, nested.name, 'llama-server.exe'))
          } catch { /* unreadable package directory */ }
        }
      } catch { /* winget packages directory is absent */ }
    }
  }
  add('llama-server')
  return candidates
}

/** The first candidate that actually answers `--version`, with the version it reported. */
export async function resolveLlamaServer(configured?: string): Promise<{ path: string; version: string } | null> {
  for (const candidate of llamaServerCandidates(configured)) {
    if (candidate !== 'llama-server' && candidate.includes('\\') && !existsSync(candidate)) continue
    const version = await llamaServerVersion(candidate)
    if (version) return { path: candidate, version }
  }
  return null
}

export interface StartOutcome { started: boolean; pid: number; port: number; message: string }

/** Start one model server, refusing rather than duplicating: an existing healthy process for
 *  this model is reported as already running, and a port held by anything else is an error. */
export async function startServer(executable: string, model: LocalModelConfig, apiKey: string): Promise<StartOutcome> {
  const existing = readRunRecord(model)
  if (existing && processAlive(existing.pid) && await portInUse(model.port)) {
    return { started: false, pid: existing.pid, port: model.port, message: `already running (pid ${existing.pid})` }
  }
  if (await portInUse(model.port)) throw new Error(`Port occupied: ${model.port} is already in use by another process`)
  const path = modelFilePath(model)
  if (!existsSync(path)) throw new Error(`Model file missing: ${path}`)
  const log = openSync(logFile(model), 'a')
  // TEMP, caches and any model-cache variable point at the local root, so the server can never
  // stage large files on the system drive.
  const child = spawn(executable, llamaServerArgs(model, apiKey, path), { shell: false, windowsHide: true, detached: true, stdio: ['ignore', log, log], env: childEnvironment() })
  child.unref()
  if (!child.pid) throw new Error('llama.cpp server failed to start')
  writeFileSync(runFile(model), JSON.stringify({ pid: child.pid, port: model.port, model: model.id, file: model.file, startedAt: new Date().toISOString() } satisfies RunRecord, null, 2), 'utf8')
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    if (!processAlive(child.pid)) throw new Error(`Server health check failed: llama.cpp exited during startup; see ${logFile(model)}`)
    if ((await health(model.port, apiKey)).ok) return { started: true, pid: child.pid, port: model.port, message: 'healthy' }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`Server health check failed: ${model.id} did not answer on 127.0.0.1:${model.port} within 5 minutes`)
}

/** Stop only the processes this stack started, by recorded pid. */
export async function stopServer(model: LocalModelConfig): Promise<string> {
  const record = readRunRecord(model)
  if (!record) return 'not running'
  if (processAlive(record.pid)) {
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => {
        const killer = spawn('taskkill.exe', ['/pid', String(record.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => resolve())
        killer.on('close', () => resolve())
      })
    } else { try { process.kill(record.pid, 'SIGTERM') } catch { /* already gone */ } }
  }
  rmSync(runFile(model), { force: true })
  return `stopped (pid ${record.pid})`
}

export interface ServerStatus { model: string; port: number; pid: number | null; running: boolean; healthy: boolean; keyEnforced: boolean; detail?: string }

export async function serverStatus(model: LocalModelConfig, apiKey: string): Promise<ServerStatus> {
  const record = readRunRecord(model)
  const running = Boolean(record && processAlive(record.pid))
  const probe = running ? await health(model.port, apiKey) : { ok: false, status: 0, detail: 'not running' }
  return { model: model.id, port: model.port, pid: record?.pid ?? null, running, healthy: probe.ok, keyEnforced: probe.ok ? await rejectsAnonymous(model.port) : false, detail: probe.detail }
}
