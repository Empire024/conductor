import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isSecretPath } from '../local-models/workspace.ts'
import { GENERATION_TIMEOUT_MS, type LocalAssistTool, type LocalModelOutcome, type LocalModelRunner, type SavingsLedger } from './contract.ts'
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
/** Prompt tokens one request asks for at most, whatever the server's context: at the ~400
 *  tokens/s this machine's Qwen 3.6 reads a prompt, a window this size is already over a minute.
 *  Below it, a request is sized from the running server (inputBudget), never fixed: a fixed 60,000
 *  characters overflowed the owner's 32k-context Qwen 3.6 on every window of a dense log (VR3 A4),
 *  because digits, ids and timestamps run at about 1.7 characters per token on its tokenizer. */
const MAX_WINDOW_TOKENS = 32_000
/** Context assumed when the running server does not report its own (the configured default). */
const FALLBACK_CONTEXT_TOKENS = 32_768
/** Characters per token assumed when the server's tokenizer cannot be asked: below a dense log's. */
const FALLBACK_CHARS_PER_TOKEN = 1.5
/** Kept free for the chat template and the framing around the material. */
const FRAMING_TOKENS = 256
/** Characters of each sample the tokenizer measures the material's density on. */
const SAMPLE_CHARS = 12_000
/** One local_ask answers within this. An MCP client calling over HTTP with a plain fetch gives up
 *  on a response after 300 s (undici's headers timeout: VR3's a4-raw.mjs was cut off at exactly
 *  300 s), and everything a call read before its caller gave up is lost. A 1 MB log is about 27
 *  minutes of prompt reading on this machine, so no section is started that would end past this
 *  at the pace of the slowest one so far, sections naming the question's own terms are read
 *  first, and the answer names the lines left unread. */
const CALL_BUDGET_MS = 240_000
/** A generation still running this long into the call is abandoned, under the 300 s client limit. */
const CALL_HARD_LIMIT_MS = 285_000
/** Slowest prompt reading a request is given time for before it counts as stuck. */
const MIN_PROMPT_TOKENS_PER_SEC = 200
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

interface InputBudget {
  /** Most prompt tokens one request may render to on the server, answer room already held back. */
  limit: number
  /** Of that, what the material itself may take. */
  tokens: number
  charsPerToken: number
}
interface AskWindow { file: string; bytes: number; truncated: boolean; part: number; parts: number; lines: string[]; retried: boolean }

/** Up to three samples (head, middle, tail) of the material, for measuring its density. */
const samples = (text: string): string[] => {
  if (text.length <= SAMPLE_CHARS * 3) return [text]
  const middle = Math.floor(text.length / 2 - SAMPLE_CHARS / 2)
  return [text.slice(0, SAMPLE_CHARS), text.slice(middle, middle + SAMPLE_CHARS), text.slice(-SAMPLE_CHARS)]
}
/** A generation that has to read this many prompt tokens first gets the time to read them. */
const readingTimeout = (promptTokens: number): number => GENERATION_TIMEOUT_MS + Math.ceil(promptTokens / MIN_PROMPT_TOKENS_PER_SEC) * 1000
const lineNumber = (line: string | undefined): number => Number(/^(\d+): /.exec(line ?? '')?.[1] ?? 0)
const firstLine = (window: AskWindow): number => lineNumber(window.lines[0])
const lastLine = (window: AskWindow): number => lineNumber(window.lines[window.lines.length - 1])
const label = (window: AskWindow): string => window.parts > 1 ? `${window.file} (part ${window.part}/${window.parts}, lines ${firstLine(window)}–${lastLine(window)})` : window.file
const original = (planned: AskWindow[], window: AskWindow): AskWindow => planned.find(candidate => candidate.file === window.file && candidate.part === window.part) ?? window
/** The unread lines per file as merged ranges, so the caller knows exactly what nobody read. */
const unreadRanges = (windows: AskWindow[]): string => {
  const byFile = new Map<string, Array<[number, number]>>()
  for (const window of windows) byFile.set(window.file, [...(byFile.get(window.file) ?? []), [firstLine(window), lastLine(window)]])
  return [...byFile].map(([file, ranges]) => {
    const merged: Array<[number, number]> = []
    for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1]
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
      else merged.push([from, to])
    }
    const shown = merged.slice(0, 8).map(([from, to]) => from === to ? `${from}` : `${from}–${to}`).join(', ')
    return `${file} lines ${shown}${merged.length > 8 ? ` and ${merged.length - 8} more ranges` : ''}`
  }).join('; ')
}
const STOP_WORDS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'what', 'where', 'which', 'when', 'line', 'lines', 'file', 'files', 'value', 'values', 'quote', 'find', 'there', 'about', 'does', 'into', 'every', 'list', 'show', 'give'])
/** The question's distinctive literals (identifiers with digits, capitals, _ - . or quotes): a
 *  section that contains one is read first. Plain English words never qualify. */
