import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isSecretPath } from '../local-models/workspace.ts'
import type { LocalAssistTool, LocalModelOutcome, LocalModelRunner, SavingsLedger } from './contract.ts'
import { capLines, failureLines, modelExcerpt, splitLines, stripAnsi, tailLines } from './digest.ts'

/** The conversation a call belongs to, read live on every call: a permission the owner lowers
 *  mid-conversation applies to the next call. */
export interface LocalAssistSession {
  projectId: string
  sessionId: string
  agentSessionId: string
  provider: string
  cwd: string
  permission: 'default' | 'read-only' | 'accept-edits' | 'auto'
  plan: boolean
}

export interface CommandRun { exitCode: number | null; durationMs: number; timedOut: boolean; outputChars: number }
export type CommandRunner = (request: { command: string; cwd: string; logFile: string; timeoutMs: number; signal?: AbortSignal }) => Promise<CommandRun>

export interface LocalAssistDeps {
  session(agentSessionId: string): LocalAssistSession | undefined
  runner: LocalModelRunner
  ledger: SavingsLedger
  run?: CommandRunner
  /** Reads a log back; injectable for tests. */
  readText?: (file: string, maxBytes: number) => Promise<string>
  now?: () => Date
}

export interface LocalAssistResult { text: string; structured: Record<string, unknown> }

/** Raw lines returned verbatim with every summary, so nothing critical depends only on the model. */
const RAW_TAIL = 15
/** Characters of log or file the local model reads in one call: its 32k-token context has to
 *  hold this, the instructions and the answer. */
const MODEL_INPUT_CHARS = 60_000
const MAX_FILE_BYTES = 512 * 1024
const MAX_FILES = 12
const MAX_LOG_READ = 16 * 1024 * 1024
const DEFAULT_TIMEOUT_SEC = 600
const MAX_TIMEOUT_SEC = 1800

const text = (args: Record<string, unknown>, key: string, limit: number, optional = false): string | undefined => {
  const value = args[key]
  if (value === undefined || value === null) { if (optional) return undefined; throw new Error(`Provide ${key} as a non-empty string`) }
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  if (value.length > limit) throw new Error(`${key} is longer than ${limit} characters`)
  return value
}
const count = (args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number => {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return Math.min(max, Math.max(min, Math.floor(value)))
}

const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** A project file the caller may hand the local model: inside the conversation's directory after
 *  links are resolved, and never a credential file. */
export async function projectFile(cwd: string, requested: string): Promise<{ path: string; relative: string }> {
  const root = await realpath(cwd)
  const path = await realpath(resolve(root, requested)).catch(() => { throw new Error(`${requested} does not exist`) })
  if (!inside(root, path)) throw new Error(`${requested} is outside this conversation's project directory`)
  const rel = relative(root, path).split(sep).join('/')
  if (isSecretPath(rel)) throw new Error(`${requested} looks like a credential file and is never sent to a model`)
  if (!(await stat(path)).isFile()) throw new Error(`${requested} is not a file`)
  return { path, relative: rel }
}

async function readHead(file: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    if (buffer.subarray(0, Math.min(length, 8000)).includes(0)) throw new Error('is a binary file')
    return { text: buffer.toString('utf8'), bytes: size, truncated: size > maxBytes }
  } finally { await handle.close() }
}

/** The log of a long run: its head and its tail when it is larger than maxBytes. */
async function readLog(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    if (size <= maxBytes) { const buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, 0); return buffer.toString('utf8') }
    const headBytes = Math.floor(maxBytes / 8), tailBytes = maxBytes - headBytes
    const head = Buffer.alloc(headBytes), tail = Buffer.alloc(tailBytes)
    await handle.read(head, 0, headBytes, 0)
    await handle.read(tail, 0, tailBytes, size - tailBytes)
    return `${head.toString('utf8')}\n… ${size - maxBytes} bytes omitted …\n${tail.toString('utf8')}`
  } finally { await handle.close() }
}

