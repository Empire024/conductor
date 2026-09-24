import { makeId, type AgentSpec, type ProjectRecord, type SessionRecord } from '../shared/models'
import type { ScheduleAgent } from '../shared/schedules'
import type { InteractionResponse, PromptOrigin, SessionProjection, SessionSettings } from '../shared/structured-agent'

/**
 * One bounded turn of a scheduled task's assigned agent, in a conversation of its own that no tab
 * has to show (the durable-jobs pattern, src/main/durable-jobs/structured-runtime.ts): register it
 * in the structured store, submit one prompt, wait for the turn to settle, keep the answer.
 *
 * "Bounded" is enforced, not requested. The turn opens in the provider's least-writing mode —
 * Codex read-only, Claude "ask", a local model read-only — with the browser tools off; any tool
 * approval it asks for is denied at once (nobody is watching at 3 AM, and a brain request answers
 * from the evidence it was given); a turn that keeps asking, or outlives its time, is interrupted.
 * The conversation is archived afterwards so nightly runs do not fill the owner's lists, and the
 * run keeps its id so the owner can open it from the Schedules panel.
 */

export interface AgentTurnDeps {
  sessions: {
    ensure(spec: AgentSpec): { available: boolean; message?: string }
    submit(id: string, text: string, settings: SessionSettings, attachments?: [], origin?: PromptOrigin): Promise<void>
    respond(response: InteractionResponse): Promise<void>
    interrupt(id: string): Promise<void>
    archive?(id: string, archived: boolean): Promise<void>
  }
  database: {
    structured: { snapshot(id: string): SessionProjection | null; update(id: string, values: { settings?: SessionSettings }): void }
    getProject(id: string): ProjectRecord | null
    listSessions(projectId: string): SessionRecord[]
    createSession(projectId: string, name?: string): SessionRecord
  }
  sleep?(ms: number): Promise<void>
  now?(): number
  pollMs?: number
}

export interface AgentTurnRequest {
  projectId: string
  agent: ScheduleAgent
  title: string
  prompt: string
  timeoutMs: number
  signal: AbortSignal
  /** A local agent answering a goal with no scripts may search the web; nothing else writes. */
  research?: boolean
}

export interface AgentTurnResult { ok: boolean; agentSessionId: string | null; answer: string; note?: string }

const MAX_DENIALS = 3
const SETTLED = new Set(['idle', 'completed', 'failed', 'interrupted', 'disconnected'])
export const AGENT_TURN_ORIGIN: PromptOrigin = { agentSessionId: 'scheduled-task', label: 'Scheduled task' }

/** The mode that writes nothing for each provider. Claude has no read-only sandbox, so it runs on
 *  "ask", where every writing tool needs an approval this runner then denies. */
export function boundedSettings(base: SessionSettings, agent: ScheduleAgent, research: boolean): SessionSettings {
  const settings: SessionSettings = { ...base, model: agent.model, effort: agent.effort, plan: false, browserMcp: false }
  delete settings.temporaryPermission
  if (agent.provider === 'claude') return { ...settings, permission: 'default' }
  if (agent.provider === 'local') return { ...settings, permission: 'read-only', localGit: false, localResearch: research, localContract: undefined }
  return { ...settings, permission: 'read-only', sandbox: 'read-only' }
}

const lastAnswer = (state: SessionProjection | null, afterSequence: number): string => {
  if (!state) return ''
  const texts = state.items.filter(item => item.sequence > afterSequence && item.data.type === 'text' && item.data.role === 'assistant')
  const last = texts.sort((a, b) => (b.updatedSequence ?? b.sequence) - (a.updatedSequence ?? a.sequence))[0]
  return last && last.data.type === 'text' ? last.data.text : ''
}

const pendingInteractions = (state: SessionProjection) => state.items.flatMap(item =>
  item.data.type === 'interaction' && item.data.interaction.status === 'pending' ? [item.data.interaction] : [])

