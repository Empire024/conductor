import { useAnimatedCount } from './use-animated-count'
import { useMemo, useState } from 'react'
import { ChevronDown, Search, Users } from 'lucide-react'
import type { ContextAttachment, FileChange, SessionPhase, TimelineItem } from '../../../shared/structured-agent'
import { AgentDialog, coalescedEditLabel, coalescedEditSummary, groupConversationActivities, isConversationActivity, StructuredActivity, StructuredMarkdown } from './StructuredAgentRenderers'
import { ProviderIcon } from '../components/ProviderIcon'
import { StructuredUsageContent } from './StructuredUsageDetails'
import { distinguishSubagentLabels, liveTokenLabel, subagentColorIndex, subagentCountLabel, subagentModelLabel, subagentStatusLabels, subagentTokenLabel, summarizeSubagents, summarizeWorkingUsage, summarizeContext } from './usage-summary'
import { stripMemoryDirectives } from '../../../shared/memory-directive'
import './StructuredAgentTelemetry.css'
import type { SubagentSummary } from './usage-summary'

export function StructuredLiveTokens({ items }: { items: TimelineItem[] }): React.JSX.Element {
  const summary = useMemo(() => summarizeWorkingUsage(items), [items])
  const user = items.filter(item => item.data.type === 'text' && item.data.role === 'user' && !item.parentId).at(-1)
  const count = useAnimatedCount(summary.tokens?.outputTokens, JSON.stringify([items.at(-1)?.runtimeId, user?.id]))
  const display = { ...summary, tokens: count === undefined ? undefined : { outputTokens: count } }
  const label = liveTokenLabel(display)
  return <span className="sa-live-tokens" title={summary.tokens ? 'Output tokens reported for the current response, including reasoning when reported. Input and cached context are shown separately.' : 'Waiting for the provider to report output tokens for this response.'}>{label ?? <span className="sa-token-pending" role="status" aria-label="Output tokens pending"><i /><i /><i /></span>}</span>
}

interface SubagentDetailContext {
  sessionId: string
  cwd: string
  projectId?: string
  interactive: boolean
  onInspectAttachment?(attachment: ContextAttachment): void
  onOpenFile(path: string, line?: number): void
  onDiff(change: FileChange): void
  onRespond(item: TimelineItem, decision?: string, answers?: Record<string, string[]>): Promise<void>
}
export function StructuredAgentTelemetry({ items, runtimeId, phase, truncated = false, sessionId, cwd, projectId, interactive = true, onInspectAttachment, onOpenFile, onDiff, onRespond }: { items: TimelineItem[]; runtimeId: string; phase: SessionPhase; truncated?: boolean } & Partial<SubagentDetailContext>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const agents = useMemo(() => summarizeSubagents(items, runtimeId, phase, open), [items, runtimeId, phase, open])
  const countLabel = subagentCountLabel(agents)
  if (!agents.length) return <></>
  // Reused by any caller that has not wired real activity context: still countable and
  // expandable, just without the rich per-step detail that needs a live conversation to open.
  const detail: SubagentDetailContext = { sessionId: sessionId ?? '', cwd: cwd ?? '', projectId, interactive, onInspectAttachment, onOpenFile: onOpenFile ?? (() => {}), onDiff: onDiff ?? (() => {}), onRespond: onRespond ?? (async () => {}) }
  return <div className="sa-telemetry">
    <button type="button" className="sa-subagent-summary" aria-label={countLabel} title={countLabel} aria-expanded={open} onClick={() => setOpen(current => !current)}><Users size={12} /><span>{countLabel}</span></button>
    {open && <AgentDialog title="Subagents" onClose={() => setOpen(false)}>
      <SubagentExplorer agents={agents} truncated={truncated} runtimeId={runtimeId} detail={detail} />
    </AgentDialog>}
  </div>
}

