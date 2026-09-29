import type { Finding } from '../../../../shared/production'
import { sortFindings } from './production-model'

const SEVERITY_TONE: Record<Finding['severity'], string> = { critical: 'bad', high: 'bad', medium: 'warn', low: 'quiet', info: 'quiet' }
const STATUS_TONE: Record<Finding['status'], string> = { open: 'bad', reopened: 'bad', disputed: 'warn', waived: 'quiet', fixed: 'good' }

/** Findings of the chosen environment, open ones first; the checkboxes select what Re-test, Verify and Create fix tasks act on. */
export function FindingList({ findings, selected, openId, onToggle, onOpen }: {
  findings: Finding[]
  selected: ReadonlySet<string>
  openId: string | null
  onToggle(findingId: string): void
  onOpen(findingId: string | null): void
}): React.JSX.Element {
  if (!findings.length) return <p className="production-muted">No findings for this environment.</p>
  return <ul className="production-findings">
    {sortFindings(findings).map(finding => <li key={finding.id} data-finding-id={finding.id} data-status={finding.status} className={openId === finding.id ? 'active' : ''}>
      <input type="checkbox" aria-label={`Select finding ${finding.title}`} checked={selected.has(finding.id)} onChange={() => onToggle(finding.id)} />
      <button type="button" className="production-finding-open" onClick={() => onOpen(openId === finding.id ? null : finding.id)} aria-expanded={openId === finding.id}>
        <span className={`production-chip tone-${SEVERITY_TONE[finding.severity]}`}>{finding.severity}</span>
        <span className="production-finding-title" data-audit-text>{finding.controlId} · {finding.title}</span>
        <span className={`production-chip tone-${STATUS_TONE[finding.status]}`}>{finding.status}</span>
        {finding.taskId && <span className="production-chip tone-quiet">task</span>}
      </button>
      <small className="production-finding-where">{finding.route ?? finding.component ?? finding.scope} · {finding.category} · {finding.confidence} · seen {finding.occurrences}×</small>
    </li>)}
  </ul>
}
