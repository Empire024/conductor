import { useState } from 'react'
import { Brain, ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react'
import type { AgentMemory, TurnMemoryRecall } from '../../../shared/models'
import { MEMORY_KINDS } from '../../../shared/models'
import { kindMeta } from './MemoryPane'
import './MemoryRecallStrip.css'

/** Indexes a conversation's recall ledger by the user message each recall travelled with, so a
 *  turn can show exactly which memories reached the agent instead of only the prompt you typed. */
export function recallsByItem(recalls: readonly TurnMemoryRecall[]): Map<string, TurnMemoryRecall> {
  const byItem = new Map<string, TurnMemoryRecall>()
  for (const recall of recalls) {
    if (!recall.itemId) continue
    // A resubmitted item id keeps the newest record: that is the recall that actually ran.
    byItem.set(recall.itemId, recall)
  }
  return byItem
}

/** A one-line correction of a memory from the conversation it steered. Deliberately narrower
 *  than the memory pane: fixing the sentence and dropping the memory are the two things worth
 *  doing the moment you notice a memory is wrong. */
function RecalledMemory({ memory, onChanged }: { memory: AgentMemory; onChanged(): void }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (draft === null || !draft.trim()) return
    setBusy(true)
    try { await window.conductor.memory.update({ id: memory.id, gist: draft }); setDraft(null); onChanged() }
    finally { setBusy(false) }
  }

  return (
    <li className={'sa-recall-item sa-recall-' + memory.kind}>
      <span className="sa-recall-kind" title={kindMeta[memory.kind]?.detail ?? memory.kind}>{kindMeta[memory.kind]?.title ?? memory.kind}</span>
      {draft === null
        ? <span className="sa-recall-gist">{memory.gist}</span>
        : <input className="sa-recall-edit" value={draft} autoFocus aria-label="Correct this memory" disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void save(); if (event.key === 'Escape') setDraft(null) }}
            onBlur={() => void save()} />}
      <small className="sa-recall-meta" title={memory.source === 'agent' ? 'Written by an agent' : 'Written by you'}>{memory.source === 'agent' ? 'agent' : 'you'}</small>
      <button type="button" title="Correct this memory" aria-label="Correct this memory" disabled={busy} onClick={() => setDraft(draft === null ? memory.gist : null)}><Pencil size={11} /></button>
      <button type="button" className="sa-recall-forget" title="Forget this memory" aria-label="Forget this memory" disabled={busy}
        onClick={() => { setBusy(true); void window.conductor.memory.remove(memory.id).then(onChanged).finally(() => setBusy(false)) }}><Trash2 size={11} /></button>
    </li>
  )
}

/**
 * What memory actually reached the agent for one turn. Recall edits the prompt behind the
 * user's back, so a wrong memory would otherwise steer a conversation with nothing in it to
 * point at; this is that thing to point at, and the place to correct it.
 */
export function MemoryRecallStrip({ recall, onChanged }: { recall: TurnMemoryRecall; onChanged(): void }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!recall.memories.length && !recall.forgotten) return null
  const kinds = MEMORY_KINDS.filter((kind) => recall.memories.some((memory) => memory.kind === kind))
  return (
    <div className="sa-recall">
      <button type="button" className="sa-recall-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        <span>Recalled {recall.memories.length} {recall.memories.length === 1 ? 'memory' : 'memories'}{kinds.length ? ' · ' + kinds.map((kind) => kindMeta[kind].title.toLowerCase()).join(', ') : ''}</span>
        {recall.forgotten > 0 && <em title="Recalled at the time, but forgotten since">{recall.forgotten} since forgotten</em>}
      </button>
      {open && <ul className="sa-recall-list">
        {recall.memories.map((memory) => <RecalledMemory key={memory.id} memory={memory} onChanged={onChanged} />)}
        {recall.forgotten > 0 && <li className="sa-recall-item sa-recall-gone">{recall.forgotten} recalled {recall.forgotten === 1 ? 'memory has' : 'memories have'} been forgotten since this turn.</li>}
      </ul>}
    </div>
  )
}
