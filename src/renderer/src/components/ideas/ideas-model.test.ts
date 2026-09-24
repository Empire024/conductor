import { describe, expect, it, vi } from 'vitest'
import type { IdeaDetail, IdeaLink, IdeaSection } from '../../../../shared/ideas'
import {
  IdeaAutosave, briefView, clampMaxPerNight, defaultProjectId, exploredLine, groupIdeaLinks, ideaListQuery, ideaProgress,
  ideaErrorMessage, linkCountsLine, linkProvenance, relativeAge, sectionAuthorLine, showOriginalText, timelineEvents, workedOnLine, actorLabel
} from './ideas-model'

const NOW = Date.parse('2026-09-24T12:00:00Z')

function detail(id: string, text: string, extra: Partial<IdeaDetail> = {}): IdeaDetail {
  return {
    id, title: text.split('\n')[0] ?? '', preview: '', status: 'inbox', workedOn: false, capturedFrom: 'desktop',
    createdAt: '2026-09-24T11:00:00Z', updatedAt: '2026-09-24T11:00:00Z', exploring: false, linkCounts: {}, tags: [],
    text, originalText: text, links: [], events: [], sections: [], explorations: [], ...extra
  }
}

function link(kind: IdeaLink['kind'], targetId: string, createdAt: string, extra: Partial<IdeaLink> = {}): IdeaLink {
  return { id: `${kind}:${targetId}`, ideaId: 'i1', kind, targetId, label: targetId, createdAt, ...extra }
}

describe('list query', () => {
  it('asks for every status except archived by default and trims the search', () => {
    expect(ideaListQuery('active', '  ')).toEqual({ limit: 500 })
    expect(ideaListQuery('active', ' lamp ')).toEqual({ limit: 500, search: 'lamp' })
  })
  it('narrows to one status', () => {
    expect(ideaListQuery('archived', '')).toEqual({ limit: 500, statuses: ['archived'] })
  })
})

describe('relative ages', () => {
  it('labels recent and old times compactly', () => {
    expect(relativeAge('2026-09-24T11:59:40Z', NOW)).toBe('just now')
    expect(relativeAge('2026-09-24T11:55:00Z', NOW)).toBe('5 min')
    expect(relativeAge('2026-09-24T09:00:00Z', NOW)).toBe('3 h')
    expect(relativeAge('2026-09-23T09:00:00Z', NOW)).toBe('yesterday')
    expect(relativeAge('2026-09-20T12:00:00Z', NOW)).toBe('4 d')
    expect(relativeAge('2026-09-03T12:00:00Z', NOW)).toBe('3 wk')
    expect(relativeAge('2026-03-12T12:00:00Z', NOW)).toBe('12 Mar')
    expect(relativeAge('2025-03-12T12:00:00Z', NOW)).toBe('12 Mar 2025')
  })
  it('tolerates missing, invalid and future times', () => {
    expect(relativeAge(undefined, NOW)).toBe('')
    expect(relativeAge('nope', NOW)).toBe('')
    expect(relativeAge('2026-09-25T12:00:00Z', NOW)).toBe('just now')
  })
})

describe('worked on and explored', () => {
  it('prefers worked on over explored over never touched', () => {
    expect(ideaProgress({ workedOn: true, lastExploredAt: '2026-09-01T00:00:00Z' })).toEqual({ label: 'Worked on', tone: 'worked' })
    expect(ideaProgress({ workedOn: false, lastExploredAt: '2026-09-01T00:00:00Z' })).toEqual({ label: 'Explored', tone: 'explored' })
    expect(ideaProgress({ workedOn: false })).toEqual({ label: 'Never touched', tone: 'untouched' })
  })
  it('says yes/no and the explored date or never', () => {
    expect(workedOnLine({ workedOn: true })).toBe('Yes')
    expect(workedOnLine({ workedOn: false })).toBe('No')
    expect(exploredLine({ exploring: false }, NOW)).toBe('never')
    expect(exploredLine({ exploring: false, lastExploredAt: '2026-09-02T03:00:00Z' }, NOW)).toMatch(/^2 Sept?$/)
    expect(exploredLine({ exploring: true }, NOW)).toBe('exploring now')
  })
  it('shows the original note only when the text moved away from it', () => {
    expect(showOriginalText({ text: 'a lamp\n', originalText: 'a lamp' })).toBe(false)
    expect(showOriginalText({ text: 'a better lamp', originalText: 'a lamp' })).toBe(true)
    expect(showOriginalText({ text: 'x', originalText: '' })).toBe(false)
  })
  it('defaults the project to the linked one, else the first', () => {
    const idea = detail('i1', 'x', { links: [link('task', 'p2:t1', '2026-09-01T00:00:00Z', { projectId: 'p2' })] })
    expect(defaultProjectId(idea, ['p1', 'p2'])).toBe('p2')
    expect(defaultProjectId(detail('i1', 'x', { links: [link('project', 'p3', '2026-09-01T00:00:00Z')] }), ['p1', 'p3'])).toBe('p3')
    expect(defaultProjectId(null, ['p1'])).toBe('p1')
    expect(defaultProjectId(null, [])).toBe('')
  })
})

