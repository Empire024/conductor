import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, ClipboardList, FileText, GitBranch, GitCompare, Github, Lightbulb, ListTodo, Pencil, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { projectTaskPriorities, projectTaskWeights } from '../../../shared/project-backlog'
import type { ProjectBacklog, ProjectTask, ProjectTaskActivity, ProjectTaskDispatchResult, ProjectTaskDispatchTarget, ProjectTaskEdit, ProjectTaskKind, ProjectTaskPriority, ProjectTaskWeight } from '../../../shared/project-backlog'
import type { SourceControlChangeSet } from '../../../shared/source-control'
import type { ContextAttachment } from '../../../shared/structured-agent'
import { AgentDialog } from '../panes/StructuredAgentRenderers'
import { openWorkspaceFile } from './workspace-files-state'
import { ProjectTaskAssignment, type ProjectTaskAssignmentMode } from './ProjectTaskAssignment'
import { PromptImageThumbnail, PromptImageUpload } from './PromptImageUpload'
import '../panes/StructuredAgentPane.css'
import './ProjectBacklogPane.css'

const kindLabels:Record<ProjectTaskKind,string> = {task:'Task',bug:'Bug',feature:'Feature',idea:'Idea'}
const kindIcons = {task:ClipboardList,bug:Bug,feature:Sparkles,idea:Lightbulb}
const statusVerbs:Record<ProjectTask['status'],string> = {done:'Completed by',doing:'Claimed by',todo:'Reopened by'}
const fileVerbs:Record<ProjectTask['status'],string> = {done:'Marked done',doing:'Marked in progress',todo:'Listed'}
const priorityLabels:Record<ProjectTaskPriority,string> = {high:'High',normal:'Normal',low:'Low'}
const priorityRank:Record<ProjectTaskPriority,number> = {high:0,normal:1,low:2}
const priorityColors:Record<ProjectTaskPriority,string> = {high:'var(--danger)',normal:'var(--accent-muted)',low:'var(--text-3)'}
const weightLabels:Record<ProjectTaskWeight,string> = {heavy:'Heavy',medium:'Medium',light:'Light'}
const weightColors:Record<ProjectTaskWeight,string> = {heavy:'var(--danger)',medium:'var(--accent-muted)',light:'var(--text-3)'}

/** A custom listbox, not a native <select>: a themed <select>'s color styles the whole
 *  popup including every option, so tinting the trigger by priority also painted every
 *  option in the native menu the same color. Each option here is its own node instead. */
function PriorityPicker({value,disabled,ariaLabel,suffix,onChange,onKeyDown}:{value:ProjectTaskPriority;disabled?:boolean;ariaLabel:string;suffix?:string;onChange(next:ProjectTaskPriority):void;onKeyDown?(event:React.KeyboardEvent<HTMLButtonElement>):void}):React.JSX.Element {
  const [open,setOpen]=useState(false)
  const trigger=useRef<HTMLButtonElement>(null)
  const menu=useRef<HTMLDivElement>(null)
  const id=useId()
  const close=():void=>{setOpen(false);trigger.current?.focus()}
  useLayoutEffect(()=> {
    if(!open)return
    const anchor=trigger.current!.getBoundingClientRect()
    const box=menu.current
    if(box) {
      const size=box.getBoundingClientRect()
      box.style.left=Math.max(8,Math.min(anchor.left,window.innerWidth-size.width-8))+'px'
      box.style.top=Math.min(anchor.bottom+4,window.innerHeight-size.height-8)+'px'
    }
    menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
  },[open])
  useEffect(()=> {
    if(!open)return
    const outside=(event:PointerEvent):void=>{if(!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node))setOpen(false)}
    const dismiss=():void=>setOpen(false)
    document.addEventListener('pointerdown',outside)
    window.addEventListener('resize',dismiss)
    window.addEventListener('scroll',dismiss,true)
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true)}
  },[open])
  useEffect(()=>{if(disabled)setOpen(false)},[disabled])
  return <>
    <button ref={trigger} type="button" className={'project-priority-trigger priority-'+value} aria-label={ariaLabel} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} disabled={disabled} onClick={()=>setOpen(o=>!o)} onKeyDown={event=> {
      onKeyDown?.(event)
      if(!event.defaultPrevented && event.key==='ArrowDown'){event.preventDefault();setOpen(true)}
    }}><span className="project-priority-dot" aria-hidden="true" style={{background:priorityColors[value]}}/><span>{priorityLabels[value]}{suffix}</span><ChevronDown size={11} aria-hidden="true"/></button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={ariaLabel} className="project-priority-menu" onKeyDown={event=> {
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault()
        const options=[...menu.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        const index=options.indexOf(document.activeElement as HTMLButtonElement)
        const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:options.length-1))%options.length
        options[next]?.focus()
      }
    }}>{projectTaskPriorities.map(item=> <button key={item} type="button" role="option" aria-selected={value===item} className={'project-priority-option priority-'+item} onClick={()=>{onChange(item);close()}}>
      <span className="project-priority-dot" aria-hidden="true" style={{background:priorityColors[item]}}/><span>{priorityLabels[item]}{suffix}</span>{value===item && <Check size={13} aria-hidden="true" className="project-priority-check"/>}
    </button>)}</div>,document.body)}
  </>
}

