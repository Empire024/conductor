import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { makeId, type AgentSpec, type ProjectRecord, type SessionRecord } from '../../shared/models'
import { localStopOf } from '../../shared/local-stop'
import type { PromptOrigin, SessionProjection, SessionSettings } from '../../shared/structured-agent'
import { STAGE_TOOL_MAP, stageKind } from './handoff'
import type { LocalExecutionView, OpenStageRequest, StageObservation, StageRuntime } from './ports'

/**
 * StageRuntime over the app's own structured runtime (src/main/structured-sessions.ts), the same
 * path agent-control's tabs.open takes: ensure(spec) registers a provider-'local' conversation in
 * the structured store, submit() dispatches the stage prompt, and the LocalAdapter builds its
 * LocalAgentSession with the per-conversation localCheckpoint (session-checkpoint.ts). The
 * conversation lives in the main process; a renderer only views it, so `showTab` is optional and
 * best effort.
 *
 * structured-sessions requires a conversation's cwd to be a registered project's folder. A job
 * isolated in its own git worktree therefore gets that worktree registered as a project record
 * of its own (not added to the desk), so the stage conversation works in the worktree and never
 * in the owner's tree.
 */

export interface StructuredRuntimeDeps {
  sessions: {
    ensure(spec: AgentSpec): { available: boolean; message?: string }
    submit(id: string, text: string, settings: SessionSettings, attachments?: [], origin?: PromptOrigin): Promise<void>
    interrupt(id: string): Promise<void>
  }
  database: {
    structured: {
      snapshot(id: string): SessionProjection | null
      spec<T>(id: string): T | null
      update(id: string, values: { settings?: SessionSettings }): void
    }
    getSetting(key: string): string | null
    getProject(id: string): ProjectRecord | null
    upsertProject(path: string, name: string): ProjectRecord
    listSessions(projectId: string): SessionRecord[]
    createSession(projectId: string, name?: string): SessionRecord
  }
  /** Shows the conversation as a tab when its workspace is open (Opus D wires this). Never awaited for correctness. */
  showTab?: (tab: { projectId: string; workspaceId: string; agentSessionId: string; title: string; model: string; jobId: string }) => Promise<void>
}

const samePath = (a: string, b: string): boolean => {
  try { return realpathSync(a).toLocaleLowerCase() === realpathSync(b).toLocaleLowerCase() } catch { return false }
}

/** models.list ids for local models may carry the provider prefix; the spec takes the bare id. */
export const localModelId = (model: string): string => model.startsWith('local/') ? model.slice('local/'.length) : model

export function readLocalExecution(getSetting: (key: string) => string | null, projectId: string, taskId: string): LocalExecutionView | undefined {
  const serialized = getSetting(`local-session-checkpoint:${JSON.stringify([projectId, taskId])}`)
  if (!serialized) return undefined
  try {
    const execution = (JSON.parse(serialized) as { state?: { execution?: Partial<LocalExecutionView> } }).state?.execution
    if (!execution || typeof execution.lifecycle !== 'string') return undefined
    const pending = execution.pending && typeof execution.pending.name === 'string' ? { id: String(execution.pending.id), name: execution.pending.name, arguments: String(execution.pending.arguments ?? '') } : undefined
    return { lifecycle: execution.lifecycle, nextAction: String(execution.nextAction ?? ''), ...(pending ? { pending } : {}) }
  } catch {
    // An unreadable checkpoint is reported as a failed task, never as a clean one.
    return { lifecycle: 'failed', nextAction: 'The local task checkpoint is unreadable; inspect the workspace before continuing.' }
  }
}

export function observeProjection(state: SessionProjection | null, execution: LocalExecutionView | undefined): StageObservation {
  if (!state) return { phase: 'missing', stopSequence: 0, lastAnswer: '', filesChanged: [] }
  const items = [...state.items].sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence))
  const stopItem = items.find(item => localStopOf(item.data))
  const stop = stopItem ? localStopOf(stopItem.data) : undefined
  const lastText = items.find(item => item.data.type === 'text' && item.data.role === 'assistant')
  const lastError = items.find(item => item.data.type === 'error')
  const changed = new Set<string>(stop?.filesChanged ?? [])
  for (const item of state.items) if (item.data.type === 'changes') for (const change of item.data.changes) changed.add(change.path)
  return {
    phase: state.phase,
    stopSequence: stopItem ? stopItem.updatedSequence ?? stopItem.sequence : 0,
    ...(stop ? { stop: { reason: stop.reason, detail: stop.detail, filesChanged: stop.filesChanged ?? [], ...(stop.acceptance ? { acceptance: stop.acceptance } : {}) }, report: stop } : {}),
    lastAnswer: lastText && lastText.data.type === 'text' ? lastText.data.text : '',
    ...(lastError && lastError.data.type === 'error' ? { lastError: lastError.data.message.slice(0, 600) } : {}),
    filesChanged: [...changed].slice(0, 400),
    ...(execution ? { execution } : {})
  }
}

