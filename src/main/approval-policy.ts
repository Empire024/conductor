import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Json } from '../shared/structured-agent'

/**
 * The owner's auto-approve policy (feature-list wake-controller-on-approval and codex-approval-spam,
 * owner 2026-10-17: "approvals fixed once and for all — the app never wastes tokens or the owner's
 * time on approvals"). Conductor answers a coworker's native approval request itself, with no model
 * turn and no card, when the request belongs to one of the benign classes below and everything it
 * names stays inside the project (or a writable root the owner configured). It runs before the
 * wizard, the stronger-model review and the controller wake, so an allowed request costs nothing.
 *
 * The classes are on by default; the owner (or a wizard, which holds the owner's authority) switches
 * each off with approvals.policy.set. The policy never allows:
 * - a native-owner action (an owner ask rule, a mandatory approval, an owner-only reach the caller
 *   found: `nativeOwner`),
 * - a write, or a path argument of a program run, outside the project and the configured
 *   writableRoots (a quoted "C:\Program Files\Blender Foundation\...\blender.exe" or Blender's bundled
 *   python.exe is the program, or a reference to it, never a write target),
 * - agent or tool configuration and credentials inside the project (.git, .claude, .codex, .agents,
 *   .conductor, .github, .vscode, AGENTS.md, CLAUDE.md, .mcp.json, .env*, .npmrc, .pypirc, .netrc, keys),
 * - a deletion outside the project; recursive or wildcard deletion only inside output, cache, temp,
 *   log and build folders,
 * - git (push or anything else), elevation, the registry, services or any program not listed here,
 * - an upload, form post or credential on a download, a link or junction, a nested project's files.
 *
 * evaluateApprovalPolicy is synchronous and never throws: anything it cannot read is left to the
 * normal path (null). Callers skip a read-only or planning session themselves.
 */

export interface PolicyRequest {
  provider: 'claude' | 'codex' | 'local' | string
  kind: 'command' | 'file-write' | 'file-read' | 'network' | 'other'
  /** The command line exactly as the runtime asks about it (a Codex `powershell.exe -Command '…'`
   *  wrapper, a cmd /c or bash -c wrapper included). */
  command?: string
  /** The files a file-read or file-write request names (absolute, or relative to cwd). */
  paths?: string[]
  /** Where the command runs, or where relative paths are resolved. */
  cwd: string
  /** The coworker's registered project folder. */
  projectRoot: string
  /** The caller found an owner boundary (an owner ask rule, a mandatory approval, an owner-only
   *  reach): the policy never answers it. */
  nativeOwner?: boolean
  /** Optional hint: the shell the command runs in. Omitted: read from the command's wrapper, else
   *  PowerShell on Windows and a POSIX shell elsewhere. Claude's Bash tool is 'posix' (Git Bash). */
  shell?: 'posix' | 'powershell' | 'cmd'
}
export type PolicyDecision = { decision: 'allow'; rule: string } | null

// ---------------------------------------------------------------------------------------------
// Settings

export const APPROVAL_POLICY_RULES = ['workspace-read', 'workspace-write', 'python', 'blender', 'download', 'pip-target', 'project-script'] as const
export type ApprovalPolicyRule = typeof APPROVAL_POLICY_RULES[number]
export const APPROVAL_POLICY_RULE_TEXT: Record<ApprovalPolicyRule, string> = {
  'workspace-read': 'reading files and listing folders inside the project (credential files excepted)',
  'workspace-write': 'creating, editing, copying, moving and deleting files inside the project or a writable root (recursive or wildcard deletion only inside output, cache, temp, log and build folders; never agent or tool configuration or credentials)',
  python: 'running Python (python, py, pythonw, a project venv) on a script inside the project, with every path argument inside the project or a writable root',
  blender: 'running Blender (blender.exe or its bundled Python, quoted Program Files paths included) on project files, writing only inside the project or a writable root',
  download: 'downloading over http(s) with curl, wget, Invoke-WebRequest, Invoke-RestMethod or Start-BitsTransfer into the project or to the console (no uploads, posts or credentials)',
  'pip-target': 'pip install --target/-t or --prefix into the project (its .deps folder), or into a venv inside the project; read-only pip commands',
  'project-script': 'running a .ps1, .cmd, .bat or .sh script that lives inside the project, with every path argument inside the project or a writable root'
}
/** Most specific first: the order a combined rule name is written in. */
const RULE_ORDER: readonly ApprovalPolicyRule[] = ['blender', 'python', 'pip-target', 'download', 'project-script', 'workspace-write', 'workspace-read']

export interface ApprovalPolicySettings {
  /** false turns the whole policy off. */
  enabled: boolean
  /** Each class; on unless the owner switched it off. */
  rules: Record<ApprovalPolicyRule, boolean>
  /** Folders outside the project that writes may also target (absolute; %VAR% and $env:VAR are
   *  expanded). Starts as DEFAULT_WRITABLE_ROOTS (%LOCALAPPDATA%\NVIDIA\OptixCache on Windows, for a
   *  Blender GPU render); a stored list, an empty one included, replaces it. */
  writableRoots: string[]
  setBy?: string
  setAt?: string
}
/** The app setting (database settings table) that holds the owner's policy as JSON. */
export const APPROVAL_POLICY_SETTING = 'approvalPolicy'
export const MAX_WRITABLE_ROOTS = 16

/** Writable roots every policy starts with until the owner changes the list: on Windows the NVIDIA
 *  OptiX kernel cache, which a Blender GPU (OptiX) render writes and stalls without (2026-10-17). */
export const DEFAULT_WRITABLE_ROOTS: readonly string[] = process.platform === 'win32' ? ['%LOCALAPPDATA%\\NVIDIA\\OptixCache'] : []

export function defaultApprovalPolicy(): ApprovalPolicySettings {
  return { enabled: true, rules: Object.fromEntries(APPROVAL_POLICY_RULES.map(rule => [rule, true])) as Record<ApprovalPolicyRule, boolean>, writableRoots: [...DEFAULT_WRITABLE_ROOTS] }
}

/** The stored policy; missing classes are on, unknown keys and unusable roots are dropped. */
export function parseApprovalPolicySettings(raw: string | null | undefined): ApprovalPolicySettings {
  const policy = defaultApprovalPolicy()
  if (!raw) return policy
  let value: Record<string, unknown>
  try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return policy; value = parsed as Record<string, unknown> } catch { return policy }
  if (value.enabled === false) policy.enabled = false
  const rules = value.rules && typeof value.rules === 'object' && !Array.isArray(value.rules) ? value.rules as Record<string, unknown> : {}
  for (const rule of APPROVAL_POLICY_RULES) if (rules[rule] === false) policy.rules[rule] = false
  if (Array.isArray(value.writableRoots)) policy.writableRoots = [...new Set(value.writableRoots.filter((root): root is string => typeof root === 'string' && !writableRootProblem(root)))].slice(0, MAX_WRITABLE_ROOTS)
  if (typeof value.setBy === 'string') policy.setBy = value.setBy.slice(0, 200)
  if (typeof value.setAt === 'string') policy.setAt = value.setAt.slice(0, 40)
  return policy
}

/** Why a folder cannot be a writable root (a drive or the home folder itself, a system, program or
 *  credential folder, a startup folder), or undefined when it can. */
export function writableRootProblem(root: string): string | undefined {
  if (typeof root !== 'string' || !root.trim() || root.length > 400) return 'a writable root is an absolute folder path'
  const expanded = expandEnvironment(root.trim())
  if (expanded === undefined) return 'it names an environment variable that is not set'
  if (!isAbsolute(expanded) || /^\\\\/.test(expanded) || /^[a-z]:(?![\\/])/i.test(expanded)) return 'a writable root is an absolute local folder path'
  const path = resolve(expanded)
  if (dirname(path) === path) return 'a whole drive cannot be a writable root'
  const home = resolve(homedir())
  if (fold(path) === fold(home) || fold(path) === fold(dirname(home))) return 'the home folder itself cannot be a writable root'
  const text = path.replaceAll('\\', '/')
  if (/\/(?:windows|winnt)(?:\/|$)|\/program files|\/programdata(?:\/|$)|\/system32|\/syswow64|^\/(?:etc|usr|bin|sbin|boot|dev|proc|sys|lib|var|opt|system|library)(?:\/|$)|^\/applications(?:\/|$)/i.test(text)) return 'a system or program folder cannot be a writable root'
  if (/\/\.(?:ssh|gnupg|aws|azure|kube|docker|config\/gh)(?:\/|$)|credential|\/microsoft\/(?:protect|crypto|vault|systemcertificates)(?:\/|$)|keychain|\/startup(?:\/|$)|\/start menu(?:\/|$)/i.test(text)) return 'a credential, key or startup folder cannot be a writable root'
  if (/\/appdata(?:\/(?:local|roaming|locallow))?\/?$/i.test(text)) return 'the AppData folder itself cannot be a writable root; name the application folder inside it'
  return undefined
}

let current = defaultApprovalPolicy()
/** The owner's policy as the main process last read or set it (index.ts at startup, approvals.policy.set). */
export function currentApprovalPolicy(): ApprovalPolicySettings { return current }
export function setCurrentApprovalPolicy(policy: ApprovalPolicySettings): void { current = policy }

/** The owner's writable roots, expanded and absolute, the invalid ones dropped; none while the
 *  policy is off. One expansion for the policy and the Codex sandbox (providers/codex.ts). */
export function writableRootPaths(policy: ApprovalPolicySettings = currentApprovalPolicy()): string[] {
  if (!policy?.enabled) return []
  return [...new Set(policy.writableRoots.filter(root => !writableRootProblem(root)).map(root => resolve(expandEnvironment(root.trim())!)))]
}

let projectRoots: () => readonly string[] = () => []
/** Every registered project folder (index.ts): a project nested inside another is never touched
 *  through the outer one's policy. */
