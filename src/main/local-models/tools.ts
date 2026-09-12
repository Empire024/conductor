import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ToolSpec } from './client.ts'
import type { DockerSandbox } from './sandbox.ts'
import { SandboxUnavailableError } from './sandbox.ts'
import { isSecretPath, resolveInWorkspace, resolveWritablePath, SecretPathError, WorkspaceBoundaryError } from './workspace.ts'

/** The complete capability set a local model is given. It is an allowlist in code, not an
 *  instruction in a prompt: a name that is not in this list cannot be dispatched at all, which
 *  is what keeps host shell tools, browser automation, connectors, credentials and every other
 *  Conductor capability out of reach of a model whose output may be prompt-injected. */
export const LOCAL_TOOLS = ['read_file', 'list_files', 'search', 'write_file', 'edit_file', 'run_command'] as const
export type LocalToolName = (typeof LOCAL_TOOLS)[number]
const MUTATING: ReadonlySet<string> = new Set<string>(['write_file', 'edit_file', 'run_command'])

export class ToolPolicyError extends Error {}

export function assertToolAllowed(name: string, readOnly: boolean): asserts name is LocalToolName {
  if (!(LOCAL_TOOLS as readonly string[]).includes(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is not available to local models`)
  if (readOnly && MUTATING.has(name)) throw new ToolPolicyError(`Tool denied by policy: ${name} is unavailable in read-only mode`)
}

const MAX_READ_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_SEARCH_HITS = 200
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.venv', 'venv', '__pycache__', '.next', 'target'])

export function toolSpecs(readOnly: boolean): ToolSpec[] {
  const specs: ToolSpec[] = [
    { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path, for example src/main/index.ts' }, offset: { type: 'integer', description: 'First line to return (1-based).' }, limit: { type: 'integer', description: 'Maximum number of lines to return.' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_files', description: 'List the entries of a workspace directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative directory; defaults to the workspace root.' } } } } },
    { type: 'function', function: { name: 'search', description: 'Search workspace file contents with a regular expression.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript regular expression.' }, path: { type: 'string', description: 'Workspace-relative directory to search.' }, glob: { type: 'string', description: 'Only search files whose name ends with this suffix, for example .ts' } }, required: ['pattern'] } } }
  ]
  if (readOnly) return specs
  return [
    ...specs,
    { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'edit_file', description: 'Replace an exact string in a workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] } } },
    { type: 'function', function: { name: 'run_command', description: 'Run a shell command inside the isolated Linux sandbox container. The workspace is mounted at /workspace. There is no network access.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_sec: { type: 'integer' } }, required: ['command'] } } }
  ]
}

export interface ToolContext {
  workspace: string
  readOnly: boolean
  sandbox: DockerSandbox | null
  timeoutSec: number
  beforeTool?(paths: string[]): Promise<void>
  afterTool?(paths: string[], success: boolean): Promise<void>
}

export interface ToolOutcome { output: string; failed: boolean; paths: string[] }

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
    assertToolAllowed(name, context.readOnly)
    const args = argumentsOf(rawArguments)
    switch (name) {
      case 'read_file': {
        const { path, relative: rel } = await resolveInWorkspace(context.workspace, text(args.path, 'path'))
        const info = await stat(path)
        if (!info.isFile()) return { output: `${rel} is not a file`, failed: true, paths: [] }
        if (info.size > MAX_READ_BYTES) return { output: `${rel} is ${info.size} bytes; read a smaller file or use search`, failed: true, paths: [] }
        const content = await readFile(path, 'utf8')
        const offset = Math.max(1, integer(args.offset, 1))
        const limit = Math.max(1, Math.min(integer(args.limit, 2000), 4000))
        const lines = content.split('\n').slice(offset - 1, offset - 1 + limit)
        return { output: lines.join('\n') || '(empty file)', failed: false, paths: [path] }
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
        const { path, relative: rel } = await resolveWritablePath(context.workspace, text(args.path, 'path'))
        await context.beforeTool?.([path])
        await mkdir(join(path, '..'), { recursive: true })
        await writeFile(path, content, 'utf8')
        await context.afterTool?.([path], true)
        return { output: `wrote ${rel} (${content.length} characters)`, failed: false, paths: [path] }
      }
      case 'edit_file': {
        const oldText = text(args.old_text, 'old_text')
        const newText = text(args.new_text, 'new_text')
        const { path, relative: rel } = await resolveWritablePath(context.workspace, text(args.path, 'path'))
        const before = await readFile(path, 'utf8')
        const occurrences = before.split(oldText).length - 1
        if (!occurrences) return { output: `old_text was not found in ${rel}`, failed: true, paths: [] }
        if (occurrences > 1 && args.replace_all !== true) return { output: `old_text appears ${occurrences} times in ${rel}; pass replace_all or use a longer unique snippet`, failed: true, paths: [] }
        await context.beforeTool?.([path])
        await writeFile(path, args.replace_all === true ? before.split(oldText).join(newText) : before.replace(oldText, newText), 'utf8')
        await context.afterTool?.([path], true)
        return { output: `edited ${rel} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`, failed: false, paths: [path] }
      }
      case 'run_command': {
        const command = text(args.command, 'command')
        if (!context.sandbox) throw new SandboxUnavailableError('Sandbox unavailable: command execution is disabled without the Docker sandbox')
        const result = await context.sandbox.exec(command, Math.max(1, Math.min(integer(args.timeout_sec, context.timeoutSec), context.timeoutSec)))
        const parts = [
          result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
          result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
          result.timedOut ? 'command exceeded its time limit and was terminated' : '',
          result.truncated ? 'output was truncated at the sandbox limit' : '',
          `exit code: ${result.exitCode}`
        ].filter(Boolean)
        return { output: parts.join('\n\n'), failed: result.exitCode !== 0, paths: [] }
      }
      default:
        throw new ToolPolicyError(`Tool denied by policy: ${name}`)
    }
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) return { output: `denied: path outside workspace (${error.message})`, failed: true, paths: [] }
    if (error instanceof SecretPathError) return { output: `denied: ${error.message}`, failed: true, paths: [] }
    if (error instanceof ToolPolicyError) return { output: `denied: ${error.message}`, failed: true, paths: [] }
    if (error instanceof SandboxUnavailableError) return { output: `denied: ${error.message}`, failed: true, paths: [] }
    return { output: `error: ${error instanceof Error ? error.message : 'tool failed'}`, failed: true, paths: [] }
  }
}
