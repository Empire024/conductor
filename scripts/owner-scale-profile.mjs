/** A synthetic Conductor profile the size of the owner's, for the owner-scale startup check
 *  (docs/startup-diagnostics.md, part 3; scripts/smoke-owner-scale-startup.mjs).
 *
 *  On 2026-10-22 every launch died four seconds in because StructuredAgentStore parsed all 1,666
 *  stored conversations (1.27 GB of projection JSON) at construction (docs/conversation-residency.md).
 *  Every smoke ran on a small test profile, so none could see it. This builds a profile of that
 *  shape once: thousands of conversations across about twenty projects, more than 1.3 GB of
 *  projection JSON (a few of about 10 MB), most with the listing summary a checkpoint writes and a
 *  minority without, a multi-GB structured_events journal, projects, workspaces with open tabs.
 *
 *  The schema is never written here: the candidate itself creates it by booting once, parked, on an
 *  empty test profile, and the rows go into that database with node:sqlite. The cache lives in the
 *  MAIN checkout's .conductor-scratch/owner-scale-profile/ (a candidate worktree under
 *  ../conductor-candidates/<sha> finds it through `git rev-parse --git-common-dir`), one copy,
 *  keyed by GENERATOR_VERSION, the sizing and the schema of the tables it fills; a different key
 *  regenerates it. Nothing here reads or copies the owner's real profile.
 *
 *  Usage: node scripts/owner-scale-profile.mjs [--regenerate] [--small] [--cache <dir>]
 *  (run it under scripts/smoke-lock.mjs: the schema probe boots the app). */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Bump when the generated data changes shape, so every cache is rebuilt. */
export const GENERATOR_VERSION = 3

/** The owner's machine on 2026-10-22: 1,666 conversations, 1.27 GB of projection JSON (largest
 *  10.8 MB), 117 open tabs, 13.5 GB journal of 11.1 M events. The profile is a little larger in
 *  projections (the check must stay ahead of the owner's growth) and smaller in journal (it is
 *  never read whole at startup; 3 GB keeps the per-run copy to seconds). */
export const DEFAULT_SIZING = Object.freeze({
  seed: 20261022,
  projects: 20,
  conversations: 3000,
  projectionBytes: 1_450_000_000,
  journalBytes: 3_000_000_000,
  huge: 12,
  hugeMin: 8_000_000,
  hugeMax: 11_000_000,
  smallMin: 3_000,
  largeMax: 6_000_000,
  openPerProject: 6,
  recentAgents: 200,
  withoutSummary: 0.12,
  archived: 0.15,
  midTurn: 0.06
})
/** `--small`: the same shape at about 1/50, for working on the generator itself. */
export const SMALL_SIZING = Object.freeze({ ...DEFAULT_SIZING, projects: 4, conversations: 60, projectionBytes: 30_000_000, journalBytes: 60_000_000, huge: 1, hugeMin: 4_000_000, hugeMax: 5_000_000, openPerProject: 3, recentAgents: 10 })

/** The tables the generator fills. Their schema (as the candidate creates it) is part of the key. */
export const FILLED_TABLES = ['projects', 'sessions', 'agent_sessions', 'settings', 'structured_sessions', 'structured_events', 'structured_meta', 'structured_runtimes']
/** Where project folders point. Fixed so the cached rows never need rewriting (a structured_sessions
 *  row carries its projection inline: touching its spec would rewrite gigabytes); the smoke
 *  recreates these folders empty for each run. */
export const projectsRoot = () => join(tmpdir(), 'conductor-owner-scale-projects')

// ------------------------------------------------------------------------------------- pure parts

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const gaussian = rng => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng())

/** Projection size of every conversation: `huge` of hugeMin..hugeMax, the rest a long-tailed
 *  (log-normal) spread between smallMin and largeMax, scaled so the total is projectionBytes. */