export function setApprovalPolicyProjects(list: () => readonly string[]): void { projectRoots = list; registered = undefined }
let registered: { at: number; roots: string[] } | undefined
/** The registered project folders, canonical, read at most every few seconds (Claude's PreToolUse hook asks the policy on every tool call). */
function registeredRoots(): string[] {
  const now = Date.now()
  if (registered && now - registered.at < 5_000) return registered.roots
  let roots: string[] = []
  try { roots = projectRoots().filter(root => typeof root === 'string' && root && isAbsolute(root)).map(canonical) } catch { roots = [] }
  registered = { at: now, roots }
  return roots
}

// ---------------------------------------------------------------------------------------------
// Paths

const WINDOWS = process.platform === 'win32'
const fold = (path: string): string => WINDOWS ? path.toLowerCase() : path

/** The real location of a path that may not exist yet: the nearest existing ancestor's realpath
 *  (so a link or junction out of the project is followed), plus the missing rest. Case-folded on Windows. */
function canonical(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute
  for (let depth = 0; depth < 128; depth++) {
    try { return fold(join(realpathSync.native(current), ...missing.reverse())) } catch { /* not there (yet): one folder up */ }
    const parent = dirname(current)
    if (parent === current) break
    missing.push(basename(current))
    current = parent
  }
  return fold(absolute)
}
const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
const strictlyInside = (root: string, target: string): boolean => inside(root, target) && relative(root, target) !== ''

/** Agent and tool configuration, repository metadata and credentials inside a project: never written by the policy. */
const PROTECTED = /(?:^|\/)(?:\.git|\.claude|\.codex|\.agents|\.conductor|\.github|\.vscode|\.idea|\.husky|\.devcontainer|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)(?:\/|$)|(?:^|\/)(?:agents\.md|claude\.md|\.mcp\.json|\.env[^/]*|\.npmrc|\.pypirc|\.netrc|_netrc|\.yarnrc[^/]*|\.pnpmfile\.cjs|\.git[^/]*|id_rsa[^/]*|id_ed25519[^/]*|id_ecdsa[^/]*|[^/]*\.(?:pem|key|pfx|p12))$/i
/** Credentials inside a project: never read by the policy either. */
const SECRET = /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)(?:\/|$)|(?:^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|id_rsa[^/]*|id_ed25519[^/]*|id_ecdsa[^/]*|[^/]*\.(?:pem|key|pfx|p12))$/i
/** Folders that may be deleted recursively or by wildcard, with their contents: caches, temp, logs,
 *  build products and reinstallable dependencies. Output and render folders hold deliverables and
 *  are not among them. */
const DISPOSABLE = /^(?:tmp|temp|cache|\.cache|caches|logs?|build|dist|\.deps|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.conductor-scratch|node_modules)$/i
/** Blender's install (Windows, macOS, a Linux tarball): its executables are programs or references, never targets. */
const BLENDER_INSTALL = /[\\/]blender foundation(?:[\\/]|$)|[\\/]blender\.app(?:[\\/]|$)|[\\/]blender-\d[^\\/]*(?:[\\/]|$)/i
const BLENDER_EXECUTABLE = /(?:^|[\\/])(?:blender|python(?:\d+(?:\.\d+)*)?w?)(?:\.exe)?$/i

interface Roots {
  /** The canonical project folder. */
  project: string
  /** The project plus the owner's writable roots, canonical. */
  writable: string[]
  /** Registered projects nested inside this one: never touched. */
  nested: string[]
}

/** $env:X, ${env:X}, %X% and a leading ~ in a configured path; undefined when a variable is unset. */
function expandEnvironment(value: string): string | undefined {
  let unknown = false
  const read = (name: string) => { const found = process.env[name]; if (found === undefined) unknown = true; return found ?? '' }
  const out = value.replace(/%([A-Za-z_][\w()]*)%/g, (_, name: string) => read(name))
    .replace(/\$\{env:([A-Za-z_]\w*)\}|\$env:([A-Za-z_]\w*)/gi, (_, braced: string | undefined, plain: string | undefined) => read((braced ?? plain)!))
    .replace(/^~(?=[\\/]|$)/, homedir())
  return unknown ? undefined : out
}

function rootsOf(projectRoot: string, policy: ApprovalPolicySettings): Roots | undefined {
  if (!projectRoot || !isAbsolute(projectRoot)) return undefined
  const project = canonical(projectRoot)
  if (dirname(project) === project) return undefined
  const writable = [project]
  for (const root of policy.writableRoots) {
    if (writableRootProblem(root)) continue
    const expanded = expandEnvironment(root.trim())
    if (expanded) writable.push(canonical(expanded))
  }
  const nested = registeredRoots().filter(root => strictlyInside(project, root))
  return { project, writable, nested }
}

/** Windows paths in a POSIX shell (Git Bash): /c/Users/x and /cygdrive/c/x are C:\Users\x. */
function msysPath(value: string): string {
  if (!WINDOWS) return value
  const match = /^\/(?:cygdrive\/)?([a-z])(?=\/|$)(.*)$/i.exec(value)
  return match ? `${match[1]!.toUpperCase()}:${match[2] || '\\'}` : value
}

type Access = 'read' | 'write' | 'delete'
/** Whether one path argument stays where the policy allows it, for reading, writing or deleting. */
function pathAllowed(value: string, cwd: string, roots: Roots, access: Access, options: { posix?: boolean; strict?: boolean } = {}): boolean {
  if (!value || value.length > 2000 || /[\0\r\n]/.test(value)) return false
  // PowerShell provider paths (HKLM:\, Env:, Cert:\, Registry::...) and device paths are never a project file.
  if (options.strict && (/^[a-z][\w.-]+:/i.test(value) && !/^[a-z]:/i.test(value) || value.includes('::'))) return false
  if (/^\\\\[?.]\\/.test(value) || /^\\\\[^\\]/.test(value) || /^\/\/[^/]/.test(value)) return false
  const expanded = (options.posix ? msysPath(value) : value).replace(/^~(?=[\\/]|$)/, homedir())
  const target = canonical(resolve(cwd, expanded))
  // An alternate data stream (file.txt:stream) beyond the drive letter.
  if (options.strict && target.slice(2).includes(':')) return false
  if (roots.nested.some(root => inside(root, target))) return false
  if (access === 'read') {
    if (!inside(roots.project, target)) return false
    return !SECRET.test(relative(roots.project, target).replaceAll('\\', '/'))
  }
  const root = roots.writable.find(candidate => inside(candidate, target))
  if (!root) return false
  if (access === 'delete' && !strictlyInside(root, target)) return false
  const local = relative(root, target).replaceAll('\\', '/')
  return !PROTECTED.test(local) && !SECRET.test(local)
}

/** A deletion that reaches further than one named file (recursive, or by wildcard): only inside, or
 *  of, a disposable folder of a writable root. */
function disposableTarget(value: string, cwd: string, roots: Roots, posix: boolean): boolean {
  const expanded = (posix ? msysPath(value) : value).replace(/^~(?=[\\/]|$)/, homedir())
  const target = canonical(resolve(cwd, expanded))
  const root = roots.writable.find(candidate => strictlyInside(candidate, target))
  if (!root) return false
  return relative(root, target).split(/[\\/]/).some(part => DISPOSABLE.test(part))
}

const isUrl = (value: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
const httpUrl = (value: string): boolean => /^https?:\/\/[^\s/?#]+/i.test(value)
const blenderExecutable = (value: string): boolean => (isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) && BLENDER_INSTALL.test(value) && BLENDER_EXECUTABLE.test(value) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)
const blenderInstallPath = (value: string): boolean => (isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) && BLENDER_INSTALL.test(value) && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)

// ---------------------------------------------------------------------------------------------
// Shell parsing: just enough of PowerShell, cmd and POSIX shells to see every program a command
// runs and every path it names. Anything this cannot read is left to the normal path.

type Dialect = 'posix' | 'powershell' | 'cmd'
interface Part { text: string; quote: '' | "'" | '"' }
interface Word { raw: string; parts: Part[] }
interface Redirect { op: string; target?: Word }
interface Segment { text: string; op: string }

const WRAPPER_FLAGS_WITH_VALUE = new Set(['-executionpolicy', '-ep', '-ex', '-inputformat', '-if', '-outputformat', '-of', '-windowstyle', '-w', '-configurationname', '-workingdirectory', '-wd', '-settingsfile', '-version', '-v'])

/** The first word of a command line, with its end offset (quotes kept out of the value). */
function firstWord(text: string): { value: string; end: number } | undefined {
  let i = 0
  while (i < text.length && /\s/.test(text[i]!)) i++
  if (i >= text.length) return undefined
  let value = ''
  while (i < text.length && !/\s/.test(text[i]!)) {
    const ch = text[i]!
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1)
      if (close < 0) return undefined
      value += text.slice(i + 1, close)
      i = close + 1
      continue
    }
    value += ch
    i++
  }
  return { value, end: i }
}

/** The body of a quoted -Command / -c / /c argument. Codex joins its argv naively, so the inner
 *  quotes of `-Command '…'` are not always escaped: the outer pair is stripped verbatim, and only
 *  an inner text whose every quote is doubled (a properly escaped body) is unescaped. */
