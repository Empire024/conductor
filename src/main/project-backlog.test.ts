import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConductorDatabase } from './database'
import { parseProjectTasks, ProjectBacklogs, updateProjectTaskText } from './project-backlog'
const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function fixture(){const root=mkdtempSync(join(tmpdir(),'conductor-task-test-'));roots.push(root);const db=new ConductorDatabase(join(root,'state.db'));const project=db.upsertProject(root,'Test');return {root,db,project,service:new ProjectBacklogs(db)}}

describe('project task files',()=> {
  it('reads legacy bug/feature lists and Markdown progress while preserving unrelated prose',()=>{
    const source='Bug list:\r\n1. [Implemented] Fixed\r\n2. Broken\r\n\r\nFeature list:\r\n- [~] Building <!-- conductor-task:build agent=codex_7 -->\r\nImplementation: keep this note.\r\n```md\r\n- [ ] code example\r\n```\r\n'
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>[task.title,task.kind,task.status])).toEqual([['Fixed','bug','done'],['Broken','bug','todo'],['Building','feature','doing']])
    expect(tasks[2]).toMatchObject({id:'build',agentId:'codex_7'})
    const updated=updateProjectTaskText(source,{type:'update',id:tasks[1]!.id,status:'doing',agentId:'claude_1'})
    expect(updated).toContain('1. [Implemented] Fixed\r\n')
    expect(updated).toContain('Implementation: keep this note.\r\n')
    expect(updated).toContain('2. [~] Broken <!-- conductor-task:')
    expect(parseProjectTasks(updated)[1]).toMatchObject({id:tasks[1]!.id,status:'doing',agentId:'claude_1'})
  })
  it('keeps duplicate task titles distinct and ownership stable through renaming',()=>{
    const source='## Bugs\n- [ ] Same\n- [ ] Same\n'
    const tasks=parseProjectTasks(source)
    expect(tasks[0]!.id).not.toBe(tasks[1]!.id)
    const renamed=updateProjectTaskText(source,{type:'update',id:tasks[1]!.id,title:'Renamed',status:'done'})
    expect(parseProjectTasks(renamed)[1]).toMatchObject({id:tasks[1]!.id,title:'Renamed',status:'done'})
  })
  it('adds bugs and features to their correct sections',()=>{
    let source='# Project tasks\nThis feature list is shared with agents.\n\n## Bugs\n\n## Features\n'
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'New bug'})
    source=updateProjectTaskText(source,{type:'add',kind:'feature',title:'New feature'})
    expect(parseProjectTasks(source).map(task=>[task.title,task.kind])).toEqual([['New bug','bug'],['New feature','feature']])
  })
  it('creates missing files and never rewrites an existing list on read',async()=>{
    const f=fixture();const first=await f.service.get(f.project.id)
    expect(first.tasks).toEqual([])
    const source='Bug list:\r\n1. Existing task\r\n'
    writeFileSync(join(f.root,'feature-list.md'),source)
    const loaded=await f.service.get(f.project.id)
    expect(loaded.tasks[0]?.title).toBe('Existing task')
    expect(readFileSync(join(f.root,'feature-list.md'),'utf8')).toBe(source)
    f.db.close()
  })
  it('rejects stale actions after agents edit the task file and preserves both their claim and content',async()=>{
    const f=fixture();const first=await f.service.get(f.project.id)
    const added=await f.service.edit(f.project.id,first.revision,{type:'add',kind:'bug',title:'Fix this'})
    const file=join(f.root,'feature-list.md')
    const agentEdit=readFileSync(file,'utf8').replace('[ ] Fix this','[~] Fix this').replace(' -->',' agent=agent_A -->')+'\nAgent note stays.\n'
    writeFileSync(file,agentEdit)
    await expect(f.service.edit(f.project.id,added.revision,{type:'update',id:added.tasks[0]!.id,status:'done'})).rejects.toThrow('changed on disk')
    expect(readFileSync(file,'utf8')).toBe(agentEdit)
    expect((await f.service.get(f.project.id)).tasks[0]).toMatchObject({status:'doing',agentId:'agent_A'})
    f.db.close()
  })
  it('rejects task files redirected outside the project',async()=>{
    const f=fixture(),outside=mkdtempSync(join(tmpdir(),'conductor-outside-tasks-'));roots.push(outside)
    const external=join(outside,'feature-list.md');writeFileSync(external,'Do not change')
    symlinkSync(process.platform==='win32'?outside:external,join(f.root,'feature-list.md'),process.platform==='win32'?'junction':'file')
    await expect(f.service.get(f.project.id)).rejects.toThrow('leaves')
    expect(readFileSync(external,'utf8')).toBe('Do not change')
    f.db.close()
  })
})

