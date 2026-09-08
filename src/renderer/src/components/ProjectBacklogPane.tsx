import { useCallback, useEffect, useRef, useState } from 'react'
import { Bug, Check, ChevronDown, ChevronRight, Circle, CircleDot, FileText, ListTodo, Pencil, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import type { ProjectBacklog, ProjectTask, ProjectTaskEdit, ProjectTaskKind } from '../../../shared/project-backlog'
import { openWorkspaceFile } from './workspace-files-state'
import './ProjectBacklogPane.css'

export function ProjectBacklogPane({project}:{project:ProjectRecord}):React.JSX.Element {
  const [board,setBoard]=useState<ProjectBacklog|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [query,setQuery]=useState(''),[kind,setKind]=useState<'all'|ProjectTaskKind>('all'),[title,setTitle]=useState(''),[newKind,setNewKind]=useState<ProjectTaskKind>('bug')
  const [editing,setEditing]=useState<{id:string;title:string}|null>(null)
  const key='conductor.tasks.done.'+project.id
  const [doneOpen,setDoneOpen]=useState(()=>localStorage.getItem(key)==='true')
  const revision=useRef(0),mounted=useRef(false),writing=useRef(false)
  const refresh=useCallback(async()=> {
    const sequence=++revision.current
    try {const next=await window.conductor.projectTasks.get(project.id);if(mounted.current && sequence===revision.current)setBoard(next)}
    catch(reason){if(mounted.current)setError(String(reason))}
  },[project.id])
  useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>{if(!writing.current)void refresh()},1500);window.addEventListener('focus',refresh);return()=>{mounted.current=false;revision.current++;clearInterval(timer);window.removeEventListener('focus',refresh)}},[refresh])
  const edit=async(change:ProjectTaskEdit):Promise<boolean>=> {
    if(!board || writing.current)return false
    writing.current=true;setBusy(true);setError('');revision.current++
    try {const next=await window.conductor.projectTasks.edit(project.id,board.revision,change);if(mounted.current)setBoard(next);return true}
    catch(reason){if(mounted.current)setError(String(reason));await refresh();return false}
    finally{writing.current=false;if(mounted.current)setBusy(false)}
  }
  const visible=(board?.tasks??[]).filter(task=>(kind==='all'||task.kind===kind) && task.title.toLowerCase().includes(query.toLowerCase()))
  const todo=visible.filter(task=>task.status==='todo'),doing=visible.filter(task=>task.status==='doing'),done=visible.filter(task=>task.status==='done')
  const row=(task:ProjectTask):React.JSX.Element=> {
    const owner=board?.owners.find(owner=>owner.id===task.agentId)
    const Status=task.status==='done'?Check:task.status==='doing'?CircleDot:Circle
    return <article className={'project-task status-'+task.status} key={task.id} data-task-id={task.id}>
      <button className="project-task-check" aria-label={(task.status==='done'?'Reopen ':'Complete ')+task.title} title={task.status==='done'?'Reopen task':'Mark done'} disabled={busy} onClick={()=>void edit({type:'update',id:task.id,status:task.status==='done'?'todo':'done'})}><Status size={16}/></button>
      <div className="project-task-body">
        {editing?.id===task.id ? <form onSubmit={event=>{event.preventDefault();void edit({type:'update',id:task.id,title:editing.title}).then(saved=>{if(saved)setEditing(null)})}}><textarea autoFocus aria-label="Edit task" value={editing.title} onChange={event=>setEditing({id:task.id,title:event.target.value})} onKeyDown={event=>{if(event.key==='Escape')setEditing(null)}}/><div><button disabled={busy} type="submit">Save</button><button type="button" onClick={()=>setEditing(null)}>Cancel</button></div></form> : <button className="project-task-title" onClick={()=>setEditing({id:task.id,title:task.title})}>{task.title}</button>}
        <div className="project-task-meta"><span className={'project-task-kind '+task.kind}>{task.kind==='bug'?<Bug size={11}/>:<Sparkles size={11}/>} {task.kind==='bug'?'Bug':'Feature'}</span>
          <select aria-label={'Status of '+task.title} disabled={busy} value={task.status} onChange={event=>void edit({type:'update',id:task.id,status:event.target.value as ProjectTask['status']})}><option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option></select>
          <button className="project-task-edit" title="Edit task" aria-label={'Edit '+task.title} onClick={()=>setEditing({id:task.id,title:task.title})}><Pencil size={11}/></button>
        </div>
        <div className="project-task-owner"><select aria-label={'Agent for '+task.title} disabled={busy} value={task.agentId??''} onChange={event=>void edit({type:'update',id:task.id,agentId:event.target.value||null})}><option value="">Unassigned</option>{task.agentId&&!owner&&<option value={task.agentId}>Previous agent · {task.agentId}</option>}{board?.owners.map(owner=><option key={owner.id} value={owner.id}>{owner.provider} · {owner.title} · {owner.workspace}</option>)}</select>
          {owner && <button title={'Open '+owner.title+' in '+owner.workspace} aria-label={'Open assigned agent for '+task.title} onClick={()=>window.dispatchEvent(new CustomEvent('conductor:focus-process',{detail:{id:owner.id,sessionId:owner.sessionId}}))}>{owner.phase.replaceAll('_',' ')} <ChevronRight size={12}/></button>}
        </div>
      </div>
    </article>
  }
  const total=board?.tasks.length??0,completed=board?.tasks.filter(task=>task.status==='done').length??0
  return <section className="project-backlog" aria-label="Project tasks">
    <header><div><ListTodo size={17}/><strong>{project.name}</strong><span>{completed}/{total} done</span></div><progress max={Math.max(1,total)} value={completed} aria-label="Project task completion"/>
      <div className="project-backlog-actions"><button title="Open task file" onClick={()=>openWorkspaceFile(project.id,'feature-list.md','editor')}><FileText size={12}/> feature-list.md</button><button title="Refresh project tasks" aria-label="Refresh project tasks" onClick={()=>void refresh()}><RefreshCw size={13}/></button></div>
    </header>
    <form className="project-task-add" onSubmit={event=>{event.preventDefault();void edit({type:'add',title,kind:newKind}).then(saved=>{if(saved)setTitle('')})}}><textarea aria-label="New project task" placeholder="Add a bug or feature…" value={title} onChange={event=>setTitle(event.target.value)} rows={2} maxLength={8000}/><div><select aria-label="New task type" value={newKind} onChange={event=>setNewKind(event.target.value as ProjectTaskKind)}><option value="bug">Bug</option><option value="feature">Feature</option></select><button type="submit" disabled={busy||!board||!title.trim()}><Plus size={13}/> Add task</button></div></form>
    <div className="project-task-filters"><label><Search size={13}/><input aria-label="Search project tasks" placeholder="Search tasks" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button title="Clear search" onClick={()=>setQuery('')}><X size={11}/></button>}</label><select aria-label="Task type filter" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="all">All types</option><option value="bug">Bugs</option><option value="feature">Features</option></select></div>
    {error&&<p className="project-task-error" role="alert">{error}</p>}
    <div className="project-task-list">
      {doing.length>0&&<section aria-label="Tasks in progress"><h3><CircleDot size={13}/> In progress <span>{doing.length}</span></h3>{doing.map(row)}</section>}
      <section aria-label="Tasks to do"><h3><Circle size={13}/> To do <span>{todo.length}</span></h3>{todo.map(row)}{!todo.length&&<p className="project-task-empty">{board?'No pending items here.':'Loading tasks…'}</p>}</section>
      <section aria-label="Completed tasks"><button className="project-task-done-heading" aria-expanded={doneOpen} onClick={()=>setDoneOpen(open=>{localStorage.setItem(key,String(!open));return !open})}>{doneOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>} Done <span>{done.length}</span></button>{doneOpen&&done.map(row)}</section>
    </div>
    <footer>Saved in your project. Agent edits appear automatically.</footer>
  </section>
}
