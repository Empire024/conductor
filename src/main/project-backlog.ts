import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { AgentSpec } from '../shared/models'
import type { ProjectBacklog, ProjectTask, ProjectTaskActivity, ProjectTaskEdit, ProjectTaskKind, ProjectTaskOwner } from '../shared/project-backlog'
import type { SourceControlChangeSet } from '../shared/source-control'
import type { ConductorDatabase } from './database'
import type { SourceControl } from './source-control'
import { workspacePath } from './agent-artifacts'
import { writeEditorFile } from './editor-files'

export const PROJECT_TASK_FILE = 'feature-list.md'
const maximum = 1024 * 1024
const template = '# Project tasks\n\nUse [ ] for to do, [~] for in progress, and [x] for done. Conductor keeps this file and the project task view in sync. Agents: preserve task markers and add your agent ID as agent=ID inside the marker when claiming an item. In native CLI sessions, CONDUCTOR_AGENT_ID contains your ID. Mark done only after completing the requested work.\n\n## Bugs\n\n## Features\n\n## Ideas\n'
const digest = (text:string):string => createHash('sha256').update(text).digest('hex')
const marker = /\s*<!-- conductor-task:([a-zA-Z0-9_-]+)(?: agent=([a-zA-Z0-9_-]+))? -->/g
const sections:Record<ProjectTaskKind,{heading:string;pattern:RegExp}> = {
  bug: {heading:'Bugs', pattern: /^(?:#{1,6}\s*)?(?:bugs?|bug list)\s*:?\s*$/i},
  feature: {heading:'Features', pattern: /^(?:#{1,6}\s*)?(?:features?|feature list)\s*:?\s*$/i},
  idea: {heading:'Ideas', pattern: /^(?:#{1,6}\s*)?(?:ideas?|idea list)\s*:?\s*$/i}
}

/** Who made a task move. Agents are identified by their live conversation. */
export interface ProjectTaskActor { actor:'agent'|'you'|'file'; agentId?:string; sessionId?:string }

/** Parse legacy numbered feature lists and ordinary Markdown checklists without rewriting prose. */
export function parseProjectTasks(text:string):ProjectTask[] {
  let kind:ProjectTaskKind='feature', fenced=false
  const tasks:ProjectTask[]=[], duplicates=new Map<string,number>()
  const lines=text.split(/\r?\n/)
  for(let line=0;line<lines.length;line++) {
    const source=lines[line]!
    if(/^\s*(```|~~~)/.test(source)) {fenced=!fenced;continue}
    if(fenced)continue
    const heading=source.replace(/^\s*#{1,6}\s*/,'').trim()
    if(/^(bugs?|bug list)\s*:?$/i.test(heading)) {kind='bug';continue}
    if(/^(features?|feature list)\s*:?$/i.test(heading)) {kind='feature';continue}
    if(/^(ideas?|idea list)\s*:?$/i.test(heading)) {kind='idea';continue}
    const item=/^\s*(?:(?:[-*+] |\d+[.)]\s+))?(?:\[( |x|~|implemented|in progress|working|done)\]\s*)?(.+?)\s*$/i.exec(source)
    if(!item || !/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[(?: |x|~|implemented|in progress|working|done)\])/i.test(source))continue
    const metadata=[...source.matchAll(marker)][0]
    const end=taskEnd(lines,line)
    const title=[item[2]!.replace(marker,'').trim(),...lines.slice(line+1,end).map(value=>value.slice(2))].join('\n')
    if(!title || title.startsWith('<!--'))continue
    const hash=digest(kind+'\n'+title).slice(0,20), count=duplicates.get(hash)??0
    duplicates.set(hash,count+1)
    const status=/^(x|implemented|done)$/i.test(item[1]??'')?'done':/^(~|in progress|working)$/i.test(item[1]??'')?'doing':'todo'
    tasks.push({id:metadata?.[1] ?? hash+'-'+count,title,kind,status,agentId:metadata?.[2],line:line+1,activity:[]})
    line=end-1
  }
  return tasks
}
/** Only marked tasks own their two-space Markdown continuation lines. */
function taskEnd(lines:string[],start:number):number {
  let end=start+1
  if(!/<!-- conductor-task:[a-zA-Z0-9_-]+(?: agent=[a-zA-Z0-9_-]+)? -->/.test(lines[start]??''))return end
  while(end<lines.length && lines[end]!.startsWith('  '))end++
  return end
}
function taskLines(prefix:string,title:string,metadata:string):string[] {
  const [first,...rest]=title.split('\n')
  return [prefix+first+' '+metadata,...rest.map(line=>'  '+line)]
}
export function updateProjectTaskText(text:string,edit:ProjectTaskEdit):string {
  const ending=text.includes('\r\n')?'\r\n':'\n'
  const lines=text.split(/\r?\n/)
  if(edit.type==='add') {
    const section=sections[edit.kind as ProjectTaskKind]
    if(!section)throw new Error('Choose Bug, Feature, or Idea')
    const title=cleanTitle(edit.title)
    let index=-1
    for(let line=0;line<lines.length;line=taskEnd(lines,line)) {
      if(section.pattern.test(lines[line]!.trim())) {index=line;break}
    }
    const added=taskLines('- [ ] ',title,'<!-- conductor-task:'+randomUUID()+' -->')
    if(index<0)lines.push('', '## '+section.heading, '', ...added)
    else {
      while(index+1<lines.length && !/^\s*(?:#{1,6}\s+|(?:Bug|Feature|Idea) list:)/i.test(lines[index+1]!))index=taskEnd(lines,index+1)-1
      lines.splice(index+1,0,...added,'')
    }
    return lines.join(ending)
  }
  const task=parseProjectTasks(text).find(task=>task.id===edit.id)
  if(!task)throw new Error('This item changed on disk. Refresh and try again.')
  const start=task.line-1, length=taskEnd(lines,start)-start
  if(edit.type==='remove') {lines.splice(start,length);return lines.join(ending)}
  if(edit.type!=='update')throw new Error('Unsupported task edit')
  const status=edit.status??task.status
  if(!['todo','doing','done'].includes(status))throw new Error('Invalid task status')
  const agentId=edit.agentId===undefined?task.agentId:edit.agentId
  if(agentId && !/^[a-zA-Z0-9_-]{1,160}$/.test(agentId))throw new Error('Invalid agent')
  const prefix=/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.exec(lines[task.line-1]!)?.[0]??'- '
  const replacement=taskLines(prefix+'['+({todo:' ',doing:'~',done:'x'}[status])+'] ',edit.title===undefined?task.title:cleanTitle(edit.title),'<!-- conductor-task:'+task.id+(agentId?' agent='+agentId:'')+' -->')
  lines.splice(start,length,...replacement)
  return lines.join(ending)
}
function cleanTitle(value:unknown):string {
  if(typeof value!=='string' || !value.trim() || value.length>8000 || /\0|<!--|-->/.test(value))throw new Error('Enter a task of up to 8000 characters without task markers')
  return value.replace(/\r\n?/g,'\n').trim()
}
export class ProjectBacklogs {
  constructor(private database:ConductorDatabase,private sourceControl?:SourceControl) {}
  async ensure(projectId:string):Promise<string> {
    const project=this.database.getProject(projectId)
    if(!project)throw new Error('Project not found')
    const path=await workspacePath(project.path,PROJECT_TASK_FILE,true)
    try {writeFileSync(path,template,{flag:'wx'})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
    if(!lstatSync(path).isFile() || statSync(path).size>maximum)throw new Error('The project task file must be a text file no larger than 1 MB')
    return path
  }
  async get(projectId:string):Promise<ProjectBacklog> {
    const path=await this.ensure(projectId), text=readFileSync(path,'utf8')
    if(Buffer.byteLength(text)>maximum)throw new Error('The project task file is too large')
    const owners=this.owners(projectId), tasks=parseProjectTasks(text)
    const history=await this.reconcile(projectId,tasks)
    for(const task of tasks)task.activity=history.get(task.id)??[]
    const sourceControl=await this.sourceControl?.describe(projectId)
    return {projectId,path:PROJECT_TASK_FILE,revision:digest(text),tasks,owners,
      sourceControl:sourceControl??{projectId,available:false,enabled:false,reason:'Repository links are unavailable in this window.'}}
  }
  async edit(projectId:string,revision:string,edit:ProjectTaskEdit,actor?:ProjectTaskActor):Promise<ProjectBacklog> {
    if(!edit || typeof revision!=='string')throw new Error('Invalid task edit')
    const path=await this.ensure(projectId), text=readFileSync(path,'utf8')
    if(digest(text)!==revision)throw new Error('The task list changed on disk. Your edit was not saved; refresh and try again.')
    if(edit.type==='update' && edit.agentId && !this.database.listProcesses(projectId).some(process=>process.kind==='agent' && process.id===edit.agentId))throw new Error('Choose an agent from this project')
    const before=edit.type==='update'?parseProjectTasks(text).find(task=>task.id===edit.id):undefined
    const next=updateProjectTaskText(text,edit)
    if(Buffer.byteLength(next)>maximum)throw new Error('The project task file is too large')
    const saved=writeEditorFile(path,next,text)
    if(saved.status==='conflict')throw new Error('The task list changed on disk. Refresh and try again.')
    if(edit.type==='add') {
      const existing=new Set(parseProjectTasks(text).map(task=>task.id))
      const added=parseProjectTasks(next).find(task=>!existing.has(task.id))
      if(added)await this.record(projectId,added.id,'todo',undefined,actor)
    }
    if(edit.type==='update' && before) {
      const status=edit.status??before.status
      const agentId=edit.agentId===undefined?before.agentId:(edit.agentId??undefined)
      if(status!==before.status || agentId!==before.agentId)await this.record(projectId,before.id,status,agentId,actor)
    }
    return this.get(projectId)
  }
  /** Diffs are anchored to the commits a task was opened against and last moved against. */
  async changes(projectId:string,taskId:string):Promise<SourceControlChangeSet> {
    if(!this.sourceControl)throw new Error('Repository links are unavailable in this window.')
    const board=await this.get(projectId), task=board.tasks.find(task=>task.id===taskId)
    if(!task)throw new Error('This task is no longer in the task file.')
    const range=this.database.projectTaskCommitRange(projectId,taskId)
    return this.sourceControl.changes(projectId,taskId,range.base,task.status==='done'?range.head:undefined)
  }
  private owners(projectId:string):ProjectTaskOwner[] {
    return this.database.listProcesses(projectId).filter(process=>process.kind==='agent').map(process=> {
      const state=this.database.structured.snapshot(process.id)
      return {id:process.id,sessionId:process.sessionId,title:state?.title || process.title,workspace:this.database.getSession(process.sessionId)?.name ?? 'Closed workspace',provider:process.provider??'Agent',phase:state?.phase ?? process.activityPhase ?? process.status}
    })
  }
  /** Agents edit feature-list.md directly, so changes observed on disk are recorded too. */
  private async reconcile(projectId:string,tasks:ProjectTask[]):Promise<Map<string,ProjectTaskActivity[]>> {
    const history=this.database.listProjectTaskActivity(projectId)
    const changed=tasks.filter(task=> {
      const last=history.get(task.id)?.[0]
      return !last || last.status!==task.status || last.assignedAgentId!==task.agentId
    })
    if(!changed.length)return history
    const commit=await this.head(projectId)
    // A checklist marker identifies the assignee, not who edited the file.
    for(const task of changed)this.write(projectId,task.id,task.status,undefined,'file',commit,undefined,undefined,task.agentId)
    return this.database.listProjectTaskActivity(projectId)
  }
  private async record(projectId:string,taskId:string,status:ProjectTask['status'],assignedAgentId:string|undefined,actor?:ProjectTaskActor):Promise<void> {
    const actingAgentId=actor?.actor==='agent'?actor.agentId:undefined
    this.write(projectId,taskId,status,actingAgentId,actor?.actor ?? 'file',await this.head(projectId),actor?.sessionId,undefined,assignedAgentId)
  }
  private write(projectId:string,taskId:string,status:ProjectTask['status'],agentId:string|undefined,actor:'agent'|'you'|'file',commit?:string,sessionId?:string,known?:ProjectTaskOwner[],assignedAgentId?:string):void {
    const actingAgent=agentId?(known??this.owners(projectId)).find(owner=>owner.id===agentId):undefined
    this.database.recordProjectTaskActivity({projectId,taskId,status,actor,agentId,assignedAgentId,commit,
      agentTitle:actingAgent?.title,provider:actingAgent?.provider,
      sessionId:actingAgent?.sessionId ?? sessionId,
      workspace:actingAgent?.workspace ?? (sessionId?this.database.getSession(sessionId)?.name:undefined)})
  }
  private async head(projectId:string):Promise<string|undefined> {
    try {return await this.sourceControl?.head(projectId)}catch{return undefined}
  }
}
export function projectTaskBriefing(spec:AgentSpec):string {
  // This is coordination context, never a prompt to start additional work.
  return 'Conductor project tasks: feature-list.md is the shared bug/feature/idea checklist shown in the UI. Read it when relevant to the requested work. For an item you start, use [~] and keep its conductor-task marker; add agent='+spec.id+' inside the marker to identify your conversation. If no marker exists, add <!-- conductor-task:<a unique simple ID> agent='+spec.id+' -->. Mark [x] only when the item is finished, [ ] if it is unstarted; keep other agents\' claims and unrelated file content. Your Conductor agent ID is '+spec.id+'. Update only items within the user\'s requested scope.'
}