/** Runs a command on the host with the owner's own shell semantics, streaming everything it
 *  prints to the log file. A timeout kills the whole process tree. */
export const hostCommandRunner: CommandRunner = ({ command, cwd, logFile, timeoutMs, signal }) => new Promise(done => {
  const started = Date.now()
  const log = createWriteStream(logFile)
  let outputChars = 0, timedOut = false, settled = false
  const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' } })
  const write = (chunk: Buffer): void => { outputChars += chunk.length; log.write(chunk) }
  child.stdout?.on('data', write)
  child.stderr?.on('data', write)
  const kill = (): void => {
    if (child.pid === undefined || child.exitCode !== null) return
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined)
    else child.kill('SIGKILL')
  }
  const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
  const abort = (): void => kill()
  signal?.addEventListener('abort', abort, { once: true })
  const finish = (exitCode: number | null, error?: Error): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (error) log.write(`\n[conductor] the command could not start: ${error.message}\n`)
    log.end(() => done({ exitCode, durationMs: Date.now() - started, timedOut, outputChars }))
  }
  child.on('error', error => finish(null, error))
  child.on('close', code => finish(code))
})

const SUMMARY_SYSTEM = 'You summarise command output for a busy engineer who will not read the log. Be exact and terse. Report only what the output shows; never guess. No preamble.'
const ASK_SYSTEM = 'You answer questions about the files provided, for an engineer who will not read them. Be exact and terse; cite file:line where you can. If the files do not contain the answer, say so. No preamble.'

export class LocalAssistTools {
  private readonly run: CommandRunner
  private readonly readText: (file: string, maxBytes: number) => Promise<string>
  private readonly now: () => Date
  constructor(private readonly deps: LocalAssistDeps) {
    this.run = deps.run ?? hostCommandRunner
    this.readText = deps.readText ?? readLog
    this.now = deps.now ?? (() => new Date())
  }

  private session(agentSessionId: string): LocalAssistSession {
    const session = this.deps.session(agentSessionId)
    if (!session) throw new Error('This conversation is no longer open in Conductor')
    return session
  }

  private record(session: LocalAssistSession, tool: LocalAssistTool, rawChars: number, returnedChars: number, outcome: LocalModelOutcome | undefined): void {
    const answer = outcome?.ok ? outcome.answer : undefined
    this.deps.ledger.record({ tool, projectId: session.projectId, agentSessionId: session.agentSessionId, provider: session.provider, rawChars, returnedChars, localInputTokens: answer?.inputTokens ?? 0, localOutputTokens: answer?.outputTokens ?? 0, usedModel: Boolean(answer), ...(answer ? { model: answer.model } : {}) })
  }