export function planConversationSizes(sizing = DEFAULT_SIZING) {
  const rng = mulberry32(sizing.seed)
  const huge = Array.from({ length: sizing.huge }, () => Math.round(sizing.hugeMin + rng() * (sizing.hugeMax - sizing.hugeMin)))
  const restCount = sizing.conversations - huge.length
  const remaining = sizing.projectionBytes - huge.reduce((sum, size) => sum + size, 0)
  if (restCount <= 0 || remaining <= 0) throw new Error('sizing leaves nothing for the ordinary conversations')
  let rest = Array.from({ length: restCount }, () => Math.exp(Math.log(150_000) + 1.25 * gaussian(rng)))
  for (let pass = 0; pass < 8; pass++) {
    const sum = rest.reduce((total, size) => total + size, 0)
    rest = rest.map(size => Math.min(sizing.largeMax, Math.max(sizing.smallMin, size * remaining / sum)))
  }
  const sizes = [...huge, ...rest.map(Math.round)]
  // Shuffle so the huge ones are spread over projects and ages, deterministically.
  for (let index = sizes.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [sizes[index], sizes[other]] = [sizes[other], sizes[index]]
  }
  return sizes
}

/** The schema rows that matter for the key: the filled tables, their indexes and triggers, with
 *  whitespace normalised and in a stable order. */
export function normalizeSchema(rows) {
  return rows
    .filter(row => row.sql && FILLED_TABLES.includes(row.tbl_name))
    .map(row => `${row.type} ${row.name}: ${row.sql.replace(/\s+/g, ' ').trim()}`)
    .sort()
    .join('\n')
}

export function profileKey({ schema, sizing = DEFAULT_SIZING, version = GENERATOR_VERSION }) {
  return createHash('sha256').update(JSON.stringify({ version, sizing, schema })).digest('hex').slice(0, 16)
}

/** What the store writes beside each projection at checkpoint (structured-store.ts summarizeProjection). */
export function summarizeProjection(state) {
  let message
  for (let index = state.items.length - 1; index >= 0; index--) {
    const data = state.items[index].data
    if (data.type === 'text' && data.text.trim()) { message = data; break }
  }
  const text = message?.text.replace(/\s+/g, ' ').trim().slice(0, 180)
  return { phase: state.phase, items: state.items.length, ...(state.settings.model ? { model: state.settings.model } : {}), ...(text && message ? { snippet: text, lastRole: message.role } : {}) }
}

// ------------------------------------------------------------------------------ checkout and cache

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
/** The main checkout behind `cwd`, which may be a linked worktree. */
export function mainCheckout(cwd = process.cwd()) {
  try { return dirname(resolve(cwd, git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) } catch { return resolve(cwd) }
}
export const defaultCacheDirectory = (cwd = process.cwd()) => join(mainCheckout(cwd), '.conductor-scratch', 'owner-scale-profile')

/** The environment of a parked test launch: never the owner's profile, never a visible window. */
export function parkedEnvironment(userData, extra = {}) {
  const env = { ...process.env, CONDUCTOR_OFFLINE_TESTS: '1', CONDUCTOR_TEST_USER_DATA: userData, CONDUCTOR_PROJECTS_ROOT: projectsRoot(), ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CONDUCTOR_BACKGROUND_WINDOWS
  return env
}

const sleep = ms => new Promise(done => setTimeout(done, ms))
/** Closes a launched app and waits for its main process to be gone (killing it past the timeout).
 *  A profile copy of several GB takes a while to close. */
/** `child` is the process the launch returned, kept by the caller: once the app died, Playwright
 *  no longer answers `app.process()`. */
export async function closeApp(app, timeoutMs = 30_000, child = (() => { try { return app.process() } catch { return null } })()) {
  if (!child) { await Promise.race([app.close().catch(() => {}), sleep(timeoutMs)]); return }
  const running = () => child.exitCode === null && child.signalCode === null
  const gone = new Promise(done => { if (!running()) done(); else child.once('exit', done) })
  await Promise.race([app.close().catch(() => {}), sleep(timeoutMs)])
  // Playwright's process can be a launcher whose Electron child (and that child's GPU, renderer
  // and utility processes) outlives it holding the profile: stop every process descended from the
  // one this run launched, deepest first, and nothing else.
  const tree = descendants(child.pid)
  if (running()) { try { child.kill() } catch { /* already gone */ } }
  for (const pid of tree.reverse()) { try { process.kill(pid) } catch { /* already gone */ } }
  await Promise.race([gone, sleep(10_000)])
}
/** Every process descended from `root` (Windows; elsewhere the launched process is the app). */
export function descendants(root) {
  if (process.platform !== 'win32' || !root) return []
  try {
    const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; q = [int]$_.ParentProcessId } } | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }) || '[]')
    const found = [], frontier = [root]
    while (frontier.length) {
      const parent = frontier.shift()
      for (const row of rows) if (row.q === parent && row.p !== root && !found.includes(row.p)) { found.push(row.p); frontier.push(row.p) }
    }
    return found
  } catch { return [] }
}
/** Removes a test profile, retrying while Electron's helper processes still hold files in it.
 *  Returns false (and says so) instead of throwing when it cannot. */
