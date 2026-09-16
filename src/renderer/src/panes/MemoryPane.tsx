import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Brain, Check, ExternalLink, Lightbulb, Pencil, Plus, Scale, Search, Sparkles, Trash2, UserRound, X } from 'lucide-react'
import { MEMORY_KINDS } from '../../../shared/models'
import type { AgentMemory, MemoryKind, MemoryPruneCandidate, ProjectRecord, UpdateMemoryInput } from '../../../shared/models'

/** Every menu, grouping and heading below is built from MEMORY_KINDS, so a new kind arrives
 *  in the pane the moment it is added to the shared list rather than being invisible here. */
export const kindMeta: Record<MemoryKind, { title: string; detail: string }> = {
  episodic: { title: 'Episode', detail: 'What happened in a particular situation' },
  semantic: { title: 'Knowledge', detail: 'Stable facts, patterns, and project meaning' },
  procedural: { title: 'Practice', detail: 'How this project prefers work to be done' }
}

const emptyGroups = (): Record<MemoryKind, AgentMemory[]> =>
  Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, [] as AgentMemory[]])) as Record<MemoryKind, AgentMemory[]>

const relativeWhen = (value: string): string => {
  const elapsed = Date.now() - Date.parse(value)
  if (!Number.isFinite(elapsed)) return 'unknown time'
  const minutes = Math.round(elapsed / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(value).toLocaleDateString()
}

/** Provenance in one line: who claimed this, out of which conversation, and when. */
export function MemoryProvenance({ memory }: { memory: AgentMemory }): React.JSX.Element {
  const origin = memory.origin
  const agentWritten = memory.source === 'agent'
  const openConversation = (): void => {
    if (!origin?.workspaceId) return
    window.dispatchEvent(new CustomEvent('conductor:focus-process', {
      detail: { id: origin.agentSessionId, sessionId: origin.workspaceId }
    }))
  }
  return (
    <div className="memory-provenance">
      <span className={'memory-source memory-source-' + memory.source} title={agentWritten ? 'Written by an agent on its own initiative' : 'Written by you'}>
        {agentWritten ? <Bot size={11} /> : <UserRound size={11} />}
        {agentWritten ? 'Agent' : 'You'}
      </span>
      {memory.correctedAt && <span className="memory-corrected" title={'Corrected by hand ' + relativeWhen(memory.correctedAt)}><Pencil size={10} />corrected</span>}
      {origin
        ? origin.workspaceId
          ? <button type="button" className="memory-origin-link" title={'Open ' + (origin.title || 'the conversation that wrote this')} onClick={openConversation}>
              <ExternalLink size={10} /><span>{origin.title || origin.agentSessionId}</span>
            </button>
          : <span className="memory-origin-link" title={origin.agentSessionId}><span>{origin.title || origin.agentSessionId}</span></span>
        : <span className="memory-origin-unknown" title="Written before Conductor recorded which conversation a memory came from">conversation unknown</span>}
      <span title={'Last updated ' + new Date(memory.updatedAt).toLocaleString()}>{relativeWhen(memory.updatedAt)}</span>
    </div>
  )
}

function WeightSlider({ label, value, max = 1, step = 0.05, onChange }: { label: string; value: number; max?: number; step?: number; onChange(value: number): void }): React.JSX.Element {
  return (
    <label className="memory-weight">
      <span>{label}</span>
      <input type="range" min={0} max={max} step={step} value={value} aria-label={label} onChange={(event) => onChange(Number(event.target.value))} />
      <b>{max > 1 ? value.toFixed(0) : value.toFixed(2)}</b>
    </label>
  )
}

/** Editing and re-weighting, for agent-written and human-written memories alike. Saving marks
 *  the memory as vouched for by hand, which is what keeps it out of automatic forgetting. */
function MemoryEditor({ memory, onCancel, onSaved }: { memory: AgentMemory; onCancel(): void; onSaved(): void }): React.JSX.Element {
  const [draft, setDraft] = useState<Required<Omit<UpdateMemoryInput, 'id'>>>({
    kind: memory.kind,
    gist: memory.gist,
    cues: memory.cues,
    salience: memory.salience,
    confidence: memory.confidence,
    strength: memory.strength
  })
  const [cueText, setCueText] = useState(memory.cues.join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.conductor.memory.update({
        id: memory.id,
        ...draft,
        cues: cueText.split(',').map((cue) => cue.trim()).filter(Boolean)
      })
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  return (
    <div className="memory-editor">
      <select value={draft.kind} aria-label="Memory kind" onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as MemoryKind }))}>
        {MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{kindMeta[kind].title}</option>)}
      </select>
      <textarea value={draft.gist} rows={3} aria-label="Memory gist" onChange={(event) => setDraft((current) => ({ ...current, gist: event.target.value }))} />
      <input value={cueText} aria-label="Recall cues" placeholder="Recall cues, comma separated" onChange={(event) => setCueText(event.target.value)} />
      <div className="memory-weights">
        <WeightSlider label="Salience" value={draft.salience} onChange={(salience) => setDraft((current) => ({ ...current, salience }))} />
        <WeightSlider label="Confidence" value={draft.confidence} onChange={(confidence) => setDraft((current) => ({ ...current, confidence }))} />
        <WeightSlider label="Rehearsal" value={draft.strength} max={20} step={1} onChange={(strength) => setDraft((current) => ({ ...current, strength }))} />
      </div>
      {error && <p role="alert" className="memory-error">{error}</p>}
      <div className="memory-editor-actions">
        <button type="button" onClick={onCancel}><X size={13} /> Cancel</button>
        <button type="button" className="primary" disabled={busy || !draft.gist.trim()} onClick={() => void save()}><Check size={13} /> Save correction</button>
      </div>
    </div>
  )
}

