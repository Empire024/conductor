import { describe, expect, it } from 'vitest'
import type { AgentEventData, TimelineItem } from '../../../shared/structured-agent'
import { conversationLinks, deliveredLinks, deliveredSignature, itemLinks, lastParagraph, unansweredQuestion, type LinkContext } from './conversation-links'

const context: LinkContext = { cwd: 'C:\\work\\app', projectId: 'project-app', projects: [{ id: 'project-app', path: 'C:\\work\\app' }, { id: 'project-docs', path: 'C:\\work\\docs' }] }
let sequence = 0
const item = (data: AgentEventData, extra: Partial<TimelineItem> = {}): TimelineItem => ({ id: 'item-' + ++sequence, runtimeId: 'runtime', sequence, timestamp: '2026-10-18T00:00:00Z', data, ...extra })
const said = (text: string, role: Extract<AgentEventData, { type: 'text' }>['role'] = 'assistant', extra: Partial<Extract<AgentEventData, { type: 'text' }>> = {}): AgentEventData => ({ type: 'text', role, text, mode: 'snapshot', ...extra })

describe('a conversation\'s links and files (feature-list e90b679f)', () => {
  it('reads URLs, Markdown links and file mentions from an agent message', () => {
    const message = item(said('See [the release](https://github.com/Empire024/conductor/releases/tag/v1.2) and https://example.com/docs/setup.\nI changed `src/main/index.ts:42` and [notes](docs/notes.md); the old one is C:\\work\\docs\\guide.md.'))
    const links = itemLinks(message, context)
    expect(links.map(link => [link.kind, link.label])).toEqual([
      ['url', 'the release'],
      ['file', 'notes.md'],
      ['url', 'example.com/docs/setup'],
      ['file', 'index.ts'],
      ['file', 'guide.md']
    ])
    expect(links[0]).toMatchObject({ url: 'https://github.com/Empire024/conductor/releases/tag/v1.2', itemId: message.id, source: 'message' })
    // Explicit links are trusted as the message renders them; a prose mention waits for the stat check.
    expect(links[1]!.candidate).toBeUndefined()
    expect(links[3]).toMatchObject({ path: 'src/main/index.ts', line: 42, projectId: 'project-app' })
    expect(links[3]!.candidate).toBeDefined()
    // A file in another open project belongs to that project.
    expect(links[4]).toMatchObject({ path: 'guide.md', projectId: 'project-docs' })
  })
  it('ignores unsafe and non-web URLs, and does not read a URL as a path', () => {
    const links = itemLinks(item(said('Try javascript:alert(1), ftp://host/file.txt, https://user:pw@host.example/x and https://ok.example/page.html')), context)
    expect(links.filter(link => link.kind === 'url').map(link => link.url)).toEqual(['https://ok.example/page.html'])
    expect(links.some(link => link.kind === 'file' && link.path?.includes('page.html'))).toBe(false)
  })
  it('takes files an edit tool or a change set wrote, and attachments, but not reads, failures or deletions', () => {
    expect(itemLinks(item({ type: 'tool', name: 'Edit', status: 'completed', input: { file_path: 'C:\\work\\app\\src\\a.ts' } }), context)).toMatchObject([{ path: 'src/a.ts', source: 'edit' }])
    expect(itemLinks(item({ type: 'tool', name: 'Edit', status: 'failed', input: { file_path: 'src/a.ts' } }), context)).toEqual([])
    expect(itemLinks(item({ type: 'tool', name: 'Read', status: 'completed', input: { file_path: 'src/b.ts' } }), context)).toEqual([])
    expect(itemLinks(item({ type: 'changes', changes: [{ path: 'src/c.ts', kind: 'update', status: 'applied' }, { path: 'src/gone.ts', kind: 'delete', status: 'applied' }, { path: 'src/no.ts', kind: 'add', status: 'rejected' }] }), context).map(link => link.path)).toEqual(['src/c.ts'])
    expect(itemLinks(item(said('Look at this', 'user', { attachments: [{ id: 'a', kind: 'file', name: 'spec.md', path: 'docs/spec.md', startLine: 3 }] })), context)).toMatchObject([{ label: 'spec.md', path: 'docs/spec.md', line: 3, source: 'attachment' }])
  })
  it('reads the owner\'s own words only for attachments; a coordinating agent\'s message counts as agent text', () => {
    expect(itemLinks(item(said('my link https://mine.example', 'user')), context)).toEqual([])
    expect(itemLinks(item(said('from the controller: https://ctl.example', 'user', { origin: { agentSessionId: 'ctl', label: 'Wizard' } })), context)).toMatchObject([{ url: 'https://ctl.example' }])
    expect(itemLinks(item(said('thinking about https://status.example', 'status')), context)).toEqual([])
  })
  it('lists each link once, at its newest mention, newest first, and bounded', () => {
    const items = [
      item(said('Old: https://a.example and https://b.example')),
      item({ type: 'tool', name: 'Write', status: 'completed', input: { file_path: 'src/x.ts' } }),
      item(said('Again https://a.example'))
    ]
    const links = conversationLinks(items, context)
    expect(links.map(link => link.url ?? link.path)).toEqual(['https://a.example', 'src/x.ts', 'https://b.example'])
    expect(links[0]!.itemId).toBe(items[2]!.id)
    expect(conversationLinks(items, context, 2)).toHaveLength(2)
  })
  it('reads an unchanged item once, and a changed (new) item again', () => {
    const first = item(said('https://one.example'))
    const before = conversationLinks([first], context)
    expect(conversationLinks([first], context)[0]).toBe(before[0])
    const streamed: TimelineItem = { ...first, data: said('https://one.example and https://two.example') }
    expect(conversationLinks([streamed], context).map(link => link.url)).toEqual(['https://one.example', 'https://two.example'])
  })
})

