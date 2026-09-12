import { describe, expect, it } from 'vitest'
import { parseSessionArchive } from './session-archive'

const stamp = '2026-09-12T14:00:00.000Z'
const fixture = (): any => ({
  format: 'conductor-session', version: 1, name: 'Restored desk', savedAt: stamp,
  projects: [{ id: 'project-a', name: 'A', path: 'C:/project-a', createdAt: stamp, updatedAt: stamp }],
  workspaces: [{ id: 'workspace-a', projectId: 'project-a', name: 'A', layout: { version: 1, root: { type: 'group', id: 'group-a', activeTabId: 'tab-a', tabs: [{ id: 'tab-a', kind: 'agent', title: 'Agent', resourceId: 'agent-a' }] } }, maximizedGroupId: null, closedTabs: [], createdAt: stamp, updatedAt: stamp }],
  detached: [],
  agents: [{ spec: { id: 'agent-a', projectId: 'project-a', sessionId: 'workspace-a', cwd: 'C:/project-a', title: 'Agent', provider: 'codex' }, projection: { sessionId: 'agent-a', runtimeId: 'runtime-a', sequence: 1, phase: 'completed', settings: { permission: 'default', plan: false, model: 'gpt-5.6-sol', effort: 'high' }, items: [] }, transcript: '' }],
  drafts: [],
  selection: { activeProjectId: 'project-a', activeSessionId: 'workspace-a', focusedGroupIds: { 'workspace-a': 'group-a' }, sessionIdsByProject: { 'project-a': 'workspace-a' } }
})

describe('session archive hostile input boundaries', () => {
  it('accepts the valid baseline used by the attacks', () => {
    expect(parseSessionArchive(JSON.stringify(fixture())).name).toBe('Restored desk')
  })

  it('rejects malformed timeline payloads before they can reach the renderer', () => {
    const value = fixture()
    value.agents[0].projection.items = [{ id: 'item-a', runtimeId: 'runtime-a', sequence: 1, timestamp: stamp, data: { type: 'plan', steps: 'not-an-array' } }]
    expect(() => parseSessionArchive(JSON.stringify(value))).toThrow(/Invalid session archive/)
  })

  it('rejects unknown runtime permission values instead of retaining them for resume', () => {
    const value = fixture()
    value.agents[0].projection.settings.permission = 'unrestricted-unknown-mode'
    expect(() => parseSessionArchive(JSON.stringify(value))).toThrow(/Invalid session archive/)
  })

  it('rejects nontext attachment labels before they become React children', () => {
    const value = fixture()
    value.agents[0].projection.items = [{ id: 'item-a', runtimeId: 'runtime-a', sequence: 1, timestamp: stamp, data: { type: 'text', role: 'user', mode: 'snapshot', text: 'See attached', attachments: [{ kind: 'file', name: { nested: true }, path: 'config.ts' }] } }]
    expect(() => parseSessionArchive(JSON.stringify(value))).toThrow(/Invalid session archive/)
  })

  it('rejects malformed question options within otherwise valid interactions', () => {
    const value = fixture()
    value.agents[0].projection.items = [{ id: 'item-a', runtimeId: 'runtime-a', sequence: 1, timestamp: stamp, data: { type: 'interaction', interaction: { id: 'question-a', kind: 'question', status: 'resolved', title: 'Choose', input: {}, choices: [], questions: [{ id: 'q-a', question: 'Choose one', options: [{ label: { nested: true } }] }] } } }]
    expect(() => parseSessionArchive(JSON.stringify(value))).toThrow(/Invalid session archive/)
  })

  it('rejects a closed agent tab that borrows history from another project', () => {
    const value = fixture()
    value.projects.push({ id: 'project-b', name: 'B', path: 'C:/project-b', createdAt: stamp, updatedAt: stamp })
    value.workspaces.push({ id: 'workspace-b', projectId: 'project-b', name: 'B', layout: { version: 1, root: { type: 'group', id: 'group-b', activeTabId: '', tabs: [] } }, maximizedGroupId: null, closedTabs: [{ id: 'closed-b', kind: 'agent', title: 'Borrowed', resourceId: 'agent-a' }], createdAt: stamp, updatedAt: stamp })
    expect(() => parseSessionArchive(JSON.stringify(value))).toThrow(/Invalid session archive/)
  })

  it('rejects a draft whose tab identifies a file in another project', () => {
    const value = fixture()
    value.projects.push({ id: 'project-b', name: 'B', path: 'C:/project-b', createdAt: stamp, updatedAt: stamp })
    value.workspaces[0].layout.root.tabs.push({ id: 'file-a', kind: 'code', title: 'config.ts', resourceId: 'config.ts', state: { path: 'config.ts' } })
    value.drafts.push({ tabId: 'file-a', projectId: 'project-b', path: 'config.ts', content: 'foreign unsaved bytes', updatedAt: stamp })
    expect(() => parseSessionArchive(JSON.stringify(value))).toThrow(/Invalid session archive/)
  })
})
