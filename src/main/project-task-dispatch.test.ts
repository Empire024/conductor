import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConductorDatabase } from './database'
import { StructuredSessions } from './structured-sessions'
import { ProjectBacklogs } from './project-backlog'
import { ProjectTaskDispatcher } from './project-task-dispatch'
import type { AgentControlTab, AgentControlUiRequest } from '../shared/agent-control'
import type { AgentProviderInfo, AgentSpec, PaneTab } from '../shared/models'
import type { ProviderCapabilities } from '../shared/structured-agent'

const cleanup:Array<()=>void>=[]
afterEach(()=>{for(const dispose of cleanup.splice(0).reverse())dispose();vi.unstubAllEnvs()})
function fixture({fail=false,hold=false}={}) {
  vi.stubEnv('CONDUCTOR_LIVE_TESTS','0');vi.stubEnv('CONDUCTOR_OFFLINE_TESTS','0')
  const root=mkdtempSync(join(tmpdir(),'conductor-task-dispatch-'))
  cleanup.push(()=>rmSync(root,{recursive:true,force:true,maxRetries:5}))
  const database=new ConductorDatabase(join(root,'state.db'));cleanup.push(()=>database.close())
  const project=database.upsertProject(root,'Dispatch'),workspace=database.listSessions(project.id)[0]!
  writeFileSync(join(root,'feature-list.md'),'## Bugs\n- [ ] Fix the parser <!-- conductor-task:one -->\n## Features\n- [ ] Add a tooltip <!-- conductor-task:two -->\n')
  const submissions:Array<{id:string;prompt:string;settings:unknown}>=[]
  const sessions=new StructuredSessions(database,()=> 'synthetic-provider',()=>{},(provider,options)=> {
    const capabilities:ProviderCapabilities={provider,runtimeVersion:'synthetic',adapterVersion:1,authentication:'cli',textStreaming:true,steering:false,toolInputStreaming:false,toolOutputStreaming:true,approvals:true,questions:true,resume:true,fork:false,plans:false,permissions:['default','read-only'],sandboxModes:['inherit','read-only','workspace-write'],effort:['low','high'],models:[{id:provider+'-native',label:provider+' native',effort:['low','high'],defaultEffort:'low'}],limitations:['Synthetic fixture; no inference']}
    return {provider,capabilities,start:async()=>options.emit({data:{type:'session',phase:'idle',nativeSessionId:'native-'+options.runtimeId}}),submit:async(prompt,settings)=>{submissions.push({id:options.runtimeId,prompt,settings});if(fail)throw new Error('Synthetic native dispatch rejection');if(!hold)options.emit({data:{type:'session',phase:'completed'}})},respond:async()=>{},interrupt:async()=>{},dispose:()=>{}}
  })
  cleanup.push(()=>sessions.dispose())
  const spec:AgentSpec={id:'existing-agent',projectId:project.id,sessionId:workspace.id,cwd:root,provider:'codex',title:'Existing Codex',model:'codex-native'}
  sessions.ensure(spec)
  database.structured.update(spec.id,{settings:{model:'codex-native',effort:'low',permission:'default',plan:false}})
  const first:PaneTab={id:'existing-tab',kind:'agent',title:spec.title,resourceId:spec.id,state:{provider:spec.provider,model:spec.model}}
  database.saveSession(workspace.id,{version:1,root:{type:'group',id:'group',activeTabId:first.id,tabs:[first]}},null,[])
  const control={tabs:({sessionId}:{sessionId:string})=>{const current=database.getSession(sessionId)!.layout.root;if(current.type!=='group')throw new Error('Fixture group expected');return current.tabs.map(tab=>({...tab,groupId:current.id,uri:'conductor://fixture/tab/'+tab.id})) as AgentControlTab[]}}
  const ui=vi.fn(async(request:AgentControlUiRequest)=>{const current=database.getSession(request.sessionId)!;if(current.layout.root.type!=='group')throw new Error('Fixture group expected');current.layout.root.tabs.push(request.params.tab as PaneTab);database.saveSession(request.sessionId,current.layout,null,[]);return {applied:true}})
  const providers:AgentProviderInfo[]=(['codex','claude'] as const).map(provider=>({id:provider,displayName:provider,available:true,installUrl:'',models:[{id:provider+'-native',label:provider+' native'}],efforts:[{id:'low',label:'Low'},{id:'high',label:'High'}]}))
  const backlogs=new ProjectBacklogs(database),changed=vi.fn()
  const dispatcher=new ProjectTaskDispatcher({database,backlogs,sessions,control,ui,providers:()=>providers,changed})
  return {root,database,project,workspace,spec,sessions,submissions,backlogs,ui,control,dispatcher,changed}
}

