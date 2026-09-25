import { useEffect, useState } from 'react'
import { Download, RefreshCw, RotateCcw } from 'lucide-react'
import type { AppUpdateState, CliPinState, RestorePlan, RestorePlanCli, RestorePoint, RestoreScope } from '../../../shared/models'
import { useAppUpdates } from '../use-app-updates'
import { UpdateQuitConfirm } from './UpdateQuitConfirm'
import './AppUpdateButton.css'

export const isUpdateActionVisible = (state: AppUpdateState): boolean =>
  ['available', 'downloading', 'ready', 'installing'].includes(state.phase) ||
  (state.phase === 'error' && Boolean(state.availableVersion))

/** A wizard tab's app.restart.request, as the owner's update control shows it. */
export const restartRequestLabel = (state: AppUpdateState): string | undefined =>
  state.restartRequest && `Restart requested by ${state.restartRequest.title} — ${state.restartRequest.reason}`

const shortCli = (label: string, value: string | null): string => `${label} ${value ?? 'unknown'}`

const planLine = (change: RestorePlanCli): string => {
  if (change.action === 'unrecorded') return `${change.label}: not recorded, unchanged`
  if (change.action === 'keep') return `${change.label} ${change.to}: unchanged`
  if (change.action === 'unavailable') return `${change.label} ${change.to}: not on this machine, stays on ${change.from ?? 'the installed version'}`
  return `${change.label} ${change.from ?? 'not installed'} → ${change.to} (${change.action === 'unpin' ? 'the installed CLI' : change.source})`
}

/** What a rollback changes, shown before the owner confirms it (FX20). */
export function RestorePlanPanel({ plan, busy, onConfirm, onCancel }: { plan: RestorePlan; busy: boolean; onConfirm(): void; onCancel(): void }): React.JSX.Element {
  return <section className="update-restore-plan" role="dialog" aria-label="Rollback plan">
    <strong>{plan.scope === 'clis' ? `Roll back the CLIs to those of ${plan.version}` : `Roll back to Conductor ${plan.version}`}</strong>
    <ul>
      {plan.app && <li>Conductor {plan.app.from} → {plan.app.to} (installs the saved build and restarts)</li>}
      {plan.clis.map(change => <li key={change.provider} data-action={change.action}>{planLine(change)}</li>)}
      {plan.models.map(entry => <li key={entry.provider} className="update-restore-models">Models recorded for {entry.provider}: {[...entry.added.map(id => '+' + id), ...entry.removed.map(id => '−' + id)].join(' ')} compared with now{plan.scope === 'clis' ? ' (a restored CLI lists its own models when its tab starts)' : ''}</li>)}
    </ul>
    {plan.warnings.map(warning => <p key={warning}>{warning}</p>)}
    {plan.blocked && <p className="update-version-error" role="alert">{plan.blocked}</p>}
    <div className="update-version-actions">
      <button type="button" disabled={busy || Boolean(plan.blocked)} onClick={onConfirm}>Confirm rollback</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </section>
}

export function VersionsMenu({ currentVersion, versions, busy, onRollback, onPin, onOpen, plan, onConfirm, onCancelPlan, cliPins = [], onUseInstalledClis }: {
  currentVersion: string
  versions: RestorePoint[]
  busy: boolean
  /** Asks for the plan of a rollback; nothing changes until the owner confirms it. */
  onRollback(version: string, scope: RestoreScope): void
  onPin(version: string, pinned: boolean): void
  /** Builds made while the app runs add restore points, so the list is re-read on every open. */
  onOpen?(): void
  plan?: RestorePlan | null
  onConfirm?(): void
  onCancelPlan?(): void
  cliPins?: CliPinState[]
  onUseInstalledClis?(): void
}): React.JSX.Element {
  return <details className="update-versions-menu" onToggle={event => { if (event.currentTarget.open) onOpen?.() }}>
    <summary>Versions</summary>
    <div className="update-versions-popover">
      {cliPins.length > 0 && <div className="update-cli-pins">
        <span>Using restored CLIs: {cliPins.map(pin => `${pin.label} ${pin.version} (installed ${pin.installed ?? 'unknown'})`).join(' · ')}</span>
        <button type="button" disabled={busy} onClick={onUseInstalledClis}>Use installed CLIs</button>
      </div>}
      {plan && <RestorePlanPanel plan={plan} busy={busy} onConfirm={() => onConfirm?.()} onCancel={() => onCancelPlan?.()} />}
      <strong>Restore points</strong>
      {!versions.length && <p>No local restore points yet.</p>}
      <ul>{versions.map(point => <li key={point.version}>
        <div><b>{point.version}</b>{point.version === currentVersion && <em>Current</em>}{point.knownGood && <em>Known good</em>}</div>
        <small>{new Date(point.createdAt).toLocaleString()} · {point.commit?.slice(0, 10) ?? 'uncommitted'}{point.dirty ? ' · dirty build' : ''}</small>
        <small>{shortCli('Claude', point.cliVersions.claude)} · {shortCli('Codex', point.cliVersions.codex)} · {shortCli('Grok', point.cliVersions.grok)}</small>
        <div className="update-version-actions">
          <button type="button" disabled={busy || point.version === currentVersion} onClick={() => onRollback(point.version, 'all')}>Roll back to this version</button>
          <button type="button" disabled={busy || (!point.cliVersions.claude && !point.cliVersions.codex)} onClick={() => onRollback(point.version, 'clis')}>Roll back CLIs only</button>
          <button type="button" disabled={busy} onClick={() => onPin(point.version, !point.pinned)}>{point.pinned ? 'Unpin' : 'Pin as known good'}</button>
        </div>
      </li>)}</ul>
    </div>
  </details>
}

