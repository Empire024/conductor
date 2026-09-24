import { SCHEDULE_AGENT_PROVIDERS, SCHEDULE_TIMINGS, type CreateScheduleInput, type ScheduleAgent, type ScheduleCreator, type ScheduleDefinition, type UpdateScheduleInput } from '../shared/schedules'
import type { ScheduleRunner } from './schedule-runner'
import type { ScheduleStore } from './schedule-store'
import { validAgent } from './schedule-store'

/**
 * The app-control surface of scheduled tasks (docs/schedules.md), so an agent can set one up when
 * the owner asks: create it, write its scripts, adjust, pause, run or delete it.
 *
 * Authority follows durable jobs (agent-control.ts jobs.*): reading is open to the project;
 * pausing, resuming and running now are open to any writable, non-local conversation of the
 * project (all three are reversible and bounded); changing a task's goal, agent or scripts is the
 * owner's, a wizard tab's, or its maintainer's — the conversation that created it, or the one the
 * owner assigned its scripts to. Deleting asks the owner unless the owner (or a wizard tab) is the
 * one asking. A sandboxed local model changes nothing here: a script is host code that runs
 * unattended, which is exactly what a local model is otherwise kept away from.
 */

const SCRIPT_CONTRACT = 'Each script runs with the project folder as cwd, node scripts as ES modules (.mjs, built-in modules only) and powershell as .ps1. Its stdout is the evidence Conductor digests, so print a compact, deterministic summary (no timestamps or durations, sorted), at most 256 KB; stderr is for diagnostics. Exit 0 means valid. Env: CONDUCTOR_SCHEDULE_STATE_DIR persists between runs (caches, ETags), CONDUCTOR_SCHEDULE_RUN_DIR holds earlier scripts\' stdout of this run as <name>.out, CONDUCTOR_SCHEDULE_CHANGED is 1 once an earlier script changed or failed'

export const scheduleSignatures: Record<string, string> = {
  'schedules.list': '() — scheduled tasks of this project: goal, assigned agent, cadence, timing (night/idle), urgent, next run, why a due run is waiting, last result and script names',
  'schedules.get': '({taskId}) — one task with its scripts\' full text and its last 10 runs: per-script results, the local summary, the assigned agent\'s answer and the saved evidence path',
  'schedules.create': '({name,prompt,everyMinutes?,timing?:"night"|"idle",urgent?,agent?:{provider,model,effort?}|null,churnModel?,brain?,enabled?}) — create a task when the owner asks for recurring work. prompt is the goal. everyMinutes defaults to 1440 (5..525600). timing night (default) waits for 01:00-06:00; idle runs whenever the owner is away and the machine is quiet; neither runs while the owner works unless urgent. agent is the assigned agent (models.list), defaulting to you; it answers one bounded request only when a script\'s output changed or failed (brain, default true); churnModel is the local model that summarizes changes first (null = first configured). A new task is due at once and runs in the first allowed window. Then write its scripts with schedules.scripts.save: runs whose scripts print the same output as last time ask no model anything',
  'schedules.update': '({taskId,name?,prompt?,everyMinutes?,timing?,urgent?,agent?,churnModel?,brain?}) — the owner, a wizard tab or the task\'s maintainer (its creator, or the conversation its scripts were assigned to)',
  'schedules.pause': '({taskId}) — stop running it until resumed',
  'schedules.resume': '({taskId}) — resume a paused task; its next window starts now',
  'schedules.runNow': '({taskId}) — run it now, skipping the night/idle wait (never alongside another scheduled run); returns the run, then read schedules.get',
  'schedules.delete': '({taskId}) — asks the owner unless the owner or a wizard tab asks; built-in tasks can only be paused',
  'schedules.scripts.save': `({taskId,name,content,language?:"node"|"powershell",description?,format?:"text"|"json",runWhen?:"always"|"changed",timeoutSec?,order?}) — add or replace one of the task's deterministic scripts (the task's maintainer, the owner or a wizard tab). name is 1-48 lower-case letters, digits and hyphens; content up to 64 KB; at most 12 scripts, run in order; runWhen "changed" (for expensive checks such as tests) runs only after an earlier script changed or failed; timeoutSec 1-1200 (default 120). ${SCRIPT_CONTRACT}. Test a script by running it yourself before saving it`,
  'schedules.scripts.delete': '({taskId,name}) — remove one of the task\'s scripts (maintainer, owner or wizard tab); scripts Conductor ships with a built-in task stay'
}
export const scheduleMethods = new Set(Object.keys(scheduleSignatures))
const scheduleKeys: Record<string, string[]> = {
  'schedules.list': [],
  'schedules.get': ['taskId'],
  'schedules.create': ['name', 'prompt', 'everyMinutes', 'timing', 'urgent', 'agent', 'churnModel', 'brain', 'enabled'],
  'schedules.update': ['taskId', 'name', 'prompt', 'everyMinutes', 'timing', 'urgent', 'agent', 'churnModel', 'brain'],
  'schedules.pause': ['taskId'],
  'schedules.resume': ['taskId'],
  'schedules.runNow': ['taskId'],
  'schedules.delete': ['taskId'],
  'schedules.scripts.save': ['taskId', 'name', 'content', 'language', 'description', 'format', 'runWhen', 'timeoutSec', 'order'],
  'schedules.scripts.delete': ['taskId', 'name']
}

