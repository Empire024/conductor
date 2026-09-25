import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CLOUD_EFFORTS, CLOUD_MODELS, MAX_CLOUD_PROMPT_CHARS, type CloudFetchResult, type CloudRunSummary, type CloudTranscriptEntry, type CloudUsage } from '../../shared/cloud'
import { TerminalScreen } from './screen'

/** The part of node-pty this uses, so tests can drive a fake. */
export interface CloudPty {
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
export type CloudSpawn = (file: string, args: string[], options: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => CloudPty
export type CloudGit = (cwd: string, args: string[]) => Promise<string>
/** A non-interactive CLI call: its combined output and exit code. */
export type CloudExec = (file: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ code: number; output: string }>

export interface CloudRunsOptions {
  /** Where runs.json, client logs, debug logs, transcripts and worktrees live (userData/cloud). */
  root: string
  /** The claude CLI, or null when it is not installed. */
  executable(): string | null
  spawn: CloudSpawn
  git?: CloudGit
  exec?: CloudExec
  /** Extra arguments placed before the CLI's own (the offline fixture's script path). */
  prefixArgs?: string[]
  env?: Record<string, string>
  onData?(event: { id: string; data: string; sequence: number }): void
  onChanged?(summary: CloudRunSummary): void
  now?(): number
  /** How often the client's debug log is read while a client runs. */
  pollMs?: number
  /** How often origin is asked for the session's branch and pull request. */
  watchMs?: number
  /** How long after its start a run is still watched on origin. */
  watchForMs?: number
}

interface LiveRun {
  process: CloudPty
  screen: TerminalScreen
  transcript: string
  sequence: number
  exited: boolean
  stopping: boolean
  attach: boolean
  trustAnswered: boolean
  timers: Array<ReturnType<typeof setInterval>>
  analyse: ReturnType<typeof setTimeout> | null
}

const SESSION_URL = /https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9_]+)/
const CREATED = /Successfully created remote session:\s*((?:session|cse)_[A-Za-z0-9_]+)/
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g
const ATTACH_REFUSED = /not enabled for your account/i

const defaultGit: CloudGit = (cwd, args) => new Promise((resolvePromise, reject) => {
  execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
    if (error) reject(new Error((stderr || error.message).trim().slice(0, 2000)))
    else resolvePromise(stdout)
  })
})
const defaultExec: CloudExec = (file, args, options) => new Promise(resolvePromise => {
  execFile(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: options.timeoutMs }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((error as { code?: unknown }).code) : 1) : 0
    resolvePromise({ code, output: `${stdout}${stderr}`.trim() })
  })
})

