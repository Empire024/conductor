import { useAnimatedCount } from './use-animated-count'
import { useMemo, useState } from 'react'
import { ChevronDown, Search, Users } from 'lucide-react'
import type { SessionPhase, TimelineItem } from '../../../shared/structured-agent'
import { AgentDialog } from './StructuredAgentRenderers'
import { ProviderIcon } from '../components/ProviderIcon'
import { StructuredUsageContent } from './StructuredUsageDetails'
import { liveTokenLabel, subagentCountLabel, subagentStatusLabels, summarizeSubagents, summarizeWorkingUsage, summarizeContext } from './usage-summary'
import './StructuredAgentTelemetry.css'
import type { SubagentSummary } from './usage-summary'

export function StructuredLiveTokens({ items }: { items: TimelineItem[] }): React.JSX.Element {
  const summary = useMemo(() => summarizeWorkingUsage(items), [items])
  const user = items.filter(item => item.data.type === 'text' && item.data.role === 'user' && !item.parentId).at(-1)
  const count = useAnimatedCount(summary.tokens?.outputTokens, JSON.stringify([items.at(-1)?.runtimeId, user?.id]))
  const display = { ...summary, tokens: count === undefined ? undefined : { outputTokens: count } }
  return <span className="sa-live-tokens" title={summary.tokens ? 'Output tokens reported for the current response, including reasoning when reported. Input and cached context are shown separately.' : 'Waiting for the provider to report output tokens for this response.'}>{liveTokenLabel(display)}</span>
}

export function StructuredAgentTelemetry({ items, runtimeId, phase, truncated = false, modelLabel }: { items: TimelineItem[]; runtimeId: string; phase: SessionPhase; truncated?: boolean; modelLabel?: string }): React.JSX.Element {
  const [panel, setPanel] = useState<'usage' | 'agents' | null>(null)
  const agents = useMemo(() => summarizeSubagents(items, runtimeId, phase, panel === 'agents'), [items, runtimeId, phase, panel])
  const countLabel = subagentCountLabel(agents)
  const context = useMemo(() => summarizeContext(items, runtimeId), [items, runtimeId])
  return <div className="sa-telemetry">
    {agents.length > 0 && <button type="button" className="sa-subagent-summary" aria-label={countLabel} title={countLabel} aria-expanded={panel === 'agents'} onClick={() => setPanel(current => current === 'agents' ? null : 'agents')}><Users size={12} /><span>{countLabel}</span></button>}
    {context && context.percent >= 40 && <button type="button" className={'sa-context-circle level-' + context.level} aria-label={`Context ${Math.floor(context.percent)}% used`} title={`${Math.floor(context.percent)}% context used (${context.used.toLocaleString()} / ${context.capacity.toLocaleString()} tokens). ${context.percent >= 90 ? 'Context nearly full. Use /compact to make room.' : 'View context details.'}`} aria-expanded={panel === 'usage'} onClick={() => setPanel(current => current === 'usage' ? null : 'usage')}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle className="sa-context-track" cx="12" cy="12" r="9" /><circle className="sa-context-fill" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${context.percent} 100`} transform="rotate(-90 12 12)" /></svg><span>{Math.floor(context.percent)}%</span>
    </button>}
    <button type="button" className="sa-usage-link" aria-expanded={panel === 'usage'} onClick={() => setPanel(current => current === 'usage' ? null : 'usage')}>View usage</button>
    {panel === 'usage' && <AgentDialog title="Usage" onClose={() => setPanel(null)}><StructuredUsageContent items={items} truncated={truncated} modelLabel={modelLabel} /></AgentDialog>}
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
          <span className={'sa-subagent-dot status-' + agent.status} /><span><strong>{agent.name}</strong><small>{agent.detached && <em className="sa-subagent-detached">Background</em>}{agent.detached ? (agent.output !== undefined ? 'Command output available' : agent.outputFile ? 'Command output file' : 'Background command') : <>{tools.length} {tools.length === 1 ? 'tool' : 'tools'} &middot; {agent.activity.length} activity items</>}</small></span><span className={'sa-subagent-state status-' + agent.status}>{subagentStatusLabels[agent.status]}</span><ChevronDown size={14} className={open ? 'expanded' : ''} />
        </button>
        {agent.linkedProvider && <span className="sa-subagent-link"><ProviderIcon provider={agent.linkedProvider} size={12} />{agent.linkedProvider} command</span>}
        {!open && (agent.task || output) && <p className="sa-agent-preview">{agent.task ?? (output ? activityText(output) : '')}</p>}
        {open && <div className="sa-agent-body">
          <dl><dt>First reported</dt><dd>{timeLabel(agent.startedAt)}</dd><dt>Last activity</dt><dd>{timeLabel(agent.updatedAt)}</dd>{agent.nativeSessionId && <><dt>Session ID</dt><dd><code>{agent.nativeSessionId}</code></dd></>}</dl>
          {agent.status === 'unknown' && <p className="sa-detail-hint">The connection ended or changed before a final status was reported.</p>}
          {agent.task && <section><h4>Assigned task</h4><pre>{agent.task}</pre></section>}
          {agent.outputFile && <section><h4>Command output{agent.outputTruncated ? ' (last 32 KB)' : ''}</h4><small>{agent.outputFile}</small>{agent.output !== undefined ? <pre>{agent.output || 'No output written.'}</pre> : <p className="sa-detail-hint">{agent.outputError ?? 'Reading task output?'}</p>}</section>}
          <section><h4>Latest response</h4>{output ? <pre>{activityText(output)}</pre> : <p className="sa-detail-hint">No response reported in the available history.</p>}</section>
          <details className="sa-agent-activity"><summary>Activity ({agent.activity.length})</summary>{agent.activity.length ? agent.activity.map(item => <div key={item.id}><small>{timeLabel(item.timestamp)} &middot; {item.data.type}</small><pre>{activityText(item)}</pre></div>) : <p className="sa-detail-hint">No child activity reported yet.</p>}</details>
        </div>}
      </article></li>
    })}</ul>
  </div>
}