/** Same custom-listbox approach as PriorityPicker, for the model weight suggestion. */
function WeightPicker({value,disabled,ariaLabel,suffix,onChange,onKeyDown}:{value:ProjectTaskWeight;disabled?:boolean;ariaLabel:string;suffix?:string;onChange(next:ProjectTaskWeight):void;onKeyDown?(event:React.KeyboardEvent<HTMLButtonElement>):void}):React.JSX.Element {
  const [open,setOpen]=useState(false)
  const trigger=useRef<HTMLButtonElement>(null)
  const menu=useRef<HTMLDivElement>(null)
  const id=useId()
  const close=():void=>{setOpen(false);trigger.current?.focus()}
  useLayoutEffect(()=> {
    if(!open)return
    const anchor=trigger.current!.getBoundingClientRect()
    const box=menu.current
    if(box) {
      const size=box.getBoundingClientRect()
      box.style.left=Math.max(8,Math.min(anchor.left,window.innerWidth-size.width-8))+'px'
      box.style.top=Math.min(anchor.bottom+4,window.innerHeight-size.height-8)+'px'
    }
    menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
  },[open])
  useEffect(()=> {
    if(!open)return
    const outside=(event:PointerEvent):void=>{if(!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node))setOpen(false)}
    const dismiss=():void=>setOpen(false)
    document.addEventListener('pointerdown',outside)
    window.addEventListener('resize',dismiss)
    window.addEventListener('scroll',dismiss,true)
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true)}
  },[open])
  useEffect(()=>{if(disabled)setOpen(false)},[disabled])
  return <>
    <button ref={trigger} type="button" className={'project-weight-trigger weight-'+value} aria-label={ariaLabel} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} disabled={disabled} onClick={()=>setOpen(o=>!o)} onKeyDown={event=> {
      onKeyDown?.(event)
      if(!event.defaultPrevented && event.key==='ArrowDown'){event.preventDefault();setOpen(true)}
    }}><span className="project-weight-dot" aria-hidden="true" style={{background:weightColors[value]}}/><span>{weightLabels[value]}{suffix}</span><ChevronDown size={11} aria-hidden="true"/></button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={ariaLabel} className="project-weight-menu" onKeyDown={event=> {
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault()
        const options=[...menu.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        const index=options.indexOf(document.activeElement as HTMLButtonElement)
        const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:options.length-1))%options.length
        options[next]?.focus()
      }
    }}>{projectTaskWeights.map(item=> <button key={item} type="button" role="option" aria-selected={value===item} className={'project-weight-option weight-'+item} onClick={()=>{onChange(item);close()}}>
      <span className="project-weight-dot" aria-hidden="true" style={{background:weightColors[item]}}/><span>{weightLabels[item]}{suffix}</span>{value===item && <Check size={13} aria-hidden="true" className="project-weight-check"/>}
    </button>)}</div>,document.body)}
  </>
}

/** When a task was first seen (its earliest recorded activity), so "newest" tracks when it
 *  was added rather than when it was last touched. Falls back to file position for the rare
 *  case a task has no recorded activity yet (e.g. a freshly built fixture in tests). */
function taskCreatedAt(task:ProjectTask):number {
  const first=task.activity[task.activity.length-1]
  const at=first?Date.parse(first.at):NaN
  return Number.isFinite(at)?at:task.line
}
/** Priority first (high, normal, low), then newest-added first within a priority. A pure view
 *  concern: feature-list.md keeps its own on-disk order untouched. */
export function sortProjectTasks(tasks:ProjectTask[]):ProjectTask[] {
  return [...tasks].sort((a,b)=>priorityRank[a.priority]-priorityRank[b.priority] || taskCreatedAt(b)-taskCreatedAt(a))
}

export function submitTaskShortcut(event:React.KeyboardEvent<HTMLTextAreaElement|HTMLSelectElement|HTMLButtonElement>):void {
  if(event.nativeEvent.isComposing || event.nativeEvent.keyCode===229)return
  if(event.key==='Enter' && (event.ctrlKey || event.metaKey)){event.preventDefault();event.currentTarget.form?.requestSubmit()}
}

