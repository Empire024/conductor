import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceLayout } from '../../shared/models'
import type { PermissionGrantRequest } from '../../shared/permission-grants'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
const { grantDelivery, recoverFromTimelines } = await import('./wiring')

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

describe('delivering an approval (H06)', () => {
  function fixture(phases: string[]) {
    // Each snapshot read takes the next phase; the last one stays.
    const snapshot = vi.fn(() => ({ phase: phases.length > 1 ? phases.shift()! : phases[0]!, settings: { permission: 'auto' }, items: [], queuedPrompts: [{ id: 'q1', text: 'queued approval' }] }))
    const sessions = { steerOrStart: vi.fn(async () => 'started'), queue: vi.fn(async () => undefined), steer: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), cancelQueued: vi.fn(() => ({ id: 'q1' })) }
    return { sessions, delivery: grantDelivery(sessions as never, { spec: () => undefined, snapshot } as never, { settleMs: 200, pollMs: 1 }) }
  }

  it('waits for a turn that is still stopping, then starts the approval turn once instead of throwing', async () => {
    const { sessions, delivery } = fixture(['interrupting', 'interrupting', 'interrupting', 'completed'])
    await expect(delivery.retry('agent_w', '[Conductor] approved: Bash(x) (once); retry it now.')).resolves.toBeUndefined()
    expect(sessions.steerOrStart).toHaveBeenCalledTimes(1)
    expect(sessions.queue).not.toHaveBeenCalled()
  })

  it('queues behind a running turn, and refuses (for a later attempt) a turn that never stops within the bound', async () => {
    const running = fixture(['running'])
    await running.delivery.retry('agent_w', 'approval')
    expect(running.sessions.queue).toHaveBeenCalledTimes(1)
    expect(running.sessions.steerOrStart).not.toHaveBeenCalled()
    const stuck = fixture(['interrupting'])
    await expect(stuck.delivery.retry('agent_w', 'approval')).rejects.toThrow('still stopping')
    expect(stuck.sessions.steerOrStart).not.toHaveBeenCalled()
  })

  it('steers a heads-up only into a turn that can take it, interrupts with the queue expedited, and takes a queued retry back', async () => {
    const starting = fixture(['starting'])
    await expect(starting.delivery.headsUp('agent_w', 'note')).resolves.toBe(false)
    expect(starting.sessions.steer).not.toHaveBeenCalled()
    const running = fixture(['running'])
    await expect(running.delivery.headsUp('agent_w', 'note')).resolves.toBe(true)
    expect(running.sessions.steer).toHaveBeenCalledWith('agent_w', 'note', { permission: 'auto' })
    await running.delivery.interrupt('agent_w')
    expect(running.sessions.interrupt).toHaveBeenCalledWith('agent_w', true)
    expect(running.delivery.unqueue('agent_w', 'queued approval')).toBe(true)
    expect(running.sessions.cancelQueued).toHaveBeenCalledWith('agent_w', 'q1')
    expect(running.delivery.unqueue('agent_w', 'something else')).toBe(false)
  })

  it('names when the running turn started and its last tool', () => {
    const items = [
      { timestamp: '2026-09-28T14:00:00.000Z', data: { type: 'text', role: 'user', text: 'old' } },
      { timestamp: '2026-09-28T14:01:00.000Z', data: { type: 'tool', name: 'Read', status: 'completed' } },
      { timestamp: '2026-09-28T14:50:00.000Z', data: { type: 'text', role: 'user', text: 'current' } },
      { timestamp: '2026-09-28T14:51:00.000Z', data: { type: 'tool', name: 'Bash', status: 'running' } },
      { timestamp: '2026-09-28T14:52:00.000Z', data: { type: 'text', role: 'assistant', text: 'working' } }
    ]
    const delivery = grantDelivery({} as never, { spec: () => undefined, snapshot: () => ({ phase: 'running', settings: {}, items }) } as never)
    expect(delivery.turn('agent_w')).toEqual({ startedAt: '2026-09-28T14:50:00.000Z', lastTool: 'Bash' })
  })
})