/** submit() refuses more than 60,000 characters. The closing instructions (the status line the
 *  handoff asks for) sit at the end, so an oversized prompt loses its middle, not its tail. */
export const clampPrompt = (prompt: string, limit = 60_000): string => prompt.length <= limit ? prompt : `${prompt.slice(0, Math.floor(limit * 0.6))}

[… handoff shortened to fit …]

${prompt.slice(-(Math.floor(limit * 0.4) - 60))}`

export function structuredStageRuntime(deps: StructuredRuntimeDeps): StageRuntime {
  const { database, sessions } = deps
  const projectFor = (request: OpenStageRequest): ProjectRecord => {
    const project = database.getProject(request.job.projectId)
    if (!project) throw new Error('The job\'s project is no longer registered in Conductor')
    if (samePath(project.path, request.job.cwd)) return project
    return database.upsertProject(request.job.cwd, `${project.name} · job ${request.job.title}`.slice(0, 120) || basename(request.job.cwd))
  }
  const workspaceFor = (project: ProjectRecord, requested?: string): string => {
    const workspaces = database.listSessions(project.id)
    return (requested && workspaces.find(workspace => workspace.id === requested)?.id) ?? workspaces[0]?.id ?? database.createSession(project.id, 'Durable job').id
  }
  return {
    async open(request) {
      const project = projectFor(request)
      const workspaceId = workspaceFor(project, project.id === request.job.projectId ? request.job.workspaceId : undefined)
      const model = localModelId(request.job.model.model)
      const spec: AgentSpec = { id: makeId('agent'), projectId: project.id, sessionId: workspaceId, provider: 'local', model, title: request.title.slice(0, 120), cwd: project.path }
      const result = sessions.ensure(spec)
      if (!result.available) throw new Error(result.message || 'The local provider is unavailable')
      const created = database.structured.snapshot(spec.id)
      if (!created) throw new Error('The stage conversation was not registered')
      // Local models have no Auto; accept-edits is their working mode (the sandbox still applies).
      // No grants are widened here: no repository writes, no research, no bypassed approvals.
      // The stage kind picks the tool scope (handoff.ts STAGE_TOOL_MAP): read-only kinds get no
      // mutating tool, and a coding-scope kind gets the coding tool set through an empty contract.
      const tools = STAGE_TOOL_MAP[request.stage.kind ?? stageKind(request.stage)]
      database.structured.update(spec.id, { settings: { ...created.settings, model, permission: tools.readOnly ? 'read-only' : 'accept-edits', plan: false, localGit: false, localResearch: false, ...(tools.scope === 'coding' ? { localContract: {} } : {}) } })
      void deps.showTab?.({ projectId: project.id, workspaceId, agentSessionId: spec.id, title: spec.title, model, jobId: request.job.id }).catch(error => console.warn('Durable job tab could not be shown', error))
      return { agentSessionId: spec.id }
    },
    async submit(agentSessionId, prompt) {
      const state = database.structured.snapshot(agentSessionId)
      if (!state) throw new Error('The stage conversation no longer exists')
      await sessions.submit(agentSessionId, clampPrompt(prompt), state.settings, [], { agentSessionId: `durable-job`, label: 'Durable job' })
    },
    observe(agentSessionId) {
      const spec = database.structured.spec<AgentSpec>(agentSessionId)
      const execution = spec ? readLocalExecution(key => database.getSetting(key), spec.projectId, agentSessionId) : undefined
      return observeProjection(database.structured.snapshot(agentSessionId), execution)
    },
    async interrupt(agentSessionId) {
      if (!database.structured.snapshot(agentSessionId)) return
      await sessions.interrupt(agentSessionId)
    }
  }
}
