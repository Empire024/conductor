import { afterEach, describe, expect, it } from 'vitest'
import type { InteractionResponse, Json, SessionProjection } from '../shared/structured-agent'
import { ApprovalReviews } from './approval-review'
import { sessionRules } from './approval-review-rules'
import { callWizardApprovals, type WizardApprovalPorts, type WizardApprovalScope } from './wizard-approvals'

afterEach(() => sessionRules.clear())

const approval = (id: string, input: Json, title: string, session?: string) => ({ id: 'item-' + id, runtimeId: 'runtime', nativeItemId: 'tool-' + id, sequence: 1, timestamp: '2026-09-26T00:00:00.000Z',
  data: { type: 'interaction' as const, interaction: { id, kind: 'approval' as const, status: 'pending' as const, title, input, choices: [{ id: 'allow', label: 'Allow once' }, { id: 'allow-session', label: 'Session', ...(session ? { description: session } : { disabled: true }) }, { id: 'deny', label: 'Deny' }] } } })

function fixture({ reviewed = false, key }: { reviewed?: boolean; key?: string } = {}) {
  const settings = new Map<string, string>(), responses: InteractionResponse[] = []
  const state: SessionProjection = { sessionId: 'coworker', runtimeId: 'runtime', phase: 'waiting_approval', sequence: 3, items: [
    approval('run-tests', { command: 'npm test' }, 'Allow Bash?'),
    approval('push', { command: 'git push origin main' }, 'Allow Bash?'),
    approval('stray', { file_path: 'C:/elsewhere/notes.txt', content: 'x' }, 'Allow Write?'),
    approval('lint', { command: 'npm run lint' }, 'Allow Bash?', 'Scope: Bash(npm run lint). Only this running Claude session; cleared when it restarts or resumes.')
  ], settings: { permission: 'default', plan: false } } as unknown as SessionProjection
  const ports: WizardApprovalPorts = {
    answerable: scope => scope.owner || scope.agentSessionId === 'wizard' ? [{ agentSessionId: 'coworker', title: 'Coworker', cwd: 'C:/work', projectId: 'project' }] : [],
    snapshot: id => id === 'coworker' ? state : null,
    respond: async response => {
      responses.push(response)
      const item = state.items.find(entry => entry.data.type === 'interaction' && entry.data.interaction.id === response.requestId)
      if (item?.data.type === 'interaction') item.data.interaction.status = 'resolved'
    },
    persistence: { getSetting: key => settings.get(key) ?? null, setSetting: (key, value) => { settings.set(key, value) } },
    reviewClass: () => ({ reviewed, ...(key ? { key } : {}) })
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

  it('lists each pending approval with its exact action, and why a non-local one deserves attention', async () => {
    const f = fixture()
    const listed = await callWizardApprovals(f.ports, f.wizard, 'agents.approvals', {}) as { approvals: Array<Record<string, unknown>> }
    expect(listed.approvals.map(entry => [entry.requestId, entry.tool, entry.class, entry.mayAllow, entry.sessionClass])).toEqual([
      ['run-tests', 'Bash', 'local', true, 'Bash:npm test'],
      ['push', 'Bash', 'external', true, null],
      ['stray', 'Write', 'local', true, null],
      ['lint', 'Bash', 'local', true, 'Bash:npm run lint']
    ])
    expect(listed.approvals[0]).toMatchObject({ agentSessionId: 'coworker', runtimeId: 'runtime', input: '{"command":"npm test"}', choices: ['allow', 'deny'] })
    expect(listed.approvals[0]!.attention).toBeUndefined()
    expect(listed.approvals[1]!.attention).toContain('external')
    expect(listed.approvals[2]!.attention).toContain('outside')
    expect(listed.approvals.some(entry => 'ownerOnly' in entry)).toBe(false)
  })

  it('allows a local action for the session: the coworker gets the answer, the journal the reason, the worker a session rule', async () => {
    const f = fixture({ reviewed: true, key: 'Bash:npm test' })
    const answer = await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', scope: 'session', reason: 'The task runs its own tests' }) as Record<string, unknown>
    // The native session choice is disabled here, so the runtime is answered once and the class rule does the rest.
    expect(f.responses).toEqual([{ sessionId: 'coworker', runtimeId: 'runtime', requestId: 'run-tests', decision: 'allow' }])
    expect(answer).toMatchObject({ decision: 'allow', scope: 'session', answered: 'allow', effectiveScope: 'once+app-rule', sessionRule: 'Bash:npm test', journal: { phase: 'responded' } })
    expect(answer.note).toMatch(/in-memory rule "Bash:npm test".*while this runtime runs; an app restart, a reconnect that starts a new runtime, or a handoff ends it/)
    const record = f.journal().forRequest('project', 'coworker', 'runtime', 'run-tests')!
    expect(record.answeredBy).toContain('Wizard wizard')
    expect(record.rationale).toContain('The task runs its own tests')
    expect(sessionRules.list({ workerId: 'coworker', runtimeId: 'runtime' }).map(rule => [rule.key, rule.source])).toEqual([['Bash:npm test', 'wizard']])
  })

  it('says truthfully what a session allow covers: once, the runtime\'s own session choice, or an unused app rule', async () => {
    const f = fixture()
    // Stronger review is off for this coworker: the app-side rule is never consulted, so the effective scope is once.
    const unreviewed = await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', scope: 'session', reason: 'tests' }) as Record<string, unknown>
    expect(unreviewed).toMatchObject({ answered: 'allow', effectiveScope: 'once', sessionRule: 'Bash:npm test' })
    expect(unreviewed.note).toContain('later requests of this class ask again')
    // No reusable class: once, and it says so.
    const compound = await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'stray', decision: 'allow', scope: 'session', reason: 'notes' }) as Record<string, unknown>
    expect(compound).toMatchObject({ answered: 'allow', effectiveScope: 'once', sessionRule: null })
    // The runtime offers its own session choice: that is used, with the lifetime its adapter states, and no app rule is added.
    const native = await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'lint', decision: 'allow', scope: 'session', reason: 'lint' }) as Record<string, unknown>
    expect(native).toMatchObject({ answered: 'allow-session', effectiveScope: 'native-session' })
    expect(native.note).toContain('Only this running Claude session; cleared when it restarts or resumes.')
    expect(sessionRules.list({ workerId: 'coworker', runtimeId: 'runtime' }).map(rule => rule.key)).toEqual(['Bash:npm test'])
    // Under review, an action whose class the gate will not cover (an owner ask rule, say): once, no rule.
    const guarded = fixture({ reviewed: true })
    const held = await callWizardApprovals(guarded.ports, guarded.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', scope: 'session', reason: 'tests' }) as Record<string, unknown>
    expect(held).toMatchObject({ answered: 'allow', effectiveScope: 'once', sessionRule: null })
    expect(held.note).toContain('owner ask rule or owner-only boundary')
    expect(sessionRules.list({ workerId: 'coworker', runtimeId: 'runtime' }).map(rule => rule.key)).toEqual(['Bash:npm test'])
    // A plain allow reports once.
    const f2 = fixture()
    await expect(callWizardApprovals(f2.ports, f2.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'allow', reason: 'tests' })).resolves.toMatchObject({ effectiveScope: 'once' })
  })

  it('lets a wizard or the owner allow every class, as permissions.decide does, and still deny', async () => {
    const f = fixture()
    // H13 (owner 2026-09-28): the wand holds the owner's authority, production and external included.
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'allow', reason: 'ship it' })).resolves.toMatchObject({ answered: 'allow' })
    await expect(callWizardApprovals(f.ports, { agentSessionId: 'owner', projectId: 'project', owner: true }, 'agents.approve', { agentSessionId: 'coworker', requestId: 'stray', decision: 'allow', reason: 'notes' })).resolves.toMatchObject({ answered: 'allow' })
    await callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'run-tests', decision: 'deny', reason: 'No tests in this task' })
    expect(f.responses.map(response => [response.requestId, response.decision])).toEqual([['push', 'allow'], ['stray', 'allow'], ['run-tests', 'deny']])
    expect(sessionRules.list({ workerId: 'coworker', runtimeId: 'runtime' })).toEqual([])
  })

  it('refuses a wizard answering its own request, and a choice its runtime does not offer', async () => {
    const f = fixture()
    const self = { ...f.ports, answerable: () => [{ agentSessionId: 'wizard', cwd: 'C:/work', projectId: 'project' }] }
    await expect(callWizardApprovals(self, f.wizard, 'agents.approve', { agentSessionId: 'wizard', requestId: 'push', decision: 'allow', reason: 'x' })).rejects.toThrow('not one of your coworkers')
    const state = f.ports.snapshot('coworker')!
    for (const item of state.items) if (item.data.type === 'interaction') item.data.interaction.choices = item.data.interaction.choices.map(choice => choice.id === 'allow' ? { ...choice, disabled: true } : choice)
    await expect(callWizardApprovals(f.ports, f.wizard, 'agents.approve', { agentSessionId: 'coworker', requestId: 'push', decision: 'allow', reason: 'x' })).rejects.toThrow('does not offer a allow answer')
    expect(f.responses).toHaveLength(0)
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
