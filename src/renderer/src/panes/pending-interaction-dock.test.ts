import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEventData, PendingInteraction, TimelineItem } from '../../../shared/structured-agent'
import { answerableHere, dockedInteractions } from './pending-interaction-dock'
import { PendingInteractionDock } from './PendingInteractionDock'
import { StructuredActivity } from './StructuredAgentRenderers'

const approval = (id: string, status: PendingInteraction['status'] = 'pending', input: unknown = { command: 'npm test' }): PendingInteraction =>
  ({ id, kind: 'approval', title: 'Run npm test?', status, input, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Deny' }] }) as PendingInteraction
const question: PendingInteraction = { id: 'q', kind: 'question', title: 'Pick a color', status: 'pending', input: {}, choices: [], questions: [{ id: 'color', question: 'Pick a color', options: [{ label: 'Blue' }] }] }
let sequence = 0
const item = (data: AgentEventData, runtimeId = 'live', id = 'item-' + ++sequence): TimelineItem => ({ id, runtimeId, sequence: ++sequence, timestamp: '2026-10-22T05:00:00Z', data })
const tool = (): AgentEventData => ({ type: 'tool', name: 'Bash', status: 'running', input: { command: 'ls' } })

describe('pending interaction dock', () => {
  it('docks every pending request of the live runtime, oldest first, however much followed it', () => {
    const first = item({ type: 'interaction', interaction: approval('a') })
    const later = [...Array.from({ length: 300 }, () => item(tool())), item({ type: 'interaction', interaction: question })]
    const docked = dockedInteractions([first, ...later], 'live', false)
    expect(docked.map(entry => entry.id)).toEqual([first.id, later.at(-1)!.id])
  })

  it('leaves answered, expired and stale-runtime requests out, and docks nothing in a historical view', () => {
    const items = [
      item({ type: 'interaction', interaction: approval('done', 'resolved') }),
      item({ type: 'interaction', interaction: approval('gone', 'expired') }),
      item({ type: 'interaction', interaction: approval('old') }, 'previous-runtime'),
      item({ type: 'interaction', interaction: approval('live') })
    ]
    expect(dockedInteractions(items, 'live', false).map(entry => (entry.data as { interaction: PendingInteraction }).interaction.id)).toEqual(['live'])
    expect(dockedInteractions(items, 'live', true)).toEqual([])
  })

  it('keeps a Codex async question answerable after its runtime ended, as the timeline does', () => {
    const asked = item({ type: 'interaction', interaction: { ...question, input: { protocol: 'codex-async-question' } } }, 'previous-runtime')
    expect(answerableHere(asked, 'live', false)).toBe(true)
    expect(dockedInteractions([asked], 'live', false)).toHaveLength(1)
    expect(answerableHere(item(tool(), 'previous-runtime'), 'live', false)).toBe(false)
  })

  const activity = (entry: TimelineItem, overrides: Partial<ComponentProps<typeof StructuredActivity>> = {}): string =>
    renderToStaticMarkup(createElement(StructuredActivity, { item: entry, sessionId: 'session', cwd: 'C:\\work', expanded: false, interactive: true, onExpand: vi.fn(), onOpenFile: vi.fn(), onDiff: vi.fn(), onRespond: vi.fn(async () => {}), ...overrides }))

  it('renders the dock with the live buttons and a heading that names what waits', () => {
    const entries = [item({ type: 'interaction', interaction: approval('a') }), item({ type: 'interaction', interaction: approval('b') })]
    const html = renderToStaticMarkup(createElement(PendingInteractionDock, { items: entries, reveal: 0, render: entry => createElement(StructuredActivity, { item: entry, sessionId: 'session', cwd: 'C:\\work', expanded: false, interactive: true, onExpand: vi.fn(), onOpenFile: vi.fn(), onDiff: vi.fn(), onRespond: vi.fn(async () => {}) }) }))
    expect(html).toContain('data-interaction-dock="2"')
    expect(html).toContain('2 approvals waiting')
    expect(html.match(/Allow once<\/button>/g)).toHaveLength(2)
    const mixed = renderToStaticMarkup(createElement(PendingInteractionDock, { items: [entries[0]!, item({ type: 'interaction', interaction: question })], reveal: 0, render: () => null }))
    expect(mixed).toContain('2 requests waiting')
    expect(renderToStaticMarkup(createElement(PendingInteractionDock, { items: [], reveal: 3, render: () => null }))).toBe('')
  })

  it('marks the timeline row of a docked request without a second set of buttons', () => {
    const entry = item({ type: 'interaction', interaction: approval('a') })
    const row = activity(entry, { answerInDock: true, onRevealDock: vi.fn() })
    expect(row).toContain('sa-interaction-in-dock')
    expect(row).toContain('Waiting for your approval above the message box')
    expect(row).toContain('Show</button>')
    expect(row).not.toContain('Allow once</button>')
    // Answered, or not answerable from here: the row is the ordinary card again.
    expect(activity(item({ type: 'interaction', interaction: approval('r', 'resolved') }), { answerInDock: true })).not.toContain('sa-interaction-in-dock')
    expect(activity(entry, { answerInDock: true, interactive: false })).not.toContain('sa-interaction-in-dock')
  })
})