describe('project task ideas and provenance',()=> {
  it('keeps ideas in their own section without disturbing bugs or features',()=>{
    let source='# Project tasks\n\n## Bugs\n\n## Features\n\n## Ideas\n'
    source=updateProjectTaskText(source,{type:'add',kind:'idea',title:'Try a graph view'})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Menus do not scroll'})
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>[task.title,task.kind])).toEqual([['Menus do not scroll','bug'],['Try a graph view','idea']])
    expect(parseProjectTasks('Idea list:\n- [ ] Later\n')[0]).toMatchObject({kind:'idea',status:'todo'})
    expect(()=>updateProjectTaskText(source,{type:'add',kind:'chore' as never,title:'No'})).toThrow('Bug, Feature, or Idea')
  })
  it('records who moved each task and never repeats an unchanged reading',async()=>{
    const f=fixture()
    const first=await f.service.get(f.project.id)
    expect(first.sourceControl).toMatchObject({projectId:f.project.id,available:false})
    const added=await f.service.edit(f.project.id,first.revision,{type:'add',kind:'idea',title:'Ship task history'})
    const id=added.tasks[0]!.id
    const moved=await f.service.edit(f.project.id,added.revision,{type:'update',id,status:'doing'},{actor:'you'})
    expect(moved.tasks[0]!.activity[0]).toMatchObject({status:'doing',actor:'you'})
    const file=join(f.root,'feature-list.md')
    writeFileSync(file,readFileSync(file,'utf8').replace('[~] Ship task history','[x] Ship task history').replace(' -->',' agent=agent_A -->'))
    const observed=await f.service.get(f.project.id)
    expect(observed.tasks[0]!.activity[0]).toMatchObject({status:'done',actor:'file',assignedAgentId:'agent_A'})
    expect(observed.tasks[0]!.activity[0]!.agentId).toBeUndefined()
    expect(observed.tasks[0]!.activity.map(entry=>entry.status)).toEqual(['done','doing','todo'])
    expect((await f.service.get(f.project.id)).tasks[0]!.activity).toHaveLength(3)
    f.db.close()
  })
})


