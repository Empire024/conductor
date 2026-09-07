import { useMemo, useState } from 'react'
import { Users } from 'lucide-react'
import type { SessionPhase, TimelineItem } from '../../../shared/structured-agent'
import { AgentDialog } from './StructuredAgentRenderers'
import { StructuredUsageContent } from './StructuredUsageDetails'
import { liveTokenLabel, subagentCountLabel, subagentStatusLabels, summarizeSubagents, summarizeUsage } from './usage-summary'
import './StructuredAgentTelemetry.css'

export function StructuredLiveTokens({ items }: { items: TimelineItem[] }): React.JSX.Element {
  const summary = useMemo(() => summarizeUsage(items), [items])
  return <span className="sa-live-tokens" title={summary.tokens ? 'Available conversation token usage. Updates with provider reports; reasoning tokens are included when reported.' : 'Waiting for the provider to report token usage.'}>{liveTokenLabel(summary)}</span>
}

export function StructuredAgentTelemetry({ items, runtimeId, phase, truncated = false }: { items: TimelineItem[]; runtimeId: string; phase: SessionPhase; truncated?: boolean }): React.JSX.Element {
  const [panel, setPanel] = useState<'usage' | 'agents' | null>(null)
  const agents = useMemo(() => summarizeSubagents(items, runtimeId, phase), [items, runtimeId, phase])
  const countLabel = subagentCountLabel(agents)
  return <div className="sa-telemetry">
    {agents.length > 0 && <button type="button" className="sa-subagent-summary" aria-label={countLabel} title={countLabel} aria-expanded={panel === 'agents'} onClick={() => setPanel(current => current === 'agents' ? null : 'agents')}><Users size={12} /><span>{countLabel}</span></button>}
    <button type="button" className="sa-usage-link" aria-expanded={panel === 'usage'} onClick={() => setPanel(current => current === 'usage' ? null : 'usage')}>View usage</button>
    {panel === 'usage' && <AgentDialog title="Usage" onClose={() => setPanel(null)}><StructuredUsageContent items={items} truncated={truncated} /></AgentDialog>}
    {panel === 'agents' && <AgentDialog title="Subagents" onClose={() => setPanel(null)}>
      <div className="sa-subagent-details">
        <p className="sa-detail-hint">{countLabel}</p>
        {truncated && <p className="sa-detail-hint">Showing subagents reported in the available history.</p>}
        <ul className="sa-subagent-roster">{agents.map(agent => <li key={agent.id}><span className={'sa-subagent-dot status-' + agent.status} /><div><strong>{agent.name}</strong></div><span className={'sa-subagent-state status-' + agent.status}>{subagentStatusLabels[agent.status]}</span></li>)}</ul>
      </div>
    </AgentDialog>}
  </div>
}
