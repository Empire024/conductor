// Latest models, step 1: what the installed Claude Code and Codex CLIs advertise to this account.
// Discovery only, no inference: Codex is asked over its app-server protocol (initialize,
// model/list), Claude Code through its stream-json control protocol (initialize) from an empty
// temporary directory, the way scripts/probe-capability-sweep.mjs does. No user message is ever
// sent, so no model turn can start.
//
// stdout is the evidence and is digested: only stable catalog fields, models sorted by id, no
// paths, pids, timings, account or rate-limit data. Diagnostics go to stderr.
// Exit 0 when at least one CLI answered, 1 when neither did.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WINDOWS = process.platform === 'win32'
const PHASE_MS = 60_000
const VERSION_MS = 15_000
const CLOSE_GRACE_MS = 5_000
const log = message => process.stderr.write(`[cli-catalogs] ${message}\n`)
const live = new Set()

const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value
const text = value => typeof value === 'string' ? value : null
const plainVersion = value => /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(value ?? '')?.[0] ?? null

function which(command) {
  try {
    const found = execFileSync(WINDOWS ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
    return found.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null
  } catch { return null }
}

// npm shims (.cmd/.bat) cannot be spawned without a shell on Windows; native executables are
// spawned directly with an argument array.
const quote = arg => /[\s"]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : arg
function launch(file, argv, cwd) {
  const options = { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  const child = WINDOWS && /\.(cmd|bat)$/i.test(file)
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...argv].map(quote).join(' ')}"`], { ...options, windowsVerbatimArguments: true })
    : spawn(file, argv, { ...options, detached: !WINDOWS })
  live.add(child)
  child.once('close', () => live.delete(child))
  child.on('error', error => log(`${file}: ${error.message}`))
  return child
}

/** Kills the child and everything it started while it is still alive (a dead parent's
 *  orphans cannot be found by tree, so this runs before the parent is gone). */
function killTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (WINDOWS) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }) } catch { /* already gone */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* already gone */ } }
  }
}
process.on('exit', () => { for (const child of live) killTree(child) })

const exited = child => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve()
  else child.once('close', () => resolve())
})
/** The probe's close pattern: end stdin so the CLI exits on its own, then kill the tree if it
 *  has not after a grace period. */
async function close(child) {
  try { child.stdin.end() } catch { /* already closed */ }
  const timer = setTimeout(() => killTree(child), CLOSE_GRACE_MS)
  await Promise.race([exited(child), new Promise(resolve => setTimeout(resolve, CLOSE_GRACE_MS + 10_000))])
  clearTimeout(timer)
  killTree(child)
}

async function capture(file, argv, cwd, timeoutMs = VERSION_MS) {
  const child = launch(file, argv, cwd)
  let stdout = ''
  child.stdout.on('data', chunk => { if (stdout.length < 512 * 1024) stdout += String(chunk) })
  child.stderr.resume()
  child.stdin.end()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)
  await new Promise(resolve => { child.once('close', resolve); child.once('error', resolve) })
  clearTimeout(timer)
  killTree(child)
  return { stdout, timedOut }
}

/** Newline-framed JSON over a child's stdio. */
function jsonChild(file, argv, cwd, onMessage) {
  const child = launch(file, argv, cwd)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000) })
  let pending = ''
  child.stdout.on('data', chunk => {
    pending += String(chunk)
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1)
      if (!line.trim()) continue
      try { onMessage(JSON.parse(line)) } catch { /* not a protocol frame */ }
    }
  })
  child.stdin.on('error', () => {})
  return { child, send: message => { try { child.stdin.write(JSON.stringify(message) + '\n') } catch { /* closed */ } }, stderr: () => stderr }
}

/** Waits for `promise` or `ms`, whichever comes first; the phase error names what timed out. */
const within = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms).unref())])

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------
/** The launch flags Conductor's Claude adapter passes (src/main/providers/claude.ts), so a CLI
 *  that drops one fails here the same way it would fail a Conductor tab. */
const CLAUDE_LAUNCH = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host', '--forward-subagent-text', '--permission-mode', 'default']