  /** run_and_summarize. Only for a conversation already allowed to run shell commands on its
   *  own (Auto): the tool must never be a way around a permission the owner set. */
  async runAndSummarize(agentSessionId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<LocalAssistResult> {
    const session = this.session(agentSessionId)
    if (session.permission !== 'auto' || session.plan) throw new Error(`run_and_summarize runs commands on the host, so it is only available to a conversation in Auto (this one is ${session.plan ? 'planning' : session.permission}). Run the command with your own shell tool instead.`)
    const command = text(args, 'command', 8000)!
    if (command.includes('\0')) throw new Error('command contains a NUL byte')
    const question = text(args, 'question', 2000, true)
    const maxLines = count(args, 'maxLines', 30, 3, 200)
    const timeoutSec = count(args, 'timeoutSec', DEFAULT_TIMEOUT_SEC, 5, MAX_TIMEOUT_SEC)
    const cwd = args.cwd === undefined ? session.cwd : (await this.directory(session.cwd, text(args, 'cwd', 1000)!))
    const scratch = join(session.cwd, '.conductor-scratch', 'local-assist')
    mkdirSync(scratch, { recursive: true })
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const logFile = join(scratch, `${stamp}-${randomBytes(3).toString('hex')}.log`)
    const run = await this.run({ command, cwd, logFile, timeoutMs: timeoutSec * 1000, signal })
    const raw = stripAnsi(await this.readText(logFile, MAX_LOG_READ).catch(() => ''))
    const lines = splitLines(raw)
    const logPath = relative(session.cwd, logFile).split(sep).join('/')
    const status = run.timedOut ? `timed out after ${timeoutSec} s (process tree killed)` : `exit ${run.exitCode ?? 'none'}`
    const header = `${status} · ${(run.durationMs / 1000).toFixed(1)} s · ${lines.length} lines, ${run.outputChars} bytes · full log: ${logPath}`
    const tail = tailLines(lines, RAW_TAIL)
    let outcome: LocalModelOutcome | undefined
    let summary: string
    if (!lines.length) summary = '(the command printed nothing)'
    else if (lines.length <= RAW_TAIL) summary = ''
    else {
      outcome = await this.deps.runner.ask({
        system: SUMMARY_SYSTEM,
        user: `Command: ${command}\nResult: ${status}\n${question ? `Question: ${question}\n` : ''}\nIn at most ${maxLines} lines: ${question ? 'answer the question, then ' : ''}say whether it passed; for each failure give the test or check name, file:line and the first error line, quoting them exactly. Skip passing items.\n\nOutput:\n${modelExcerpt(lines, MODEL_INPUT_CHARS)}`,
        maxTokens: Math.min(2048, maxLines * 40),
        signal
      })
      summary = outcome.ok
        ? `Summary (${outcome.answer.model}, local):\n${capLines(outcome.answer.text, maxLines)}`
        : [`Local summary unavailable: ${outcome.reason}.`, ...(() => { const found = failureLines(lines, maxLines); return found.length ? ['Failure-looking lines (pattern match, not the model):', ...found] : [] })()].join('\n')
    }
    const body = [header, summary, `Last ${tail.length} lines (verbatim):`, ...tail].filter(Boolean).join('\n')
    this.record(session, 'run_and_summarize', raw.length, body.length, outcome)
    return { text: body, structured: { exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs, logPath, lines: lines.length, summarized: Boolean(outcome?.ok) } }
  }

  private async directory(root: string, requested: string): Promise<string> {
    const base = await realpath(root)
    const path = await realpath(resolve(base, requested)).catch(() => { throw new Error(`${requested} does not exist`) })
    if (!inside(base, path)) throw new Error(`cwd ${requested} is outside this conversation's project directory`)
    if (!(await stat(path)).isDirectory()) throw new Error(`cwd ${requested} is not a directory`)
    return path
  }

  /** local_ask / summarize_file: read project files on the host and have the local model answer. */
  async ask(agentSessionId: string, args: Record<string, unknown>, tool: 'local_ask' | 'summarize_file' = 'local_ask', signal?: AbortSignal): Promise<LocalAssistResult> {
    const session = this.session(agentSessionId)
    const prompt = text(args, 'prompt', 8000)!
    const maxLines = count(args, 'maxLines', 30, 3, 200)
    const requested = args.files === undefined ? [] : args.files
    if (!Array.isArray(requested) || requested.some(entry => typeof entry !== 'string' || !entry.trim() || entry.length > 1000)) throw new Error('files must be a list of project-relative paths')
    if (requested.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files per call`)
    const files: Array<{ relative: string; text: string; bytes: number; truncated: boolean }> = []
    for (const entry of requested as string[]) {
      const file = await projectFile(session.cwd, entry)
      const read = await readHead(file.path, MAX_FILE_BYTES).catch(error => { throw new Error(`${entry} ${error instanceof Error ? error.message : 'could not be read'}`) })
      files.push({ relative: file.relative, ...read })
    }
    const rawChars = files.reduce((sum, file) => sum + file.text.length, 0)
    // Share the model's input budget across the files; a file over its share keeps its head and tail.
    const share = files.length ? Math.floor(MODEL_INPUT_CHARS / files.length) : 0
    const material = files.map(file => {
      const numbered = splitLines(file.text).map((line, index) => `${index + 1}: ${line}`)
      const body = modelExcerpt(numbered, share)
      return `=== ${file.relative} (${file.bytes} bytes${file.truncated ? `, first ${MAX_FILE_BYTES} read` : ''}) ===\n${body}`
    }).join('\n\n')
    const outcome = await this.deps.runner.ask({
      system: ASK_SYSTEM,
      user: `${prompt}\n\nAnswer in at most ${maxLines} lines.${material ? `\n\nFiles (line numbers prefixed):\n${material}` : ''}`,
      maxTokens: Math.min(2048, maxLines * 40),
      signal
    })
    const listing = files.map(file => `${file.relative} (${file.bytes} bytes)`).join(', ')
    const body = outcome.ok
      ? `${capLines(outcome.answer.text, maxLines)}\n— ${outcome.answer.model}, local${listing ? `, over ${listing}` : ''}`
      : `Local model unavailable: ${outcome.reason}. Nothing was summarised; read ${listing || 'the files'} yourself or call again shortly.`
    this.record(session, tool, outcome.ok ? rawChars : 0, body.length, outcome)
    return { text: body, structured: { answered: outcome.ok, files: files.map(file => ({ path: file.relative, bytes: file.bytes, truncated: file.truncated })) } }
  }

  summarizeFile(agentSessionId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<LocalAssistResult> {
    const path = text(args, 'path', 1000)!
    const question = text(args, 'question', 2000, true)
    const maxLines = args.maxLines
    return this.ask(agentSessionId, { prompt: question ?? 'Summarise this file: its purpose, its main parts with line numbers, and anything unusual.', files: [path], ...(maxLines === undefined ? {} : { maxLines }) }, 'summarize_file', signal)
  }
}

const schema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })

export interface LocalAssistToolSpec {
  name: LocalAssistTool
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
  call(tools: LocalAssistTools, agentSessionId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<LocalAssistResult>
}

export const LOCAL_ASSIST_TOOLS: LocalAssistToolSpec[] = [
  {
    name: 'run_and_summarize',
    description: 'Run a shell command (tests, builds, linters) on this machine in the project directory, save the full output to a log, and return exit code, duration, log path, a local-model summary focused on failures (test names, file:line, first error) and the last 15 raw lines. Use it instead of reading long test/build output. Auto mode only.',
    inputSchema: schema({
      command: { type: 'string', description: 'The command, as you would type it in the project directory.' },
      cwd: { type: 'string', description: 'Optional directory inside the project to run in.' },
      question: { type: 'string', description: 'Optional: what you want to know from the output.' },
      maxLines: { type: 'number', description: 'Most summary lines to return (default 30).' },
      timeoutSec: { type: 'number', description: 'Kill the command after this many seconds (default 600, max 1800).' }
    }, ['command']),
    call: (tools, id, args, signal) => tools.runAndSummarize(id, args, signal)
  },
  {
    name: 'local_ask',
    annotations: { readOnlyHint: true },
    description: 'Have the local model read project files and answer: summarise, extract, classify, or find where something happens. Returns a short answer with file:line references instead of the file contents. Use it for large files you would otherwise read whole.',
    inputSchema: schema({
      prompt: { type: 'string', description: 'The question or instruction.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Project-relative paths to read (up to 12; each capped at 512 KB).' },
      maxLines: { type: 'number', description: 'Most answer lines (default 30).' }
    }, ['prompt']),
    call: (tools, id, args, signal) => tools.ask(id, args, 'local_ask', signal)
  },
  {
    name: 'summarize_file',
    annotations: { readOnlyHint: true },
    description: 'Have the local model summarise one project file, or answer a question about it, with line numbers.',
    inputSchema: schema({
      path: { type: 'string', description: 'Project-relative path.' },
      question: { type: 'string', description: 'Optional question about the file.' },
      maxLines: { type: 'number', description: 'Most answer lines (default 30).' }
    }, ['path']),
    call: (tools, id, args, signal) => tools.summarizeFile(id, args, signal)
  }
]