/** What the app plugs into AgentControl once the scheduler exists (src/main/index.ts). */
export interface ScheduleControlService {
  store: ScheduleStore
  runner: Pick<ScheduleRunner, 'runNow' | 'running' | 'forget'>
  changed(projectId: string): void
}

export interface ScheduleControlCaller {
  projectId: string
  agentSessionId: string
  title: string
  provider: string
  /** The owner credential or a wizard tab. */
  sovereign: boolean
  owner: boolean
  wizard: boolean
  /** A read-only or planning conversation. */
  restricted: boolean
  /** The caller's own model, the default assigned agent for a task it creates. */
  model?: string
  effort?: string
}

export interface ScheduleControlContext extends ScheduleControlService {
  /** Asks the owner; throws unless they allowed it. */
  ask(message: string, action: string): Promise<void>
  /** Re-checks the caller's scope after the owner took time to answer. */
  reauthorize(): void
  catalog(): Array<{ provider: string; available: boolean; models: Array<{ id: string }> }>
}

type Args = Record<string, unknown>
const taskId = (args: Args): string => {
  if (typeof args.taskId !== 'string' || !args.taskId.trim() || args.taskId.length > 160) throw new Error('taskId is required: the id of a task from schedules.list')
  return args.taskId
}

function writable(caller: ScheduleControlCaller): void {
  if (caller.sovereign) return
  if (caller.provider === 'local') throw new Error('A sandboxed local conversation cannot change scheduled tasks; its scripts run on the host unattended. The owner, a wizard tab or a non-local coworker can')
  if (caller.restricted) throw new Error('This conversation is read-only or planning')
}

function maintainer(caller: ScheduleControlCaller, task: ScheduleDefinition): void {
  writable(caller)
  if (caller.sovereign) return
  if (task.createdBy.agentSessionId === caller.agentSessionId || task.delegateAgentSessionId === caller.agentSessionId) return
  throw new Error(task.kind === 'agent'
    ? 'Only the owner, a wizard tab, or this task\'s maintainer (the conversation that created it, or the one its scripts were assigned to) may change it. The owner can assign it to you from the Schedules panel'
    : 'A built-in task is changed by the owner or a wizard tab; the owner can assign its scripts to you from the Schedules panel')
}

/** The assigned agent must be a provider and model this Conductor actually offers. */
function checkAgent(context: ScheduleControlContext, agent: ScheduleAgent | null): void {
  if (!agent) return
  const entry = context.catalog().find(provider => provider.provider === agent.provider)
  if (!entry) throw new Error(`${agent.provider} is not a provider of this Conductor; use models.list`)
  if (entry.models.length && !entry.models.some(model => model.id === agent.model)) throw new Error(`${agent.model} is not a ${agent.provider} model of models.list`)
}
function checkChurnModel(context: ScheduleControlContext, model: unknown): void {
  if (model === undefined || model === null) return
  const local = context.catalog().find(provider => provider.provider === 'local')
  if (typeof model !== 'string' || !local?.models.some(entry => entry.id === model)) throw new Error('churnModel must be null or a local model id from models.list')
}

const summary = (context: ScheduleControlContext, task: ScheduleDefinition) => {
  const [last] = context.store.runs(task.id, 1)
  const running = context.runner.running()
  return {
    ...task,
    scripts: context.store.scripts(task.id).map(script => ({ name: script.name, language: script.language, runWhen: script.runWhen, origin: script.origin })),
    running: running?.scheduleId === task.id,
    lastRun: last ? { id: last.id, outcome: last.outcome, trigger: last.trigger, startedAt: last.startedAt, finishedAt: last.finishedAt, detail: last.detail.slice(0, 600), artifactPath: last.artifactPath } : null
  }
}

