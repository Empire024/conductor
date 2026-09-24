import { describe, expect, it } from 'vitest'
import type { AgentControlScope } from '../shared/agent-control'
import { CoworkerRecovery, RECOVERY_ATTEMPTS, RECOVERY_WINDOW_MS } from './coworker-recovery'

const store = () => { const values = new Map<string, string>(); return { getSetting: (key: string) => values.get(key) ?? null, setSetting: (key: string, value: string) => { values.set(key, value) } } }
const controller: AgentControlScope = { projectId: 'project', sessionId: 'workspace', agentSessionId: 'controller' }
const wizard: AgentControlScope = { ...controller, agentSessionId: 'wizard', wizard: true }
const owner: AgentControlScope = { ...controller, agentSessionId: '', owner: true }

describe('bounded coworker recovery', () => {
  it('allows a few recoveries of a failed coworker, then leaves the decision to the owner', () => {
    let now = Date.parse('2026-09-24T20:00:00Z')
    const recovery = new CoworkerRecovery(store(), () => now)
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt++) {
      expect(() => recovery.admit(controller, 'worker', 'failed')).not.toThrow()
      recovery.record(controller, 'worker', 'failed')
      now += 60_000
    }
    expect(recovery.status('project', 'worker')).toMatchObject({ attempts: RECOVERY_ATTEMPTS, remaining: 0 })
    expect(() => recovery.admit(controller, 'worker', 'disconnected')).toThrow(/tell the owner/)
    // A wizard holds the owner's authority but runs unattended: bounded all the same.
    expect(() => recovery.admit(wizard, 'worker', 'failed')).toThrow(/tell the owner/)
    // The owner's own call is never refused by the bound, and is not counted against it.
    expect(() => recovery.admit(owner, 'worker', 'failed')).not.toThrow()
    recovery.record(owner, 'worker', 'failed')
    expect(recovery.status('project', 'worker').attempts).toBe(RECOVERY_ATTEMPTS)
    // The window moves on.
    now += RECOVERY_WINDOW_MS
    expect(() => recovery.admit(controller, 'worker', 'failed')).not.toThrow()
  })

  it('does not count a routine reconnect of an idle or completed conversation as a recovery', () => {
    const recovery = new CoworkerRecovery(store())
    for (let index = 0; index < RECOVERY_ATTEMPTS + 2; index++) { recovery.admit(controller, 'worker', 'idle'); recovery.record(controller, 'worker', 'idle') }
    expect(recovery.status('project', 'worker')).toMatchObject({ attempts: 0, remaining: RECOVERY_ATTEMPTS })
    expect(() => recovery.admit(controller, 'worker', 'completed')).not.toThrow()
  })

  it('never recovers a conversation that is waiting on a request: its pending approval is answered, not expired', () => {
    const recovery = new CoworkerRecovery(store())
    for (const phase of ['waiting_approval', 'waiting_input', 'running', 'starting', 'interrupting'] as const) expect(() => recovery.admit(owner, 'worker', phase)).toThrow(/answered, not recovered/)
    expect(() => recovery.supersede(controller, 'worker', 'waiting_approval', 'replacement', 'Redone')).toThrow(/stopped conversation/)
  })

  it('records a superseded failure apart from unfinished work and refuses to resume it', () => {
    const recovery = new CoworkerRecovery(store())
    expect(() => recovery.supersede(controller, 'worker', 'failed', 'worker', 'self')).toThrow(/itself/)
    expect(() => recovery.supersede(controller, 'worker', 'failed', 'replacement', ' ')).toThrow(/reason/)
    const status = recovery.supersede(controller, 'worker', 'failed', 'replacement', 'Replacement passed the acceptance test')
    expect(status.superseded).toMatchObject({ by: 'replacement', reason: 'Replacement passed the acceptance test', recordedBy: 'controller' })
    expect(() => recovery.admit(owner, 'worker', 'failed')).toThrow(/superseded by replacement/)
    // Scoped per project: the same id elsewhere is a different conversation's record.
    expect(recovery.status('other-project', 'worker').superseded).toBeNull()
  })
})
