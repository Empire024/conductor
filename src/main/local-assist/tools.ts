import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isSecretPath } from '../local-models/workspace.ts'
import type { LocalAssistTool, LocalModelOutcome, LocalModelRunner, SavingsLedger } from './contract.ts'
import { capLines, chunkLines, clip, failureLines, modelExcerpt, splitLines, stripAnsi, tailLines } from './digest.ts'

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
  /** Injectable for tests: real setTimeout-based by default. */
  sleep?: (ms: number) => Promise<void>
}

export interface LocalAssistResult { text: string; structured: Record<string, unknown> }

/** Raw lines returned verbatim with every summary, so nothing critical depends only on the model. */
const RAW_TAIL = 15
/** Characters of log or file the local model reads in one call: its 32k-token context has to
 *  hold this, the instructions and the answer. */
const MODEL_INPUT_CHARS = 60_000
/** Raised from 512 KB: at the old cap a needle past it was never read at all (never mind
 *  answered), which is worse than the truncation note this cap still leaves for anything beyond
 *  it. 1.5 MB comfortably covers a single large source or log file while keeping the chunked
 *  map-reduce below (chunkLines / MAX_ASK_CHUNKS) to a bounded number of local model calls. */
const MAX_FILE_BYTES = 1536 * 1024
const MAX_FILES = 12
/** Local model round trips one `local_ask`/`summarize_file` call will make over one file's
 *  content before it stops and says how much it actually examined. */
const MAX_ASK_CHUNKS = 24
const MAX_LOG_READ = 16 * 1024 * 1024
/** The command's own kill bound when the caller does not name one: generous, so a real test suite
 *  is not truncated. */
const DEFAULT_KILL_SEC = 600
const MAX_TIMEOUT_SEC = 1800
/** Longest a caller is held for a command it did not put an explicit timeoutSec on. Past this the
 *  call returns a "still running" note instead of blocking; the command keeps running in the
 *  background up to its own kill bound. An explicit timeoutSec is the caller asking to wait that
 *  long, so it is honoured in full instead. */
const DEFAULT_RETURN_SEC = 120

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
const NOT_FOUND = 'NOT FOUND IN THIS EXCERPT'
/** Used once a file needed more than one window: each call only ever sees one window, so it must
 *  never guess about the rest of the file — it can only say this excerpt did or did not have it. */
const CHUNK_ASK_SYSTEM = `You answer a question using ONLY the excerpt of a file shown below; you are not shown the rest of the file. Be exact and terse; cite file:line for every claim. If this excerpt does not contain the answer, reply with exactly "${NOT_FOUND}" and nothing else. No preamble.`

