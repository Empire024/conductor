import { useRef } from 'react'
import { Play, Send, Square } from 'lucide-react'
import { spinPhaseStyle } from '../spin-sync'
import './StructuredAgentPane.css'

export type SendButtonState = 'send' | 'stop' | 'resume'
export function sendButtonIntent(input: { active: boolean; interrupting: boolean; draft: boolean; needsResume: boolean; steering: boolean; historical: boolean; canSubmit: boolean; submitting: boolean }): { state: SendButtonState; label: string; title: string; disabled: boolean } {
  if (input.active && !input.draft) return { state: 'stop', label: 'Stop', title: 'Stop · Esc', disabled: input.interrupting || input.historical }
  if (input.needsResume) return { state: 'resume', label: 'Resume conversation', title: 'Resume the same conversation', disabled: false }
  return { state: 'send', label: input.steering ? 'Steer' : input.active ? 'Queue message' : 'Send message', title: input.steering ? 'Send to running turn · Enter' : input.active ? 'Queue message after this turn · Enter' : 'Send message · Enter', disabled: !input.canSubmit || !input.draft || input.submitting }
}
/* One element for all three states: every glyph stays mounted so send/stop/resume morph in CSS instead of swapping, and only the send state submits the composer. */
export function StructuredSendButton({ state, label, title, disabled, busy, onActivate }: { state: SendButtonState; label: string; title: string; disabled: boolean; busy: boolean; onActivate(): void }): React.JSX.Element {
  // Frozen at mount: recomputing the delay on every render would jerk the orbit back mid-spin.
  const spinEpoch = useRef(Date.now()).current
  return <button className={state === 'stop' ? 'sa-send sa-stop' : 'sa-send'} data-state={state} data-busy={busy ? 'true' : 'false'} type={state === 'send' ? 'submit' : 'button'} aria-label={label} title={title} disabled={disabled} onClick={state === 'send' ? undefined : () => onActivate()}>
    <span className="sa-send-orbit" aria-hidden="true" style={spinPhaseStyle(spinEpoch)} />
    <span className="sa-send-glyphs" aria-hidden="true"><Send className="sa-send-glyph sa-glyph-send" size={15} /><Square className="sa-send-glyph sa-glyph-stop" size={11} fill="currentColor" /><Play className="sa-send-glyph sa-glyph-resume" size={15} /></span>
  </button>
}
