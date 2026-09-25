import { afterEach, describe, expect, it } from 'vitest'
import type { InteractionResponse, Json, SessionProjection } from '../shared/structured-agent'
import { ApprovalReviews } from './approval-review'
import { sessionRules } from './approval-review-rules'
import { callWizardApprovals, type WizardApprovalPorts, type WizardApprovalScope } from './wizard-approvals'

afterEach(() => sessionRules.clear())

const approval = (id: string, input: Json, title: string) => ({ id: 'item-' + id, runtimeId: 'runtime', nativeItemId: 'tool-' + id, sequence: 1, timestamp: '2026-09-26T00:00:00.000Z',
  data: { type: 'interaction' as const, interaction: { id, kind: 'approval' as const, status: 'pending' as const, title, input, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-session', label: 'Session', disabled: true }, { id: 'deny', label: 'Deny' }] } } })

function fixture() {
  const settings = new Map<string, string>(), responses: InteractionResponse[] = []
  const state: SessionProjection = { sessionId: 'coworker', runtimeId: 'runtime', phase: 'waiting_approval', sequence: 3, items: [
    approval('run-tests', { command: 'npm test' }, 'Allow Bash?'),
    approval('push', { command: 'git push origin main' }, 'Allow Bash?'),
    approval('stray', { file_path: 'C:/elsewhere/notes.txt', content: 'x' }, 'Allow Write?')
  ], settings: { permission: 'default', plan: false } } as unknown as SessionProjection
  const ports: WizardApprovalPorts = {
    answerable: scope => scope.owner || scope.agentSessionId === 'wizard' ? [{ agentSessionId: 'coworker', title: 'Coworker', cwd: 'C:/work', projectId: 'project' }] : [],
    snapshot: id => id === 'coworker' ? state : null,
    respond: async response => {
      responses.push(response)
      const item = state.items.find(entry => entry.data.type === 'interaction' && entry.data.interaction.id === response.requestId)
      if (item?.data.type === 'interaction') item.data.interaction.status = 'resolved'
    },
    persistence: { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) } }
  }
  const wizard: WizardApprovalScope = { agentSessionId: 'wizard', projectId: 'project', wizard: true }
  return { ports, responses, wizard, journal: () => new ApprovalReviews(ports.persistence) }
}

describe('a wizard answers its coworkers\' approvals (wizard-answers-approvals)', () => {
  it('refuses an ordinary conversation, and a wizard naming a conversation it does not control', async () => {
    const f = fixture()
    await expect(callWizardApprovals(f.ports, { agentSessionId: 'worker', projectId: 'project' }, 'agents.approvals', {})).rejects.toThrow('only a wizard tab')
    await expect(callWizardApprovals(f.ports, { agentSessionId: 'worker', projectId: 'project' }, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', reason: 'x' })).rejects.toThrow('only a wizard tab')
    await expect(callWizardApprovals(f.ports, { agentSessionId: 'other-wizard', projectId: 'project', wizard: true }, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', reason: 'x' })).rejects.toThrow('not one of your coworkers')
    expect(f.responses).toHaveLength(0)
  })

  it('lists each pending approval with its exact action and whether automation may allow it', async () => {
    const f = fixture()
    const listed = await callWizardApprovals(f.ports, f.wizard, 'agents.approvals', {}) as { approvals: Array<Record<string, unknown>> }
    expect(listed.approvals.map(entry => [entry.requestId, entry.tool, entry.class, entry.mayAllow, entry.sessionClass])).toEqual([
      ['run-tests', 'Bash', 'local', true, 'Bash:npm test'],
      ['push', 'Bash', 'external', false, null],
      ['stray', 'Write', 'local', false, null]
    ])
    expect(listed.approvals[0]).toMatchObject({ agentSessionId: 'coworker', runtimeId: 'runtime', input: '{"command":"npm test"}', choices: ['allow', 'deny'] })
    expect(listed.approvals[2]!.ownerOnly).toContain('outside')
  })

  it('allows a local action for the session: the coworker gets the answer, the journal the reason, the worker a session rule', async () => {
    const f = fixture()
    const answer = await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', scope: 'session', reason: 'The task runs its own tests' }) as Record<string, unknown>
    // The native session choice is disabled here, so the runtime is answered once and the class rule does the rest.
    expect(f.responses).toEqual([{ sessionId: 'coworker', runtimeId: 'runtime', requestId: 'run-tests', decision: 'allow' }])
    expect(answer).toMatchObject({ decision: 'allow', scope: 'session', answered: 'allow', sessionRule: 'Bash:npm test', journal: { phase: 'responded' } })
    const record = f.journal().forRequest('project', 'coworker', 'runtime', 'run-tests')!
    expect(record.answeredBy).toContain('Wizard wizard')
    expect(record.rationale).toContain('The task runs its own tests')
    expect(sessionRules.list({ workerId: 'coworker', runtimeId: 'runtime' }).map(rule => [rule.key, rule.source])).toEqual([['Bash:npm test', 'wizard']])
  })

  it('keeps production, external and outside-workspace actions the owner\'s, but lets the wizard deny them', async () => {
    const f = fixture()
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'allow', reason: 'ship it' })).rejects.toThrow('external')
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'stray', decision: 'allow', reason: 'notes' })).rejects.toThrow('outside')
    // The owner credential through app control is automation too: held to the same line.
    await expect(callWizardApprovals(f.ports, { agentSessionId: 'owner', projectId: 'project', owner: true }, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'allow', reason: 'x' })).rejects.toThrow('external')
    expect(f.responses).toHaveLength(0)
    await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'deny', reason: 'No pushes in this task' })
    expect(f.responses).toEqual([{ sessionId: 'coworker', runtimeId: 'runtime', requestId: 'push', decision: 'deny' }])
    expect(sessionRules.list({ workerId: 'coworker', runtimeId: 'runtime' })).toEqual([])
  })

  it('refuses an answer to a request that is no longer pending, and malformed arguments', async () => {
    const f = fixture()
    await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', reason: 'tests' })
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', reason: 'tests' })).rejects.toThrow('no longer pending')
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'maybe', reason: 'x' })).rejects.toThrow('decision')
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'deny' })).rejects.toThrow('reason')
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'deny', reason: 'x', force: true })).rejects.toThrow('does not take force')
  })
})