describe('Project tasks native dispatch',()=> {
  it('lists visible native targets and runtime-reported model efforts',()=>{
    const f=fixture(),options=f.dispatcher.options(f.project.id)
    expect(options.targets).toEqual([expect.objectContaining({agentSessionId:f.spec.id,tabId:'existing-tab',sessionId:f.workspace.id})])
    expect(options.providers[0]).toMatchObject({source:'runtime',models:[{id:'codex-native',effort:['low','high']}],permissions:['default','read-only']})
  })
  it('falls back to each provider\'s real static permission modes before any runtime has reported its own',()=>{
    const f=fixture(),options=f.dispatcher.options(f.project.id)
    const claude=options.providers.find(provider=>provider.provider==='claude')
    expect(claude).toMatchObject({source:'configured',permissions:['default','accept-edits','auto']})
  })
  it('sends selected tasks once to an existing tab while preserving its permissions and unrelated tasks',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    f.database.structured.update(f.spec.id,{settings:{model:'codex-native',effort:'low',permission:'read-only',sandbox:'read-only',plan:false}})
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'existing',agentSessionId:f.spec.id}})
    expect(result.assignments[0]).toMatchObject({status:'submitted',agentSessionId:f.spec.id})
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0]).toMatchObject({prompt:expect.stringContaining('Task one (bug)'),settings:expect.objectContaining({permission:'read-only',sandbox:'read-only'})})
    expect(result.board.tasks).toEqual(expect.arrayContaining([expect.objectContaining({id:'one',status:'doing',agentId:f.spec.id,activity:expect.arrayContaining([expect.objectContaining({actor:'you'})])}),expect.objectContaining({id:'two',status:'todo'})]))
    expect(f.ui).not.toHaveBeenCalled()
  })
  it('queues active tab assignments without interrupting or submitting another concurrent turn',async()=>{
    const f=fixture({hold:true})
    await f.sessions.submit(f.spec.id,'Already running',f.database.structured.snapshot(f.spec.id)!.settings)
    const board=await f.backlogs.get(f.project.id)
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['two'],target:{type:'existing',agentSessionId:f.spec.id}})
    expect(result.assignments[0]?.status).toBe('queued')
    expect(f.submissions).toHaveLength(1)
    expect(f.database.structured.snapshot(f.spec.id)?.queuedPrompts?.[0]?.text).toContain('Task two (feature)')
  })
  it('opens a visible new provider tab and validates its selected concrete effort before submitting',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one','two'],target:{type:'new',sessionId:f.workspace.id,provider:'claude',model:'claude-native',effort:'high'}})
    expect(f.ui).toHaveBeenCalledOnce()
    expect(f.ui.mock.calls[0]?.[0].params.focus).toBe(false)
    expect(result.assignments[0]).toMatchObject({status:'submitted',provider:'claude',model:'claude-native',effort:'high'})
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0]?.settings).toMatchObject({effort:'high'})
    expect(result.board.tasks.every(task=>task.agentId===result.assignments[0]?.agentSessionId)).toBe(true)
  })
  it('launches one visible main Fixer with actual-model selection and native coworker instructions',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one','two'],target:{type:'auto',sessionId:f.workspace.id}})
    expect(result.assignments[0]?.status).toBe('submitted')
    expect(f.ui.mock.calls[0]?.[0].params.tab).toMatchObject({title:'Project tasks Fixer'})
    expect(f.ui.mock.calls[0]?.[0].params.focus).toBe(false)
    expect(f.submissions).toHaveLength(1)
    expect(f.submissions[0]?.prompt).toContain('models.list and app.state')
    expect(f.submissions[0]?.prompt).toContain('explicit provider, model, effort')
    expect(f.submissions[0]?.prompt).toContain('projectTaskIds')
    expect(f.submissions[0]?.prompt).toContain('Task two (feature)')
  })
  it('rejects stale revisions, unavailable targets, invalid effort, and duplicate IDs before submission',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id),target={type:'existing' as const,agentSessionId:f.spec.id}
    await expect(f.dispatcher.dispatch(f.project.id,'stale',{taskIds:['one'],target})).rejects.toThrow('changed')
    await expect(f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'existing',agentSessionId:'not-visible'}})).rejects.toThrow('currently open')
    await expect(f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one','one'],target})).rejects.toThrow('distinct')
    await expect(f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'new',sessionId:f.workspace.id,provider:'claude',model:'claude-native',effort:'imaginary'}})).rejects.toThrow('supported')
    await expect(f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'new',sessionId:f.workspace.id,provider:'claude',model:'claude-native',effort:'low',permission:'read-only'}})).rejects.toThrow('supported')
    expect(f.submissions).toHaveLength(0);expect(f.ui).not.toHaveBeenCalled()
  })
  it('applies an explicitly chosen permission mode to a new tab and threads it into the submitted settings',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'new',sessionId:f.workspace.id,provider:'codex',model:'codex-native',effort:'low',permission:'read-only'}})
    expect(result.assignments[0]).toMatchObject({status:'submitted',permission:'read-only'})
    expect(f.submissions[0]?.settings).toMatchObject({permission:'read-only'})
    expect(f.database.structured.snapshot(result.assignments[0]!.agentSessionId)?.settings).toMatchObject({permission:'read-only'})
  })
  it('opens a new tab on the owner\'s remembered permission for that provider when the request leaves it unset',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    f.database.setSetting('rememberedPermission:claude','read-only')
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'new',sessionId:f.workspace.id,provider:'claude',model:'claude-native',effort:'low'}})
    expect(result.assignments[0]).toMatchObject({status:'submitted'})
    expect(f.submissions[0]?.settings).toMatchObject({permission:'read-only'})
    expect(f.database.structured.snapshot(result.assignments[0]!.agentSessionId)?.settings).toMatchObject({permission:'read-only'})
  })
  it('still lets an explicit dispatch permission win over the owner\'s remembered mode',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    f.database.setSetting('rememberedPermission:codex','read-only')
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'new',sessionId:f.workspace.id,provider:'codex',model:'codex-native',effort:'low',permission:'default'}})
    expect(f.submissions[0]?.settings).toMatchObject({permission:'default'})
  })
  it('opens the auto Fixer tab on the owner\'s remembered permission too',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    f.database.setSetting('rememberedPermission:codex','read-only')
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one','two'],target:{type:'auto',sessionId:f.workspace.id}})
    expect(result.assignments[0]).toMatchObject({status:'submitted'})
    expect(f.submissions[0]?.settings).toMatchObject({permission:'read-only'})
  })
  it('appends an optional owner instruction to the dispatched prompt, and omits it entirely when blank',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    const withExtra=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'existing',agentSessionId:f.spec.id},prompt:'Please also update the changelog'})
    expect(withExtra.assignments[0]?.status).toBe('submitted')
    expect(f.submissions[0]?.prompt).toContain('Additional instructions from the owner')
    expect(f.submissions[0]?.prompt).toContain('Please also update the changelog')
    const before=f.submissions.length
    const board2=await f.backlogs.get(f.project.id)
    await f.dispatcher.dispatch(f.project.id,board2.revision,{taskIds:['two'],target:{type:'existing',agentSessionId:f.spec.id}})
    expect(f.submissions[before]?.prompt).not.toContain('Additional instructions from the owner')
  })
  it('rejects an overlong extra instruction before submitting anything',async()=>{
    const f=fixture(),board=await f.backlogs.get(f.project.id)
    await expect(f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'existing',agentSessionId:f.spec.id},prompt:'x'.repeat(4001)})).rejects.toThrow('4000 characters')
    expect(f.submissions).toHaveLength(0)
  })
  it('keeps tasks unchanged on native failure, retains the visible tab, and never retries the prompt',async()=>{
    const f=fixture({fail:true}),board=await f.backlogs.get(f.project.id),before=readFileSync(join(f.root,'feature-list.md'),'utf8')
    const result=await f.dispatcher.dispatch(f.project.id,board.revision,{taskIds:['one'],target:{type:'new',sessionId:f.workspace.id,provider:'claude',model:'claude-native',effort:'low'}})
    expect(result.assignments[0]).toMatchObject({status:'failed',error:expect.stringContaining('Synthetic native dispatch rejection')})
    expect(readFileSync(join(f.root,'feature-list.md'),'utf8')).toBe(before)
    expect(f.submissions).toHaveLength(1);expect(f.control.tabs({sessionId:f.workspace.id})).toHaveLength(2)
  })
})
