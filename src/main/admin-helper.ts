import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * The Conductor side of the elevated admin helper (docs/admin-helper.md). Conductor never runs
 * elevated; the owner installs, with one UAC click, a scheduled task that runs as them with highest
 * privileges and executes only the allowlisted actions whose scripts live in an admin-only folder.
 * Conductor asks for an action by name: it writes a request file into the helper's queue, starts the
 * task, and reads the result the task writes back. The elevated runner checks every request again
 * against its own copy of the allowlist (scripts/admin-helper/actions.json); this file mirrors it so
 * a bad request is refused here with a useful message before anything is queued.
 */

export const ADMIN_TASK_NAME = 'Conductor Admin Helper'
export const ADMIN_INSTALL_COMMAND = 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Claude\\conductor\\scripts\\admin-helper\\install.ps1'

export interface AdminActionArg { type: 'boolean'; switch: string; summary: string }
export interface AdminAction { script: string; summary: string; args: Record<string, AdminActionArg> }

/** Must equal scripts/admin-helper/actions.json `actions` (admin-helper.test.ts checks it). */
export const ADMIN_ACTIONS: Record<string, AdminAction> = {
  'firewall-candidate-cleanup': {
    script: 'firewall-candidate-cleanup.ps1',
    summary: 'Remove the inbound Windows Firewall rules Windows created for Conductor acceptance candidates and smoke worktrees (electron.exe under a conductor-candidates or .conductor-scratch folder). Never touches the installed Conductor.exe, the main checkout\'s electron.exe or any other program\'s rules.',
    args: { dryRun: { type: 'boolean', switch: 'DryRun', summary: 'list what would be removed without removing it' } }
  }
}

export interface AdminRequest { id: string; action: string; args: Record<string, boolean>; by: string; requestedAt: string }
export interface AdminResult {
  id: string
  ok: boolean
  action?: string
  args?: Record<string, unknown> | null
  by?: string | null
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  output?: string
  error?: string
  log?: string
}

export class AdminRequestError extends Error {}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/

/** The normalized args of one request for `action`, or an AdminRequestError naming what is wrong. */
export function validateAdminRequest(action: unknown, args: unknown, actions: Record<string, AdminAction> = ADMIN_ACTIONS): { action: string; args: Record<string, boolean> } {
  if (typeof action !== 'string' || !Object.hasOwn(actions, action)) throw new AdminRequestError(`Unknown admin action ${JSON.stringify(action)}. The admin helper runs only: ${Object.keys(actions).join(', ')}`)
  const declared = actions[action] as AdminAction
  if (args === undefined || args === null) return { action, args: {} }
  if (typeof args !== 'object' || Array.isArray(args)) throw new AdminRequestError('args must be an object')
  const normalized: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (!Object.hasOwn(declared.args, key)) throw new AdminRequestError(`${action} takes no argument ${JSON.stringify(key)}${Object.keys(declared.args).length ? `; it takes ${Object.keys(declared.args).join(', ')}` : ''}`)
    if (declared.args[key]?.type === 'boolean' && typeof value !== 'boolean') throw new AdminRequestError(`${key} must be true or false`)
    normalized[key] = value as boolean
  }
  return { action, args: normalized }
}

/** A result file's content, or null when it is not one the runner wrote for `id`. */
export function parseAdminResult(text: string, id: string): AdminResult | null {
  let value: unknown
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { return null }
  if (!value || typeof value !== 'object' || (value as AdminResult).id !== id || typeof (value as AdminResult).ok !== 'boolean') return null
  return value as AdminResult
}

export interface AdminHelperOptions {
  /** C:\ProgramData\ConductorAdmin unless a test names another folder. */
  root?: string
  /** Starts the scheduled task; schtasks /Run by default. */
  startTask?: () => Promise<void>
  /** Whether the task is registered; schtasks /Query by default. */
  taskInstalled?: () => Promise<boolean>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  platform?: NodeJS.Platform
}

const run = promisify(execFile)

export class AdminHelper {
  readonly root: string
  private readonly startTask: () => Promise<void>
  private readonly taskInstalled: () => Promise<boolean>
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pollMs: number
  private readonly platform: NodeJS.Platform

