/**
 * Claude Code cloud sessions run as Conductor coworkers (docs/cloud-coworker.md). The session
 * itself runs on Anthropic's cloud against the project's GitHub repository; Conductor hosts the
 * `claude --cloud` client that created it in a PTY, shows that client in a 'cloud' tab, and
 * fetches the branch or pull request the session produced into a worktree of its own.
 */

export type CloudRunStatus =
  /** The client is creating the session; no session id yet. */
  | 'starting'
  /** The session exists and has not pushed anything yet. */
  | 'running'
  /** The session pushed its branch (and may have opened a pull request); it may still be working. */
  | 'pushed'
  /** Conductor stopped following the run (cloud.stop). */
  | 'stopped'
  /** The client exited before any session existed. */
  | 'failed'

/** One message of the session's transcript, as the CLI's teleport saved it. */
export interface CloudTranscriptEntry {
  role: 'user' | 'assistant' | 'tool' | 'result'
  text: string
  at: string | null
}

export interface CloudUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; messages: number }

export interface CloudRunSummary {
  id: string
  projectId: string
  workspaceId: string
  title: string
  prompt: string
  model: string
  effort: string | null
  /** Base branch, tag or SHA the session started from; null means the repository's default. */
  ref: string | null
  status: CloudRunStatus
  /** A client process is attached to the session right now (creating it, or a live view). */
  attached: boolean
  /** Whether this account may attach a live client to an existing session (the CLI's attach gate); null until tried. */
  liveView: boolean | null
  /** The project folder the run was started from; git and the CLI run there. */
  cwd: string
  sessionId: string | null
  sessionUrl: string | null
  /** The model the client asked the cloud for (its debug log), then the one the session's messages name. */
  confirmedModel: string | null
  /** The branch the session was told to push to; the pushed branch may carry a suffix. */
  branchHint: string | null
  branch: string | null
  /** The pushed branch's head on origin. */
  headCommit: string | null
  prUrl: string | null
  /** When the transcript was last pulled, its message count, and the session's token usage. */
  transcriptAt: number | null
  transcriptEntries: number
  usage: CloudUsage | null
  /** Where "Fetch for verification" checked the result out, never the owner's working tree. */
  worktreePath: string | null
  fetchedCommit: string | null
  /** Whoever started it: 'owner', or the conversation id of the controller. */
  startedBy: string
  createdAt: number
  updatedAt: number
  endedAt: number | null
  exitCode: number | null
  error: string | null
}

export interface CloudModel { id: string; label: string; isDefault?: boolean }

/** Full names, so a later alias change never silently moves a run to another model. */
export const CLOUD_MODELS: CloudModel[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (cloud)', isDefault: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (cloud)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cloud)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (cloud)' }
]
export const CLOUD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const MAX_CLOUD_PROMPT_CHARS = 20_000

export interface CloudStartInput {
  projectId: string
  workspaceId: string
  prompt: string
  model?: string
  effort?: string
  ref?: string
  title?: string
}

export interface CloudFetchResult {
  worktreePath: string
  commit: string
  /** The remote ref that was fetched (refs/heads/<branch> or refs/pull/<n>/head). */
  ref: string
  branch: string | null
  prUrl: string | null
  /** `git diff --stat` of the result against the commit it shares with this checkout's HEAD. */
  diffStat: string
}

export interface CloudBridge {
  list(projectId: string): Promise<CloudRunSummary[]>
  get(projectId: string, runId: string): Promise<CloudRunSummary>
  start(input: CloudStartInput): Promise<CloudRunSummary>
  ensure(projectId: string, runId: string): Promise<{ summary: CloudRunSummary; transcript: string; sequence: number }>
  write(runId: string, data: string): void
  resize(runId: string, cols: number, rows: number): void
  interrupt(projectId: string, runId: string): Promise<CloudRunSummary>
  stop(projectId: string, runId: string): Promise<CloudRunSummary>
  attach(projectId: string, runId: string): Promise<CloudRunSummary>
  fetch(projectId: string, runId: string): Promise<CloudFetchResult>
  transcript(projectId: string, runId: string, refresh: boolean): Promise<CloudTranscriptEntry[]>
  onData(callback: (event: { id: string; data: string; sequence: number }) => void): () => void
  onChanged(callback: (summary: CloudRunSummary) => void): () => void
}

export const CLOUD_CHANNELS = {
  list: 'cloud:list',
  get: 'cloud:get',
  start: 'cloud:start',
  ensure: 'cloud:ensure',
  write: 'cloud:write',
  resize: 'cloud:resize',
  interrupt: 'cloud:interrupt',
  stop: 'cloud:stop',
  attach: 'cloud:attach',
  fetch: 'cloud:fetch',
  transcript: 'cloud:transcript',
  data: 'cloud:data',
  changed: 'cloud:changed'
} as const
