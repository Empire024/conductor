import { CLOUD_EFFORTS, CLOUD_MODELS, type CloudRunSummary } from '../../shared/cloud'
import type { CloudRuns } from './runs'

/**
 * The cloud.* app-control methods. agent-control.ts decides who is calling and opens the tab;
 * everything about the runs themselves is decided here.
 */
export const cloudSignatures = {
  'cloud.start': '({prompt,model?,effort?,ref?,title?,focus?}) — start a Claude Code cloud session on this project\'s GitHub repository (it spends the owner\'s cloud credit): model from models.list provider "cloud" (default claude-opus-5-5), ref the base branch/tag/SHA on GitHub (default: the repository\'s default branch; local commits that are not pushed are not in the cloud). Opens a visible "cloud" tab, in the background unless focus:true. Returns the run; follow it with cloud.status and cloud.transcript. tabs.open({provider:"cloud",prompt,model,branch?}) and router.dispatch tasks with provider "cloud" do the same',
  'cloud.list': '() — this project\'s cloud runs, newest first: status (starting, running, pushed, stopped, failed), session id and claude.ai URL, model, branch and head commit on origin, pull request, token usage, fetched worktree',
  'cloud.status': '({runId,lines?}) — one run, re-checked on origin now, with the last lines (default 60, up to 400) of what its client showed',
  'cloud.transcript': '({runId,refresh?,limit?}) — the session\'s messages (user, assistant, tool calls and results; the last 60 by default, up to 400). refresh:true pulls them from the cloud now with the CLI\'s teleport, in a scratch worktree of the run, never the project folder; they are pulled once by themselves when the branch is first pushed',
  'cloud.send': '({runId,message}) — send the session a message (steer or follow up): typed into a live client when one is attached, else claude -p --cloud <session>. Where the account does not allow attaching to a cloud session, the CLI refuses and the error says so, with the session link',
  'cloud.interrupt': '({runId}) — stop the cloud agent\'s current turn through a live client (Esc)',
  'cloud.stop': '({runId}) — stop following the run: a live client interrupts and closes; otherwise the session finishes its turn in the cloud and note says where to stop it',
  'cloud.attach': '({runId}) — open a live client on the session, where the account allows it (liveView)',
  'cloud.fetch': '({runId}) — fetch the branch (or pull request head) the session pushed into a detached worktree of its own (never the project\'s working tree, index or branches) and return its path, commit and diff stat, to verify locally before shipping with git.ship. Nothing is merged or pushed'
} as const

export const cloudMethods = new Set(Object.keys(cloudSignatures))
export const CLOUD_READ_METHODS = ['cloud.list', 'cloud.status', 'cloud.transcript'] as const
export const CLOUD_MUTATION_METHODS = ['cloud.start', 'cloud.send', 'cloud.interrupt', 'cloud.stop', 'cloud.attach', 'cloud.fetch'] as const

const allowedKeys: Record<string, string[]> = {
  'cloud.start': ['prompt', 'model', 'effort', 'ref', 'title', 'focus'],
  'cloud.list': [],
  'cloud.status': ['runId', 'lines'],
  'cloud.transcript': ['runId', 'refresh', 'limit'],
  'cloud.send': ['runId', 'message'],
  'cloud.interrupt': ['runId'],
  'cloud.stop': ['runId'],
  'cloud.attach': ['runId'],
  'cloud.fetch': ['runId']
}

export interface CloudCaller {
  projectId: string
  workspaceId: string
  /** This project's folder on this machine; null for a project that lives on another machine. */
  projectPath: string | null
  /** 'owner' for the owner's credential, else the calling conversation's id. */
  startedBy: string
  /** Why this caller may not start or steer cloud runs, or null when it may. */
  refusal: string | null
  /** Shows the run's tab; agent-control places it like any tab it opens. */
  openTab(run: CloudRunSummary, focus: boolean | undefined): Promise<unknown>
}

type Args = Record<string, unknown>

/** models.list's entry for cloud sessions. */
export function cloudCatalogEntry(available: boolean): { provider: 'cloud'; available: boolean; source: 'configured'; models: Array<{ id: string; label: string; isDefault?: boolean; effort: string[] }> } {
  return { provider: 'cloud', available, source: 'configured', models: CLOUD_MODELS.map(model => ({ ...model, effort: [...CLOUD_EFFORTS] })) }
}

export async function callCloudMethod(runs: CloudRuns, caller: CloudCaller, method: string, args: Args): Promise<unknown> {
  const allowed = allowedKeys[method]
  if (!allowed) throw new Error('Unknown cloud method')
  const mutation = (CLOUD_MUTATION_METHODS as readonly string[]).includes(method) || method === 'cloud.transcript' && args.refresh === true
  if (mutation && caller.refusal) throw new Error(caller.refusal)
  const extra = Object.keys(args).filter(key => !allowed.includes(key) && key !== 'projectId' && key !== 'workspaceId')
  if (extra.length) throw new Error(`Unsupported argument(s) for ${method}: ${extra.join(', ')}`)
  if (method === 'cloud.list') return runs.list(caller.projectId)
  if (mutation && !caller.projectPath) throw new Error('Cloud runs start from a project on this machine')
  if (method === 'cloud.start') {
    if (!runs.available()) throw new Error('The Claude Code CLI is not installed on this machine')
    if (args.focus !== undefined && typeof args.focus !== 'boolean') throw new Error('focus must be true or false')
    const run = runs.start({ projectId: caller.projectId, workspaceId: caller.workspaceId, cwd: caller.projectPath!, prompt: args.prompt, model: args.model, effort: args.effort, ref: args.ref, title: args.title, startedBy: caller.startedBy })
    const tab = await caller.openTab(run, args.focus as boolean | undefined).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    return { ...run, tab }
  }
  if (typeof args.runId !== 'string' || !args.runId) throw new Error('runId is required')
  const run = runs.get(args.runId, caller.projectId)
  if (method === 'cloud.status') {
    const lines = args.lines === undefined ? 60 : Number(args.lines)
    if (!Number.isInteger(lines) || lines < 1 || lines > 400) throw new Error('lines must be 1 to 400')
    const current = await runs.refreshResult(run.id).catch(() => runs.get(run.id))
    return { ...current, screen: runs.screen(run.id, lines) }
  }
  if (method === 'cloud.transcript') {
    const limit = args.limit === undefined ? 60 : Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error('limit must be 1 to 400')
    if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh must be true or false')
    const entries = await runs.transcript(run.id, args.refresh === true)
    return { ...runs.get(run.id), entries: entries.slice(-limit), total: entries.length }
  }
  if (method === 'cloud.send') return runs.send(run.id, args.message)
  if (method === 'cloud.interrupt') return runs.interrupt(run.id)
  if (method === 'cloud.stop') return runs.stop(run.id)
  if (method === 'cloud.attach') return runs.attach(run.id)
  if (method === 'cloud.fetch') return runs.fetch(run.id)
  throw new Error('Unknown cloud method')
}