  constructor(options: AdminHelperOptions = {}) {
    this.root = options.root ?? join(process.env.ProgramData ?? 'C:\\ProgramData', 'ConductorAdmin')
    this.startTask = options.startTask ?? (async () => { await run('schtasks.exe', ['/Run', '/TN', ADMIN_TASK_NAME], { windowsHide: true, timeout: 20_000 }) })
    this.taskInstalled = options.taskInstalled ?? (async () => run('schtasks.exe', ['/Query', '/TN', ADMIN_TASK_NAME], { windowsHide: true, timeout: 20_000 }).then(() => true, () => false))
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.pollMs = options.pollMs ?? 500
    this.platform = options.platform ?? process.platform
  }

  private get requests(): string { return join(this.root, 'queue', 'requests') }
  private get results(): string { return join(this.root, 'queue', 'results') }

  private async version(): Promise<Record<string, unknown> | null> {
    try { return JSON.parse((await readFile(join(this.root, 'VERSION.json'), 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown> } catch { return null }
  }

  /** Whether the helper is installed, what it can do, and its latest results (newest first). */
  async status(limit = 10): Promise<{ installed: boolean; task: string; root: string; version: Record<string, unknown> | null; actions: Record<string, { summary: string; args: Record<string, string> }>; recent: AdminResult[]; install?: string }> {
    const actions = Object.fromEntries(Object.entries(ADMIN_ACTIONS).map(([name, action]) => [name, { summary: action.summary, args: Object.fromEntries(Object.entries(action.args).map(([key, arg]) => [key, `${arg.type}: ${arg.summary}`])) }]))
    const version = await this.version()
    const installed = this.platform === 'win32' && version !== null && await this.taskInstalled()
    const recent: AdminResult[] = []
    const names = await readdir(this.results).catch(() => [] as string[])
    const entries = await Promise.all(names.filter(name => name.endsWith('.json') && ID_PATTERN.test(name.slice(0, -5))).map(async name => ({ name, mtime: await stat(join(this.results, name)).then(info => info.mtimeMs, () => 0) })))
    for (const { name } of entries.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(0, limit))) {
      const result = parseAdminResult(await readFile(join(this.results, name), 'utf8').catch(() => ''), name.slice(0, -5))
      if (result) recent.push(result)
    }
    return { installed, task: ADMIN_TASK_NAME, root: this.root, version, actions, recent, ...(installed ? {} : { install: `Not installed. The owner installs it once (one UAC prompt): ${ADMIN_INSTALL_COMMAND}` }) }
  }

  /** One result by request id, or null while it has not finished. */
  async result(id: string): Promise<AdminResult | null> {
    if (!ID_PATTERN.test(id)) throw new AdminRequestError('id must be a request id returned by admin.run')
    return parseAdminResult(await readFile(join(this.results, `${id}.json`), 'utf8').catch(() => ''), id)
  }

  /** Queues one allowlisted action, starts the task and waits up to waitMs for its result. */
  async run(request: { action: unknown; args?: unknown; by: string; waitMs?: number }): Promise<{ id: string; pending: true; request: AdminRequest } | { id: string; pending: false; result: AdminResult }> {
    const { action, args } = validateAdminRequest(request.action, request.args)
    if (this.platform !== 'win32') throw new Error('The admin helper exists on Windows only')
    if (!await this.version()) throw new Error(`The admin helper is not installed. The owner installs it once (one UAC prompt): ${ADMIN_INSTALL_COMMAND}`)
    const id = `${new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(6).toString('hex')}`
    const queued: AdminRequest = { id, action, args, by: request.by.slice(0, 200), requestedAt: new Date(this.now()).toISOString() }
    const path = join(this.requests, `${id}.json`)
    const temp = `${path}.tmp`
    // The runner only picks up *.json, so it never sees a half-written request.
    await writeFile(temp, JSON.stringify(queued, null, 2) + '\n', { flag: 'wx' })
    try { await rename(temp, path) } catch (error) { await rm(temp, { force: true }); throw error }
    try { await this.startTask() } catch (error) {
      await rm(path, { force: true })
      throw new Error(`Starting the scheduled task '${ADMIN_TASK_NAME}' failed (${error instanceof Error ? error.message : String(error)}); nothing ran. Reinstall it with: ${ADMIN_INSTALL_COMMAND}`)
    }
    const deadline = this.now() + Math.max(0, Math.min(request.waitMs ?? 40_000, 45_000))
    for (;;) {
      const result = await this.result(id)
      if (result) return { id, pending: false, result }
      if (this.now() >= deadline) return { id, pending: true, request: queued }
      await this.sleep(this.pollMs)
    }
  }
}
