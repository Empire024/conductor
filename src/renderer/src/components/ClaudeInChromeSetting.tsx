import { useEffect, useState } from 'react'
import type { ClaudeInChromeMode, ClaudeInChromeState } from '../../../shared/claude-in-chrome'

const MODES: Array<{ id: ClaudeInChromeMode; label: string }> = [
  { id: 'auto', label: 'Automatic' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' }
]

/**
 * Settings > Runtimes: whether Conductor's Claude tabs launch with --chrome, which attaches the
 * Claude in Chrome extension's tools (src/main/claude-in-chrome.ts). Automatic turns it on when
 * the extension's native host is installed; it applies to tabs started or resumed afterwards.
 */
export function ClaudeInChromeSetting(): React.JSX.Element {
  const [state, setState] = useState<ClaudeInChromeState>()
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void window.conductor.claudeInChrome.state().then(value => { if (alive) setState(value) }).catch(reason => { if (alive) setError(String(reason)) })
    return () => { alive = false }
  }, [])
  const status = !state ? 'Checking…' : state.enabled ? 'On' : 'Off'
  const detail = !state ? '' : state.hostInstalled
    ? 'The Claude in Chrome extension is installed for this account. Claude tabs get its browser tools.'
    : 'The Claude in Chrome extension\'s native host is not installed on this PC. Install the extension and run /chrome once in Claude Code to connect it.'
  return <section className="claude-in-chrome-setting" data-state={state ? state.enabled ? 'on' : 'off' : 'loading'} aria-label="Claude in Chrome">
    <label className="theme-auto-setting">
      <span><strong>Claude in Chrome · {status}</strong><small>{detail} Applies to Claude tabs started or resumed after a change.</small></span>
      <select value={state?.mode ?? 'auto'} disabled={!state} onChange={event => {
        setError('')
        void window.conductor.claudeInChrome.setMode(event.target.value as ClaudeInChromeMode).then(setState).catch(reason => setError(String(reason)))
      }}>
        {MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
  </section>
}
