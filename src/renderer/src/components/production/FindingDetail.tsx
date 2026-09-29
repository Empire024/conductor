import { ExternalLink, FileSearch } from 'lucide-react'
import type { Finding, Waiver } from '../../../../shared/production'
import { formatTime, shortCommit } from './production-model'

/**
 * Everything the audit knows about one finding: expected and observed, how to reproduce it, the
 * evidence files (opened from the run that last saw it), the proposed fix, its fix task, the
 * independent verification record and, for legal findings, the sources with their dates.
 */
export function FindingDetail({ finding, waiver, busy, onOpenEvidence, onOpenTasks, onWaive }: {
  finding: Finding
  waiver: Waiver | null
  busy: string
  onOpenEvidence(runId: string, evidenceId: string): void
  onOpenTasks(): void
  onWaive(findingId: string): void
}): React.JSX.Element {
  const verification = finding.verification
  return <article className="production-finding-detail" aria-label={`Finding ${finding.title}`} data-finding-id={finding.id}>
    <dl className="production-facts">
      <div><dt>Expected</dt><dd>{finding.expected}</dd></div>
      <div><dt>Observed</dt><dd>{finding.observed}</dd></div>
    </dl>
    {finding.reproduction.length > 0 && <div>
      <h4>Reproduction</h4>
      <ol>{finding.reproduction.map((step, index) => <li key={index}>{step}</li>)}</ol>
    </div>}
    <div>
      <h4>Evidence</h4>
      {finding.evidence.length
        ? <ul className="production-evidence">{finding.evidence.map(evidenceId => <li key={evidenceId}>
            <button type="button" className="production-link" disabled={Boolean(busy)} onClick={() => onOpenEvidence(finding.lastSeenRunId, evidenceId)}><FileSearch size={11} />{evidenceId}</button>
          </li>)}</ul>
        : <p className="production-muted">No evidence files recorded.</p>}
    </div>
    <div>
      <h4>Proposed fix</h4>
      <p>{finding.proposedFix || 'None proposed.'}</p>
    </div>
    <dl className="production-facts">
      <div><dt>Fix task</dt><dd>{finding.taskId
        ? <button type="button" className="production-link" onClick={onOpenTasks} title="Open the project task board"><ExternalLink size={11} />{finding.taskId}</button>
        : 'none yet'}</dd></div>
      <div><dt>Verification</dt><dd data-fact="verification">{verification
        ? <>{verification.status} · run {verification.verifierRunId} · {shortCommit(verification.fingerprint.commit)} · {formatTime(verification.at)}
            {verification.disagreement && <small className="production-disagreement">Disagreement: {verification.disagreement}</small>}</>
        : 'not independently verified'}</dd></div>
      <div><dt>History</dt><dd>first {finding.firstSeenRunId}, last {finding.lastSeenRunId} at {shortCommit(finding.lastSeenFingerprint.commit)}</dd></div>
      <div><dt>Owner</dt><dd>{finding.owner}</dd></div>
    </dl>
    {finding.legal && <div>
      <h4>Legal sources</h4>
      <ul className="production-sources">{finding.legal.sources.map((source, index) => <li key={index}>
        {source.title}{source.jurisdiction ? ` (${source.jurisdiction})` : ''}
        <small>effective {source.effectiveDate ?? 'unknown'} · retrieved {source.retrievedAt ?? 'never checked'} · review by {source.reviewBy ?? 'unset'}</small>
      </li>)}</ul>
    </div>}
    {waiver && !waiver.revokedAt
      ? <p className="production-muted" data-fact="waiver">Waived until {formatTime(waiver.expiresAt)}: {waiver.reason} (owner {waiver.owner})</p>
      : finding.status !== 'fixed' && <button type="button" disabled={Boolean(busy)} onClick={() => onWaive(finding.id)}>Waive…</button>}
  </article>
}
