import { CONTROL_TITLES, type ControlId, type ControlResult, type GateState } from '../../../../shared/production'
import { reviewCounts, sortResults, STATUS_LABEL, STATUS_TONE } from './production-model'

/** The items themselves are answered in the Human review section; the table only counts them. */
const reviewLine = (result: ControlResult): string => {
  const { total, answered } = reviewCounts([result])
  return `${total} human-review item${total === 1 ? '' : 's'}, ${answered} answered${answered < total ? ' (answer under Human review)' : ''}`
}

const coverageText = (result: ControlResult): string => {
  const { tested, sampled, excluded, unobservable } = result.coverage
  const parts = [`${tested.length} tested`, `${sampled.length} sampled`, `${excluded.length} excluded`]
  if (unobservable.length) parts.push(`${unobservable.length} unobservable`)
  return parts.join(' · ')
}

/**
 * One row per control of the last run: status, the applicability rationale, route coverage counts
 * and how many human-review items it has answered. A control a later change invalidated is marked stale. Two columns,
 * because the drawer is narrow: what the control is and its status, then why and how far it was tested.
 */
export function ControlTable({ results, gate }: { results: ControlResult[]; gate: GateState }): React.JSX.Element {
  const stale = new Set<ControlId>(gate.staleControls)
  if (!results.length && !gate.results.length) return <p className="production-muted">No control results yet. Run an audit to fill this table.</p>
  const head = (controlId: ControlId, status: ControlResult['status']): React.JSX.Element => <td>
    <strong>{controlId}</strong> {CONTROL_TITLES[controlId]}
    <span className="production-chips">
      <span className={`production-chip tone-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
      {stale.has(controlId) && <span className="production-chip tone-warn">Stale</span>}
    </span>
  </td>
  if (!results.length) {
    return <table className="production-table production-controls">
      <thead><tr><th>Control</th><th>Result</th></tr></thead>
      <tbody>{sortResults(gate.results).map(result => <tr key={result.controlId} data-control={result.controlId} data-status={result.status}>
        {head(result.controlId, result.status)}
        <td><small className="production-muted">Details load with the run's results.</small></td>
      </tr>)}</tbody>
    </table>
  }
  return <table className="production-table production-controls">
    <thead><tr><th>Control</th><th>Why and coverage</th></tr></thead>
    <tbody>{sortResults(results).map(result => <tr key={result.controlId} data-control={result.controlId} data-status={result.status}>
      {head(result.controlId, result.status)}
      <td>
        {result.rationale && <small className="production-rationale" data-audit-text>{result.rationale}</small>}
        <small data-audit-text>{result.applicability.status}: {result.applicability.rationale}</small>
        <small data-fact="coverage">{coverageText(result)}</small>
        {result.humanReview.length > 0 && <small data-fact="human-review">{reviewLine(result)}</small>}
      </td>
    </tr>)}</tbody>
  </table>
}
