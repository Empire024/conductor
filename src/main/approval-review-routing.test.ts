import { describe, expect, it, vi } from 'vitest'
import type { ReviewAction } from './approval-review'
import type { SessionProjection, TimelineItem } from '../shared/structured-agent'
import type { AgentSpec } from '../shared/models'
import type { AgentControlDependencies } from './agent-control'
import { createApprovalRouting, REVIEWS_PER_OWNER_TASK, REVIEWS_PER_REVIEWER } from './approval-review-routing'

const spec = (id: string, projectId = 'project'): AgentSpec => ({ id, projectId, sessionId: 'workspace-' + projectId, provider: 'claude', cwd: 'C:/work', title: id })

/** A controller chain with no database behind it: who controls whom, which tabs are open here. */
function routing(chain: Record<string, string | undefined>, specs: Record<string, AgentSpec>, open: (id: string) => boolean, review = true) {
  const deps = {
    sessions: { isApprovalReviewer: () => false },
    database: { structured: { snapshot: () => ({ settings: { permission: 'auto', plan: false, reviewDelegatedActions: review } }), spec: (id: string) => specs[id] } }
  } as unknown as AgentControlDependencies
  return createApprovalRouting(deps, { controller: id => chain[id], localAndOpen: current => open(current.id), discoveredOpus: () => 'opus', open: async () => 'reviewer' })
}

describe('stronger review routing authority', () => {
  it('reviews a worker whose controllers are all open here, in the same project', () => {
    const specs = { worker: spec('worker'), controller: spec('controller') }
    expect(routing({ worker: 'controller' }, specs, () => true).enabled(specs.worker)).toBe(true)
  })
  it('does not review, and so does not force approvals on, a worker controlled from another project or a closed tab', () => {
    const cross = { worker: spec('worker'), controller: spec('controller', 'faktury') }
    expect(routing({ worker: 'controller' }, cross, () => true).enabled(cross.worker)).toBe(false)
    const closed = { worker: spec('worker'), controller: spec('controller') }
    expect(routing({ worker: 'controller' }, closed, id => id !== 'controller').enabled(closed.worker)).toBe(false)
  })
  it('reviews for a wizard controller on a frontier model, and not for a wand on a lesser one', () => {
    const specs = { worker: spec('worker'), controller: spec('controller') }
    const wizard = (model: string) => {
      const deps = { sessions: { isApprovalReviewer: () => false }, database: { structured: { snapshot: () => ({ settings: { permission: 'auto', plan: false, wizard: true, model } }), spec: (id: string) => specs[id as keyof typeof specs] } } } as unknown as AgentControlDependencies
      return createApprovalRouting(deps, { controller: id => ({ worker: 'controller' } as Record<string, string | undefined>)[id], localAndOpen: () => true, discoveredOpus: () => 'opus', open: async () => 'reviewer' })
    }
    expect(wizard('claude-opus-5').enabled(specs.worker)).toBe(true)
    expect(wizard('sonnet').enabled(specs.worker)).toBe(false)
  })
  it('is off when no controller asked for it', () => {
    const specs = { worker: spec('worker'), controller: spec('controller') }
    expect(routing({ worker: 'controller' }, specs, () => true, false).enabled(specs.worker)).toBe(false)
    expect(routing({}, specs, () => true).enabled(specs.worker)).toBe(false)
  })
})

/** A synthetic native reviewer: every submitted prompt becomes one completed Opus turn that echoes
 *  the prompt's digest. No inference; only the routing's own bookkeeping is under test. */