function quotedBody(rest: string): string {
  const text = rest.trim()
  if (text.length >= 2 && text[0] === "'" && text.at(-1) === "'") {
    const inner = text.slice(1, -1)
    if (/'/.test(inner) && !inner.replace(/''/g, '').includes("'")) return inner.replace(/''/g, "'")
    return inner.replace(/'"'"'|'\\''/g, "'")
  }
  if (text.length >= 2 && text[0] === '"' && text.at(-1) === '"') {
    const inner = text.slice(1, -1)
    return inner.replace(/\\"|`"|""/g, '"')
  }
  return text
}

/** Peels shell wrappers (powershell -Command, pwsh -c, cmd /c, bash -c) off a command line. */
function unwrap(command: string, hint: Dialect | undefined): { body: string; dialect: Dialect } | undefined {
  let body = command.trim(), dialect: Dialect = hint ?? (WINDOWS ? 'powershell' : 'posix')
  for (let depth = 0; depth < 4; depth++) {
    const first = firstWord(body)
    if (!first) return { body, dialect }
    const name = programName(first.value)
    let rest = body.slice(first.end)
    if (name === 'powershell' || name === 'pwsh') {
      let mode: 'command' | 'file' | undefined
      for (;;) {
        const flag = firstWord(rest)
        if (!flag) return { body: '', dialect: 'powershell' }
        const lower = flag.value.toLowerCase()
        if (!lower.startsWith('-')) { mode = name === 'pwsh' ? 'file' : 'command'; break }
        if (/^-(?:e|ec|enc|encodedcommand|encodedarguments)$/.test(lower)) return undefined
        if (/^-(?:c|command)$/.test(lower)) { rest = rest.slice(flag.end); mode = 'command'; break }
        if (/^-(?:f|file)$/.test(lower)) { rest = rest.slice(flag.end); mode = 'file'; break }
        rest = rest.slice(flag.end)
        if (WRAPPER_FLAGS_WITH_VALUE.has(lower)) { const value = firstWord(rest); if (!value) return undefined; rest = rest.slice(value.end) }
      }
      if (mode === 'file') return { body: '& ' + rest.trim(), dialect: 'powershell' }
      body = quotedBody(rest); dialect = 'powershell'
      continue
    }
    if (name === 'cmd') {
      let strip = false
      for (;;) {
        const flag = firstWord(rest)
        if (!flag) return { body: '', dialect: 'cmd' }
        const lower = flag.value.toLowerCase()
        rest = rest.slice(flag.end)
        if (lower === '/c' || lower === '/k') break
        if (lower === '/s') { strip = true; continue }
        if (/^\/(?:d|q|a|u|e:on|e:off|f:on|f:off|v:on|v:off)$/.test(lower)) continue
        return undefined
      }
      const text = rest.trim()
      body = strip && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text.startsWith('"') && text.endsWith('"') && text.indexOf('"', 1) === text.length - 1 ? text.slice(1, -1) : text
      dialect = 'cmd'
      continue
    }
    if (['bash', 'sh', 'zsh', 'dash'].includes(name)) {
      let script: string | undefined
      for (;;) {
        const flag = firstWord(rest)
        if (!flag || !flag.value.startsWith('-')) break
        rest = rest.slice(flag.end)
        if (/^-[a-z]*c[a-z]*$/i.test(flag.value)) { script = quotedBody(rest); break }
        if (flag.value === '-o' || flag.value === '+o') { const value = firstWord(rest); if (!value) return undefined; rest = rest.slice(value.end) }
      }
      if (script === undefined) return { body, dialect: 'posix' }
      body = script; dialect = 'posix'
      continue
    }
    return { body, dialect }
  }
  return undefined
}

/** Splits a body into simple commands at ; && || | & and line breaks outside quotes and groups. */
function splitSegments(body: string, dialect: Dialect): Segment[] | undefined {
  const segments: Segment[] = []
  let current = '', op = '', quote: string | undefined, depth = 0
  const push = (next: string): boolean => {
    if (!current.trim()) { if (next !== ';' && op !== ';' && op !== '') return false; current = ''; op = next || op; return true }
    segments.push({ text: current.trim(), op })
    current = ''; op = next
    return true
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (quote) {
      current += ch
      if (dialect === 'powershell' && quote === '"' && ch === '`') { current += body[i + 1] ?? ''; i++; continue }
      if (dialect === 'posix' && quote === '"' && ch === '\\') { current += body[i + 1] ?? ''; i++; continue }
      if (ch === quote) {
        if (dialect === 'powershell' && body[i + 1] === quote) { current += body[i + 1]; i++; continue }
        quote = undefined
      }
      continue
    }
    if (ch === '"' || (ch === "'" && dialect !== 'cmd')) { quote = ch; current += ch; continue }
    if (dialect === 'posix' && ch === '\\') { current += ch + (body[i + 1] ?? ''); i++; continue }
    if (dialect === 'powershell' && ch === '`') { current += ch + (body[i + 1] ?? ''); i++; continue }
    if (dialect === 'cmd' && ch === '^') { current += ch + (body[i + 1] ?? ''); i++; continue }
    if (dialect === 'posix' && ch === '`') return undefined
    if (ch === '(' || ch === '{') { depth++; current += ch; continue }
    if (ch === ')' || ch === '}') { depth--; if (depth < 0) return undefined; current += ch; continue }
    if (depth > 0) { current += ch; continue }
    if (ch === '\n' || ch === '\r' || (ch === ';' && dialect !== 'cmd')) { if (!push(';')) return undefined; continue }
    if (ch === '&') {
      if (body[i + 1] === '&') { if (!push('&&')) return undefined; i++; continue }
      // PowerShell's call operator, a redirect's stream merge (2>&1) or a POSIX &> redirect.
      if (dialect === 'powershell' && !current.trim()) { current += ch; continue }
      if (body[i - 1] === '>' || (dialect === 'posix' && body[i + 1] === '>')) { current += ch; continue }
      if (!push('&')) return undefined
      continue
    }
    if (ch === '|') {
      if (body[i + 1] === '|') { if (!push('||')) return undefined; i++; continue }
      if (!push('|')) return undefined
      continue
    }
    current += ch
  }
  if (quote || depth !== 0) return undefined
  if (current.trim()) segments.push({ text: current.trim(), op })
  else if (op && op !== ';') return undefined
  return segments
}

/** One simple command's words and redirects; undefined when it cannot be read. */
function parseSegment(text: string, dialect: Dialect): { words: Word[]; redirects: Redirect[] } | undefined {
  const words: Word[] = [], redirects: Redirect[] = []
  let i = 0
  const readWord = (): Word | undefined => {
    const start = i, parts: Part[] = []
    let buffer = ''
    const flush = () => { if (buffer) { parts.push({ text: buffer, quote: '' }); buffer = '' } }
    while (i < text.length) {
      const ch = text[i]!
      if (/\s/.test(ch)) break
      if (ch === '"' || (ch === "'" && dialect !== 'cmd')) {
        flush()
        const quote = ch
        let value = ''
        i++
        for (;;) {
          if (i >= text.length) return undefined
          const c = text[i]!
          if (c === quote) {
            if (dialect === 'powershell' && text[i + 1] === quote) { value += quote; i += 2; continue }
            i++
            break
          }
          if (dialect === 'powershell' && quote === '"' && c === '`') { value += text[i + 1] ?? ''; i += 2; continue }
          if (dialect === 'posix' && quote === '"' && c === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) { value += text[i + 1]; i += 2; continue }
          value += c
          i++
        }
        parts.push({ text: value, quote: quote as "'" | '"' })
        continue
      }
      if (ch === '>' || (ch === '<' && dialect !== 'powershell')) break
      if ((dialect === 'posix' && ch === '\\') || (dialect === 'powershell' && ch === '`') || (dialect === 'cmd' && ch === '^')) { buffer += text[i + 1] ?? ''; i += 2; continue }
      if (ch === '(' || ch === '{') {
        // A group in a word ($(…), @{…}, (…)) is kept whole; its value decides later.
        let level = 0, quote: string | undefined
        for (; i < text.length; i++) {
          const c = text[i]!
          buffer += c
          if (quote) { if (c === quote) quote = undefined; continue }
          if (c === '"' || c === "'") { quote = c; continue }
          if (c === '(' || c === '{') level++
          if (c === ')' || c === '}') { level--; if (level === 0) { i++; break } }
        }
        if (level !== 0) return undefined
        continue
      }
      buffer += ch
      i++
    }
    flush()
    return { raw: text.slice(start, i), parts }
  }
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue }
    const redirect = /^(?:[0-9*]?>>?|&>>?|<<<|<<|<)(?:&[0-9])?/.exec(text.slice(i))
    if (redirect && (redirect[0].includes('>') || dialect !== 'powershell')) {
      const op = redirect[0]
      if (op.startsWith('<<')) return undefined
      i += op.length
      if (/&[0-9]$/.test(op)) { redirects.push({ op }); continue }
      while (i < text.length && /\s/.test(text[i]!)) i++
      const target = readWord()
      if (!target || !target.raw) return undefined
      redirects.push({ op, target })
      continue
    }
    const word = readWord()
    if (!word) return undefined
    if (!word.raw) return undefined
    words.push(word)
  }
  return { words, redirects }
}

interface Context {
  roots: Roots
  cwd: string
  stack: string[]
  dialect: Dialect
  vars: Map<string, string>
  env: Map<string, string>
}

/** A variable's value in this command, the environment's, or undefined when unknown. */
function variable(name: string, context: Context): string | undefined {
  const lower = name.toLowerCase()
  if (lower.startsWith('env:')) {
    const key = name.slice(4)
    return context.env.get(WINDOWS ? key.toLowerCase() : key) ?? process.env[key]
  }
  if (context.dialect === 'posix') {
    if (name === 'HOME') return homedir()
    if (name === 'PWD') return context.cwd
    return context.vars.get(name) ?? context.env.get(name) ?? (/^[A-Z_][A-Z0-9_]*$/.test(name) ? process.env[name] : undefined)
  }
  if (lower === 'pwd' || lower === 'psscriptroot') return context.cwd
  if (lower === 'home') return homedir()
  if (lower === 'null') return ''
  if (lower === 'true' || lower === 'false') return lower
  return context.vars.get(lower)
}

