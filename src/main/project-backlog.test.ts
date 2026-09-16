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

describe('project tasks with attached images',()=> {
  // A bug filed with a screenshot embeds the image as a Markdown continuation
  // line rather than a separate field, so it rides the same checklist storage
  // as any other multi-line title (see ProjectBacklogPane's embedTaskImages).
  const withImage='Broken layout on the settings page\n\n![Pasted image](.conductor/prompt-images/abc123.png)'
  it('keeps an embedded image link and its marker intact through add and status edits, without disturbing sibling tasks',()=>{
    let source='# Project tasks\n\n## Bugs\n\n## Features\n'
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Sibling bug filed first'})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:withImage})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Sibling bug filed last'})
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>task.title)).toEqual(['Sibling bug filed first',withImage,'Sibling bug filed last'])
    const imaged=tasks[1]!
    expect(imaged.title).toContain('![Pasted image](.conductor/prompt-images/abc123.png)')
    const markers=[...source.matchAll(/<!-- conductor-task:([a-zA-Z0-9_-]+) -->/g)].map(match=>match[1])
    expect(markers).toHaveLength(3)
    expect(new Set(markers).size).toBe(3)
    const updated=updateProjectTaskText(source,{type:'update',id:imaged.id,status:'done'})
    const reparsed=parseProjectTasks(updated)
    expect(reparsed.find(task=>task.id===imaged.id)).toMatchObject({status:'done',title:withImage})
    expect(reparsed.find(task=>task.title==='Sibling bug filed first')).toMatchObject({status:'todo'})
    expect(reparsed.find(task=>task.title==='Sibling bug filed last')).toMatchObject({status:'todo'})
    expect(updated).toMatch(/<!-- conductor-task:[a-zA-Z0-9_-]+ -->/)
  })
  it('persists an image-attached task through the full service write and preserves unrelated file content',async()=>{
    const f=fixture()
    try {
      const path=join(f.root,'feature-list.md')
      writeFileSync(path,'# Project tasks\n\nKeep this delivery note.\n\n## Bugs\n\n## Features\n')
      const first=await f.service.get(f.project.id)
      const added=await f.service.edit(f.project.id,first.revision,{type:'add',kind:'bug',title:withImage})
      const saved=readFileSync(path,'utf8')
      expect(saved).toContain('Keep this delivery note.')
      expect(saved).toContain('![Pasted image](.conductor/prompt-images/abc123.png)')
      expect(added.tasks[0]).toMatchObject({title:withImage,kind:'bug',status:'todo'})
      expect(parseProjectTasks(saved)[0]).toMatchObject({title:withImage})
    }finally{f.db.close()}
  })
})

