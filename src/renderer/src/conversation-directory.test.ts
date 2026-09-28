import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../../shared/models'
import type { AgentEventData, TimelineItem } from '../../shared/structured-agent'
import {
  buildConversationDirectory, conversationDirectoryForTest, conversationLabel, conversationRefRemarkPlugin, currentConversationDirectory, findConversationRefs,
  matchConversationTabs, mentionsConversationId, resolveConversationRef, setLiveWorkspaces
} from './conversation-directory'
import { mcpAgentMessageOf, receivedMessagePeer } from './panes/AgentMessageCards'
import { StructuredActivity } from './panes/StructuredAgentRenderers'
import { tabCommand } from './components/CommandPalette'

const session = (id: string, projectId: string, name: string, tabs: Array<{ id: string; title: string; resourceId?: string; kind?: 'agent' | 'terminal' }>): SessionRecord => ({
  id, projectId, name, maximizedGroupId: null, closedTabs: [], continueOnLimit: false, createdAt: '', updatedAt: '',
  layout: { version: 1, root: { type: 'split', id: 'split', direction: 'horizontal', sizes: [50, 50], children: [
    { type: 'group', id: 'g1', activeTabId: tabs[0]?.id ?? '', tabs: tabs.slice(0, 1).map(tab => ({ kind: 'agent', ...tab })) },
    { type: 'group', id: 'g2', activeTabId: tabs[1]?.id ?? '', tabs: tabs.slice(1).map(tab => ({ kind: 'agent', ...tab })) }
  ] } }
})
const projects = [{ id: 'project_conductor', name: 'conductor' }, { id: 'project_mtt8tdta_9b59qnn', name: 'haftheme' }]
const sessions = [
  session('session_a', 'project_conductor', 'Main', [{ id: 'tab_mulf9ghp_wf9a621', title: 'Controller', resourceId: 'agent_mulf9gp4_awcbpcc' }, { id: 'tab_mulh0000_term001', title: 'PowerShell', kind: 'terminal' }]),
  session('session_b', 'project_mtt8tdta_9b59qnn', 'Haftheme', [{ id: 'pane_muldox0q_o4uxsva', title: 'Owner decision, relayed by the wizard', resourceId: 'agent_muldox0q_y4hp2rg' }])
]
const directory = buildConversationDirectory(projects, sessions)

afterEach(() => conversationDirectoryForTest.reset())

describe('conversation directory', () => {
  it('indexes every tab of every project by agent id and tab id', () => {
    expect(directory.entries).toHaveLength(3)
    expect(directory.byAgent.get('agent_muldox0q_y4hp2rg')).toMatchObject({ tabId: 'pane_muldox0q_o4uxsva', projectName: 'haftheme', workspaceName: 'Haftheme', uri: 'conductor://project_mtt8tdta_9b59qnn/tab/pane_muldox0q_o4uxsva' })
    expect(directory.byTab.get('tab_mulh0000_term001')).toMatchObject({ kind: 'terminal' })
    expect(directory.byTab.get('tab_mulh0000_term001')?.agentSessionId).toBeUndefined()
  })

  it('resolves an agent id, a tab id and a conductor uri, and nothing it does not know', () => {
    expect(resolveConversationRef(directory, 'agent_muldox0q_y4hp2rg')?.title).toBe('Owner decision, relayed by the wizard')
    expect(resolveConversationRef(directory, 'pane_muldox0q_o4uxsva')?.agentSessionId).toBe('agent_muldox0q_y4hp2rg')
    expect(resolveConversationRef(directory, 'conductor://project_mtt8tdta_9b59qnn/tab/pane_muldox0q_o4uxsva')?.projectName).toBe('haftheme')
    // A uri naming the right tab under the wrong project is not that tab.
    expect(resolveConversationRef(directory, 'conductor://project_conductor/tab/pane_muldox0q_o4uxsva')).toBeNull()
    expect(resolveConversationRef(directory, 'agent_zzzzzzzz_zzzzzzz')).toBeNull()
  })

  it('finds known ids in prose, trims trailing punctuation and leaves unknown ids alone', () => {
    const text = 'The agent notified agent_muldox0q_y4hp2rg. See conductor://project_conductor/tab/tab_mulf9ghp_wf9a621, not agent_zzzzzzzz_zzzzzzz or my_agent_thing.'
    expect(findConversationRefs(text, directory).map(ref => [ref.raw, ref.entry.tabId])).toEqual([
      ['agent_muldox0q_y4hp2rg', 'pane_muldox0q_o4uxsva'],
      ['conductor://project_conductor/tab/tab_mulf9ghp_wf9a621', 'tab_mulf9ghp_wf9a621']
    ])
    expect(mentionsConversationId('ask agent_zzzzzzzz_zzzzzzz')).toBe(true)
    expect(mentionsConversationId('an agent tab')).toBe(false)
  })

  it('names the project of a tab that lives in another one', () => {
    const entry = directory.byAgent.get('agent_muldox0q_y4hp2rg')!
    expect(conversationLabel(entry, 'project_conductor')).toBe('Owner decision, relayed by the wizard (haftheme)')
    expect(conversationLabel(entry, 'project_mtt8tdta_9b59qnn')).toBe('Owner decision, relayed by the wizard')
  })

  it('turns text and whole inline-code ids into links, but never inside explicit links or code blocks', () => {
    type Node = { type: string; value?: string; url?: string; children?: Node[]; data?: { hProperties?: Record<string, unknown> } }
    const tree: Node = { type: 'root', children: [
      { type: 'paragraph', children: [{ type: 'text', value: 'from agent_muldox0q_y4hp2rg now' }, { type: 'inlineCode', value: 'tab_mulf9ghp_wf9a621' }, { type: 'inlineCode', value: 'agent_zzzzzzzz_zzzzzzz' }] },
      { type: 'link', url: 'https://x', children: [{ type: 'text', value: 'agent_muldox0q_y4hp2rg' }] },
      { type: 'code', value: 'agent_muldox0q_y4hp2rg' }
    ] }
    conversationRefRemarkPlugin(directory, 'project_conductor')()(tree as never)
    const paragraph = tree.children![0]!.children!
    expect(paragraph.map(node => node.type)).toEqual(['text', 'link', 'text', 'link', 'inlineCode'])
    expect(paragraph[1]).toMatchObject({ url: 'conductor://project_mtt8tdta_9b59qnn/tab/pane_muldox0q_o4uxsva', data: { hProperties: { title: 'Show Owner decision, relayed by the wizard (haftheme)' } } })
    expect(paragraph[3]!.children![0]).toMatchObject({ type: 'inlineCode', value: 'tab_mulf9ghp_wf9a621' })
    expect(tree.children![1]!.children![0]).toMatchObject({ type: 'text' })
    expect(tree.children![2]).toMatchObject({ type: 'code' })
  })
})