/** The text a part expands to; undefined when it holds a subexpression or an unknown variable. */
function expand(text: string, context: Context): string | undefined {
  if (context.dialect === 'cmd') {
    let unknown = false
    const out = text.replace(/%%|%([^%\s]+)%/g, (whole, name: string | undefined) => {
      if (!name) return '%'
      const value = context.env.get(WINDOWS ? name.toLowerCase() : name) ?? process.env[name]
      if (value === undefined) unknown = true
      return value ?? ''
    })
    return unknown || /![\w]+!/.test(out) ? undefined : out
  }
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch !== '$') {
      if (context.dialect === 'powershell' && (ch === '@' && (text[i + 1] === '(' || text[i + 1] === '{'))) return undefined
      out += ch
      continue
    }
    const next = text[i + 1]
    if (next === '(') {
      // $(…): only a date stamp (Get-Date -Format …) is read; anything else could run anything.
      let level = 0, end = -1
      for (let j = i + 1; j < text.length; j++) { if (text[j] === '(') level++; if (text[j] === ')') { level--; if (level === 0) { end = j; break } } }
      if (end < 0) return undefined
      const inner = text.slice(i + 2, end)
      if (context.dialect !== 'powershell' || !/^\s*Get-Date(?:\s+-(?:Format|f|UFormat)\s+(?:'[^']*'|"[^"$]*"|[^\s()$;|&]+))?\s*$/i.test(inner)) return undefined
      out += '20261017-000000'
      i = end
      continue
    }
    if (next === '{') {
      const end = text.indexOf('}', i + 2)
      if (end < 0) return undefined
      const value = variable(text.slice(i + 2, end), context)
      if (value === undefined) return undefined
      out += value
      i = end
      continue
    }
    const match = (context.dialect === 'powershell' ? /^(?:env:)?[A-Za-z_][\w]*/ : /^[A-Za-z_][\w]*/).exec(text.slice(i + 1))
    if (!match) {
      if (next === undefined || /[\s'"/\\:.,=-]/.test(next)) { out += '$'; continue }
      return undefined
    }
    const value = variable(match[0], context)
    if (value === undefined) return undefined
    out += value
    i += match[0].length
  }
  return out
}

/** A word's value after quoting and expansion; undefined when it cannot be known. */
function valueOf(word: Word, context: Context): string | undefined {
  let out = ''
  for (const [index, part] of word.parts.entries()) {
    if (part.quote === "'" && context.dialect !== 'cmd') { out += part.text; continue }
    let text = part.text
    if (index === 0 && part.quote === '' && context.dialect === 'posix') text = text.replace(/^~(?=\/|$)/, homedir())
    if (context.dialect === 'powershell' && part.quote === '' && /^[([{]/.test(text) && !(index === 0 && /^@\{[^$()`]*\}$/.test(text))) return undefined
    if (context.dialect === 'powershell' && part.quote === '' && index === 0 && /^@\{[^$()`]*\}$/.test(text)) { out += text; continue }
    const value = expand(text, context)
    if (value === undefined) return undefined
    out += value
  }
  return out
}

/** The bare program name: lower case, without folders and .exe/.com. */
function programName(value: string): string {
  const base = value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.(?:exe|com)$/, '')
}

// ---------------------------------------------------------------------------------------------
// Programs

const NAVIGATION = new Set(['cd', 'chdir', 'set-location', 'sl', 'push-location', 'pushd', 'pop-location', 'popd'])
const HARMLESS = new Set(['echo', 'write-output', 'write-host', 'write-verbose', 'write-information', 'write-warning', 'write-debug', 'printf', 'start-sleep', 'sleep', 'get-date', 'clear-host', 'cls', 'clear', 'true', 'exit', 'out-null', 'get-location', 'gl', 'pwd', 'which', 'get-command', 'gcm', 'whoami', 'get-host'])
const FILTERS = new Set(['select-object', 'select', 'sort-object', 'measure-object', 'measure', 'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw', 'out-string', 'out-host', 'oh', 'group-object', 'group', 'get-unique', 'gu', 'convertto-json', 'convertfrom-json', 'convertto-csv', 'convertfrom-csv', 'select-string', 'sls', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'wc', 'uniq', 'cut', 'more', 'jq', 'column', 'nl', 'tac', 'rev', 'sort'])
const READS = new Set(['get-childitem', 'gci', 'dir', 'ls', 'get-content', 'gc', 'cat', 'type', 'test-path', 'resolve-path', 'rvpa', 'get-item', 'gi', 'get-filehash', 'split-path', 'join-path', 'stat', 'file', 'du', 'tree', 'realpath', 'readlink', 'dirname', 'basename', 'find', 'where', 'get-itemproperty', 'gp', 'test-json', 'import-csv', 'ipcsv'])
const CREATE = new Set(['new-item', 'ni', 'mkdir', 'md', 'touch'])
const COPY = new Set(['copy-item', 'copy', 'cp', 'cpi'])
const MOVE = new Set(['move-item', 'move', 'mv', 'mi', 'rename-item', 'ren', 'rni', 'rename'])
const REMOVE = new Set(['remove-item', 'rm', 'del', 'erase', 'ri', 'rd', 'rmdir'])
const CONTENT = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'tee-object', 'tee', 'export-csv', 'epcsv'])
const ARCHIVES = new Set(['expand-archive', 'compress-archive', 'tar', 'unzip'])
const DOWNLOADERS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer'])
const PYTHON = /^(?:python(?:\d+(?:\.\d+)*)?w?|pythonw|pyw?)$/
const PIP = /^pip(?:\d+(?:\.\d+)*)?$/
const SCRIPT_EXTENSION = /\.(?:ps1|cmd|bat|sh)$/i

/** The classes one simple command needs ([] when it needs none), or null when the policy leaves it alone. */
type Verdict = ApprovalPolicyRule[] | null

const isFlag = (value: string, dialect: Dialect): boolean => value.startsWith('-') || (dialect === 'cmd' && /^\/[a-z?][\w:+-]*$/i.test(value))

/** Every argument of a file command must stay inside the project (for reads) or a writable root. */
function fileArguments(values: string[], context: Context, access: Access, flagsWithValue: Set<string> = new Set()): boolean {
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (isFlag(value, context.dialect) && value !== '-') {
      const lower = value.toLowerCase()
      const eq = value.indexOf('=')
      if (eq > 0 && lower.startsWith('--')) { if (!pathAllowed(value.slice(eq + 1), context.cwd, context.roots, access, { posix: context.dialect === 'posix', strict: true })) return false; continue }
      // A PowerShell -Path:value form.
      const colon = /^-[a-z]+:(.+)$/i.exec(value)
      if (colon && context.dialect === 'powershell') { if (!pathAllowed(colon[1]!, context.cwd, context.roots, access, { strict: true })) return false; continue }
      if (flagsWithValue.has(lower)) i++
      continue
    }
    if (!pathAllowed(value, context.cwd, context.roots, access, { posix: context.dialect === 'posix', strict: true })) return false
  }
  return true
}

/** A path, URL or plain argument a program run is given: inside a writable root, a Blender
 *  executable it is told to use, a URL, or a word that names nothing outside. */
function programArgument(value: string, context: Context): boolean {
  if (!value) return true
  if (isUrl(value)) return !/^file:/i.test(value)
  if (blenderExecutable(value)) return true
  return pathAllowed(value, context.cwd, context.roots, 'write', { posix: context.dialect === 'posix' })
}
function programArguments(values: string[], context: Context): boolean {
  for (const value of values) {
    if (value.startsWith('-')) {
      const eq = value.indexOf('=')
      if (eq > 0 && !programArgument(value.slice(eq + 1), context)) return false
      continue
    }
    if (!programArgument(value, context)) return false
  }
  return true
}

const INLINE_UNSAFE = /\b(?:os\.(?:system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|removedirs|chmod|chown|kill)|subprocess|shutil\.(?:rmtree|move|chown)|winreg|_winreg|ctypes|socket|eval|exec|compile|__import__|importlib|pty|webbrowser|smtplib|ftplib|telnetlib|bpy\.ops\.wm\.(?:url_open|path_open))\b/
/** Absolute paths written as string literals in inline code (python -c, --python-expr). */
function inlineCode(code: string, context: Context): boolean {
  if (code.length > 20_000) return false
  // A one-liner that starts programs, deletes trees, opens sockets or reaches the registry is not
  // a benign run; a script file inside the project is the reviewed way to do such things.
  if (INLINE_UNSAFE.test(code)) return false
  for (const match of code.matchAll(/(['"])((?:[a-zA-Z]:[\\/]|\\\\|\/(?!\/)|~[\\/])[^'"\n]*)\1/g)) {
    const path = match[2]!.replace(/\\\\/g, '\\')
    if (!blenderExecutable(path) && !pathAllowed(path, context.cwd, context.roots, 'write', { posix: true })) return false
  }
  return true
}

/** cwd must be inside the project for anything that runs or writes there. */
const cwdInProject = (context: Context): boolean => inside(context.roots.project, canonical(context.cwd)) && !context.roots.nested.some(root => inside(root, canonical(context.cwd)))

function pythonRun(program: string, values: string[], context: Context, blender: boolean): Verdict {
  const venv = /[\\/]/.test(program) && !isAbsolute(program) && !/^[a-z]:/i.test(program) ? pathAllowed(program, context.cwd, context.roots, 'read', { posix: context.dialect === 'posix' })
    : /[\\/]/.test(program) && inside(context.roots.project, canonical(resolve(context.cwd, context.dialect === 'posix' ? msysPath(program) : program)))
  if (/^\\\\/.test(program)) return null
  if (/[\\/]/.test(program) && !isAbsolute(program) && !/^[a-z]:/i.test(program) && !venv) return null
  const rule: ApprovalPolicyRule = blender ? 'blender' : 'python'
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (value === '-m') {
      const module = values[i + 1]
      if (!module) return null
      const rest = values.slice(i + 2)
      if (module === 'pip') return pip(rest, context, venv)
      return programArguments(rest, context) ? [rule] : null
    }
    if (value === '-c') {
      const code = values[i + 1]
      if (code === undefined || !inlineCode(code, context)) return null
      return programArguments(values.slice(i + 2), context) ? [rule] : null
    }
    if (/^-[0-9](?:\.[0-9]+)?(?:-(?:32|64))?$/.test(value)) continue
    if (value === '-X' || value === '-W' || value === '--check-hash-based-pycs') { i++; continue }
    if (/^-(?:[uBEIOsSqbdRhVvi]+|OO)$/.test(value) || value === '--version' || value === '--help') continue
    if (value === '-' || value.startsWith('-')) return null
    // The script: a file inside the project.
    if (!pathAllowed(value, context.cwd, context.roots, 'read', { posix: context.dialect === 'posix' })) return null
    return programArguments(values.slice(i + 1), context) ? [rule] : null
  }
  return [rule]
}

function blenderRun(values: string[], context: Context): Verdict {
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (value === '--') return programArguments(values.slice(i + 1), context) ? ['blender'] : null
    if (value === '--python-expr') { if (!inlineCode(values[i + 1] ?? '', context)) return null; i++; continue }
    if (value === '--python-text' || value === '--app-template' || value === '--addons' || value === '-E' || value === '--engine' || value === '-F' || value === '--render-format') { i++; continue }
    if (value === '-P' || value === '--python') { if (!pathAllowed(values[i + 1] ?? '', context.cwd, context.roots, 'read', { posix: context.dialect === 'posix' })) return null; i++; continue }
    if (value === '-o' || value === '--render-output') {
      // Blender's // prefix is relative to the .blend file, itself a project file.
      const output = (values[i + 1] ?? '').replace(/^\/\//, '')
      if (!programArgument(output || '.', context)) return null
      i++
      continue
    }
    if (value.startsWith('-')) continue
    if (!programArgument(value, context)) return null
  }
  return ['blender']
}

const PIP_GLOBAL_VALUES = new Set(['--proxy', '--retries', '--timeout', '--trusted-host', '--exists-action', '--use-feature', '--use-deprecated', '--root-user-action', '--progress-bar', '--resume-retries'])
const PIP_INSTALL_VALUES = new Set(['-i', '--index-url', '--extra-index-url', '--platform', '--python-version', '--implementation', '--abi', '--only-binary', '--no-binary', '--progress-bar', '--upgrade-strategy', '-C', '--config-settings', '--global-option', '--trusted-host', '--timeout', '--retries', '--proxy', '--exists-action'])
const PIP_READONLY = new Set(['list', 'show', 'freeze', 'check', 'help', 'index', 'inspect', 'debug', 'hash'])

function pip(values: string[], context: Context, venv: boolean): Verdict {
  const write = (path: string | undefined) => path !== undefined && pathAllowed(path, context.cwd, context.roots, 'write', { posix: context.dialect === 'posix' })
  const projectFolder = (path: string | undefined) => path !== undefined && write(path) && inside(context.roots.project, canonical(resolve(context.cwd, context.dialect === 'posix' ? msysPath(path) : path)))
  const read = (path: string | undefined) => path !== undefined && (httpUrl(path) || /^git\+https?:\/\//i.test(path) || pathAllowed(path, context.cwd, context.roots, 'read', { posix: context.dialect === 'posix' }))
  let i = 0
  for (; i < values.length && values[i]!.startsWith('-'); i++) {
    const [flag, attached] = values[i]!.split(/=(.*)/s) as [string, string | undefined]
    if (flag === '--cache-dir' || flag === '--log' || flag === '--log-file') { if (!write(attached ?? values[++i])) return null; continue }
    if (flag === '--cert') { if (!read(attached ?? values[++i])) return null; continue }
    if (flag === '--python' || flag === '--client-cert' || flag === '--keyring-provider') return null
    if (PIP_GLOBAL_VALUES.has(flag)) { if (attached === undefined) i++; continue }
    if (flag === '--version' || flag === '-V') return ['pip-target']
  }
  const command = values[i]?.toLowerCase(), args = values.slice(i + 1)
  if (!command) return ['pip-target']
  if (PIP_READONLY.has(command)) return args.every(arg => arg.startsWith('-') || !/[\\/]/.test(arg) || read(arg)) ? ['pip-target'] : null
  if (command === 'cache') return ['dir', 'info', 'list'].includes(args[0] ?? '') ? ['pip-target'] : null
  if (command === 'uninstall') return venv ? ['pip-target'] : null
  if (command !== 'install' && command !== 'download' && command !== 'wheel') return null
  let target: string | undefined
  for (let k = 0; k < args.length; k++) {
    const raw = args[k]!
    if (!raw.startsWith('-')) {
      // A package name or specifier, a URL, or a local wheel/archive/folder inside the project.
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[\w,.\s-]+\])?(?:\s*(?:===|==|~=|!=|>=|<=|>|<)\s*[\w.*+!-]+(?:\s*,\s*(?:===|==|~=|!=|>=|<=|>|<)\s*[\w.*+!-]+)*)?(?:\s*;.*)?$/.test(raw) && !/[\\/]/.test(raw)) continue
      if (!read(raw)) return null
      continue
    }
    const match = /^(-t|--target|--prefix|--root|-d|--dest|--destination-directory|-w|--wheel-dir|-r|--requirement|-c|--constraint|-e|--editable|--src|--report|--cache-dir|--log|-f|--find-links)(?:=(.*))?$/s.exec(raw)
      ?? /^(-t|-d|-w|-r|-c|-e|-f)(.+)$/s.exec(raw)
    if (match) {
      const flag = match[1]!, value = match[2] ?? args[++k]
      if (value === undefined) return null
      if (['-t', '--target', '--prefix', '--root', '-d', '--dest', '--destination-directory', '-w', '--wheel-dir'].includes(flag)) { if (!projectFolder(value)) return null; target = value; continue }
      if (['--src', '--report', '--cache-dir', '--log'].includes(flag)) { if (!write(value)) return null; continue }
      if (flag === '-f' || flag === '--find-links') { if (!read(value)) return null; continue }
      if (!read(value)) return null
      continue
    }
    const [flag, attached] = raw.split(/=(.*)/s) as [string, string | undefined]
    if (flag === '--user' || flag === '--break-system-packages') { if (flag === '--user' || !target) return null; continue }
    if (PIP_INSTALL_VALUES.has(flag)) { if (attached === undefined) k++; continue }
    if (/^--?[a-zA-Z][\w-]*$/.test(flag)) continue
    return null
  }
  // pip download and pip wheel write to cwd unless told otherwise; install needs a target or a project venv.
  if (command === 'install' && !target && !venv) return null
  if (command !== 'install' && !target && !cwdInProject(context)) return null
  return ['pip-target']
}

const CURL_DENY = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-F', '--form', '--form-string', '-T', '--upload-file', '-K', '--config', '-u', '--user', '--proxy-user', '-E', '--cert', '--key', '--pass', '--netrc', '--netrc-file', '--netrc-optional', '-n', '--oauth2-bearer', '--aws-sigv4', '--delegation', '--negotiate', '--ntlm', '--anyauth', '--basic', '--digest', '-Q', '--quote', '--mail-from', '--mail-rcpt', '--libcurl', '-:', '--next'])
const CURL_WRITE = new Set(['-o', '--output', '--output-dir', '-D', '--dump-header', '-c', '--cookie-jar', '--trace', '--trace-ascii', '--stderr', '--etag-save', '--hsts', '--alt-svc'])
const CURL_READ = new Set(['--cacert', '--capath', '--etag-compare'])
const CURL_VALUES = new Set(['-H', '--header', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '-r', '--range', '-C', '--continue-at', '-w', '--write-out', '-x', '--proxy', '--limit-rate', '--max-filesize', '-z', '--time-cond', '--resolve', '--connect-to', '--url', '--ciphers', '--interface', '--max-redirs', '-y', '--speed-time', '-Y', '--speed-limit', '--tls-max', '--parallel-max', '--keepalive-time', '--expect100-timeout', '--happy-eyeballs-timeout-ms', '--dns-servers', '--noproxy', '--preproxy', '--rate', '--variable', '--url-query'])
const CURL_SWITCHES = new Set(['-L', '--location', '-s', '--silent', '-S', '--show-error', '-f', '--fail', '--fail-with-body', '--fail-early', '-O', '--remote-name', '--remote-name-all', '-J', '--remote-header-name', '--create-dirs', '-k', '--insecure', '-I', '--head', '-#', '--progress-bar', '--compressed', '-v', '--verbose', '-i', '--include', '-g', '--globoff', '-N', '--no-buffer', '--http1.0', '--http1.1', '--http2', '--http3', '-4', '-6', '-G', '--get', '-Z', '--parallel', '--ssl-no-revoke', '-q', '--disable', '--location-trusted', '--retry-connrefused', '--retry-all-errors', '--no-progress-meter', '--fail-early', '--styled-output', '--no-styled-output', '-R', '--remote-time', '--tcp-nodelay', '--no-keepalive', '--raw', '--tr-encoding', '--xattr', '--no-clobber', '--remove-on-error', '--skip-existing', '--ssl', '--ssl-reqd', '--tlsv1.2', '--tlsv1.3', '--path-as-is', '--clobber'])
const WGET_DENY = new Set(['-e', '--execute', '--post-data', '--post-file', '--body-data', '--body-file', '--user', '--password', '--http-user', '--http-password', '--ftp-user', '--ftp-password', '--proxy-user', '--proxy-password', '--certificate', '--private-key', '--ask-password', '--use-askpass', '--config', '-b', '--background'])
const WGET_WRITE = new Set(['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file', '-a', '--append-output', '--save-cookies', '--warc-file'])
const WGET_READ = new Set(['-i', '--input-file', '--load-cookies', '--ca-certificate', '--ca-directory'])
const WGET_VALUES = new Set(['-U', '--user-agent', '--header', '-t', '--tries', '-T', '--timeout', '-w', '--wait', '--limit-rate', '-l', '--level', '-A', '--accept', '-R', '--reject', '--referer', '--waitretry', '--dns-timeout', '--connect-timeout', '--read-timeout', '-Q', '--quota', '-D', '--domains', '--exclude-domains', '-I', '--include-directories', '-X', '--exclude-directories', '--cut-dirs', '--restrict-file-names', '--secure-protocol', '--max-redirect', '-e'])
const IWR_DENY = new Set(['-body', '-infile', '-form', '-credential', '-usedefaultcredentials', '-certificate', '-certificatethumbprint', '-authentication', '-token', '-proxycredential', '-proxyusedefaultcredentials', '-allowunencryptedauthentication', '-customMethod'.toLowerCase()])
const IWR_VALUES = new Set(['-timeoutsec', '-maximumredirection', '-maximumretrycount', '-retryintervalsec', '-useragent', '-headers', '-contenttype', '-proxy', '-websession', '-sessionvariable', '-sv', '-transferencoding', '-progressaction', '-connectiontimeoutseconds', '-operationtimeoutseconds', '-httpversion', '-sslprotocol', '-erroraction', '-ea', '-warningaction', '-wa', '-outvariable', '-ov', '-statuscodevariable', '-responseheaderstvariable', '-responseheadersvariable'])
const IWR_SWITCHES = new Set(['-usebasicparsing', '-passthru', '-resume', '-skipcertificatecheck', '-skiphttperrorcheck', '-skipheadervalidation', '-noproxy', '-disablekeepalive', '-preservehttpmethodonredirect', '-preserveauthorizationonredirect', '-allowinsecureredirect', '-verbose'])

function curl(values: string[], context: Context): Verdict {
  let remote = false, outputDir = false, urls = 0
  const write = (path: string | undefined) => path !== undefined && pathAllowed(path, context.cwd, context.roots, 'write', { posix: context.dialect === 'posix', strict: true })
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (!value.startsWith('-') || value === '-') {
      if (/^file:/i.test(value) || (isUrl(value) && !/^(?:https?|ftps?):\/\//i.test(value))) return null
      urls++
      continue
    }
    const [flag, attached] = value.startsWith('--') ? value.split(/=(.*)/s) as [string, string | undefined] : [value, undefined]
    const one = (name: string, rest: string | undefined): boolean | 'next' => {
      if (CURL_DENY.has(name)) return false
      if (name === '-X' || name === '--request') { const method = rest ?? values[++i]; return /^(?:GET|HEAD)$/i.test(method ?? '') }
      if (CURL_WRITE.has(name)) {
        const path = rest ?? values[++i]
        if (name === '--output-dir') outputDir = true
        return path === '-' || path === '/dev/null' || /^nul$/i.test(path ?? '') || write(path)
      }
      if (CURL_READ.has(name)) { const path = rest ?? values[++i]; return path !== undefined && pathAllowed(path, context.cwd, context.roots, 'read', { posix: context.dialect === 'posix', strict: true }) }
      if (name === '--url') { const url = rest ?? values[++i]; if (url === undefined || /^file:/i.test(url)) return false; urls++; return true }
      if (CURL_VALUES.has(name)) { if (rest === undefined) i++; return true }
      if (CURL_SWITCHES.has(name)) { if (name === '-O' || name === '--remote-name' || name === '--remote-name-all' || name === '-J' || name === '--remote-header-name') remote = true; return rest === undefined }
      return false
    }
    if (flag.startsWith('--')) { if (!one(flag, attached)) return null; continue }
    // Short flags may be bundled (-fsSL, -sLo file, -ofile).
    const letters = flag.slice(1)
    let ok = true
    for (let k = 0; k < letters.length; k++) {
      const name = '-' + letters[k]
      const takes = CURL_DENY.has(name) || CURL_WRITE.has(name) || CURL_READ.has(name) || CURL_VALUES.has(name) || name === '-X'
      if (takes) { const rest = letters.slice(k + 1) || undefined; ok = Boolean(one(name, rest)); break }
      if (!one(name, undefined)) { ok = false; break }
    }
    if (!ok) return null
  }
  if (!urls) return null
  // -O and -J write into the output folder, or into cwd.
  if ((remote && !outputDir) && !cwdInProject(context)) return null
  return ['download']
}

function wget(values: string[], context: Context): Verdict {
  let wrote = false, urls = 0
  const write = (path: string | undefined) => path !== undefined && (path === '-' || pathAllowed(path, context.cwd, context.roots, 'write', { posix: context.dialect === 'posix', strict: true }))
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (!value.startsWith('-')) { if (!/^(?:https?|ftps?):\/\//i.test(value) && isUrl(value)) return null; urls++; continue }
    const [flag, attached] = value.split(/=(.*)/s) as [string, string | undefined]
    if (WGET_DENY.has(flag)) return null
    if (flag === '--method') { if (!/^(?:GET|HEAD)$/i.test(attached ?? values[++i] ?? '')) return null; continue }
    if (WGET_WRITE.has(flag)) { if (!write(attached ?? values[++i])) return null; if (flag === '-O' || flag === '--output-document' || flag === '-P' || flag === '--directory-prefix') wrote = true; continue }
    if (WGET_READ.has(flag)) { const path = attached ?? values[++i]; if (path === undefined || !pathAllowed(path, context.cwd, context.roots, 'read', { posix: context.dialect === 'posix', strict: true })) return null; urls++; continue }
    if (WGET_VALUES.has(flag)) { if (attached === undefined) i++; continue }
    if (/^-{1,2}[a-zA-Z][\w-]*$/.test(flag) && attached === undefined) continue
    return null
  }
  if (!urls) return null
  if (!wrote && !cwdInProject(context)) return null
  return ['download']
}

function invokeWebRequest(values: string[], context: Context, bits: boolean): Verdict {
  let urls = 0
  const write = (path: string | undefined) => path !== undefined && pathAllowed(path, context.cwd, context.roots, 'write', { strict: true })
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    if (!value.startsWith('-')) { if (!/^(?:https?):\/\//i.test(value)) return null; urls++; continue }
    const lower = value.toLowerCase().replace(/:$/, '')
    if (IWR_DENY.has(lower)) return null
    if (lower === '-uri' || lower === '-source') { const url = values[++i]; if (!url || !/^https?:\/\//i.test(url)) return null; urls++; continue }
    if (lower === '-outfile' || lower === '-destination') { if (!write(values[++i])) return null; continue }
    if (lower === '-method') { if (!/^(?:get|head)$/i.test(values[++i] ?? '')) return null; continue }
    if (bits && lower === '-transfertype') { if (!/^download$/i.test(values[++i] ?? '')) return null; continue }
    if (bits && ['-description', '-displayname', '-priority', '-retryinterval', '-retrytimeout', '-maxdownloadtime', '-transferpolicy', '-proxyusage', '-proxylist', '-proxybypass'].includes(lower)) { i++; continue }
    if (bits && ['-asynchronous', '-suspended', '-dynamic', '-usestoredcredential'].includes(lower)) { if (lower === '-usestoredcredential') return null; continue }
    if (IWR_VALUES.has(lower)) { i++; continue }
    if (IWR_SWITCHES.has(lower)) continue
    return null
  }
  return urls ? ['download'] : null
}

/** One simple command, judged with the context it runs in (cwd, variables). */
function judgeSegment(segment: Segment, context: Context): Verdict {
  const { dialect } = context
  // PowerShell assignment: $x = …, $env:X = …
  if (dialect === 'powershell') {
    const assignment = /^\$((?:env:)?[A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(segment.text)
    if (assignment) {
      const name = assignment[1]!, rhs = assignment[2]!.trim()
      const parsed = parseSegment(rhs, dialect)
      if (!parsed) return null
      const literal = parsed.words.length === 1 && !parsed.redirects.length && (parsed.words[0]!.parts.every(part => part.quote) || /^-?\d+(?:\.\d+)?$|^\$(?:env:)?[A-Za-z_]\w*$/.test(parsed.words[0]!.raw))
      const key = name.toLowerCase().startsWith('env:') ? name.slice(4) : name
      const store = name.toLowerCase().startsWith('env:') ? context.env : context.vars
      if (literal || !rhs) {
        const value = rhs ? valueOf(parsed.words[0]!, context) : ''
        if (value !== undefined) store.set(name.toLowerCase().startsWith('env:') ? (WINDOWS ? key.toLowerCase() : key) : key.toLowerCase(), value)
        else store.delete(key.toLowerCase())
        return []
      }
      // $r = <command>: the command runs; the variable's value is unknown afterwards.
      store.delete(key.toLowerCase())
      return judgeSegment({ text: rhs, op: segment.op }, context)
    }
  }
  const parsed = parseSegment(segment.text, dialect)
  if (!parsed) return null
  let words = parsed.words
  let rule: ApprovalPolicyRule | undefined
  // Redirections write files: each target inside a writable root (or the null device).
  for (const redirect of parsed.redirects) {
    if (!redirect.target) continue
    const target = valueOf(redirect.target, context)
    if (target === undefined) return null
    if (redirect.op.startsWith('<')) { if (!pathAllowed(target, context.cwd, context.roots, 'read', { posix: dialect === 'posix', strict: true })) return null; continue }
    if (/^(?:nul|\/dev\/null|\$null)$/i.test(target) || target === '' ) continue
    if (!cwdInProject(context) && !isAbsolute(target)) return null
    if (!pathAllowed(target, context.cwd, context.roots, 'write', { posix: dialect === 'posix', strict: true })) return null
    rule = 'workspace-write'
  }
  // POSIX environment assignments before a command, and export.
  if (dialect === 'posix') {
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0]!.raw)) {
      const value = valueOf(words[0]!, context)
      if (value === undefined) return null
      const eq = value.indexOf('=')
      context.vars.set(value.slice(0, eq), value.slice(eq + 1))
      words = words.slice(1)
    }
    if (!words.length) return rule ? [rule] : []
  }
  if (!words.length) return rule ? [rule] : null
  let call = false
  if (dialect === 'powershell' && (words[0]!.raw === '&' || words[0]!.raw === '.')) { call = true; words = words.slice(1) }
  else if (dialect === 'powershell' && /^&\S/.test(words[0]!.raw)) {
    const [first, ...rest] = words[0]!.parts
    words = [{ raw: words[0]!.raw.slice(1), parts: first!.quote === '' ? (first!.text.length > 1 ? [{ text: first!.text.slice(1), quote: '' as const }, ...rest] : rest) : words[0]!.parts }, ...words.slice(1)]
    call = true
  }
  if (dialect === 'cmd' && words[0]!.raw.toLowerCase() === 'call') words = words.slice(1)
  if (!words.length) return null
  const values: string[] = []
  for (const word of words) { const value = valueOf(word, context); if (value === undefined) return null; values.push(value) }
  const program = values[0]!
  const args: string[] = []
  for (let i = 1; i < values.length; i++) {
    if (dialect === 'powershell' && /^-(?:erroraction|ea|warningaction|wa|informationaction|infa|errorvariable|ev|warningvariable|wv|informationvariable|iv|outvariable|ov|pipelinevariable|pv|outbuffer|ob|progressaction|proga)$/i.test(values[i]!)) { i++; continue }
    if (dialect === 'powershell' && /^-(?:confirm|whatif|verbose|debug)(?::\S*)?$/i.test(values[i]!)) continue
    args.push(values[i]!)
  }
  const name = programName(program)
  const posix = dialect === 'posix'
  const withRule = (verdict: Verdict): Verdict => verdict === null ? null : [...new Set([...verdict, ...(rule ? [rule] : [])])]

  if (!call && NAVIGATION.has(name)) {
    if (name === 'pop-location' || name === 'popd') { context.cwd = context.stack.pop() ?? context.cwd; return [] }
    const target = args.filter(arg => !isFlag(arg, dialect) || arg === '-').find(Boolean)
    const next = !target ? (posix ? homedir() : context.cwd) : target === '-' ? context.cwd : resolve(context.cwd, (posix ? msysPath(target) : target).replace(/^~(?=[\\/]|$)/, homedir()))
    if (name === 'push-location' || name === 'pushd') context.stack.push(context.cwd)
    context.cwd = next
    return withRule([])
  }
  if (dialect === 'cmd' && name === 'set') {
    const assignment = args.join(' ').replace(/^"(.*)"$/s, '$1')
    const eq = assignment.indexOf('=')
    if (eq <= 0 || /^\//.test(assignment)) return null
    context.env.set(WINDOWS ? assignment.slice(0, eq).toLowerCase() : assignment.slice(0, eq), assignment.slice(eq + 1))
    return withRule([])
  }
  if (posix && name === 'export') {
    for (const arg of args) { const eq = arg.indexOf('='); if (eq > 0) context.vars.set(arg.slice(0, eq), arg.slice(eq + 1)) }
    return withRule([])
  }
  if (!call && HARMLESS.has(name)) return withRule([])
  if (!call && (FILTERS.has(name) || READS.has(name))) {
    if (name === 'find' && !posix && dialect === 'cmd') return fileArguments(args.slice(1), context, 'read') ? withRule(['workspace-read']) : null
    if (args.some(arg => /^-(?:exec|execdir|delete|ok|okdir|fprint\w*|fls)$/.test(arg) || /^--pre(?:=|$)/.test(arg) || (name === 'sort' && /^(?:-o|--output|\/o)/i.test(arg)))) return null
    // Reading Blender's own install (finding blender.exe) is part of a Blender run.
    if (READS.has(name) && args.some(arg => !arg.startsWith('-') && blenderInstallPath(arg))) {
      return args.every(arg => arg.startsWith('-') || blenderInstallPath(arg) || pathAllowed(arg, context.cwd, context.roots, 'read', { posix, strict: true })) ? withRule(['blender']) : null
    }
    if (!cwdInProject(context) && args.filter(arg => !isFlag(arg, dialect)).length === 0 && READS.has(name)) return null
    const valued = new Set(['-filter', '-include', '-exclude', '-depth', '-encoding', '-totalcount', '-tail', '-head', '-first', '-last', '-skip', '-algorithm', '-pattern', '-property', '-delimiter', '-n', '-c', '-e', '-m', '-a', '-b', '-f', '-d', '-t', '-k', '--max-count', '--glob', '-g', '--type', '-A', '-B', '-C', '-expandproperty', '-index', '-childpath', '-additionalchildpath', '-qualifier', '-leaf', '-parent', '-erroraction', '-ea'])
    return fileArguments(args, context, 'read', valued) ? withRule(FILTERS.has(name) && !READS.has(name) && !args.some(arg => !isFlag(arg, dialect) && /[\\/.]/.test(arg)) ? [] : ['workspace-read']) : null
  }
  if (!call && (CREATE.has(name) || COPY.has(name) || MOVE.has(name) || REMOVE.has(name) || CONTENT.has(name) || ARCHIVES.has(name))) {
    if (!cwdInProject(context)) return null
    if (args.some(arg => /^-(?:itemtype|type)$/i.test(arg)) && args.some(arg => /^(?:symboliclink|junction|hardlink)$/i.test(arg))) return null
    if (args.some(arg => /^(?:-P|--absolute-names|--to-command.*|-I|--use-compress-program.*|--checkpoint-action.*|--rsh-command.*|--info-script.*|--new-volume-script.*)$/.test(arg))) return null
    if (name === 'tar' && args.some(arg => /^-[a-zA-Z]*[PI][a-zA-Z]*$/.test(arg))) return null
    if (REMOVE.has(name)) {
      const recursive = args.some(arg => /^-{1,2}r/i.test(arg) || (posix && /^-[a-z]*r/i.test(arg)) || /^\/s$/i.test(arg))
      const targets = args.filter(arg => !isFlag(arg, dialect))
      if (!targets.length) return null
      for (const target of targets) {
        if (!pathAllowed(target, context.cwd, context.roots, 'delete', { posix, strict: true })) return null
        if ((recursive || /[*?[]/.test(target)) && !disposableTarget(target, context.cwd, context.roots, posix)) return null
      }
      return withRule(['workspace-write'])
    }
    const valued = new Set(['-value', '-encoding', '-itemtype', '-type', '-name', '-filter', '-include', '-exclude', '-delimiter', '-compressionlevel', '-inputobject', '-width'])
    const access: Access = MOVE.has(name) ? 'delete' : 'write'
    if (MOVE.has(name) || COPY.has(name)) {
      // Sources and destination alike: inside a writable root; a move's source is a deletion.
      const paths = args.filter(arg => !isFlag(arg, dialect))
      if (!paths.length) return null
      for (const [index, path] of paths.entries()) {
        const last = index === paths.length - 1 && paths.length > 1
        if (!pathAllowed(path, context.cwd, context.roots, last ? 'write' : access, { posix, strict: true })) return null
      }
      return withRule(['workspace-write'])
    }
    // Set-Content -Value text: the text is not a path.
    const filtered: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (/^-(?:value|inputobject)$/i.test(args[i]!)) { i++; continue }
      filtered.push(args[i]!)
    }
    return fileArguments(filtered, context, 'write', valued) ? withRule(['workspace-write']) : null
  }
  {
    if (DOWNLOADERS.has(name) || name === 'curl.exe' || name === 'wget.exe') {
      const powershellStyle = name === 'invoke-webrequest' || name === 'iwr' || name === 'invoke-restmethod' || name === 'irm' || name === 'start-bitstransfer'
        || (dialect === 'powershell' && !/\.exe$/i.test(program) && (name === 'curl' || name === 'wget') && args.some(arg => /^-(?:uri|outfile|usebasicparsing|method|headers|useragent|timeoutsec)$/i.test(arg)))
      const verdict = powershellStyle ? invokeWebRequest(args, context, name === 'start-bitstransfer') : name === 'wget' ? wget(args, context) : curl(args, context)
      return withRule(verdict)
    }
    if (PIP.test(name)) {
      const venv = /[\\/]/.test(program) && inside(context.roots.project, canonical(resolve(context.cwd, posix ? msysPath(program) : program)))
      if (/[\\/]/.test(program) && !venv && !isAbsolute(program) && !/^[a-z]:/i.test(program)) return null
      if (!cwdInProject(context)) return null
      return withRule(pip(args, context, venv))
    }
    if (PYTHON.test(name)) {
      if (!cwdInProject(context)) return null
      return withRule(pythonRun(program, args, context, blenderInstallPath(program)))
    }
    if (name === 'blender') {
      if (!cwdInProject(context)) return null
      if (/[\\/]/.test(program) && !isAbsolute(program) && !/^[a-z]:/i.test(program) && !pathAllowed(program, context.cwd, context.roots, 'read', { posix })) return null
      return withRule(blenderRun(args, context))
    }
    if ((name === 'bash' || name === 'sh' || name === 'zsh') && args[0] && !args[0].startsWith('-')) {
      if (!cwdInProject(context) || !SCRIPT_EXTENSION.test(args[0]) || !pathAllowed(args[0], context.cwd, context.roots, 'write', { posix: true })) return null
      return programArguments(args.slice(1), context) ? withRule(['project-script']) : null
    }
    if (SCRIPT_EXTENSION.test(program)) {
      if (!cwdInProject(context) || !pathAllowed(program, context.cwd, context.roots, 'write', { posix })) return null
      return programArguments(args, context) ? withRule(['project-script']) : null
    }
  }
  return null
}

function judgeCommand(command: string, hint: Dialect | undefined, roots: Roots, cwd: string): ApprovalPolicyRule[] | null {
  if (!command.trim() || command.length > 16_000) return null
  // Codex doubles the separators of a Windows command line (C:\\WINDOWS\\…).
  const text = WINDOWS ? command.replace(/\\{2,}/g, '\\') : command
  const unwrapped = unwrap(text, hint)
  if (!unwrapped || !unwrapped.body.trim()) return null
  const segments = splitSegments(unwrapped.body, unwrapped.dialect)
  if (!segments?.length || segments.length > 40) return null
  const context: Context = { roots, cwd, stack: [], dialect: unwrapped.dialect, vars: new Map(), env: new Map() }
  const rules = new Set<ApprovalPolicyRule>()
  for (const segment of segments) {
    const verdict = judgeSegment(segment, context)
    if (!verdict) return null
    for (const rule of verdict) rules.add(rule)
  }
  return rules.size ? [...rules] : ['workspace-read']
}

/**
 * Whether the owner's auto-approve policy answers this request, and under which rule (several
 * joined with "+" when a command combines classes). null leaves it to the normal path: the
 * runtime's own Auto, the stronger review, the wizard, the owner's card.
 */
export function evaluateApprovalPolicy(req: PolicyRequest, policy: ApprovalPolicySettings = currentApprovalPolicy()): PolicyDecision {
  try {
    if (!policy?.enabled || !req || req.nativeOwner) return null
    const roots = rootsOf(req.projectRoot, policy)
    if (!roots) return null
    const cwd = req.cwd && isAbsolute(req.cwd) ? req.cwd : resolve(req.projectRoot, req.cwd || '.')
    let rules: ApprovalPolicyRule[] | null
    if (req.kind === 'file-read' || req.kind === 'file-write') {
      const paths = (req.paths ?? []).filter(path => typeof path === 'string')
      if (!paths.length || paths.length > 100) return null
      const access: Access = req.kind === 'file-read' ? 'read' : 'write'
      if (!paths.every(path => pathAllowed(path, cwd, roots, access, { strict: true }))) return null
      rules = [req.kind === 'file-read' ? 'workspace-read' : 'workspace-write']
    } else if (req.kind === 'command' || req.kind === 'network') {
      if (typeof req.command !== 'string') return null
      rules = judgeCommand(req.command, req.shell, roots, cwd)
    } else return null
    if (!rules?.length || !rules.every(rule => policy.rules[rule] !== false)) return null
    return { decision: 'allow', rule: RULE_ORDER.filter(rule => rules!.includes(rule)).join('+') }
  } catch { return null }
}

// ---------------------------------------------------------------------------------------------
// The record of what the policy answered: answeredBy "policy" with the rule, per request. Like the
// approval journal it keeps no raw arguments (a digest only); the conversation's own timeline shows
// the command. Bounded, kept in memory and written at most every couple of seconds, because Claude's
// PreToolUse hook asks it on every tool call.

export interface PolicyAnswer { at: string; answeredBy: 'policy'; rule: string; provider: string; kind: string; tool: string; projectId: string; workerId: string; runtimeId: string; requestId: string; digest: string }
interface PolicyLogState { total: number; byRule: Record<string, number>; recent: PolicyAnswer[] }
export const APPROVAL_POLICY_LOG = 'approvalPolicyLog:v1'
const POLICY_LOG_LIMIT = 300
interface Persistence { getSetting(key: string): string | null; setSetting(key: string, value: string): void }

export class PolicyAnswerLog {
  private state?: PolicyLogState
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly persistence: Persistence, private readonly delayMs = 2000) {}
  private load(): PolicyLogState {
    if (this.state) return this.state
    let state: PolicyLogState = { total: 0, byRule: {}, recent: [] }
    try {
      const saved = JSON.parse(this.persistence.getSetting(APPROVAL_POLICY_LOG) ?? 'null') as Partial<PolicyLogState> | null
      if (saved && typeof saved.total === 'number' && Array.isArray(saved.recent)) state = { total: saved.total, byRule: saved.byRule && typeof saved.byRule === 'object' ? saved.byRule : {}, recent: saved.recent.slice(-POLICY_LOG_LIMIT) }
    } catch { /* an unreadable log starts over */ }
    return this.state = state
  }
  record(answer: Omit<PolicyAnswer, 'at' | 'answeredBy' | 'digest'> & { input: Json }): PolicyAnswer {
    const state = this.load()
    const { input, ...rest } = answer
    const entry: PolicyAnswer = { at: new Date().toISOString(), answeredBy: 'policy', ...rest, digest: createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 16) }
    state.total++
    state.byRule[entry.rule] = (state.byRule[entry.rule] ?? 0) + 1
    state.recent.push(entry)
    if (state.recent.length > POLICY_LOG_LIMIT) state.recent.splice(0, state.recent.length - POLICY_LOG_LIMIT)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        // A store closed meanwhile (the app quitting, a test's database) already took its last flush.
        try { this.flush() } catch (error) { if (!/not open|closed/i.test(error instanceof Error ? error.message : '')) console.warn('The auto-approve policy log could not be saved', error) }
      }, this.delayMs)
      this.timer.unref?.()
    }
    return entry
  }
  /** How many requests the policy answered (by rule) and the latest answers, newest first. */
  summary(limit = 20): { total: number; byRule: Record<string, number>; recent: PolicyAnswer[] } {
    const state = this.load()
    return { total: state.total, byRule: { ...state.byRule }, recent: state.recent.slice(-limit).reverse() }
  }
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.state) this.persistence.setSetting(APPROVAL_POLICY_LOG, JSON.stringify(this.state))
  }
}
const logs = new WeakMap<object, PolicyAnswerLog>()
/** The one log per settings store, shared by the adapters' host and the approval sweep. */
export function policyAnswerLog(persistence: Persistence): PolicyAnswerLog {
  let log = logs.get(persistence)
  if (!log) logs.set(persistence, log = new PolicyAnswerLog(persistence))
  return log
}

