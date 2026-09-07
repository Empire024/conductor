import { useMemo, useState } from 'react'
import { ChevronDown, Search, Users } from 'lucide-react'
import type { SessionPhase, TimelineItem } from '../../../shared/structured-agent'
import { AgentDialog } from './StructuredAgentRenderers'
import { StructuredUsageContent } from './StructuredUsageDetails'
import { liveTokenLabel, subagentCountLabel, subagentStatusLabels, summarizeSubagents, summarizeUsage } from './usage-summary'
import './StructuredAgentTelemetry.css'
import type { SubagentSummary } from './usage-summary'

export function StructuredLiveTokens({ items }: { items: TimelineItem[] }): React.JSX.Element {
  const summary = useMemo(() => summarizeUsage(items), [items])
  return <span className="sa-live-tokens" title={summary.tokens ? 'Available conversation token usage. Updates with provider reports; reasoning tokens are included when reported.' : 'Waiting for the provider to report token usage.'}>{liveTokenLabel(summary)}</span>
}

export function StructuredAgentTelemetry({ items, runtimeId, phase, truncated = false }: { items: TimelineItem[]; runtimeId: string; phase: SessionPhase; truncated?: boolean }): React.JSX.Element {
  const [panel, setPanel] = useState<'usage' | 'agents' | null>(null)
  const agents = useMemo(() => summarizeSubagents(items, runtimeId, phase, panel === 'agents'), [items, runtimeId, phase, panel])
  const countLabel = subagentCountLabel(agents)
  return <div className="sa-telemetry">
    {agents.length > 0 && <button type="button" className="sa-subagent-summary" aria-label={countLabel} title={countLabel} aria-expanded={panel === 'agents'} onClick={() => setPanel(current => current === 'agents' ? null : 'agents')}><Users size={12} /><span>{countLabel}</span></button>}
    <button type="button" className="sa-usage-link" aria-expanded={panel === 'usage'} onClick={() => setPanel(current => current === 'usage' ? null : 'usage')}>View usage</button>
    {panel === 'usage' && <AgentDialog title="Usage" onClose={() => setPanel(null)}><StructuredUsageContent items={items} truncated={truncated} /></AgentDialog>}
    {panel === 'agents' && <AgentDialog title="Subagents" onClose={() => setPanel(null)}>
      <SubagentExplorer agents={agents} truncated={truncated} />
    </AgentDialog>}
  </div>
}


function activityText(item: TimelineItem): string {
  const data = item.data
  if (data.type === 'text') return data.text
  if (data.type === 'error') return data.message
  if (data.type === 'tool') return [data.description ?? data.name, data.status.replaceAll('_', ' '), data.output, data.stderr].filter(Boolean).join(' \u00b7 ')
  if (data.type === 'changes') return data.changes.map(change => `${change.status}: ${change.path}`).join('\n')
  return ''
}
function timeLabel(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not reported'
}
export function SubagentExplorer({ agents, truncated = false }: { agents: SubagentSummary[]; truncated?: boolean }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const active = (agent: SubagentSummary): boolean => ['running', 'preparing', 'awaiting_approval'].includes(agent.status)
  const visible = agents.filter(agent => (filter === 'all' || (filter === 'active' ? active(agent) : filter === 'attention' ? ['failed', 'rejected', 'unknown', 'awaiting_approval'].includes(agent.status) : agent.status === 'completed')) && `${agent.name} ${agent.task ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="sa-subagent-details">
    <p className="sa-detail-hint">{subagentCountLabel(agents)}</p>
    {truncated && <p className="sa-detail-hint">Showing subagents reported in the available history.</p>}
    <label className="sa-agent-search"><Search size={14} /><input aria-label="Search subagents" placeholder="Search names and tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="sa-agent-filters" role="group" aria-label="Filter subagents">{[['all', 'All'], ['active', 'Active'], ['attention', 'Needs attention'], ['completed', 'Completed']].map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id!)}>{label}</button>)}</div>
    <div className="sa-agent-list-actions"><span>{visible.length} shown</span><button type="button" onClick={() => setExpanded(new Set(visible.map(agent => agent.id)))}>Expand all</button><button type="button" onClick={() => setExpanded(new Set())}>Collapse all</button></div>
    {!visible.length && <p className="sa-detail-hint" role="status">No subagents match this view.</p>}
    <ul className="sa-subagent-roster">{visible.map(agent => {
      const open = expanded.has(agent.id)
      const output = agent.activity.filter(item => item.data.type === 'text' && item.data.role === 'assistant').at(-1)
      const tools = agent.activity.filter(item => item.data.type === 'tool')
      return <li key={agent.id}><article className="sa-agent-card">
        <button type="button" className="sa-agent-card-heading" aria-expanded={open} onClick={() => setExpanded(current => { const next = new Set(current); if (open) next.delete(agent.id); else next.add(agent.id); return next })}>
          <span className={'sa-subagent-dot status-' + agent.status} /><span><strong>{agent.name}</strong><small>{tools.length} {tools.length === 1 ? 'tool' : 'tools'} &middot; {agent.activity.length} activity items</small></span><span className={'sa-subagent-state status-' + agent.status}>{subagentStatusLabels[agent.status]}</span><ChevronDown size={14} className={open ? 'expanded' : ''} />
        </button>
        {!open && (agent.task || output) && <p className="sa-agent-preview">{agent.task ?? (output ? activityText(output) : '')}</p>}
        {open && <div className="sa-agent-body">
          <dl><dt>First reported</dt><dd>{timeLabel(agent.startedAt)}</dd><dt>Last activity</dt><dd>{timeLabel(agent.updatedAt)}</dd>{agent.nativeSessionId && <><dt>Session ID</dt><dd><code>{agent.nativeSessionId}</code></dd></>}</dl>
          {agent.status === 'unknown' && <p className="sa-detail-hint">The connection ended or changed before a final status was reported.</p>}
          {agent.task && <section><h4>Assigned task</h4><pre>{agent.task}</pre></section>}
          <section><h4>Latest response</h4>{output ? <pre>{activityText(output)}</pre> : <p className="sa-detail-hint">No response reported in the available history.</p>}</section>
          <details className="sa-agent-activity"><summary>Activity ({agent.activity.length})</summary>{agent.activity.length ? agent.activity.map(item => <div key={item.id}><small>{timeLabel(item.timestamp)} &middot; {item.data.type}</small><pre>{activityText(item)}</pre></div>) : <p className="sa-detail-hint">No child activity reported yet.</p>}</details>
        </div>}
      </article></li>
    })}</ul>
  </div>
}