function reviewerFixture(decision = 'allow') {
  const settings = new Map<string, string>(), states = new Map<string, SessionProjection>(), prompts: Array<{ id: string; prompt: string }> = [], notices: Array<{ id: string; message: string }> = []
  let sequence = 0, opened = 0
  const item = (runtimeId: string, data: TimelineItem['data'], turnId?: string): TimelineItem => ({ id: 'item-' + ++sequence, runtimeId, sequence, timestamp: new Date().toISOString(), data, ...(turnId ? { turnId } : {}) })
  const specs = { worker: spec('worker'), controller: spec('controller') }
  const deps = {
    sessions: {
      isApprovalReviewer: () => false,
      interrupt: vi.fn(async () => undefined),
      notice: (id: string, message: string) => { notices.push({ id, message }); return true },
      submit: async (id: string, prompt: string) => {
        prompts.push({ id, prompt })
        const state = states.get(id)!, digest = /"digest":"([0-9a-f]+)"/.exec(prompt)?.[1], turn = 'turn-' + prompts.length
        state.items.push(item(state.runtimeId, { type: 'text', role: 'user', text: prompt, mode: 'snapshot' }))
        state.items.push(item(state.runtimeId, { type: 'text', role: 'assistant', text: JSON.stringify({ digest, decision, rationale: 'synthetic' }), mode: 'snapshot' }, turn))
        state.items.push(item(state.runtimeId, { type: 'usage', inputTokens: 900, outputTokens: 30 } as TimelineItem['data'], turn))
        state.phase = 'completed'
      }
    },
    database: {
      getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string) => { settings.set(key, value) },
      structured: { snapshot: (id: string) => states.get(id) ?? ({ settings: { permission: 'auto', plan: false, reviewDelegatedActions: true } }), spec: (id: string) => specs[id as keyof typeof specs] }
    }
  } as unknown as AgentControlDependencies
  const closed: string[] = []
  const routing = createApprovalRouting(deps, {
    controller: id => ({ worker: 'controller' } as Record<string, string | undefined>)[id], localAndOpen: () => true, discoveredOpus: () => 'opus',
    open: async () => {
      const id = 'reviewer-' + ++opened
      states.set(id, { sessionId: id, runtimeId: 'runtime-' + id, phase: 'idle', sequence: 0, items: [], settings: { permission: 'default', plan: false }, capabilities: { effectiveSettings: { model: 'claude-opus-5-5' } } } as unknown as SessionProjection)
      return id
    },
    close: async (_spec, id) => { closed.push(id) },
    isOpen: (_spec, id) => !closed.includes(id)
  })
  const action = (requestId: string, overrides: Partial<ReviewAction> = {}): ReviewAction => ({ projectId: 'project', machineId: 'local', workerId: 'worker', runtimeId: 'runtime', requestId, ownerTaskId: 'controller:owner-message',
    tool: 'Bash', arguments: { command: 'echo ' + requestId }, paths: [], boundary: 'workspace-write', reason: 'routine', sideEffects: [], ownerEvidence: 'Owner message: run the checks. '.repeat(40), authorizationId: 'auth-1', native: {}, ...overrides })
  return { routing, specs, prompts, notices, closed, action, get opened() { return opened } }
}

describe('stronger review cost (review-cost-bounded)', () => {
  it('reuses one reviewer conversation per worker, binding each answer to its own turn and digest', async () => {
    const f = reviewerFixture()
    const results = []
    for (const id of ['r1', 'r2', 'r3']) results.push(await f.routing.run(f.specs.worker, f.action(id), 'abcd0' + id.slice(1)))
    expect(f.opened).toBe(1)
    expect(new Set(results.map(result => result.reviewerId))).toEqual(new Set(['reviewer-1']))
    expect(results.map(result => result.turnId)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(results.every(result => result.decision === 'allow')).toBe(true)
    // Only the first prompt carries the full owner evidence and role text; later ones reference it.
    expect(f.prompts[0]!.prompt).toContain('Owner message: run the checks.')
    expect(f.prompts[1]!.prompt).not.toContain('Owner message: run the checks.')
    expect(f.prompts[1]!.prompt.length).toBeLessThan(f.prompts[0]!.prompt.length / 2)
    expect(f.prompts.every(entry => entry.prompt.startsWith('You are an isolated approval reviewer'))).toBe(true)
    // Usage is this turn's, not the conversation's running total.
    expect(results[2]!.usage).toMatchObject({ run: { tokens: { inputTokens: 900, outputTokens: 30 } } })
    expect(f.closed).toEqual([])
  })

  it('hands over to a fresh reviewer after its review allowance so the context stays small', async () => {
    const f = reviewerFixture()
    for (let index = 0; index <= REVIEWS_PER_REVIEWER; index++) await f.routing.run(f.specs.worker, f.action('q' + index, { ownerTaskId: 'controller:m' + index }), 'abc' + index)
    expect(f.opened).toBe(2)
    expect(f.closed).toEqual(['reviewer-1'])
  })

  it('stops at a low per-task budget, tells the owner once, and reports what was spent', async () => {
    expect(REVIEWS_PER_OWNER_TASK).toBeLessThanOrEqual(24)
    const f = reviewerFixture()
    for (let index = 0; index < REVIEWS_PER_OWNER_TASK; index++) await f.routing.run(f.specs.worker, f.action('b' + index), 'abc' + index)
    expect(f.routing.budget!(f.action('x'))).toEqual({ used: REVIEWS_PER_OWNER_TASK, cap: REVIEWS_PER_OWNER_TASK })
    await expect(f.routing.run(f.specs.worker, f.action('over'), 'abcd')).rejects.toThrow(`${REVIEWS_PER_OWNER_TASK}-review budget`)
    await expect(f.routing.run(f.specs.worker, f.action('over-again'), 'abce')).rejects.toThrow('budget')
    expect(f.notices.map(notice => notice.id).sort()).toEqual(['controller', 'worker'])
    expect(f.notices[0]!.message).toContain('Approval review budget reached')
    expect(f.prompts).toHaveLength(REVIEWS_PER_OWNER_TASK)
  })
})
