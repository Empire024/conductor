import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TimelineItem } from '../../../shared/structured-agent'

/** Pinned above the composer: every approval and question this conversation is waiting on, each
 *  as the live card with its buttons, until it is answered or expires. `reveal` changes when the
 *  owner asks to be shown them (Needs attention, a conversation link, the header badge, the
 *  inline "Show" on a card's row), which opens the dock, brings it into view and pulses it. */
export function PendingInteractionDock({ items, reveal, render }: { items: TimelineItem[]; reveal: number; render(item: TimelineItem): ReactNode }): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  const [pulse, setPulse] = useState(false)
  const dock = useRef<HTMLElement>(null)
  const count = items.length
  useEffect(() => {
    if (!reveal) return
    setOpen(true); setPulse(true)
    requestAnimationFrame(() => dock.current?.scrollIntoView?.({ block: 'nearest' }))
  }, [reveal])
  useEffect(() => {
    if (!pulse) return
    const timer = window.setTimeout(() => setPulse(false), 1600)
    return () => window.clearTimeout(timer)
  }, [pulse])
  if (!count) return null
  const approvals = items.filter(item => item.data.type === 'interaction' && item.data.interaction.kind === 'approval').length
  const label = approvals === count ? (count === 1 ? 'Approval waiting' : `${count} approvals waiting`) : approvals === 0 ? (count === 1 ? 'Question waiting' : `${count} questions waiting`) : `${count} requests waiting`
  return <section ref={dock} className={'sa-interaction-dock' + (pulse ? ' sa-interaction-dock-pulse' : '')} aria-label={`${label} for you`} data-interaction-dock={count}>
    <button type="button" className="sa-interaction-dock-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <strong>{label}</strong>
      <span className="sa-muted">{open ? 'Hide' : 'Show'}</span>
    </button>
    {open && <div className="sa-interaction-dock-cards">{items.map(item => <div key={item.id} className="sa-interaction-dock-card">{render(item)}</div>)}</div>}
  </section>
}
