import { Bell, CircleStop, TriangleAlert, Unplug } from 'lucide-react'
import type { AgentActivityPhase } from '../../../shared/models'
import { spinPhaseStyle } from '../spin-sync'

/** What each phase is called wherever it is shown: the tab strip's tooltip, the workspace
 * list's tooltip, and both screen-reader labels. One table so a state cannot be described two
 * different ways in two places. */
export const ACTIVITY_LABEL: Record<AgentActivityPhase, string> = {
  idle: 'Idle',
  working: 'Working',
  waiting_input: 'Needs your attention',
  limited: 'Paused - usage limit reached',
  complete: 'Finished',
  stopped: 'Stopped - the run was interrupted',
  disconnected: 'Disconnected - lost the runtime connection',
  failed: 'Failed - the run ended with an error'
}

/** The running lifecycle - working, finished, waiting on a limit - shares one morphing ring so
 * the transitions animate; the states that ended the run get their own glyph instead.
 *
 * They used to share the ring too, with the error case simply painting it red. That left a
 * filled circle wearing the ring's own dashed stroke, which read as a lumpy red blob and said
 * nothing about *what* had happened - and 'failed', 'disconnected' and 'stopped' were all
 * flattened into it. */
export function TabActivityIndicator({ phase, title, spinEpoch }: {
  phase: AgentActivityPhase
  /** The tab's own title, so the accessible name says which agent this is about. */
  title: string
  spinEpoch: number
}): React.JSX.Element {
  const label = ACTIVITY_LABEL[phase]
  const glyph =
    phase === 'waiting_input' ? <Bell className="tab-attention-bell" aria-hidden="true" />
    : phase === 'failed' ? <TriangleAlert className="tab-state-icon" aria-hidden="true" />
    : phase === 'disconnected' ? <Unplug className="tab-state-icon" aria-hidden="true" />
    : phase === 'stopped' ? <CircleStop className="tab-state-icon" aria-hidden="true" />
    : <svg className="tab-ring" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6" style={spinPhaseStyle(spinEpoch)} /><path d="M5.7 9.2 8 11.4l4.5-5" /></svg>
  return (
    <span className={`tab-activity ${phase}`} aria-label={`${title}: ${label}`} title={phase === 'idle' ? undefined : label}>
      {glyph}
    </span>
  )
}
