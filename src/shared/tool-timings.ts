/**
 * Tool-call timing analysis (docs/perf-evidence/t3code-cloud-tool-timings.md): how long each
 * structured agent tool call took (Claude, Codex, Grok and local-model tabs; raw CLI-view tabs,
 * cloud coworkers and mirrored remote conversations are not recorded), with the parts of that time a provider or
 * Conductor actually observed. Pure: the recorder (src/main/tool-timings.ts), the tools.timings
 * control method and the Settings → Usage breakdown share these types and this aggregation.
 *
 * Nothing is derived that was not observed. Elapsed time is measured from the first non-terminal
 * event Conductor saw for the call; a call first seen already finished has no elapsed time. Wait
 * is the time spent in `awaiting_approval`, and only when that phase was seen. Execution is the
 * provider's own duration, or Conductor's observed `running` phase; never elapsed minus wait.
 * Where a provider stamps an item's start and end on its own clock (Codex), elapsed is that
 * provider interval instead, labelled `provider`; host and provider stamps are never subtracted
 * from each other. A provider's automatic approval review is `reviewMs`, apart from wait.
 * A missing measurement is null and counted as unavailable, never as zero.
 */

export type ToolTimingOutcome = 'completed' | 'failed' | 'rejected' | 'interrupted' | 'abandoned'
export type ToolCategory = 'shell' | 'file-read' | 'file-write' | 'search' | 'web' | 'mcp' | 'agent' | 'other'
/** host-monotonic: this process' monotonic clock; wall-clock: across a restart, where only wall
 *  time survives (bounded to a day, never negative); provider: the provider's own start and end
 *  stamps of the item's lifecycle, both on its clock (Codex startedAtMs → completedAtMs). That is
 *  lifecycle time, not execution, and is never mixed with a host stamp. */
export type ElapsedSource = 'host-monotonic' | 'wall-clock' | 'provider' | 'transcript-wall' | 'unavailable'
/** native: a structured tab this host observed live. cli-transcript: a raw Claude CLI-view tab's
 *  call read afterwards from the rows its CLI appended to the conversation's transcript while the
 *  tab owned it (transcript-wall: that CLI's own row times on this machine). cloud-transcript: a cloud coworker's call read
 *  afterwards from its teleported transcript (transcript-wall elapsed: the cloud's own write times of
 *  the tool_use and its tool_result rows). Kept apart from the native report unless asked for. */
export type ToolTimingOrigin = 'native' | 'cloud-transcript' | 'cli-transcript'
/** provider-review: the provider's own auto-approval review time (Codex guardian), overlaps counted
 *  once. Kept apart from WaitSource, which is a human approval this host observed. */
export type ReviewSource = 'provider-review'
export type WaitSource = 'observed-approval' | 'unavailable'
export type ExecSource = 'provider' | 'host-phase' | 'unavailable'

export interface ToolTimingRecord {
  /** sessionId, runtimeId and the provider's item id: item ids repeat across runtimes and tabs. */
  key: string
  agentSessionId: string
  projectId: string
  provider: string
  runtimeId: string
  itemId: string
  turnId?: string
  model?: string
  tool: string
  category: ToolCategory
  /** A bounded, secret-masked summary of the arguments: never the full input. */
  args: string
  /** Wall-clock instant of the first non-terminal event; null when first seen finished. */
  startedAt: string | null
  endedAt: string
  elapsedMs: number | null
  elapsedSource: ElapsedSource
  waitMs: number | null
  waitSource: WaitSource
  execMs: number | null
  execSource: ExecSource
  /** Time the call spent in `preparing` (the model still writing its arguments), when seen. */
  prepareMs: number | null
  /** Absent for a native call. */
  origin?: 'cloud-transcript' | 'cli-transcript'
  /** The provider's automatic approval review of this call (absent: none reported). Not part of waitMs. */
  reviewMs?: number
  reviewSource?: ReviewSource
  outcome: ToolTimingOutcome
  exitCode?: number
  /** First meaningful line of a failure's output, masked and bounded. */
  error?: string
  /** Provider-confirmed background work that outlives its turn: kept out of latency percentiles. */
  detached?: boolean
  /** Other calls of the same conversation already in flight when this one was first seen. */
  concurrent: number
  /** Repeated terminal statements of this same call that were dropped. */
  restated?: number
  notes?: string[]
}