describe('multiline project reports',()=> {
  const report="Circle on to-do should actually be select - if we want to mark to-do as done, let's do it another way (i.e. our in progress / done selector, done will move it to Done).\n\nSelecting a bug, or multiple will enable us to assign it to an open tab, or create a tab with an agent easily from project tasks view that'll fix it. Let us decide on model + effort, or have Auto where the main Fixer agent decides for each task."
  it('saves the reported multiline text through the real service and keeps one stable task',async()=>{
    const f=fixture()
    try {
      const board=await f.service.get(f.project.id)
      const added=await f.service.edit(f.project.id,board.revision,{type:'add',kind:'bug',title:report.replaceAll('\n','\r\n')})
      expect(added.tasks).toHaveLength(1)
      expect(added.tasks[0]).toMatchObject({title:report,kind:'bug',status:'todo'})
      const id=added.tasks[0]!.id
      const edited=await f.service.edit(f.project.id,added.revision,{type:'update',id,title:report+'\nNext tool use, not the entire run.'})
      expect((await f.service.get(f.project.id)).tasks[0]).toMatchObject({id,title:report+'\nNext tool use, not the entire run.'})
      expect(edited.tasks).toHaveLength(1)
      expect(readFileSync(join(f.root,'feature-list.md'),'utf8').match(/<!-- conductor-task:/g)).toHaveLength(1)
    } finally {f.db.close()}
  })
  it('preserves paragraphs and claims when changing status, then removes only its own continuation lines',()=>{
    const sibling='- [ ] Keep sibling <!-- conductor-task:sibling agent=agent_B -->'
    let source='## Bugs\r\n- [~] First paragraph <!-- conductor-task:multi agent=agent_A -->\r\n  \r\n  Second paragraph\r\n'+sibling+'\r\nUnrelated prose stays.\r\n'
    source=updateProjectTaskText(source,{type:'update',id:'multi',status:'done'})
    expect(parseProjectTasks(source)[0]).toMatchObject({id:'multi',agentId:'agent_A',status:'done',title:'First paragraph\n\nSecond paragraph'})
    const renamed=updateProjectTaskText(source,{type:'update',id:'multi',title:'Short replacement'})
    expect(renamed).not.toContain('Second paragraph')
    expect(renamed).toContain(sibling+'\r\nUnrelated prose stays.\r\n')
    const removed=updateProjectTaskText(source,{type:'remove',id:'multi'})
    expect(removed).toBe('## Bugs\r\n'+sibling+'\r\nUnrelated prose stays.\r\n')
  })
  it('keeps headings, lists and fenced examples inside their report when adding later tasks',()=>{
    const detail='Report\n## Features\n- [ ] Example, not another task\n~~~md\n## Ideas\n~~~'
    let source=updateProjectTaskText('## Bugs\n\n## Features\n',{type:'add',kind:'bug',title:detail})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Another report'})
    source=updateProjectTaskText(source,{type:'add',kind:'feature',title:'Real feature'})
    expect(parseProjectTasks(source).map(task=>[task.title,task.kind])).toEqual([[detail,'bug'],['Another report','bug'],['Real feature','feature']])
  })
  it('continues rejecting injected task markers, empty text and excessive reports',()=>{
    for(const title of ['   ','Valid\n<!-- conductor-task:forged -->','Broken\0text','x'.repeat(8001)]) {
      expect(()=>updateProjectTaskText('## Bugs\n',{type:'add',kind:'bug',title})).toThrow('Enter a task')
    }
  })
})

