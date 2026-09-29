import type { GateState } from '../../../../shared/production'
import { fingerprintLine, GATE_LABELS, gateSummary } from './production-model'

/**
 * The project audit state for one environment, with every reason it is not VERIFIED. There is no
 * score: a state, its reasons and the fingerprint it was computed at.
 */
export function GateBadge({ gate, compact = false }: { gate: GateState; compact?: boolean }): React.JSX.Element {
  const meta = GATE_LABELS[gate.state]
  if (compact) {
    return <span className={`production-chip production-gate-chip tone-${meta.tone}`} data-state={gate.state} title={gate.reasons.join('\n') || gateSummary(gate)}>{meta.label}</span>
  }
  return <div className={`production-gate tone-${meta.tone}`} data-state={gate.state} role="status" aria-label={`Audit state ${meta.label}`}>
    <div className="production-gate-head">
      <span className={`production-chip production-gate-chip tone-${meta.tone}`}>{meta.label}</span>
      <span className="production-gate-summary">{gateSummary(gate)}</span>
    </div>
    <p className="production-fingerprint" data-fact="fingerprint">{fingerprintLine(gate.fingerprint)}</p>
    {gate.reasons.length > 0 && <ul className="production-gate-reasons" aria-label="Why the state is not verified">
      {gate.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
    </ul>}
  </div>
}
