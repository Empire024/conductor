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