describe('project task priority',()=> {
  it('defaults missing or unrecognized priority markers to normal without failing',()=>{
    const source='## Bugs\n- [ ] No marker at all\n- [ ] Legacy claim <!-- conductor-task:legacy agent=agent_A -->\n- [ ] Garbled value <!-- conductor-task:odd priority=urgent -->\n- [ ] Wrong case <!-- conductor-task:cased priority=HIGH -->\n'
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>task.priority)).toEqual(['normal','normal','normal','high'])
  })
  it('writes a high or low priority into the marker and reads it back, leaving normal unmarked',()=>{
    let source=updateProjectTaskText('## Bugs\n',{type:'add',kind:'bug',title:'Fix now',priority:'high'})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Someday',priority:'low'})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Usual pace'})
    expect(source).toContain('priority=high')
    expect(source).toContain('priority=low')
    expect(source).not.toContain('priority=normal')
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>[task.title,task.priority])).toEqual([['Fix now','high'],['Someday','low'],['Usual pace','normal']])
  })
  it('keeps priority through a status-only update, and drops the attribute again once set back to normal',()=>{
    let source=updateProjectTaskText('## Bugs\n',{type:'add',kind:'bug',title:'Urgent fix',priority:'high'})
    const id=parseProjectTasks(source)[0]!.id
    source=updateProjectTaskText(source,{type:'update',id,status:'doing'})
    expect(parseProjectTasks(source)[0]).toMatchObject({status:'doing',priority:'high'})
    source=updateProjectTaskText(source,{type:'update',id,priority:'normal'})
    expect(source).not.toContain('priority=')
    expect(parseProjectTasks(source)[0]).toMatchObject({priority:'normal'})
  })
  it('sets priority on one task without disturbing a sibling claim, unrelated prose, or line endings',()=>{
    const sibling='- [ ] Keep sibling <!-- conductor-task:sibling agent=agent_B -->'
    const source='## Bugs\r\n- [~] Target <!-- conductor-task:target agent=agent_A -->\r\n'+sibling+'\r\nUnrelated prose stays.\r\n'
    const updated=updateProjectTaskText(source,{type:'update',id:'target',priority:'low'})
    expect(updated).toContain('<!-- conductor-task:target agent=agent_A priority=low -->')
    expect(updated).toContain(sibling+'\r\nUnrelated prose stays.\r\n')
    const tasks=parseProjectTasks(updated)
    expect(tasks[0]).toMatchObject({id:'target',agentId:'agent_A',priority:'low',status:'doing'})
    expect(tasks[1]).toMatchObject({id:'sibling',agentId:'agent_B',priority:'normal'})
  })
  it('normalizes a garbage priority value from an edit instead of writing or crashing on it',()=>{
    const source='## Bugs\n- [ ] Task <!-- conductor-task:t1 -->\n'
    const updated=updateProjectTaskText(source,{type:'update',id:'t1',priority:'urgent' as never})
    expect(updated).not.toContain('priority=urgent')
    expect(parseProjectTasks(updated)[0]).toMatchObject({priority:'normal'})
  })
  it('retains unknown marker attributes when changing a known one',()=>{
    const source='## Bugs\n- [~] Imported <!-- conductor-task:t1 agent=agent_A source=linear priority=low external_id=ABC_123 -->\n'
    const updated=updateProjectTaskText(source,{type:'update',id:'t1',priority:'high'})
    expect(updated).toContain('source=linear')
    expect(updated).toContain('external_id=ABC_123')
    expect(updated).toContain('agent=agent_A')
    expect(updated).toContain('priority=high')
    expect(updated).not.toContain('priority=low')
  })
  it('saves an agent-set priority through the real service and keeps it after reloading',async()=>{
    const f=fixture()
    try {
      const first=await f.service.get(f.project.id)
      const added=await f.service.edit(f.project.id,first.revision,{type:'add',kind:'bug',title:'Ship it'})
      const id=added.tasks[0]!.id
      expect(added.tasks[0]).toMatchObject({priority:'normal'})
      const prioritized=await f.service.edit(f.project.id,added.revision,{type:'update',id,priority:'high'})
      expect(prioritized.tasks[0]).toMatchObject({priority:'high'})
      expect((await f.service.get(f.project.id)).tasks[0]).toMatchObject({priority:'high'})
    } finally {f.db.close()}
  })
})

describe('the neutral Task kind',()=> {
  it('parses a Tasks section distinctly from Bugs, Features and Ideas',()=>{
    const source='## Tasks\n- [ ] Write the onboarding doc\n\n## Bugs\n- [ ] Fix the crash\n'
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>[task.title,task.kind])).toEqual([['Write the onboarding doc','task'],['Fix the crash','bug']])
  })
  it('adds a new Task kind to its own section, creating it when missing',()=>{
    const source=updateProjectTaskText('## Bugs\n',{type:'add',kind:'task',title:'Draft the release notes'})
    expect(parseProjectTasks(source)).toEqual([expect.objectContaining({title:'Draft the release notes',kind:'task'})])
    expect(source).toContain('## Tasks')
  })
  it('still rejects an unsupported kind, naming Task alongside Bug, Feature and Idea',()=>{
    expect(()=>updateProjectTaskText('## Bugs\n',{type:'add',kind:'chore' as never,title:'No'})).toThrow('Task, Bug, Feature, or Idea')
  })
  it('moves an edited multiline task into its new kind while preserving identity, claims, metadata and siblings',()=>{
    const source='# Project tasks\r\n\r\n## Tasks\r\n- [~] First paragraph <!-- conductor-task:moving agent=agent_A priority=high weight=heavy source=imported -->\r\n  \r\n  Second paragraph\r\n- [ ] Task sibling <!-- conductor-task:task-sibling -->\r\n\r\n## Bugs\r\n- [ ] Bug sibling <!-- conductor-task:bug-sibling -->\r\n\r\nDelivery note stays.\r\n\r\n## Features\r\n'
    const updated=updateProjectTaskText(source,{type:'update',id:'moving',kind:'bug',title:'First paragraph\n\nSecond paragraph\nEdited detail'})
    const tasks=parseProjectTasks(updated)
    expect(tasks.find(task=>task.id==='moving')).toMatchObject({title:'First paragraph\n\nSecond paragraph\nEdited detail',kind:'bug',status:'doing',agentId:'agent_A',priority:'high',weight:'heavy'})
    expect(tasks.map(task=>task.id)).toEqual(['task-sibling','bug-sibling','moving'])
    expect(updated).toContain('<!-- conductor-task:moving agent=agent_A priority=high weight=heavy source=imported -->')
    expect(updated).toContain('- [ ] Task sibling <!-- conductor-task:task-sibling -->')
    expect(updated).toContain('- [ ] Bug sibling <!-- conductor-task:bug-sibling -->')
    expect(updated).toContain('Delivery note stays.')
    expect(updated).not.toMatch(/## Tasks\r\n- \[~\] First paragraph/)
  })
  it('saves a changed kind through the service and reloads the same multiline task in its new section',async()=>{
    const f=fixture()
    try {
      const path=join(f.root,'feature-list.md')
      writeFileSync(path,'## Tasks\n- [~] Existing report <!-- conductor-task:persist agent=previous_worker origin=manual -->\n  \n  Original detail\n\n## Bugs\n- [ ] Existing bug <!-- conductor-task:bug -->\n\n## Features\n')
      const initial=await f.service.get(f.project.id)
      const saved=await f.service.edit(f.project.id,initial.revision,{type:'update',id:'persist',kind:'feature',title:'Existing report\n\nOriginal detail\nSaved edit'})
      expect(saved.tasks.find(task=>task.id==='persist')).toMatchObject({kind:'feature',title:'Existing report\n\nOriginal detail\nSaved edit',status:'doing',agentId:'previous_worker'})
      const reloaded=await f.service.get(f.project.id)
      expect(reloaded.tasks.find(task=>task.id==='persist')).toMatchObject({kind:'feature',title:'Existing report\n\nOriginal detail\nSaved edit',status:'doing',agentId:'previous_worker'})
      const text=readFileSync(path,'utf8')
      expect(text).toContain('<!-- conductor-task:persist agent=previous_worker origin=manual -->')
      expect(text.indexOf('Existing report')).toBeGreaterThan(text.indexOf('## Features'))
      expect(text).toContain('Existing bug')
    } finally {f.db.close()}
  })
})

