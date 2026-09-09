import { describe, expect, it } from 'vitest'
import type { AgentActivityPhase, SessionRecord } from '../../shared/models'
import { createDefaultLayout } from '../../shared/models'
import { closeTab } from './layout/layout-operations'
import type { ProjectActivityStatus } from '../../shared/project-activity'
import {
  getAttentionSessionIds,
  getProjectActivityStatuses,
  mergeProjectActivity,
  getSessionActivityStatuses,
  hasActiveSubagent,
  resolveActivityPhase,
  resolveActivityPhases,
  retainVisibleAttentionResources,
  type SessionActivityStatus
} from './attention'

const makeSession = (resourceId = 'agent-resource', overrides: Partial<Pick<SessionRecord, 'id' | 'projectId'>> = {}): SessionRecord => {
  const layout = createDefaultLayout()
  if (layout.root.type !== 'group') throw new Error('Expected a tab group')
  layout.root.tabs[0] = {
    id: 'agent-tab',
    kind: 'agent',
    title: 'Codex',
    resourceId
  }
  layout.root.activeTabId = 'agent-tab'
  return {
    id: 'workspace-1',
    projectId: 'project-1',
    name: 'Workspace 1',
    layout,
    maximizedGroupId: null,
    closedTabs: [],
    continueOnLimit: false,
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

describe('workspace attention', () => {
  it('drops an alert as soon as its originating tab is closed', () => {
    const session = makeSession()
    const attention = new Set(['agent-resource'])

    expect([...getAttentionSessionIds([session], attention)]).toEqual(['workspace-1'])
    const result = closeTab(session.layout, session.layout.root.id, 'agent-tab')
    const closedSession = { ...session, layout: result.layout }

    expect([...getAttentionSessionIds([closedSession], attention)]).toEqual([])
    expect([...retainVisibleAttentionResources([closedSession], attention)]).toEqual([])
  })
})

describe('session activity status', () => {
  it.each([
    ['waiting_input', 'waiting'],
    ['failed', 'waiting'],
    ['working', 'working'],
    ['limited', 'working'],
    ['complete', 'done'],
    ['idle', undefined],
    // Stopped is a deliberate halt, so it does not pull the workspace into the waiting list.
    ['stopped', undefined],
    // A session only reaches this layer as disconnected when it lost its connection mid-flight.
    ['disconnected', 'waiting']
  ] as const)('maps phase %s to status %s', (phase, expected) => {
    const session = makeSession()
    const phases = new Map<string, AgentActivityPhase>([['agent-resource', phase]])
    expect(getSessionActivityStatuses([session], phases).get('workspace-1')).toBe(expected)
  })

  it('prioritises waiting over working over done across multiple tabs', () => {
    const session = makeSession()
    if (session.layout.root.type !== 'group') throw new Error('Expected a tab group')
    session.layout.root.tabs.push({ id: 'agent-tab-2', kind: 'agent', title: 'Claude', resourceId: 'agent-resource-2' })
    const phases = new Map<string, AgentActivityPhase>([
      ['agent-resource', 'working'],
      ['agent-resource-2', 'waiting_input']
    ])
    expect(getSessionActivityStatuses([session], phases).get('workspace-1')).toBe('waiting')
  })

  it('reports done when a finished tab sits next to one that settled before losing its connection', () => {
    const session = makeSession()
    if (session.layout.root.type !== 'group') throw new Error('Expected a tab group')
    session.layout.root.tabs.push({ id: 'agent-tab-2', kind: 'agent', title: 'Claude', resourceId: 'agent-resource-2' })
    const phases = new Map<string, AgentActivityPhase>([
      ['agent-resource', 'complete'],
      ['agent-resource-2', 'idle']
    ])
    expect(getSessionActivityStatuses([session], phases).get('workspace-1')).toBe('done')
  })

  it('ignores resources without a matching visible tab', () => {
    const session = makeSession()
    const phases = new Map<string, AgentActivityPhase>([['some-other-resource', 'working']])
    expect(getSessionActivityStatuses([session], phases).size).toBe(0)
  })
})

describe('subagent-aware tab phase', () => {
  it.each([
    ['running'],
    ['preparing'],
    ['awaiting_approval']
  ] as const)('treats %s subagents as active', (status) => {
    expect(hasActiveSubagent([status])).toBe(true)
  })

  it.each([
    ['completed'],
    ['failed'],
    ['rejected'],
    ['interrupted'],
    ['unknown']
  ] as const)('treats %s subagents as settled', (status) => {
    expect(hasActiveSubagent([status])).toBe(false)
  })

  it('has no active subagent when the list is empty', () => {
    expect(hasActiveSubagent([])).toBe(false)
  })

  it('downgrades a completed tab to working while it still owns active subagent work', () => {
    expect(resolveActivityPhase('complete', true)).toBe('working')
  })

  it('leaves a completed tab alone once every subagent has settled', () => {
    expect(resolveActivityPhase('complete', false)).toBe('complete')
  })

  it.each(['idle', 'working', 'waiting_input', 'limited', 'failed', 'disconnected', 'stopped'] as const)('passes phase %s through regardless of subagent activity', (phase) => {
    expect(resolveActivityPhase(phase, true)).toBe(phase)
    expect(resolveActivityPhase(phase, false)).toBe(phase)
  })

  it('resolves a whole phase map against the active subagent id set', () => {
    const phases = new Map<string, AgentActivityPhase>([
      ['tab-with-subagents', 'complete'],
      ['tab-without-subagents', 'complete'],
      ['tab-working', 'working']
    ])
    const resolved = resolveActivityPhases(phases, new Set(['tab-with-subagents']))
    expect(resolved.get('tab-with-subagents')).toBe('working')
    expect(resolved.get('tab-without-subagents')).toBe('complete')
    expect(resolved.get('tab-working')).toBe('working')
  })
})

describe('project activity status roll-up', () => {
  it('reports idle for a project with no sessions', () => {
    expect(getProjectActivityStatuses([], new Set(), new Map()).size).toBe(0)
  })

  it('needs-attention wins over working, which wins over done', () => {
    const attentionSession = makeSession('attention-resource', { id: 'session-attention' })
    const workingSession = makeSession('working-resource', { id: 'session-working' })
    const doneSession = makeSession('done-resource', { id: 'session-done' })
    const sessions = [attentionSession, workingSession, doneSession]

    const activity: ReadonlyMap<string, SessionActivityStatus> = new Map([
      ['session-working', 'working'],
      ['session-done', 'done']
    ])

    const withAttention = getProjectActivityStatuses(sessions, new Set(['session-attention']), activity)
    expect(withAttention.get('project-1')).toBe('attention')

    const withoutAttention = getProjectActivityStatuses(sessions, new Set(), activity)
    expect(withoutAttention.get('project-1')).toBe('working')

    const onlyDone: ReadonlyMap<string, SessionActivityStatus> = new Map([['session-done', 'done']])
    expect(getProjectActivityStatuses([doneSession], new Set(), onlyDone).get('project-1')).toBe('done')
  })

  it('falls back to idle when no session reports an activity status', () => {
    const session = makeSession('idle-resource', { id: 'session-idle' })
    expect(getProjectActivityStatuses([session], new Set(), new Map()).get('project-1')).toBe('idle')
  })

  it('keeps projects independent', () => {
    const sessionA = makeSession('a-resource', { id: 'session-a', projectId: 'project-a' })
    const sessionB = makeSession('b-resource', { id: 'session-b', projectId: 'project-b' })
    const activity: ReadonlyMap<string, SessionActivityStatus> = new Map([['session-a', 'working']])
    const result = getProjectActivityStatuses([sessionA, sessionB], new Set(), activity)
    expect(result.get('project-a')).toBe('working')
    expect(result.get('project-b')).toBe('idle')
  })
})

describe('merging backend project activity with the mounted project', () => {
  it('keeps every project the main process reported, including ones this renderer never opened', () => {
    const merged = mergeProjectActivity({ 'project-a': 'idle', 'project-b': 'working', 'project-c': 'attention' }, new Map())
    expect([...merged]).toEqual([['project-a', 'idle'], ['project-b', 'working'], ['project-c', 'attention']])
  })

  it('lets the mounted project override the backend once it observes activity', () => {
    const merged = mergeProjectActivity(
      { 'project-a': 'done', 'project-b': 'working' },
      new Map<string, ProjectActivityStatus>([['project-a', 'working']])
    )
    expect(merged.get('project-a')).toBe('working')
    expect(merged.get('project-b')).toBe('working')
  })

  it('keeps the persisted answer when the mounted project has observed nothing yet', () => {
    const merged = mergeProjectActivity({ 'project-a': 'done' }, new Map<string, ProjectActivityStatus>([['project-a', 'idle']]))
    expect(merged.get('project-a')).toBe('done')
  })

  it('still reports a project the backend has not heard of', () => {
    const merged = mergeProjectActivity({}, new Map<string, ProjectActivityStatus>([['project-new', 'idle']]))
    expect(merged.get('project-new')).toBe('idle')
  })
})
