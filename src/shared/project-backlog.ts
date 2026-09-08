export type ProjectTaskStatus = 'todo' | 'doing' | 'done'
export type ProjectTaskKind = 'bug' | 'feature'
export interface ProjectTask { id:string; title:string; kind:ProjectTaskKind; status:ProjectTaskStatus; agentId?:string; line:number }
export interface ProjectTaskOwner { id:string; sessionId:string; title:string; workspace:string; provider:string; phase:string }
export interface ProjectBacklog { projectId:string; path:string; revision:string; tasks:ProjectTask[]; owners:ProjectTaskOwner[] }
export type ProjectTaskEdit = { type:'add'; title:string; kind:ProjectTaskKind } | { type:'update'; id:string; title?:string; status?:ProjectTaskStatus; agentId?:string|null } | {type:'remove';id:string}
export interface ProjectBacklogBridge { get(projectId:string):Promise<ProjectBacklog>; edit(projectId:string,revision:string,edit:ProjectTaskEdit):Promise<ProjectBacklog> }