export function promptTerms(prompt: string): string[] {
  const quoted = [...prompt.matchAll(/["'`]([^"'`\n]{3,80})["'`]/g)].map(match => match[1]!)
  const words = prompt.split(/[^A-Za-z0-9_.\-]+/).map(word => word.replace(/^[.\-]+|[.\-]+$/g, '')).filter(word => word.length >= 4 && !STOP_WORDS.has(word.toLowerCase()) && (/\d/.test(word) || /[_.\-]/.test(word) || /[A-Z]/.test(word.slice(1))))
  return [...new Set([...quoted, ...words].map(term => term.toLowerCase()))].slice(0, 12)
}

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
      const maxTokens = Math.min(2048, maxLines * 40)
      const build = (chars: number): string => `Command: ${command}\nResult: ${status}\n${question ? `Question: ${question}\n` : ''}\nIn at most ${maxLines} lines: ${question ? 'answer the question, then ' : ''}say whether it passed; for each failure give the test or check name, file:line and the first error line, quoting them exactly. Skip passing items.\n\nOutput:\n${modelExcerpt(lines, chars)}`
      const budget = await this.inputBudget(SUMMARY_SYSTEM.length + build(0).length, maxTokens, samples(lines.map(line => clip(line)).join('\n')), signal)
      let chars = Math.floor(budget.tokens * budget.charsPerToken)
      const measured = await this.deps.runner.promptTokens?.({ system: SUMMARY_SYSTEM, user: build(chars) }, signal).catch(() => null)
      if (measured && measured > budget.limit) chars = Math.floor(chars * budget.limit / measured * 0.95)
      const send = (size: number): Promise<LocalModelOutcome> => this.deps.runner.ask({ system: SUMMARY_SYSTEM, user: build(size), maxTokens, timeoutMs: readingTimeout(size / budget.charsPerToken), signal })
      outcome = await send(chars)
      // Refused as longer than the context after all: once more at half the excerpt.
      if (!outcome.ok && outcome.contextExceeded) outcome = await send(Math.floor(chars / 2))
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
    const listing = files.map(file => `${file.relative} (${file.bytes} bytes)`).join(', ')
    const numbered = files.map(file => splitLines(file.text).map((line, index) => `${index + 1}: ${line}`))
    const singleTokens = Math.min(2048, maxLines * 40), windowTokens = Math.min(1024, maxLines * 20)
    const framing = CHUNK_ASK_SYSTEM.length + prompt.length + 400
    const budget = await this.inputBudget(framing, Math.max(singleTokens, windowTokens), files.length ? samples(numbered.map(lines => lines.join('\n')).join('\n')) : [], signal)
    let windowChars = Math.floor(budget.tokens * budget.charsPerToken)
    const record = { files: files.map(file => ({ path: file.relative, bytes: file.bytes, truncated: file.truncated })) }

    // The common case (no files, or files small enough for one window) is answered in one call:
    // full material in one prompt, one system message tuned for that. Each file gets its share of
    // the window; one that needs more than its share is split into windows below instead of
    // losing its unmatched middle.
    const share = files.length ? Math.floor(windowChars / files.length) : windowChars
    const whole = numbered.map(lines => chunkLines(lines, share, 2))
    if (whole.every(({ chunks }) => chunks.length <= 1)) {
      const material = files.map((file, index) => `=== ${file.relative} (${file.bytes} bytes${file.truncated ? `, first ${MAX_FILE_BYTES} read` : ''}) ===\n${whole[index]!.chunks[0] ?? ''}`).join('\n\n')
      const user = `${prompt}\n\nAnswer in at most ${maxLines} lines.${material ? `\n\nFiles (line numbers prefixed):\n${material}` : ''}`
      const measured = files.length ? await this.deps.runner.promptTokens?.({ system: ASK_SYSTEM, user }, signal).catch(() => null) : null
      let outcome: LocalModelOutcome | undefined
      if (measured && measured > budget.limit) windowChars = Math.floor(windowChars * budget.limit / measured * 0.95)
      else {
        outcome = await this.deps.runner.ask({ system: ASK_SYSTEM, user, maxTokens: singleTokens, timeoutMs: readingTimeout(user.length / budget.charsPerToken), signal })
        if (!outcome.ok && outcome.contextExceeded && files.length) { windowChars = Math.floor(windowChars / 2); outcome = undefined }
      }
      if (outcome) {
        const body = outcome.ok
          ? `${capLines(outcome.answer.text, maxLines)}\n— ${outcome.answer.model}, local${listing ? `, over ${listing}` : ''}`
          : `Local model unavailable: ${outcome.reason}. Nothing was summarised; read ${listing || 'the files'} yourself or call again shortly.`
        this.record(session, tool, outcome.ok ? rawChars : 0, body.length, outcome)
        return { text: body, structured: { answered: outcome.ok, ...record } }
      }
      // It did not fit after all (the server counted more than the estimate, or refused it):
      // fall through to windows at the size the server allows.
    }

    // Too big for one window: map the question over each window in turn (never guessing about a
    // window it was not shown), then reduce the hits into one answer. Every window is checked
    // against the server's own count before it is sent and split if it would not fit; a window the
    // server still refuses as too long is retried once as two halves. Sections that contain the
    // question's own terms are read first, and the whole call is bounded by the call limit and the
    // time budget, so the answer always says exactly which lines were not read.
    const planned: AskWindow[] = []
    files.forEach((file, index) => {
      const { chunks } = chunkLines(numbered[index]!, windowChars, Number.MAX_SAFE_INTEGER)
      chunks.forEach((chunk, part) => planned.push({ file: file.relative, bytes: file.bytes, truncated: file.truncated, part: part + 1, parts: chunks.length, lines: chunk.split('\n'), retried: false }))
    })
    const terms = promptTerms(prompt)
    const naming = (window: AskWindow): boolean => { const body = window.lines.join('\n').toLowerCase(); return terms.some(term => body.includes(term)) }
    const first = terms.length ? planned.filter(naming) : []
    const queue = first.length && first.length < planned.length ? [...first, ...planned.filter(window => !first.includes(window))] : [...planned]
    const found: Array<{ window: AskWindow; text: string }> = []
    const unread: AskWindow[] = []
    let inputTokens = 0, outputTokens = 0, usedModel = false, lastModel: string | undefined, stopped: string | undefined, examined = 0, calls = 0, sections = planned.length
    const started = this.now().getTime()
    let slowest = 0
    const request = (window: AskWindow): string => `${prompt}\n\nExcerpt of ${label(window)}, ${window.bytes} bytes total${window.truncated ? `, only the first ${MAX_FILE_BYTES} bytes of the file were read` : ''}. Lines are numbered from the start of the file, not this excerpt:\n${window.lines.join('\n')}`
    const halve = (window: AskWindow): AskWindow[] => { const middle = Math.ceil(window.lines.length / 2); sections++; return [{ ...window, lines: window.lines.slice(0, middle), retried: true }, { ...window, lines: window.lines.slice(middle), retried: true }] }
    while (queue.length) {
      const window = queue.shift()!
      if (calls >= MAX_ASK_CHUNKS) { stopped = `one call reads at most ${MAX_ASK_CHUNKS} sections`; unread.push(window, ...queue.splice(0)); break }
      if (calls && this.now().getTime() - started + slowest > CALL_BUDGET_MS) { stopped = `one call answers within ${CALL_BUDGET_MS / 60_000} min, and a section takes about ${Math.round(slowest / 1000)} s on this model`; unread.push(window, ...queue.splice(0)); break }
      const user = request(window)
      const measured = await this.deps.runner.promptTokens?.({ system: CHUNK_ASK_SYSTEM, user }, signal).catch(() => null)
      if (measured && measured > budget.limit && window.lines.length > 1) { queue.unshift(...halve(window)); continue }
      const sent = this.now().getTime()
      const outcome = await this.deps.runner.ask({ system: CHUNK_ASK_SYSTEM, user, maxTokens: windowTokens, timeoutMs: Math.max(30_000, Math.min(readingTimeout(measured ?? user.length / budget.charsPerToken), started + CALL_HARD_LIMIT_MS - sent)), signal })
      slowest = Math.max(slowest, this.now().getTime() - sent)
      calls++
      if (!outcome.ok) {
        if (outcome.contextExceeded && !window.retried && window.lines.length > 1) { queue.unshift(...halve(window)); continue }
        stopped = `local model failed: ${outcome.reason}`
        unread.push(window, ...queue.splice(0))
        break
      }
      examined++
      usedModel = true
      inputTokens += outcome.answer.inputTokens
      outputTokens += outcome.answer.outputTokens
      lastModel = outcome.answer.model
      // Per line: a question with two parts gets "A: value" and "B: NOT FOUND IN THIS EXCERPT" from
      // a section holding only A, and dropping the whole answer lost A (VR3 A4 fixture, both needles).
      const answer = outcome.answer.text.split('\n').filter(line => line.trim() && !line.toUpperCase().includes(NOT_FOUND)).join('\n').trim()
      if (answer) found.push({ window, text: answer })
    }
    // Hits in file order, whatever order they were read in.
    found.sort((a, b) => planned.indexOf(original(planned, a.window)) - planned.indexOf(original(planned, b.window)) || firstLine(a.window) - firstLine(b.window))
    const order = examined && first.length && first.length < planned.length ? ` Sections naming ${terms.map(term => JSON.stringify(term)).join(', ')} were read first.` : ''
    const remainder = unread.length
      ? ` ${unread.length} of ${sections} sections of ${listing || 'the file(s)'} were not examined (${stopped}): ${unreadRanges(unread)}.${order} Read those lines yourself, or ask about a smaller file.`
      : ''
    const body = found.length
      ? `${capLines(found.map(hit => `${label(hit.window)}: ${hit.text}`).join('\n'), maxLines)}\n— local, over ${listing}; read ${examined} of ${sections} sections.${remainder}`
      : `Not found in the ${examined} of ${sections} section(s) of ${listing || 'the file(s)'} read.${remainder}`
    this.recordUsage(session, tool, usedModel ? rawChars : 0, body.length, { inputTokens, outputTokens, usedModel, model: lastModel })
    return { text: body, structured: { answered: usedModel && found.length > 0, chunks: sections, examined, ...record } }
  }

  /** How much material one request may carry: the running server's own context less the answer,
   *  the instructions and the template, in tokens, and how many characters of this material one
   *  token covers, measured on the server's tokenizer over samples of it when the server allows. */
  private async inputBudget(instructionChars: number, answerTokens: number, material: string[], signal?: AbortSignal): Promise<InputBudget> {
    const runner = this.deps.runner
    const context = (await runner.contextTokens?.(signal).catch(() => null)) ?? FALLBACK_CONTEXT_TOKENS
    const limit = Math.min(context - answerTokens, MAX_WINDOW_TOKENS) - FRAMING_TOKENS
    const tokens = Math.max(1024, limit - Math.ceil(instructionChars / 2))
    let ratio: number | null = null
    for (const sample of material) {
      const counted = sample ? await runner.promptTokens?.({ system: '', user: sample }, signal).catch(() => null) : null
      if (!counted) break
      ratio = Math.min(ratio ?? Infinity, sample.length / counted)
    }
    return { limit: Math.max(1024, limit), tokens, charsPerToken: ratio === null ? FALLBACK_CHARS_PER_TOKEN : ratio * 0.95 }
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
