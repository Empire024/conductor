import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpec } from '../shared/models'
import type { ProjectBacklog, ProjectTask, ProjectTaskEdit, ProjectTaskKind } from '../shared/project-backlog'
import type { ConductorDatabase } from './database'
import { workspacePath } from './agent-artifacts'
import { writeEditorFile } from './editor-files'

export const PROJECT_TASK_FILE = 'feature-list.md'
const maximum = 1024 * 1024
const template = '# Project tasks\n\nUse [ ] for to do, [~] for in progress, and [x] for done. Conductor keeps this file and the project task view in sync. Agents: preserve task markers and add your agent ID as agent=ID inside the marker when claiming an item. In native CLI sessions, CONDUCTOR_AGENT_ID contains your ID. Mark done only after completing the requested work.\n\n## Bugs\n\n## Features\n'
const digest = (text:string):string => createHash('sha256').update(text).digest('hex')
const marker = /\s*<!-- conductor-task:([a-zA-Z0-9_-]+)(?: agent=([a-zA-Z0-9_-]+))? -->/g

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
    const item=/^\s*(?:(?:[-*+] |\d+[.)]\s+))?(?:\[( |x|~|implemented|in progress|working|done)\]\s*)?(.+?)\s*$/i.exec(source)
    if(!item || !/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[(?: |x|~|implemented|in progress|working|done)\])/i.test(source))continue
    const metadata=[...source.matchAll(marker)][0]
    const title=item[2]!.replace(marker,'').trim()
    if(!title || title.startsWith('<!--'))continue
    const hash=digest(kind+'\n'+title).slice(0,20), count=duplicates.get(hash)??0
    duplicates.set(hash,count+1)
    const status=/^(x|implemented|done)$/i.test(item[1]??'')?'done':/^(~|in progress|working)$/i.test(item[1]??'')?'doing':'todo'
    tasks.push({id:metadata?.[1] ?? hash+'-'+count,title,kind,status,agentId:metadata?.[2],line:line+1})
  }
  return tasks
}
export function updateProjectTaskText(text:string,edit:ProjectTaskEdit):string {
  const ending=text.includes('\r\n')?'\r\n':'\n'
  const lines=text.split(/\r?\n/)
  if(edit.type==='add') {
    if(!['bug','feature'].includes(edit.kind))throw new Error('Choose Bug or Feature')
    const title=cleanTitle(edit.title)
    const header=edit.kind==='bug'?'Bugs':'Features'
    const headingPattern=edit.kind==='bug'? /^(?:#{1,6}\s*)?(?:bugs?|bug list)\s*:?\s*$/i : /^(?:#{1,6}\s*)?(?:features?|feature list)\s*:?\s*$/i
    let index=lines.findIndex(line=>headingPattern.test(line.trim()))
    const added='- [ ] '+title+' <!-- conductor-task:'+randomUUID()+' -->'
    if(index<0)lines.push('', '## '+header, '', added)
    else {while(index+1<lines.length && !/^\s*(?:#{1,6}\s+|(?:Bug|Feature) list:)/i.test(lines[index+1]!))index++;lines.splice(index+1,0,added,'')}
    return lines.join(ending)
  }
  const task=parseProjectTasks(text).find(task=>task.id===edit.id)
  if(!task)throw new Error('This item changed on disk. Refresh and try again.')
  if(edit.type==='remove') {lines.splice(task.line-1,1);return lines.join(ending)}
  if(edit.type!=='update')throw new Error('Unsupported task edit')
  const status=edit.status??task.status
  if(!['todo','doing','done'].includes(status))throw new Error('Invalid task status')
  const agentId=edit.agentId===undefined?task.agentId:edit.agentId
  if(agentId && !/^[a-zA-Z0-9_-]{1,160}$/.test(agentId))throw new Error('Invalid agent')
  const prefix=/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.exec(lines[task.line-1]!)?.[0]??'- '
  lines[task.line-1]=prefix+'['+({todo:' ',doing:'~',done:'x'}[status])+'] '+(edit.title===undefined?task.title:cleanTitle(edit.title))+' <!-- conductor-task:'+task.id+(agentId?' agent='+agentId:'')+' -->'
  return lines.join(ending)
}
function cleanTitle(value:unknown):string {
  if(typeof value!=='string' || !value.trim() || value.length>8000 || /[\r\n\0]|<!--|-->/.test(value))throw new Error('Enter a task title of up to 8000 characters on one line')
  return value.trim()
}
export class ProjectBacklogs {
  constructor(private database:ConductorDatabase) {}
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
    const owners=this.database.listProcesses(projectId).filter(process=>process.kind==='agent').map(process=> {
      const state=this.database.structured.snapshot(process.id)
      return {id:process.id,sessionId:process.sessionId,title:state?.title || process.title,workspace:this.database.getSession(process.sessionId)?.name ?? 'Closed workspace',provider:process.provider??'Agent',phase:state?.phase ?? process.activityPhase ?? process.status}
    })
    return {projectId,path:PROJECT_TASK_FILE,revision:digest(text),tasks:parseProjectTasks(text),owners}
  }
  async edit(projectId:string,revision:string,edit:ProjectTaskEdit):Promise<ProjectBacklog> {
    if(!edit || typeof revision!=='string')throw new Error('Invalid task edit')
    const path=await this.ensure(projectId), text=readFileSync(path,'utf8')
    if(digest(text)!==revision)throw new Error('The task list changed on disk. Your edit was not saved; refresh and try again.')
    if(edit.type==='update' && edit.agentId && !this.database.listProcesses(projectId).some(process=>process.kind==='agent' && process.id===edit.agentId))throw new Error('Choose an agent from this project')
    const next=updateProjectTaskText(text,edit)
    if(Buffer.byteLength(next)>maximum)throw new Error('The project task file is too large')
    const saved=writeEditorFile(path,next,text)
    if(saved.status==='conflict')throw new Error('The task list changed on disk. Refresh and try again.')
    return this.get(projectId)
  }
}
export function projectTaskBriefing(spec:AgentSpec):string {
  // This is coordination context, never a prompt to start additional work.
  return 'Conductor project tasks: feature-list.md is the shared bug/feature checklist shown in the UI. Read it when relevant to the requested work. For an item you start, use [~] and keep its conductor-task marker; add agent='+spec.id+' inside the marker to identify your conversation. If no marker exists, add <!-- conductor-task:<a unique simple ID> agent='+spec.id+' -->. Mark [x] only when the item is finished, [ ] if it is unstarted; keep other agents\' claims and unrelated file content. Your Conductor agent ID is '+spec.id+'. Update only items within the user\'s requested scope.'
}
