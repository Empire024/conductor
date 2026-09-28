import { useEffect, useState } from 'react'
import { CLAUDE_FULL_AUTO_ACTION, CLAUDE_FULL_AUTO_EXPLANATION, type ClaudeFullAutoState } from '../../../shared/claude-full-auto'
import './ClaudeFullAutoControl.css'

export function ClaudeFullAutoControl(): React.JSX.Element {
  const [state, setState] = useState<ClaudeFullAutoState>()
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void window.conductor.claudeFullAuto.state().then(value => { if (alive) setState(value) }).catch(reason => { if (alive) setError(String(reason)) })
    const unsubscribe = window.conductor.claudeFullAuto.onChanged(value => { if (alive) setState(value) })
    return () => { alive = false; unsubscribe() }
  }, [])
  return <section className="sa-full-auto-control" aria-label="Claude Full Auto authorization">
    <p>{CLAUDE_FULL_AUTO_EXPLANATION}</p>
    <button type="button" disabled={!state || state.applying} onClick={event => {
      // Synthetic DOM events (including replayed notifications) cannot authorize this action.
      if (!event.isTrusted || !state) return
      setError('')
      void window.conductor.claudeFullAuto.setEnabled(!state.enabled).then(setState).catch(reason => setError(String(reason)))
    }}>{state?.enabled ? 'Disable Full Auto for Claude workers' : CLAUDE_FULL_AUTO_ACTION}</button>
    <p role="status">{state?.applying ? 'Applying the owner policy to eligible Claude runtimes…' : state?.enabled ? 'Full Auto authorized. Each conversation shows its confirmed runtime mode; busy sessions may be awaiting a safe resume.' : 'Full Auto is not authorized. Claude Auto currently uses Guarded Auto.'}</p>
    {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
  </section>
}