export function MemoryPane({ project }: { project: ProjectRecord }): React.JSX.Element {
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [candidates, setCandidates] = useState<MemoryPruneCandidate[] | null>(null)
  const [query, setQuery] = useState('')
  const [gist, setGist] = useState('')
  const [cues, setCues] = useState('')
  const [kind, setKind] = useState<MemoryKind>('semantic')
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback((): void => {
    void window.conductor.memory.list(project.id).then(setMemories)
    setCandidates((current) => {
      if (current) void window.conductor.memory.pruneCandidates(project.id, 25).then(setCandidates)
      return current
    })
  }, [project.id])
  useEffect(() => { load() }, [load])

  const recall = async (): Promise<void> => {
    setMemories(query.trim()
      ? await window.conductor.memory.recall(project.id, query, undefined, 30)
      : await window.conductor.memory.list(project.id))
  }

  const remember = async (): Promise<void> => {
    if (!gist.trim()) return
    setSaving(true)
    await window.conductor.memory.remember({
      projectId: project.id,
      kind,
      gist,
      cues: cues.split(',').map((cue) => cue.trim()).filter(Boolean)
    })
    setGist('')
    setCues('')
    setSaving(false)
    load()
    window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Saved as distilled project memory' }))
  }

  const forget = (memory: AgentMemory): void => {
    void window.conductor.memory.remove(memory.id).then(() => {
      load()
      window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Forgot: ' + memory.gist.slice(0, 60) }))
    })
  }

  const togglePrune = (): void => {
    if (candidates) { setCandidates(null); return }
    void window.conductor.memory.pruneCandidates(project.id, 25).then(setCandidates)
  }

  const grouped = useMemo(() => memories.reduce<Record<MemoryKind, AgentMemory[]>>((result, memory) => {
    (result[memory.kind] ??= []).push(memory)
    return result
  }, emptyGroups()), [memories])

  const article = (memory: AgentMemory, extra?: React.ReactNode): React.JSX.Element => (
    <article key={memory.id} className={editing === memory.id ? 'memory-editing' : undefined}>
      <Lightbulb size={15} />
      <div>
        {editing === memory.id
          ? <MemoryEditor memory={memory} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />
          : <>
              <p>{memory.gist}</p>
              <MemoryProvenance memory={memory} />
              {extra}
              <footer>
                <span>{memory.cues.join(' · ') || 'uncued'}</span>
                <span title={`Salience ${memory.salience.toFixed(2)} · confidence ${memory.confidence.toFixed(2)}`}>strength {memory.strength} · recalled {memory.recallCount}</span>
              </footer>
            </>}
      </div>
      {editing !== memory.id && <div className="memory-actions">
        <button onClick={() => setEditing(memory.id)} title="Edit and re-weight"><Pencil size={13} /></button>
        <button className="memory-forget" onClick={() => forget(memory)} title="Forget"><Trash2 size={14} /></button>
      </div>}
    </article>
  )

  return (
    <div className="memory-pane">
      <header className="memory-heading">
        <div className="memory-mark"><Brain size={22} /></div>
        <div><strong>Living project memory</strong><span>Gist, cues, rehearsal, and time—not transcript hoarding.</span></div>
        <button type="button" className={'memory-prune-toggle' + (candidates ? ' active' : '')} onClick={togglePrune} title="Rank memories by how much standing they still have">
          <Scale size={13} /> {candidates ? 'Back to all' : 'Review weakest'}
        </button>
      </header>
      <div className="memory-search">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void recall() }} placeholder="Recall by idea, file, decision, or situation…" />
        <button onClick={() => void recall()}>Recall</button>
      </div>
      <div className="memory-list">
        {candidates
          ? <section className="memory-prune">
              <h3>Weakest first<span>Standing is salience, confidence and how retrievable a memory still is. Nothing here is removed until you say so.</span></h3>
              {candidates.length === 0 && <p className="memory-muted">Nothing is stored for this project yet.</p>}
              {candidates.map(({ memory, standing, retrievability, reason }) => article(memory, (
                <div className="memory-standing" key="standing">
                  <div className="memory-standing-bar" role="img" aria-label={`Standing ${(standing * 100).toFixed(0)} percent`}><i style={{ width: `${Math.round(standing * 100)}%` }} /></div>
                  <small>{reason} · standing {(standing * 100).toFixed(0)}% · retrievability {(retrievability * 100).toFixed(0)}%</small>
                </div>
              )))}
            </section>
          : <>
              {memories.length === 0 && (
                <div className="memory-empty"><Sparkles size={24} /><strong>No memories yet</strong><span>Add the useful gist of a decision or experience below. Agents recall matching memories when you message them.</span></div>
              )}
              {MEMORY_KINDS.map((memoryKind) => (grouped[memoryKind]?.length ?? 0) > 0 && (
                <section key={memoryKind}>
                  <h3>{kindMeta[memoryKind].title}<span>{kindMeta[memoryKind].detail}</span></h3>
                  {grouped[memoryKind]!.map((memory) => article(memory))}
                </section>
              ))}
            </>}
      </div>
      <div className="memory-composer">
        <select value={kind} aria-label="New memory kind" onChange={(event) => setKind(event.target.value as MemoryKind)}>
          {MEMORY_KINDS.map((option) => <option key={option} value={option}>{kindMeta[option].title}</option>)}
        </select>
        <div>
          <textarea value={gist} onChange={(event) => setGist(event.target.value)} rows={2} placeholder="Write the durable gist in your own words…" />
          <input value={cues} onChange={(event) => setCues(event.target.value)} placeholder="Recall cues, comma separated (optional)" />
        </div>
        <button disabled={!gist.trim() || saving} onClick={() => void remember()}><Plus size={17} /> Remember</button>
      </div>
    </div>
  )
}