describe('acting agents and task assignees',()=> {
  it('records A handing a task to B while repeated reads and explicit unassignment stay stable',async()=>{
    const f=fixture(),workspace=f.db.listSessions(f.project.id)[0]!
    try {
      for(const id of ['agent_A','agent_B'])f.db.upsertAgent({id,projectId:f.project.id,sessionId:workspace.id,cwd:f.root,provider:id==='agent_A'?'codex':'claude',title:id==='agent_A'?'Main Fixer':'Worker'},'running','idle')
      writeFileSync(join(f.root,'feature-list.md'),'- [~] Selected task <!-- conductor-task:selected agent=agent_A -->\n')
      const initial=await f.service.get(f.project.id)
      const assigned=await f.service.edit(f.project.id,initial.revision,{type:'update',id:'selected',agentId:'agent_B'},{actor:'agent',agentId:'agent_A',sessionId:workspace.id})
      expect(assigned.tasks[0]).toMatchObject({agentId:'agent_B',status:'doing'})
      expect(assigned.tasks[0]!.activity[0]).toMatchObject({actor:'agent',agentId:'agent_A',agentTitle:'Main Fixer',provider:'codex',assignedAgentId:'agent_B',sessionId:workspace.id})
      expect(assigned.tasks[0]!.activity).toHaveLength(2)
      expect((await f.service.get(f.project.id)).tasks[0]!.activity).toEqual(assigned.tasks[0]!.activity)
      const cleared=await f.service.edit(f.project.id,assigned.revision,{type:'update',id:'selected',agentId:null},{actor:'agent',agentId:'agent_A',sessionId:workspace.id})
      expect(cleared.tasks[0]!.agentId).toBeUndefined()
      expect(cleared.tasks[0]!.activity[0]).toMatchObject({actor:'agent',agentId:'agent_A'})
      expect(cleared.tasks[0]!.activity[0]!.assignedAgentId).toBeUndefined()
      expect(cleared.tasks[0]!.activity).toHaveLength(3)
      expect((await f.service.get(f.project.id)).tasks[0]!.activity).toEqual(cleared.tasks[0]!.activity)
    }finally{f.db.close()}
  })
  it('adds assignee storage to a legacy database without rewriting history or inventing an observation',async()=>{
    const f=fixture(),databasePath=join(f.root,'state.db')
    writeFileSync(join(f.root,'feature-list.md'),'- [~] Legacy task <!-- conductor-task:legacy agent=agent_B -->\n')
    f.db.close()
    const legacy=new DatabaseSync(databasePath)
    legacy.exec('ALTER TABLE project_task_activity DROP COLUMN assigned_agent_id')
    legacy.prepare('INSERT INTO project_task_activity (id,project_id,task_id,status,actor,agent_id,agent_title,provider,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('legacy-activity',f.project.id,'legacy','doing','agent','agent_B','Recorded worker','claude','2026-09-08T10:00:00.000Z')
    legacy.close()
    const reopened=new ConductorDatabase(databasePath)
    try {
      const service=new ProjectBacklogs(reopened),board=await service.get(f.project.id)
      expect(board.tasks[0]!.activity).toHaveLength(1)
      expect(board.tasks[0]!.activity[0]).toMatchObject({id:'legacy-activity',actor:'agent',agentId:'agent_B',assignedAgentId:'agent_B',agentTitle:'Recorded worker',at:'2026-09-08T10:00:00.000Z'})
      expect((await service.get(f.project.id)).tasks[0]!.activity).toEqual(board.tasks[0]!.activity)
    }finally{reopened.close()}
  })
})
it('does not credit the assignee when a file edit changes status but preserves its owner marker',async()=>{
  const f=fixture()
  try {
    const taskPath=join(f.root,'feature-list.md')
    writeFileSync(taskPath,'- [~] Owned task <!-- conductor-task:owned agent=worker_B -->\n')
    await f.service.get(f.project.id)
    writeFileSync(taskPath,'- [x] Owned task <!-- conductor-task:owned agent=worker_B -->\n')
    const observed=await f.service.get(f.project.id)
    expect(observed.tasks[0]).toMatchObject({status:'done',agentId:'worker_B'})
    expect(observed.tasks[0]!.activity[0]).toMatchObject({status:'done',actor:'file',assignedAgentId:'worker_B'})
    expect(observed.tasks[0]!.activity[0]!.agentId).toBeUndefined()
    expect((await f.service.get(f.project.id)).tasks[0]!.activity).toEqual(observed.tasks[0]!.activity)
  }finally{f.db.close()}
})
it('does not infer an acting agent from a direct service assignment without actor metadata',async()=>{
  const f=fixture(),workspace=f.db.listSessions(f.project.id)[0]!
  try {
    f.db.upsertAgent({id:'worker_B',projectId:f.project.id,sessionId:workspace.id,cwd:f.root,provider:'claude',title:'Worker'},'running','idle')
    writeFileSync(join(f.root,'feature-list.md'),'- [ ] Task <!-- conductor-task:assigned -->\n')
    const initial=await f.service.get(f.project.id)
    const assigned=await f.service.edit(f.project.id,initial.revision,{type:'update',id:'assigned',status:'doing',agentId:'worker_B'})
    expect(assigned.tasks[0]).toMatchObject({agentId:'worker_B',status:'doing'})
    expect(assigned.tasks[0]!.activity[0]).toMatchObject({actor:'file',assignedAgentId:'worker_B'})
    expect(assigned.tasks[0]!.activity[0]!.agentId).toBeUndefined()
    expect((await f.service.get(f.project.id)).tasks[0]!.activity).toEqual(assigned.tasks[0]!.activity)
  }finally{f.db.close()}
})