export interface ToolTimingsQuery {
  projectId?: string
  agentSessionId?: string
  provider?: string
  tool?: string
  since?: string
  until?: string
  /** Rows in tools/slowest/failures/offenders; default 10, at most 50. */
  limit?: number
  /** Most recent raw records to include; default 0, at most 100. */
  recent?: number
  includeDetached?: boolean
  /** Which records: native tabs (the default) or cloud-coworker transcripts, never both mixed. */
  origin?: ToolTimingOrigin
}

/** One tool call paired from a cloud transcript by its exact tool_use_id (cloud/runs.ts
 *  parseTranscript). Stamps are the transcript rows' own ISO times, null when absent or invalid;
 *  a call with notes (a conflicting restatement, a result naming another row) is never timed.
 *  `result` is bounded and only ever summarized as a failure's masked first line. */
export interface TranscriptToolCall {
  toolUseId: string
  name: string
  input: unknown
  usedAt: string | null
  resultAt: string | null
  isError: boolean
  /** The CLI's toolDenialKind on the result: a denial, or a result it wrote for an interrupted call. */
  denied: string | null
  result: string
  notes: string[]
}

/** Why a raw Claude CLI view's transcript read is (not) the whole of what its CLI appended. */
export type CliCaptureReason =
  | 'complete' | 'no-transcript'
  | 'window-truncated' | 'call-limit'
  | 'boundary-missing' | 'boundary-unverified' | 'boundary-malformed'
  | 'file-missing' | 'file-shrank' | 'file-replaced' | 'file-changed' | 'file-unreadable'
/**
 * What one return to Chat read of the CLI view's own rows. `complete` only when the persisted
 * boundary was verified against the file and every row after it was read; `partial` when rows
 * after a verified boundary were not read (their calls are absent, never estimated); `unavailable`
 * when no row could be trusted as the CLI's own (nothing was imported). Counts only; no content.
 */
export interface CliCaptureCoverage {
  status: 'complete' | 'partial' | 'unavailable'
  reason: CliCaptureReason
  boundaryBytes: number | null
  fileBytes: number | null
  bytesRead: number
  /** Appended bytes before the read window, never read. */
  bytesSkipped: number
  /** Calls with no result among the rows read. */
  unmatchedCalls: number
  /** Results whose call lies in unread rows: untimed, not estimated. */
  unpairedResults: number
  /** Paired calls or held entries the pairing bounds let go. */
  droppedCalls: number
}
export interface CliCaptureNote extends CliCaptureCoverage { handoffId: string; agentSessionId: string; nativeSessionId: string }

