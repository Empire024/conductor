import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceLayout } from '../../shared/models'
import type { PermissionGrantRequest } from '../../shared/permission-grants'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
const { recoverFromTimelines } = await import('./wiring')

const request = (id: string, status: PermissionGrantRequest['status']): PermissionGrantRequest => ({
  id, source: 'agent', tool: 'Bash', action: 'Run a command', resource: 'bash app/prod/fix-pool.sh', class: 'local', rule: 'Bash(bash app/prod/fix-pool.sh)', status, requestedAt: '2026-09-26T04:00:00.000Z'
})
const card = (value: PermissionGrantRequest) => ({ data: { type: 'notice', message: 'Permission', payload: { permissionGrant: value } } })
const layout = (...ids: string[]) => ({ root: { type: 'leaf', tabs: ids.map(resourceId => ({ resourceId })) } }) as unknown as WorkspaceLayout

describe('the first launch of a build that saves grants (grant-survives-restart)', () => {
  it('takes back the agent requests an open tab\'s timeline still shows waiting, judged by each request\'s last card', () => {
    const timelines: Record<string, unknown[]> = {
      agent_w: [card(request('grant:used', 'pending')), card(request('grant:waiting', 'pending')), card(request('grant:used', 'used'))],
      agent_moved: [card(request('grant:moved', 'moved'))],
      agent_closed: [card(request('grant:closed', 'pending'))],
      agent_codex: [card(request('grant:codex', 'pending'))]
    }
    const recovered = recoverFromTimelines({
      store: { spec: (id: string) => ({ provider: id === 'agent_codex' ? 'codex' : 'claude' }), snapshot: (id: string) => ({ items: timelines[id] ?? [] }) },
      workspaces: {
        getSession: () => null,
        listProjects: () => [{ id: 'project' }],
        listSessions: () => [{ layout: layout('agent_w', 'agent_moved', 'agent_codex') }],
        listDetachedWindows: () => []
      }
    } as unknown as Parameters<typeof recoverFromTimelines>[0])
    expect(recovered.requests).toEqual([expect.objectContaining({ id: 'grant:waiting', agentSessionId: 'agent_w', status: 'pending' })])
  })
})
