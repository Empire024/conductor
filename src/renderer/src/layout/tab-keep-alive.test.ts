import { describe, expect, it } from 'vitest'
import type { PaneTab } from '../../../shared/models'
import { TAB_VIEW_POOL_SIZE, isStructuredConversationTab, mountedTabIds, suspendedConversationSpec, tabViewRetention, touchRecentTabs } from './tab-keep-alive'

const agent = (id: string, state: Record<string, unknown> = { provider: 'codex' }): PaneTab => ({ id, kind: 'agent', title: 'Agent ' + id, resourceId: 'agent-' + id, state })
const tab = (id: string, kind: PaneTab['kind']): PaneTab => ({ id, kind, title: kind + ' ' + id, resourceId: kind === 'terminal' ? 'terminal-' + id : undefined })

describe('tab view retention', () => {
  it('suspends structured conversations and keeps terminal, editor and panel views mounted', () => {
    expect(tabViewRetention(agent('a'))).toBe('suspend')
    expect(tabViewRetention(agent('b', { provider: 'claude' }))).toBe('suspend')
    expect(tabViewRetention(agent('c', {}))).toBe('suspend')
    // A conversation shown as its native CLI, a PTY-only provider and an archived-dormant tab are
    // terminals or placeholders, not the structured pane.
    expect(tabViewRetention(agent('d', { provider: 'claude', viewMode: 'cli' }))).toBe('always')
    expect(tabViewRetention(agent('e', { provider: 'gemini' }))).toBe('always')
    expect(tabViewRetention(agent('f', { provider: 'codex', archiveDormant: true }))).toBe('always')
    expect(isStructuredConversationTab({ ...agent('g'), resourceId: undefined })).toBe(false)
    for (const kind of ['terminal', 'code', 'launcher', 'file-tree', 'tasks', 'job'] as const) expect(tabViewRetention(tab('x', kind))).toBe('always')
    expect(tabViewRetention(tab('p', 'preview'))).toBe('pool')
    expect(tabViewRetention(tab('w', 'browser'))).toBe('pool')
  })

  it('mounts only the active conversation of a group full of them', () => {
    const tabs = Array.from({ length: 25 }, (_, index) => agent(String(index)))
    const recent = ['3', '7', '0']
    expect([...mountedTabIds(tabs, '3', recent)]).toEqual(['3'])
  })

  it('keeps terminals and editors mounted and the most recent previews in a bounded pool', () => {
    const previews = Array.from({ length: TAB_VIEW_POOL_SIZE + 2 }, (_, index) => tab('p' + index, 'preview'))
    const tabs = [agent('a'), tab('t', 'terminal'), tab('c', 'code'), ...previews]
    const recent = ['a', ...previews.map(item => item.id)]
    const mounted = mountedTabIds(tabs, 'a', recent)
    expect(mounted.has('t') && mounted.has('c')).toBe(true)
    expect(previews.filter(item => mounted.has(item.id)).map(item => item.id)).toEqual(previews.slice(0, TAB_VIEW_POOL_SIZE).map(item => item.id))
    expect(mounted.size).toBe(3 + TAB_VIEW_POOL_SIZE)
  })

  it('tracks selection order without churning when nothing changed', () => {
    const ids = new Set(['a', 'b', 'c'])
    const first = touchRecentTabs([], 'a', ids)
    expect(touchRecentTabs(first, 'a', ids)).toBe(first)
    const second = touchRecentTabs(first, 'b', ids)
    expect(second).toEqual(['b', 'a'])
    expect(touchRecentTabs(second, 'c', new Set(['b', 'c']))).toEqual(['c', 'b'])
  })

  it('registers a suspended conversation with exactly the spec its mounted pane would', () => {
    const project = { id: 'project', path: 'C:/work' }
    const session = { id: 'workspace', continueOnLimit: true }
    expect(suspendedConversationSpec(agent('a', { provider: 'claude', model: 'opus', effort: 'high' }), project, session)).toEqual({
      id: 'agent-a', projectId: 'project', sessionId: 'workspace', title: 'Agent a', cwd: 'C:/work', provider: 'claude', model: 'opus', effort: 'high', continueOnLimit: true
    })
    expect(suspendedConversationSpec(agent('b', { continueOnLimit: false }), project, session)).toMatchObject({ provider: 'codex', model: 'default', effort: 'auto', continueOnLimit: false })
    expect(suspendedConversationSpec(agent('c', { provider: 'gemini' }), project, session)).toBeNull()
    expect(suspendedConversationSpec(tab('t', 'terminal'), project, session)).toBeNull()
  })
})