/** Task titles stay valid Markdown: an attached image becomes its own continuation line so
 *  the existing checklist parser round-trips it like any other multi-line title. */
const taskImageLine=/^!\[([^\]]*)\]\(([^\s()]+)\)$/
export function embedTaskImages(title:string,images:ContextAttachment[]):string {
  const lines=images.filter(image=>image.path).map(image=>'!['+image.name.replace(/[[\]]/g,'').slice(0,160)+']('+image.path+')')
  return lines.length?title.trim()+'\n\n'+lines.join('\n'):title
}
export function splitTaskImages(title:string):{text:string;images:{id:string;name:string;path:string}[]} {
  const images:{id:string;name:string;path:string}[]=[], lines:string[]=[]
  for(const line of title.split('\n')) {
    const match=taskImageLine.exec(line.trim())
    if(match)images.push({id:match[2]!,name:match[1] || 'Image',path:match[2]!})
    else lines.push(line)
  }
  return {text:lines.join('\n').replace(/\n{3,}/g,'\n\n').trim(),images}
}

/** Short, honest relative time. Older entries fall back to a real date. */
export function taskMoment(at:string,now=Date.now()):string {
  const stamp=Date.parse(at)
  if(!Number.isFinite(stamp))return ''
  const seconds=Math.max(0,Math.round((now-stamp)/1000))
  if(seconds<60)return 'just now'
  if(seconds<3600)return Math.floor(seconds/60)+'m ago'
  if(seconds<86400)return Math.floor(seconds/3600)+'h ago'
  if(seconds<604800)return Math.floor(seconds/86400)+'d ago'
  return new Date(stamp).toLocaleDateString(undefined,{month:'short',day:'numeric'})
}
/** Who moved a task, in the words the owner would use. */
export function taskAuthor(activity:ProjectTaskActivity):string {
  if(activity.actor!=='agent')return 'you'
  const name=[activity.provider,activity.agentTitle].filter(Boolean).filter((part,index,all)=>all.indexOf(part)===index).join(' · ')
  return name || activity.agentId || 'an agent'
}

/** A done task must read as done at a glance, not just once you notice the muted text. */
export function taskTitleRow(status:ProjectTask['status'],content:React.ReactNode,onClick:()=>void):React.JSX.Element {
  return <div className="project-task-title-row">{status==='done' && <Check size={13} className="project-task-done-check" aria-hidden="true"/>}<button className="project-task-title" onClick={onClick}>{content}</button></div>
}

function TaskChanges({project,task,onClose}:{project:ProjectRecord;task:ProjectTask;onClose():void}):React.JSX.Element {
  const [changes,setChanges]=useState<SourceControlChangeSet|null>(null),[error,setError]=useState('')
  useEffect(()=>{let live=true
    window.conductor.projectTasks.changes(project.id,task.id).then(result=>{if(live)setChanges(result)},reason=>{if(live)setError(String(reason))})
    return()=>{live=false}},[project.id,task.id])
  const open=(url?:string):void=>{if(url)void window.conductor.system.openExternal(url).catch((reason:unknown)=>setError(String(reason)))}
  return <AgentDialog title={'Changes · '+task.title.slice(0,80)} onClose={onClose}>
    <div className="project-diff">
      {error&&<p role="alert" className="project-task-error">{error}</p>}
      {!changes&&!error&&<p className="project-task-empty">Reading the repository…</p>}
      {changes&&<>
        <div className="project-diff-actions">
          <button disabled={!changes.compareUrl} title={changes.compareUrl ?? 'This repository has no GitHub remote.'} onClick={()=>open(changes.compareUrl)}><Github size={13}/> Open on GitHub</button>
          {changes.base&&<code title="Commit when this task was first recorded">{changes.base.slice(0,8)} → {changes.head?.slice(0,8)}</code>}
          {!changes.base&&changes.head&&<code title="Commit this task was last recorded against">{changes.head.slice(0,8)}</code>}
        </div>
        {changes.note&&<p className="project-task-empty">{changes.note}</p>}
        {changes.commits.length>0&&<section><h4>{changes.commits.length} commit{changes.commits.length===1?'':'s'}</h4>
          <ul className="project-diff-commits">{changes.commits.map(commit=><li key={commit.sha}>
            <button className="project-diff-sha" disabled={!commit.url} title={commit.url ?? commit.sha} onClick={()=>open(commit.url)}>{commit.sha.slice(0,8)}</button>
            <span>{commit.subject}</span><small>{commit.author} · {taskMoment(commit.date)}</small>
          </li>)}</ul></section>}
        {changes.files.length>0&&<section><h4>{changes.files.length} file{changes.files.length===1?'':'s'} changed</h4>
          <ul className="project-diff-files">{changes.files.map(file=><li key={file.path}>
            <button title={'Open '+file.path} onClick={()=>{openWorkspaceFile(project.id,file.path,'editor');onClose()}}>{file.path}</button>
            <small>{file.status}</small>
            <span className="project-diff-count">{file.additions!==undefined&&<b>+{file.additions}</b>}{file.deletions!==undefined&&<em>−{file.deletions}</em>}</span>
          </li>)}</ul></section>}
        {changes.patch&&<details className="project-diff-patch"><summary>Full patch{changes.patchTruncated?' (truncated)':''}</summary>
          <pre>{changes.patch.split('\n').map((line,index)=><span key={index} className={/^\+(?!\+\+)/.test(line)?'project-diff-added':/^-(?!--)/.test(line)?'project-diff-removed':undefined}>{line}{'\n'}</span>)}</pre></details>}
      </>}
    </div>
  </AgentDialog>
}

