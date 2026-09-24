import { boundedSearch } from './bounded-search.ts'
import { splitExecutionEnvelope } from './bounded-execution.ts'
import { createHash, randomUUID } from 'node:crypto'
import { boundedFile, staleEvidence, type LocalFileEvidence } from './bounded-files.ts'
import { defaultResultStore, type LocalResultStore } from './result-artifacts.ts'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ToolSpec } from './client.ts'
import { brokeredGitPush, mentionsGitPush } from './git-push.ts'
import type { DockerSandbox } from './sandbox.ts'
import { SandboxPolicyError, SandboxUnavailableError, assertNoPackageInstall } from './sandbox.ts'
import { readPublicWeb, searchPublicWeb } from './web.ts'
import { isSecretPath, resolveInWorkspace, resolveWritablePath, SecretPathError, WorkspaceBoundaryError } from './workspace.ts'
import { pathAllowed, type TaskContract } from './completion.ts'

/** The complete capability set a local model is given. It is an allowlist in code, not an
 *  instruction in a prompt: a name that is not in this list cannot be dispatched at all, which
 *  is what keeps host shell tools, browser automation, connectors, credentials and every other
 *  Conductor capability out of reach of a model whose output may be prompt-injected. */
export const LOCAL_TOOLS = ['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'apply_edits', 'run_command', 'conductor', 'web_read', 'web_search'] as const

/** Which tools a conversation is offered. 'full' is the ordinary conversation; 'coding' is a
 *  bounded task under a contract, which gets the file and command tools only: the memory, task
 *  board and web brokers cost schema tokens on every round and were where field runs drifted
 *  (claiming tasks, saving memory) instead of editing. A capability of the task, not the model. */
export type ToolScope = 'full' | 'coding'
const CODING_SCOPE_TOOLS: ReadonlySet<string> = new Set<string>(['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'apply_edits', 'run_command'])

/** How many lines read_file returns unasked, and the most it returns at all. The header names
 *  the total so the model can ask for the range it needs; a whole 34 KB file in one result was
 *  enough to end a real run after two calls. */
export interface ReadWindow { defaultLines: number; maxLines: number }
export const DEFAULT_READ_WINDOW: ReadWindow = { defaultLines: 200, maxLines: 800 }

/** Capabilities the owner turns on for one conversation, off unless they say otherwise. `git`
 *  is a sandbox mount decision (see containerRunArgs); `research` widens the web broker from a
 *  single fetch tool to a search-and-read loop with room to actually use it. */
export interface LocalGrants { git: boolean; research: boolean }
export const NO_GRANTS: LocalGrants = { git: false, research: false }
export const LOCAL_CONTROL_METHODS = ['memory.recall', 'memory.remember', 'tasks.list', 'tasks.update', 'agents.list', 'agents.snapshot', 'agents.status', 'app.update', 'app.update.status', 'usage.limits'] as const
export type LocalControl = (method: string, args: Record<string, unknown>) => Promise<unknown>
export type LocalToolName = (typeof LOCAL_TOOLS)[number]
const MUTATING: ReadonlySet<string> = new Set<string>(['write_file', 'edit_file', 'apply_edits', 'run_command'])
export const WRITE_TOOLS: ReadonlySet<string> = new Set<string>(['write_file', 'edit_file', 'apply_edits'])

export class ToolPolicyError extends Error {}

/** Methods that write something durable, so a read-only turn must not reach them. */
const MUTATING_CONTROL: ReadonlySet<string> = new Set<string>(['memory.remember', 'tasks.update', 'app.update'])

/** Reused at the trusted session boundary so an adapter cannot widen its own authority. */
export function assertLocalControlAllowed(method: string, args: Record<string, unknown>, readOnly: boolean): void {
  if (!(LOCAL_CONTROL_METHODS as readonly string[]).includes(method) || (readOnly && MUTATING_CONTROL.has(method))) throw new ToolPolicyError('Conductor method is unavailable in this mode')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolPolicyError('args must be an object')
  const fields = method === 'memory.remember' ? ['gist', 'kind', 'cues']
    : method === 'memory.recall' ? ['query']
      // The scope fields (projectId, agentId) still come from the authorized session, never the model.
      : method === 'tasks.update' ? ['revision', 'id', 'status', 'title', 'priority']
        : method === 'agents.snapshot' || method === 'agents.status' ? ['agentSessionId']
          : method === 'usage.limits' ? ['provider'] : []
  if (Object.keys(args).some(key => !fields.includes(key))) throw new ToolPolicyError('Conductor scope and unsupported arguments cannot be overridden')
}

export function assertToolAllowed(name: string, readOnly: boolean, grants: LocalGrants = NO_GRANTS, scope: ToolScope = 'full'): asserts name is LocalToolName {
  if (!(LOCAL_TOOLS as readonly string[]).includes(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is not available to local models`)
  if (readOnly && MUTATING.has(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is unavailable in read-only mode`)
  if (scope === 'coding' && !CODING_SCOPE_TOOLS.has(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is not part of this bounded coding task`)
  if (name === 'web_search' && !grants.research) throw new ToolPolicyError('Tool denied by policy: web_search needs deep research turned on for this conversation')
}

const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_SEARCH_HITS = 200
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.venv', 'venv', '__pycache__', '.next', 'target'])

export function toolSpecs(readOnly: boolean, control = false, grants: LocalGrants = NO_GRANTS, scope: ToolScope = 'full', window: ReadWindow = DEFAULT_READ_WINDOW): ToolSpec[] {
  const specs: ToolSpec[] = [
    { type: 'function', function: { name: 'read_file', description: `Read bounded ranges; inspect gives SHA256/encoding evidence, bytes gives raw/hex samples. Returns at most ${window.defaultLines} lines unless limit is given (never more than ${window.maxLines}); the first line reports total_lines and the range returned, so read a large file in the ranges you need, or use search to find the lines first.`, parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative file' }, mode: { type: 'string', enum: ['lines', 'inspect', 'bytes'] }, byte_offset: { type: 'integer' }, byte_limit: { type: 'integer' }, artifact: { type: 'string', description: 'Owned result handle; replaces path' }, offset: { type: 'integer', description: 'First line to return (1-based).' }, limit: { type: 'integer', description: 'Maximum number of lines to return.' } }, } } },
    { type: 'function', function: { name: 'list_files', description: 'List the entries of a workspace directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative directory; defaults to the workspace root.' } } } } },
    { type: 'function', function: { name: 'search', description: 'Search an authorized file or directory with a regular expression; reports coverage and skipped data.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript regular expression.' }, path: { type: 'string', description: 'Workspace-relative file or directory to search.' }, glob: { type: 'string', description: 'Only search files whose name ends with this suffix, for example .ts' } }, required: ['pattern'] } } }
  ]
  if (scope === 'coding') return readOnly ? specs : [...specs, ...writeSpecs(grants)]
  if (grants.research) specs.push({ type: 'function', function: { name: 'web_search', description: 'Search the public web and get back a numbered list of result titles and HTTPS links. Read the promising ones with web_read. Search as many times as the question needs, with different wordings; only the query text leaves this machine, so never put private workspace content in it.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'How many results to return, 1 to 25. Defaults to 10.' } }, required: ['query'] } } })
  specs.push({ type: 'function', function: { name: 'web_read', description: 'GET a public HTTPS text page for research without inherited credentials or cookies. Private/local addresses are refused; shell networking stays disabled. URL paths and queries leave this machine: never include private workspace content.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } })
  if (control) specs.push({ type: 'function', function: { name: 'conductor', description: 'Access durable project memory, the project task checklist, and the other visible conversations through Conductor. memory.remember accepts gist, kind (semantic, episodic, procedural), cues (string array); memory.recall accepts query; use these to save memory, never a filesystem path. tasks.list takes no arguments and returns the tasks plus the revision to quote back. tasks.update accepts revision (from the tasks.list you just read), id, and any of status (todo, doing, done), title, priority (high, normal, low). agents.list takes no arguments and returns the agentSessionId of every visible conversation; agents.snapshot requires one of those exact agentSessionId values and returns that conversation\'s state. app.update takes no arguments and builds this checkout into a local update the installed Conductor then offers as "Update pending" — use it when the owner asks to update the app via the updater; the owner confirms the build unless another coworker already authorized this conversation, and it returns immediately, so poll app.update.status (no arguments) every minute or so until it is no longer running. Nothing is installed for the owner. usage.limits takes an optional provider (claude, codex, grok) and returns the newest account allowance each provider reported, with what is unknown.', parameters: { type: 'object', properties: { method: { type: 'string', enum: LOCAL_CONTROL_METHODS.filter(method => !readOnly || !MUTATING_CONTROL.has(method)) }, args: { type: 'object' } }, required: ['method', 'args'] } } })
  if (readOnly) return specs
  return [...specs, ...writeSpecs(grants)]
}

function writeSpecs(grants: LocalGrants): ToolSpec[] {
  return [
    { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a workspace file. With append: true the content is added to the end of the file instead, creating it if needed. One call can only carry a few thousand tokens, so write a large file in parts: the first part plainly, then each further part with append: true.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'edit_file', description: 'Replace an exact string in a workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] } } },
    { type: 'function', function: { name: 'apply_edits', description: 'Apply several exact replacements to one workspace file in a single call, atomically: every old_text must occur exactly once in the current file, or nothing is written and the result says which edit failed. Use this instead of one edit_file per change when a task lists several exact edits.', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['old_text', 'new_text'] }, description: 'Up to 40 replacements, applied in order.' } }, required: ['path', 'edits'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Run command OR saved script OR code with runtime and args in Docker. Code is saved in task scratch; results have owned retrieval handles. cwd is workspace-relative. The workspace is mounted at /workspace. There is no network access. npm, npx, yarn, pnpm and bun installs are refused: with no network they can only destroy the dependency tree that is already there. Run installed binaries directly instead, for example `node ./node_modules/typescript/bin/tsc --noEmit` or `./node_modules/.bin/vitest run <file>`.' + (grants.git ? ' Git is writable in this conversation: commit and branch locally as you work. `git push` works too, but it is run for you on the host, because the container has no network: send it as a command of its own, with at most an existing remote and the branch you are on. Force, delete and other push flags stay refused.' : ' The .git directory is read-only: git log and git diff work, git commit does not.'), parameters: { type: 'object', properties: { command: { type: 'string' }, code: { type: 'string' }, script: { type: 'string' }, runtime: { type: 'string', enum: ['python3', 'python', 'node', 'bash'] }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeout_sec: { type: 'integer' } } } } }
  ]
}

export interface ToolContext {
  workspace: string
  taskId?: string
  artifacts?: LocalResultStore
  analysisScratch?: string
  analysis?: { taskId: string }
  readOnly: boolean
  grants?: LocalGrants
  /** A bounded task's contract: paths a write may touch. Enforced here, not in the prompt. */
  contract?: TaskContract
  scope?: ToolScope
  readWindow?: ReadWindow
  sandbox: DockerSandbox | null
  timeoutSec: number
  signal?: AbortSignal
  control?: LocalControl
  beforeTool?(paths: string[]): Promise<void>
  afterTool?(paths: string[], success: boolean): Promise<void>
}

export interface ToolOutcome { output: string; failed: boolean; paths: string[]; exitCode?: number; evidence?: LocalFileEvidence }

const argumentsOf = (raw: string): Record<string, unknown> => {
  if (!raw?.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch { throw new ToolPolicyError('Tool arguments must be a JSON object') }
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new ToolPolicyError(`${name} must be a string`)
  return value
}

const integer = (value: unknown, fallback: number): number => Number.isInteger(value) ? value as number : fallback

async function walk(root: string, directory: string, visit: (path: string) => Promise<boolean>, skipped: string[], budget = { remaining: 10000 }): Promise<boolean> {
  let entries: import('node:fs').Dirent[]
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { skipped.push(`${relative(root, directory)}: unreadable directory`); return true }
  for (const entry of entries) {
    if (--budget.remaining < 0) { skipped.push('directory entry limit reached; narrow path'); return false }
    const full = join(directory, entry.name)
    const rel = relative(root, full).replace(/\\/g, '/')
    if (isSecretPath(rel)) { skipped.push('secret path'); continue }
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) { skipped.push(`${rel}: excluded directory`); continue }
      if (!await walk(root, full, visit, skipped, budget)) return false
    } else if (entry.isFile()) {
      if (!await visit(full)) return false
    } else skipped.push(`${rel}: symlink or nonregular entry`)
  }
  return true
}

export const analysisScratchPath = (workspace: string, taskId: string): string => '.conductor-scratch/' + createHash('sha256').update(workspace + '\0' + taskId).digest('hex').slice(0, 24)

/** The interpreter a saved script's extension names, for a run_command that gives none. */
export const scriptRuntime = (path: string): 'python3' | 'node' | 'bash' | undefined => /\.py$/i.test(path) ? 'python3' : /\.(?:mjs|cjs|js)$/i.test(path) ? 'node' : /\.sh$/i.test(path) ? 'bash' : undefined

const artifactOwner = (context: ToolContext): string => `${context.workspace}\0${context.analysis?.taskId ?? context.taskId ?? context.sandbox?.name ?? "unscoped"}`

/** Dispatch one tool call. Every path is canonicalized inside the workspace before it is
 *  touched, every command goes to the container, and any refusal is returned to the model as a
 *  tool result rather than ending the turn: a denied capability is information the model can
 *  work with, and the denial itself is not negotiable. */
export async function runTool(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutcome> {
  try {
    if (context.analysis && !context.analysisScratch) context = { ...context, analysisScratch: analysisScratchPath(context.workspace, context.analysis.taskId) }
    assertToolAllowed(name, context.readOnly, context.grants ?? NO_GRANTS, context.scope ?? 'full')
    context.signal?.throwIfAborted()
    const args = argumentsOf(rawArguments)
    const window = context.readWindow ?? DEFAULT_READ_WINDOW
    const writable = async (requested: string): Promise<{ path: string; relative: string }> => {
      const resolved = await resolveWritablePath(context.workspace, requested)
      if (context.analysisScratch) {
        const scratch = await resolveWritablePath(context.workspace, context.analysisScratch)
        if (scratch.relative === '.') throw new ToolPolicyError('Analysis scratch must be a task subdirectory')
        const inside = relative(scratch.path, resolved.path).replace(/\\/g, '/')
        if (inside === '..' || inside.startsWith('../') || inside.startsWith('/') || /^[A-Za-z]:/.test(inside)) throw new ToolPolicyError(`Analysis source is read-only; writes are allowed only inside the task scratch directory ${context.analysisScratch}/ (you named ${resolved.relative})`)
      } else if (context.analysis) throw new ToolPolicyError('Analysis source is read-only; use run_command code for task-owned scratch diagnostics')
      if (!pathAllowed(context.contract, resolved.relative)) throw new ToolPolicyError(`${resolved.relative} is outside the paths this task may change (${context.contract!.allowedPaths!.join(', ')})`)
      return resolved
    }
    switch (name) {
      case 'conductor': {
        const method = text(args.method, 'method')
        if (!context.control) throw new ToolPolicyError('Conductor project bridge is unavailable')
        const input = args.args
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ToolPolicyError('args must be an object')
        assertLocalControlAllowed(method, input as Record<string, unknown>, context.readOnly)
        return { output: JSON.stringify(await context.control(method, input as Record<string, unknown>)).slice(0, 24_000), failed: false, paths: [] }
      }
      case 'web_read': return { output: await readPublicWeb(text(args.url, 'url'), context.signal), failed: false, paths: [] }
      case 'web_search': return { output: await searchPublicWeb(text(args.query, 'query'), context.signal, args.limit === undefined ? 10 : integer(args.limit, 10)), failed: false, paths: [] }
      case 'read_file': {
        if (args.artifact !== undefined) return { output: (context.artifacts ?? defaultResultStore).read(artifactOwner(context), text(args.artifact, 'artifact'), integer(args.byte_offset, 0), integer(args.byte_limit, 4096)), failed: false, paths: [] }
        const { path } = await resolveInWorkspace(context.workspace, text(args.path, 'path'))
        if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 1)) throw new ToolPolicyError('offset must be a positive 1-based line number; negative offsets are not supported')
        let evidence: LocalFileEvidence | undefined
        const output = await boundedFile(path, { mode: args.mode === undefined ? 'lines' : text(args.mode, 'mode'), offset: args.offset === undefined ? 1 : Number(args.offset), limit: Math.max(1, Math.min(integer(args.limit, window.defaultLines), window.maxLines)), byteOffset: args.byte_offset === undefined ? 0 : Number(args.byte_offset), byteLimit: args.byte_limit === undefined ? 4096 : Number(args.byte_limit), signal: context.signal, evidence: value => { evidence = value } })
        return { output, failed: false, paths: [path], evidence }
      }
      case 'list_files': {
        const { path, relative: rel } = await resolveInWorkspace(context.workspace, args.path === undefined ? '.' : text(args.path, 'path'))
        const entries = await readdir(path, { withFileTypes: true })
        const visible = entries
          .filter(entry => !isSecretPath(rel === '.' ? entry.name : `${rel}/${entry.name}`))
          .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
          .sort()
        return { output: visible.join('\n') || '(empty directory)', failed: false, paths: [] }
      }
      case 'search': {
        const pattern = text(args.pattern, 'pattern')
        if (pattern.length > 400) throw new ToolPolicyError('pattern is too long')
        try { new RegExp(pattern, 'g') } catch { throw new ToolPolicyError('pattern is not a valid regular expression') }
        const suffix = args.glob === undefined ? '' : text(args.glob, 'glob')
        const { path: root } = await resolveInWorkspace(context.workspace, args.path === undefined ? '.' : text(args.path, 'path'))
        const hits: string[] = []
        const skipped: string[] = []; let scanned = 0
        const searchStarted = Date.now()
        const visit = async (file: string): Promise<boolean> => {
          context.signal?.throwIfAborted()
          if (Date.now() - searchStarted > 1500) { skipped.push('search time budget reached; narrow path/pattern'); return false }
          if (scanned >= 2000) { skipped.push('file count limit reached'); return false }
          file = (await resolveInWorkspace(context.workspace, relative(context.workspace, file))).path
          if (suffix && !file.endsWith(suffix)) { skipped.push(`${relative(context.workspace, file)}: suffix filter`); return true }
          const info = await stat(file)
          if (info.size > MAX_READ_BYTES) { skipped.push(`${relative(context.workspace, file)}: exceeds 8 MiB; use read_file inspect/bytes`); return true }
          let content: string
          try { content = await readFile(file, 'utf8') } catch { skipped.push(`${relative(context.workspace, file)}: unreadable`); return true }
          scanned++
          if (content.includes('\0') || content.includes('\uFFFD')) { skipped.push(`${relative(context.workspace, file)}: binary or invalid UTF-8; use read_file inspect/bytes`); return true }
          const rel = relative(context.workspace, file).replace(/\\/g, '/')
          const found = boundedSearch(content, pattern, MAX_SEARCH_HITS - hits.length)
          for (const hit of found.hits) hits.push(`${rel}:${hit.line}:${hit.column}: ${hit.excerpt}`)
          if (found.skippedCount) skipped.push(`${rel}: ${found.skippedCount} lines exceed 16 KiB regex limit (first lines: ${found.skippedLines.join(', ')}); use read_file bytes or a saved streaming script`)
          if (found.timedOut) { skipped.push(`${rel}: regex exceeded 25 ms; file coverage unknown; simplify pattern or use a saved script`); return false }
          if (found.stopped) { skipped.push(`${rel}: hit/line scan limit; narrow pattern or read a range`); return false }
          return true
        }
        const complete = (await stat(root)).isFile() ? await visit(root) : await walk(context.workspace, root, visit, skipped)
        return { output: `[search: scanned_files=${scanned}; hits=${hits.length}; coverage=${complete && !skipped.length ? 'complete' : 'partial'}; skipped=${skipped.length}; hit_limit=${MAX_SEARCH_HITS}]\n${hits.join('\n') || 'no matches in searched coverage'}\n${skipped.slice(0, 30).join('\n')}${skipped.length > 30 ? '\nFurther skip details omitted' : ''}${!complete ? '\nSearch stopped at limit; narrow path/pattern.' : ''}`, failed: false, paths: [] }
      }
      case 'write_file': {
        const content = text(args.content, 'content')
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolPolicyError('content exceeds the 1 MiB write limit')
        const { path, relative: rel } = await writable(text(args.path, 'path'))
        const previous = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        const revision = context.analysisScratch ? await readFile(path, 'utf8').then(content => (context.artifacts ?? defaultResultStore).save(artifactOwner(context), content), error => { if (error.code === 'ENOENT') return undefined; throw error }) : undefined
        await context.beforeTool?.([path])
        context.signal?.throwIfAborted()
        const current = await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        if (previous === null ? current !== null : current === null || !previous.equals(current)) return { output: `File changed externally; nothing written. ${staleEvidence(current?.toString('utf8') ?? '')}`, failed: true, paths: [] }
        await mkdir(join(path, '..'), { recursive: true })
        context.signal?.throwIfAborted()
        if (args.append === true) {
          const existing = await stat(path).then(info => info.size, () => 0)
          if (existing + Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolPolicyError('the file would exceed the 1 MiB write limit')
          await appendFile(path, content, 'utf8')
        } else await writeFile(path, content, 'utf8')
        await context.afterTool?.([path], true)
        return { output: `${args.append === true ? 'appended to' : 'wrote'} ${rel} (${content.length} characters)${revision ? `; previous revision artifact=${revision}` : ""}`, failed: false, paths: [path] }
      }
      case 'edit_file': {
        const oldText = text(args.old_text, 'old_text')
        const newText = text(args.new_text, 'new_text')
        const { path, relative: rel } = await writable(text(args.path, 'path'))
        const before = await readFile(path, 'utf8')
        const occurrences = before.split(oldText).length - 1
        if (!oldText) throw new ToolPolicyError('old_text must not be empty')
        if (!occurrences) return { output: `old_text was not found in ${rel}; ${staleEvidence(before)}`, failed: true, paths: [] }
        if (occurrences > 1 && args.replace_all !== true) return { output: `old_text appears ${occurrences} times in ${rel}; pass replace_all or use a longer unique snippet`, failed: true, paths: [] }
        const revision = context.analysisScratch ? (context.artifacts ?? defaultResultStore).save(artifactOwner(context), before) : undefined
        await context.beforeTool?.([path])
        context.signal?.throwIfAborted()
        if (await readFile(path, 'utf8') !== before) return { output: `File changed externally; nothing written. ${staleEvidence(await readFile(path, 'utf8'))}`, failed: true, paths: [] }
        await writeFile(path, args.replace_all === true ? before.split(oldText).join(newText) : before.replace(oldText, () => newText), 'utf8')
        await context.afterTool?.([path], true)
        return { output: `edited ${rel} (${occurrences} replacement${occurrences === 1 ? '' : 's'})${revision ? `; previous revision artifact=${revision}` : ''}`, failed: false, paths: [path] }
      }
      case 'apply_edits': {
        if (!Array.isArray(args.edits) || !args.edits.length || args.edits.length > 40) throw new ToolPolicyError('edits must be a list of 1 to 40 {old_text, new_text} objects')
        const edits = args.edits.map((edit, index) => {
          if (!edit || typeof edit !== 'object' || Array.isArray(edit)) throw new ToolPolicyError(`edits[${index}] must be an object`)
          const entry = edit as Record<string, unknown>
          const oldText = text(entry.old_text, `edits[${index}].old_text`), newText = text(entry.new_text, `edits[${index}].new_text`)
          if (!oldText) throw new ToolPolicyError(`edits[${index}].old_text must not be empty`)
          return { oldText, newText }
        })
        const { path, relative: rel } = await writable(text(args.path, 'path'))
        const original = await readFile(path, 'utf8')
        let content = original
        const status: string[] = []
        // Every anchor is checked against the file as it stands after the previous edits, so
        // edits apply in order, and one failure leaves the file untouched.
        for (const [index, edit] of edits.entries()) {
          const occurrences = content.split(edit.oldText).length - 1
          if (occurrences !== 1) {
            status.push(`edit ${index + 1}: ${occurrences === 0 ? 'old_text not found' : `old_text appears ${occurrences} times`}`)
            return { output: `failed: nothing written to ${rel}. ${status.join('; ')}. ${index} earlier edit${index === 1 ? '' : 's'} matched but were not applied either; ${staleEvidence(original)}`, failed: true, paths: [] }
          }
          content = content.replace(edit.oldText, () => edit.newText)
          status.push(`edit ${index + 1}: ok`)
        }
        const revision = context.analysisScratch ? (context.artifacts ?? defaultResultStore).save(artifactOwner(context), original) : undefined
        await context.beforeTool?.([path])
        context.signal?.throwIfAborted()
        if (await readFile(path, 'utf8') !== original) return { output: `File changed externally; nothing written. ${staleEvidence(await readFile(path, 'utf8'))}`, failed: true, paths: [] }
        await writeFile(path, content, 'utf8')
        await context.afterTool?.([path], true)
        return { output: `applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${rel} (${status.join('; ')})${revision ? `; previous revision artifact=${revision}` : ''}`, failed: false, paths: [path] }
      }
      case 'run_command': {
        const forms = ['command', 'code', 'script'].filter(key => args[key] !== undefined)
        if (forms.length !== 1) throw new ToolPolicyError(`Provide exactly one of command, code or script (this call had ${forms.length ? forms.join(' and ') : 'none of them'}). Nothing ran. Examples: {"command":"node scratch/match.mjs"}, {"script":"scratch/match.mjs","runtime":"node"}, {"code":"console.log(1)","runtime":"node"}.`)
        const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'"
        const cwd = await resolveInWorkspace(context.workspace, args.cwd === undefined ? '.' : text(args.cwd, 'cwd'))
        if (!(await stat(cwd.path)).isDirectory()) throw new ToolPolicyError('cwd must be a directory')
        // A saved script names its own interpreter by extension when the call does not; `bash
        // match.mjs` would only ever fail in a way the model cannot read.
        const inferred = forms[0] === 'script' && args.runtime === undefined ? scriptRuntime(text(args.script, 'script')) : undefined
        const runtime = args.runtime === undefined ? inferred ?? 'bash' : text(args.runtime, 'runtime')
        if (!['python3', 'python', 'node', 'bash'].includes(runtime)) throw new ToolPolicyError('runtime must be python3, python, node or bash')
        if (args.args !== undefined && (!Array.isArray(args.args) || args.args.some(value => typeof value !== 'string' || value.includes('\0')))) throw new ToolPolicyError('args must be strings without NUL bytes')
        let command: string, scriptArtifact: string | undefined
        if (forms[0] === 'command') {
          command = text(args.command, 'command')
          // A runtime beside a shell command is accepted when the command already starts with that
          // interpreter (the two agree, as in {"command":"node x.mjs","runtime":"node"}); a runtime
          // the command does not start with would silently change what runs, so it is refused with
          // the forms that do say what the model means. Extra `args` are appended quoted rather
          // than dropped: the model asked for them.
          if (runtime !== 'bash') {
            const first = command.trim().split(/\s+/)[0] ?? ''
            const binary = first.replace(/^.*\//, '')
            const agrees = binary === runtime || (runtime.startsWith('python') && /^python3?$/.test(binary))
            if (!agrees) throw new ToolPolicyError(`command is literal bash shell text, and runtime ${runtime} does not match its first word "${first}", so nothing ran. Either drop runtime, or run a saved workspace file with {"script":"<workspace path>","runtime":"${runtime}"} (a .py file needs python3, a .mjs/.cjs/.js file needs node), or supply inline code with {"code":"...","runtime":"${runtime}"}.`)
          }
          if (Array.isArray(args.args) && args.args.length) command += ' ' + (args.args as string[]).map(quote).join(' ')
        } else {
          let script: string, setup = ''
          if (forms[0] === 'code') {
            const code = text(args.code, 'code')
            if (Buffer.byteLength(code) > 12 * 1024) throw new ToolPolicyError('code exceeds the 12 KiB inline-script limit; use a workspace script path for larger programs')
            scriptArtifact = (context.artifacts ?? defaultResultStore).save(artifactOwner(context), code)
            const extension = runtime.startsWith('python') ? '.py' : runtime === 'node' ? '.cjs' : '.sh'
            if (context.analysisScratch) {
              const scratch = await writable(context.analysisScratch + '/script-' + randomUUID() + extension)
              await mkdir(join(scratch.path, '..'), { recursive: true })
              await writeFile(scratch.path, code, { flag: 'wx' })
              script = '/workspace/' + scratch.relative
            } else {
              script = '/tmp/conductor-script-' + randomUUID() + extension
              setup = 'printf %s ' + quote(Buffer.from(code).toString('base64')) + ' | base64 -d > ' + quote(script) + ' && '
            }
          } else {
            const source = await resolveInWorkspace(context.workspace, text(args.script, 'script'))
            if ((await stat(source.path)).size > MAX_WRITE_BYTES) throw new ToolPolicyError('Saved script exceeds the 1 MiB diagnostic snapshot limit')
            scriptArtifact = (context.artifacts ?? defaultResultStore).save(artifactOwner(context), await readFile(source.path, 'utf8'))
            script = '/workspace/' + source.relative
          }
          command = setup + runtime + ' ' + quote(script) + ' ' + ((args.args ?? []) as string[]).map(quote).join(' ')
        }
        assertNoPackageInstall(command)
        // The container has no network and never sees the owner's credentials, so a push can
        // only run on the host. With the repository grant on, one is brokered there under the
        // checks in git-push.ts; without it, the refusal says so rather than letting the model
        // watch git fail obscurely inside the sandbox.
        if (mentionsGitPush(command)) {
          if (context.analysis || context.analysisScratch) throw new ToolPolicyError('Analysis source is read-only; repository mutation is unavailable')
          if (!(context.grants ?? NO_GRANTS).git) throw new ToolPolicyError('Tool denied by policy: pushing needs repository writes turned on for this conversation')
          const pushed = await brokeredGitPush(context.workspace, command, context.signal)
          return { ...pushed, paths: [] }
        }
        if (!context.sandbox) throw new SandboxUnavailableError('Sandbox unavailable: command execution is disabled without the Docker sandbox')
        if (context.analysisScratch) {
          const scratch = await resolveWritablePath(context.workspace, context.analysisScratch)
          if (scratch.relative === '.') throw new ToolPolicyError('Analysis scratch must be a task subdirectory')
          await mkdir(scratch.path, { recursive: true })
          context.sandbox.setAnalysisAccess(scratch.relative)
        } else context.sandbox.setAnalysisMode?.(!!context.analysis)
        const marker = '__CONDUCTOR_PAYLOAD_' + randomUUID().replace(/-/g, '') + '__'
        const execution = `cd ${quote('/workspace/' + cwd.relative)} || exit 125; printf 'environment: os=Linux sandbox=Docker cwd=%s runtime=%s\n' "$PWD" "$(command -v ${runtime} || printf unavailable)"; ${runtime} --version 2>&1; printf '\\n${marker}\\n'; printf '\\n${marker}\\n' >&2; ` + command
        const result = await context.sandbox.exec(execution, Math.max(1, Math.min(integer(args.timeout_sec, context.timeoutSec), context.timeoutSec)), context.signal)
        const payload = splitExecutionEnvelope(result.stdout, result.stderr, marker)
        const environment = `[environment: ${JSON.stringify({ discovery: payload.environment.slice(0, 1024), stderr: payload.environmentStderr.slice(0, 1024), truncated: payload.environment.length > 1024 || payload.environmentStderr.length > 1024 })}]`
        const metadata = `[execution: payload_started=${payload.payloadStarted}; stdout_empty=${payload.payloadStarted ? payload.stdout.length === 0 : "unknown"}; stderr_empty=${payload.payloadStarted ? payload.stderr.length === 0 : "unknown"}; exit_code=${result.exitCode}; timed_out=${result.timedOut}; cancelled=${result.cancelled ?? false}; truncated=${result.truncated}; duration_ms=${result.durationMs}; source_read_only=${!!(context.analysis || context.analysisScratch)}]`
        const full = `${metadata}\n${environment}\nstdout:\n${payload.stdout}\nstderr:\n${payload.stderr}`
        const artifact = (context.artifacts ?? defaultResultStore).save(artifactOwner(context), full)
        const parts = [
          `${metadata}\n${environment}\n[result_artifact: id=${artifact}; read_file artifact=${artifact} byte_offset=0 byte_limit=4096; retained_output=${result.truncated ? 'partial: execution output cap reached' : 'complete'}]${scriptArtifact ? `\n[script_artifact: id=${scriptArtifact}]` : ''}`,
          `stdout:\n${payload.stdout}`,
          `stderr:\n${payload.stderr}`,
          result.timedOut ? 'command exceeded its time limit and was terminated' : '',
          result.truncated ? 'output was truncated at the sandbox limit' : '',
          `exit code: ${result.exitCode}`
        ].filter(Boolean)
        return { output: parts.join('\n\n'), failed: result.exitCode !== 0 || !payload.payloadStarted, paths: [], exitCode: result.exitCode }
      }
      default:
        throw new ToolPolicyError(`Tool denied by policy: ${name}`)
    }
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) return { output: `denied: path outside workspace (${error.message})`, failed: true, paths: [] }
    if (error instanceof SecretPathError) return { output: `denied: ${error.message}`, failed: true, paths: [] }
    if (error instanceof SandboxPolicyError) return { output: `denied: ${error.message}`, failed: true, paths: [] }
    if (error instanceof ToolPolicyError) return { output: `denied: ${error.message}`, failed: true, paths: [] }
    if (error instanceof SandboxUnavailableError) return { output: `denied: ${error.message}`, failed: true, paths: [] }
    return { output: `error: ${error instanceof Error ? error.message : 'tool failed'}`, failed: true, paths: [] }
  }
}