describe('project task weight',()=> {
  it('defaults missing or unrecognized weight markers to medium without failing',()=>{
    const source='## Bugs\n- [ ] No marker at all\n- [ ] Garbled value <!-- conductor-task:odd weight=huge -->\n- [ ] Wrong case <!-- conductor-task:cased weight=HEAVY -->\n'
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>task.weight)).toEqual(['medium','medium','heavy'])
  })
  it('writes a heavy or light weight into the marker and reads it back, leaving medium unmarked',()=>{
    let source=updateProjectTaskText('## Bugs\n',{type:'add',kind:'bug',title:'Big refactor',weight:'heavy'})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Tiny tweak',weight:'light'})
    source=updateProjectTaskText(source,{type:'add',kind:'bug',title:'Usual pace'})
    expect(source).toContain('weight=heavy')
    expect(source).toContain('weight=light')
    expect(source).not.toContain('weight=medium')
    const tasks=parseProjectTasks(source)
    expect(tasks.map(task=>[task.title,task.weight])).toEqual([['Big refactor','heavy'],['Tiny tweak','light'],['Usual pace','medium']])
  })
  it('sets weight on one task alongside its priority without disturbing a sibling claim',()=>{
    const sibling='- [ ] Keep sibling <!-- conductor-task:sibling agent=agent_B -->'
    const source='## Bugs\r\n- [~] Target <!-- conductor-task:target agent=agent_A priority=high -->\r\n'+sibling+'\r\n'
    const updated=updateProjectTaskText(source,{type:'update',id:'target',weight:'heavy'})
    expect(updated).toContain('<!-- conductor-task:target agent=agent_A priority=high weight=heavy -->')
    expect(updated).toContain(sibling)
    const tasks=parseProjectTasks(updated)
    expect(tasks[0]).toMatchObject({id:'target',priority:'high',weight:'heavy'})
    expect(tasks[1]).toMatchObject({id:'sibling',weight:'medium'})
  })
  it('saves an agent-set weight through the real service and keeps it after reloading',async()=>{
    const f=fixture()
    try {
      const first=await f.service.get(f.project.id)
      const added=await f.service.edit(f.project.id,first.revision,{type:'add',kind:'bug',title:'Ship it'})
      const id=added.tasks[0]!.id
      expect(added.tasks[0]).toMatchObject({weight:'medium'})
      const weighted=await f.service.edit(f.project.id,added.revision,{type:'update',id,weight:'heavy'})
      expect(weighted.tasks[0]).toMatchObject({weight:'heavy'})
      expect((await f.service.get(f.project.id)).tasks[0]).toMatchObject({weight:'heavy'})
    } finally {f.db.close()}
  })
})
