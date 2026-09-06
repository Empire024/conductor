import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePlay,
  ClipboardList,
  LoaderCircle,
  PauseCircle,
  Plus,
  Save,
  Trash2,
  Workflow,
  X
} from 'lucide-react'
import type { AgentProviderId } from '../../../shared/models'
import type {
  OrchestrationAgent,
  OrchestrationBridge,
  OrchestrationSnapshot,
  OrchestrationTaskPriority,
  OrchestrationTaskStatus,
  RoutineDefinition,
  SaveRoutineStepInput
} from '../../../shared/orchestration'
import './OrchestrationHub.css'

export type HubView = 'agents' | 'tasks' | 'routines'

interface OrchestrationHubProps {
  projectId: string
  initialView?: HubView
  onClose?(): void
}

interface AgentDraft {
  id?: string
  name: string
  provider: AgentProviderId
  model: string
  role: string
  instructions: string
  status: OrchestrationAgent['status']
}

interface RoutineDraft {
  id?: string
  name: string
  description: string
  enabled: boolean
  steps: SaveRoutineStepInput[]
}

const emptySnapshot: OrchestrationSnapshot = { agents: [], tasks: [], routines: [], runs: [] }
const blankAgent = (): AgentDraft => ({
  name: '', provider: 'codex', model: '', role: '', instructions: '', status: 'active'
})
const blankRoutine = (): RoutineDraft => ({
  name: '', description: '', enabled: true, steps: [{ title: '', instructions: '', assignedAgentId: null }]
})

const bridge = (): OrchestrationBridge => (
  window.conductor as typeof window.conductor & { orchestration: OrchestrationBridge }
).orchestration

const agentName = (agents: OrchestrationAgent[], id: string | null): string =>
  agents.find((agent) => agent.id === id)?.name ?? 'Unassigned'