export async function removeTree(path, timeoutMs = 90_000, log = console.error) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { rmSync(path, { recursive: true, force: true }); return true } catch (error) {
      if (Date.now() > deadline) { log(`could not remove ${path}: ${error.code ?? error.message}`); return false }
      await sleep(1000)
    }
  }
}

const waitFor = async (test, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await test()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}`)
    await new Promise(done => setTimeout(done, 250))
  }
}

/** Boots the candidate in `cwd` once, parked, on an empty profile, and returns the database it
 *  created (closed, checkpointed) with its schema. The caller removes `root`. */
export async function probeSchema(cwd, log = console.log) {
  const { _electron: electron } = await import('@playwright/test')
  const main = resolve(cwd, 'out', 'main', 'index.js')
  if (!existsSync(main)) throw new Error(`${main} does not exist: build the candidate first (npm run build)`)
  const root = mkdtempSync(join(tmpdir(), 'conductor-owner-scale-probe-'))
  const userData = join(root, 'profile')
  mkdirSync(projectsRoot(), { recursive: true })
  log(`schema probe: booting ${main} on an empty profile`)
  const started = Date.now()
  const app = await electron.launch({ args: [main], cwd, env: parkedEnvironment(userData, { CONDUCTOR_TEST_EMPTY_HISTORY: '1' }), timeout: 60_000 })
  try {
    await waitFor(() => existsSync(join(userData, 'control-owner.json')), 90_000, 'control-owner.json on the empty profile')
    // The schema is complete once app control answers; a few seconds more lets anything the
    // window's first load creates land too. The probe needs no window of its own.
    await waitFor(() => app.windows().length > 0, 30_000, 'the first window').catch(error => log(`schema probe: ${error.message}; reading the schema anyway`))
    await new Promise(done => setTimeout(done, 3000))
  } finally {
    await closeApp(app)
  }
  const database = join(userData, 'conductor.db')
  if (!existsSync(database)) throw new Error(`the probe launch wrote no ${database}`)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(database)
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const schema = normalizeSchema(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all())
    log(`schema probe: done in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    return { root, database, schema }
  } finally { db.close() }
}

// ----------------------------------------------------------------------------------------- content

const WORDS = ('the a to of and in that is for it with as on be this are not by at from or an will was but have which can one all when there were so if what more about out up into than then them only some time these could would should other also new now how its our two may any where most after over just because function const return import export await async class interface type string number boolean null undefined true false error test build commit worktree conductor projection journal structured session agent runtime renderer main process window heap memory startup smoke candidate update install verify phone layout tab pane composer timeline tool output stderr exit code path file src/main/index.ts src/main/structured-store.ts docs/startup-diagnostics.md npm vitest typecheck git ship diff patch line column query sqlite index table row events summary snapshot checkpoint resident evict budget guard limit owner wizard coworker controller dispatch steer review approval permission card sandbox auto edit read write bash powershell node electron playwright fixture assert expect describe it should passes fails flaky timeout retry').split(' ')
/** The owner's text is not ASCII: typographic quotes and dashes, arrows, check marks and tree
 *  drawing in tool output. That matters for memory: V8 keeps a string with any such character in
 *  two bytes per character, so a row or message that has one costs twice its ASCII size. */
const PUNCT = ['.', ',', '.', ':', ';', '.\n', '.\n\n', ' -', '?', '`', '()', ' =>', ' {', '}', ' —', '…', '’s', ' →', ' ✓', ' “ok”', ' ×2', '\n├──', '\n│']

/** One large deterministic text to slice message bodies, tool outputs and patches from. */
function buildCorpus(rng, length) {
  const parts = []
  let size = 0
  while (size < length) {
    const word = WORDS[Math.floor(rng() * WORDS.length)]
    const part = rng() < 0.12 ? word + PUNCT[Math.floor(rng() * PUNCT.length)] + ' ' : word + ' '
    parts.push(part)
    size += part.length
  }
  return parts.join('')
}