export async function scheduleCall(context: ScheduleControlContext, caller: ScheduleControlCaller, method: string, args: Args): Promise<unknown> {
  const allowed = scheduleKeys[method]
  if (!allowed) throw new Error('Unknown control method; use tools.list')
  const extra = Object.keys(args).filter(key => !allowed.includes(key) && key !== 'projectId')
  if (extra.length) throw new Error(`${method} accepts only ${allowed.join(', ') || 'no arguments'}; ${extra.join(', ')} is not an argument`)
  const { store } = context
  const done = <T>(value: T): T => { context.changed(caller.projectId); return value }

  if (method === 'schedules.list') return store.list(caller.projectId).map(task => summary(context, task))
  if (method === 'schedules.create') {
    writable(caller)
    const agent = args.agent === undefined
      ? (caller.owner || caller.provider === 'local' || !caller.model || !SCHEDULE_AGENT_PROVIDERS.includes(caller.provider as ScheduleAgent['provider']) ? null : { provider: caller.provider as ScheduleAgent['provider'], model: caller.model, ...(caller.effort ? { effort: caller.effort } : {}) })
      : validAgent(args.agent)
    if (args.agent !== undefined) checkAgent(context, agent)
    checkChurnModel(context, args.churnModel)
    if (args.timing !== undefined && !SCHEDULE_TIMINGS.includes(args.timing as never)) throw new Error(`timing must be ${SCHEDULE_TIMINGS.join(' or ')}`)
    const createdBy: ScheduleCreator = { kind: caller.owner ? 'owner' : caller.wizard ? 'wizard' : 'agent', ...(caller.owner ? {} : { agentSessionId: caller.agentSessionId }), title: caller.title }
    context.reauthorize()
    const task = store.create({ ...(args as Partial<CreateScheduleInput>), projectId: caller.projectId, name: args.name as string, agent, createdBy })
    return done({ task: summary(context, task), note: `Due now; it runs in the first ${task.timing === 'night' ? 'night' : 'idle'} window. Give it scripts with schedules.scripts.save({taskId:"${task.id}",...}); without scripts its agent answers the goal directly each run.` })
  }

  const task = store.get(caller.projectId, taskId(args))
  if (method === 'schedules.get') return { task: summary(context, task), scripts: store.scripts(task.id), runs: store.runs(task.id, 10) }
  if (method === 'schedules.pause' || method === 'schedules.resume') {
    writable(caller)
    context.reauthorize()
    const updated = store.update(caller.projectId, task.id, { enabled: method === 'schedules.resume' })
    context.runner.forget(task.id)
    return done(summary(context, updated))
  }
  if (method === 'schedules.runNow') {
    writable(caller)
    context.reauthorize()
    const run = context.runner.runNow(caller.projectId, task.id)
    return done({ run, note: run.outcome === 'skipped' ? run.detail : 'Started. Poll schedules.get for its result; a run with unchanged script output ends in seconds without asking any model.' })
  }
  if (method === 'schedules.update') {
    maintainer(caller, task)
    const patch: UpdateScheduleInput = {}
    for (const key of ['name', 'prompt', 'everyMinutes', 'timing', 'urgent', 'churnModel', 'brain'] as const) if (args[key] !== undefined) (patch as Args)[key] = args[key]
    if (args.agent !== undefined) { patch.agent = validAgent(args.agent); checkAgent(context, patch.agent) }
    checkChurnModel(context, args.churnModel)
    context.reauthorize()
    const updated = store.update(caller.projectId, task.id, patch)
    context.runner.forget(task.id)
    return done(summary(context, updated))
  }
  if (method === 'schedules.delete') {
    maintainer(caller, task)
    if (task.kind !== 'agent') throw new Error('A built-in scheduled task cannot be deleted; pause it instead')
    if (context.runner.running()?.scheduleId === task.id) throw new Error('This task is running; delete it once the run has finished')
    if (!caller.sovereign) await context.ask(`${caller.title} wants to delete the scheduled task “${task.name}” with its scripts and run history.`, 'delete this scheduled task')
    context.reauthorize()
    store.remove(caller.projectId, task.id)
    return done({ deleted: true, taskId: task.id })
  }
  if (method === 'schedules.scripts.save') {
    maintainer(caller, task)
    context.reauthorize()
    const author: ScheduleCreator = { kind: caller.owner ? 'owner' : caller.wizard ? 'wizard' : 'agent', ...(caller.owner ? {} : { agentSessionId: caller.agentSessionId }), title: caller.title }
    const { taskId: _taskId, ...input } = args
    const script = store.saveScript(caller.projectId, task.id, input as never, caller.owner ? 'owner' : 'agent', author)
    const { content: _content, ...meta } = script
    return done({ script: meta, note: 'Saved. It runs in order with the task\'s other scripts on the next run; its first output counts as changed.' })
  }
  if (method === 'schedules.scripts.delete') {
    maintainer(caller, task)
    context.reauthorize()
    store.deleteScript(caller.projectId, task.id, args.name as string)
    return done({ deleted: true, taskId: task.id, name: args.name })
  }
  throw new Error('Unknown control method; use tools.list')
}
