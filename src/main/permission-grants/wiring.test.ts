import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceLayout } from '../../shared/models'
import type { PermissionGrantRequest } from '../../shared/permission-grants'

vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
const { grantDelivery, nativeResponseTarget, recoverFromTimelines } = await import('./wiring')
const { grantCallIdentity } = await import('./identity')
const { SteeringUnavailableError } = await import('../providers/adapter')

const request = (id: string, status: PermissionGrantRequest['status']): PermissionGrantRequest => ({
  id, source: 'agent', tool: 'Bash', action: 'Run a command', resource: 'bash app/prod/fix-pool.sh', class: 'local', rule: 'Bash(bash app/prod/fix-pool.sh)', status, requestedAt: '2026-09-26T04:00:00.000Z'
})
const card = (value: PermissionGrantRequest) => ({ data: { type: 'notice', message: 'Permission', payload: { permissionGrant: value } } })
const layout = (...ids: string[]) => ({ root: { type: 'leaf', tabs: ids.map(resourceId => ({ resourceId })) } }) as unknown as WorkspaceLayout

describe('one native response is bound to the live tool and arguments', () => {
  it('rejects a changed request, tool, arguments, runtime or native session', () => {
    const input = { command: 'cd app && cat < input.txt' }
    const call = grantCallIdentity({ runtimeId: 'runtime', nativeSessionId: 'native', requestId: 'request', toolUseId: 'tool', tool: 'Bash', input })
    const tool = { runtimeId: 'runtime', nativeItemId: 'tool', data: { type: 'tool', name: 'Bash', input, status: 'awaiting_approval' } }
    const pending = { runtimeId: 'runtime', data: { type: 'interaction', interaction: { id: 'request', status: 'pending', input } } }
    const state = { runtimeId: 'runtime', nativeSessionId: 'native', items: [tool, pending] }
    const check = (value: unknown) => nativeResponseTarget(value as never, call)
    expect(check(state)).toBe(true)
    expect(check({ ...state, runtimeId: 'restarted' })).toBe(false)
    expect(check({ ...state, nativeSessionId: 'another' })).toBe(false)
    expect(check({ ...state, items: [tool, { ...pending, data: { ...pending.data, interaction: { ...pending.data.interaction, status: 'resolved' } } }] })).toBe(false)
    expect(check({ ...state, items: [{ ...tool, data: { ...tool.data, input: { command: 'cd app && cat < other.txt' } } }, pending] })).toBe(false)
    expect(nativeResponseTarget(state as never, { ...call, toolUseId: 'another' })).toBe(false)
  })
})

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
    const sessions = { steerOrStart: vi.fn(async () => 'started'), queue: vi.fn(async () => undefined), steerAccepted: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), cancelQueued: vi.fn(() => ({ id: 'q1' })) }
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
    expect(starting.sessions.steerAccepted).not.toHaveBeenCalled()
    const running = fixture(['running'])
    await expect(running.delivery.headsUp('agent_w', 'note')).resolves.toBe(true)
    expect(running.sessions.steerAccepted).toHaveBeenCalledWith('agent_w', 'note', { permission: 'auto' })
    await running.delivery.interrupt('agent_w')
    expect(running.sessions.interrupt).toHaveBeenCalledWith('agent_w', true)
    expect(running.delivery.unqueue('agent_w', 'queued approval')).toBe(true)
    expect(running.sessions.cancelQueued).toHaveBeenCalledWith('agent_w', 'q1')
    expect(running.delivery.unqueue('agent_w', 'something else')).toBe(false)
  })

  // The Codex heads-up race (H06 follow-up): a steer the runtime could not take fell back to the
  // queue, behind the approval turn already queued there, so the heads-up came with or after it.
  describe('the heads-up never lands after the approval turn it announces', () => {
    function conversation(steer: (text: string) => Promise<void>) {
      // A queue and pending steering records as StructuredSessions keeps them; the retry is queued first.
      const state = { phase: 'running', settings: { permission: 'auto' }, items: [], queuedPrompts: [] as Array<{ id: string; text: string }>, pendingSteering: [] as Array<{ id: string; text: string; status: string }> }
      const sessions = {
        queue: vi.fn(async (_id: string, text: string) => { state.queuedPrompts.push({ id: `q${state.queuedPrompts.length}`, text }) }),
        steerAccepted: vi.fn(async (_id: string, text: string) => steer(text)),
        cancelQueued: vi.fn((_id: string, promptId: string) => { const found = state.pendingSteering.find(input => input.id === promptId); state.pendingSteering = state.pendingSteering.filter(input => input !== found); return found ?? null })
      }
      return { state, sessions, delivery: grantDelivery(sessions as never, { spec: () => undefined, snapshot: () => state } as never) }
    }

    it('is not queued behind the retry when the runtime takes no steer, and leaves no record to resend', async () => {
      const c = conversation(async text => {
        c.state.pendingSteering.push({ id: 'p1', text, status: 'uncertain' })
        throw new SteeringUnavailableError('Codex compact turns cannot be steered')
      })
      await c.delivery.retry('agent_c', 'approved retry')
      await expect(c.delivery.headsUp('agent_c', 'heads-up')).resolves.toBe(false)
      expect(c.state.queuedPrompts.map(prompt => prompt.text)).toEqual(['approved retry'])
      expect(c.state.pendingSteering).toEqual([])
      expect(c.sessions.queue).toHaveBeenCalledTimes(1)
    })

    it('counts a steer the runtime may have read as sent, so it is never sent twice', async () => {
      const c = conversation(async text => {
        c.state.pendingSteering.push({ id: 'p1', text, status: 'uncertain' })
        throw new Error('Native steering delivery is uncertain')
      })
      await c.delivery.retry('agent_c', 'approved retry')
      await expect(c.delivery.headsUp('agent_c', 'heads-up')).resolves.toBe(true)
      expect(c.state.queuedPrompts.map(prompt => prompt.text)).toEqual(['approved retry'])
      // Refused before any record was made (no steerable turn at that instant): not sent, tried again later.
      const early = conversation(async () => { throw new Error('The current turn does not support steering. Native acceptance was not confirmed') })
      await expect(early.delivery.headsUp('agent_c', 'heads-up')).resolves.toBe(false)
      expect(early.state.queuedPrompts).toEqual([])
    })
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