/** The drawer unmounts whenever it is closed or the project changes, so unsubmitted task
 *  text lives outside React state. Written from the input handlers, never from an effect,
 *  so an unmount cannot race the save. */
interface BacklogDraft {title:string;images:ContextAttachment[];editing:{id:string;title:string}|null}
const emptyBacklogDraft:BacklogDraft={title:'',images:[],editing:null}
const backlogDraftKey=(projectId:string):string=>'conductor.tasks.draft.'+projectId
const isDraftImage=(value:unknown):value is ContextAttachment=>Boolean(value) && typeof value==='object' && (value as ContextAttachment).kind==='image' && typeof (value as ContextAttachment).id==='string' && typeof (value as ContextAttachment).path==='string' && typeof (value as ContextAttachment).name==='string'
const readBacklogDraft=(projectId:string):BacklogDraft=> {
  try {
    const value=JSON.parse(localStorage.getItem(backlogDraftKey(projectId))??'null')
    if(!value || typeof value.title!=='string')return emptyBacklogDraft
    const editing=value.editing && typeof value.editing.id==='string' && typeof value.editing.title==='string'?{id:value.editing.id,title:value.editing.title}:null
    const images=Array.isArray(value.images)?value.images.filter(isDraftImage):[]
    return {title:value.title,images,editing}
  } catch {return emptyBacklogDraft}
}
const writeBacklogDraft=(projectId:string,draft:BacklogDraft):void=> {
  try {
    if(!draft.title && !draft.images.length && !draft.editing)localStorage.removeItem(backlogDraftKey(projectId))
    else localStorage.setItem(backlogDraftKey(projectId),JSON.stringify(draft))
  } catch {/* A full quota must never block typing; the text stays in React state. */}
}

