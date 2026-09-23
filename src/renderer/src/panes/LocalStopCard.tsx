import { localStopLabels, type LocalStopReport } from '../../../shared/local-stop'

const count = (value: number): string => value.toLocaleString()

/**
 * Why a local model turn ended, with the figures. Shown for every stop that is not the model's
 * own final answer, so the owner reads "tool-round limit" or "context limit" rather than a
 * generic failure and infers which. Kept free of hooks and pane imports so it renders in a
 * plain unit test.
 */
export function LocalStopCard({ report }: { report: LocalStopReport }): React.JSX.Element {
  const attention = report.reason !== 'completed'
  const context = report.context
  return <section className={'sa-interaction sa-local-stop' + (attention ? ' needs-attention' : '')} role={attention ? 'alert' : 'status'} aria-label={localStopLabels[report.reason]} data-stop-reason={report.reason}>
    <header className="sa-auto-denial-header"><strong>{localStopLabels[report.reason]}</strong><span className="sa-auto-denial-reason">{report.rounds} / {report.hardLimit} tool rounds</span></header>
    <p className="sa-muted">{report.detail}</p>
    {report.unverified && <p className="sa-muted">The final message was not accepted as done: {report.unverified}</p>}
    <dl className="sa-local-stop-figures">
      <dt>Context</dt><dd>{count(context.usedTokens)} / {count(context.capacityTokens)} tokens ({Math.round(context.percent)}%{context.estimated ? ', estimated' : ''}); {count(context.reserveTokens)} reserved for the answer of a {count(context.windowTokens)}-token window</dd>
      {report.compactions > 0 && <><dt>Compaction</dt><dd>{report.compactions}× this turn, about {count(report.recoveredTokens)} tokens recovered</dd></>}
      {report.loopWarnings > 0 && <><dt>Loop warnings</dt><dd>{report.loopWarnings}</dd></>}
      {report.acceptance && <><dt>Acceptance</dt><dd>{report.acceptance.passed ? 'passed' : `failed (exit ${report.acceptance.exitCode})`}: <code>{report.acceptance.command}</code></dd></>}
      <dt>Files changed</dt><dd>{report.filesChanged.length ? report.filesChanged.map(path => <code key={path}>{path}</code>).reduce<React.ReactNode[]>((nodes, node, index) => index ? [...nodes, ', ', node] : [node], []) : 'none'}</dd>
      {report.commandsRun > 0 && <><dt>Commands run</dt><dd>{report.commandsRun}</dd></>}
      {report.excludedOutputChars > 0 && <><dt>Tool output kept out of the prompt</dt><dd>{count(report.excludedOutputChars)} characters (the full output is in this timeline)</dd></>}
    </dl>
  </section>
}