describe('links', () => {
  it('groups by kind in a fixed order, newest first, dropping empty groups', () => {
    const groups = groupIdeaLinks([
      link('project', 'p1', '2026-09-01T00:00:00Z'),
      link('agent-session', 's1', '2026-09-02T00:00:00Z'),
      link('agent-session', 's2', '2026-09-03T00:00:00Z'),
      link('memory', 'm1', '2026-09-01T00:00:00Z')
    ])
    expect(groups.map(group => group.label)).toEqual(['Conversations', 'Memories', 'Projects'])
    expect(groups[0]!.links.map(item => item.targetId)).toEqual(['s2', 's1'])
  })
  it('describes provenance', () => {
    expect(linkProvenance(link('task', 't', '2026-09-01T00:00:00Z', { createdFromIdeaId: 'i1' }))).toBe('Created from this idea')
    expect(linkProvenance(link('artifact', 'a', '2026-09-01T00:00:00Z', { createdByAgentSessionId: 'session-123456789' }))).toBe('By conversation session-')
    expect(linkProvenance(link('memory', 'm', '2026-09-01T00:00:00Z', { createdFromIdeaId: 'i1', createdByJobId: 'job42' }))).toBe('Created from this idea · by job job42')
    expect(linkProvenance(link('project', 'p', '2026-09-01T00:00:00Z'))).toBe('Linked by the owner')
  })
  it('summarizes link counts', () => {
    expect(linkCountsLine({ task: 1, 'agent-session': 2, memory: 0 })).toBe('2 conversations · 1 task')
    expect(linkCountsLine({})).toBe('')
  })
})

describe('timeline and briefs', () => {
  it('sorts events newest first and labels actors', () => {
    const events = timelineEvents([
      { id: 'a', ideaId: 'i1', at: '2026-09-01T00:00:00Z', kind: 'created', message: 'Created', actor: { kind: 'owner' } },
      { id: 'b', ideaId: 'i1', at: '2026-09-03T00:00:00Z', kind: 'explored', message: 'Explored', actor: { kind: 'job', jobId: 'job-1' } }
    ])
    expect(events.map(event => event.id)).toEqual(['b', 'a'])
    expect(actorLabel({ kind: 'owner' })).toBe('You')
    expect(actorLabel({ kind: 'agent', label: ' Qwen on MAIN ' })).toBe('Qwen on MAIN')
    expect(actorLabel({ kind: 'conductor' })).toBe('Conductor')
  })
  const section: IdeaSection = {
    id: 's', ideaId: 'i1', kind: 'brief', title: 'Brief', body: '## Concept\nA lamp', createdAt: '2026-09-24T03:10:00Z',
    createdBy: { kind: 'job', jobId: 'job1', label: 'Qwen on MAIN', model: 'qwen3-14b' }
  }
  it('prefers the structured brief and drops blank entries', () => {
    const view = briefView({ ...section, brief: { concept: ' A lamp ', openQuestions: ['Why?', ' '], nextStep: 'Sketch it', relatedMemoryIds: ['m1'], observations: [] } })
    expect(view).toEqual({ kind: 'structured', concept: 'A lamp', openQuestions: ['Why?'], nextStep: 'Sketch it', observations: [], relatedMemoryIds: ['m1'] })
  })
  it('falls back to the body when the brief is missing or empty', () => {
    expect(briefView(section)).toEqual({ kind: 'body', body: '## Concept\nA lamp' })
    expect(briefView({ ...section, brief: { concept: '', openQuestions: [], nextStep: '', relatedMemoryIds: [], observations: [] } }).kind).toBe('body')
  })
  it('names who wrote a section, with what, and when', () => {
    expect(sectionAuthorLine(section, NOW)).toMatch(/^Written by Qwen on MAIN · qwen3-14b · 24 Sept?, \d\d:\d\d$/)
  })
})

describe('error messages', () => {
  it('strips the IPC wrapper', () => {
    expect(ideaErrorMessage(new Error("Error invoking remote method 'ideas:explore': Error: No local model is configured."))).toBe('No local model is configured.')
    expect(ideaErrorMessage('plain')).toBe('plain')
    expect(ideaErrorMessage(new Error(''))).toBe('Something went wrong.')
  })
})

describe('incubator settings', () => {
  it('clamps max per night to 1..10', () => {
    expect(clampMaxPerNight(0)).toBe(1)
    expect(clampMaxPerNight(4.4)).toBe(4)
    expect(clampMaxPerNight(99)).toBe(10)
    expect(clampMaxPerNight(Number.NaN)).toBe(1)
  })
})

