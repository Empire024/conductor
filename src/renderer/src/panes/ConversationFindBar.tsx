import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from 'lucide-react'
import type { ConversationSearchResult } from '../../../shared/structured-agent'
import { findPositionLabel } from './conversation-find'

interface ConversationFindBarProps {
  query: string
  count: number
  index: number
  results: ConversationSearchResult | null
  searching: boolean
  focusToken: number
  onQuery(query: string): void
  onStep(direction: 1 | -1): void
  onOpenHit(sessionId: string, itemId: string): void
  onClose(): void
}
const roleLabel = (role: 'user' | 'assistant' | 'status'): string => role === 'user' ? 'You' : role === 'assistant' ? 'Agent' : 'Status'

export function ConversationFindBar(props: ConversationFindBarProps): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  // Re-pressing Ctrl+F while the bar is open reselects the needle instead of opening anything new.
  useEffect(() => { input.current?.focus(); input.current?.select() }, [props.focusToken])
  const groups = props.results?.groups ?? []
  const needle = props.query.trim()
  return <div className="sa-find" role="search">
    <div className="sa-find-row">
      <Search size={13} aria-hidden="true" />
      <input ref={input} type="text" aria-label="Find in conversations" placeholder="Find in this workspace" spellCheck={false} value={props.query} onChange={event => props.onQuery(event.target.value)} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); return }
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); props.onStep(event.shiftKey ? -1 : 1) }
      }} />
      <span className="sa-find-count" role="status">{findPositionLabel(props.count, props.index, props.query)}</span>
      <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={props.count < 1} onClick={() => props.onStep(-1)}><ChevronUp size={13} /></button>
      <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={props.count < 1} onClick={() => props.onStep(1)}><ChevronDown size={13} /></button>
      <button type="button" aria-label="Close find" title="Close (Esc)" onClick={props.onClose}><X size={13} /></button>
    </div>
    {Boolean(needle) && <div className="sa-find-results" aria-label="Matches in other conversations">
      {needle.length < 2 && <p className="sa-find-note">Type two characters to search your other conversations.</p>}
      {needle.length >= 2 && props.searching && !groups.length && <p className="sa-find-note" role="status"><LoaderCircle size={11} className="spin" /> Searching other conversations…</p>}
      {needle.length >= 2 && !props.searching && !groups.length && <p className="sa-find-note">No matches in other conversations.</p>}
      {groups.map(group => <section key={group.sessionId}>
        <h4><span>{group.title}</span><small>{group.messages} {group.messages === 1 ? 'message' : 'messages'}{group.archived ? ' · archived' : ''}</small></h4>
        {group.hits.map(hit => <button type="button" key={hit.itemId} title={'Open this message in ' + group.title} onClick={() => props.onOpenHit(group.sessionId, hit.itemId)}>
          <span className="sa-find-role">{roleLabel(hit.role)}</span>
          <span className="sa-find-snippet">{hit.snippet.slice(0, hit.matchStart)}<mark>{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>{hit.snippet.slice(hit.matchStart + hit.matchLength)}</span>
        </button>)}
        {group.messages > group.hits.length && <p className="sa-find-note">{group.messages - group.hits.length} more in this conversation</p>}
      </section>)}
      {props.results?.truncated && <p className="sa-find-note">More conversations match. Refine the search to see them.</p>}
    </div>}
  </div>
}
