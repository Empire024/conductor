/**
 * Execution nodes and the bounded jobs they run.
 *
 * A node is one of the owner's computers that Conductor reaches over SSH inside the tailnet to run
 * commands - builds, tests, platform checks - without a Conductor window of its own. It is the
 * execution half of the machine pool; a paired Conductor peer (machines.ts) is the conversation
 * half. The two meet on the same computer when it runs both: `peerMachineId` links them.
 *
 * Everything here is plain data so it persists as JSON and crosses app control unchanged.
 */

export type NodePlatform = 'darwin' | 'linux' | 'win32'

export interface NodeSsh {
  /** The tailnet name (MagicDNS), never a 100.x address that can change. */
  host: string
  user: string
  port?: number
  /** Private key on this machine; its public half is in the node account's authorized_keys. */
  identityFile: string
}

export interface NodeTool {
  path: string
  /** First line of `<tool> --version`; empty when the tool did not say. */
  version: string
}

/** What the node said about itself on its last successful probe. */
export interface NodeFacts {
  hostname: string
  user: string
  home: string
  platform: NodePlatform | null
  /** `uname -m`: arm64, x86_64, aarch64. */
  arch: string
  osName: string
  osVersion: string
  osBuild: string
  kernel: string
  /** hw.model on a Mac, e.g. Macmini9,1. */
  model: string
  cpu: string
  cores: number | null
  performanceCores: number | null
  ramGb: number | null
  diskFreeGb: number | null
  shell: string
  /** Path of the Command Line Tools / Xcode developer dir; null when neither is installed. */
  developerDir: string | null
  /** Whether Rosetta 2 is installed; null off macOS. */
  rosetta: boolean | null
  /** `pmset -g` sleep minutes; "0" means the machine never sleeps on its own. Null off macOS. */
  sleepMinutes: string | null
  tools: Record<string, NodeTool>
  /** Tools present only as Command Line Tools shims that would open an installer dialog. */
  shims: string[]
  /** What decides whether the machine comes back on its own; null off macOS or when not reported. */
  autoRestart?: boolean | null
  wakeOnNetwork?: boolean | null
  fileVault?: 'on' | 'off' | 'changing' | null
  autoLoginUser?: string | null
  /** How Tailscale starts: a system daemon (before login), a login item, only running now, or absent. */
  tailscaleMode?: 'daemon' | 'login-item' | 'running' | 'absent' | null
  conductor?: 'at-login' | 'installed' | 'not-installed' | null
}

export interface ReadinessCheck {
  id: 'sleep' | 'auto-restart' | 'boot-unlock' | 'tailscale' | 'conductor'
  label: string
  /** null: the node did not say. */
  ok: boolean | null
  detail: string
}

/** Whether the machine is on when it is needed, with no one at it (feature always-on-machines). */
export interface NodeReadiness {
  ready: boolean
  checks: ReadinessCheck[]
  /** The physical or owner steps still needed, in words. */
  missing: string[]
}

export type NodeStatus = 'unknown' | 'online' | 'offline'

export interface ExecutionNode {
  /** Stable, owner-chosen id, e.g. "mac-mini". */
  id: string
  name: string
  ssh: NodeSsh
  /** The Conductor peer on the same computer, when it also runs Conductor (machines.list id). */
  peerMachineId: string | null
  /** Directory under the node account's home that holds repos, checkouts and job state. */
  root: string
  /** Capabilities the owner asserts beyond what the probe finds, e.g. "electron-build". */
  labels: string[]
  /** How many jobs may run on it at once. Checkout jobs are also one per repository. */
  maxConcurrentJobs: number
  facts: NodeFacts | null
  status: NodeStatus
  lastSeenAt: string | null
  lastProbeAt: string | null
  lastError: string | null
  registeredAt: string
}

export interface NodeSummary extends ExecutionNode {
  capabilities: string[]
  currentJobs: string[]
  readiness: NodeReadiness | null
}

export type RemoteJobStatus = 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'lost'

export const TERMINAL_REMOTE_JOB_STATUSES: readonly RemoteJobStatus[] = ['succeeded', 'failed', 'timed-out', 'cancelled', 'lost']

export interface RemoteJobCheckout {
  /** Repository name on the node; its checkout is <root>/work/<repo>. */
  repo: string
  /** Full commit id, resolved on this machine before the job was queued. */
  commit: string
  /** The local repository the commit was pushed from. */
  localRepoPath: string
}

export interface RemoteJob {
  id: string
  title: string
  nodeId: string
  /** Capabilities the job asked for; the node it landed on had all of them. */
  requires: string[]
  /** A bash command line, run in its own process group on the node. */
  command: string
  /** Working directory on the node: relative to the checkout when there is one, else to home. */
  cwd: string
  checkout: RemoteJobCheckout | null
  timeoutSec: number
  status: RemoteJobStatus
  /** What the job is doing now or why it ended, in words. */
  detail: string | null
  exitCode: number | null
  remotePid: number | null
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  stdoutBytes: number
  stderrBytes: number
  /** The last few KB of each stream; the full logs are files beside job.json. */
  stdoutTail: string
  stderrTail: string
  projectId: string | null
  createdBy: string | null
  cancelReason: string | null
  /** The process that runs it (the app or a script); only that process follows or ends it. */
  runnerPid: number | null
}

export interface SubmitRemoteJob {
  command: string
  title?: string
  /** Run on exactly this node. */
  nodeId?: string
  /** Or on any online node that has all of these capabilities, e.g. ["macos", "arm64"]. */
  requires?: string[]
  cwd?: string
  timeoutSec?: number
  /** Bring the node's own checkout to this commit of the local repository first. */
  checkout?: { localRepoPath: string; commit?: string; repo?: string }
  projectId?: string
  createdBy?: string
}

export interface RegisterNode {
  id: string
  name?: string
  ssh: NodeSsh
  peerMachineId?: string | null
  root?: string
  labels?: string[]
  maxConcurrentJobs?: number
}
