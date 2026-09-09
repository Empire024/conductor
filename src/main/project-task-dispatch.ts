import { randomUUID } from 'node:crypto'
import { makeId, type AgentProviderInfo, type AgentSpec, type PaneTab } from '../shared/models'
import type { AgentControl, } from './agent-control'
import type { AgentControlScope, AgentControlUiRequest } from '../shared/agent-control'
import type { ProjectTask, ProjectTaskDispatchAssignment, ProjectTaskDispatchOptions, ProjectTaskDispatchRequest, ProjectTaskDispatchResult } from '../shared/project-backlog'
import type { SessionSettings, StructuredProvider } from '../shared/structured-agent'
import { AUTO_FIXER_INSTRUCTIONS } from '../shared/orchestration'
import { resolveEffortChoice } from '../shared/model-effort'
import type { ConductorDatabase } from './database'
import type { ProjectBacklogs } from './project-backlog'
import type { StructuredSessions } from './structured-sessions'

type Dependencies = {
  database:ConductorDatabase
  backlogs:ProjectBacklogs
  sessions:Pick<StructuredSessions,'ensure'|'connectSession'|'submit'|'queue'>
  control:Pick<AgentControl,'tabs'>
  providers():AgentProviderInfo[]
  ui(request:AgentControlUiRequest):Promise<unknown>
  changed(projectId:string):void
}
const active = new Set(['starting','running','waiting_input','waiting_approval'])
const validId = (value:unknown):value is string => typeof value==='string' && Boolean(value.trim()) && value.length<=160 && !value.includes('\0')
/** The real, static permission modes each provider's adapter declares (see the Claude and
 *  Codex ProviderAdapter classes) — used only until a live runtime reports its own catalog. */
const staticPermissions:Record<StructuredProvider,SessionSettings['permission'][]> = {
  claude:['default','accept-edits','auto'],
  codex:['default','read-only','accept-edits']
}
export const projectTaskPrompt = (tasks:ProjectTask[],fixer=false,extra?:string):string => {
  const requested=tasks.map(task=>`Task ${task.id} (${task.kind}):\n${task.title}`).join('\n\n')
  const instructions=fixer
    ? AUTO_FIXER_INSTRUCTIONS
    : 'Complete the selected Project tasks below. Read feature-list.md and the project instructions, coordinate overlapping files with active coworkers, and use Conductor tasks APIs to update only these exact task IDs. Preserve unrelated tasks and claims. Mark tasks done only after finishing and verifying them.'
  const addition=extra?.trim() ? `\n\nAdditional instructions from the owner:\n${extra.trim()}` : ''
  return `${instructions}\n\n${requested}\n\nThis assignment was requested by the owner in Project tasks. The app records ownership after native prompt acceptance; read tasks.list before changing task status. If a selected task is still assigned elsewhere, wait for the handoff rather than seizing another agent\'s claim. Do not repeat a submission after an uncertain transport result.${addition}`
}