async function claude() {
  const file = process.env.CONDUCTOR_CLAUDE_PATH?.trim() || which('claude')
  if (!file) return { error: 'Claude Code executable not found (CONDUCTOR_CLAUDE_PATH unset and not on PATH)' }
  const cwd = await mkdtemp(join(tmpdir(), 'conductor-schedule-claude-'))
  try {
    const versionRun = await capture(file, ['--version'], cwd)
    const version = plainVersion(versionRun.stdout)
    if (!version) return { error: versionRun.timedOut ? 'claude --version timed out' : 'claude --version printed no version' }
    const help = (await capture(file, ['--help'], cwd)).stdout
    const missingFlags = help ? CLAUDE_LAUNCH.filter(arg => arg.startsWith('--') && !help.includes(arg)).sort() : []
    // Keep the check from leaving anything behind: no transcript, and none of the owner's MCP
    // servers started (they would be child processes of the CLI).
    const hygiene = [
      ...(help.includes('--no-session-persistence') ? ['--no-session-persistence'] : []),
      ...(help.includes('--strict-mcp-config') ? ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] : [])
    ]
    let settle
    const answered = new Promise(resolve => { settle = resolve })
    const session = jsonChild(file, [...CLAUDE_LAUNCH, ...hygiene], cwd, message => {
      if (message?.type === 'control_response' && message.response?.request_id === 'catalog-initialize') settle(message.response)
    })
    session.child.once('close', code => settle({ subtype: 'error', error: `exited before answering initialize (code ${code})` }))
    session.child.once('error', error => settle({ subtype: 'error', error: `could not start: ${error.code ?? error.message}` }))
    session.send({ type: 'control_request', request_id: 'catalog-initialize', request: { subtype: 'initialize', hooks: {}, forwardSubagentText: true, promptSuggestions: false, agentProgressSummaries: false } })
    let response
    try { response = await within(answered, PHASE_MS, 'initialize') } catch (error) { response = { subtype: 'error', error: error.message } }
    await close(session.child)
    if (response.subtype === 'error') {
      log(`claude stderr: ${session.stderr()}`)
      const flag = /unknown option '?([-\w]+)'?/i.exec(session.stderr())?.[1]
      return { version, missingFlags, error: flag ? `rejected launch flag ${flag}` : String(response.error ?? 'initialize failed').slice(0, 200) }
    }
    const models = Array.isArray(response.response?.models) ? response.response.models : []
    return {
      version, missingFlags,
      models: models.map(model => ({
        value: text(model.value) ?? text(model.id),
        resolvedModel: text(model.resolvedModel),
        displayName: text(model.displayName) ?? text(model.name),
        description: text(model.description),
        supportsEffort: typeof model.supportsEffort === 'boolean' ? model.supportsEffort : null,
        efforts: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter(level => typeof level === 'string') : [],
        isDefault: typeof model.isDefault === 'boolean' ? model.isDefault : (model.value ?? model.id) === 'default'
      })).filter(model => model.value).sort((a, b) => a.value.localeCompare(b.value))
    }
  } finally { await rm(cwd, { recursive: true, force: true }).catch(() => {}) }
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------
async function codex() {
  const file = process.env.CONDUCTOR_CODEX_PATH?.trim() || which('codex')
  if (!file) return { error: 'Codex executable not found (CONDUCTOR_CODEX_PATH unset and not on PATH)' }
  const cwd = await mkdtemp(join(tmpdir(), 'conductor-schedule-codex-'))
  try {
    const versionRun = await capture(file, ['--version'], cwd)
    const version = plainVersion(versionRun.stdout)
    if (!version) return { error: versionRun.timedOut ? 'codex --version timed out' : 'codex --version printed no version' }
    const waiting = new Map()
    let nextId = 0
    const server = jsonChild(file, ['app-server', '--listen', 'stdio://'], cwd, message => {
      if (message?.id !== undefined && !message.method) waiting.get(message.id)?.(message)
    })
    let exitedEarly = null
    const stop = reason => { exitedEarly ??= reason; for (const done of [...waiting.values()]) done({ error: { message: exitedEarly } }) }
    server.child.once('close', code => stop(`app-server exited (code ${code})`))
    server.child.once('error', error => stop(`app-server could not start: ${error.code ?? error.message}`))
    const request = (method, params) => new Promise((resolve, reject) => {
      if (exitedEarly) return reject(new Error(exitedEarly))
      const id = ++nextId
      waiting.set(id, message => { waiting.delete(id); message.error ? reject(new Error(`${method}: ${message.error.message ?? JSON.stringify(message.error)}`)) : resolve(message.result) })
      server.send({ id, method, params })
    })
    const list = async includeHidden => {
      const data = []
      let cursor = null
      for (let page = 0; page < 10; page++) {
        const result = await request('model/list', { limit: 100, includeHidden, ...(cursor ? { cursor } : {}) })
        data.push(...(Array.isArray(result?.data) ? result.data : []))
        cursor = result?.nextCursor ?? null
        if (!cursor) break
      }
      return data
    }
    try {
      const { visible, all } = await within((async () => {
        await request('initialize', { clientInfo: { name: 'conductor-schedule', title: 'Conductor scheduled catalog check', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } })
        server.send({ method: 'initialized' })
        const visible = await list(false)
        let all = visible
        try { all = await list(true) } catch (error) { log(`model/list includeHidden: ${error.message}`) }
        return { visible, all }
      })(), PHASE_MS, 'app-server model/list')
      const visibleIds = new Set(visible.map(model => text(model.model) ?? text(model.id)))
      const byId = new Map()
      for (const model of [...visible, ...all]) {
        const id = text(model.model) ?? text(model.id)
        if (!id) continue
        const upgrade = typeof model.upgrade === 'string' ? model.upgrade : text(model.upgrade?.model) ?? text(model.upgrade?.id)
        byId.set(id, {
          id,
          displayName: text(model.displayName),
          description: text(model.description),
          hidden: Boolean(model.hidden) || !visibleIds.has(id),
          isDefault: model.isDefault === true,
          efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(entry => typeof entry === 'string' ? entry : text(entry?.reasoningEffort)).filter(Boolean),
          defaultEffort: text(model.defaultReasoningEffort),
          upgrade: upgrade ?? null,
          retirementAt: text(model.upgradeInfo?.retirementAt)
        })
      }
      return { version, models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) }
    } catch (error) {
      log(`codex stderr: ${server.stderr()}`)
      return { version, error: String(error.message).slice(0, 200) }
    } finally { await close(server.child) }
  } finally { await rm(cwd, { recursive: true, force: true }).catch(() => {}) }
}

const failed = error => ({ error: `check crashed: ${String(error?.message ?? error).slice(0, 200)}` })
const [claudeSide, codexSide] = await Promise.all([claude().catch(failed), codex().catch(failed)])
for (const [name, side] of [['claude', claudeSide], ['codex', codexSide]]) if (side.error) log(`${name}: ${side.error}`)
const answered = Boolean(claudeSide.models || codexSide.models)
process.stdout.write(JSON.stringify(sortKeys({ claude: claudeSide, codex: codexSide }), null, 2) + '\n', () => process.exit(answered ? 0 : 1))