const MODELS = { claude: ['opus', 'claude-opus-5-5', 'sonnet'], codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol'] }
const TOOLS = { claude: ['Bash', 'Read', 'Edit', 'Grep', 'Write', 'mcp__conductor__control'], codex: ['shell', 'apply_patch', 'read_file', 'mcp__conductor__control'] }
const capabilities = provider => ({
  provider, runtimeVersion: provider === 'claude' ? '2.9.14' : '0.159.0', adapterVersion: 1, authentication: 'cli', textStreaming: true, steering: true,
  toolInputStreaming: true, toolOutputStreaming: true, approvals: true, questions: true, resume: true, fork: provider === 'claude', plans: true, imageAttachments: true,
  permissions: ['default', 'read-only', 'accept-edits', 'auto'], effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  models: MODELS[provider].map((id, index) => ({ id, label: id, effort: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', ...(index === 0 ? { isDefault: true } : {}) })),
  limitations: []
})

// --------------------------------------------------------------------------------------- generator

/** Writes one conversation: its journal events as they would have been appended, then its
 *  projection row as the last checkpoint left it. Returns the byte counts. */
class ConversationWriter {
  constructor(context, spec) {
    Object.assign(this, context)
    this.spec = spec
    this.sequence = 0
    this.journalBytes = 0
    this.events = 0
    this.items = []
    this.keep = false
    this.runtime = 0
    this.turn = 0
    this.clock = spec.startedAt
  }
  get runtimeId() { return `rt_${this.spec.id}_${this.runtime}` }
  get nativeSessionId() { return `native-${this.spec.id}-${this.runtime}` }
  text(length) {
    const size = Math.max(1, Math.min(Math.round(length), 60_000))
    const offset = Math.floor(this.rng() * (this.corpus.length - size))
    return this.corpus.slice(offset, offset + size)
  }
  emit(data, extra = {}) {
    this.sequence++
    this.clock += 200 + Math.floor(this.rng() * 4000)
    const event = {
      schemaVersion: 1, id: `evt_${this.spec.id}_${this.sequence}`, sequence: this.sequence, sessionId: this.spec.id, runtimeId: this.runtimeId,
      provider: this.spec.provider, projectId: this.spec.projectId, workspaceId: this.spec.sessionId, cwd: this.spec.cwd,
      nativeSessionId: this.nativeSessionId, ...extra, timestamp: new Date(this.clock).toISOString(), data
    }
    const json = JSON.stringify(event)
    this.insertEvent.run(this.spec.id, this.sequence, json)
    this.journalBytes += json.length
    this.events++
    return event
  }
  /** A timeline item built from the events just emitted for it (the reducer's id and fields). */
  item(first, last, data) {
    if (!this.keep) return
    const identity = first.itemId
    const id = identity ? JSON.stringify([first.runtimeId, first.nativeSessionId ?? '', first.turnId ?? '', identity, data.type]) : first.id
    this.items.push({ id, runtimeId: first.runtimeId, turnId: first.turnId, nativeItemId: first.itemId, sequence: first.sequence, updatedSequence: last.sequence, timestamp: first.timestamp, data })
  }
  startRuntime() {
    this.runtime++
    this.emit({ type: 'session', phase: 'starting', nativeSessionId: this.nativeSessionId, settings: this.spec.settings, capabilities: this.spec.capabilities, view: 'visual' })
    if (this.runtimeRow) this.runtimeRow.run(this.spec.id, this.runtimeId, new Date(this.clock).toISOString(), this.sequence)
  }
  /** One turn of about `budget` characters of content. */
  turnOf(budget, average) {
    if (this.runtime === 0 || this.rng() < 0.04) this.startRuntime()
    this.turn++
    const turnId = `turn_${this.turn}`
    this.emit({ type: 'session', phase: 'running' }, { turnId })
    const prompt = this.text(Math.min(2000, 40 + this.rng() * 900))
    const user = this.emit({ type: 'text', role: 'user', text: prompt, mode: 'snapshot' }, { turnId, itemId: `u${this.turn}` })
    this.item(user, user, { type: 'text', role: 'user', text: prompt, mode: 'snapshot' })
    let spent = prompt.length, part = 0
    while (spent < budget) {
      part++
      const size = Math.min(60_000, Math.max(60, average * Math.exp(0.8 * gaussian(this.rng))))
      const roll = this.rng(), itemId = `i${this.turn}_${part}`
      if (roll < 0.36) {
        const text = this.text(size)
        const chunks = Math.min(6, 1 + Math.floor(text.length / 700))
        const step = Math.ceil(text.length / chunks)
        let first, last
        for (let at = 0; at < text.length; at += step) {
          last = this.emit({ type: 'text', role: 'assistant', text: text.slice(at, at + step), mode: 'delta' }, { turnId, itemId })
          first ??= last
        }
        this.item(first, last, { type: 'text', role: 'assistant', text, mode: 'delta' })
      } else if (roll < 0.86) {
        const name = this.tools[Math.floor(this.rng() * this.tools.length)]
        const input = name === 'Read' || name === 'read_file' ? { file_path: `${this.spec.cwd}\\src\\main\\${this.text(18).replace(/\W+/g, '-')}.ts` } : { command: this.text(Math.min(400, 30 + size / 20)), description: this.text(60) }
        const output = this.text(size)
        const first = this.emit({ type: 'tool', name, input, status: 'running' }, { turnId, itemId })
        const chunks = Math.min(4, 1 + Math.floor(output.length / 4000)), step = Math.ceil(output.length / chunks)
        for (let at = 0; at < output.length; at += step) this.emit({ type: 'tool', name, status: 'running', output: output.slice(at, at + step), outputMode: 'delta' }, { turnId, itemId })
        const exitCode = this.rng() < 0.9 ? 0 : 1, durationMs = Math.floor(this.rng() * 30_000)
        const last = this.emit({ type: 'tool', name, status: exitCode ? 'failed' : 'completed', exitCode, durationMs }, { turnId, itemId })
        this.item(first, last, { type: 'tool', name, input, inputDelta: '', status: exitCode ? 'failed' : 'completed', output, outputMode: 'delta', exitCode, durationMs })
      } else if (roll < 0.95) {
        const patch = this.text(size)
        const changes = [{ path: `src/main/${this.text(14).replace(/\W+/g, '-')}.ts`, kind: 'update', patch, additions: 1 + Math.floor(size / 120), deletions: Math.floor(size / 300), status: 'applied' }]
        const event = this.emit({ type: 'changes', changes }, { turnId, itemId })
        this.item(event, event, { type: 'changes', changes })
      } else {
        const message = this.text(Math.min(size, 600))
        const event = this.emit({ type: 'notice', message }, { turnId, itemId })
        this.item(event, event, { type: 'notice', message })
      }
      spent += size
    }
    const inputTokens = 2000 + Math.floor(this.rng() * 400_000)
    const usage = this.emit({ type: 'usage', inputTokens, outputTokens: Math.floor(inputTokens / 40), cachedTokens: Math.floor(inputTokens * 0.8), totalTokens: inputTokens + Math.floor(inputTokens / 40), scope: 'turn', source: 'provider' }, { turnId })
    this.item(usage, usage, usage.data)
    this.emit({ type: 'session', phase: 'completed' }, { turnId })
    return spent
  }
}

const now = () => new Date().toISOString()
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all()
/** An INSERT for the given values that fails loudly when the candidate's table has a required
 *  column the generator does not know (a schema change the generator must learn). */
function inserter(db, table, values) {
  const columns = columnsOf(db, table)
  if (!columns.length) throw new Error(`the candidate has no ${table} table`)
  const names = Object.keys(values).filter(name => columns.some(column => column.name === name))
  const missing = columns.filter(column => column.notnull && column.dflt_value === null && !column.pk && !names.includes(column.name))
  if (missing.length) throw new Error(`${table} needs ${missing.map(column => column.name).join(', ')}, which owner-scale-profile.mjs does not fill; teach it (and bump GENERATOR_VERSION)`)
  const statement = db.prepare(`INSERT OR REPLACE INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`)
  return { names, run: row => statement.run(...names.map(name => row[name] ?? null)) }
}

/** Fills `database` (the probe's, schema already created by the candidate). */
export async function fillProfile(database, sizing = DEFAULT_SIZING, log = console.log) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(database)
  const started = Date.now()
  const rng = mulberry32(sizing.seed ^ 0x5bd1e995)
  const corpus = buildCorpus(rng, 4 * 1024 * 1024)
  const sizes = planConversationSizes(sizing)
  const journalRatio = sizing.journalBytes / sizing.projectionBytes
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA foreign_keys=OFF; PRAGMA cache_size=-262144; PRAGMA temp_store=MEMORY')
    const hasSummary = columnsOf(db, 'structured_sessions').some(column => column.name === 'summary_json')
    const hasRuntimes = columnsOf(db, 'structured_runtimes').length > 0
    const root = projectsRoot()
    const epoch = Date.parse('2026-09-16T08:00:00Z'), span = Date.parse('2026-10-22T08:00:00Z') - epoch
    const projects = Array.from({ length: sizing.projects }, (_, index) => {
      const n = String(index + 1).padStart(2, '0')
      return { id: `project_ownerscale_${n}`, name: `Owner scale ${n}`, path: join(root, `project-${n}`), workspace: `workspace_ownerscale_${n}`, open: [] }
    })
    const project = inserter(db, 'projects', { id: '', name: '', path: '', created_at: '', updated_at: '' })
    const settings = inserter(db, 'settings', { key: '', value: '', updated_at: '' })
    const agent = inserter(db, 'agent_sessions', { id: '', project_id: '', session_id: '', provider: '', title: '', cwd: '', resume: 1, transcript: '', status: '', updated_at: '', model: '', effort: '', continue_on_limit: 0, activity_phase: '' })
    const session = inserter(db, 'structured_sessions', { id: '', project_id: '', provider: '', spec_json: '', projection_json: '', title: '', archived: 0, ...(hasSummary ? { summary_json: '' } : {}) })
    const insertEvent = db.prepare('INSERT INTO structured_events(session_id, sequence, event_json) VALUES(?,?,?)')
    const runtimeRow = hasRuntimes ? db.prepare('INSERT OR IGNORE INTO structured_runtimes(session_id, runtime_id, started_at, first_sequence) VALUES(?,?,?,?)') : null

    db.exec('BEGIN')
    for (const entry of projects) project.run({ id: entry.id, name: entry.name, path: entry.path, created_at: new Date(epoch).toISOString(), updated_at: now() })
    db.exec('COMMIT')

    // Conversation ids sort in creation order, so the journal's primary key grows at its end.
    const conversations = sizes.map((size, index) => {
      const provider = rng() < 0.62 ? 'claude' : 'codex'
      const home = projects[Math.min(projects.length - 1, Math.floor(Math.pow(rng(), 1.6) * projects.length))]
      const model = MODELS[provider][Math.floor(rng() * MODELS[provider].length)]
      const startedAt = epoch + Math.floor(span * index / sizes.length)
      return { index, size, id: `agent_os${String(index).padStart(5, '0')}_${Math.floor(rng() * 36 ** 6).toString(36).padStart(6, '0')}`, provider, model, project: home, startedAt }
    })
    let projectionTotal = 0, journalTotal = 0, eventTotal = 0, itemTotal = 0, withSummary = 0, archivedCount = 0, midTurnCount = 0, largest = 0
    const ages = []
    for (const conversation of conversations) {
      const { id, provider, model, project: home, size } = conversation
      const settingsValue = { model, effort: 'high', permission: 'auto', plan: false }
      const title = `${home.name}: ${corpus.slice(conversation.index * 97 % 100_000, conversation.index * 97 % 100_000 + 60).replace(/\s+/g, ' ').trim()}`
      const spec = { id, projectId: home.id, sessionId: home.workspace, provider, title, cwd: home.path, resume: true, model, effort: 'high', continueOnLimit: false, settings: settingsValue, capabilities: capabilities(provider), startedAt: conversation.startedAt }
      const writer = new ConversationWriter({ rng, corpus, insertEvent, runtimeRow, tools: TOOLS[provider] }, spec)
      // Items per conversation: up to the 2,000 the timeline keeps; the average item follows.
      const itemsWanted = Math.min(1900, Math.max(6, Math.round(size / (900 + rng() * 3000))))
      const average = Math.max(120, size / itemsWanted)
      const turnBudget = Math.max(average * 2, Math.min(size / 3, average * (4 + rng() * 14)))
      db.exec('BEGIN')
      // Older history the timeline already dropped: in the journal, not in the projection.
      const older = Math.max(0, size * journalRatio - size * 1.35)
      let spent = 0
      while (spent < older * 0.75) spent += writer.turnOf(turnBudget, average)
      const truncated = writer.sequence > 0
      writer.keep = true
      spent = 0
      while (spent < size * 0.84 || writer.items.length < 3) spent += writer.turnOf(turnBudget, average)
      const midTurn = rng() < sizing.midTurn
      const archived = !midTurn && rng() < sizing.archived
      const snapshotSequence = writer.sequence
      const items = writer.items.length > 2000 ? writer.items.slice(-2000) : writer.items
      const projection = {
        view: 'visual', queued: null, queuedPrompts: [], pendingSteering: [], sessionId: id, runtimeId: writer.runtimeId, nativeSessionId: writer.nativeSessionId,
        phase: midTurn ? 'running' : 'completed', sequence: snapshotSequence, items, capabilities: spec.capabilities, settings: settingsValue,
        title, archived, truncated: truncated || writer.items.length > 2000
      }
      // A conversation the last process was in the middle of: the journal holds a turn after the snapshot.
      if (midTurn) { writer.keep = false; writer.turnOf(Math.min(turnBudget, 20_000), Math.min(average, 2000)); midTurnCount++ }
      const json = JSON.stringify(projection)
      const summary = !hasSummary || rng() < sizing.withoutSummary ? null : JSON.stringify(summarizeProjection(projection))
      const { capabilities: _capabilities, settings: _settings, startedAt: _startedAt, ...storedSpec } = spec
      session.run({ id, project_id: home.id, provider, spec_json: JSON.stringify(storedSpec), projection_json: json, title, archived: archived ? 1 : 0, summary_json: summary })
      const updatedAt = new Date(writer.clock).toISOString()
      agent.run({ id, project_id: home.id, session_id: home.workspace, provider, title, cwd: home.path, resume: 1, transcript: '', status: 'exited', updated_at: updatedAt, model, effort: 'high', continue_on_limit: 0, activity_phase: 'idle' })
      db.exec('COMMIT')
      if (!archived) home.open.push({ id, title, provider, model, at: writer.clock })
      ages.push({ id, at: writer.clock })
      projectionTotal += json.length; journalTotal += writer.journalBytes; eventTotal += writer.events; itemTotal += items.length
      largest = Math.max(largest, json.length)
      if (summary) withSummary++
      if (archived) archivedCount++
      const done = conversation.index + 1
      if (done % 100 === 0 || done === conversations.length) {
        const seconds = (Date.now() - started) / 1000
        log(`  ${done}/${conversations.length} conversations, ${(projectionTotal / 1e9).toFixed(2)} GB projections, ${(journalTotal / 1e9).toFixed(2)} GB journal (${eventTotal.toLocaleString('en-US')} events), ${seconds.toFixed(0)} s, about ${Math.round(seconds / done * (conversations.length - done))} s left`)
      }
    }

    // Workspaces with the newest conversations of each project open as tabs (the owner had 117).
    const workspace = inserter(db, 'sessions', { id: '', project_id: '', name: '', layout_json: '', closed_tabs_json: '[]', created_at: '', updated_at: '', continue_on_limit: 0 })
    db.exec('BEGIN')
    let openTabs = 0
    for (const entry of projects) {
      const open = entry.open.sort((a, b) => b.at - a.at).slice(0, sizing.openPerProject)
      const tabs = open.map((conversation, index) => ({ id: `tab_${entry.workspace}_${index}`, kind: 'agent', title: conversation.title.slice(0, 60), resourceId: conversation.id, titleLocked: true, state: { provider: conversation.provider, model: conversation.model, effort: 'high', resume: true, viewMode: 'visual' } }))
      openTabs += tabs.length
      const layout = { version: 1, root: { type: 'group', id: `group_${entry.workspace}`, tabs, activeTabId: tabs[0]?.id ?? '' } }
      workspace.run({ id: entry.workspace, project_id: entry.id, name: 'Main', layout_json: JSON.stringify(layout), closed_tabs_json: '[]', created_at: new Date(epoch).toISOString(), updated_at: now(), continue_on_limit: 0 })
    }
    const setting = (key, value) => settings.run({ key, value, updated_at: now() })
    setting('activeProjectId', projects[0].id)
    setting('activeSessionId', projects[0].workspace)
    setting('sessionIdsByProject', JSON.stringify(Object.fromEntries(projects.map(entry => [entry.id, entry.workspace]))))
    // The one-off secret redaction finished long ago on the owner's machine.
    const meta = db.prepare('INSERT OR REPLACE INTO structured_meta(key, value) VALUES(?,?)')
    meta.run('secret_redaction_v1', JSON.stringify({ target: 4, after: 0, changed: 0, done: '2026-09-29T00:00:00.000Z' }))
    meta.run('secret_redaction_artifacts_v1', JSON.stringify({ after: '', changed: 0, done: '2026-09-29T00:00:00.000Z' }))
    db.exec('COMMIT')
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const recent = ages.sort((a, b) => b.at - a.at).slice(0, sizing.recentAgents).map(entry => entry.id)
    return {
      projects: projects.length, conversations: conversations.length, openTabs, recentAgents: recent, withSummary, withoutSummary: conversations.length - withSummary,
      archived: archivedCount, midTurn: midTurnCount, timelineItems: itemTotal, events: eventTotal,
      projectionBytes: projectionTotal, largestProjectionBytes: largest, journalBytes: journalTotal, seconds: Math.round((Date.now() - started) / 1000)
    }
  } finally { db.close() }
}

/** The cached profile for the candidate in `cwd`, generated when missing or keyed differently.
 *  Returns the cached database path and its manifest. */
export async function ensureOwnerScaleProfile({ cwd = process.cwd(), regenerate = false, sizing = DEFAULT_SIZING, cache = defaultCacheDirectory(cwd), log = console.log } = {}) {
  const probe = await probeSchema(cwd, log)
  try {
    const key = profileKey({ schema: probe.schema, sizing })
    const database = join(cache, 'conductor.db'), manifestPath = join(cache, 'manifest.json')
    let manifest = null
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { /* none yet */ }
    if (!regenerate && manifest?.key === key && existsSync(database) && statSync(database).size === manifest.databaseBytes) {
      log(`owner-scale profile: cached ${key} (${(manifest.databaseBytes / 1e9).toFixed(2)} GB, ${manifest.conversations} conversations) in ${cache}`)
      return { database, manifest }
    }
    log(`owner-scale profile: ${regenerate ? 'regenerating on request' : manifest ? `key ${manifest.key} != ${key}, regenerating` : 'none cached, generating'} in ${cache}`)
    mkdirSync(cache, { recursive: true })
    // One copy: the old database goes before the new one is written.
    for (const name of ['conductor.db', 'conductor.db.partial', 'manifest.json']) rmSync(join(cache, name), { force: true })
    const partial = join(cache, 'conductor.db.partial')
    copyFileSync(probe.database, partial)
    const filled = await fillProfile(partial, sizing, log)
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(partial + suffix, { force: true })
    renameSync(partial, database)
    manifest = { key, generatorVersion: GENERATOR_VERSION, generatedAt: now(), generatedBy: cwd, projectsRoot: projectsRoot(), sizing, schemaTables: FILLED_TABLES, ...filled, databaseBytes: statSync(database).size }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    log(`owner-scale profile: generated ${key} in ${filled.seconds} s: ${(manifest.databaseBytes / 1e9).toFixed(2)} GB database, ${filled.conversations} conversations, ${(filled.projectionBytes / 1e9).toFixed(2)} GB projections (largest ${(filled.largestProjectionBytes / 1e6).toFixed(1)} MB), ${(filled.journalBytes / 1e9).toFixed(2)} GB journal`)
    return { database, manifest }
  } finally {
    await removeTree(probe.root)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--cache')
  const small = args.includes('--small')
  const options = { regenerate: args.includes('--regenerate'), sizing: small ? SMALL_SIZING : DEFAULT_SIZING, ...(at >= 0 ? { cache: resolve(args[at + 1]) } : small ? { cache: join(defaultCacheDirectory(), 'small') } : {}) }
  ensureOwnerScaleProfile(options).then(({ database, manifest }) => { console.log(database); console.log(JSON.stringify({ key: manifest.key, conversations: manifest.conversations, projectionBytes: manifest.projectionBytes, journalBytes: manifest.journalBytes, databaseBytes: manifest.databaseBytes })) })
    .catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1 })
}
