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
export const LOCAL_CONTROL_METHODS = ['memory.recall', 'memory.remember', 'tasks.list', 'tasks.update', 'agents.list', 'agents.snapshot', 'agents.status', 'app.update', 'app.update.status'] as const
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
        : method === 'agents.snapshot' || method === 'agents.status' ? ['agentSessionId'] : []
  if (Object.keys(args).some(key => !fields.includes(key))) throw new ToolPolicyError('Conductor scope and unsupported arguments cannot be overridden')
}

export function assertToolAllowed(name: string, readOnly: boolean, grants: LocalGrants = NO_GRANTS, scope: ToolScope = 'full'): asserts name is LocalToolName {
  if (!(LOCAL_TOOLS as readonly string[]).includes(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is not available to local models`)
  if (readOnly && MUTATING.has(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is unavailable in read-only mode`)
  if (scope === 'coding' && !CODING_SCOPE_TOOLS.has(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is not part of this bounded coding task`)
  if (name === 'web_search' && !grants.research) throw new ToolPolicyError('Tool denied by policy: web_search needs deep research turned on for this conversation')
}

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_SEARCH_HITS = 200
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.venv', 'venv', '__pycache__', '.next', 'target'])

export function toolSpecs(readOnly: boolean, control = false, grants: LocalGrants = NO_GRANTS, scope: ToolScope = 'full', window: ReadWindow = DEFAULT_READ_WINDOW): ToolSpec[] {
  const specs: ToolSpec[] = [
    { type: 'function', function: { name: 'read_file', description: `Read a UTF-8 text file from the workspace. Returns at most ${window.defaultLines} lines unless limit is given (never more than ${window.maxLines}); the first line reports total_lines and the range returned, so read a large file in the ranges you need, or use search to find the lines first.`, parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path, for example src/main/index.ts' }, offset: { type: 'integer', description: 'First line to return (1-based).' }, limit: { type: 'integer', description: 'Maximum number of lines to return.' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List the entries of a workspace directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative directory; defaults to the workspace root.' } } } } },
    { type: 'function', function: { name: 'search', description: 'Search workspace file contents with a regular expression.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript regular expression.' }, path: { type: 'string', description: 'Workspace-relative directory to search.' }, glob: { type: 'string', description: 'Only search files whose name ends with this suffix, for example .ts' } }, required: ['pattern'] } } }
  ]
  if (scope === 'coding') return readOnly ? specs : [...specs, ...writeSpecs(grants)]
  if (grants.research) specs.push({ type: 'function', function: { name: 'web_search', description: 'Search the public web and get back a numbered list of result titles and HTTPS links. Read the promising ones with web_read. Search as many times as the question needs, with different wordings; only the query text leaves this machine, so never put private workspace content in it.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', description: 'How many results to return, 1 to 25. Defaults to 10.' } }, required: ['query'] } } })
  specs.push({ type: 'function', function: { name: 'web_read', description: 'GET a public HTTPS text page for research without inherited credentials or cookies. Private/local addresses are refused; shell networking stays disabled. URL paths and queries leave this machine: never include private workspace content.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } })
  if (control) specs.push({ type: 'function', function: { name: 'conductor', description: 'Access durable project memory, the project task checklist, and the other visible conversations through Conductor. memory.remember accepts gist, kind (semantic, episodic, procedural), cues (string array); memory.recall accepts query; use these to save memory, never a filesystem path. tasks.list takes no arguments and returns the tasks plus the revision to quote back. tasks.update accepts revision (from the tasks.list you just read), id, and any of status (todo, doing, done), title, priority (high, normal, low). agents.list takes no arguments and returns the agentSessionId of every visible conversation; agents.snapshot requires one of those exact agentSessionId values and returns that conversation\'s state. app.update takes no arguments and builds this checkout into a local update the installed Conductor then offers as "Update pending" — use it when the owner asks to update the app via the updater; the owner confirms the build unless another coworker already authorized this conversation, and it returns immediately, so poll app.update.status (no arguments) every minute or so until it is no longer running. Nothing is installed for the owner.', parameters: { type: 'object', properties: { method: { type: 'string', enum: LOCAL_CONTROL_METHODS.filter(method => !readOnly || !MUTATING_CONTROL.has(method)) }, args: { type: 'object' } }, required: ['method', 'args'] } } })
  if (readOnly) return specs
  return [...specs, ...writeSpecs(grants)]
}

function writeSpecs(grants: LocalGrants): ToolSpec[] {
  return [
    { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a workspace file. With append: true the content is added to the end of the file instead, creating it if needed. One call can only carry a few thousand tokens, so write a large file in parts: the first part plainly, then each further part with append: true.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'edit_file', description: 'Replace an exact string in a workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] } } },
    { type: 'function', function: { name: 'apply_edits', description: 'Apply several exact replacements to one workspace file in a single call, atomically: every old_text must occur exactly once in the current file, or nothing is written and the result says which edit failed. Use this instead of one edit_file per change when a task lists several exact edits.', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['old_text', 'new_text'] }, description: 'Up to 40 replacements, applied in order.' } }, required: ['path', 'edits'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Run a shell command inside the isolated Linux sandbox container. The workspace is mounted at /workspace. There is no network access. npm, npx, yarn, pnpm and bun installs are refused: with no network they can only destroy the dependency tree that is already there. Run installed binaries directly instead, for example `node ./node_modules/typescript/bin/tsc --noEmit` or `./node_modules/.bin/vitest run <file>`.' + (grants.git ? ' Git is writable in this conversation: commit and branch locally as you work. `git push` works too, but it is run for you on the host, because the container has no network: send it as a command of its own, with at most an existing remote and the branch you are on. Force, delete and other push flags stay refused.' : ' The .git directory is read-only: git log and git diff work, git commit does not.'), parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_sec: { type: 'integer' } }, required: ['command'] } } }
  ]
}

export interface ToolContext {
  workspace: string
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

export interface ToolOutcome { output: string; failed: boolean; paths: string[]; exitCode?: number }

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

async function walk(root: string, directory: string, visit: (path: string) => Promise<boolean>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(directory, entry.name)
    const rel = relative(root, full).replace(/\\/g, '/')
    if (isSecretPath(rel)) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      await walk(root, full, visit)
    } else if (entry.isFile()) {
      if (!await visit(full)) return
    }
  }
}

/** Dispatch one tool call. Every path is canonicalized inside the workspace before it is
 *  touched, every command goes to the container, and any refusal is returned to the model as a
 *  tool result rather than ending the turn: a denied capability is information the model can
 *  work with, and the denial itself is not negotiable. */
export async function runTool(name: string, rawArguments: string, context: ToolContext): Promise<ToolOutcome> {
  try {
    assertToolAllowed(name, context.readOnly, context.grants ?? NO_GRANTS, context.scope ?? 'full')
    context.signal?.throwIfAborted()
    const args = argumentsOf(rawArguments)
    const window = context.readWindow ?? DEFAULT_READ_WINDOW
    const writable = async (requested: string): Promise<{ path: string; relative: string }> => {
      const resolved = await resolveWritablePath(context.workspace, requested)
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
        const { path, relative: rel } = await resolveInWorkspace(context.workspace, text(args.path, 'path'))
        const info = await stat(path)
        if (!info.isFile()) return { output: `${rel} is not a file`, failed: true, paths: [] }
        if (info.size > MAX_READ_BYTES) return { output: `${rel} is ${info.size} bytes; read a smaller file or use search`, failed: true, paths: [] }
        const content = await readFile(path, 'utf8')
        // Offset is positive and 1-based (not a byte position or negative tail index).
        // Document this in results/errors without changing the cache-stable tool schema.
        if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 1)) throw new ToolPolicyError('offset must be a positive 1-based line number; negative offsets are not supported')
        const offset = Math.max(1, integer(args.offset, 1))
        const limit = Math.max(1, Math.min(integer(args.limit, window.defaultLines), window.maxLines))
        const lines = content.split('\n').slice(offset - 1, offset - 1 + limit)
        const totalLines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
        const first = offset <= totalLines ? offset : 0
        const last = first ? Math.min(totalLines, offset + limit - 1) : 0
        const truncated = totalLines > 0 && (first !== 1 || last !== totalLines)
        const hint = truncated && last < totalLines ? `; next range: offset=${last + 1}` : ''
        const metadata = `[read_file: total_lines=${totalLines}; returned_lines=${first}-${last}; truncated=${truncated}${hint}; offset is a positive 1-based line number]\n`
        return { output: metadata + (lines.join('\n') || (totalLines ? '(no lines in requested range)' : '(empty file)')), failed: false, paths: [path] }
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
        let expression: RegExp
        try { expression = new RegExp(pattern, 'g') } catch { throw new ToolPolicyError('pattern is not a valid regular expression') }
        const suffix = args.glob === undefined ? '' : text(args.glob, 'glob')
        const { path: root } = await resolveInWorkspace(context.workspace, args.path === undefined ? '.' : text(args.path, 'path'))
        const hits: string[] = []
        await walk(context.workspace, root, async file => {
          if (suffix && !file.endsWith(suffix)) return true
          const info = await stat(file)
          if (info.size > MAX_READ_BYTES) return true
          let content: string
          try { content = await readFile(file, 'utf8') } catch { return true }
          const rel = relative(context.workspace, file).replace(/\\/g, '/')
          const lines = content.split('\n')
          for (let index = 0; index < lines.length; index++) {
            expression.lastIndex = 0
            if (!expression.test(lines[index]!)) continue
            hits.push(`${rel}:${index + 1}: ${lines[index]!.slice(0, 300)}`)
            if (hits.length >= MAX_SEARCH_HITS) return false
          }
          return true
        })
        return { output: hits.join('\n') || 'no matches', failed: false, paths: [] }
      }
      case 'write_file': {
        const content = text(args.content, 'content')
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolPolicyError('content exceeds the 1 MiB write limit')
        const { path, relative: rel } = await writable(text(args.path, 'path'))
        await context.beforeTool?.([path])
        context.signal?.throwIfAborted()
        await mkdir(join(path, '..'), { recursive: true })
        context.signal?.throwIfAborted()
        if (args.append === true) {
          const existing = await stat(path).then(info => info.size, () => 0)
          if (existing + Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolPolicyError('the file would exceed the 1 MiB write limit')
          await appendFile(path, content, 'utf8')
        } else await writeFile(path, content, 'utf8')
        await context.afterTool?.([path], true)
        return { output: `${args.append === true ? 'appended to' : 'wrote'} ${rel} (${content.length} characters)`, failed: false, paths: [path] }
      }
      case 'edit_file': {
        const oldText = text(args.old_text, 'old_text')
        const newText = text(args.new_text, 'new_text')
        const { path, relative: rel } = await writable(text(args.path, 'path'))
        const before = await readFile(path, 'utf8')
        const occurrences = before.split(oldText).length - 1
        if (!occurrences) return { output: `old_text was not found in ${rel}`, failed: true, paths: [] }
        if (occurrences > 1 && args.replace_all !== true) return { output: `old_text appears ${occurrences} times in ${rel}; pass replace_all or use a longer unique snippet`, failed: true, paths: [] }
        await context.beforeTool?.([path])
        context.signal?.throwIfAborted()
        await writeFile(path, args.replace_all === true ? before.split(oldText).join(newText) : before.replace(oldText, newText), 'utf8')
        await context.afterTool?.([path], true)
        return { output: `edited ${rel} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`, failed: false, paths: [path] }
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
        let content = await readFile(path, 'utf8')
        const status: string[] = []
        // Every anchor is checked against the file as it stands after the previous edits, so
        // edits apply in order, and one failure leaves the file untouched.
        for (const [index, edit] of edits.entries()) {
          const occurrences = content.split(edit.oldText).length - 1
          if (occurrences !== 1) {
            status.push(`edit ${index + 1}: ${occurrences === 0 ? 'old_text not found' : `old_text appears ${occurrences} times`}`)
            return { output: `failed: nothing written to ${rel}. ${status.join('; ')}. ${index} earlier edit${index === 1 ? '' : 's'} matched but were not applied either; fix this anchor (it must occur exactly once in the current file) and send the whole call again.`, failed: true, paths: [] }
          }
          content = content.replace(edit.oldText, () => edit.newText)
          status.push(`edit ${index + 1}: ok`)
        }
        await context.beforeTool?.([path])
        context.signal?.throwIfAborted()
        await writeFile(path, content, 'utf8')
        await context.afterTool?.([path], true)
        return { output: `applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${rel} (${status.join('; ')})`, failed: false, paths: [path] }
      }
      case 'run_command': {
        const command = text(args.command, 'command')
        assertNoPackageInstall(command)
        // The container has no network and never sees the owner's credentials, so a push can
        // only run on the host. With the repository grant on, one is brokered there under the
        // checks in git-push.ts; without it, the refusal says so rather than letting the model
        // watch git fail obscurely inside the sandbox.
        if (mentionsGitPush(command)) {
          if (!(context.grants ?? NO_GRANTS).git) throw new ToolPolicyError('Tool denied by policy: pushing needs repository writes turned on for this conversation')
          const pushed = await brokeredGitPush(context.workspace, command, context.signal)
          return { ...pushed, paths: [] }
        }
        if (!context.sandbox) throw new SandboxUnavailableError('Sandbox unavailable: command execution is disabled without the Docker sandbox')
        const result = await context.sandbox.exec(command, Math.max(1, Math.min(integer(args.timeout_sec, context.timeoutSec), context.timeoutSec)), context.signal)
        const parts = [
          result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
          result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
          result.timedOut ? 'command exceeded its time limit and was terminated' : '',
          result.truncated ? 'output was truncated at the sandbox limit' : '',
          `exit code: ${result.exitCode}`
        ].filter(Boolean)
        return { output: parts.join('\n\n'), failed: result.exitCode !== 0, paths: [], exitCode: result.exitCode }
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
