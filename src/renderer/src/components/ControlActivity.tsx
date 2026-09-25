import { useEffect, useRef, useState } from 'react'
import { Check, CircleDot, GitCommitHorizontal, Link2, PenLine, RotateCw, Send, SquareArrowOutUpRight, SquareX, Workflow } from 'lucide-react'
import { controlActionText, readChipText, type AppControlEntry, type ControlAction, type ControlActionKind, type ControlActivity, type ControlledBy } from '../../../shared/control-activity'
import { copyText } from '../clipboard'
import './ControlActivity.css'

/* FX15: what a conversation did through app control, drawn Conductor-side from the notices
 * src/main/control-activity.ts records. Kept free of pane imports so it renders in a unit test. */

const KIND_ICONS: Record<ControlActionKind, typeof Send> = {
  open: SquareArrowOutUpRight, steer: Send, close: SquareX, ship: GitCommitHorizontal, app: RotateCw, decide: Check, write: PenLine, other: CircleDot
}
type FocusAgent = (origin: { agentSessionId: string; label: string }) => void

const actionTitle = (action: ControlAction): string => [
  `${action.method}${action.failed ? ' (failed)' : ''}`,
  action.error,
  action.commit ? `Commit ${action.commit}; click to copy` : action.target?.agentSessionId ? `Show ${action.target.title ?? 'the tab'}` : undefined,
  action.at ? new Date(action.at).toLocaleString() : undefined
].filter(Boolean).join('\n')

function ControlChip({ action, onFocusAgent }: { action: ControlAction; onFocusAgent?: FocusAgent }): React.JSX.Element {
  const Icon = KIND_ICONS[action.kind] ?? CircleDot
  const className = `control-chip kind-${action.kind}${action.failed ? ' failed' : ''}${action.appWide ? ' app-wide' : ''}`
  const body = <><Icon size={11} aria-hidden="true" /><span>{controlActionText(action)}</span></>
  const target = action.target?.agentSessionId
  if (action.commit) return <button type="button" className={className} title={actionTitle(action)} onClick={() => void copyText(action.commit!)}>{body}</button>
  if (target && onFocusAgent) return <button type="button" className={className} title={actionTitle(action)} onClick={() => onFocusAgent({ agentSessionId: target, label: action.target?.title ?? 'tab' })}>{body}</button>
  return <span className={className} title={actionTitle(action)}>{body}</span>
}

/** One turn's control calls as a chip row; reads collapse into one "read N times" chip. */
export function ControlActivityRow({ activity, onFocusAgent }: { activity: ControlActivity; onFocusAgent?: FocusAgent }): React.JSX.Element {
  const reads = Object.entries(activity.readMethods).sort((a, b) => b[1] - a[1]).map(([method, count]) => `${method} ×${count}`).join('\n')
  return <section className="control-activity" aria-label="Conductor app control used in this turn">
    <span className="control-activity-lead"><Workflow size={11} aria-hidden="true" />Conductor</span>
    {activity.dropped > 0 && <span className="control-chip kind-other" title="Earlier calls in this turn">{activity.dropped} earlier</span>}
    {activity.actions.map((action, index) => <ControlChip key={index} action={action} onFocusAgent={onFocusAgent} />)}
    {activity.reads > 0 && <span className="control-chip kind-read" title={reads || undefined}>{readChipText(activity.reads)}</span>}
  </section>
}

/** In a tab another conversation drove: "Opened by Swarm", the name one click from that tab. */
export function ControlledByNotice({ driven, onFocusAgent }: { driven: ControlledBy; onFocusAgent?: FocusAgent }): React.JSX.Element {
  const by = driven.agentSessionId && onFocusAgent
    ? <button type="button" onClick={() => onFocusAgent({ agentSessionId: driven.agentSessionId!, label: driven.title })} title={`Show ${driven.title}`}>{driven.title}</button>
    : <strong>{driven.title}</strong>
  return <div className="controlled-by-notice" role="note"><Link2 size={11} aria-hidden="true" /><span>{driven.verb} by {by}</span><small>{driven.method}</small></div>
}

/** "Controlled by <tab>" on a coworker's tab entry; `compact` shows only the icon (pane tab strip). */
export function ControlledByBadge({ controllerTitle, compact = false }: { controllerTitle: string; compact?: boolean }): React.JSX.Element {
  return <span className={`controlled-by-badge${compact ? ' compact' : ''}`} title={`Controlled by ${controllerTitle}`} aria-label={`Controlled by ${controllerTitle}`}>
    <Link2 size={compact ? 10 : 9} aria-hidden="true" />{!compact && <span>by {controllerTitle}</span>}
  </span>
}

const relative = (at: string, now: number): string => {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000))
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : seconds < 86400 ? `${Math.round(seconds / 3600)}h ago` : `${Math.round(seconds / 86400)}d ago`
}

/** The status bar's history of app-wide actions agents took (restart, update install, rollback). */
export function AppControlHistoryList({ entries, now }: { entries: readonly AppControlEntry[]; now: number }): React.JSX.Element {
  return <ol className="app-control-history-list">
    {[...entries].reverse().map((entry, index) => <li key={index} className={entry.failed ? 'failed' : ''}>
      <strong>{entry.label}</strong><span>by {entry.by.title}</span><time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{relative(entry.at, now)}</time>
    </li>)}
  </ol>
}

export function AppControlHistory(): React.JSX.Element | null {
  const [entries, setEntries] = useState<AppControlEntry[]>([])
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    const load = (): void => { void window.conductor.agentControl.appActivity?.().then(next => { if (live) setEntries(next) }).catch(() => {}) }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (!open) return
    void window.conductor.agentControl.appActivity?.().then(setEntries).catch(() => {})
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close); window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [open])
  const last = entries.at(-1)
  if (!last) return null
  return <div className="app-control-history" ref={root}>
    <button type="button" className="statusbar-link" aria-expanded={open} title={`Last app action by an agent: ${last.label} by ${last.by.title}. Show history`} onClick={() => setOpen(value => !value)}>
      <Workflow size={11} /> {last.label}
    </button>
    {open && <div className="app-control-history-popover" role="dialog" aria-label="App actions taken through Conductor">
      <header>App actions through Conductor</header>
      <AppControlHistoryList entries={entries} now={Date.now()} />
    </div>}
  </div>
}
