import { useEffect, useState } from 'react'
import { PanelTopClose } from 'lucide-react'
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
