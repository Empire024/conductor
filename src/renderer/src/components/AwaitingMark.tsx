import { Hourglass } from 'lucide-react'
import { awaitingSentence, type AwaitingFact } from '../../../shared/awaiting-results'
import './AwaitingMark.css'

/**
 * The tab strip's mark for a tab whose turn ended waiting for other conversations' results
 * (src/shared/awaiting-results.ts): an hourglass in place of the completed-turn check, so the strip
 * says what the sidebar's "waiting for …" row says. Whom it waits for is in the tooltip.
 */
export function AwaitingMark({ fact, title }: { fact: AwaitingFact; title: string }): React.JSX.Element {
  const sentence = awaitingSentence(fact)
  return (
    <span className="tab-awaiting" data-awaiting={fact.agents.map(agent => agent.agentSessionId).join(' ')} title={sentence} aria-label={`${title}: ${sentence}`}>
      <Hourglass size={12} strokeWidth={2} aria-hidden="true" />
    </span>
  )
}
