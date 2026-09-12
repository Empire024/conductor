import { describe, expect, it, vi } from 'vitest'
import { browserViewCandidates } from './browser-views'
import type { AgentControlTab } from '../shared/agent-control'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, webContents: { fromId: () => undefined } }))

describe('browser MCP view routing', () => {
  it('always addresses the project sidebar and only retains real legacy browser tabs', () => {
    const tabs = [
      { id: 'browser-tab', kind: 'browser' },
      { id: 'editor-tab', kind: 'code' }
    ] as AgentControlTab[]
    expect([...browserViewCandidates({ projectId: 'project-a', sessionId: 'workspace-a', agentSessionId: 'agent-a' }, tabs)]).toEqual([
      'project-browser:project-a',
      'browser-tab'
    ])
  })

  it('never derives another project identity from workspace tabs', () => {
    const candidates = browserViewCandidates({ projectId: 'project-b', sessionId: 'workspace-a', agentSessionId: 'agent-a' }, [])
    expect([...candidates]).toEqual(['project-browser:project-b'])
    expect(candidates.has('project-browser:project-a')).toBe(false)
  })
})
