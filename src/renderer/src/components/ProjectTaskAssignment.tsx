import { useEffect, useState } from 'react'
import type { ProjectRecord } from '../../../shared/models'
import { heaviestProjectTaskWeight, projectTaskWeightDefaults } from '../../../shared/project-backlog'
import type { ProjectTask, ProjectTaskDispatchOptions, ProjectTaskDispatchResult, ProjectTaskDispatchTarget } from '../../../shared/project-backlog'
import { AgentDialog } from '../panes/StructuredAgentRenderers'
import { assignmentStatus } from './project-task-assignment-status'

export type ProjectTaskAssignmentMode = 'existing' | 'new' | 'auto'
const permissionLabels: Record<string, string> = { default: 'Ask', auto: 'Auto', 'accept-edits': 'Edit', 'read-only': 'Read only' }

export function ProjectTaskAssignment({ project, tasks, mode, onDispatch, onClose }: {
  project: ProjectRecord
  tasks: ProjectTask[]
  mode: ProjectTaskAssignmentMode
  onDispatch(target: ProjectTaskDispatchTarget, prompt?: string): Promise<ProjectTaskDispatchResult>
  onClose(): void
}): React.JSX.Element {
  const [options, setOptions] = useState<ProjectTaskDispatchOptions | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [workspace, setWorkspace] = useState(''), [agent, setAgent] = useState('')
  const [provider, setProvider] = useState<'codex' | 'claude'>('codex')
  const [model, setModel] = useState(''), [effort, setEffort] = useState(''), [permission, setPermission] = useState('')
  const [prompt, setPrompt] = useState('')
  const [result, setResult] = useState<ProjectTaskDispatchResult | null>(null)
  const [delivered, setDelivered] = useState<string[]>([])
  const title = mode === 'existing' ? 'Assign to an open tab' : mode === 'new' ? 'Assign to a new agent' : 'Auto Fixer'
  const catalog = options?.providers.find(item => item.provider === provider)
  const chosenModel = catalog?.models.find(item => item.id === model)
  const chosenAgent = options?.targets.find(item => item.agentSessionId === agent)
  // The heaviest selected task wins, so a mixed batch is never under-provisioned; this is
  // only ever a starting suggestion the owner can still override below.
  const suggestedWeight = heaviestProjectTaskWeight(tasks.map(task => task.weight))

  useEffect(() => {
    let active = true
    window.conductor.projectTasks.dispatchOptions(project.id).then(next => {
      if (!active) return
      setOptions(next)
      setWorkspace(next.workspaces[0]?.id ?? '')
      setAgent(next.targets[0]?.agentSessionId ?? '')
      const available = next.providers.find(item => item.available && item.models.length > 0)
      if (available) {
        setProvider(available.provider)
        const suggestion = projectTaskWeightDefaults[available.provider][suggestedWeight]
        const preferred = available.models.find(item => item.id === suggestion.model)
        const initial = preferred ?? available.models.find(item => item.isDefault) ?? available.models[0]!
        setModel(initial.id)
        setEffort(preferred && initial.effort?.includes(suggestion.effort) ? suggestion.effort : initial.effort?.includes(initial.defaultEffort ?? '') ? initial.defaultEffort! : initial.effort?.[0] ?? '')
        setPermission(available.permissions.includes('default') ? 'default' : available.permissions[0] ?? '')
      }
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [project.id, suggestedWeight])

  const chooseProvider = (value: 'codex' | 'claude'): void => {
    setProvider(value)
    const next = options?.providers.find(item => item.provider === value)
    const suggestion = projectTaskWeightDefaults[value][suggestedWeight]
    const preferred = next?.models.find(item => item.id === suggestion.model)
    const initial = preferred ?? next?.models.find(item => item.isDefault) ?? next?.models[0]
    setModel(initial?.id ?? '')
    setEffort(preferred && initial?.effort?.includes(suggestion.effort) ? suggestion.effort : initial?.effort?.includes(initial.defaultEffort ?? '') ? initial.defaultEffort! : initial?.effort?.[0] ?? '')
    setPermission(next?.permissions.includes('default') ? 'default' : next?.permissions[0] ?? '')
  }
  const chooseModel = (value: string): void => {
    setModel(value)
    const next = catalog?.models.find(item => item.id === value)
    setEffort(next?.effort?.includes(next.defaultEffort ?? '') ? next.defaultEffort! : next?.effort?.[0] ?? '')
  }
  const hasCompleted = tasks.some(task => task.status === 'done')
  const valid = Boolean(options && tasks.length > 0 && tasks.length <= 50 && !hasCompleted && (mode === 'existing'
    ? chosenAgent
    : workspace && (mode === 'auto'
      ? options.providers.some(item => item.available && item.models.length > 0)
      : catalog?.available && chosenModel && (!chosenModel.effort?.length || chosenModel.effort.includes(effort)))))
  const submit = async (): Promise<void> => {
    if (!valid || busy || submitted) return
    setBusy(true); setSubmitted(true); setError('')
    const target: ProjectTaskDispatchTarget = mode === 'existing' ? { type: 'existing', agentSessionId: agent }
      : mode === 'auto' ? { type: 'auto', sessionId: workspace }
        : { type: 'new', sessionId: workspace, provider, model, ...(chosenModel?.effort?.length ? { effort } : {}), ...(permission ? { permission } : {}) }
    try { setDelivered([]); setResult(await onDispatch(target, prompt.trim() || undefined)) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  // A queued prompt leaves nothing visible here until the busy tab drains it, so watch that tab
  // and say so, rather than leaving the owner staring at a status that never changes.
  useEffect(() => {
    const pending = (result?.assignments ?? []).filter(item => item.status === 'queued').map(item => item.agentSessionId)
    if (!pending.length) return
    let disposed = false
    const check = (): void => {
      for (const id of pending) void window.conductor.structured.snapshot(id).then(snapshot => {
        if (disposed || !snapshot) return
        const queued = snapshot.queuedPrompts ?? (snapshot.queued ? [snapshot.queued] : [])
        if (!queued.length) setDelivered(current => current.includes(id) ? current : [...current, id])
      }).catch(() => { /* the tab may close before its queue drains */ })
    }
    check()
    const off = window.conductor.structured.onEvents(events => { if (events.some(event => pending.includes(event.sessionId))) check() })
    return () => { disposed = true; off() }
  }, [result])
  const focus = async (assignment: ProjectTaskDispatchResult['assignments'][number]): Promise<void> => {
    try { await window.conductor.agentControl.focusTab(project.id, assignment.sessionId, assignment.tabId); onClose() }
    catch (reason) { setError(String(reason)) }
  }

  return <AgentDialog title={title} onClose={() => { if (!busy) onClose() }}>
    <form className="project-task-assignment" onSubmit={event => { event.preventDefault(); void submit() }}>
      <p>{tasks.length} task{tasks.length === 1 ? '' : 's'} selected</p>
      <ul className="project-task-assignment-preview">{tasks.map(task => <li key={task.id}>{task.title}</li>)}</ul>
      {!options && !error && <p role="status">Loading open tabs and models...</p>}
      {options && !result && <>
        {mode === 'existing' ? <>
          <label>Open agent tab<select aria-label="Open agent tab" value={agent} disabled={busy || !options.targets.length} onChange={event => setAgent(event.target.value)}>
            {!options.targets.length && <option value="">No open agent tabs</option>}
            {options.targets.map(item => <option key={item.agentSessionId} value={item.agentSessionId}>{item.title} ({item.provider}, {options.workspaces.find(space => space.id === item.sessionId)?.name ?? item.sessionId})</option>)}
          </select></label>
          <p className="project-task-assignment-note">The selected tasks go to this conversation together. If it is busy, they wait in its queue.</p>
        </> : <>
          <label>Workspace<select aria-label="Assignment workspace" value={workspace} disabled={busy || !options.workspaces.length} onChange={event => setWorkspace(event.target.value)}>
            {!options.workspaces.length && <option value="">No workspace available</option>}
            {options.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          {mode === 'new' ? <>
            <label>Provider<select aria-label="Task agent provider" value={provider} disabled={busy} onChange={event => chooseProvider(event.target.value as 'codex' | 'claude')}>
              {options.providers.map(item => <option key={item.provider} value={item.provider} disabled={!item.available || !item.models.length}>{item.provider === 'codex' ? 'Codex' : 'Claude'}{!item.available ? ' (unavailable)' : ''}</option>)}
            </select></label>
            <label>Model<select aria-label="Task agent model" value={model} disabled={busy || !catalog?.models.length} onChange={event => chooseModel(event.target.value)}>
              {!catalog?.models.length && <option value="">No models available</option>}
              {catalog?.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label>
            {Boolean(chosenModel?.effort?.length) && <label>Reasoning effort<select aria-label="Task agent reasoning effort" value={effort} disabled={busy} onChange={event => setEffort(event.target.value)}>
              {chosenModel?.effort?.map(value => <option key={value} value={value}>{value}</option>)}
            </select></label>}
            {Boolean(catalog?.permissions.length) && <label>Permission mode<select aria-label="Task agent permission mode" value={permission} disabled={busy} onChange={event => setPermission(event.target.value)}>
              {catalog?.permissions.map(value => <option key={value} value={value}>{permissionLabels[value] ?? value}</option>)}
            </select></label>}
            <p className="project-task-assignment-note">Defaults follow the {suggestedWeight} weight of the selected tasks; pick a different model, effort, or permission mode to override.</p>
            <p className="project-task-assignment-note">A new agent tab receives the selected tasks together with these settings.</p>
          </> : <p className="project-task-assignment-note">Auto Fixer chooses a model and reasoning effort for each task, opens agents to work on them, and reviews their results.</p>}
          {!options.providers.some(item => item.available && item.models.length > 0) && <p role="status">Connect a native agent provider to assign tasks.</p>}
        </>}
      </>}
      {options && !result && <label>Extra instructions (optional)<textarea aria-label="Extra instructions for this assignment" value={prompt} disabled={busy} maxLength={4000} rows={2} onChange={event => setPrompt(event.target.value)} placeholder="Add anything specific you want the agent to know"/></label>}
      {tasks.length > 50 && <p className="project-task-error" role="alert">Select up to 50 tasks at a time.</p>}
      {hasCompleted && <p className="project-task-error" role="alert">Reopen completed tasks before assigning them.</p>}
      {result && <div className="project-task-assignment-results" role="status">{result.assignments.map((assignment, index) => <div key={assignment.agentSessionId + index}>
        <span>{assignmentStatus(assignment, delivered.includes(assignment.agentSessionId))}</span>
        {assignment.tabId && <button type="button" onClick={() => void focus(assignment)}>Open tab</button>}
      </div>)}</div>}
      {error && <p className="project-task-error" role="alert">{error}</p>}
      {error && submitted && <p className="project-task-assignment-note">Close this dialog to review the selected tasks and the destination tab before assigning again.</p>}
      <div className="project-task-assignment-actions"><button type="button" disabled={busy} onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && <button className="project-task-assignment-submit" type="submit" disabled={!valid || busy || submitted}>{busy ? 'Assigning...' : mode === 'existing' ? 'Assign tasks' : mode === 'new' ? 'Start agent' : 'Start Auto Fixer'}</button>}
      </div>
    </form>
  </AgentDialog>
}