/** Owner-triggered dispatch. Uses the same visible tabs and native session manager as app control. */
export class ProjectTaskDispatcher {
  private dispatching=new Set<string>()
  constructor(private deps:Dependencies){}
  options(projectId:string):ProjectTaskDispatchOptions {
    const {database,control}=this.deps
    if(!validId(projectId) || !database.getProject(projectId))throw new Error('Project not found')
    const workspaces=database.listSessions(projectId).map(({id,name})=>({id,name}))
    const targets=workspaces.flatMap(workspace=>control.tabs({projectId,sessionId:workspace.id,agentSessionId:''}).flatMap(tab=> {
      const spec=tab.resourceId?database.structured.spec<AgentSpec>(tab.resourceId):undefined
      if(tab.kind!=='agent'||!spec||!['codex','claude'].includes(spec.provider)||spec.projectId!==projectId||spec.sessionId!==workspace.id)return []
      return [{agentSessionId:spec.id,tabId:tab.id,sessionId:workspace.id,title:tab.title,provider:spec.provider as StructuredProvider,phase:database.structured.snapshot(spec.id)?.phase??'idle'}]
    }))
    const providers=this.deps.providers().filter(provider=>provider.id==='codex'||provider.id==='claude').map(provider=> {
      const runtime=targets.filter(target=>target.provider===provider.id).map(target=>database.structured.snapshot(target.agentSessionId)?.capabilities).find(capabilities=>capabilities?.models.length)
      return {provider:provider.id as StructuredProvider,available:provider.available,source:runtime?'runtime' as const:'configured' as const,
        models:runtime?.models??provider.models.filter(model=>!['default','auto'].includes(model.id)).map(model=>({...model,effort:provider.efforts.map(effort=>effort.id).filter(effort=>effort!=='auto')})),
        permissions:runtime?.permissions??staticPermissions[provider.id as StructuredProvider]}
    })
    return {workspaces,targets,providers}
  }
  async dispatch(projectId:string,revision:string,request:ProjectTaskDispatchRequest):Promise<ProjectTaskDispatchResult> {
    if(this.dispatching.has(projectId))throw new Error('A task assignment is already being submitted. Wait for its result before trying again.')
    this.dispatching.add(projectId)
    try{return await this.perform(projectId,revision,request)}finally{this.dispatching.delete(projectId)}
  }
  private async perform(projectId:string,revision:string,request:ProjectTaskDispatchRequest):Promise<ProjectTaskDispatchResult> {
    const {database,backlogs,sessions}=this.deps
    const options=this.options(projectId)
    if(!request||!Array.isArray(request.taskIds)||!request.taskIds.length||request.taskIds.length>50||request.taskIds.some(id=>!validId(id))||new Set(request.taskIds).size!==request.taskIds.length)throw new Error('Select between 1 and 50 distinct project tasks')
    if(request.prompt!==undefined&&(typeof request.prompt!=='string'||request.prompt.length>4000))throw new Error('Keep the extra instructions under 4000 characters')
    const board=await backlogs.get(projectId)
    if(board.revision!==revision)throw new Error('The task list changed. Refresh and review the selection before assigning it.')
    const tasks=request.taskIds.map(id=> {const task=board.tasks.find(task=>task.id===id);if(!task)throw new Error('A selected task no longer exists');if(task.status==='done')throw new Error('Reopen completed tasks before assigning them');return task})
    const target=request.target
    if(!target||!['existing','new','auto'].includes(target.type))throw new Error('Choose an assignment destination')
    const prompt=projectTaskPrompt(tasks,target.type==='auto',request.prompt)
    if(prompt.length>50_000)throw new Error('These task descriptions are too large for one assignment. Select fewer tasks.')
    let assignment:ProjectTaskDispatchAssignment
    if(target.type==='existing') {
      const existing=options.targets.find(item=>item.agentSessionId===target.agentSessionId)
      if(!existing)throw new Error('Choose a currently open native agent tab in this project')
      const state=database.structured.snapshot(existing.agentSessionId)!
      if(database.getSetting('cliHandoff:'+existing.agentSessionId)!==null)throw new Error('Switch the selected native tab from CLI to Chat before assigning tasks')
      if(state.phase==='disconnected'||state.phase==='failed')throw new Error('Resume the selected conversation explicitly before assigning tasks; its previous execution may be uncertain')
      assignment={...existing,taskIds:request.taskIds,model:state.settings.model??'',effort:state.settings.effort,status:'failed'}
    }else {
      if(!validId(target.sessionId)||!options.workspaces.some(workspace=>workspace.id===target.sessionId))throw new Error('Choose an open workspace in this project')
      const catalog=target.type==='new'?options.providers.find(provider=>provider.provider===target.provider&&provider.available):options.providers.find(provider=>provider.available&&provider.source==='runtime')??options.providers.find(provider=>provider.available)
      if(!catalog)throw new Error('No supported native provider is available')
      const model=target.type==='new'?catalog.models.find(model=>model.id===target.model):catalog.models.find(model=>model.isDefault)??catalog.models[0]
      if(!model)throw new Error('Choose a model from the available provider catalog')
      const effort=target.type==='new'?target.effort:resolveEffortChoice(model.effort??[],model.defaultEffort)
      if(effort!==undefined&&(!validId(effort)||!model.effort?.includes(effort)))throw new Error('Choose an effort supported by the selected model')
      const permission=target.type==='new'?target.permission:undefined
      if(permission!==undefined&&(!validId(permission)||!catalog.permissions.includes(permission)))throw new Error('Choose a permission mode supported by the selected model')
      const tab:PaneTab={id:makeId('tab'),kind:'agent',resourceId:makeId('agent'),title:target.type==='auto'?'Project tasks Fixer':tasks.length===1?tasks[0]!.title.replace(/\s+/g,' ').slice(0,100):`${tasks.length} project tasks`,state:{provider:catalog.provider,model:model.id,effort:effort??'auto',...(permission?{permission}:{}),viewMode:'visual'}}
      const spec:AgentSpec={id:tab.resourceId!,projectId,sessionId:target.sessionId,provider:catalog.provider,model:model.id,title:tab.title,cwd:database.getProject(projectId)!.path}
      const ensured=sessions.ensure(spec)
      if(!ensured.available)throw new Error(ensured.message||'Provider unavailable')
      database.structured.update(spec.id,{settings:{...database.structured.snapshot(spec.id)!.settings,model:model.id,effort,...(permission?{permission:permission as SessionSettings['permission']}:{})}})
      const scope:AgentControlScope={projectId,sessionId:target.sessionId,agentSessionId:''}
      await this.deps.ui({...scope,id:randomUUID(),action:'tabs.open',params:{tab,focus:false}})
      if(!this.deps.control.tabs(scope).some(current=>current.id===tab.id&&current.resourceId===spec.id))throw new Error('The new native tab was not acknowledged. Inspect the workspace before retrying.')
      assignment={taskIds:request.taskIds,agentSessionId:spec.id,tabId:tab.id,sessionId:target.sessionId,provider:catalog.provider,model:model.id,effort,...(permission?{permission}:{}),status:'failed'}
    }
    try {
      let state=database.structured.snapshot(assignment.agentSessionId)!
      if(target.type!=='existing') {
        await sessions.connectSession(assignment.agentSessionId)
        state=database.structured.snapshot(assignment.agentSessionId)!
        const model=state.capabilities?.models.find(model=>model.id===assignment.model)
        if(!model)throw new Error('The native runtime did not advertise the chosen model. Inspect the new tab and select an available model before retrying.')
        if(assignment.effort!==undefined&&!model.effort?.includes(assignment.effort))throw new Error('The native runtime did not advertise the chosen effort. No task prompt was sent.')
        if(assignment.permission!==undefined&&state.capabilities?.permissions&&!state.capabilities.permissions.includes(assignment.permission as SessionSettings['permission']))throw new Error('The native runtime did not advertise the chosen permission mode. No task prompt was sent.')
      }
      const settings:SessionSettings={...state.settings,...(target.type==='existing'?{}:{model:assignment.model,effort:assignment.effort,...(assignment.permission?{permission:assignment.permission as SessionSettings['permission']}:{})})}
      // Revalidate the optimistic task snapshot after potentially slow native connection.
      if((await backlogs.get(projectId)).revision!==revision)throw new Error('The task list changed during connection. No task prompt was sent; review the selection before retrying.')
      if(active.has(state.phase)) {await sessions.queue(assignment.agentSessionId,prompt,settings);assignment.status='queued'}
      else {await sessions.submit(assignment.agentSessionId,prompt,settings);assignment.status='submitted'}
      let current=await backlogs.get(projectId)
      for(const task of tasks) {
        const latest=current.tasks.find(item=>item.id===task.id)
        if(!latest||latest.title!==task.title||latest.status!==task.status||latest.agentId!==task.agentId)throw new Error('The native prompt was accepted, but a task changed before its ownership could be recorded. Inspect the visible tab; do not resend the assignment.')
        current=await backlogs.edit(projectId,current.revision,{type:'update',id:task.id,status:'doing',agentId:assignment.agentSessionId},{actor:'you',sessionId:assignment.sessionId})
      }
    }catch(error) {
      assignment.error=error instanceof Error?error.message:String(error)
      if(assignment.status==='failed')assignment.error+=' The selected tasks were kept. Inspect the visible tab before retrying an uncertain provider result.'
    }
    this.deps.changed(projectId)
    return {board:await backlogs.get(projectId),assignments:[assignment]}
  }
}
