import { useState } from 'react'
import { absoluteTime, needsClamp, relativeTime, type Tone } from './schedule-helpers'

/** A small status pill; the stylesheet colours it by tone. */
export function Chip({ tone = 'quiet', children, title }: { tone?: Tone; children: React.ReactNode; title?: string }): React.JSX.Element {
  return <span className={`schedule-chip tone-${tone}`} title={title}>{children}</span>
}

/** A relative time with the absolute one on hover. */
export function TimeAgo({ iso, now, prefix = '' }: { iso: string | null | undefined; now: number; prefix?: string }): React.JSX.Element | null {
  const text = relativeTime(iso, now)
  if (!iso || !text) return null
  return <time dateTime={iso} title={absoluteTime(iso)}>{prefix}{text}</time>
}

/** Pre-wrapped text clamped to a few lines, with "Show more" when it is long. */
export function ClampedText({ text, className = '' }: { text: string; className?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const long = needsClamp(text)
  return <div className={`schedule-clamp ${className}`}>
    <p className={long && !expanded ? 'clamped' : ''}>{text}</p>
    {long && <button type="button" className="schedule-link" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</button>}
  </div>
}