describe('autosave', () => {
  function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  function harness(id: string | null = null, text = '') {
    const calls: Array<{ op: 'capture' | 'update'; id?: string; text: string; done: ReturnType<typeof deferred<IdeaDetail>> }> = []
    const timers: Array<{ callback: () => void; cleared: boolean }> = []
    const saved: Array<{ id: string; created: boolean; text: string }> = []
    const states: string[] = []
    const saver = new IdeaAutosave({
      capture: (value) => { const done = deferred<IdeaDetail>(); calls.push({ op: 'capture', text: value, done }); return done.promise },
      update: (ideaId, value) => { const done = deferred<IdeaDetail>(); calls.push({ op: 'update', id: ideaId, text: value, done }); return done.promise }
    }, id, text, {
      onSaved: (value, info) => saved.push({ id: value.id, created: info.created, text: info.text }),
      onState: state => states.push(state),
      setTimer: (callback) => { const timer = { callback, cleared: false }; timers.push(timer); return timer },
      clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true }
    })
    const fire = (): void => { const timer = timers.filter(item => !item.cleared).at(-1); timer!.cleared = true; timer!.callback() }
    const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }
    return { saver, calls, timers, saved, states, fire, settle }
  }

  it('never creates an empty idea', async () => {
    const h = harness()
    h.saver.edit('   \n ')
    expect(h.timers).toHaveLength(0)
    await h.saver.flush()
    expect(h.calls).toHaveLength(0)
  })

  it('captures on the first real text after the debounce, then updates', async () => {
    const h = harness()
    h.saver.edit('A')
    h.saver.edit('A lamp')
    expect(h.timers.filter(timer => !timer.cleared)).toHaveLength(1)
    h.fire()
    expect(h.calls).toMatchObject([{ op: 'capture', text: 'A lamp' }])
    h.calls[0]!.done.resolve(detail('i1', 'A lamp'))
    await h.settle()
    expect(h.saver.ideaId).toBe('i1')
    expect(h.saved).toEqual([{ id: 'i1', created: true, text: 'A lamp' }])
    h.saver.edit('A lamp that dims')
    h.fire()
    expect(h.calls[1]).toMatchObject({ op: 'update', id: 'i1', text: 'A lamp that dims' })
  })

  it('serializes saves and ends on the newest text when typing races a save', async () => {
    const h = harness()
    h.saver.edit('One')
    h.fire()
    h.saver.edit('One two')
    const flushed = h.saver.flush()
    // Only the capture is in flight; the newer text waits for the id rather than creating twice.
    expect(h.calls).toHaveLength(1)
    h.calls[0]!.done.resolve(detail('i1', 'One'))
    await h.settle()
    expect(h.calls[1]).toMatchObject({ op: 'update', id: 'i1', text: 'One two' })
    expect(h.saver.dirty).toBe(true)
    h.calls[1]!.done.resolve(detail('i1', 'One two'))
    await flushed
    expect(h.calls.filter(call => call.op === 'capture')).toHaveLength(1)
    expect(h.saver.dirty).toBe(false)
    expect(h.saver.text).toBe('One two')
  })

  it('refuses server text while local edits are pending or in flight, accepts it when clean', async () => {
    const h = harness('i1', 'Hello')
    expect(h.saver.acceptServerText('Hello from phone')).toBe(true)
    expect(h.saver.text).toBe('Hello from phone')
    h.saver.edit('Hello from phone!')
    expect(h.saver.acceptServerText('stale')).toBe(false)
    h.fire()
    expect(h.saver.acceptServerText('stale')).toBe(false)
    h.calls[0]!.done.resolve(detail('i1', 'Hello from phone!'))
    await h.settle()
    expect(h.saver.acceptServerText('Hello from phone!')).toBe(true)
    expect(h.saver.text).toBe('Hello from phone!')
  })

  it('drops a server read that started before a later keystroke or save', async () => {
    const h = harness('i1', 'Old')
    const before = h.saver.revision
    h.saver.edit('Old and new')
    h.fire()
    h.calls[0]!.done.resolve(detail('i1', 'Old and new'))
    await h.settle()
    // The read began before the save landed, so its "Old" is stale even though nothing is pending now.
    expect(h.saver.acceptServerText('Old', before)).toBe(false)
    expect(h.saver.text).toBe('Old and new')
    expect(h.saver.acceptServerText('Old and new', h.saver.revision)).toBe(true)
  })

  it('does not save an existing note emptied to whitespace', async () => {
    const h = harness('i1', 'Hello')
    h.saver.edit('  ')
    await h.saver.flush()
    expect(h.calls).toHaveLength(0)
    expect(h.saver.dirty).toBe(true)
  })

  it('reports a failed save, keeps the text dirty, and retries on flush', async () => {
    const errors: unknown[] = []
    const update = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (id: string, text: string) => detail(id, text))
    const saver = new IdeaAutosave({ capture: vi.fn(), update }, 'i1', 'a', { onError: error => errors.push(error), setTimer: () => 1, clearTimer: () => undefined })
    saver.edit('ab')
    await saver.flush()
    expect(errors).toHaveLength(1)
    expect(saver.dirty).toBe(true)
    expect(saver.acceptServerText('a')).toBe(false)
    await saver.flush()
    expect(update).toHaveBeenCalledTimes(2)
    expect(saver.dirty).toBe(false)
  })
})
