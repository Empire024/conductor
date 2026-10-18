import type { IdeaActor } from '../../shared/ideas'
import type { IdeaRunController } from './controller'
import type { CrossProjectCleanupGuard } from '../cleanup-guard'

/** tools.list descriptions for the idea autopilot (docs/idea-autopilot.md). */
export const ideaRunSignatures: Record<string, string> = {
  'ideas.run': '({ideaId,planner?,model?,dryRun?}) — "Run this idea": a durable idea run in this project; a frontier planner (claude Opus by default, or codex) writes a staged plan with done-criteria, budgets and owner checkpoints, and nothing runs until the owner approves it. dryRun:true rehearses: agents simulate every outside action',
  'ideas.runs': '({ideaId?,runId?}) — idea runs with their plan, stages (status, agent, budget, spend, loop, next occurrence), checkpoints with the exact action and who answered, and standing rules; runId gives one run',
  'ideas.run.approve': '({runId}) — owner only: approve a run\'s plan so its stages start',
  'ideas.run.decide': '({checkpointId,decision,standing?,note?}) — owner only: approve or deny an outward-facing action (account, publish, message, purchase, order, spend); standing:true applies the answer to every later action of that type in the run',
  'ideas.run.pause': '({runId,ownerApproval?}) — pause a run; a turn already running finishes and is read on resume. Another project\'s run is refused unless the owner credential calls, or ownerApproval:true and the owner approves the dialog',
  'ideas.run.resume': '({runId}) — owner or wizard: resume a paused run; a stage stopped by its budget gets another budget of the same size',
  'ideas.run.stop': '({runId,ownerApproval?}) — stop a run for good; its running stage turn is interrupted. Another project\'s run is refused like ideas.run.pause'
}
export const ideaRunMethods = new Set(Object.keys(ideaRunSignatures))
/** For control-method-classes.ts. */
export const IDEA_RUN_READ_METHODS = ['ideas.runs'] as const
export const IDEA_RUN_MUTATION_METHODS = ['ideas.run', 'ideas.run.approve', 'ideas.run.decide', 'ideas.run.pause', 'ideas.run.resume', 'ideas.run.stop'] as const

const keys: Record<string, string[]> = {
  'ideas.run': ['ideaId', 'planner', 'model', 'dryRun'], 'ideas.runs': ['ideaId', 'runId'], 'ideas.run.approve': ['runId'],
  'ideas.run.decide': ['checkpointId', 'decision', 'standing', 'note'], 'ideas.run.pause': ['runId', 'ownerApproval'], 'ideas.run.resume': ['runId'], 'ideas.run.stop': ['runId', 'ownerApproval']
}

/** Who is calling, decided by agent-control from the authorized scope, never from the caller. */
export interface IdeaRunsControlCaller {
  projectId: string
  agentSessionId: string
  title: string
  /** The owner's own credential or window: the only caller that answers checkpoints and approves plans. */
  owner: boolean
  /** The owner or a wizard tab. */
  sovereign: boolean
  /** A local model, or a read-only / planning conversation: reads only. */
  readOnly: boolean
  /** The cross-project cleanup rule (src/main/cleanup-guard.ts): pausing or stopping another
   *  project's run goes through it. */
  crossProject?: CrossProjectCleanupGuard
}

const id = (args: Record<string, unknown>, name: string): string => {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`${name} is required`)
  return value.trim()
}

export async function ideaRunsCall(controller: IdeaRunController, caller: IdeaRunsControlCaller, method: string, rawArgs: unknown): Promise<unknown> {
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>
  const allowed = keys[method]
  if (!allowed) throw new Error('Unknown idea-run method; use tools.list')
  const extra = Object.keys(args).filter(key => !allowed.includes(key) && key !== 'sessionId' && key !== 'projectId')
  if (extra.length) throw new Error(`${method} does not accept ${extra.join(', ')}`)
  if (method === 'ideas.runs') {
    if (typeof args.runId === 'string' && args.runId) return controller.get(args.runId)
    return controller.list({ ...(typeof args.ideaId === 'string' && args.ideaId ? { ideaId: args.ideaId } : {}) })
  }
  if (caller.readOnly && !caller.sovereign) throw new Error(`${method} changes an idea run; a local model or a read-only conversation may only read them`)
  const actor: IdeaActor = caller.owner && !caller.agentSessionId ? { kind: 'owner', label: 'owner' } : { kind: 'agent', agentSessionId: caller.agentSessionId, label: caller.title }
  if (method === 'ideas.run') {
    const planner = args.planner === undefined ? 'claude' : String(args.planner)
    if (planner !== 'claude' && planner !== 'codex') throw new Error('planner must be claude or codex')
    if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('dryRun must be true or false')
    return controller.start({
      ideaId: id(args, 'ideaId'), projectId: caller.projectId, dryRun: args.dryRun === true,
      planner: { provider: planner, ...(typeof args.model === 'string' && args.model.trim() ? { model: args.model.trim() } : {}) }
    }, actor)
  }
  if (method === 'ideas.run.approve' || method === 'ideas.run.decide') {
    // Outward-facing and irreversible steps pause for the owner (owner, 2026-09-25: "if you need
    // me for any step ... pause your work and holler at me"); a wizard tab steers, it does not sign.
    if (!caller.owner) throw new Error(`${method} is the owner's answer: use the Ideas view, the phone notification, or the owner's own credential`)
    if (method === 'ideas.run.approve') return controller.approve(id(args, 'runId'), actor)
    if (args.decision !== 'approve' && args.decision !== 'deny') throw new Error('decision must be approve or deny')
    if (args.standing !== undefined && typeof args.standing !== 'boolean') throw new Error('standing must be true or false')
    return controller.decide({ checkpointId: id(args, 'checkpointId'), decision: args.decision, standing: args.standing === true, ...(typeof args.note === 'string' ? { note: args.note } : {}) }, actor)
  }
  if (method === 'ideas.run.pause' || method === 'ideas.run.stop') {
    // The run store is machine-wide: a run of another project is that project's to stop.
    const runId = id(args, 'runId')
    if (args.ownerApproval !== undefined && typeof args.ownerApproval !== 'boolean') throw new Error('ownerApproval must be true or false')
    const run = controller.get(runId)
    if (run.projectId !== caller.projectId) {
      if (!caller.crossProject) throw new Error(`Idea run ${runId} belongs to another project; ${method} it from that project`)
      await caller.crossProject({ projectId: run.projectId, label: `idea run ${runId}`, action: method === 'ideas.run.pause' ? 'pause' : 'stop', call: `${method}({runId:"${runId}"})`, ownerApproval: args.ownerApproval === true })
    }
    return method === 'ideas.run.pause' ? controller.pause(runId, actor) : controller.stop(runId, actor)
  }
  if (method === 'ideas.run.resume') {
    if (!caller.sovereign) throw new Error('ideas.run.resume needs the owner or a wizard tab')
    return controller.resume(id(args, 'runId'), actor)
  }
  return controller.stop(id(args, 'runId'), actor)
}
