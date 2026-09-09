import { processModelLabel } from '../agent-models'
import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, CircleDot, Clock3, Gauge, RefreshCw, TerminalSquare, UserRound } from 'lucide-react'
import type { AgentProviderInfo, ProjectRecord, RuntimeProcessSummary } from '../../../shared/models'
import type { AgentCollaborationSnapshot } from '../../../shared/agent-collaboration'

const relativeTime = (timestamp: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  return `${Math.round(seconds / 3600)}h ago`
}

export function ProcessDashboardPane({ project }: { project: ProjectRecord }): React.JSX.Element {
  const [processes, setProcesses] = useState<RuntimeProcessSummary[]>([])
  const [collaboration, setCollaboration] = useState<AgentCollaborationSnapshot>({ messages: [], presence: [] })
  const [providers, setProviders] = useState<AgentProviderInfo[]>([])
  const [reportedModels, setReportedModels] = useState<Map<string, string>>(new Map())
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let active = true
    void window.conductor.agents.listProviders().then((items) => { if (active) setProviders(items) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    const load = (): void => {
      void Promise.all([
        window.conductor.agents.listProcesses(project.id),
        window.conductor.collaboration.snapshot({ projectId: project.id, limit: 30 })
      ]).then(([items, snapshot]) => {
        if (!active) return
        setProcesses(items)
        setCollaboration(snapshot)
        // The persisted process row only ever knows the model it was configured with (often
        // 'default'); the model a running turn actually resolved to lives in its own session.
        void Promise.all(items.filter((item) => item.kind === 'agent').map((item) =>
          window.conductor.structured.snapshot(item.id)
            .then((snapshot) => [item.id, snapshot?.settings.model] as const)
            .catch(() => [item.id, undefined] as const)
        )).then((entries) => {
          if (!active) return
          setReportedModels(new Map(entries.filter((entry): entry is [string, string] => Boolean(entry[1]))))
        })
      })
    }
    load()
    const timer = window.setInterval(() => { load(); setTick((value) => value + 1) }, 1200)
    return () => { active = false; window.clearInterval(timer) }
  }, [project.id])

  const sections = useMemo(() => ({
    input: processes.filter((process) => process.needsInput),
    running: processes.filter((process) => (process.status === 'starting' || process.activityPhase === 'working') && !process.needsInput),
    ready: processes.filter((process) => process.status === 'running' && process.activityPhase !== 'working' && !process.needsInput),
    waiting: processes.filter((process) => process.status === 'limited' && !process.needsInput),
    finished: processes.filter((process) => ['complete', 'exited', 'error', 'unavailable'].includes(process.status))
  }), [processes, tick])

  return (
    <div className="process-dashboard">
      <header><div><Gauge size={22} /><span><strong>Process dashboard</strong><small>Live runtimes across this project</small></span></div><span className="dashboard-live"><i /> live</span></header>
      <div className="process-summary">
        <span><b>{sections.running.length}</b> moving</span>
        <span><b>{sections.ready.length}</b> ready</span>
        <span className={sections.input.length ? 'attention' : ''}><b>{sections.input.length}</b> need you</span>
        <span><b>{sections.waiting.length}</b> waiting</span>
        <span><b>{sections.finished.length}</b> finished</span>
      </div>
      {collaboration.presence.length > 0 && (
        <section className="coworker-presence">
          <header><Bot size={14} /><strong>Files in motion</strong><span>shared project-wide</span></header>
          <div>
            {collaboration.presence.slice(0, 8).map((presence) => {
              const process = processes.find((item) => item.id === presence.agentSessionId)
              return <article key={presence.id} className={presence.state} title={presence.detail}>
                <span className={`presence-intent ${presence.intent}`}>{presence.intent}</span>
                <strong>{presence.path}</strong>
                <small>{process?.title ?? presence.agentSessionId}</small>
              </article>
            })}
          </div>
        </section>
      )}
      <div className="process-sections">
        {(['input', 'running', 'ready', 'waiting', 'finished'] as const).map((section) => (
          <section key={section}>
            <h3>{section === 'input' ? <UserRound size={15} /> : section === 'running' ? <RefreshCw className={sections.running.length > 0 ? 'spin' : ''} size={15} /> : section === 'ready' ? <CircleDot size={15} /> : section === 'waiting' ? <Clock3 size={15} /> : <Check size={15} />}{section === 'input' ? 'Needs input' : section === 'running' ? 'In progress' : section === 'ready' ? 'Ready' : section === 'waiting' ? 'Waiting for limit' : 'Finished'}<span>{sections[section].length}</span></h3>
            {sections[section].length === 0 && <div className="process-empty">Nothing here right now.</div>}
            {sections[section].map((process) => {
              const Icon = process.kind === 'agent' ? Bot : TerminalSquare
              const eta = process.resumeAt ? Math.max(0, Date.parse(process.resumeAt) - Date.now()) : 0
              return (
                <article
                  key={process.id}
                  title="Double-click to focus this runtime"
                  onDoubleClick={() => window.dispatchEvent(new CustomEvent('conductor:focus-process', { detail: process }))}
                >
                  <span className={`process-icon ${process.status}`}><Icon size={17} /></span>
                  <div><strong>{process.title}</strong><small>{process.provider ? `${process.provider} · ${processModelLabel(process, providers, reportedModels)}` : 'PowerShell'} · {relativeTime(process.updatedAt)}</small>
                    {section === 'running' && <div className="process-progress"><i /></div>}
                  </div>
                  <span className={`process-status ${process.status}`}>{process.status === 'limited' && process.resumeAt ? <><Clock3 size={12} /> {Math.ceil(eta / 60000)}m</> : section === 'ready' ? 'ready' : process.status.replace('_', ' ')}</span>
                </article>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