export function ProjectBacklogPane({project}:{project:ProjectRecord}):React.JSX.Element {
  const [board,setBoard]=useState<ProjectBacklog|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [query,setQuery]=useState(''),[kind,setKind]=useState<'all'|ProjectTaskKind>('all'),[title,setTitle]=useState(()=>readBacklogDraft(project.id).title),[newKind,setNewKind]=useState<ProjectTaskKind>('task')
  const [newPriority,setNewPriority]=useState<ProjectTaskPriority>('normal')
  const [newWeight,setNewWeight]=useState<ProjectTaskWeight>('medium')
  const [images,setImages]=useState<ContextAttachment[]>(()=>readBacklogDraft(project.id).images)
  const [editing,setEditing]=useState<{id:string;title:string}|null>(()=>readBacklogDraft(project.id).editing),[diffTask,setDiffTask]=useState<ProjectTask|null>(null)
  const [selected,setSelected]=useState<Set<string>>(()=>new Set())
  const [confirmDelete,setConfirmDelete]=useState<string|null>(null)
  const [assignment,setAssignment]=useState<{mode:ProjectTaskAssignmentMode;tasks:ProjectTask[];revision:string}|null>(null)
  const key='conductor.tasks.done.'+project.id
  const [doneOpen,setDoneOpen]=useState(()=>localStorage.getItem(key)==='true')
  const revision=useRef(0),mounted=useRef(false),writing=useRef(false)
  const draft=useRef<BacklogDraft>({title,images,editing})
  draft.current={title,images,editing}
  const keepDraft=(next:Partial<BacklogDraft>):void=> {
    draft.current={...draft.current,...next}
    writeBacklogDraft(project.id,draft.current)
  }
  const draftTitle=(next:string):void=>{setTitle(next);keepDraft({title:next})}
  const draftImages=(next:ContextAttachment[]):void=>{setImages(next);keepDraft({images:next})}
  const draftEditing=(next:{id:string;title:string}|null):void=>{setEditing(next);keepDraft({editing:next})}
  useEffect(()=>{setSelected(new Set());setAssignment(null);setConfirmDelete(null);const saved=readBacklogDraft(project.id);draft.current=saved;setTitle(saved.title);setImages(saved.images);setEditing(saved.editing)},[project.id])
  useEffect(()=>{if(board)setSelected(current=>{const available=new Set(board.tasks.map(task=>task.id));const next=new Set([...current].filter(id=>available.has(id)));return next.size===current.size?current:next})},[board])
  // A task deleted elsewhere must not leave an unreachable edit draft behind.
  useEffect(()=>{if(board && editing && !board.tasks.some(task=>task.id===editing.id))draftEditing(null)},[board,editing])
  useEffect(()=>{if(board && confirmDelete && confirmDelete!=='selection' && !board.tasks.some(task=>task.id===confirmDelete))setConfirmDelete(null)},[board,confirmDelete])
  const refresh=useCallback(async()=> {
    const sequence=++revision.current
    try {const next=await window.conductor.projectTasks.get(project.id);if(mounted.current && sequence===revision.current)setBoard(next)}
    catch(reason){if(mounted.current)setError(String(reason))}
  },[project.id])
  useEffect(()=>{mounted.current=true;void refresh();const timer=setInterval(()=>{if(!writing.current)void refresh()},1500);window.addEventListener('focus',refresh);return()=>{mounted.current=false;revision.current++;clearInterval(timer);window.removeEventListener('focus',refresh)}},[refresh])
  useEffect(()=>window.conductor.files.onChanged(change=>{if(change.projectId===project.id && change.path.replaceAll('\\','/').toLowerCase()==='feature-list.md' && !writing.current)void refresh()}),[project.id,refresh])
  const edit=async(change:ProjectTaskEdit):Promise<boolean>=> {
    if(!board || board.projectId!==project.id || writing.current)return false
    writing.current=true;setBusy(true);setError('');revision.current++
    try {const next=await window.conductor.projectTasks.edit(project.id,board.revision,change);if(mounted.current)setBoard(next);return true}
    catch(reason){if(mounted.current)setError(String(reason));await refresh();return false}
    finally{writing.current=false;if(mounted.current)setBusy(false)}
  }
  const dispatch=async(target:ProjectTaskDispatchTarget,prompt?:string):Promise<ProjectTaskDispatchResult>=> {
    if(!board || board.projectId!==project.id || !assignment || writing.current)throw new Error('The task list is busy. Try again when it finishes saving.')
    writing.current=true;setBusy(true);setError('');revision.current++
    try {
      const result=await window.conductor.projectTasks.dispatch(project.id,assignment.revision,{taskIds:assignment.tasks.map(task=>task.id),target,...(prompt?{prompt}:{})})
      if(mounted.current){setBoard(result.board);const sent=new Set(result.assignments.filter(item=>item.status!=='failed').flatMap(item=>item.taskIds));setSelected(current=>new Set([...current].filter(id=>!sent.has(id))))}
      return result
    } catch(reason){await refresh();throw reason}
    finally{writing.current=false;if(mounted.current)setBusy(false)}
  }
  const removeTasks=async(ids:string[]):Promise<boolean>=> {
    if(!board || board.projectId!==project.id || writing.current || !ids.length)return false
    writing.current=true;setBusy(true);setError('');revision.current++
    let current=board
    try {
      for(const id of ids)current=await window.conductor.projectTasks.edit(project.id,current.revision,{type:'remove',id})
      if(mounted.current)setBoard(current)
      setSelected(existing=>new Set([...existing].filter(id=>!ids.includes(id))))
      return true
    } catch(reason){if(mounted.current)setError(String(reason));await refresh();return false}
    finally{writing.current=false;if(mounted.current)setBusy(false)}
  }
  const scm=board?.sourceControl
  const links=Boolean(scm?.enabled && scm.available)
  const toggleSourceControl=async(enabled:boolean):Promise<void>=> {
    setError('')
    try {await window.conductor.projectTasks.setSourceControl(project.id,enabled);await refresh()}
    catch(reason){setError(String(reason))}
  }
  const openOnGithub=async(task:ProjectTask):Promise<void>=> {
    setError('')
    try {
      const changes=await window.conductor.projectTasks.changes(project.id,task.id)
      if(!changes.compareUrl)throw new Error(changes.note ?? 'This repository has no GitHub remote to link to.')
      await window.conductor.system.openExternal(changes.compareUrl)
    } catch(reason){setError(String(reason))}
  }
  const visible=sortProjectTasks((board?.tasks??[]).filter(task=>(kind==='all'||task.kind===kind) && task.title.toLowerCase().includes(query.toLowerCase())))
  const todo=visible.filter(task=>task.status==='todo'),doing=visible.filter(task=>task.status==='doing'),done=visible.filter(task=>task.status==='done')
  const row=(task:ProjectTask):React.JSX.Element=> {
    const owner=board?.owners.find(owner=>owner.id===task.agentId)
    const Selected=selected.has(task.id)?CircleCheck:Circle
    const Kind=kindIcons[task.kind] ?? Sparkles
    const last=task.activity[0]
    const author=last?taskAuthor(last):''
    const opened=task.activity.length===1 && last?.status==='todo'
    const {text:taskText,images:taskImages}=splitTaskImages(task.title)
    return <article className={'project-task status-'+task.status+(selected.has(task.id)?' is-selected':'')} key={task.id} data-task-id={task.id}>
      <button type="button" role="checkbox" className="project-task-check" aria-label={'Select '+task.title} aria-checked={selected.has(task.id)} title={selected.has(task.id)?'Deselect task':'Select task'} disabled={busy} onClick={()=>setSelected(current=>{const next=new Set(current);if(next.has(task.id))next.delete(task.id);else next.add(task.id);return next})}><Selected size={16}/></button>
      <div className="project-task-body">
        {editing?.id===task.id ? <form onSubmit={event=>{event.preventDefault();if(!editing.title.trim() || busy)return;void edit({type:'update',id:task.id,title:editing.title}).then(saved=>{if(saved)draftEditing(null)})}}><textarea autoFocus aria-label="Edit task" value={editing.title} onChange={event=>draftEditing({id:task.id,title:event.target.value})} onKeyDown={event=>{submitTaskShortcut(event);if(event.key==='Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode!==229)draftEditing(null)}} title="Ctrl+Enter to save; Enter for a new line" maxLength={8000}/><div><button disabled={busy||!editing.title.trim()} type="submit">Save</button><button type="button" onClick={()=>draftEditing(null)}>Cancel</button></div></form> : taskTitleRow(task.status,taskText || (taskImages.length?'Attached image':task.title),()=>draftEditing({id:task.id,title:task.title}))}
        {taskImages.length>0 && <div className="project-task-images">{taskImages.map(image=><PromptImageThumbnail key={image.id} projectId={project.id} attachment={{id:image.id,kind:'image' as const,name:image.name,path:image.path}}/>)}</div>}
        <div className="project-task-meta"><span className={'project-task-kind '+task.kind}><Kind size={11}/> {kindLabels[task.kind]}</span>
          <select aria-label={'Status of '+task.title} disabled={busy} value={task.status} onChange={event=>void edit({type:'update',id:task.id,status:event.target.value as ProjectTask['status']})}><option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option></select>
          <PriorityPicker ariaLabel={'Priority of '+task.title} value={task.priority} disabled={busy} onChange={next=>void edit({type:'update',id:task.id,priority:next})}/>
          <WeightPicker ariaLabel={'Weight of '+task.title} value={task.weight} disabled={busy} onChange={next=>void edit({type:'update',id:task.id,weight:next})}/>
          <button className="project-task-edit" title="Edit task" aria-label={'Edit '+task.title} onClick={()=>draftEditing({id:task.id,title:task.title})}><Pencil size={11}/></button>
          {confirmDelete===task.id ? <span className="project-task-delete-confirm-group">
            <button className="project-task-delete-confirm" title="Confirm delete" aria-label={'Confirm delete '+task.title} disabled={busy} onClick={()=>{setConfirmDelete(null);void removeTasks([task.id])}}><Check size={11}/></button>
            <button className="project-task-delete-cancel" title="Cancel delete" aria-label={'Cancel delete '+task.title} onClick={()=>setConfirmDelete(null)}><X size={11}/></button>
          </span> : <button className="project-task-delete" title="Delete task" aria-label={'Delete '+task.title} disabled={busy} onClick={()=>setConfirmDelete(task.id)}><Trash2 size={11}/></button>}
        </div>
        <div className="project-task-owner"><span className="project-task-owner-label" title={owner?[owner.provider,owner.title,owner.workspace].join(' / '):task.agentId??'Select this task to assign it'}>{owner?[owner.provider,owner.title,owner.workspace].join(' / '):task.agentId?'Previous agent: '+task.agentId:'Unassigned'}</span>
          {owner && <button title={'Open '+owner.title+' in '+owner.workspace} aria-label={'Open assigned agent for '+task.title} onClick={()=>window.dispatchEvent(new CustomEvent('conductor:focus-process',{detail:{id:owner.id,sessionId:owner.sessionId}}))}>{owner.phase.replaceAll('_',' ')} <ChevronRight size={12}/></button>}
        </div>
        {last && <div className="project-task-history">
          <span title={new Date(last.at).toLocaleString()+(last.commit?' · commit '+last.commit.slice(0,8):'')}>{last.actor==='file'?fileVerbs[last.status]+' in feature-list.md':(opened?'Added by ':statusVerbs[last.status]+' ')+author+(last.workspace?' in '+last.workspace:'')} · {taskMoment(last.at)}</span>
          {last.actor==='agent'&&last.agentId&&<button className="project-task-jump" title={'Open the conversation that moved this task'} aria-label={'Open the agent that moved '+task.title} onClick={()=>window.dispatchEvent(new CustomEvent('conductor:focus-process',{detail:{id:last.agentId,sessionId:last.sessionId}}))}><ChevronRight size={11}/></button>}
          {links&&<><button className="project-task-diff" title="See what changed in the repository while this task was open" aria-label={'See changes for '+task.title} onClick={()=>setDiffTask(task)}><GitCompare size={11}/> Diff</button>
          <button className="project-task-github" title="Open these changes on GitHub" aria-label={'Open '+task.title+' changes on GitHub'} disabled={scm?.remote?.host!=='github'} onClick={()=>void openOnGithub(task)}><Github size={11}/></button></>}
        </div>}
      </div>
    </article>
  }
  const shown=[...doing,...todo,...(doneOpen?done:[])]
  const allShownSelected=shown.length>0&&shown.every(task=>selected.has(task.id))
  const selectedTasks=(board?.tasks??[]).filter(task=>selected.has(task.id))
  const openAssignment=(mode:ProjectTaskAssignmentMode):void=>{if(board)setAssignment({mode,tasks:selectedTasks,revision:board.revision})}
  const total=board?.tasks.length??0,completed=board?.tasks.filter(task=>task.status==='done').length??0
  return <section className="project-backlog" aria-label="Project tasks">
    <header><div><ListTodo size={17}/><strong>{project.name}</strong><span>{completed}/{total} done</span></div><progress max={Math.max(1,total)} value={completed} aria-label="Project task completion"/>
      <div className="project-backlog-actions"><button title="Open task file" onClick={()=>openWorkspaceFile(project.id,'feature-list.md','editor')}><FileText size={12}/> feature-list.md</button><button title="Refresh project tasks" aria-label="Refresh project tasks" onClick={()=>void refresh()}><RefreshCw size={13}/></button></div>
      {scm&&<div className="project-backlog-scm">
        <label title="Link task history to this project's git repository"><input type="checkbox" aria-label="Show repository links" checked={scm.enabled} onChange={event=>void toggleSourceControl(event.target.checked)}/> Source control</label>
        {scm.enabled&&scm.available&&<span className="project-scm-branch" title={'HEAD '+(scm.head??'unknown')}><GitBranch size={11}/> {scm.branch??'detached'}</span>}
        {scm.enabled&&scm.available&&scm.remote?.host==='github'&&<button title={'Open '+scm.remote.webUrl} aria-label="Open the repository on GitHub" onClick={()=>void window.conductor.system.openExternal(scm.remote!.webUrl).catch((reason:unknown)=>setError(String(reason)))}><Github size={12}/></button>}
        {scm.enabled&&!scm.available&&<small title={scm.reason}>{scm.reason}</small>}
      </div>}
    </header>
    <form className="project-task-add" onSubmit={event=>{event.preventDefault();if(!title.trim() || busy)return;void edit({type:'add',title:embedTaskImages(title,images),kind:newKind,priority:newPriority,weight:newWeight}).then(saved=>{if(saved){draftTitle('');draftImages([])}})}}>
      {images.length>0 && <div className="sa-context-chips">{images.map(image=><span key={image.id}><span className="project-task-image-chip" title={image.name}><PromptImageThumbnail projectId={project.id} attachment={image}/>{image.name}</span><button type="button" aria-label={'Remove attached image '+image.name} onClick={()=>draftImages(images.filter(item=>item.id!==image.id))}><X size={11}/></button></span>)}</div>}
      <textarea aria-label="New project task" placeholder="Add a task, bug, feature, or idea…" value={title} onChange={event=>draftTitle(event.target.value)} rows={2} maxLength={8000} onKeyDown={submitTaskShortcut} title="Ctrl+Enter to add; Enter for a new line"/>
      <div><span className="project-task-add-controls"><PromptImageUpload projectId={project.id} disabled={busy} onError={setError} onAttach={added=>{if(images.length+added.length>20){setError('A task can have up to 20 attached images. Remove some and attach these again.');return}draftImages([...images,...added])}}/><select aria-label="New task type" value={newKind} onChange={event=>setNewKind(event.target.value as ProjectTaskKind)} onKeyDown={submitTaskShortcut}><option value="task">Task</option><option value="bug">Bug</option><option value="feature">Feature</option><option value="idea">Idea</option></select><PriorityPicker ariaLabel="New task priority" value={newPriority} suffix=" priority" onChange={setNewPriority} onKeyDown={submitTaskShortcut}/><WeightPicker ariaLabel="New task weight" value={newWeight} suffix=" weight" onChange={setNewWeight} onKeyDown={submitTaskShortcut}/></span><button type="submit" disabled={busy||!board||!title.trim()}>Add task</button></div>
    </form>
    <div className="project-task-filters"><label><Search size={13}/><input aria-label="Search project tasks" placeholder="Search tasks" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button title="Clear search" onClick={()=>setQuery('')}><X size={11}/></button>}</label><select aria-label="Task type filter" value={kind} onChange={event=>setKind(event.target.value as typeof kind)}><option value="all">All types</option><option value="task">Tasks</option><option value="bug">Bugs</option><option value="feature">Features</option><option value="idea">Ideas</option></select></div>
    <div className="project-task-selection">
      <div><button type="button" disabled={busy||!shown.length} onClick={()=>setSelected(current=>{const next=new Set(current);for(const task of shown){if(allShownSelected)next.delete(task.id);else next.add(task.id)}return next})}>{allShownSelected?'Deselect visible':'Select visible'}</button>
        <span role="status" aria-live="polite">{selected.size} selected</span>{selected.size>0&&<button type="button" disabled={busy} onClick={()=>setSelected(new Set())}>Clear selection</button>}</div>
      {selected.size>0&&<div className="project-task-selection-actions"><button disabled={busy} onClick={()=>openAssignment('existing')}>Assign to tab</button><button disabled={busy} onClick={()=>openAssignment('new')}>New agent</button><button disabled={busy} onClick={()=>openAssignment('auto')}><Sparkles size={12}/> Auto Fixer</button>
        {confirmDelete==='selection' ? <span className="project-task-delete-confirm-group">
          <button className="project-task-delete-confirm" disabled={busy} title="Confirm delete selected tasks" aria-label="Confirm delete selected tasks" onClick={()=>{const ids=[...selected];setConfirmDelete(null);void removeTasks(ids)}}><Check size={12}/></button>
          <button className="project-task-delete-cancel" title="Cancel delete selected tasks" aria-label="Cancel delete selected tasks" onClick={()=>setConfirmDelete(null)}><X size={12}/></button>
        </span> : <button className="project-task-delete" disabled={busy} title="Delete selected tasks" aria-label="Delete selected tasks" onClick={()=>setConfirmDelete('selection')}><Trash2 size={12}/> Delete</button>}
      </div>}
    </div>
    {error&&<p className="project-task-error" role="alert">{error}</p>}
    <div className="project-task-list">
      {doing.length>0&&<section aria-label="Tasks in progress"><h3><CircleDot size={13}/> In progress <span>{doing.length}</span></h3>{doing.map(row)}</section>}
      <section aria-label="Tasks to do"><h3><Circle size={13}/> To do <span>{todo.length}</span></h3>{todo.map(row)}{!todo.length&&<p className="project-task-empty">{board?'No pending items here.':'Loading tasks…'}</p>}</section>
      <section aria-label="Completed tasks"><button className="project-task-done-heading" aria-expanded={doneOpen} onClick={()=>setDoneOpen(open=>{localStorage.setItem(key,String(!open));return !open})}>{doneOpen?<ChevronDown size={14}/>:<ChevronRight size={14}/>} Done <span>{done.length}</span></button>{doneOpen&&done.map(row)}</section>
    </div>
    <footer>Saved in your project. Agent edits appear automatically.</footer>
    {assignment&&<ProjectTaskAssignment project={project} tasks={assignment.tasks} mode={assignment.mode} onDispatch={dispatch} onClose={()=>setAssignment(null)}/>}
    {diffTask&&<TaskChanges project={project} task={diffTask} onClose={()=>setDiffTask(null)}/>}
  </section>
}
