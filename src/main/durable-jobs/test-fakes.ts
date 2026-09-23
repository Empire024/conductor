/** Test doubles for the durable-jobs tests (imported only by *.test.ts). */
import type { LocalStopReason } from '../../shared/local-stop'
import type { DurableJobArtifactRef } from '../../shared/durable-jobs'
import type { OpenStageRequest, StageObservation, StageRuntime } from './ports'
import type { WorktreeOps } from './worktree'

export type ScriptedOutcome =
  | { kind: 'answer'; text: string; reason?: LocalStopReason; filesChanged?: string[]; pending?: { id: string; name: string; arguments: string } }
  | { kind: 'hang' }
  | { kind: 'approval' }
  | { kind: 'refuse-submit'; message: string }

interface FakeSession { request: OpenStageRequest; observation: StageObservation; interrupts: number }

/** A structured runtime whose conversations follow a script, one outcome per opened conversation. */
export class FakeRuntime implements StageRuntime {
  readonly sessions = new Map<string, FakeSession>()
  readonly prompts: string[] = []
  readonly opened: string[] = []
  private next = 0
  constructor(public script: ScriptedOutcome[] = [], private readonly fallback: ScriptedOutcome = { kind: 'answer', text: 'Done.\nJOB STATUS: DONE' }) {}

  async open(request: OpenStageRequest): Promise<{ agentSessionId: string }> {
    const id = `agent_fake_${this.opened.length + 1}`
    this.opened.push(id)
    this.sessions.set(id, { request, observation: { phase: 'idle', stopSequence: 0, lastAnswer: '', filesChanged: [] }, interrupts: 0 })
    return { agentSessionId: id }
  }

  async submit(agentSessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(agentSessionId)!
    const outcome = this.script[this.next++] ?? this.fallback
    if (outcome.kind === 'refuse-submit') throw new Error(outcome.message)
    this.prompts.push(prompt)
    session.observation = { ...session.observation, phase: 'running' }
    setImmediate(() => {
      if (session.observation.phase !== 'running') return
      if (outcome.kind === 'hang') return
      if (outcome.kind === 'approval') { session.observation = { ...session.observation, phase: 'waiting_approval' }; return }
      const reason = outcome.reason ?? (outcome.text.trim() ? 'completed' : 'empty_answer')
      const phase = reason === 'completed' || (reason === 'output_limit' && outcome.text.trim()) ? 'completed' : 'failed'
      session.observation = {
        phase, stopSequence: session.observation.stopSequence + 1,
        stop: { reason, detail: `${reason} detail`, filesChanged: outcome.filesChanged ?? [] },
        lastAnswer: outcome.text, filesChanged: outcome.filesChanged ?? [],
        ...(outcome.pending ? { execution: { lifecycle: 'blocked', nextAction: 'inspect', pending: outcome.pending } } : {})
      }
    })
  }

  observe(agentSessionId: string): StageObservation {
    return this.sessions.get(agentSessionId)?.observation ?? { phase: 'missing', stopSequence: 0, lastAnswer: '', filesChanged: [] }
  }

  async interrupt(agentSessionId: string): Promise<void> {
    const session = this.sessions.get(agentSessionId)
    if (!session) return
    session.interrupts++
    if (['running', 'waiting_approval', 'waiting_input', 'starting'].includes(session.observation.phase)) {
      session.observation = { ...session.observation, phase: 'interrupted', stopSequence: session.observation.stopSequence + 1, stop: { reason: 'interrupted', detail: 'interrupted', filesChanged: [] } }
    }
  }

  /** Sets a conversation's durable state directly (simulating what survived a restart). */
  set(agentSessionId: string, observation: StageObservation): void {
    const existing = this.sessions.get(agentSessionId)
    this.sessions.set(agentSessionId, { request: existing?.request ?? ({} as OpenStageRequest), observation, interrupts: existing?.interrupts ?? 0 })
  }
}

/** Non-git worktree ops that record calls. */
export class FakeWorktrees implements WorktreeOps {
  commits: Array<{ message: string; operationId: string }> = []
  snapshots: Array<{ files: string[]; directory: string }> = []
  committed = new Map<string, string>()
  constructor(private readonly root: string | null = null) {}
  async gitRoot(): Promise<string | null> { return this.root }
  async create(_projectPath: string, jobId: string, target: string) { return { path: target, branch: `conductor-job/${jobId}`, baseCommit: 'a'.repeat(40) } }
  async commit(_path: string, message: string, operationId: string) {
    const sha = (this.commits.length + 1).toString(16).padStart(40, '0')
    this.commits.push({ message, operationId })
    this.committed.set(operationId, sha)
    return sha
  }
  async findCommit(_path: string, operationId: string) { return this.committed.get(operationId) }
  async snapshot(_cwd: string, files: string[], directory: string): Promise<DurableJobArtifactRef[]> {
    this.snapshots.push({ files, directory })
    return [{ path: `${directory}/manifest.json`, kind: 'checkpoint' }, ...files.map(file => ({ path: `${directory}/files/${file}`, kind: 'checkpoint' as const }))]
  }
  snapshotComplete(directory: string): boolean { return this.snapshots.some(snapshot => snapshot.directory === directory) }
}

export async function until(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Condition not reached in time')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

export const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