export function OrchestrationHub({
  projectId,
  initialView = 'tasks',
  onClose
}: OrchestrationHubProps): React.JSX.Element {
  const [view, setView] = useState<HubView>(initialView)
  const [snapshot, setSnapshot] = useState<OrchestrationSnapshot>(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null)
  const [routineDraft, setRoutineDraft] = useState<RoutineDraft | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskAgentId, setTaskAgentId] = useState('')
  const [taskPriority, setTaskPriority] = useState<OrchestrationTaskPriority>('normal')

  const load = useCallback(async (): Promise<void> => {
    try {
      setError('')
      setSnapshot(await bridge().snapshot(projectId))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load orchestration')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    setLoading(true)
    setAgentDraft(null)
    setRoutineDraft(null)
    void load()
  }, [load])

  useEffect(() => setView(initialView), [initialView])

  const mutate = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError('')
    try {
      await action()
      await load()
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The change could not be saved')
      return false
    } finally {
      setBusy(false)
    }
  }

  const activeRuns = useMemo(
    () => snapshot.runs.filter((run) => run.status === 'running').length,
    [snapshot.runs]
  )

  const saveAgent = async (): Promise<void> => {
    if (!agentDraft?.name.trim()) return
    const saved = await mutate(() => bridge().agents.save({
      ...agentDraft,
      projectId,
      model: agentDraft.model || null
    }))
    if (saved) setAgentDraft(null)
  }

  const createTask = async (): Promise<void> => {
    if (!taskTitle.trim()) return
    const saved = await mutate(() => bridge().tasks.create({
      projectId,
      title: taskTitle,
      priority: taskPriority,
      assignedAgentId: taskAgentId || null
    }))
    if (saved) setTaskTitle('')
  }

  const editRoutine = (routine: RoutineDefinition): void => setRoutineDraft({
    id: routine.id,
    name: routine.name,
    description: routine.description,
    enabled: routine.enabled,
    steps: routine.steps.map((step) => ({
      id: step.id,
      title: step.title,
      instructions: step.instructions,
      assignedAgentId: step.assignedAgentId
    }))
  })

  const updateRoutineStep = (index: number, patch: Partial<SaveRoutineStepInput>): void => {
    setRoutineDraft((current) => current
      ? { ...current, steps: current.steps.map((step, position) => position === index ? { ...step, ...patch } : step) }
      : current)
  }

  const moveRoutineStep = (index: number, direction: -1 | 1): void => {
    setRoutineDraft((current) => {
      if (!current) return current
      const target = index + direction
      if (target < 0 || target >= current.steps.length) return current
      const steps = [...current.steps]
      const selected = steps[index]
      const neighbor = steps[target]
      if (!selected || !neighbor) return current
      steps[index] = neighbor
      steps[target] = selected
      return { ...current, steps }
    })
  }

  const saveRoutine = async (): Promise<void> => {
    if (!routineDraft?.name.trim() || routineDraft.steps.some((step) => !step.title.trim())) return
    const saved = await mutate(() => bridge().routines.save({ ...routineDraft, projectId }))
    if (saved) setRoutineDraft(null)
  }

  return (
    <section className="orchestration-hub" aria-label="Agents, tasks, and routines">
      <header className="orchestration-hub-header">
        <div className="orchestration-hub-title">
          <Workflow size={19} />
          <span><strong>Orchestration</strong><small>Persistent team, queue, and playbooks</small></span>
        </div>
        <div className="orchestration-hub-stats">
          <span>{snapshot.agents.filter((agent) => agent.status === 'active').length} agents</span>
          <span>{snapshot.tasks.filter((task) => !['done', 'cancelled'].includes(task.status)).length} open</span>
          {activeRuns > 0 && <span className="running">{activeRuns} running</span>}
          {onClose && <button onClick={onClose} title="Close orchestration"><X size={16} /></button>}
        </div>
      </header>

      <nav className="orchestration-hub-tabs" aria-label="Orchestration sections">
        <button className={view === 'agents' ? 'active' : ''} onClick={() => setView('agents')}><Bot size={15} /> Agents</button>
        <button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}><ClipboardList size={15} /> Tasks</button>
        <button className={view === 'routines' ? 'active' : ''} onClick={() => setView('routines')}><Workflow size={15} /> Routines</button>
      </nav>

      {error && <div className="orchestration-error">{error}<button onClick={() => setError('')}><X size={13} /></button></div>}
      {loading ? (
        <div className="orchestration-loading"><LoaderCircle className="spin" size={20} /> Loading orchestration…</div>
      ) : (
        <div className="orchestration-hub-body">
          {view === 'agents' && (
            <div className="orchestration-section">
              <div className="orchestration-section-heading">
                <span><strong>Agent roster</strong><small>Reusable identities and operating instructions</small></span>
                <button className="orchestration-primary" onClick={() => setAgentDraft(blankAgent())}><Plus size={14} /> Add agent</button>
              </div>
              {agentDraft && (
                <div className="orchestration-editor">
                  <div className="orchestration-editor-heading"><strong>{agentDraft.id ? 'Edit agent' : 'New agent'}</strong><button onClick={() => setAgentDraft(null)}><X size={15} /></button></div>
                  <div className="orchestration-form-grid">
                    <label><span>Name</span><input autoFocus value={agentDraft.name} onChange={(event) => setAgentDraft({ ...agentDraft, name: event.target.value })} placeholder="Release reviewer" /></label>
                    <label><span>Provider</span><select value={agentDraft.provider} onChange={(event) => setAgentDraft({ ...agentDraft, provider: event.target.value as AgentProviderId })}>{['codex', 'claude', 'gemini', 'qwen', 'kimi'].map((provider) => <option key={provider}>{provider}</option>)}</select></label>
                    <label><span>Model (optional)</span><input value={agentDraft.model} onChange={(event) => setAgentDraft({ ...agentDraft, model: event.target.value })} placeholder="Provider default" /></label>
                    <label><span>Status</span><select value={agentDraft.status} onChange={(event) => setAgentDraft({ ...agentDraft, status: event.target.value as OrchestrationAgent['status'] })}><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></select></label>
                    <label className="wide"><span>Role</span><input value={agentDraft.role} onChange={(event) => setAgentDraft({ ...agentDraft, role: event.target.value })} placeholder="Own release readiness and regression review" /></label>
                    <label className="wide"><span>Operating instructions</span><textarea value={agentDraft.instructions} onChange={(event) => setAgentDraft({ ...agentDraft, instructions: event.target.value })} rows={4} placeholder="Durable instructions applied whenever this agent is assigned…" /></label>
                  </div>
                  <div className="orchestration-editor-actions"><button disabled={busy || !agentDraft.name.trim()} className="orchestration-primary" onClick={() => void saveAgent()}><Save size={14} /> Save agent</button></div>
                </div>
              )}
              <div className="orchestration-card-list">
                {snapshot.agents.length === 0 && <Empty icon={<Bot size={22} />} title="No persistent agents" detail="Create a reusable agent identity, then assign it to tasks and routine steps." />}
                {snapshot.agents.map((agent) => (
                  <article className="orchestration-agent-card" key={agent.id}>
                    <div className={`orchestration-avatar ${agent.status}`}><Bot size={17} /></div>
                    <button className="orchestration-card-main" onClick={() => setAgentDraft({ ...agent, model: agent.model ?? '' })}>
                      <strong>{agent.name}</strong>
                      <small>{agent.provider}{agent.model ? ` · ${agent.model}` : ''} · {agent.role || 'General agent'}</small>
                    </button>
                    <span className={`orchestration-status ${agent.status}`}>{agent.status === 'paused' && <PauseCircle size={12} />}{agent.status}</span>
                    <button className="orchestration-danger" title={`Remove ${agent.name}`} onClick={() => void mutate(() => bridge().agents.remove(agent.id))}><Trash2 size={14} /></button>
                  </article>
                ))}
              </div>
            </div>
          )}

          {view === 'tasks' && (
            <div className="orchestration-section">
              <div className="orchestration-section-heading"><span><strong>Task queue</strong><small>Project work independent of any coding pane</small></span></div>
              <div className="orchestration-quick-task">
                <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createTask() }} placeholder="Add a task…" />
                <select value={taskAgentId} onChange={(event) => setTaskAgentId(event.target.value)}><option value="">Unassigned</option>{snapshot.agents.filter((agent) => agent.status !== 'archived').map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
                <select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as OrchestrationTaskPriority)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select>
                <button className="orchestration-primary" disabled={busy || !taskTitle.trim()} onClick={() => void createTask()}><Plus size={14} /> Add</button>
              </div>
              <div className="orchestration-card-list task-list">
                {snapshot.tasks.length === 0 && <Empty icon={<ClipboardList size={22} />} title="Queue is clear" detail="Add a standalone task or start a routine to generate a linear task chain." />}
                {snapshot.tasks.map((task) => (
                  <article className={`orchestration-task-card status-${task.status}`} key={task.id}>
                    <span className={`orchestration-priority ${task.priority}`} title={`${task.priority} priority`} />
                    <div className="orchestration-card-main">
                      <strong>{task.title}</strong>
                      <small>{agentName(snapshot.agents, task.assignedAgentId)}{task.routineId ? ' · routine task' : ''}</small>
                    </div>
                    <select value={task.status} aria-label={`Status for ${task.title}`} onChange={(event) => void mutate(() => bridge().tasks.update(task.id, { status: event.target.value as OrchestrationTaskStatus }))}>
                      <option value="backlog">Backlog</option><option value="ready">Ready</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option><option value="cancelled">Cancelled</option>
                    </select>
                    <button className="orchestration-danger" title={`Remove ${task.title}`} onClick={() => void mutate(() => bridge().tasks.remove(task.id))}><Trash2 size={14} /></button>
                  </article>
                ))}
              </div>
            </div>
          )}

          {view === 'routines' && (
            <div className="orchestration-section">
              <div className="orchestration-section-heading">
                <span><strong>Linear routines</strong><small>Start repeatable work as an ordered, unlocking task chain</small></span>
                <button className="orchestration-primary" onClick={() => setRoutineDraft(blankRoutine())}><Plus size={14} /> New routine</button>
              </div>
              {routineDraft && (
                <div className="orchestration-editor routine-editor">
                  <div className="orchestration-editor-heading"><strong>{routineDraft.id ? 'Edit routine' : 'New routine'}</strong><button onClick={() => setRoutineDraft(null)}><X size={15} /></button></div>
                  <div className="orchestration-form-grid">
                    <label><span>Name</span><input autoFocus value={routineDraft.name} onChange={(event) => setRoutineDraft({ ...routineDraft, name: event.target.value })} placeholder="Prepare a release" /></label>
                    <label className="checkbox"><input type="checkbox" checked={routineDraft.enabled} onChange={(event) => setRoutineDraft({ ...routineDraft, enabled: event.target.checked })} /><span>Available to start</span></label>
                    <label className="wide"><span>Description</span><input value={routineDraft.description} onChange={(event) => setRoutineDraft({ ...routineDraft, description: event.target.value })} placeholder="When and why this playbook is used" /></label>
                  </div>
                  <div className="routine-step-editor">
                    {routineDraft.steps.map((step, index) => (
                      <div className="routine-step-row" key={step.id ?? `new-${index}`}>
                        <span className="routine-step-number">{index + 1}</span>
                        <div><input value={step.title} onChange={(event) => updateRoutineStep(index, { title: event.target.value })} placeholder="Step title" /><textarea rows={2} value={step.instructions ?? ''} onChange={(event) => updateRoutineStep(index, { instructions: event.target.value })} placeholder="What should happen in this step?" /></div>
                        <select value={step.assignedAgentId ?? ''} onChange={(event) => updateRoutineStep(index, { assignedAgentId: event.target.value || null })}><option value="">Unassigned</option>{snapshot.agents.filter((agent) => agent.status !== 'archived').map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>
                        <span className="routine-step-actions"><button disabled={index === 0} onClick={() => moveRoutineStep(index, -1)} title="Move up"><ChevronUp size={13} /></button><button disabled={index === routineDraft.steps.length - 1} onClick={() => moveRoutineStep(index, 1)} title="Move down"><ChevronDown size={13} /></button><button disabled={routineDraft.steps.length === 1} onClick={() => setRoutineDraft({ ...routineDraft, steps: routineDraft.steps.filter((_, position) => position !== index) })} title="Remove step"><Trash2 size={13} /></button></span>
                      </div>
                    ))}
                    <button className="routine-add-step" onClick={() => setRoutineDraft({ ...routineDraft, steps: [...routineDraft.steps, { title: '', instructions: '', assignedAgentId: null }] })}><Plus size={13} /> Add step</button>
                  </div>
                  <div className="orchestration-editor-actions"><button disabled={busy || !routineDraft.name.trim() || routineDraft.steps.some((step) => !step.title.trim())} className="orchestration-primary" onClick={() => void saveRoutine()}><Save size={14} /> Save routine</button></div>
                </div>
              )}
              <div className="orchestration-card-list routine-list">
                {snapshot.routines.length === 0 && <Empty icon={<Workflow size={22} />} title="No routines yet" detail="Capture a repeatable sequence. Starting it creates tasks where each step unlocks the next." />}
                {snapshot.routines.map((routine) => (
                  <article className="orchestration-routine-card" key={routine.id}>
                    <button className="orchestration-card-main" onClick={() => editRoutine(routine)}>
                      <strong>{routine.name}</strong><small>{routine.steps.length} step{routine.steps.length === 1 ? '' : 's'} · {routine.description || 'No description'}</small>
                    </button>
                    <span className={`orchestration-status ${routine.enabled ? 'active' : 'paused'}`}>{routine.enabled ? 'enabled' : 'paused'}</span>
                    <button className="orchestration-run" disabled={busy || !routine.enabled} onClick={() => void mutate(async () => {
                      await bridge().routines.start(routine.id)
                      setView('tasks')
                      window.dispatchEvent(new CustomEvent('conductor:toast', { detail: `Started ${routine.name}` }))
                    })}><CirclePlay size={15} /> Start</button>
                    <button className="orchestration-danger" title={`Remove ${routine.name}`} onClick={() => void mutate(() => bridge().routines.remove(routine.id))}><Trash2 size={14} /></button>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {busy && <div className="orchestration-saving"><LoaderCircle className="spin" size={13} /> Saving</div>}
    </section>
  )
}

function Empty({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }): React.JSX.Element {
  return <div className="orchestration-empty">{icon}<strong>{title}</strong><span>{detail}</span></div>
}