export function AppUpdateButton({ state, onAction }: { state: AppUpdateState; onAction(): void }): React.JSX.Element | null {
  const { pendingQuitConfirm, confirmQuitAndInstall, cancelQuitConfirm } = useAppUpdates()
  const [versions, setVersions] = useState<RestorePoint[]>([])
  const [versionBusy, setVersionBusy] = useState(false)
  const [versionError, setVersionError] = useState('')
  const [plan, setPlan] = useState<RestorePlan | null>(null)
  const [cliPins, setCliPins] = useState<CliPinState[]>([])
  const refreshVersions = (): void => {
    void window.conductor.updates.versions().then(setVersions).catch(() => setVersions([]))
    void window.conductor.updates.cliPins().then(setCliPins).catch(() => setCliPins([]))
  }
  useEffect(refreshVersions, [])
  const failed = (reason: unknown): void => setVersionError(reason instanceof Error ? reason.message : String(reason))
  const confirm = pendingQuitConfirm && <UpdateQuitConfirm running={pendingQuitConfirm} onConfirm={() => void confirmQuitAndInstall()} onCancel={cancelQuitConfirm} />
  const requested = restartRequestLabel(state)
  const menu = <VersionsMenu currentVersion={state.currentVersion} versions={versions} busy={versionBusy} onOpen={refreshVersions} onPin={(version, pinned) => {
    setVersionBusy(true); setVersionError('')
    void window.conductor.updates.pinVersion(version, pinned).then(refreshVersions).catch(reason => setVersionError(reason instanceof Error ? reason.message : String(reason))).finally(() => setVersionBusy(false))
  }} onRollback={(version, scope) => {
    setVersionBusy(true); setVersionError(''); setPlan(null)
    void window.conductor.updates.restorePlan(version, scope).then(setPlan).catch(failed).finally(() => setVersionBusy(false))
  }} plan={plan} onCancelPlan={() => setPlan(null)} onConfirm={() => {
    if (!plan) return
    setVersionBusy(true); setVersionError('')
    // A CLI-only rollback applies at once; a full one installs the saved build and restarts the app.
    void window.conductor.updates.rollback(plan.version, plan.scope).then(() => { setPlan(null); refreshVersions() }).catch(failed).finally(() => setVersionBusy(false))
  }} cliPins={cliPins} onUseInstalledClis={() => {
    setVersionBusy(true); setVersionError('')
    void window.conductor.updates.useInstalledClis().then(setCliPins).catch(failed).finally(() => setVersionBusy(false))
  }} />
  const extras = <>{menu}{versionError && <span className="update-version-error" role="alert">{versionError}</span>}{confirm}</>
  if (!isUpdateActionVisible(state)) {
    if (!requested) return extras
    return <>
      <button className="statusbar-update ready" onClick={() => void window.conductor.updates.restart()} title={requested}>
        <RotateCcw size={11} /><span aria-live="polite">{requested.length > 90 ? requested.slice(0, 89) + '…' : requested}</span>
      </button>
      {extras}
    </>
  }

  const busy = state.phase === 'downloading' || state.phase === 'installing'
  const progress = typeof state.progress === 'number' && Number.isFinite(state.progress) ? Math.round(Math.max(0, Math.min(100, state.progress))) : undefined
  const label = state.phase === 'available' ? 'Update pending'
    : state.phase === 'downloading' ? progress === undefined ? 'Preparing download…' : `Downloading ${progress}%`
      : state.phase === 'ready' ? 'Restart to update'
        : state.phase === 'installing' ? 'Preparing restart…' : 'Retry update'
  const Icon = ['available', 'downloading'].includes(state.phase) ? Download : state.phase === 'ready' ? RotateCcw : RefreshCw
  return <>
    <button className={`statusbar-update ${state.phase}`} onClick={onAction} disabled={busy} aria-busy={busy}
      title={[requested, state.message ?? (state.availableVersion ? `${label}: Conductor ${state.availableVersion}` : label)].filter(Boolean).join('\n')}>
      <Icon size={11} /><span aria-live="polite">{label}</span>
      {requested && <span>· {requested.length > 90 ? requested.slice(0, 89) + '…' : requested}</span>}
      {state.phase === 'downloading' && <progress aria-label="Update download progress" value={progress} max={100} />}
    </button>
    {extras}
  </>
}