const text = (value: unknown, key: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${key} must be a non-empty string of up to ${max} characters`)
  return value
}

/** The last `bytes` of a file, or '' when it is missing. */
function tail(path: string, bytes: number): string {
  try {
    const size = statSync(path).size
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    const fd = openSync(path, 'r')
    try { readSync(fd, buffer, 0, length, size - length) } finally { closeSync(fd) }
    return buffer.toString('utf8')
  } catch { return '' }
}

/** The app's environment without the marks of a Claude Code session that may have launched it
 *  (an agent restarting Conductor): the cloud client is the owner's own, not that session's child. */
export function clientEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'
    && !/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|ENTRYPOINT|EXECPATH|SESSION_ATTENDED|MESSAGING_[A-Z_]+))$/.test(entry[0])))
}

/** What the client's debug log says about the session it created. The log line is a JSON string,
 *  so the payload's quotes arrive escaped. */
export function readCreateLog(log: string): { sessionId: string | null; model: string | null; branchHint: string | null } {
  const sessionId = CREATED.exec(log)?.[1] ?? null
  const at = log.lastIndexOf('Creating session with payload')
  const payload = at >= 0 ? log.slice(at, at + 40_000) : ''
  const model = /\\?"model\\?"\s*:\s*\\?"([^"\\]+)/.exec(payload)?.[1] ?? null
  const branchHint = /\\?"branches\\?"\s*:\s*\[(?:\s|\\n)*\\?"(claude\/[^"\\]+)/.exec(payload)?.[1] ?? null
  return { sessionId, model, branchHint }
}

/** The CLI's own arguments for a new cloud session; exported for the tests. */
export function cloudArgs(run: Pick<CloudRunSummary, 'prompt' | 'model' | 'effort' | 'ref' | 'title'>, debugFile: string): string[] {
  return ['--cloud', run.prompt, '--model', run.model, ...(run.effort ? ['--effort', run.effort] : []), ...(run.ref ? ['--ref', run.ref] : []), '--name', run.title, '--debug-file', debugFile]
}

/** The session's branch and pull request among origin's heads: the branch it was told to use
 *  (the cloud may add a suffix), else the one new claude/* head since the run started. */
export function findResult(lines: string, hint: string | null, known: string[]): { branch: string | null; head: string | null; pr: number | null; ambiguous: string[] } {
  const refs = lines.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2) as Array<[string, string]>
  const heads = refs.filter(([, ref]) => ref.startsWith('refs/heads/claude/')).map(([sha, ref]) => ({ sha, branch: ref.slice('refs/heads/'.length) }))
  let match = hint ? heads.find(head => head.branch === hint) ?? heads.filter(head => head.branch.startsWith(hint + '-')).at(-1) : undefined
  let ambiguous: string[] = []
  if (!match) {
    const fresh = heads.filter(head => !known.includes(`refs/heads/${head.branch}`))
    if (fresh.length === 1) match = fresh[0]
    else if (fresh.length > 1) ambiguous = fresh.map(head => head.branch)
  }
  if (!match) return { branch: null, head: null, pr: null, ambiguous }
  const pull = refs.find(([sha, ref]) => sha === match!.sha && /^refs\/pull\/\d+\/head$/.test(ref))
  return { branch: match.branch, head: match.sha, pr: pull ? Number(pull[1].split('/')[2]) : null, ambiguous: [] }
}

/** The transcript the CLI's teleport saved (one JSON record per line), as readable entries plus
 *  the token usage and model its assistant messages report. */
export function parseTranscript(jsonl: string): { entries: CloudTranscriptEntry[]; usage: CloudUsage; model: string | null } {
  const entries: CloudTranscriptEntry[] = []
  const usage: CloudUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0 }
  let model: string | null = null
  const clip = (value: string, max = 4000): string => value.length > max ? value.slice(0, max) + ' …' : value
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let record: any
    try { record = JSON.parse(line) } catch { continue }
    if (record.type !== 'user' && record.type !== 'assistant') continue
    // The teleport's own note about continuing elsewhere is not part of the session.
    if (record.isMeta) continue
    const at = typeof record.timestamp === 'string' ? record.timestamp : null
    const content = record.message?.content
    if (record.type === 'assistant') {
      if (typeof record.message?.model === 'string' && !record.message.model.startsWith('<')) model = record.message.model
      const u = record.message?.usage
      if (u) { usage.inputTokens += u.input_tokens ?? 0; usage.outputTokens += u.output_tokens ?? 0; usage.cacheReadTokens += u.cache_read_input_tokens ?? 0; usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0; usage.messages++ }
    }
    const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
    for (const part of parts) {
      if (part?.type === 'text' && String(part.text).trim()) {
        if (record.type === 'user' && /^This session is being continued from another machine/.test(String(part.text))) continue
        entries.push({ role: record.type, text: clip(String(part.text)), at })
      } else if (part?.type === 'tool_use') entries.push({ role: 'tool', text: clip(`${part.name} ${JSON.stringify(part.input ?? {})}`, 1500), at })
      else if (part?.type === 'tool_result') {
        const body = Array.isArray(part.content) ? part.content.map((item: any) => item?.text ?? '').join('\n') : String(part.content ?? '')
        entries.push({ role: 'result', text: clip(body, 1500), at })
      }
    }
  }
  return { entries, usage, model }
}

/**
 * Cloud runs of every project. One run is one Claude Code cloud session:
 *
 * - `start` spawns `claude --cloud <task>` in a PTY (the CLI creates sessions only from a
 *   terminal). That client creates the session and exits; its debug log names the session, the
 *   model and the branch the session will push.
 * - It then tries once to attach a live client (`claude --cloud <session_id>`). Where the account
 *   allows it, the tab shows the session live and messages are typed into it; where it does not
 *   (the CLI says so), the run is followed on GitHub instead.
 * - Origin is watched for the session's branch and pull request, and `transcript` pulls the
 *   session's messages with the CLI's teleport into a scratch worktree of its own.
 */
export class CloudRuns {
  private runs = new Map<string, CloudRunSummary>()
  private live = new Map<string, LiveRun>()
  private watchers = new Map<string, ReturnType<typeof setInterval>>()
  private watching = new Set<string>()
  private git: CloudGit
  private exec: CloudExec
  private now: () => number
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private teleports = new Set<CloudPty>()
  private pulls = new Map<string, Promise<CloudTranscriptEntry[]>>()
  private disposed = false

  constructor(private options: CloudRunsOptions) {
    this.git = options.git ?? defaultGit
    this.exec = options.exec ?? defaultExec
    this.now = options.now ?? Date.now
    mkdirSync(options.root, { recursive: true })
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as CloudRunSummary[]
      // A client does not survive the app; a run whose client was still creating it never got a session.
      for (const run of saved) this.runs.set(run.id, run.status === 'starting' && !run.sessionId
        ? { ...run, attached: false, status: 'failed', error: run.error ?? 'Conductor closed before the cloud session was created' }
        : { ...run, attached: false })
      for (const run of this.runs.values()) if (run.status === 'running' || run.status === 'pushed') this.watch(run.id)
    } catch { /* first run */ }
  }

  private get file(): string { return join(this.options.root, 'runs.json') }
  private clientLog(id: string): string { return join(this.options.root, `${id}.log`) }
  private debugFile(id: string): string { return join(this.options.root, `${id}.debug.log`) }
  private transcriptFile(id: string): string { return join(this.options.root, `${id}.transcript.json`) }
  private knownHeadsFile(id: string): string { return join(this.options.root, `${id}.heads.json`) }
  private knownHeads(id: string): string[] { try { return JSON.parse(readFileSync(this.knownHeadsFile(id), 'utf8')) as string[] } catch { return [] } }
  private cli(): string {
    const executable = this.options.executable()
    if (!executable) throw new Error('The Claude Code CLI is not installed on this machine')
    return executable
  }
  private env(id: string): Record<string, string> {
    return { ...clientEnv(process.env), ...this.options.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', CONDUCTOR_CLOUD_RUN: id }
  }

  list(projectId?: string): CloudRunSummary[] {
    return [...this.runs.values()].filter(run => !projectId || run.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string, projectId?: string): CloudRunSummary {
    const run = this.runs.get(id)
    if (!run || projectId !== undefined && run.projectId !== projectId) throw new Error('No cloud run with that id in this project')
    return run
  }

  available(): boolean { return Boolean(this.options.executable()) }

  start(input: { projectId: string; workspaceId: string; cwd: string; prompt: unknown; model?: unknown; effort?: unknown; ref?: unknown; title?: unknown; startedBy: string }): CloudRunSummary {
    const prompt = text(input.prompt, 'prompt', MAX_CLOUD_PROMPT_CHARS)
    const model = input.model === undefined ? CLOUD_MODELS.find(entry => entry.isDefault)!.id : text(input.model, 'model', 80)
    if (!CLOUD_MODELS.some(entry => entry.id === model)) throw new Error(`Choose a cloud model from models.list: ${CLOUD_MODELS.map(entry => entry.id).join(', ')}`)
    const effort = input.effort === undefined || input.effort === 'auto' ? null : text(input.effort, 'effort', 20)
    if (effort && !(CLOUD_EFFORTS as readonly string[]).includes(effort)) throw new Error(`effort must be one of ${CLOUD_EFFORTS.join(', ')}`)
    const ref = input.ref === undefined ? null : text(input.ref, 'ref', 200)
    if (ref && !/^[\w./-]+$/.test(ref)) throw new Error('ref must be a branch, tag or SHA')
    const title = input.title === undefined ? prompt.replace(/\s+/g, ' ').trim().slice(0, 80) : text(input.title, 'title', 120)
    if (!existsSync(input.cwd)) throw new Error('The project folder is not on this machine')
    this.cli()
    const at = this.now()
    const run: CloudRunSummary = {
      id: `cloud_${randomUUID().replace(/-/g, '').slice(0, 12)}`, projectId: input.projectId, workspaceId: input.workspaceId, title, prompt, model, effort, ref,
      status: 'starting', attached: false, liveView: null, cwd: input.cwd, sessionId: null, sessionUrl: null, confirmedModel: null,
      branchHint: null, branch: null, headCommit: null, prUrl: null, transcriptAt: null, transcriptEntries: 0, usage: null,
      worktreePath: null, fetchedCommit: null, startedBy: input.startedBy, createdAt: at, updatedAt: at, endedAt: null, exitCode: null, error: null
    }
    this.runs.set(run.id, run)
    // Which claude/* branches exist before the session can push one, so a new one is recognisable.
    void this.git(input.cwd, ['ls-remote', '--heads', 'origin', 'refs/heads/claude/*'])
      .then(out => writeFileSync(this.knownHeadsFile(run.id), JSON.stringify(out.split('\n').map(line => line.split('\t')[1]?.trim()).filter(Boolean))))
      .catch(() => writeFileSync(this.knownHeadsFile(run.id), '[]'))
    this.spawn(run, cloudArgs(run, this.debugFile(run.id)), false)
    return this.get(run.id)
  }

  /** A live client on the run's session, where the account allows one. */
  attach(id: string): CloudRunSummary {
    const run = this.get(id)
    const current = this.live.get(id)
    if (current && !current.exited) return run
    if (!run.sessionId) throw new Error('This run never got a cloud session; start a new one')
    if (run.liveView === false) throw new Error(`This Claude account cannot attach a live client to a cloud session (the CLI refuses: "Attaching to an existing cloud session is not enabled for your account"). Follow it here through its branch and transcript, or open ${run.sessionUrl}`)
    this.spawn(run, ['--cloud', run.sessionId, '--debug-file', this.debugFile(run.id)], true)
    return this.get(id)
  }

  /** The PTY stream so far, for a tab that just opened; a finished client replays its saved log. */
  clientTranscript(id: string): { transcript: string; sequence: number } {
    this.get(id)
    const live = this.live.get(id)
    if (live) return { transcript: live.transcript, sequence: live.sequence }
    try { return { transcript: readFileSync(this.clientLog(id), 'utf8'), sequence: 0 } } catch { return { transcript: '', sequence: 0 } }
  }

  /** What the client showed, as text: the last `lines` lines. */
  screen(id: string, lines = 60): string {
    this.get(id)
    const live = this.live.get(id)
    if (live) return live.screen.text(lines)
    const screen = new TerminalScreen(160, 50)
    screen.write(this.clientTranscript(id).transcript)
    return screen.text(lines)
  }

  /** Raw keystrokes from the tab's terminal. */
  write(id: string, data: string): void {
    const live = this.live.get(id)
    if (!live || live.exited || typeof data !== 'string' || data.length > 200_000) return
    live.process.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const live = this.live.get(id)
    if (!live || live.exited || !Number.isInteger(cols) || !Number.isInteger(rows)) return
    const c = Math.max(20, Math.min(500, cols)), r = Math.max(5, Math.min(300, rows))
    live.process.resize(c, r); live.screen.resize(c, r)
  }

  /**
   * A message to the session: typed into a live client when one is attached, else sent with
   * `claude -p <message> --cloud <session_id>`. An account without the attach gate is refused by
   * the CLI either way, and that refusal is what the caller gets, with the session's link.
   */
  async send(id: string, message: unknown): Promise<CloudRunSummary & { output?: string }> {
    const body = text(message, 'message', MAX_CLOUD_PROMPT_CHARS)
    const run = this.get(id)
    if (!run.sessionId) throw new Error('The cloud session does not exist yet')
    const live = this.live.get(id)
    if (live && !live.exited && live.attach) {
      // Bracketed paste keeps newlines in the message from submitting it early.
      live.process.write('\x1b[200~' + body + '\x1b[201~')
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
      live.process.write('\r')
      return this.get(id)
    }
    const result = await this.exec(this.cli(), [...(this.options.prefixArgs ?? []), '-p', body, '--cloud', run.sessionId], { cwd: run.cwd, env: this.env(id), timeoutMs: 120_000 })
    if (result.code !== 0 || ATTACH_REFUSED.test(result.output)) {
      if (ATTACH_REFUSED.test(result.output)) this.update(id, { liveView: false })
      throw new Error(`The CLI did not deliver the message: ${result.output.split('\n').filter(Boolean).slice(-3).join(' ') || `exit ${result.code}`}. Steer it at ${run.sessionUrl}`)
    }
    return { ...this.get(id), output: result.output.slice(-4000) }
  }

  /** Esc to a live client: the cloud agent stops its current turn. */
  interrupt(id: string): CloudRunSummary {
    const run = this.get(id)
    const live = this.live.get(id)
    if (!live || live.exited || !live.attach) throw new Error(`No live client is attached to this session, so it cannot be interrupted from here; stop it at ${run.sessionUrl ?? 'claude.ai/code'}`)
    live.process.write('\x1b')
    return this.get(id)
  }

  /**
   * Stops following the run: a live client is interrupted and closed, and origin is no longer
   * watched. The cloud session itself finishes its turn in the cloud unless a live client could
   * interrupt it; `note` says which.
   */
  async stop(id: string): Promise<CloudRunSummary & { note: string }> {
    const run = this.get(id)
    const live = this.live.get(id)
    let interrupted = false
    if (live && !live.exited) {
      live.stopping = true
      if (live.attach) { live.process.write('\x1b'); interrupted = true }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
      if (!live.exited) try { live.process.kill() } catch { /* already gone */ }
    }
    this.unwatch(id)
    const next = this.update(id, { status: run.sessionId ? 'stopped' : 'failed', attached: false, endedAt: this.now(), ...(run.sessionId ? {} : { error: run.error ?? 'Stopped before the cloud session was created' }) })
    return { ...next, note: interrupted ? 'The live client interrupted the session\'s turn and was closed.' : run.sessionId ? `Conductor stopped following it. The cloud session finishes its current turn in the cloud; stop it there if needed: ${run.sessionUrl}` : 'Stopped before a session existed.' }
  }

  /** Asks origin for the session's branch and pull request now. */
  async refreshResult(id: string): Promise<CloudRunSummary> {
    const run = this.get(id)
    if (!run.sessionId) return run
    const out = await this.git(run.cwd, ['ls-remote', 'origin', 'refs/heads/claude/*', 'refs/pull/*/head'])
    const found = findResult(out, run.branchHint, this.knownHeads(id))
    const patch: Partial<CloudRunSummary> = {}
    if (found.branch && found.branch !== run.branch) patch.branch = found.branch
    if (found.head && found.head !== run.headCommit) patch.headCommit = found.head
    if (found.pr) {
      const repo = /github\.com[/:]([^/]+\/[^/.\s]+)/.exec(await this.git(run.cwd, ['remote', 'get-url', 'origin']).catch(() => ''))?.[1]
      const url = repo ? `https://github.com/${repo}/pull/${found.pr}` : `pull/${found.pr}`
      if (url !== run.prUrl) patch.prUrl = url
    }
    if (found.branch && run.status === 'running') patch.status = 'pushed'
    if (!Object.keys(patch).length) return run
    const next = this.update(id, patch)
    // The first push is when there is something to read: pull the transcript once, unasked.
    if (patch.status === 'pushed') void this.transcript(id, true).catch(() => undefined)
    return next
  }

  /**
   * The session's messages. With `refresh`, the CLI's teleport pulls them from the cloud into a
   * scratch worktree of this store (`claude --teleport <session_id>` checks the session's branch
   * out there, never in the project folder) and they are read from the conversation file it saves.
   */
  async transcript(id: string, refresh = false): Promise<CloudTranscriptEntry[]> {
    const run = this.get(id)
    if (refresh) {
      if (!run.sessionId) throw new Error('The cloud session does not exist yet')
      // One pull at a time per run: a second ask while one runs gets that one's answer.
      const pending = this.pulls.get(id)
      if (pending) return pending
      const pull = this.pullTranscript(run).finally(() => this.pulls.delete(id))
      this.pulls.set(id, pull)
      return pull
    }
    try { return JSON.parse(readFileSync(this.transcriptFile(id), 'utf8')) as CloudTranscriptEntry[] } catch { return [] }
  }

  private async pullTranscript(run: CloudRunSummary): Promise<CloudTranscriptEntry[]> {
    const id = run.id
    const dir = resolve(this.options.root, 'teleport', id)
    if (!existsSync(dir)) {
      mkdirSync(join(this.options.root, 'teleport'), { recursive: true })
      await this.git(run.cwd, ['worktree', 'add', '--detach', dir, 'HEAD'])
    }
    const branches = async (): Promise<string[]> => (await this.git(run.cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/claude']).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean)
    const before = await branches()
    const file = await this.teleport(run, dir)
    // The teleport checked the session's branch out here as a local branch. Let go of it and, when
    // the teleport created that branch, remove it again: the project's branches stay as they were.
    const checkedOut = (await this.git(dir, ['branch', '--show-current']).catch(() => '')).trim()
    await this.git(dir, ['checkout', '--detach']).catch(() => undefined)
    if (checkedOut.startsWith('claude/') && !before.includes(checkedOut) && (await branches()).includes(checkedOut)) await this.git(run.cwd, ['branch', '-D', checkedOut]).catch(() => undefined)
    const parsed = parseTranscript(readFileSync(file, 'utf8'))
    writeFileSync(this.transcriptFile(id), JSON.stringify(parsed.entries))
    this.update(id, { transcriptAt: this.now(), transcriptEntries: parsed.entries.length, usage: parsed.usage, ...(parsed.model ? { confirmedModel: parsed.model } : {}) })
    return parsed.entries
  }

  /**
   * Brings what the session produced into a worktree of its own under this store. Only a
   * remote-tracking ref and that worktree change; the project's working tree, index and branches
   * are never touched.
   */
  async fetch(id: string): Promise<CloudFetchResult> {
    let run = await this.refreshResult(id)
    const git = (args: string[]): Promise<string> => this.git(run.cwd, args)
    if (!run.branch && !run.prUrl) {
      const found = findResult(await git(['ls-remote', 'origin', 'refs/heads/claude/*']), run.branchHint, this.knownHeads(id))
      throw new Error(found.ambiguous.length ? `Several new claude/* branches appeared: ${found.ambiguous.join(', ')}` : 'The session has not pushed a branch yet')
    }
    const pr = run.prUrl ? /\/pull\/(\d+)/.exec(run.prUrl)?.[1] : undefined
    const [ref, local] = run.branch ? [`refs/heads/${run.branch}`, `refs/remotes/origin/${run.branch}`] : [`refs/pull/${pr}/head`, `refs/remotes/origin/cloud-pr-${pr}`]
    await git(['fetch', '--no-tags', 'origin', `+${ref}:${local}`])
    const commit = (await git(['rev-parse', local])).trim()
    const worktreePath = resolve(this.options.root, 'worktrees', id)
    if (existsSync(worktreePath)) await git(['worktree', 'remove', '--force', worktreePath]).catch(() => undefined)
    mkdirSync(join(this.options.root, 'worktrees'), { recursive: true })
    await git(['worktree', 'add', '--detach', worktreePath, commit])
    const base = (await git(['merge-base', 'HEAD', commit]).catch(() => '')).trim()
    const diffStat = base ? (await git(['diff', '--stat', base, commit]).catch(() => '')).trim() : ''
    run = this.update(id, { worktreePath, fetchedCommit: commit })
    return { worktreePath, commit, ref, branch: run.branch, prUrl: run.prUrl, diffStat }
  }

  dispose(): void {
    this.disposed = true
    for (const id of [...this.watchers.keys()]) this.unwatch(id)
    for (const child of this.teleports) try { child.kill() } catch { /* gone */ }
    this.teleports.clear()
    for (const [id, live] of this.live) { this.clear(live); if (!live.exited) try { live.process.kill() } catch { /* gone */ } ; this.persistClientLog(id, live) }
    this.flush()
  }

  // ---------------------------------------------------------------------------------------------

  private spawn(run: CloudRunSummary, args: string[], attach: boolean): void {
    let child: CloudPty
    try {
      child = this.options.spawn(this.cli(), [...(this.options.prefixArgs ?? []), ...args], { cwd: run.cwd, cols: 120, rows: 40, env: this.env(run.id) })
    } catch (error) {
      this.update(run.id, { status: run.sessionId ? run.status : 'failed', error: error instanceof Error ? error.message : String(error) })
      throw error
    }
    const live: LiveRun = { process: child, screen: new TerminalScreen(120, 40), transcript: attach ? this.clientTranscript(run.id).transcript : '', sequence: 0, exited: false, stopping: false, attach, trustAnswered: false, timers: [], analyse: null }
    if (attach) live.screen.write(live.transcript)
    this.live.set(run.id, live)
    this.update(run.id, { attached: true, endedAt: null, exitCode: null, error: null })
    child.onData(data => {
      if (this.live.get(run.id) !== live) return
      live.transcript = (live.transcript + data).slice(-512_000)
      live.screen.write(data)
      this.options.onData?.({ id: run.id, data, sequence: ++live.sequence })
      if (!live.analyse) live.analyse = setTimeout(() => { live.analyse = null; this.analyse(run.id, live) }, 150)
    })
    child.onExit(({ exitCode }) => {
      live.exited = true
      this.clear(live)
      if (this.live.get(run.id) !== live) return
      this.analyse(run.id, live)
      this.readDebug(run.id)
      this.persistClientLog(run.id, live)
      this.live.delete(run.id)
      const current = this.get(run.id)
      const shown = live.screen.text(12)
      if (!current.sessionId) {
        this.update(run.id, { attached: false, exitCode, endedAt: this.now(), status: 'failed', ...(live.stopping ? {} : { error: `The cloud client exited (${exitCode}) before a session was created:\n${shown}` }) })
        return
      }
      const refused = attach && ATTACH_REFUSED.test(shown)
      this.update(run.id, { attached: false, exitCode, ...(attach ? { liveView: !refused && current.liveView !== false } : {}), ...(current.status === 'starting' ? { status: 'running' as const } : {}) })
      if (current.status !== 'stopped' && !live.stopping) {
        this.watch(run.id)
        // The creating client has done its part; a live view is the next thing to try, once.
        if (!attach && current.liveView === null) try { this.attach(run.id) } catch { /* followed on origin instead */ }
      }
    })
    live.timers.push(setInterval(() => { this.readDebug(run.id); this.persistClientLog(run.id, live) }, this.options.pollMs ?? 2000))
  }

  private watch(id: string): void {
    if (this.watchers.has(id)) return
    const tick = (): void => {
      const run = this.runs.get(id)
      if (!run || run.status === 'stopped' || run.status === 'failed' || this.now() - run.createdAt > (this.options.watchForMs ?? 24 * 3600_000)) { this.unwatch(id); return }
      if (this.watching.has(id)) return
      this.watching.add(id)
      void this.refreshResult(id).catch(() => undefined).finally(() => this.watching.delete(id))
    }
    this.watchers.set(id, setInterval(tick, this.options.watchMs ?? 60_000))
    tick()
  }

  private unwatch(id: string): void {
    const timer = this.watchers.get(id)
    if (timer) clearInterval(timer)
    this.watchers.delete(id)
  }

  /**
   * Runs `claude --teleport <session>` in `dir` and returns the conversation file it saved. The
   * teleport fetches the session's messages, checks its branch out and then sits in its own prompt;
   * sits in its own prompt, writing the session's messages into a conversation file under the
   * CLI's projects folder while it does. Once the newest conversation saved for `dir` since the
   * teleport started holds the session's messages, the prompt is closed with Ctrl+C (twice, as the
   * CLI asks) and that file is the answer. Nothing is ever typed into the prompt.
   */
  private teleport(run: CloudRunSummary, dir: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      if (this.disposed) { reject(new Error('Cloud runs are shutting down')); return }
      const startedAt = Date.now()
      const child = this.options.spawn(this.cli(), [...(this.options.prefixArgs ?? []), '--teleport', run.sessionId!], { cwd: dir, cols: 140, rows: 40, env: this.env(run.id) })
      this.teleports.add(child)
      const screen = new TerminalScreen(140, 40)
      let done = false, closing = false
      const holdsMessages = (file: string | null): file is string => {
        try { return file !== null && readFileSync(file, 'utf8').includes('"type":"assistant"') } catch { return false }
      }
      const saved = (): string | null => {
        const localId = /claude --resume ([0-9a-f-]{36})/.exec(screen.text(300))?.[1]
        const named = localId ? this.findConversation(localId) : null
        return holdsMessages(named) ? named : this.newestConversation(dir, startedAt, holdsMessages)
      }
      const finish = (error: Error | null, file?: string): void => {
        if (done) return
        done = true; clearTimeout(timer); clearInterval(poll); this.teleports.delete(child)
        try { child.kill() } catch { /* gone */ }
        if (error) reject(error); else resolvePromise(file!)
      }
      const close = (file: string): void => {
        if (closing) return
        closing = true
        child.write('\x03')
        setTimeout(() => { if (!done) child.write('\x03') }, 500)
        setTimeout(() => finish(null, saved() ?? file), 5000)
      }
      const poll = setInterval(() => { const file = saved(); if (file) close(file) }, 1000)
      const timer = setTimeout(() => { const file = saved(); if (file) finish(null, file); else finish(new Error(`The teleport saved no messages in time:\n${screen.text(10)}`)) }, 180_000)
      child.onData(data => { screen.write(data) })
      child.onExit(({ exitCode }) => {
        const file = saved()
        if (file) finish(null, file); else finish(new Error(`The teleport exited (${exitCode}) without saving the session's messages:\n${screen.text(10)}`))
      })
    })
  }

  /** The newest conversation the CLI saved for `dir` since `since` (its projects folder names
   *  the folder with every character other than a letter, digit or dash turned into a dash). */
  private newestConversation(dir: string, since: number, accept: (file: string) => boolean = () => true): string | null {
    const folder = join(this.projectsDir(), dir.replace(/[^A-Za-z0-9-]/g, '-'))
    try {
      const files = readdirSync(folder).filter(name => name.endsWith('.jsonl')).map(name => ({ path: join(folder, name), at: statSync(join(folder, name)).mtimeMs })).filter(file => file.at >= since - 1000)
      return files.sort((x, y) => y.at - x.at).find(file => accept(file.path))?.path ?? null
    } catch { return null }
  }

  private projectsDir(): string {
    return join(this.options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  }

  /** The conversation file the CLI saved for `localId`, under its projects folder. */
  private findConversation(localId: string): string | null {
    const projects = this.projectsDir()
    try {
      for (const folder of readdirSync(projects)) {
        const candidate = join(projects, folder, `${localId}.jsonl`)
        if (existsSync(candidate)) return candidate
      }
    } catch { /* no projects folder */ }
    return null
  }

  private clear(live: LiveRun): void {
    for (const timer of live.timers) clearInterval(timer)
    live.timers = []
    if (live.analyse) { clearTimeout(live.analyse); live.analyse = null }
  }

  private persistClientLog(id: string, live: LiveRun): void {
    try { writeFileSync(this.clientLog(id), live.transcript) } catch { /* next time */ }
  }

  /** The session id, the model and the branch the client asked for, from its debug log. */
  private readDebug(id: string): void {
    const run = this.runs.get(id)
    if (!run) return
    const found = readCreateLog(tail(this.debugFile(id), 512 * 1024))
    const patch: Partial<CloudRunSummary> = {}
    if (!run.sessionId && found.sessionId) { patch.sessionId = found.sessionId; patch.sessionUrl = `https://claude.ai/code/${found.sessionId}` }
    if (!run.confirmedModel && found.model) patch.confirmedModel = found.model
    if (!run.branchHint && found.branchHint) patch.branchHint = found.branchHint
    if (Object.keys(patch).length) this.update(id, patch)
  }

  private analyse(id: string, live: LiveRun): void {
    const run = this.runs.get(id)
    if (!run) return
    const shown = live.screen.text(80)
    // The CLI asks once per folder whether to trust it. The folder is the owner's own project,
    // which Conductor already runs agents in; answering keeps the run unattended.
    if (!live.trustAnswered && /Yes, I trust this folder/.test(shown)) {
      live.trustAnswered = true
      live.process.write('\x1b[B')
      setTimeout(() => { if (!live.exited) live.process.write('\r') }, 300)
    }
    const patch: Partial<CloudRunSummary> = {}
    if (!run.sessionId) {
      const url = SESSION_URL.exec(shown)
      if (url) { patch.sessionId = url[1]!; patch.sessionUrl = `https://claude.ai/code/${url[1]}` }
    }
    const pr = [...shown.matchAll(PR_URL)].at(-1)?.[0]
    if (pr && pr !== run.prUrl) patch.prUrl = pr
    if (Object.keys(patch).length) this.update(id, patch)
  }

  private update(id: string, patch: Partial<CloudRunSummary>): CloudRunSummary {
    const current = this.runs.get(id)
    if (!current) throw new Error('No cloud run with that id')
    const next = { ...current, ...patch, updatedAt: this.now() }
    this.runs.set(id, next)
    this.scheduleSave()
    this.options.onChanged?.(next)
    return next
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush() }, 300)
  }

  private flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    try {
      const temp = this.file + '.tmp'
      writeFileSync(temp, JSON.stringify([...this.runs.values()], null, 1))
      renameSync(temp, this.file)
    } catch { /* next change saves again */ }
  }
}