/** Usage % and the view-usage entry point live on the composer control line, beside effort/model/mode. */
export function StructuredUsageSummary({ items, runtimeId, truncated = false, modelLabel, agentSessionId, workspaceId }: { items: TimelineItem[]; runtimeId: string; truncated?: boolean; modelLabel?: string; agentSessionId?: string; workspaceId?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const context = useMemo(() => summarizeContext(items, runtimeId), [items, runtimeId])
  return <div className="sa-usage-summary">
    {context && context.percent >= 40 && <button type="button" className={'sa-context-circle level-' + context.level} aria-label={`Context ${Math.floor(context.percent)}% used`} title={`${Math.floor(context.percent)}% context used (${context.used.toLocaleString()} / ${context.capacity.toLocaleString()} tokens). ${context.percent >= 90 ? 'Context nearly full. Use /compact to make room.' : 'View context details.'}`} aria-expanded={open} onClick={() => setOpen(current => !current)}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle className="sa-context-track" cx="12" cy="12" r="9" /><circle className="sa-context-fill" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${context.percent} 100`} transform="rotate(-90 12 12)" /></svg><span>{Math.floor(context.percent)}%</span>
    </button>}
    <button type="button" className="sa-usage-link" aria-expanded={open} onClick={() => setOpen(current => !current)}>View usage</button>
    {open && <AgentDialog title="Usage" onClose={() => setOpen(false)}><StructuredUsageContent items={items} truncated={truncated} modelLabel={modelLabel} agentSessionId={agentSessionId} workspaceId={workspaceId} /></AgentDialog>}
  </div>
}

function activityText(item: TimelineItem): string {
  const data = item.data
  if (data.type === 'text') return data.role === 'assistant' ? stripMemoryDirectives(data.text) : data.text
  if (data.type === 'error') return data.message
  if (data.type === 'tool') return [data.description ?? data.name, data.status.replaceAll('_', ' '), data.output, data.stderr].filter(Boolean).join(' · ')
  if (data.type === 'changes') return data.changes.map(change => `${change.status}: ${change.path}`).join('\n')
  return ''
}
function timeLabel(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not reported'
}
export function SubagentExplorer({ agents, truncated = false, runtimeId, detail }: { agents: SubagentSummary[]; truncated?: boolean; runtimeId: string; detail: SubagentDetailContext }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // The same identity notion the main timeline's "Within X" labels use, so an agent shown
  // here reads as the same colored, disambiguated identity everywhere it appears.
  const labels = useMemo(() => distinguishSubagentLabels(agents), [agents])
  const active = (agent: SubagentSummary): boolean => ['running', 'preparing', 'awaiting_approval'].includes(agent.status)
  const visible = agents.filter(agent => (filter === 'all' || (filter === 'active' ? active(agent) : filter === 'attention' ? ['failed', 'rejected', 'unknown', 'awaiting_approval'].includes(agent.status) : agent.status === 'completed')) && `${agent.name} ${agent.task ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="sa-subagent-details">
    <p className="sa-detail-hint">{subagentCountLabel(agents)}</p>
    {truncated && <p className="sa-detail-hint">Showing subagents reported in the available history.</p>}
    <label className="sa-agent-search"><Search size={14} /><input aria-label="Search subagents" placeholder="Search names and tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="sa-agent-filters" role="group" aria-label="Filter subagents">{[['all', 'All'], ['active', 'Active'], ['attention', 'Needs attention'], ['completed', 'Completed']].map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id!)}>{label}</button>)}</div>
    <div className="sa-agent-list-actions"><span>{visible.length} shown</span><button type="button" onClick={() => setExpanded(new Set(visible.map(agent => agent.id)))}>Expand all</button><button type="button" onClick={() => setExpanded(new Set())}>Collapse all</button></div>
    {!visible.length && <p className="sa-detail-hint" role="status">No subagents match this view.</p>}
    <ul className="sa-subagent-roster">{visible.map(agent => <SubagentCard key={agent.id} agent={agent} label={labels.get(agent.id) ?? agent.name} colorIndex={subagentColorIndex(agent.id)} runtimeId={runtimeId} detail={detail} open={expanded.has(agent.id)} onToggle={() => setExpanded(current => { const next = new Set(current); if (next.has(agent.id)) next.delete(agent.id); else next.add(agent.id); return next })} />)}</ul>
  </div>
}

function SubagentCard({ agent, label, colorIndex, runtimeId, detail, open, onToggle }: { agent: SubagentSummary; label: string; colorIndex: number; runtimeId: string; detail: SubagentDetailContext; open: boolean; onToggle(): void }): React.JSX.Element {
  const [itemExpansion, setItemExpansion] = useState<Record<string, boolean>>({})
  const onExpand = (id: string): void => setItemExpansion(current => ({ ...current, [id]: !current[id] }))
  // Same filtering and grouping the main conversation timeline uses, so a subagent's own
  // steps render as real activity cards (tool calls, diffs, markdown) instead of raw text.
  const activity = useMemo(() => agent.activity.filter(isConversationActivity), [agent.activity])
  const groups = useMemo(() => groupConversationActivities(activity), [activity])
  const output = activity.filter(item => item.data.type === 'text' && item.data.role === 'assistant').at(-1)
  const tools = activity.filter(item => item.data.type === 'tool')
  const modelLabel = subagentModelLabel(agent)
  const tokenLabel = subagentTokenLabel(agent)
  return <li><article className="sa-agent-card">
    <button type="button" className="sa-agent-card-heading" aria-expanded={open} onClick={onToggle}>
      <span className={'sa-subagent-dot status-' + agent.status} />
      <span><strong title={label}><span className={'sa-subagent-identity sa-agent-hue-' + colorIndex} aria-hidden="true" />{label}</strong><small>{agent.detached && <><em className="sa-subagent-detached">Background</em>{' '}</>}{agent.detached ? (agent.output !== undefined ? 'Command output available' : agent.outputFile ? 'Command output file' : 'Background command') : <>{tools.length} {tools.length === 1 ? 'tool' : 'tools'} &middot; {activity.length} activity items</>}</small></span>
      {modelLabel && <span className="sa-subagent-model" title={'Runs on ' + modelLabel}><ProviderIcon provider={agent.modelProvider} model={agent.model} size={11} />{modelLabel}</span>}
      {tokenLabel && <span className="sa-subagent-tokens" title="Tokens reported for this subagent">{tokenLabel}</span>}
      <span className={'sa-subagent-state status-' + agent.status}>{subagentStatusLabels[agent.status]}</span>
      <ChevronDown size={14} className={open ? 'expanded' : ''} />
    </button>
    {agent.linkedProvider && <span className="sa-subagent-link"><ProviderIcon provider={agent.linkedProvider} size={12} />{agent.linkedProvider} command</span>}
    {!open && (agent.task || output) && <p className="sa-agent-preview">{agent.task ?? (output ? activityText(output) : '')}</p>}
    {open && <div className="sa-agent-body">
      <dl><dt>First reported</dt><dd>{timeLabel(agent.startedAt)}</dd><dt>Last activity</dt><dd>{timeLabel(agent.updatedAt)}</dd>{agent.nativeSessionId && <><dt>Session ID</dt><dd><code>{agent.nativeSessionId}</code></dd></>}</dl>
      {agent.status === 'unknown' && <p className="sa-detail-hint">The connection ended or changed before a final status was reported.</p>}
      {agent.task && <section><h4>Assigned task</h4><StructuredMarkdown text={agent.task} cwd={detail.cwd} projectId={detail.projectId} onOpenFile={detail.onOpenFile} /></section>}
      {agent.outputFile && <section><h4>Command output{agent.outputTruncated ? ' (last 32 KB)' : ''}</h4><small>{agent.outputFile}</small>{agent.output !== undefined ? <pre>{agent.output || 'No output written.'}</pre> : <p className="sa-detail-hint">{agent.outputError ?? 'Reading task output…'}</p>}</section>}
      <section><h4>Latest response</h4>{output?.data.type === 'text' ? <StructuredMarkdown text={stripMemoryDirectives(output.data.text)} cwd={detail.cwd} projectId={detail.projectId} onOpenFile={detail.onOpenFile} /> : <p className="sa-detail-hint">No response reported in the available history.</p>}</section>
      <details className="sa-agent-activity"><summary>Activity ({activity.length})</summary>{groups.length ? groups.map(group => {
        const rows = group.map(item => <StructuredActivity key={item.id} item={item} sessionId={detail.sessionId} projectId={detail.projectId} onInspectAttachment={detail.onInspectAttachment} cwd={detail.cwd} expanded={itemExpansion[item.id] ?? false} interactive={detail.interactive && item.runtimeId === runtimeId} onExpand={onExpand} onOpenFile={detail.onOpenFile} onDiff={detail.onDiff} onRespond={detail.onRespond} />)
        if (group.length === 1) return rows[0]
        const coalesced = coalescedEditSummary(group)
        return <details className="sa-completed-group" key={group[0]!.id}><summary>{coalesced ? coalescedEditLabel(coalesced) : `${group.length} completed actions`}</summary><div>{rows}</div></details>
      }) : <p className="sa-detail-hint">No child activity reported yet.</p>}</details>
    </div>}
  </article></li>
}