export class LocalAssistTools {
  private readonly run: CommandRunner
  private readonly readText: (file: string, maxBytes: number) => Promise<string>
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  constructor(private readonly deps: LocalAssistDeps) {
    this.run = deps.run ?? hostCommandRunner
    this.readText = deps.readText ?? readLog
    this.now = deps.now ?? (() => new Date())
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Races a command against a return bound. Resolves with the finished run when it lands first;
   *  otherwise resolves `done: false` and leaves the command running in the background (it still
   *  stops at its own kill bound; `run` never rejects). */
  private async boundedRun(run: Promise<CommandRun>, ms: number): Promise<{ done: true; run: CommandRun } | { done: false }> {
    return Promise.race([
      run.then(result => ({ done: true as const, run: result })),
      this.sleep(ms).then(() => ({ done: false as const }))
    ])
  }

  private session(agentSessionId: string): LocalAssistSession {
    const session = this.deps.session(agentSessionId)
    if (!session) throw new Error('This conversation is no longer open in Conductor')
    return session
  }

  private record(session: LocalAssistSession, tool: LocalAssistTool, rawChars: number, returnedChars: number, outcome: LocalModelOutcome | undefined): void {
    const answer = outcome?.ok ? outcome.answer : undefined
    this.recordUsage(session, tool, rawChars, returnedChars, { inputTokens: answer?.inputTokens ?? 0, outputTokens: answer?.outputTokens ?? 0, usedModel: Boolean(answer), model: answer?.model })
  }

  /** Same ledger line as `record`, for a call answered over several local model round trips
   *  (chunked `local_ask`) whose usage is summed across them rather than coming from one outcome. */
  private recordUsage(session: LocalAssistSession, tool: LocalAssistTool, rawChars: number, returnedChars: number, usage: { inputTokens: number; outputTokens: number; usedModel: boolean; model?: string }): void {
    this.deps.ledger.record({ tool, projectId: session.projectId, agentSessionId: session.agentSessionId, provider: session.provider, rawChars, returnedChars, localInputTokens: usage.inputTokens, localOutputTokens: usage.outputTokens, usedModel: usage.usedModel, ...(usage.model ? { model: usage.model } : {}) })
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
    const explicitTimeout = args.timeoutSec !== undefined
    const timeoutSec = count(args, 'timeoutSec', DEFAULT_KILL_SEC, 5, MAX_TIMEOUT_SEC)
    const cwd = args.cwd === undefined ? session.cwd : (await this.directory(session.cwd, text(args, 'cwd', 1000)!))
    const scratch = join(session.cwd, '.conductor-scratch', 'local-assist')
    mkdirSync(scratch, { recursive: true })
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    const logFile = join(scratch, `${stamp}-${randomBytes(3).toString('hex')}.log`)
    const logPath = relative(session.cwd, logFile).split(sep).join('/')
    const started = this.now().getTime()
    const runPromise = this.run({ command, cwd, logFile, timeoutMs: timeoutSec * 1000, signal })
    const returnAfterMs = Math.min(DEFAULT_RETURN_SEC * 1000, timeoutSec * 1000)
    const race = explicitTimeout ? { done: true as const, run: await runPromise } : await this.boundedRun(runPromise, returnAfterMs)
    if (!race.done) {
      const waitedSec = Math.round((this.now().getTime() - started) / 1000) || Math.round(returnAfterMs / 1000)
      const body = `Still running after ${waitedSec} s (not finished yet). It keeps running in the background and is killed after ${timeoutSec} s total if it has not finished by then. Log: ${logPath} — read it directly, or call run_and_summarize again shortly to check.`
      return { text: body, structured: { stillRunning: true, logPath, waitedMs: waitedSec * 1000 } }
    }
    const run = race.run
    const raw = stripAnsi(await this.readText(logFile, MAX_LOG_READ).catch(() => ''))
    const lines = splitLines(raw)
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
    // Share the model's input budget across the files; a file whose own content needs more than
    // its share is split into windows below instead of losing its unmatched middle.
    const share = files.length ? Math.floor(MODEL_INPUT_CHARS / files.length) : MODEL_INPUT_CHARS
    const fileChunks = files.map(file => {
      const numbered = splitLines(file.text).map((line, index) => `${index + 1}: ${line}`)
      return { file, ...chunkLines(numbered, share, Number.MAX_SAFE_INTEGER) }
    })
    const allWindows = fileChunks.flatMap(({ file, chunks }) => chunks.map((body, index) => ({ file, index, total: chunks.length, body })))
    const listing = files.map(file => `${file.relative} (${file.bytes} bytes)`).join(', ')

    // The common case (no files, or files small enough for one window) is answered in one call
    // exactly as before: full material in one prompt, one system message tuned for that.
    if (allWindows.length <= 1) {
      const material = fileChunks.map(({ file, chunks }) => `=== ${file.relative} (${file.bytes} bytes${file.truncated ? `, first ${MAX_FILE_BYTES} read` : ''}) ===\n${chunks[0] ?? ''}`).join('\n\n')
      const outcome = await this.deps.runner.ask({
        system: ASK_SYSTEM,
        user: `${prompt}\n\nAnswer in at most ${maxLines} lines.${material ? `\n\nFiles (line numbers prefixed):\n${material}` : ''}`,
        maxTokens: Math.min(2048, maxLines * 40),
        signal
      })
      const body = outcome.ok
        ? `${capLines(outcome.answer.text, maxLines)}\n— ${outcome.answer.model}, local${listing ? `, over ${listing}` : ''}`
        : `Local model unavailable: ${outcome.reason}. Nothing was summarised; read ${listing || 'the files'} yourself or call again shortly.`
      this.record(session, tool, outcome.ok ? rawChars : 0, body.length, outcome)
      return { text: body, structured: { answered: outcome.ok, files: files.map(file => ({ path: file.relative, bytes: file.bytes, truncated: file.truncated })) } }
    }

    // Too big for one window: map the question over each window in turn (never guessing about a
    // window it was not shown), then reduce the hits into one answer. Bounded so one huge file
    // cannot turn a call into an unbounded number of local model round trips.
    const windows = allWindows.slice(0, MAX_ASK_CHUNKS)
    const found: string[] = []
    let inputTokens = 0, outputTokens = 0, usedModel = false, lastModel: string | undefined, failureReason: string | undefined, examined = 0
    for (const window of windows) {
      const label = window.total > 1 ? `${window.file.relative} (part ${window.index + 1}/${window.total})` : window.file.relative
      const outcome = await this.deps.runner.ask({
        system: CHUNK_ASK_SYSTEM,
        user: `${prompt}\n\nExcerpt of ${label}, ${window.file.bytes} bytes total${window.file.truncated ? `, only the first ${MAX_FILE_BYTES} bytes of the file were read` : ''}. Lines are numbered from the start of the file, not this excerpt:\n${window.body}`,
        maxTokens: Math.min(1024, maxLines * 20),
        signal
      })
      if (!outcome.ok) { failureReason = outcome.reason; break }
      examined++
      usedModel = true
      inputTokens += outcome.answer.inputTokens
      outputTokens += outcome.answer.outputTokens
      lastModel = outcome.answer.model
      const answer = outcome.answer.text.trim()
      if (answer && !answer.toUpperCase().includes(NOT_FOUND)) found.push(`${label}: ${answer}`)
    }
    const unexamined = allWindows.length - examined
    const remainder = unexamined > 0 ? ` ${unexamined} of ${allWindows.length} sections of ${listing || 'the file(s)'} were not examined${failureReason ? ` (local model failed: ${failureReason})` : ' — this is larger than one call can fully cover; ask again about a narrower part or file if needed'}.` : ''
    const body = found.length
      ? `${capLines(found.join('\n'), maxLines)}\n— local, over ${listing}.${remainder}`
      : `Not found in the ${examined} section(s) of ${listing || 'the file(s)'} read.${remainder}`
    this.recordUsage(session, tool, usedModel ? rawChars : 0, body.length, { inputTokens, outputTokens, usedModel, model: lastModel })
    return { text: body, structured: { answered: usedModel && found.length > 0, chunks: allWindows.length, examined, files: files.map(file => ({ path: file.relative, bytes: file.bytes, truncated: file.truncated })) } }
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
      timeoutSec: { type: 'number', description: `Kill the command after this many seconds (max ${MAX_TIMEOUT_SEC}). Without it, the call returns within about ${DEFAULT_RETURN_SEC} s even if the command is still running (it keeps going in the background, killed after ${DEFAULT_KILL_SEC} s, and logged at the returned path) — pass this when you want to wait out a specific, longer command.` }
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
