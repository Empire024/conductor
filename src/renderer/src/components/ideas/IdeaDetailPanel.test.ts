import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { IdeaDetail, IdeaSection } from '../../../../shared/ideas'
import type { ProjectRecord } from '../../../../shared/models'
import { IdeaBrief, IdeaDetailPanel, IdeaRelatedWork, IdeaTimeline } from './IdeaDetailPanel'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const noop = (): void => undefined

const brief: IdeaSection = {
  id: 's1', ideaId: 'i1', kind: 'brief', title: 'Brief', body: 'raw body', createdAt: '2026-09-24T03:10:00Z',
  createdBy: { kind: 'job', jobId: 'job1', label: 'Qwen on MAIN', model: 'qwen3-14b' },
  brief: { concept: 'A dimmable desk lamp', openQuestions: ['Which LEDs?'], nextStep: 'Sketch the housing', relatedMemoryIds: [], observations: ['Overlaps the lighting task'] }
}

const idea: IdeaDetail = {
  id: 'i1', title: 'Desk lamp', preview: 'dims with the sun', status: 'active', workedOn: true, capturedFrom: 'phone',
  createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-23T08:00:00Z', lastExploredAt: '2026-09-24T03:10:00Z', exploring: false,
  linkCounts: { 'agent-session': 1, project: 1 }, tags: [],
  text: 'Desk lamp\ndims with the sun', originalText: 'Desk lamp',
  links: [
    { id: 'l1', ideaId: 'i1', kind: 'agent-session', targetId: 'sess-1', label: 'Lamp prototype chat', projectId: 'p1', createdAt: '2026-09-23T08:00:00Z', createdFromIdeaId: 'i1' },
    { id: 'l2', ideaId: 'i1', kind: 'project', targetId: 'p1', label: 'Hardware', createdAt: '2026-09-23T08:00:00Z', createdFromIdeaId: 'i1' }
  ],
  events: [
    { id: 'e1', ideaId: 'i1', at: '2026-09-20T08:00:00Z', kind: 'created', message: 'Idea created from phone', actor: { kind: 'owner', label: 'phone Pixel' } },
    { id: 'e2', ideaId: 'i1', at: '2026-09-23T08:00:00Z', kind: 'worked-on', message: 'Claude started working on it', actor: { kind: 'agent', agentSessionId: 'sess-1' } }
  ],
  sections: [brief], explorations: [], latestBrief: brief
}

const projects: ProjectRecord[] = [{ id: 'p1', name: 'Hardware', path: 'C:\\hw', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]

describe('idea detail rendering', () => {
  it('labels a brief as agent-generated with who, model and when', () => {
    const html = renderToStaticMarkup(createElement(IdeaBrief, { section: brief, now: NOW }))
    expect(html).toContain('Agent-generated')
    expect(html).toContain('Qwen on MAIN · qwen3-14b')
    expect(html).toContain('A dimmable desk lamp')
    expect(html).toContain('Which LEDs?')
    expect(html).toContain('Sketch the housing')
    expect(html).not.toContain('raw body')
  })

  it('renders an unstructured brief as preformatted text', () => {
    const html = renderToStaticMarkup(createElement(IdeaBrief, { section: { ...brief, brief: undefined }, now: NOW }))
    expect(html).toContain('<pre class="ideas-brief-body">raw body</pre>')
  })

  it('renders the timeline newest first with actors', () => {
    const html = renderToStaticMarkup(createElement(IdeaTimeline, { events: idea.events, now: NOW }))
    expect(html.indexOf('Claude started working on it')).toBeLessThan(html.indexOf('Idea created from phone'))
    expect(html).toContain('phone Pixel')
    expect(html).toContain('Agent sess-1')
  })

  it('groups related work with provenance and an unlink button', () => {
    const html = renderToStaticMarkup(createElement(IdeaRelatedWork, { links: idea.links, onOpen: noop, onUnlink: noop }))
    expect(html.indexOf('Conversations')).toBeLessThan(html.indexOf('Projects'))
    expect(html).toContain('Lamp prototype chat')
    expect(html).toContain('Created from this idea')
    expect(html).toContain('aria-label="Unlink Lamp prototype chat"')
  })

  it('renders the whole panel: worked on, explored, actions, original note', () => {
    const html = renderToStaticMarkup(createElement(IdeaDetailPanel, {
      idea, projects, now: NOW, busy: null,
      onStatus: noop, onWork: noop, onExplore: noop, onCreateTask: noop, onArchive: noop, onOpenLink: noop, onUnlink: noop
    }))
    expect(html).toContain('Worked on')
    expect(html).toContain('>Yes<')
    expect(html).toContain('Work on this idea')
    expect(html).toContain('Explore with local model')
    expect(html).toContain('Create task')
    expect(html).toContain('Archive')
    expect(html).toContain('Original note')
    expect(html).toContain('Latest brief')
  })
})
