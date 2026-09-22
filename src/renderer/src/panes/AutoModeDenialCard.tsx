import type { AutoModeDenial } from '../../../shared/auto-mode-denial'

/**
 * A tool call the claude CLI's own auto-mode classifier refused. There was never a `can_use_tool`
 * request, so no approval card could exist; this card takes its place with the same attention
 * styling and the one action that gets the owner a real card next time: Edit mode asks before
 * such actions. Kept free of hooks and pane imports so it renders in a plain unit test.
 */
export function AutoModeDenialCard({ denial, onSwitchToEdit }: { denial: AutoModeDenial; onSwitchToEdit?: () => void }): React.JSX.Element {
  return <section className="sa-interaction needs-attention sa-auto-denial" role="alert" aria-label={'Auto mode refused ' + denial.tool} data-tool-use-id={denial.toolUseId}>
    <header className="sa-auto-denial-header"><strong>Auto mode refused {denial.tool}</strong><span className="sa-auto-denial-reason">{denial.reason}</span></header>
    <p className="sa-muted">The claude CLI's own classifier decided this, so Conductor could not show you a card. The tool call failed and Claude was told to carry on with other work.</p>
    <div className="sa-interaction-actions">
      <button type="button" className="sa-auto-denial-switch" disabled={!onSwitchToEdit} title={onSwitchToEdit ? 'Edit mode asks you before such actions, so the next attempt shows an Allow card' : 'This conversation is no longer live'} onClick={onSwitchToEdit}>Switch to Edit mode</button>
    </div>
    <p className="sa-request-summary">Then send <code>continue</code> so Claude retries the action and you get an Allow card for it, or add a permission rule for this tool.</p>
  </section>
}
