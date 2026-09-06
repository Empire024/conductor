import { useEffect, useMemo, useState } from 'react'
import { Brain, Lightbulb, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import type { AgentMemory, MemoryKind, ProjectRecord } from '../../../shared/models'

const kindMeta: Record<MemoryKind, { title: string; detail: string }> = {
  episodic: { title: 'Episode', detail: 'What happened in a particular situation' },
  semantic: { title: 'Knowledge', detail: 'Stable facts, patterns, and project meaning' },
  procedural: { title: 'Practice', detail: 'How this project prefers work to be done' }
}

export function MemoryPane({ project }: { project: ProjectRecord }): React.JSX.Element {
  const [memories, setMemories] = useState<AgentMemory[]>([])
  const [query, setQuery] = useState('')
  const [gist, setGist] = useState('')
  const [cues, setCues] = useState('')
  const [kind, setKind] = useState<MemoryKind>('semantic')
  const [saving, setSaving] = useState(false)

  const load = (): void => { void window.conductor.memory.list(project.id).then(setMemories) }
  useEffect(load, [project.id])

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

  const grouped = useMemo(() => memories.reduce<Record<MemoryKind, AgentMemory[]>>((result, memory) => {
    result[memory.kind].push(memory)
    return result
  }, { episodic: [], semantic: [], procedural: [] }), [memories])

  return (
    <div className="memory-pane">
      <header className="memory-heading">
        <div className="memory-mark"><Brain size={22} /></div>
        <div><strong>Living project memory</strong><span>Gist, cues, rehearsal, and time—not transcript hoarding.</span></div>
      </header>
      <div className="memory-search">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void recall() }} placeholder="Recall by idea, file, decision, or situation…" />
        <button onClick={() => void recall()}>Recall</button>
      </div>
      <div className="memory-list">
        {memories.length === 0 && (
          <div className="memory-empty"><Sparkles size={24} /><strong>No memories yet</strong><span>Add the useful gist of a decision or experience below. Agents recall matching memories when you message them.</span></div>
        )}
        {(Object.keys(grouped) as MemoryKind[]).map((memoryKind) => grouped[memoryKind].length > 0 && (
          <section key={memoryKind}>
            <h3>{kindMeta[memoryKind].title}<span>{kindMeta[memoryKind].detail}</span></h3>
            {grouped[memoryKind].map((memory) => (
              <article key={memory.id}>
                <Lightbulb size={15} />
                <div><p>{memory.gist}</p><footer><span>{memory.cues.join(' · ') || 'uncued'}</span><span>strength {memory.strength} · recalled {memory.recallCount}</span></footer></div>
                <button onClick={() => { void window.conductor.memory.remove(memory.id).then(load) }} title="Forget"><Trash2 size={14} /></button>
              </article>
            ))}
          </section>
        ))}
      </div>
      <div className="memory-composer">
        <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
          <option value="semantic">Knowledge</option>
          <option value="episodic">Episode</option>
          <option value="procedural">Practice</option>
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