export interface DurationStats { measured: number; unavailable: number; p50: number | null; p95: number | null; max: number | null; totalMs: number }
export interface ToolAggregate {
  tool: string
  category: ToolCategory
  providers: string[]
  calls: number
  failures: number
  elapsed: DurationStats
  wait: DurationStats
  exec: DurationStats
  prepare: DurationStats
  review: DurationStats
}
export interface FailureGroup { tool: string; provider: string; count: number; calls: number; exitCodes: number[]; lastError: string | null; lastAt: string; example: string }
export interface ProviderCoverage { provider: string; calls: number; elapsed: number; elapsedFromProvider: number; wait: number; review: number; exec: number; execFromProvider: number; abandoned: number }
export interface ToolOffender {
  kind: 'failure-rate' | 'approval-wait' | 'slow' | 'repeated' | 'argument-streaming' | 'abandoned' | 'coverage'
  tool: string
  provider: string | null
  severity: 'high' | 'medium' | 'low'
  summary: string
  evidence: { calls: number; failures?: number; p50Ms?: number | null; p95Ms?: number | null; examples: string[]; sessions: number }
  suggestion: string
}
export interface ToolTimingsReport {
  observedAt: string
  filters: Omit<ToolTimingsQuery, 'limit' | 'recent'>
  window: { from: string | null; to: string | null }
  totals: { calls: number; failures: number; failureRate: number | null; abandoned: number; detached: number; inFlight: number }
  coverage: { elapsed: number; wait: number; review: number; exec: number; providers: ProviderCoverage[] }
  tools: ToolAggregate[]
  slowest: ToolTimingRecord[]
  failures: FailureGroup[]
  offenders: ToolOffender[]
  recent: ToolTimingRecord[]
  storage: { records: number; capacity: number; retentionDays: number; recordedSince: string | null; deduplicated: number; droppedOnLoad: number; parseErrors: number }
  /** Since this process started (not persisted): what each raw Claude CLI-view return could read. Absent until one returned. */
  captureCoverage?: { cliTranscript: { returns: number; complete: number; partial: number; unavailable: number; recentIncomplete: CliCaptureNote[] } }
  gaps: string[]
}

export interface ToolTimingsBridge {
  report(query?: ToolTimingsQuery): Promise<ToolTimingsReport>
}

export const TOOL_TIMING_LIMITS = { top: 10, maxTop: 50, maxRecent: 100, args: 160, error: 160, tool: 80 } as const

/** What each provider's events can and cannot say; repeated in every report so a missing number
 *  reads as a gap of that provider rather than a fast tool. */
export const TOOL_TIMING_GAPS: Readonly<Record<string, string>> = {
  codex: 'Codex: commandExecution, mcpToolCall and dynamicToolCall report their own durationMs (exec = provider). File changes and web search report none. Elapsed is the provider\'s item lifecycle (startedAtMs → completedAtMs) when both stamps arrived, else host-observed; an item seen only completing has none. Human approval wait is observed when the app-server asks; the automatic approval review is reported separately (review, provider clock; unstable protocol, reviews without a target item are not attributed).',
  claude: 'Claude: the stream reports no tool duration; exec is Conductor\'s observed running phase (includes stream transport latency). Auto-mode classifier time inside the CLI is not visible, so wait is unavailable unless a card was raised.',
  grok: 'Grok: no tool duration; exec is the observed running phase. Approval wait is observed when the ACP permission request arrives.',
  local: 'Local model: Conductor\'s own runtime measures each tool (exec = provider). There is no approval phase, so wait is unavailable.',
  cli: 'Codex and Grok CLI-view tabs (raw terminal) and conversations mirrored from another machine emit no structured tool events here: they are not covered. Claude CLI-view tabs are read from their transcript when the tab returns to Chat (origin cli-transcript).',
  'claude-cli': 'Claude CLI-view tabs (origin cli-transcript): read when the tab returns to Chat, from rows the CLI appended after the handoff (at most the newest 16 MiB), never live. Elapsed is the CLI\'s own row times from tool_use to its tool_result (transcript-wall), which includes permission, hooks and queueing: not execution, and no approval wait. Calls without a result, denied or interrupted results, and missing or reversed times are not timed. A return whose boundary cannot be verified against the file, or whose appended rows exceed the window, is reported in captureCoverage as partial or unavailable, never as complete.',
  'claude-cloud': 'Cloud coworkers (origin cloud-transcript): read from the teleported transcript after a pull, never live. Elapsed is the cloud\'s own row times from tool_use to its tool_result (transcript-wall), which includes permission, hooks and queueing: not execution, and no approval wait. Calls without a result yet, denied or interrupted results, and missing or reversed times are not timed.'
}

const SECRETISH_KEY = /(secret|token|password|passwd|api[_-]?key|auth|credential|cookie|private)/i
/** A name that holds a secret, in a URL query, a cookie or an assignment. Deliberately wide: a
 *  masked `max_tokens=8` costs a little detail, a missed `?token=` leaks a credential to disk. */
