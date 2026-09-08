import type { SourceControlChangeSet, SourceControlStatus } from './source-control'

export type ProjectTaskStatus = 'todo' | 'doing' | 'done'
export type ProjectTaskKind = 'bug' | 'feature' | 'idea'
export const projectTaskKinds: ProjectTaskKind[] = ['bug', 'feature', 'idea']
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
export interface ProjectTask { id:string; title:string; kind:ProjectTaskKind; status:ProjectTaskStatus; agentId?:string; line:number; activity:ProjectTaskActivity[] }
export interface ProjectTaskOwner { id:string; sessionId:string; title:string; workspace:string; provider:string; phase:string }
export interface ProjectBacklog { projectId:string; path:string; revision:string; tasks:ProjectTask[]; owners:ProjectTaskOwner[]; sourceControl:SourceControlStatus }
export type ProjectTaskEdit = { type:'add'; title:string; kind:ProjectTaskKind } | { type:'update'; id:string; title?:string; status?:ProjectTaskStatus; agentId?:string|null } | {type:'remove';id:string}
export interface ProjectBacklogBridge {
  get(projectId:string):Promise<ProjectBacklog>
  edit(projectId:string,revision:string,edit:ProjectTaskEdit):Promise<ProjectBacklog>
  setSourceControl(projectId:string,enabled:boolean):Promise<SourceControlStatus>
  changes(projectId:string,taskId:string):Promise<SourceControlChangeSet>
  dispatchOptions(projectId:string):Promise<ProjectTaskDispatchOptions>
  dispatch(projectId:string,revision:string,request:ProjectTaskDispatchRequest):Promise<ProjectTaskDispatchResult>
}

export interface ProjectTaskDispatchModel { id:string; label:string; effort?:string[]; defaultEffort?:string; isDefault?:boolean }
export interface ProjectTaskDispatchOptions {
  workspaces:Array<{id:string;name:string}>
  targets:Array<{agentSessionId:string;tabId:string;sessionId:string;title:string;provider:'codex'|'claude';phase:string}>
  providers:Array<{provider:'codex'|'claude';available:boolean;source:'runtime'|'configured';models:ProjectTaskDispatchModel[]}>
}
export type ProjectTaskDispatchTarget = {type:'existing';agentSessionId:string} | {type:'new';sessionId:string;provider:'codex'|'claude';model:string;effort?:string} | {type:'auto';sessionId:string}
export interface ProjectTaskDispatchRequest {taskIds:string[];target:ProjectTaskDispatchTarget}
export interface ProjectTaskDispatchAssignment {taskIds:string[];agentSessionId:string;tabId:string;sessionId:string;provider:'codex'|'claude';model:string;effort?:string;status:'submitted'|'queued'|'failed';error?:string}
export interface ProjectTaskDispatchResult {board:ProjectBacklog;assignments:ProjectTaskDispatchAssignment[]}