describe('the question the agent ended its turn with', () => {
  const ended = (text: string): TimelineItem => item(said(text))
  it('is the last paragraph of a settled turn\'s reply when it ends with a question mark', () => {
    const reply = ended('I updated the parser.\n\nShould I also update the **docs**?')
    expect(unansweredQuestion([item(said('Fix it', 'user')), reply], 'completed')).toEqual({ itemId: reply.id, text: 'Should I also update the **docs**?' })
  })
  it('is nothing while the turn runs, once the owner replied, when the reply is not a question, or for a nested agent', () => {
    const reply = ended('Want me to continue?')
    expect(unansweredQuestion([reply], 'running')).toBeNull()
    expect(unansweredQuestion([reply, item(said('yes', 'user'))], 'completed')).toBeNull()
    expect(unansweredQuestion([ended('Is it fixed? Yes, all tests pass.')], 'completed')).toBeNull()
    expect(unansweredQuestion([reply, item(said('Shall I?'), { parentId: 'tool-1' })], 'idle')).toEqual({ itemId: reply.id, text: 'Want me to continue?' })
  })
  it('skips status lines and tool output after the reply, and ignores a question inside a code block', () => {
    const reply = ended('Done. Should I push it?')
    expect(unansweredQuestion([reply, item(said('thinking', 'status')), item({ type: 'usage', source: 'provider', outputTokens: 3 })], 'completed')).toMatchObject({ itemId: reply.id })
    expect(lastParagraph('Here:\n\n```\nwhy?\n```')).toBe('Here:')
  })
})

describe('the files the latest turn delivered (feature-list delivered-outputs-highlight)', () => {
  const owner = (text: string): TimelineItem => item(said(text, 'user'))
  const reply = (text: string, extra: Partial<TimelineItem> = {}): TimelineItem => item(said(text), extra)
  it('takes every file link of the latest delivering turn, in posting order, with the exact path', () => {
    const items = [
      owner('Make the logos'),
      reply('Working on it; first draft in `out/draft.png`.'),
      item({ type: 'tool', name: 'Write', status: 'completed', input: { file_path: 'out/logo.pdf' } }),
      reply('Done: [the logo](<C:/work/app/output/owner picks/HAF Logo.pdf>) and :codex-file-citation{path="C:\\work\\app\\output\\logos.zip" purpose="output"}. See https://example.com/brief.')
    ]
    const { links, candidates } = deliveredLinks(items, context)
    expect(links.map(link => link.absolutePath)).toEqual(['C:/work/app/out/draft.png', 'C:/work/app/output/owner picks/HAF Logo.pdf', 'C:/work/app/output/logos.zip'])
    expect(links[1]).toMatchObject({ path: 'output/owner picks/HAF Logo.pdf', projectId: 'project-app', itemId: items[3]!.id })
    // The edit tool's file is not a delivery, and a URL is not a file.
    expect(links.some(link => link.path === 'out/logo.pdf' || link.kind === 'url')).toBe(false)
    expect(candidates.map(candidate => candidate.path)).toEqual(['out/draft.png'])
    // A prose mention waits for its stat check.
    expect(deliveredLinks(items, context, link => !link.candidate).links.map(link => link.label)).toEqual(['HAF Logo.pdf', 'logos.zip'])
  })
  it('keeps the last delivering turn after a reply that delivered nothing, and ends a turn at a coordinating agent\'s message', () => {
    const delivered = reply('Here: C:\\work\\app\\output\\report.pdf')
    expect(deliveredLinks([owner('report please'), delivered, owner('thanks'), reply('You are welcome.')], context).links.map(link => link.absolutePath)).toEqual(['C:/work/app/output/report.pdf'])
    const fromController = item(said('[spec](docs/spec.md)', 'user', { origin: { agentSessionId: 'ctl', label: 'Wizard' } }))
    const next = reply('[notes](docs/notes.md)')
    expect(deliveredLinks([delivered, fromController, next], context).links.map(link => link.path)).toEqual(['docs/notes.md'])
    expect(deliveredLinks([delivered, fromController], context).links.map(link => link.itemId)).toEqual([delivered.id])
  })
  it('ignores nested agents and files outside every open project; the signature names the newest message and its files', () => {
    expect(deliveredLinks([owner('go'), reply('[x](C:/work/app/x.pdf)', { parentId: 'tool-1' })], context).links).toEqual([])
    expect(deliveredLinks([owner('go'), reply('[x](C:/elsewhere/x.pdf)')], context).links).toEqual([])
    const first = deliveredLinks([owner('go'), reply('[a](C:/work/app/a.pdf)')], context).links
    const second = deliveredLinks([owner('go'), reply('[a](C:/work/app/a.pdf)'), reply('[b](C:/work/app/b.zip)')], context).links
    expect(deliveredSignature(first)).not.toBe('')
    expect(deliveredSignature(second)).not.toBe(deliveredSignature(first))
    expect(deliveredSignature([])).toBe('')
  })
})
