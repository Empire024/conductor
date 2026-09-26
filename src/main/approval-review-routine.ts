import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { describeGrantRequest } from '../shared/permission-grants'
import type { Json } from '../shared/structured-agent'
import type { ReviewAction } from './approval-review'
import { commandText } from './approval-review-rules'
import { ownerOnlyEscalation } from './providers/codex'

/**
 * Routine in-workspace actions (review-cost-bounded, owner 2026-09-26: "stop this LEAK"): what a
 * worker in Auto would simply run is answered for a reviewed Ask-mode coworker without paying a
 * stronger-model review, and journaled as an automatic allow. The list is an allowlist and
 * deliberately short; anything not on it still goes to the (reused) reviewer:
 *
 * - Write, Edit, MultiEdit, NotebookEdit of one file inside a version-controlled workspace (so
 *   the owner sees and can revert every such edit in git), after the gate's realpath containment
 *   and protected-path checks, except files that configure tools, CI, hooks or credentials
 *   (.github, .vscode, .idea, .husky, .devcontainer, .env*, .npmrc, .yarnrc*, .git*).
 * - Read-only git: status, diff, log, show, blame, ls-files, rev-parse, describe, shortlog, grep;
 *   branch/tag/remote only listing; stash list. No global options, and no flag that writes a file,
 *   runs a program or reads outside the repository (--output, -O, --ext-diff, --no-index, --exec).
 * - The project's own test, build, lint, typecheck and check scripts through npm, pnpm or yarn
 *   (`npm test`, `npm run lint`, extra arguments only after `--`), when package.json defines the
 *   script and neither it nor its pre/post script reaches the network, installs, publishes,
 *   deletes or crosses an owner-only boundary.
 * - `npx` of a locally installed tsc, vitest, eslint, prettier or jest (never a download).
 *
 * Every command must be one simple command: no chaining, pipes, redirection, substitution,
 * variables, quotes, globs, `~`, absolute paths, `..` segments or URLs. The caller has already
 * made owner ask rules, owner-only reaches and read-only/plan sessions non-routine (boundary).
 */
const EDIT = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Workspace files that configure CI, editors, hooks, the package manager or credentials. */
const SENSITIVE_FILE = /(?:^|\/)(?:\.github|\.vscode|\.idea|\.husky|\.devcontainer)(?:\/|$)|(?:^|\/)(?:\.env[^/]*|\.npmrc|\.yarnrc[^/]*|\.pnpmfile\.cjs|\.git[^/]*)$/i
/** One plain word of a simple command: no quoting, variables, globs, home, pipes or grouping. */
const SAFE_TOKEN = /^[A-Za-z0-9_.,:=+/\\-]+$/
const BASH_KEYS = new Set(['command', 'description', 'timeout', 'run_in_background'])
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'describe', 'shortlog', 'grep'])
/** Git flags that write a file, start another program, or read outside the repository. */
const GIT_UNSAFE_FLAG = /^(?:--output|--open-files-in-pager|-O|--ext-diff|--no-index|--exec|--upload-pack|--receive-pack|--config|-c$)/
const GIT_LIST_FLAGS: Record<string, Set<string>> = {
  branch: new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--list', '--show-current', '--no-color']),
  tag: new Set(['-l', '--list']),
  remote: new Set(['-v', '--verbose'])
}
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn'])
const PROJECT_SCRIPT = /^(?:test|build|lint|typecheck|type-check|check)(?::[\w.-]+)?$/i
/** What a project script may not do and still be routine: install, publish or fetch. */
const SCRIPT_UNSAFE = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|publish|update|upgrade|login|adduser|exec|dlx|x)\b|\bnpx\s+-|\bpnpx\b|\bgit\s+(?:push|clone|fetch|pull|remote|config|commit|reset|clean|checkout)\b|https?:\/\//i
const LOCAL_BINS = new Set(['tsc', 'vitest', 'eslint', 'prettier', 'jest'])
const object = (value: unknown): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {}

/** A command word that names a path must stay inside the workspace lexically. */
const safeWord = (word: string): boolean => SAFE_TOKEN.test(word) && !/^[\\/]/.test(word) && !/^[a-z]:/i.test(word) && !/(?:^|[\\/=])\.\.(?:[\\/]|$)/.test(word) && !word.includes('://')
const program = (word: string) => word.toLowerCase().replace(/\.(?:exe|cmd)$/, '')

function gitClass(words: string[]): string | undefined {
  const [, sub, ...rest] = words
  if (!sub) return undefined
  if (GIT_READ.has(sub)) return rest.some(word => GIT_UNSAFE_FLAG.test(word)) ? undefined : 'git ' + sub
  if (GIT_LIST_FLAGS[sub]) return rest.every(word => GIT_LIST_FLAGS[sub]!.has(word)) ? 'git ' + sub : undefined
  if (sub === 'stash' && rest.length === 1 && rest[0] === 'list') return 'git stash list'
  return undefined
}