/** The policy as approvals.policy.get shows it: each class with what it covers, the writable roots
 *  as configured and as expanded, who set it, and (for the owner or a wizard) what it answered. */
export function describeApprovalPolicy(policy: ApprovalPolicySettings, answered?: ReturnType<PolicyAnswerLog['summary']>): Record<string, Json> {
  return {
    enabled: policy.enabled,
    rules: APPROVAL_POLICY_RULES.map(rule => ({ rule, on: policy.rules[rule] !== false, covers: APPROVAL_POLICY_RULE_TEXT[rule] })),
    writableRoots: policy.writableRoots.map(root => ({ root, path: expandEnvironment(root) ?? null })),
    ...(policy.setBy ? { setBy: policy.setBy } : {}), ...(policy.setAt ? { setAt: policy.setAt } : {}),
    never: 'a native-owner action (an owner ask rule, a mandatory approval, an owner-only reach), a plan or read-only conversation, a write or program argument outside the project and the writable roots, agent configuration or credentials, git, elevation, the registry, uploads, links, or a nested project',
    ...(answered ? { answered: answered as unknown as Json } : {})
  }
}

/** What the policy covered, for a notice or the approval journal. */
export function policyRationale(rule: string): string {
  const texts = rule.split('+').map(name => APPROVAL_POLICY_RULE_TEXT[name as ApprovalPolicyRule]).filter(Boolean)
  return `the owner's auto-approve policy (${rule}: ${texts.join('; ')})`
}

