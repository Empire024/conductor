import { BellRing } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { ATTENTION_LABEL, type AttentionSnapshot } from '../../../shared/needs-attention'
import './NeedsAttention.css'

const SHOWN = 5

/**
 * "Needs attention" under the projects (src/shared/needs-attention.ts): the agent tabs in every
 * open project that need the owner now - an approval card, a question, a permission card, a
 * failed, interrupted or limit-stopped run the owner has not looked at. Main publishes the list only
 * when it changes, so this never re-renders while the owner types. Clicking a row shows that tab.
 */
export const NeedsAttention = memo(function NeedsAttention(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<AttentionSnapshot | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    let disposed = false
    void window.conductor.needsAttention.snapshot().then(next => { if (!disposed) setSnapshot(next) }).catch(() => {})
    const off = window.conductor.needsAttention.onChanged(next => setSnapshot(next))
    return () => { disposed = true; off() }
  }, [])
  if (!snapshot?.entries.length) return null
  const rows = expanded ? snapshot.entries : snapshot.entries.slice(0, SHOWN)
  const hidden = snapshot.total - rows.length
  const show = (projectId: string, workspaceId: string, tabId: string): void => {
    setNote('')
    window.conductor.agentControl.focusTab(projectId, workspaceId, tabId).catch(error => setNote(error instanceof Error ? error.message : String(error)))
  }
  return (
    <section className="needs-attention" aria-label={`${snapshot.total} tab${snapshot.total === 1 ? '' : 's'} need attention`} data-attention-count={snapshot.total}>
      <div className="needs-attention-head">
        <BellRing size={12} strokeWidth={1.9} aria-hidden="true" />
        <strong>Needs attention</strong>
        <span>{snapshot.total}</span>
      </div>
      <ul>
        {rows.map(entry => (
          <li key={entry.agentSessionId}>
            <button
              type="button" data-attention-tab={entry.tabId} data-attention-reason={entry.reason}
              title={`${entry.title} — ${entry.projectName} / ${entry.workspaceName}${entry.detail ? `\n${entry.detail}` : ''}`}
              onClick={() => show(entry.projectId, entry.workspaceId, entry.tabId)}
            >
              <em className={`needs-attention-reason ${entry.reason}`}>{ATTENTION_LABEL[entry.reason]}</em>
              <span className="ellipsis">{entry.title}</span>
              <small className="ellipsis">{entry.projectName}</small>
            </button>
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && snapshot.entries.length > SHOWN && (
        <button type="button" className="needs-attention-more" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer' : `+${hidden} more`}</button>
      )}
      {note && <p className="needs-attention-note" role="status">{note}</p>}
    </section>
  )
})
