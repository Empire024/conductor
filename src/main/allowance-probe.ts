import { makeId, type AgentSpec } from '../shared/models'
import type { StructuredSessions } from './structured-sessions'

type ProbeSessions = Pick<StructuredSessions, 'ensure' | 'connectSession' | 'refreshUsage' | 'killWhere'>

/** Performs Codex's account/rateLimits/read handshake without creating a tab or submitting a turn. */
export class AllowanceProbe {
  constructor(private readonly sessions: ProbeSessions) {}

  async codex(input: {projectId:string;workspaceId:string;cwd:string;model:string}): Promise<{id:string;refreshed:boolean}> {
    const id = makeId('allowance-probe')
    const spec: AgentSpec = {
      id, projectId: input.projectId, sessionId: input.workspaceId,
      cwd: input.cwd, provider: 'codex', model: input.model, title: 'Allowance probe'
    }
    try {
      const ensured = this.sessions.ensure(spec)
      if (!ensured.available) return { id, refreshed: false }
      await this.sessions.connectSession(id)
      return { id, refreshed: await this.sessions.refreshUsage(id) }
    } finally {
      // Events/spec remain durable; only the ephemeral provider transport is disposed.
      this.sessions.killWhere(candidate => candidate.id === id)
    }
  }
}
