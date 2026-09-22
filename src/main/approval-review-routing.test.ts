import { describe, expect, it } from 'vitest'
import type { AgentSpec } from '../shared/models'
import type { AgentControlDependencies } from './agent-control'
import { createApprovalRouting } from './approval-review-routing'

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
  it('is off when no controller asked for it', () => {
    const specs = { worker: spec('worker'), controller: spec('controller') }
    expect(routing({ worker: 'controller' }, specs, () => true, false).enabled(specs.worker)).toBe(false)
    expect(routing({}, specs, () => true).enabled(specs.worker)).toBe(false)
  })
})
