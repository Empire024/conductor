import { afterEach, describe, expect, it } from 'vitest'
import { IdeaStore } from './store'

const OWNER = { kind: 'owner' as const }
let clock = new Date('2026-09-20T10:00:00.000Z')
const stores: IdeaStore[] = []
const open = (): IdeaStore => { const store = new IdeaStore(':memory:', () => clock); stores.push(store); return store }
const advance = (minutes: number): void => { clock = new Date(clock.getTime() + minutes * 60_000) }

afterEach(() => { for (const store of stores.splice(0)) store.close(); clock = new Date('2026-09-20T10:00:00.000Z') })

describe('IdeaStore', () => {
  it('captures a note into the inbox with an inferred title and a created event', () => {
    const store = open()
    const idea = store.capture({ text: '  Clothing drops by city\nonly buyable while there', source: 'phone' }, OWNER)
    expect(idea).toMatchObject({ title: 'Clothing drops by city', preview: 'only buyable while there', status: 'inbox', workedOn: false, capturedFrom: 'phone', originalText: idea.text })
    expect(idea.events.map(event => [event.kind, event.message])).toEqual([['created', 'Idea created from phone']])
    expect(() => store.capture({ text: '   \n ' }, OWNER)).toThrow(/empty/)
  })

  it('keeps the original text of the first sitting and never rewrites it later', () => {
    const store = open()
    const idea = store.capture({ text: 'jam' }, OWNER)
    advance(2)
    expect(store.update(idea.id, { text: 'jam company' }, OWNER).originalText).toBe('jam company')
    advance(15)
    const later = store.update(idea.id, { text: 'Premium jam company with seasonal fruit' }, OWNER)
    expect(later).toMatchObject({ originalText: 'jam company', text: 'Premium jam company with seasonal fruit', title: 'Premium jam company with seasonal fruit' })
  })

  it('coalesces autosaves into one edited event per half hour', () => {
    const store = open()
    const idea = store.capture({ text: 'a' }, OWNER)
    for (let index = 0; index < 5; index += 1) { advance(1); store.update(idea.id, { text: `a${index}` }, OWNER) }
    advance(40)
    store.update(idea.id, { text: 'b' }, OWNER)
    expect(store.get(idea.id).events.filter(event => event.kind === 'edited')).toHaveLength(2)
  })

  it('records status changes and lists without archived ideas by default', () => {
    const store = open()
    const kept = store.capture({ text: 'kept' }, OWNER)
    const gone = store.capture({ text: 'gone' }, OWNER)
    store.update(gone.id, { status: 'archived' }, OWNER)
    expect(store.list().map(idea => idea.id)).toEqual([kept.id])
    expect(store.list({ statuses: ['archived'] }).map(idea => idea.id)).toEqual([gone.id])
    expect(store.get(gone.id).events[0]).toMatchObject({ kind: 'status', message: 'Marked Archived' })
    expect(() => store.update(kept.id, { status: 'bogus' as never }, OWNER)).toThrow(/status/)
  })

  it('links related work with provenance, once per target, and marks the idea worked on', () => {
    const store = open()
    const idea = store.capture({ text: 'Invoice parser' }, OWNER)
    const link = store.link(idea.id, { kind: 'agent-session', targetId: 'agent_1', label: 'Claude: parser', projectId: 'project_1', createdFromIdeaId: idea.id, createdByAgentSessionId: 'agent_1' }, OWNER, { workedOn: true })
    store.link(idea.id, { kind: 'agent-session', targetId: 'agent_1', label: 'Claude: parser v2' }, OWNER)
    const detail = store.get(idea.id)
    expect(detail.links).toHaveLength(1)
    expect(detail.links[0]).toMatchObject({ id: link.id, label: 'Claude: parser v2', createdFromIdeaId: idea.id, createdByAgentSessionId: 'agent_1', projectId: 'project_1' })
    expect(detail).toMatchObject({ workedOn: true, status: 'active', linkCounts: { 'agent-session': 1 } })
    expect(detail.events.map(event => event.kind)).toContain('worked-on')
    const unlinked = store.unlink(idea.id, link.id, OWNER)
    expect(unlinked.links).toHaveLength(0)
    expect(unlinked.workedOn).toBe(true)
  })

  it('keeps agent sections apart from the owner text and exposes the latest brief', () => {
    const store = open()
    const idea = store.capture({ text: 'fashion thing' }, OWNER)
    store.addSection(idea.id, { kind: 'brief', title: 'Idea brief', body: 'v1', brief: { concept: 'City drops', openQuestions: ['Cost?'], nextStep: 'Prague', relatedMemoryIds: [], observations: [] }, createdBy: { kind: 'job', jobId: 'job_1', model: 'qwen' } })
    advance(1)
    store.addSection(idea.id, { kind: 'brief', title: 'Idea brief', body: 'v2', createdBy: { kind: 'job', jobId: 'job_2' } })
    const detail = store.get(idea.id)
    expect(detail.text).toBe('fashion thing')
    expect(detail.latestBrief?.body).toBe('v2')
    expect(detail.sections[1]?.brief?.concept).toBe('City drops')
  })

  it('searches the note, tags, sections and link labels', () => {
    const store = open()
    const idea = store.capture({ text: 'Something about shirts' }, OWNER)
    store.capture({ text: 'Unrelated' }, OWNER)
    store.addSection(idea.id, { kind: 'brief', title: 'Brief', body: 'A clothing brand', createdBy: { kind: 'job' } })
    expect(store.list({ search: 'clothing' }).map(row => row.id)).toEqual([idea.id])
    expect(store.list({ search: 'SHIRTS' }).map(row => row.id)).toEqual([idea.id])
    expect(store.list({ search: '100%' })).toEqual([])
  })

  it('tracks explorations, restores the prior status and picks untouched incubator candidates', () => {
    const store = open()
    const old = store.capture({ text: 'Old untouched idea' }, OWNER)
    advance(5)
    const fresh = store.capture({ text: 'Being typed right now' }, OWNER)
    const worked = store.capture({ text: 'Worked idea' }, OWNER)
    store.link(worked.id, { kind: 'task', targetId: 'p:t', label: 'Task' }, OWNER, { workedOn: true })
    store.capture({ text: 'x' }, OWNER)
    advance(6)
    expect(store.incubatorCandidates(5).map(idea => idea.id)).toEqual([old.id])
    advance(10)
    expect(store.incubatorCandidates(5).map(idea => idea.id)).toEqual([old.id, fresh.id])

    const exploration = store.startExploration({ ideaId: old.id, jobId: 'job_1', projectId: 'project_1', model: 'qwen', intensity: 'light', trigger: 'incubator' })
    expect(store.get(old.id)).toMatchObject({ status: 'exploring', exploring: true })
    expect(store.incubatorCandidates(5).map(idea => idea.id)).toEqual([fresh.id])
    expect(store.explorationsStartedSince(new Date(clock.getTime() - 60_000).toISOString(), 'incubator')).toBe(1)
    store.finishExploration(exploration.id, 'completed')
    const after = store.get(old.id)
    expect(after).toMatchObject({ status: 'inbox', exploring: false, workedOn: false })
    expect(after.lastExploredAt).toBeTruthy()
    expect(store.runningExplorations()).toEqual([])
    expect(store.incubatorCandidates(5).map(idea => idea.id)).toEqual([fresh.id])
  })

  it('stores incubator settings with defaults and bounds', () => {
    const store = open()
    expect(store.incubatorSettings()).toEqual({ enabled: true, maxPerNight: 3, intensity: 'light' })
    expect(store.setIncubatorSettings({ maxPerNight: 99, intensity: 'explore' })).toEqual({ enabled: true, maxPerNight: 10, intensity: 'explore' })
    expect(() => store.setIncubatorSettings({ intensity: 'develop' as never })).toThrow(/intensity/)
  })

  it('notifies listeners of changes', () => {
    const store = open()
    const seen: Array<string | null> = []
    store.onChange(change => seen.push(change.ideaId))
    const idea = store.capture({ text: 'hello' }, OWNER)
    store.update(idea.id, { tags: ['a'] }, OWNER)
    expect(seen).toEqual([idea.id, idea.id])
  })
})