describe('palette tab search', () => {
  it('matches a whole agent id, an id fragment and a tab id across projects', () => {
    expect(matchConversationTabs(directory, 'agent_muldox0q_y4hp2rg').map(entry => entry.tabId)).toEqual(['pane_muldox0q_o4uxsva'])
    expect(matchConversationTabs(directory, 'muldox0q').map(entry => entry.tabId)).toEqual(['pane_muldox0q_o4uxsva'])
    expect(matchConversationTabs(directory, 'WF9A621').map(entry => entry.agentSessionId)).toEqual(['agent_mulf9gp4_awcbpcc'])
    // Ids rank above titles; a short fragment matches titles only.
    expect(matchConversationTabs(directory, 'mul').map(entry => entry.tabId)).toEqual([])
    expect(matchConversationTabs(directory, 'haftheme').map(entry => entry.tabId)).toEqual(['pane_muldox0q_o4uxsva'])
    expect(matchConversationTabs(directory, '')).toEqual([])
  })

  it('labels a hit from another project with that project and jumps by agent id', async () => {
    const focusOrigin = vi.fn(async () => {}), openUri = vi.fn(async () => {})
    vi.stubGlobal('window', { conductor: { agentControl: { focusOrigin, openUri } } })
    try {
      const command = tabCommand(directory.byAgent.get('agent_muldox0q_y4hp2rg')!, 'project_conductor')
      expect(command).toMatchObject({ label: 'Owner decision, relayed by the wizard (haftheme)', category: 'Tabs', detail: 'haftheme · Haftheme · agent_muldox0q_y4hp2rg' })
      command.run()
      expect(focusOrigin).toHaveBeenCalledWith('agent_muldox0q_y4hp2rg')
      tabCommand(directory.byTab.get('tab_mulh0000_term001')!, 'project_conductor').run()
      expect(openUri).toHaveBeenCalledWith('conductor://project_conductor/tab/tab_mulh0000_term001')
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps the same directory object while only layout details change', () => {
    setLiveWorkspaces('project_conductor', [sessions[0]!], projects)
    const first = currentConversationDirectory()
    setLiveWorkspaces('project_conductor', [{ ...sessions[0]!, updatedAt: 'later', maximizedGroupId: 'g1' }], projects)
    expect(currentConversationDirectory()).toBe(first)
    setLiveWorkspaces('project_conductor', [session('session_a', 'project_conductor', 'Main', [{ id: 'tab_mulf9ghp_wf9a621', title: 'Renamed', resourceId: 'agent_mulf9gp4_awcbpcc' }])], projects)
    expect(currentConversationDirectory().byTab.get('tab_mulf9ghp_wf9a621')?.title).toBe('Renamed')
  })
})

describe('agent-to-agent message cards', () => {
  const render = (data: AgentEventData): string => {
    const item: TimelineItem = { id: 'item', runtimeId: 'runtime', sequence: 1, timestamp: '2026-09-28T00:00:00Z', data }
    return renderToStaticMarkup(createElement(StructuredActivity, { item, sessionId: 'session', cwd: 'C:\\work', projectId: 'project_conductor', expanded: false, interactive: true, onExpand: vi.fn(), onOpenFile: vi.fn(), onDiff: vi.fn(), onRespond: vi.fn(async () => {}) }))
  }

  it('reads a Conductor MCP messaging call as the message it sent, in every runtime naming', () => {
    const base = { status: 'completed' as const, input: { agentSessionId: 'agent_muldox0q_y4hp2rg', text: 'Please rerun the smoke' } }
    expect(mcpAgentMessageOf({ type: 'tool', name: 'mcp__conductor__send_message', ...base })).toMatchObject({ method: 'agents.steer', to: { agentSessionId: 'agent_muldox0q_y4hp2rg' }, text: 'Please rerun the smoke' })
    expect(mcpAgentMessageOf({ type: 'tool', name: 'conductor.submit_task', ...base })?.method).toBe('agents.submit')
    expect(mcpAgentMessageOf({ type: 'tool', name: 'mcp__conductor__report', status: 'completed', input: { text: 'done' }, output: '{"agentSessionId":"agent_mulf9gp4_awcbpcc","delivery":"steered"}' })).toMatchObject({ to: { agentSessionId: 'agent_mulf9gp4_awcbpcc' }, text: 'done' })
    expect(mcpAgentMessageOf({ type: 'tool', name: 'mcp__conductor__send_message', ...base, status: 'failed' })).toBeNull()
    expect(mcpAgentMessageOf({ type: 'tool', name: 'mcp__other__send_message', ...base })).toBeNull()
    expect(mcpAgentMessageOf({ type: 'tool', name: 'mcp__conductor__request_permission', status: 'completed', input: { reason: 'x' } })).toBeNull()
  })

  it('names who sent a coordinated turn, Conductor for its own relays, and nobody for the owner', () => {
    expect(receivedMessagePeer({ type: 'text', role: 'user', text: 'x', mode: 'snapshot', origin: { agentSessionId: 'agent_a', label: 'Fixer' } })).toEqual({ agentSessionId: 'agent_a', title: 'Fixer' })
    expect(receivedMessagePeer({ type: 'text', role: 'user', text: 'x', mode: 'snapshot', origin: { agentSessionId: 'owner', label: 'Conductor' } })).toEqual({ title: 'Conductor' })
    expect(receivedMessagePeer({ type: 'text', role: 'user', text: '[Conductor] approved: Bash(npm test); retry it now', mode: 'snapshot' })).toEqual({ title: 'Conductor' })
    expect(receivedMessagePeer({ type: 'text', role: 'user', text: 'my own words', mode: 'snapshot' })).toBeNull()
    expect(receivedMessagePeer({ type: 'text', role: 'assistant', text: '[Conductor] x', mode: 'snapshot' })).toBeNull()
  })

  it('renders received and sent messages as collapsed cards linked to the live tab title', () => {
    setLiveWorkspaces('project_conductor', sessions, projects)
    const received = render({ type: 'text', role: 'user', text: 'Rerun the smoke\nwith details', mode: 'snapshot', origin: { agentSessionId: 'agent_muldox0q_y4hp2rg', label: 'Old title' } })
    expect(received).toContain('sa-agent-message-received')
    expect(received).not.toContain('<details open')
    expect(received).toContain('Show Owner decision, relayed by the wizard (haftheme) tab')
    expect(received).toContain('Rerun the smoke</span>')
    const sent = render({ type: 'notice', message: 'Sent to Controller (agents.steer)', payload: { agentMessage: { method: 'agents.steer', text: 'Go ahead', characters: 8, at: '', to: { agentSessionId: 'agent_mulf9gp4_awcbpcc', title: 'Controller' } } } })
    expect(sent).toContain('sa-agent-message-sent')
    expect(sent).toContain('sent to')
    expect(sent).toContain('agents.steer')
    const mcp = render({ type: 'tool', name: 'mcp__conductor__send_message', status: 'completed', input: { agentSessionId: 'agent_muldox0q_y4hp2rg', text: 'Hello there' } })
    expect(mcp).toContain('sa-agent-message-sent')
    expect(mcp).toContain('Hello there')
  })

  it('links a known id in a notice and leaves an unknown one as text', () => {
    setLiveWorkspaces('project_conductor', sessions, projects)
    const html = render({ type: 'notice', message: 'Relayed to agent_muldox0q_y4hp2rg and agent_zzzzzzzz_zzzzzzz' })
    expect(html).toContain('class="sa-conversation-ref"')
    expect(html).toContain('title="Show Owner decision, relayed by the wizard (haftheme)"')
    expect(html).toContain('and agent_zzzzzzzz_zzzzzzz')
  })
})
