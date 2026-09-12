import { useState } from 'react'
import { Bot, Globe2, TerminalSquare } from 'lucide-react'
import './SessionArchiveDormantPane.css'

export interface SessionArchiveDormantPaneProps {
  kind: 'agent' | 'terminal' | 'browser'
  title: string
  machineId?: string
  onActivate(): Promise<void> | void
}

export function SessionArchiveDormantPane({ kind, title, machineId = 'local', onActivate }: SessionArchiveDormantPaneProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const remote = kind === 'agent' && machineId !== 'local'
  const Icon = kind === 'agent' ? Bot : kind === 'terminal' ? TerminalSquare : Globe2
  const detail = remote
    ? `This conversation belongs to remote machine ${machineId}. Its private pairing and access grants were not exported, so it remains offline and will never fall back to this machine.`
    : kind === 'agent'
      ? 'Saved history, settings, and the native conversation ID are available. Resume works only if the provider still has that conversation on this machine.'
      : kind === 'terminal'
        ? 'The transcript is restored. Starting this tab opens a fresh shell; no command from the imported session will run automatically.'
        : 'The saved address was restored with credentials removed. The page will load only after you open it.'
  const label = kind === 'agent' ? 'Resume conversation' : kind === 'terminal' ? 'Start fresh shell' : 'Open saved page'
  const activate = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await onActivate() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open this saved resource') }
    finally { setBusy(false) }
  }
  return <section className="session-archive-dormant" aria-label={`Saved ${kind}: ${title}`}>
    <span className="session-archive-dormant-icon"><Icon size={22} /></span>
    <div><small>Saved session</small><h2>{title}</h2><p>{detail}</p></div>
    {!remote && <button type="button" disabled={busy} onClick={() => void activate()}>{busy ? 'Opening…' : label}</button>}
    {error && <p className="session-archive-dormant-error" role="alert">{error}</p>}
  </section>
}