const denyChoice = (choices: Array<{ id: string; label: string }>): string | undefined =>
  choices.find(choice => ['deny', 'decline', 'reject'].includes(choice.id))?.id
    ?? choices.find(choice => /deny|decline|reject/i.test(choice.label))?.id

export async function runScheduledAgentTurn(deps: AgentTurnDeps, request: AgentTurnRequest): Promise<AgentTurnResult> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }))
  const now = deps.now ?? Date.now
  const project = deps.database.getProject(request.projectId)
  if (!project) return { ok: false, agentSessionId: null, answer: '', note: 'The project is no longer registered in Conductor.' }
  const workspaceId = deps.database.listSessions(project.id)[0]?.id ?? deps.database.createSession(project.id, 'Scheduled tasks').id
  const spec: AgentSpec = { id: makeId('agent'), projectId: project.id, sessionId: workspaceId, provider: request.agent.provider, model: request.agent.model, ...(request.agent.effort ? { effort: request.agent.effort as AgentSpec['effort'] } : {}), title: request.title.slice(0, 120), cwd: project.path }
  const ensured = deps.sessions.ensure(spec)
  if (!ensured.available) return { ok: false, agentSessionId: null, answer: '', note: ensured.message || `${request.agent.provider} is not available on this machine.` }
  const created = deps.database.structured.snapshot(spec.id)
  if (!created) return { ok: false, agentSessionId: null, answer: '', note: 'The conversation was not registered.' }
  const settings = boundedSettings(created.settings, request.agent, request.research === true)
  deps.database.structured.update(spec.id, { settings })
  const startSequence = created.sequence
  const deadline = now() + request.timeoutMs
  let denials = 0, note: string | undefined, interrupted = false
  const stop = async (reason: string): Promise<void> => {
    note ??= reason
    if (!interrupted) { interrupted = true; await deps.sessions.interrupt(spec.id).catch(() => undefined) }
  }
  try {
    await deps.sessions.submit(spec.id, request.prompt, settings, [], AGENT_TURN_ORIGIN)
    let sawWork = false
    while (true) {
      const state = deps.database.structured.snapshot(spec.id)
      if (!state) return { ok: false, agentSessionId: spec.id, answer: '', note: 'The conversation disappeared while it was answering.' }
      if (!SETTLED.has(state.phase)) sawWork = true
      else if (sawWork || state.sequence > startSequence + 1) {
        const answer = lastAnswer(state, startSequence).trim()
        if (state.phase === 'failed' && !answer) return { ok: false, agentSessionId: spec.id, answer: '', note: note ?? 'The turn failed before it answered.' }
        return { ok: Boolean(answer) && !interrupted, agentSessionId: spec.id, answer, ...(note ? { note } : answer ? {} : { note: 'The turn ended without an answer.' }) }
      }
      if (request.signal.aborted) { await stop('The scheduled run was cancelled.'); throw request.signal.reason ?? new Error('Cancelled') }
      if (now() > deadline) await stop(`The agent did not answer within ${Math.round(request.timeoutMs / 60_000)} minutes, so the turn was stopped.`)
      for (const interaction of pendingInteractions(state)) {
        const decision = denyChoice(interaction.choices)
        if (interaction.kind === 'question' || !decision || ++denials > MAX_DENIALS) { await stop('The agent asked for tools or answers a scheduled brain request cannot give, so the turn was stopped.'); break }
        await deps.sessions.respond({ sessionId: spec.id, runtimeId: state.runtimeId, requestId: interaction.id, decision }).catch(() => undefined)
      }
      await sleep(deps.pollMs ?? 1_000)
    }
  } catch (error) {
    if (request.signal.aborted) throw error
    return { ok: false, agentSessionId: spec.id, answer: '', note: error instanceof Error ? error.message : String(error) }
  } finally {
    // Out of the owner's lists; the Schedules panel still opens it by id.
    const phase = deps.database.structured.snapshot(spec.id)?.phase
    if (phase && SETTLED.has(phase)) await deps.sessions.archive?.(spec.id, true).catch(() => undefined)
  }
}
