import { useEffect, useState } from 'react'
import { CheckCheck, PanelTopClose } from 'lucide-react'
import './UsageCapDefaultSetting.css'

const choices: Array<{ minutes: number; label: string }> = [
  { minutes: 5, label: '5 minutes' },
  { minutes: 10, label: '10 minutes' },
  { minutes: 20, label: '20 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 0, label: 'Off' }
]

/**
 * How long a finished coworker stays open before Conductor closes it (history kept), and how
 * long any settled Claude or Codex conversation keeps its CLI process (src/main/coworker-autoclose.ts).
 */
export function CoworkerAutoCloseSetting(): React.JSX.Element {
  const [minutes, setMinutes] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  useEffect(() => {
    window.conductor.settings.coworkerAutoClose().then(setMinutes).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])
  const save = (value: number): void => {
    setError(undefined); setMinutes(value)
    window.conductor.settings.setCoworkerAutoClose(value).then(setMinutes).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  return <section>
    <div className="settings-section-title"><PanelTopClose size={14} /><div><strong>Finished coworkers</strong><span>Close delivered coworker tabs and give idle CLI processes back.</span></div></div>
    <label className="usage-cap-setting">
      <span><strong>Close finished coworkers after</strong><small>{minutes === 0
        ? 'Coworker tabs stay open and every CLI keeps running until you close it'
        : 'A delivered coworker that sat idle this long closes, history kept; any settled Claude or Codex tab idle this long releases its CLI and restarts it on the next message'}</small></span>
      <select aria-label="Close finished coworkers after" value={minutes ?? 10} disabled={minutes === null} onChange={event => save(Number(event.target.value))}>
        {choices.map(choice => <option key={choice.minutes} value={choice.minutes}>{choice.label}</option>)}
      </select>
    </label>
    {error && <p className="usage-cap-error">{error}</p>}
  </section>
}

const sweepChoices: Array<{ hours: number; label: string }> = [
  { hours: 4, label: '4 hours' },
  { hours: 12, label: '12 hours' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '1 week' },
  { hours: 0, label: 'Never' }
]

/**
 * How long a finished tab nobody looked at stays open before it closes itself, history kept
 * (workspace clarity, src/main/workspace-clarity.ts). Running, waiting, pinned and wizard tabs,
 * and the tab on screen in its pane, are never closed.
 */
export function FinishedTabSweepSetting(): React.JSX.Element {
  const [hours, setHours] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  useEffect(() => {
    window.conductor.settings.finishedTabSweep().then(setHours).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [])
  const save = (value: number): void => {
    setError(undefined); setHours(value)
    window.conductor.settings.setFinishedTabSweep(value).then(setHours).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  return <section>
    <div className="settings-section-title"><CheckCheck size={14} /><div><strong>Finished tabs</strong><span>Keep every workspace to the work that is still going.</span></div></div>
    <label className="usage-cap-setting">
      <span><strong>Close finished tabs after</strong><small>{hours === 0
        ? 'Finished tabs stay open until you close them (the sidebar\'s Done group has Close finished)'
        : 'A finished tab you have not looked at for this long closes, history kept; running, waiting, pinned and wizard tabs never do'}</small></span>
      <select aria-label="Close finished tabs after" value={hours ?? 24} disabled={hours === null} onChange={event => save(Number(event.target.value))}>
        {sweepChoices.map(choice => <option key={choice.hours} value={choice.hours}>{choice.label}</option>)}
      </select>
    </label>
    {error && <p className="usage-cap-error">{error}</p>}
  </section>
}