/** A script another script runs through the package manager (`npm run lint && npm test`). */
const NESTED_SCRIPT = /\b(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g

/** A project script, with its pre/post scripts and every script it runs in turn, that stays
 *  local and installs, publishes and fetches nothing. */
function localScript(scripts: Record<string, Json>, name: string, seen = new Set<string>()): boolean {
  if (seen.has(name)) return true
  if (seen.size > 12 || !PROJECT_SCRIPT.test(name) || typeof scripts[name] !== 'string') return false
  seen.add(name)
  for (const part of [name, 'pre' + name, 'post' + name]) {
    const body = scripts[part]
    if (body === undefined) continue
    if (typeof body !== 'string' || body.length > 2000) return false
    if (SCRIPT_UNSAFE.test(body) || ownerOnlyEscalation(body)) return false
    if (describeGrantRequest({ tool: 'Bash', input: { command: body }, cwd: '' }).class !== 'local') return false
    for (const match of body.matchAll(NESTED_SCRIPT)) if (!localScript(scripts, match[1] === 't' ? 'test' : match[1]!, seen)) return false
  }
  return true
}

async function packageScripts(cwd: string): Promise<Record<string, Json> | undefined> {
  try { return object(object(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))).scripts) }
  catch { return undefined }
}

async function scriptClass(cwd: string, words: string[]): Promise<string | undefined> {
  const [manager, verb, ...rest] = words
  let script: string | undefined, extra: string[]
  if (verb === 'test' || (manager === 'npm' && verb === 't')) { script = 'test'; extra = rest }
  else if (verb === 'run' || verb === 'run-script') { script = rest[0]; extra = rest.slice(1) }
  else return undefined
  if (!script) return undefined
  // Arguments go to the script, never to the package manager (no --prefix, --registry, ...).
  if (extra.length && extra[0] !== '--') return undefined
  const scripts = await packageScripts(cwd)
  if (!scripts || !localScript(scripts, script)) return undefined
  return `${manager} ${verb === 'test' || verb === 't' ? 'test' : 'run ' + script}`
}

async function npxClass(cwd: string, words: string[]): Promise<string | undefined> {
  const bin = words[1]
  if (!bin || !LOCAL_BINS.has(bin)) return undefined
  // Only an installed binary: npx would otherwise download and run a package.
  const bins = join(cwd, 'node_modules', '.bin')
  for (const name of [bin, bin + '.cmd']) {
    try { await access(join(bins, name)); return 'npx ' + bin } catch { /* try the next shim name */ }
  }
  return undefined
}

async function commandClass(cwd: string, tool: string, input: Record<string, Json>): Promise<string | undefined> {
  if (!Object.keys(input).every(key => BASH_KEYS.has(key))) return undefined
  const command = commandText(input)
  if (!command || command.length > 400) return undefined
  const words = command.split(/\s+/)
  if (!words.every(safeWord)) return undefined
  const described = describeGrantRequest({ tool: tool === 'PowerShell' ? 'PowerShell' : 'Bash', input: { command }, cwd })
  if (described.class !== 'local' || ownerOnlyEscalation(command)) return undefined
  const head = program(words[0]!)
  words[0] = head
  if (head === 'git') return gitClass(words)
  if (PACKAGE_MANAGERS.has(head)) return scriptClass(cwd, words)
  if (head === 'npx') return npxClass(cwd, words)
  return undefined
}

/** Whether the workspace (or a folder above it) is a git working tree. */
async function versioned(root: string): Promise<boolean> {
  for (let current = root; ; current = dirname(current)) {
    try { await access(join(current, '.git')); return true } catch { /* keep looking upward */ }
    if (dirname(current) === current) return false
  }
}

/**
 * The routine class of one Claude tool request, or undefined when it must be reviewed.
 * `input` is the tool input exactly as the worker sent it (not the reviewer's bounded copy);
 * `action.paths` holds the canonical, contained target of a file tool.
 */
export async function routineClass(action: Pick<ReviewAction, 'tool' | 'paths' | 'boundary'>, input: Json, cwd: string): Promise<string | undefined> {
  if (action.boundary !== 'workspace-write') return undefined
  const args = object(input)
  if (EDIT.has(action.tool)) {
    if (action.paths.length !== 1) return undefined
    let root: string
    try { root = await realpath(cwd) } catch { return undefined }
    const part = relative(process.platform === 'win32' ? root.toLowerCase() : root, action.paths[0]!)
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) return undefined
    const local = part.replaceAll('\\', '/')
    if (local.includes(':') || SENSITIVE_FILE.test(local)) return undefined
    if (describeGrantRequest({ tool: action.tool, input: args, cwd }).class !== 'local') return undefined
    return await versioned(root) ? 'routine:edit:workspace' : undefined
  }
  if (action.tool === 'Bash' || action.tool === 'PowerShell') {
    const found = await commandClass(cwd, action.tool, args)
    return found && 'routine:' + found
  }
  return undefined
}
