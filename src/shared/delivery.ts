/**
 * Source control delivery: one call takes a project's finished work from the working tree to a
 * verified local commit — test, build, commit — and, only when asked to publish, on to a push and
 * the GitHub release that other devices update from. Routine deliveries stay on this machine;
 * the installed app here updates from the checkout through app.update. It runs on the host, with
 * the owner's own Git credentials and network, so no agent sandbox has to reach GitHub or ask to
 * leave the workspace to deliver.
 */

export type DeliveryStageId = 'preflight' | 'test' | 'build' | 'commit' | 'push' | 'release'
export type DeliveryStageState = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

export interface DeliveryStage {
  id: DeliveryStageId
  label: string
  state: DeliveryStageState
  startedAt: string | null
  finishedAt: string | null
  /** One line on what happened, or why it was skipped or failed. */
  detail: string
  /** Bounded tail of the stage's command output (at most 40 lines). */
  log: string[]
}

export type DeliveryRequester = { kind: 'owner' } | { kind: 'agent'; agentSessionId: string; title: string }

export interface DeliveryRun {
  id: string
  projectId: string
  state: 'running' | 'delivered' | 'failed' | 'cancelled'
  requestedBy: DeliveryRequester
  message: string
  /** Null commits every change in the working tree; otherwise only these repository paths. */
  paths: string[] | null
  /** False: the commit stays local (push and release are skipped). True: push and verify the
   *  GitHub release. Absent on runs recorded before the distinction existed, which published. */
  publish?: boolean
  startedAt: string
  finishedAt: string | null
  commit: string | null
  releaseTag: string | null
  releaseUrl: string | null
  workflowRunUrl: string | null
  stages: DeliveryStage[]
  /** Why the run stopped, in words an agent or the owner can act on. */
  error: string | null
}

export interface RepositoryFile {
  path: string
  /** Porcelain v1 index/worktree status letters, e.g. 'M', 'A', 'D', '?'. */
  index: string
  worktree: string
}

export interface RepositoryStatus {
  projectId: string
  available: boolean
  /** Why delivery is unavailable (not a repository, no remote, detached HEAD…). */
  reason: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  head: string | null
  headSubject: string | null
  files: RepositoryFile[]
  /** The GitHub repository the push goes to, when the remote is on GitHub. */
  github: { owner: string; repo: string } | null
  /** True when the project has a release workflow whose result the release stage waits for. */
  releaseWorkflow: boolean
  checkedAt: string
}

export interface DeliveryRequest {
  projectId: string
  message: string
  paths?: string[]
  /** Push and publish a GitHub release after the commit. Off by default: a release costs a
   *  hosted build and is only needed when another device must update. */
  publish?: boolean
}

export interface DeliveryBridge {
  status(projectId: string): Promise<RepositoryStatus>
  /** The running delivery for the project, else its most recent one, else null. */
  current(projectId: string): Promise<DeliveryRun | null>
  ship(request: DeliveryRequest): Promise<DeliveryRun>
  cancel(projectId: string): Promise<DeliveryRun | null>
  onChanged(callback: (run: DeliveryRun) => void): () => void
}

export const DELIVERY_STAGES: ReadonlyArray<{ id: DeliveryStageId; label: string }> = [
  { id: 'preflight', label: 'Check repository' },
  { id: 'test', label: 'Run tests' },
  { id: 'build', label: 'Build' },
  { id: 'commit', label: 'Commit' },
  { id: 'push', label: 'Push' },
  { id: 'release', label: 'Verify release' }
]
