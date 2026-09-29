import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, X } from 'lucide-react'
import { offerAwaitsOwner, type ModelUpgradeOffer, type ModelUpgradesStatus } from '../../../shared/model-upgrades'

/**
 * The owner's one OK for a better model (docs/model-upgrades.md). Non-modal, bottom right: shown
 * only when an upgrade is fully prepared (state ready), and while it is being applied. "Not now"
 * hides it for this window session; "No" declines the model for good.
 */
export function ModelUpgradeCard(): React.JSX.Element | null {
  const [status, setStatus] = useState<ModelUpgradesStatus | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const bridge = window.conductor.modelUpgrades
    if (!bridge) return
    void bridge.status().then(setStatus).catch(() => {})
    return bridge.onStatus(setStatus)
  }, [])
  const answer = useCallback(async (offer: ModelUpgradeOffer, choice: 'accept' | 'decline') => {
    setBusy(offer.id); setError(null)
    try { await window.conductor.modelUpgrades.answer(offer.id, choice) } catch (failure) { setError(String((failure as Error)?.message ?? failure).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) } finally { setBusy(null) }
  }, [])
  const offer = status?.offers.find(entry => (offerAwaitsOwner(entry) || entry.state === 'applying') && !hidden.has(entry.id))
  if (!offer) return null
  const applying = offer.state === 'applying'
  // Portalled: an ancestor with a transform would otherwise be the fixed position's frame.
  return createPortal(
    <section className="update-prompt model-upgrade-card" role="dialog" aria-labelledby="model-upgrade-title" data-offer={offer.id} data-state={offer.state}>
      <header>
        <span className="update-prompt-icon"><Sparkles size={20} /></span>
        <div>
          <strong id="model-upgrade-title">{applying ? `Switching to ${offer.label}` : `${offer.label} is available`}</strong>
          <span>{offer.provider === 'codex' ? 'Codex' : 'Claude Code'}{offer.cli ? ` · CLI ${offer.cli.from ?? '?'} → ${offer.cli.to}` : ''}{offer.candidate ? ` · verified build ${offer.candidate.commit.slice(0, 7)}` : ''}</span>
        </div>
        <button title="Not now" aria-label="Not now" onClick={() => setHidden(new Set([...hidden, offer.id]))}><X size={15} /></button>
      </header>
      <p role="status" aria-live="polite">{applying ? offer.steps.at(-1) ?? 'Switching…' : offer.summary}</p>
      {!applying && <p className="model-upgrade-detail">OK makes new {offer.provider === 'codex' ? 'Codex' : 'Claude'} tabs use it wherever {offer.replaces.label} was the pick{offer.cli ? `, with Conductor's own copy of the newer CLI (your installed CLI is not changed)` : ''}{offer.protocolBump ? ', and installs the verified Conductor update once no tab is working' : ''}.</p>}
      {error && <p role="alert" className="model-upgrade-error">{error}</p>}
      {!applying && (
        <label className="update-auto-choice">
          <input type="checkbox" checked={status?.wizardMayAccept ?? false} onChange={event => void window.conductor.modelUpgrades.setWizardMayAccept(event.target.checked).then(next => next && setStatus(next))} />
          <span><strong>Let a wizard tab answer these for me</strong><small>Off: only you can say OK to a model switch.</small></span>
        </label>
      )}
      {!applying && (
        <footer>
          <button disabled={busy === offer.id} onClick={() => void answer(offer, 'decline')}>No, keep {offer.replaces.label}</button>
          <button className="primary" disabled={busy === offer.id} aria-busy={busy === offer.id} onClick={() => void answer(offer, 'accept')}>OK, switch</button>
        </footer>
      )}
    </section>,
    document.body
  )
}