/** The notice an adapter shows instead of a card when the policy answered a request. */
export function policyNotice(subject: string, rule: string): { message: string; payload: Json } {
  const line = subject.replace(/\s+/g, ' ').trim()
  return { message: `Allowed by the auto-approve policy (${rule}): ${line.length > 300 ? line.slice(0, 300) + '…' : line}`, payload: { approvalPolicy: { rule } } }
}

const object = (value: unknown): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {}
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * The policy request for a pending native approval, from the tool (Claude) or the native method
 * (Codex) and its input; undefined when the request is not one the policy reads.
 */
export function policyRequestFor(source: { provider: string; tool?: string; nativeMethod?: string; input: Json; cwd: string; projectRoot: string; nativeOwner?: boolean }): PolicyRequest | undefined {
  const input = object(source.input)
  const base = { provider: source.provider, cwd: source.cwd, projectRoot: source.projectRoot, ...(source.nativeOwner ? { nativeOwner: true } : {}) }
  if (source.nativeMethod === 'item/commandExecution/requestApproval') {
    const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) && input.command.every(part => typeof part === 'string') ? (input.command as string[]).map(part => /\s/.test(part) ? `"${part}"` : part).join(' ') : undefined
    if (!command) return undefined
    return { ...base, kind: input.networkApprovalContext ? 'network' : 'command', command, cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : source.cwd }
  }
  if (source.nativeMethod === 'item/fileChange/requestApproval') return typeof input.grantRoot === 'string' && input.grantRoot ? { ...base, kind: 'file-write', paths: [input.grantRoot] } : undefined
  if (source.nativeMethod && source.nativeMethod !== 'can_use_tool') return undefined
  const tool = source.tool ?? ''
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : undefined
    return command ? { ...base, kind: 'command', command, shell: tool === 'Bash' ? 'posix' : 'powershell' } : undefined
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path
    return typeof path === 'string' && path ? { ...base, kind: 'file-write', paths: [path] } : undefined
  }
  if (READ_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path ?? input.path
    if (path !== undefined && typeof path !== 'string') return undefined
    // A Glob or Grep pattern can name its own root: only a relative one stays in the workspace.
    for (const key of ['pattern', 'glob'] as const) {
      const value = input[key]
      if (typeof value === 'string' && tool !== 'Grep' && (/^(?:[\\/~]|[a-z]:)/i.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value))) return undefined
      if (key === 'glob' && typeof value === 'string' && (/^(?:[\\/~]|[a-z]:)/i.test(value) || value.includes('..'))) return undefined
    }
    return { ...base, kind: 'file-read', paths: [typeof path === 'string' && path ? path : source.cwd] }
  }
  return undefined
}