const SECRET_NAME = String.raw`[\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|credential|session|sess(?:ion)?id|sid|signature|sig|cookie|csrf|xsrf)[\w.-]*`
/** In a URL an OAuth `code` is a credential too; in prose `code: 2` is an exit status. */
const SECRET_QUERY_NAME = String.raw`(?:${SECRET_NAME}|[\w.-]*code[\w.-]*)`
// ?token=…, &sig=…, ;sessionid=… in a URL or a cookie string.
const SECRET_QUERY = new RegExp(String.raw`([?&;]\s*${SECRET_QUERY_NAME}=)[^&#;\s"']+`, 'gi')
// name = "value", "name": "value", name: 'value', name=value (any case).
const SECRET_ASSIGNMENT = new RegExp(String.raw`((?:^|[\s{,(;])["']?${SECRET_NAME}["']?\s*[:=]\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s,;}&)"']+)`, 'gi')
/** Extra forms beyond the journal's masker: URL credentials and secret-named query parameters,
 *  cookie headers and session cookies, quoted and unquoted secret assignments (JSON, YAML, env,
 *  code), AWS keys, Slack tokens, and secret flags. Applied before it, so both run on every summary. */
export function maskToolText(text: string, mask: (text: string) => string = value => value): string {
  return mask(text
    // A Cookie or Set-Cookie header (curl -H, fetch headers): its whole value.
    .replace(/((?:set-)?cookie["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\n"']+)/gi, '$1[REDACTED]')
    .replace(/(--cookie(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(SECRET_QUERY, '$1[REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/g, '$1[REDACTED]')
    .replace(/(--?(?:password|passwd|token|secret|api-?key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]'))
}

const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max - 1) + '…' : text
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function toolCategory(name: string): ToolCategory {
  const tool = name.toLowerCase()
  if (/^mcp__|\//.test(tool) && !/^(bash|powershell|command)$/.test(tool)) return 'mcp'
  if (/^(bash|powershell|command|shell|exec|run_command|bashoutput|killshell|run_and_summarize)$/.test(tool)) return 'shell'
  if (/^(read|notebookread|view|read_file|list_files|ls|summarize_file)$/.test(tool)) return 'file-read'
  if (/^(write|edit|multiedit|notebookedit|file change|apply_patch|write_file|edit_file|process_files)$/.test(tool)) return 'file-write'
  if (/^(grep|glob|search|find|search_files|codebase_search)$/.test(tool)) return 'search'
  if (/^(webfetch|websearch|web_search|fetch)$/.test(tool)) return 'web'
  if (/^(task|agent|spawnagent|subagent)$/.test(tool)) return 'agent'
  return 'other'
}

const pick = (input: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) { const value = input[key]; if (typeof value === 'string' && value.trim()) return value }
  return undefined
}
/** The shortest faithful hint of what the call did: a command's first line, a path, a pattern, or
 *  the argument names. Bounded before masking so a huge input costs nothing on the hot path. */
export function summarizeToolArgs(name: string, input: unknown, mask: (text: string) => string = value => value): string {
  if (input === undefined || input === null) return ''
  const max = TOOL_TIMING_LIMITS.args
  if (typeof input === 'string') return clip(maskToolText(oneLine(input.slice(0, max * 4)), mask), max)
  if (Array.isArray(input)) {
    const paths = input.map(item => item && typeof item === 'object' ? pick(item as Record<string, unknown>, ['path', 'file_path']) : undefined).filter((path): path is string => Boolean(path))
    return clip(maskToolText(paths.length ? `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3}` : ''}` : `[${input.length} items]`, mask), max)
  }
  if (typeof input !== 'object') return clip(String(input), max)
  const record = input as Record<string, unknown>
  const command = pick(record, ['command', 'cmd', 'script'])
  if (command) return clip(maskToolText(oneLine(command.split(/\r?\n/, 1)[0]!.slice(0, max * 4)), mask), max)
  const path = pick(record, ['file_path', 'path', 'notebook_path', 'filePath'])
  const pattern = pick(record, ['pattern', 'query', 'url', 'glob'])
  if (path || pattern) return clip(maskToolText(oneLine([pattern, path].filter(Boolean).join(' in ').slice(0, max * 4)), mask), max)
  const description = pick(record, ['description', 'subagent_type', 'prompt'])
  if (description && toolCategory(name) === 'agent') return clip(maskToolText(oneLine(description.slice(0, max * 4)), mask), max)
  const keys = Object.keys(record).slice(0, 8).map(key => SECRETISH_KEY.test(key) ? `${key}=[REDACTED]` : key)
  return clip(keys.length ? `{${keys.join(', ')}}` : '{}', max)
}

/** First meaningful line of a failure's output (the last non-empty line when it is short). */
export function summarizeToolError(output: string | undefined, stderr: string | undefined, mask: (text: string) => string = value => value): string | undefined {
  const text = (stderr?.trim() ? stderr : output)?.slice(-4000)
  if (!text?.trim()) return undefined
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const line = lines.find(item => /error|fail|denied|not found|refused|timed? ?out|cannot|invalid|exception/i.test(item)) ?? lines.at(-1)!
  // Bounded before masking, like the arguments: the masker's cost grows with the line.
  return clip(maskToolText(oneLine(line).slice(0, TOOL_TIMING_LIMITS.error * 4), mask), TOOL_TIMING_LIMITS.error)
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!
}
function stats(values: Array<number | null>): DurationStats {
  const measured = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
  return { measured: measured.length, unavailable: values.length - measured.length, p50: percentile(measured, 0.5), p95: percentile(measured, 0.95), max: measured.at(-1) ?? null, totalMs: measured.reduce((sum, value) => sum + value, 0) }
}

const isFailure = (record: ToolTimingRecord): boolean => record.outcome === 'failed' || record.outcome === 'rejected'
const spentMs = (record: ToolTimingRecord): number | null => record.elapsedMs ?? record.execMs
const parseTime = (value: string | undefined): number | undefined => { if (!value) return undefined; const at = Date.parse(value); return Number.isFinite(at) ? at : undefined }

export function filterToolTimings(records: readonly ToolTimingRecord[], query: ToolTimingsQuery): ToolTimingRecord[] {
  const since = parseTime(query.since), until = parseTime(query.until), tool = query.tool?.toLowerCase()
  const origin = query.origin ?? 'native'
  return records.filter(record => {
    if ((record.origin ?? 'native') !== origin) return false
    if (query.projectId && record.projectId !== query.projectId) return false
    if (query.agentSessionId && record.agentSessionId !== query.agentSessionId) return false
    if (query.provider && record.provider !== query.provider) return false
    if (tool && record.tool.toLowerCase() !== tool) return false
    const at = Date.parse(record.endedAt)
    if (since !== undefined && at < since) return false
    if (until !== undefined && at > until) return false
    return true
  })
}

const SECOND = 1000
const formatMs = (ms: number | null | undefined): string => ms === null || ms === undefined ? 'n/a' : ms < SECOND ? `${Math.round(ms)} ms` : ms < 60 * SECOND ? `${(ms / SECOND).toFixed(1)} s` : `${(ms / 60 / SECOND).toFixed(1)} min`
export { formatMs as formatToolMs }

/** Advice comes only from what the records show; each names its numbers and examples. */
export function toolOffenders(records: readonly ToolTimingRecord[], limit: number): ToolOffender[] {
  const groups = new Map<string, ToolTimingRecord[]>()
  for (const record of records) {
    const key = `${record.provider}\u0000${record.tool}`
    const list = groups.get(key)
    if (list) list.push(record); else groups.set(key, [record])
  }
  const offenders: Array<ToolOffender & { score: number }> = []
  const examples = (list: ToolTimingRecord[]): string[] => [...new Set(list.map(record => record.args).filter(Boolean))].slice(0, 3)
  const sessions = (list: ToolTimingRecord[]): number => new Set(list.map(record => record.agentSessionId)).size
  for (const list of groups.values()) {
    const { tool, provider, category } = list[0]!
    const calls = list.length
    const failed = list.filter(isFailure)
    if (calls >= 4 && failed.length / calls >= 0.3) {
      const errors = failed.map(record => record.error).filter((error): error is string => Boolean(error))
      const common = errors.sort((a, b) => errors.filter(e => e === b).length - errors.filter(e => e === a).length)[0]
      const cause = common ?? ''
      const suggestion = /sandbox|helper_unknown_error|acl/i.test(cause) ? 'The sandbox itself is failing, not the command: repair the sandbox (docs/codex-windows-sandbox-repair.md) before the agent retries.'
        : /denied|permission|not permitted|eacces|eperm/i.test(cause) ? 'Calls are refused by permissions: grant the command class once (Always allow) or run the tab in Auto rather than letting the agent retry.'
        : /not found|enoent|no such file|is not recognized/i.test(cause) ? 'A program or path the agent expects is missing: install it, or brief the agent on the right command for this machine.'
        : /timed? ?out|etimedout/i.test(cause) ? 'Calls time out: give the command a narrower scope or run it in the background and poll.'
        : 'Read the common error and fix its cause once; repeated failing calls cost a model round each.'
      offenders.push({ kind: 'failure-rate', tool, provider, severity: failed.length / calls >= 0.5 ? 'high' : 'medium', summary: `${tool} failed ${failed.length} of ${calls} calls${common ? `: “${common}”` : ''}`,
        evidence: { calls, failures: failed.length, examples: examples(failed), sessions: sessions(failed) }, suggestion, score: failed.length * 10 })
    }
    const waited = list.filter(record => record.waitMs !== null && record.waitMs > 0)
    const wait = stats(waited.map(record => record.waitMs))
    if (waited.length >= 3 && (wait.p50 ?? 0) >= 10 * SECOND) offenders.push({ kind: 'approval-wait', tool, provider, severity: (wait.p50 ?? 0) >= 60 * SECOND ? 'high' : 'medium',
      summary: `${tool} waited for approval ${waited.length} times (p50 ${formatMs(wait.p50)}, total ${formatMs(wait.totalMs)})`,
      evidence: { calls, p50Ms: wait.p50, p95Ms: wait.p95, examples: examples(waited), sessions: sessions(waited) },
      suggestion: 'The time is spent waiting for an answer, not running: add an Always-allow rule for this command class, or let an approval policy or a wizard tab answer it.', score: wait.totalMs / SECOND })
    const timed = list.filter(record => !record.detached)
    const exec = stats(timed.map(record => record.execMs ?? record.elapsedMs))
    if (exec.measured >= 3 && (exec.p95 ?? 0) >= 60 * SECOND) offenders.push({ kind: 'slow', tool, provider, severity: (exec.p95 ?? 0) >= 5 * 60 * SECOND ? 'high' : 'medium',
      summary: `${tool} is slow: p50 ${formatMs(exec.p50)}, p95 ${formatMs(exec.p95)} over ${exec.measured} timed calls`,
      evidence: { calls, p50Ms: exec.p50, p95Ms: exec.p95, examples: examples(timed.filter(record => (record.execMs ?? record.elapsedMs ?? 0) >= (exec.p50 ?? 0))), sessions: sessions(timed) },
      suggestion: category === 'shell' ? 'Narrow the command (one test file, one package), run long builds through run_and_summarize, or background them and poll instead of blocking the turn.'
        : category === 'web' ? 'Slow fetches block the turn: prefer local docs or a cached copy, and cap what is fetched.'
        : category === 'mcp' ? 'The MCP server is slow to answer: check that server (local.servers for the local model) or batch its calls.'
        : 'Check what makes this tool slow on this machine before the agent calls it again.', score: exec.totalMs / SECOND })
    const prepare = stats(list.map(record => record.prepareMs))
    if (prepare.measured >= 3 && (prepare.p95 ?? 0) >= 30 * SECOND) offenders.push({ kind: 'argument-streaming', tool, provider, severity: 'low',
      summary: `The model spent p95 ${formatMs(prepare.p95)} writing ${tool} arguments before the call ran`,
      evidence: { calls, p50Ms: prepare.p50, p95Ms: prepare.p95, examples: examples(list), sessions: sessions(list) },
      suggestion: 'Large inputs are generated token by token: prefer small Edit calls over rewriting whole files.', score: prepare.totalMs / SECOND / 2 })
    const repeats = new Map<string, ToolTimingRecord[]>()
    for (const record of list) if (record.args) { const key = `${record.agentSessionId}\u0000${record.args}`; const same = repeats.get(key); if (same) same.push(record); else repeats.set(key, [record]) }
    const repeated = [...repeats.values()].sort((a, b) => b.length - a.length)[0]
    if (repeated && repeated.length >= 5) offenders.push({ kind: 'repeated', tool, provider, severity: 'low',
      summary: `${tool} ran the same arguments ${repeated.length} times in one conversation`,
      evidence: { calls: repeated.length, failures: repeated.filter(isFailure).length, examples: [repeated[0]!.args], sessions: 1 },
      suggestion: 'The agent repeats an identical call: keep the first result, or brief it with what changed between attempts.', score: repeated.length })
    const abandoned = list.filter(record => record.outcome === 'abandoned')
    if (abandoned.length >= 3) offenders.push({ kind: 'abandoned', tool, provider, severity: 'low',
      summary: `${abandoned.length} ${tool} calls never reported an end`,
      evidence: { calls, examples: examples(abandoned), sessions: sessions(abandoned) },
      suggestion: 'These calls were cut off by a restart, a lost runtime or a crash: their time is unknown, not zero.', score: abandoned.length })
  }
  const byProvider = new Map<string, ToolTimingRecord[]>()
  for (const record of records) { const list = byProvider.get(record.provider); if (list) list.push(record); else byProvider.set(record.provider, [record]) }
  for (const [provider, list] of byProvider) {
    const unavailable = list.filter(record => record.execMs === null && record.elapsedMs === null).length
    if (list.length >= 10 && unavailable / list.length >= 0.8) offenders.push({ kind: 'coverage', tool: '*', provider, severity: 'low',
      summary: `${unavailable} of ${list.length} ${provider} calls have no measured time`,
      evidence: { calls: list.length, examples: [], sessions: sessions(list) },
      suggestion: TOOL_TIMING_GAPS[provider] ?? 'This provider reports no timing for these calls; treat its totals as a lower bound.', score: 0 })
  }
  const rank = { high: 3, medium: 2, low: 1 }
  return offenders.sort((a, b) => rank[b.severity] - rank[a.severity] || b.score - a.score).slice(0, limit).map(({ score: _score, ...offender }) => offender)
}

export function aggregateToolTimings(all: readonly ToolTimingRecord[], query: ToolTimingsQuery, context: { observedAt: string; inFlight: number; storage: ToolTimingsReport['storage'] }): ToolTimingsReport {
  const limit = Math.min(TOOL_TIMING_LIMITS.maxTop, Math.max(1, Math.floor(query.limit ?? TOOL_TIMING_LIMITS.top)))
  const recentCount = Math.min(TOOL_TIMING_LIMITS.maxRecent, Math.max(0, Math.floor(query.recent ?? 0)))
  const matched = filterToolTimings(all, query)
  const records = query.includeDetached ? matched : matched.filter(record => !record.detached)
  const failures = records.filter(isFailure)
  const byTool = new Map<string, ToolTimingRecord[]>()
  for (const record of records) { const list = byTool.get(record.tool); if (list) list.push(record); else byTool.set(record.tool, [record]) }
  const tools: ToolAggregate[] = [...byTool.entries()].map(([tool, list]) => ({
    tool, category: list[0]!.category, providers: [...new Set(list.map(record => record.provider))].sort(), calls: list.length, failures: list.filter(isFailure).length,
    elapsed: stats(list.map(record => record.elapsedMs)), wait: stats(list.map(record => record.waitMs)), exec: stats(list.map(record => record.execMs)), prepare: stats(list.map(record => record.prepareMs)),
    review: stats(list.map(record => record.reviewMs ?? null))
  })).sort((a, b) => (b.elapsed.totalMs || b.exec.totalMs) - (a.elapsed.totalMs || a.exec.totalMs) || b.calls - a.calls).slice(0, limit)
  const slowest = records.filter(record => spentMs(record) !== null).sort((a, b) => spentMs(b)! - spentMs(a)!).slice(0, limit)
  const failureGroups = new Map<string, FailureGroup>()
  for (const record of failures) {
    const key = `${record.provider}\u0000${record.tool}\u0000${record.error ?? ''}`
    const group = failureGroups.get(key)
    if (!group) failureGroups.set(key, { tool: record.tool, provider: record.provider, count: 1, calls: byTool.get(record.tool)?.length ?? 1, exitCodes: record.exitCode !== undefined ? [record.exitCode] : [], lastError: record.error ?? null, lastAt: record.endedAt, example: record.args })
    else {
      group.count++
      if (record.exitCode !== undefined && !group.exitCodes.includes(record.exitCode) && group.exitCodes.length < 5) group.exitCodes.push(record.exitCode)
      if (record.endedAt > group.lastAt) { group.lastAt = record.endedAt; group.example = record.args }
    }
  }
  const providers = new Map<string, ProviderCoverage>()
  for (const record of records) {
    const row = providers.get(record.provider) ?? { provider: record.provider, calls: 0, elapsed: 0, elapsedFromProvider: 0, wait: 0, review: 0, exec: 0, execFromProvider: 0, abandoned: 0 }
    row.calls++
    if (record.elapsedMs !== null) row.elapsed++
    if (record.elapsedSource === 'provider') row.elapsedFromProvider++
    if (record.waitMs !== null) row.wait++
    if (record.reviewMs !== undefined) row.review++
    if (record.execMs !== null) row.exec++
    if (record.execSource === 'provider') row.execFromProvider++
    if (record.outcome === 'abandoned') row.abandoned++
    providers.set(record.provider, row)
  }
  const ended = records.map(record => record.endedAt).sort()
  const share = (count: number): number => records.length ? Math.round(count / records.length * 1000) / 1000 : 0
  const seen = new Set(records.map(record => record.provider))
  const { limit: _limit, recent: _recent, ...filters } = query
  return {
    observedAt: context.observedAt,
    filters,
    window: { from: ended[0] ?? null, to: ended.at(-1) ?? null },
    totals: { calls: records.length, failures: failures.length, failureRate: records.length ? Math.round(failures.length / records.length * 1000) / 1000 : null, abandoned: records.filter(record => record.outcome === 'abandoned').length, detached: matched.filter(record => record.detached).length, inFlight: context.inFlight },
    coverage: { elapsed: share(records.filter(record => record.elapsedMs !== null).length), wait: share(records.filter(record => record.waitMs !== null).length), review: share(records.filter(record => record.reviewMs !== undefined).length), exec: share(records.filter(record => record.execMs !== null).length), providers: [...providers.values()].sort((a, b) => b.calls - a.calls) },
    tools,
    slowest,
    failures: [...failureGroups.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, limit),
    offenders: toolOffenders(records, limit),
    recent: recentCount ? records.slice(-recentCount).reverse() : [],
    storage: context.storage,
    gaps: [...Object.entries(TOOL_TIMING_GAPS).filter(([provider]) => provider === 'cli' || !seen.size || seen.has(provider)).map(([, gap]) => gap)]
  }
}
