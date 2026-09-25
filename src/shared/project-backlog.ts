import type { SourceControlChangeSet, SourceControlStatus } from './source-control'

/** Large enough for a complete diagnostic report; shared by every task entry point. */
export const PROJECT_TASK_MAX_LENGTH = 200_000
/** Completed work remains in feature-list.md forever, but leaves the everyday task view after two weeks. */
export const PROJECT_TASK_ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000
export const PROJECT_TASK_PAGE_SIZE = 40

export type ProjectTaskStatus = 'todo' | 'doing' | 'done'
export type ProjectTaskKind = 'task' | 'bug' | 'feature' | 'idea'
export const projectTaskKinds: ProjectTaskKind[] = ['task', 'bug', 'feature', 'idea']
/** A small, obvious scale: no numeric ranking. Missing/unknown markers degrade to 'normal'. */
export type ProjectTaskPriority = 'high' | 'normal' | 'low'
export const projectTaskPriorities: ProjectTaskPriority[] = ['high', 'normal', 'low']
/** How much model a task is worth: a suggestion for dispatch, not a lock. Missing/unknown
 *  markers degrade to 'medium', the same way an unrecognized priority degrades to 'normal'. */
export type ProjectTaskWeight = 'heavy' | 'medium' | 'light'
export const projectTaskWeights: ProjectTaskWeight[] = ['heavy', 'medium', 'light']
const weightRank: Record<ProjectTaskWeight, number> = { heavy: 0, medium: 1, light: 2 }
/** The heaviest weight among a selection wins, so a mixed batch is never under-provisioned. */
export function heaviestProjectTaskWeight(weights: ProjectTaskWeight[]): ProjectTaskWeight {
  return weights.length ? weights.reduce((top, weight) => weightRank[weight] < weightRank[top] ? weight : top) : 'medium'
}
/** Real model ids/efforts this app actually offers (see agent-manager.ts's CODEX_MODELS and
 *  the Claude provider's model list); heavy tasks get the strongest model at higher effort,
 *  light tasks get a cheaper, faster one at lower effort. */
export const projectTaskWeightDefaults: Record<'codex' | 'claude', Record<ProjectTaskWeight, { model: string; effort: string }>> = {
  codex: { heavy: { model: 'gpt-6-astra', effort: 'high' }, medium: { model: 'gpt-5.6-sol', effort: 'medium' }, light: { model: 'gpt-5.6-luna', effort: 'low' } },
  claude: { heavy: { model: 'opus', effort: 'high' }, medium: { model: 'sonnet', effort: 'medium' }, light: { model: 'haiku', effort: 'low' } }
}
/** Who moved a task, in which workspace, and what the repository looked like then. */
export interface ProjectTaskActivity {
  id:string
  status:ProjectTaskStatus
  actor:'agent'|'you'|'file'
  at:string
  /** The task owner after this activity; distinct from the agent who acted. */
  assignedAgentId?:string
  /** The acting agent. UI author labels and conversation links use this identity. */
  agentId?:string
  agentTitle?:string
  provider?:string
  sessionId?:string
  workspace?:string
  commit?:string
}
export interface ProjectTask { id:string; title:string; kind:ProjectTaskKind; status:ProjectTaskStatus; agentId?:string; priority:ProjectTaskPriority; weight:ProjectTaskWeight; line:number; activity:ProjectTaskActivity[]; archived?:boolean }
export interface ProjectTaskOwner { id:string; sessionId:string; title:string; workspace:string; provider:string; phase:string }
export interface ProjectTaskListQuery { query?:string; kind?:'all'|ProjectTaskKind; includeDone?:boolean; includeArchived?:boolean; offset?:number; limit?:number }
/** How many filtered tasks each pane section holds across the whole list, not only the loaded page. */
export interface ProjectTaskSectionCounts { doing:number; todo:number; done:number; archived:number }
export interface ProjectTaskPage { offset:number; limit:number; total:number; hasMore:boolean; sections?:ProjectTaskSectionCounts }
export interface ProjectTaskSummary { total:number; completed:number; archived:number }
export interface ProjectBacklog { projectId:string; path:string; revision:string; tasks:ProjectTask[]; owners:ProjectTaskOwner[]; sourceControl:SourceControlStatus; page?:ProjectTaskPage; summary?:ProjectTaskSummary }
export type ProjectTaskEdit = { type:'add'; title:string; kind:ProjectTaskKind; priority?:ProjectTaskPriority; weight?:ProjectTaskWeight } | { type:'update'; id:string; title?:string; kind?:ProjectTaskKind; status?:ProjectTaskStatus; agentId?:string|null; priority?:ProjectTaskPriority; weight?:ProjectTaskWeight } | {type:'remove';id:string}
export interface ProjectBacklogBridge {
  get(projectId:string,query?:ProjectTaskListQuery):Promise<ProjectBacklog>
  edit(projectId:string,revision:string,edit:ProjectTaskEdit,query?:ProjectTaskListQuery):Promise<ProjectBacklog>
  setSourceControl(projectId:string,enabled:boolean):Promise<SourceControlStatus>
  changes(projectId:string,taskId:string):Promise<SourceControlChangeSet>
  dispatchOptions(projectId:string):Promise<ProjectTaskDispatchOptions>
  dispatch(projectId:string,revision:string,request:ProjectTaskDispatchRequest):Promise<ProjectTaskDispatchResult>
}

export interface ProjectTaskDispatchModel { id:string; label:string; effort?:string[]; defaultEffort?:string; isDefault?:boolean }
export interface ProjectTaskDispatchOptions {
  workspaces:Array<{id:string;name:string}>
  targets:Array<{agentSessionId:string;tabId:string;sessionId:string;title:string;provider:'codex'|'claude';phase:string}>
  providers:Array<{provider:'codex'|'claude';available:boolean;source:'runtime'|'configured';models:ProjectTaskDispatchModel[];permissions:string[]}>
}
/** `new`/`auto` register a fresh native session, which opens on the owner's remembered permission
 *  for its provider (see structured-sessions.ts ensure()); an explicit `permission` on `new`
 *  overrides that inherited default instead of leaving the choice to whatever was last remembered. */
export type ProjectTaskDispatchTarget = {type:'existing';agentSessionId:string} | {type:'new';sessionId:string;provider:'codex'|'claude';model:string;effort?:string;permission?:string} | {type:'auto';sessionId?:string}
export interface ProjectTaskDispatchRequest {taskIds:string[];target:ProjectTaskDispatchTarget;prompt?:string}
export interface ProjectTaskDispatchAssignment {taskIds:string[];agentSessionId:string;tabId:string;sessionId:string;provider:'codex'|'claude';model:string;effort?:string;permission?:string;status:'submitted'|'queued'|'failed';error?:string}
export interface ProjectTaskDispatchResult {board:ProjectBacklog;assignments:ProjectTaskDispatchAssignment[]}
